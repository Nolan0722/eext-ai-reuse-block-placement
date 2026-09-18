/**
 * LLM HTTP：经 sys_ClientUrl 出站（嘉立创代理）+ 状态码分类。
 */
import { edaGlobal, withTimeout } from '../host';

export interface LlmRequest {
	url: string;
	body: string;
	headers: Record<string, string>;
	/** SSE 流式请求标记：true 时按分块读取响应而非等待完整 JSON。 */
	stream?: boolean;
}

/** 流式事件：chunk=一段 SSE 载荷（data: 后的 JSON 文本），done=流正常结束。 */
export interface StreamHandlers {
	onChunk?: (data: string) => void;
	/** 用户请求中止（abortChatTurn）时回调；此后不再有 chunk。 */
	onAborted?: () => void;
}

export const LLM_TIMEOUT_MS = 120000;
/** 流式空闲超时：两个 SSE 事件之间的最大间隔（推理型模型思考期可能数分钟无输出，故放宽）。 */
export const LLM_STREAM_IDLE_MS = 180000;
/** 流式探测缓冲阈值：收到的字节超过该值仍无法按 SSE 解析时，判定通道不透传分块（缓冲降级）。 */
const STREAM_FALLBACK_BYTES = 256;

export type LlmErrorKind = 'auth' | 'path' | 'rate' | 'timeout' | 'format' | 'permission' | 'network' | 'unconfigured' | 'other';

export class LlmHttpError extends Error {
	kind: LlmErrorKind;
	status?: number;
	constructor(kind: LlmErrorKind, message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
	}
}

function sliceBody(text: string): string {
	return text ? ` 响应：${text.slice(0, 160)}` : '';
}

export function classifyLlmError(e: unknown): { kind: LlmErrorKind; message: string } {
	if (e instanceof LlmHttpError)
		return { kind: e.kind, message: e.message };
	const message = e instanceof Error ? e.message : String(e);
	if (/尚未配置|请先在/.test(message))
		return { kind: 'unconfigured', message };
	if (/外部交互权限/.test(message))
		return { kind: 'permission', message };
	if (/超时/.test(message))
		return { kind: 'timeout', message };
	if (/鉴权|HTTP 401|HTTP 403/.test(message))
		return { kind: 'auth', message };
	if (/HTTP 404|baseUrl 路径/.test(message))
		return { kind: 'path', message };
	if (/HTTP 429|限流/.test(message))
		return { kind: 'rate', message };
	if (/不是合法 JSON|响应不是/.test(message))
		return { kind: 'format', message };
	return { kind: 'other', message };
}

/** 会话中止注册表：sessionId → AbortController。chatTurn 开始时挂载，结束时卸载。 */
const abortControllers = new Map<string, AbortController>();

export function registerAbort(sessionId: string): AbortController {
	const c = new AbortController();
	abortControllers.set(sessionId, c);
	return c;
}

export function releaseAbort(sessionId: string): void {
	abortControllers.delete(sessionId);
}

export function abortSession(sessionId: string): boolean {
	const c = abortControllers.get(sessionId);
	if (!c)
		return false;
	c.abort();
	return true;
}

function sleepAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(done, ms);
		function done(): void {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done, { once: true });
	});
}

/**
 * 按行分块读取 SSE 响应体。返回 'streamed'（至少收到一个完整 SSE 事件）
 * 或 'buffered'（连接整体缓冲、无法增量解析——由调用方把累积内容按完整 JSON 解析）。
 * 通道实现（EasyEDA sys_ClientUrl 返回标准 fetch Response）可能不做逐块 resolve：
 * 此时所有 chunk 会在响应结束时一次性到达，同样以 'streamed' 收尾，只是时间上等效缓冲。
 */
async function readSse(
	res: { body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> } } },
	handlers: StreamHandlers,
	signal: AbortSignal,
): Promise<'streamed' | 'buffered'> {
	const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
	if (!reader)
		return 'buffered';
	const cancelReader = async (): Promise<void> => {
		try {
			await reader.cancel?.();
		}
		catch { /* 已关闭 */ }
	};
	const decoder = new TextDecoder();
	let buf = '';
	let events = 0;
	let done = false;
	while (!done) {
		if (signal.aborted) {
			await cancelReader();
			handlers.onAborted?.();
			return 'streamed';
		}
		const chunk = await Promise.race([
			reader.read(),
			sleepAbortable(LLM_STREAM_IDLE_MS, signal).then(() => null),
		]);
		if (signal.aborted) {
			await cancelReader();
			handlers.onAborted?.();
			return 'streamed';
		}
		if (!chunk) {
			// 空闲超时：服务器长时间无新数据，视为流中断（非用户中止）。
			await cancelReader();
			throw new LlmHttpError('timeout', `流式响应空闲超过 ${Math.round(LLM_STREAM_IDLE_MS / 1000)}s，已中断。请重试或更换端点`);
		}
		if (chunk.done) {
			done = true;
			break;
		}
		buf += decoder.decode(chunk.value, { stream: true });
		// 缓冲降级判定：累计超过阈值仍凑不出一个 SSE 事件行，说明通道不透传分块，
		// 让调用方退回"整体缓冲 → 完整 JSON"解析（功能等价旧版非流式路径）。
		if (events === 0 && buf.length > STREAM_FALLBACK_BYTES && !buf.includes('\n'))
			return 'buffered';
		for (;;) {
			const idx = buf.indexOf('\n');
			if (idx < 0)
				break;
			const line = buf.slice(0, idx).replace(/\r$/, '');
			buf = buf.slice(idx + 1);
			if (!line || line.startsWith(':'))
				continue;
			if (line.startsWith('data:')) {
				const data = line.slice(5).trim();
				if (!data)
					continue;
				events++;
				handlers.onChunk?.(data);
			}
		}
	}
	if (signal.aborted) {
		handlers.onAborted?.();
		return 'streamed';
	}
	return events > 0 ? 'streamed' : 'buffered';
}

/** 流式路径的返回哨兵：真实载荷已经过 onChunk 回调交付，Promise 值本身无意义。 */
export const STREAM_SENTINEL = { __streamed: true };

export async function sendLlmRequest(req: LlmRequest, handlers?: StreamHandlers, signal?: AbortSignal): Promise<unknown> {
	const client = edaGlobal()?.sys_ClientUrl as
		| { request?: (url: string, method: string, data?: string, options?: Record<string, unknown>) => Promise<unknown> }
		| undefined;
	const send = client?.request;
	if (typeof send !== 'function')
		throw new LlmHttpError('permission', 'sys_ClientUrl 不可用（宿主版本过低或不支持外部请求）');
	let res: unknown;
	try {
		res = await withTimeout(
			send.call(client, req.url, 'POST', req.body, { headers: req.headers }),
			LLM_TIMEOUT_MS,
			'请求超时（120s）——请检查端点可达性',
		);
	}
	catch (e) {
		if (e instanceof LlmHttpError)
			throw e;
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.includes('外部交互权限') || msg.toLowerCase().includes('external interaction'))
			throw new LlmHttpError('permission', '外部交互权限未开启：请在 扩展管理 中为本插件启用「外部交互权限」后重试');
		if (msg.includes('超时'))
			throw new LlmHttpError('timeout', msg);
		throw new LlmHttpError('network', `网络请求失败：${msg}（出网走嘉立创代理；api.openai.com 官方域实测不可用，请使用国内可达端点）`);
	}
	const r = res as {
		ok?: boolean;
		status?: number;
		text?: () => Promise<string>;
		json?: () => Promise<unknown>;
		body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> } };
	};
	if (r && typeof r.ok === 'boolean') {
		if (!r.ok) {
			let bodyText = '';
			try {
				bodyText = typeof r.text === 'function' ? await r.text() : '';
			}
			catch { /* 忽略读体失败 */ }
			if (r.status === 401 || r.status === 403)
				throw new LlmHttpError('auth', `鉴权失败（HTTP ${r.status}）：apiKey 无效或无权限。${sliceBody(bodyText)}`, r.status);
			if (r.status === 404)
				throw new LlmHttpError('path', `HTTP 404：baseUrl 路径不对——一般应填到 /v1 这一级（如 https://api.deepseek.com/v1）。${sliceBody(bodyText)}`, 404);
			if (r.status === 429)
				throw new LlmHttpError('rate', `HTTP 429：请求被限流，请稍后重试。${sliceBody(bodyText)}`, 429);
			throw new LlmHttpError('other', `HTTP ${r.status ?? '?'}:${sliceBody(bodyText)}`, r.status);
		}
		// 流式路径：SSE 分块读取；channel 不可流式（无 body reader 或整体缓冲）时降级为完整 JSON。
		if (req.stream && handlers) {
			const mode = await readSse(r, handlers, signal ?? new AbortController().signal);
			if (mode === 'streamed')
				return STREAM_SENTINEL;
			// buffered：按完整 JSON 解析（通道缓冲或 body reader 不可用）。
		}
		try {
			if (typeof r.json !== 'function')
				throw new LlmHttpError('format', 'sys_ClientUrl 返回对象不含 json()');
			return await r.json();
		}
		catch (e) {
			if (e instanceof LlmHttpError)
				throw e;
			throw new LlmHttpError('format', '响应不是合法 JSON：请检查 baseUrl 是否指向正确的 API 地址');
		}
	}
	return res;
}

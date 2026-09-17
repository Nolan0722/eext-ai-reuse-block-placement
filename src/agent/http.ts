/**
 * LLM HTTP：经 sys_ClientUrl 出站（嘉立创代理）+ 状态码分类。
 */
import { edaGlobal, withTimeout } from '../host';

export interface LlmRequest {
	url: string;
	body: string;
	headers: Record<string, string>;
}

export const LLM_TIMEOUT_MS = 120000;

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

export async function sendLlmRequest(req: LlmRequest): Promise<unknown> {
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
	const r = res as { ok?: boolean; status?: number; text?: () => Promise<string>; json?: () => Promise<unknown> };
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

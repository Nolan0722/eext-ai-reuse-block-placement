/**
 * 三格式请求构造 / 响应解析（OpenAI Chat、OpenAI Responses、Anthropic Messages）。
 */
import type { LlmSettings } from '../settings';
import type { LlmRequest } from './http';
import { AGENT_SYSTEM_PROMPT, toolsAnthropic, toolsOpenAiChat, toolsOpenAiResponses } from './tools';

export interface ParsedToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface ParsedAgentResponse {
	text: string;
	toolCalls: Array<ParsedToolCall>;
	/** 思维链文本（reasoning/thinking），未开启或端点未返回时为空串。 */
	reasoning: string;
}

export interface HistoryTurn {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	toolCalls?: Array<ParsedToolCall>;
	toolCallId?: string;
	toolName?: string;
}

function joinUrl(base: string, path: string): string {
	return base.endsWith(path) ? base : `${base}${path}`;
}

/** anthropic 消息端点：base 已含 /v1 时拼 /messages，已完整则原样。buildAgentRequest / buildPingRequest 共用。 */
function anthropicEndpoint(base: string): string {
	return base.endsWith('/messages') ? base : (base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`);
}

function openaiHeaders(settings: LlmSettings): Record<string, string> {
	return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey.trim()}` };
}

function anthropicHeaders(settings: LlmSettings): Record<string, string> {
	return { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey.trim(), 'anthropic-version': '2023-06-01' };
}

function toOpenAiChatMessages(systemExtra: string, history: Array<HistoryTurn>): Array<Record<string, unknown>> {
	const msgs: Array<Record<string, unknown>> = [
		{ role: 'system', content: `${AGENT_SYSTEM_PROMPT}\n${systemExtra}`.trim() },
	];
	for (const t of history) {
		if (t.role === 'user') {
			msgs.push({ role: 'user', content: t.content });
		}
		else if (t.role === 'assistant') {
			const row: Record<string, unknown> = { role: 'assistant', content: t.content || null };
			if (t.toolCalls?.length) {
				row.tool_calls = t.toolCalls.map(c => ({
					id: c.id,
					type: 'function',
					function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
				}));
			}
			msgs.push(row);
		}
		else {
			msgs.push({ role: 'tool', tool_call_id: t.toolCallId, content: t.content });
		}
	}
	return msgs;
}

function toAnthropicMessages(history: Array<HistoryTurn>): Array<Record<string, unknown>> {
	const msgs: Array<Record<string, unknown>> = [];
	for (const t of history) {
		if (t.role === 'user') {
			msgs.push({ role: 'user', content: t.content });
		}
		else if (t.role === 'assistant') {
			const content: Array<Record<string, unknown>> = [];
			if (t.content)
				content.push({ type: 'text', text: t.content });
			for (const c of t.toolCalls || [])
				content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} });
			msgs.push({ role: 'assistant', content: content.length ? content : t.content });
		}
		else {
			const prev = msgs[msgs.length - 1];
			const block = { type: 'tool_result', tool_use_id: t.toolCallId, content: t.content };
			if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
				(prev.content as Array<unknown>).push(block);
			}
			else {
				msgs.push({ role: 'user', content: [block] });
			}
		}
	}
	return msgs;
}

function toResponsesInput(history: Array<HistoryTurn>): Array<Record<string, unknown>> {
	const input: Array<Record<string, unknown>> = [];
	for (const t of history) {
		if (t.role === 'user') {
			input.push({ role: 'user', content: t.content });
		}
		else if (t.role === 'assistant') {
			if (t.content)
				input.push({ role: 'assistant', content: t.content });
			for (const c of t.toolCalls || []) {
				input.push({
					type: 'function_call',
					call_id: c.id,
					name: c.name,
					arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
				});
			}
		}
		else {
			input.push({ type: 'function_call_output', call_id: t.toolCallId, output: t.content });
		}
	}
	return input;
}

export function buildAgentRequest(
	settings: LlmSettings,
	systemExtra: string,
	history: Array<HistoryTurn>,
): LlmRequest {
	const base = settings.baseUrl.trim().replace(/\/+$/, '');
	if (settings.provider === 'anthropic') {
		const url = anthropicEndpoint(base);
		const body: Record<string, unknown> = {
			model: settings.model.trim(),
			max_tokens: 4096,
			temperature: 0,
			stream: true,
			system: `${AGENT_SYSTEM_PROMPT}\n${systemExtra}`.trim(),
			messages: toAnthropicMessages(history),
			tools: toolsAnthropic(),
		};
		// Anthropic 思考模式：thinking 块与 temperature 互斥，开启时必须去掉 temperature。
		if (settings.enableThinking) {
			delete body.temperature;
			body.thinking = { type: 'enabled', budget_tokens: 8192 };
		}
		return { url, body: JSON.stringify(body), headers: anthropicHeaders(settings) };
	}
	if (settings.provider === 'openai-responses') {
		const body: Record<string, unknown> = {
			model: settings.model.trim(),
			temperature: 0,
			stream: true,
			instructions: `${AGENT_SYSTEM_PROMPT}\n${systemExtra}`.trim(),
			input: toResponsesInput(history),
			tools: toolsOpenAiResponses(),
		};
		// OpenAI Responses 推理参数：非 gpt-5/o 系模型可能不识别，端点报错时由用户关闭思考模式。
		if (settings.enableThinking)
			body.reasoning = { effort: 'medium', summary: 'auto' };
		return { url: joinUrl(base, '/responses'), body: JSON.stringify(body), headers: openaiHeaders(settings) };
	}
	// OpenAI Chat 兼容格式：DeepSeek-R1 的 reasoning_content、Qwen3 的 reasoning 随 delta 增量返回，
	// 无需额外请求参数（思考模型按 model 名路由；Qwen3 系需 enable_thinking 时由流式路径天然满足）。
	return {
		url: joinUrl(base, '/chat/completions'),
		body: JSON.stringify({
			model: settings.model.trim(),
			temperature: 0,
			stream: true,
			messages: toOpenAiChatMessages(systemExtra, history),
			tools: toolsOpenAiChat(),
		}),
		headers: openaiHeaders(settings),
	};
}

export function buildPingRequest(settings: LlmSettings): LlmRequest {
	const base = settings.baseUrl.trim().replace(/\/+$/, '');
	if (settings.provider === 'anthropic') {
		const url = anthropicEndpoint(base);
		return {
			url,
			body: JSON.stringify({
				model: settings.model.trim(),
				max_tokens: 16,
				temperature: 0,
				messages: [{ role: 'user', content: 'ping' }],
			}),
			headers: anthropicHeaders(settings),
		};
	}
	if (settings.provider === 'openai-responses') {
		return {
			url: joinUrl(base, '/responses'),
			body: JSON.stringify({
				model: settings.model.trim(),
				max_output_tokens: 16,
				input: 'ping',
			}),
			headers: openaiHeaders(settings),
		};
	}
	return {
		url: joinUrl(base, '/chat/completions'),
		body: JSON.stringify({
			model: settings.model.trim(),
			max_tokens: 16,
			temperature: 0,
			messages: [{ role: 'user', content: 'ping' }],
		}),
		headers: openaiHeaders(settings),
	};
}

function parseArgs(raw: unknown): unknown {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw);
		}
		catch {
			return { _raw: raw };
		}
	}
	return raw ?? {};
}

/** 单个 SSE data 载荷的累积状态：三家协议的 delta 字段各不相同，按 provider 分别累加。 */
export class StreamAccumulator {
	private text = '';
	private reasoning = '';
	/** OpenAI Chat：按 index 累积增量 tool_calls（arguments 是分片 JSON 文本）。 */
	private oaCalls = new Map<number, { id: string; name: string; args: string }>();
	private oaOrder: Array<number> = [];
	/** Responses：function_call 事件按 call_id 整体或分片到达。 */
	private respCalls = new Map<string, { name: string; args: string }>();
	private respOrder: Array<string> = [];
	/** Anthropic：tool_use 块按 index 累积 partial_json。 */
	private anCalls = new Map<number, { id: string; name: string; args: string }>();
	private anOrder: Array<number> = [];

	/** 喂入一条 SSE data 载荷（JSON 文本），返回本次追加的正文/思维链增量。无法解析的载荷静默忽略（keep-alive 等）。 */
	feed(provider: LlmSettings['provider'], data: string): { textDelta: string; reasoningDelta: string } {
		let d: Record<string, any>;
		try {
			d = JSON.parse(data) as Record<string, any>;
		}
		catch {
			return { textDelta: '', reasoningDelta: '' };
		}
		const before = { text: this.text, reasoning: this.reasoning };
		if (provider === 'anthropic')
			this.feedAnthropic(d);
		else if (provider === 'openai-responses')
			this.feedResponses(d);
		else
			this.feedOpenAiChat(d);
		return { textDelta: this.text.slice(before.text.length), reasoningDelta: this.reasoning.slice(before.reasoning.length) };
	}

	private feedOpenAiChat(d: Record<string, any>): void {
		if (d?.error)
			throw new Error(`端点返回错误：${typeof d.error === 'string' ? d.error : JSON.stringify(d.error).slice(0, 160)}`);
		const choice = Array.isArray(d?.choices) ? d.choices[0] : null;
		if (!choice)
			return;
		const delta = choice.delta ?? {};
		if (typeof delta.reasoning_content === 'string')
			this.reasoning += delta.reasoning_content;
		else if (typeof delta.reasoning === 'string')
			this.reasoning += delta.reasoning;
		if (typeof delta.content === 'string')
			this.text += delta.content;
		for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
			const idx = typeof tc.index === 'number' ? tc.index : 0;
			let slot = this.oaCalls.get(idx);
			if (!slot) {
				slot = { id: String(tc.id || ''), name: String(tc.function?.name || ''), args: '' };
				this.oaCalls.set(idx, slot);
				this.oaOrder.push(idx);
			}
			if (tc.id)
				slot.id = String(tc.id);
			if (tc.function?.name)
				slot.name += String(tc.function.name);
			if (typeof tc.function?.arguments === 'string')
				slot.args += tc.function.arguments;
		}
	}

	private feedResponses(d: Record<string, any>): void {
		if (d?.error)
			throw new Error(`端点返回错误：${typeof d.error === 'string' ? d.error : JSON.stringify(d.error).slice(0, 160)}`);
		const type = String(d?.type || '');
		if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
			this.text += d.delta;
		}
		else if (type === 'response.reasoning_summary_text.delta' && typeof d.delta === 'string') {
			this.reasoning += d.delta;
		}
		else if (type === 'response.reasoning_text.delta' && typeof d.delta === 'string') {
			this.reasoning += d.delta;
		}
		else if (type === 'response.output_item.added' && d.item?.type === 'function_call') {
			const cid = String(d.item.call_id || d.item.id || '');
			if (cid && !this.respCalls.has(cid)) {
				this.respCalls.set(cid, { name: String(d.item.name || ''), args: String(d.item.arguments || '') });
				this.respOrder.push(cid);
			}
		}
		else if (type === 'response.function_call_arguments.delta') {
			const slot = this.respCalls.get(String(d.call_id || d.item_id || ''));
			if (slot && typeof d.delta === 'string')
				slot.args += d.delta;
		}
		else if (type === 'response.completed' || type === 'response.incomplete') {
			// 兜底：以最终 response.output 为准修正遗漏（部分端点只发终态）。
			const output = Array.isArray(d.response?.output) ? d.response.output : [];
			for (const item of output) {
				if (item?.type === 'function_call') {
					const cid = String(item.call_id || item.id || '');
					let slot = this.respCalls.get(cid);
					if (!slot) {
						slot = { name: String(item.name || ''), args: String(item.arguments || '') };
						this.respCalls.set(cid, slot);
						this.respOrder.push(cid);
					}
					slot.name = String(item.name || slot.name);
					if (item.arguments)
						slot.args = String(item.arguments);
				}
			}
		}
	}

	private feedAnthropic(d: Record<string, any>): void {
		const type = String(d?.type || '');
		if (type === 'content_block_start') {
			const cb = d.content_block ?? {};
			if (cb.type === 'tool_use') {
				const idx = typeof d.index === 'number' ? d.index : this.anOrder.length;
				this.anCalls.set(idx, { id: String(cb.id || ''), name: String(cb.name || ''), args: '' });
				this.anOrder.push(idx);
			}
		}
		else if (type === 'content_block_delta') {
			const dl = d.delta ?? {};
			if (dl.type === 'text_delta' && typeof dl.text === 'string') {
				this.text += dl.text;
			}
			else if (dl.type === 'thinking_delta' && typeof dl.thinking === 'string') {
				this.reasoning += dl.thinking;
			}
			else if (dl.type === 'input_json_delta' && typeof dl.partial_json === 'string') {
				const slot = this.anCalls.get(typeof d.index === 'number' ? d.index : -1);
				if (slot)
					slot.args += dl.partial_json;
			}
		}
	}

	/** 流结束后汇总；toolCalls 保证按出现顺序。 */
	result(): ParsedAgentResponse {
		const toolCalls: Array<ParsedToolCall> = [];
		for (const idx of this.oaOrder) {
			const c = this.oaCalls.get(idx)!;
			toolCalls.push({ id: c.id || `tool_${idx}`, name: c.name, arguments: parseArgs(c.args) });
		}
		for (const cid of this.respOrder) {
			const c = this.respCalls.get(cid)!;
			toolCalls.push({ id: cid, name: c.name, arguments: parseArgs(c.args) });
		}
		for (const idx of this.anOrder) {
			const c = this.anCalls.get(idx)!;
			toolCalls.push({ id: c.id || `tool_${idx}`, name: c.name, arguments: parseArgs(c.args) });
		}
		return { text: this.text, toolCalls, reasoning: this.reasoning };
	}
}

export function parseAgentResponse(provider: LlmSettings['provider'], data: unknown): ParsedAgentResponse {
	if (provider === 'anthropic') {
		const d = data as Record<string, any>;
		const content: Array<Record<string, any>> = Array.isArray(d?.content) ? d.content : [];
		const text = content.filter(i => i?.type === 'text').map(i => String(i.text || '')).join('');
		const reasoning = content.filter(i => i?.type === 'thinking').map(i => String(i.thinking || '')).join('');
		const toolCalls = content.filter(i => i?.type === 'tool_use').map(i => ({
			id: String(i.id || `tool_${Math.random().toString(36).slice(2)}`),
			name: String(i.name || ''),
			arguments: parseArgs(i.input),
		}));
		return { text, toolCalls, reasoning };
	}
	if (provider === 'openai-responses') {
		const d = data as Record<string, any>;
		if (d?.error)
			throw new Error(`端点返回错误：${typeof d.error === 'string' ? d.error : JSON.stringify(d.error).slice(0, 160)}`);
		const output: Array<Record<string, any>> = Array.isArray(d?.output) ? d.output : [];
		const text = output
			.filter(i => i?.type === 'message')
			.flatMap(i => (Array.isArray(i.content) ? i.content : []))
			.filter((c: Record<string, any>) => c?.type === 'output_text')
			.map((c: Record<string, any>) => String(c.text || ''))
			.join('');
		const reasoning = output
			.filter(i => i?.type === 'reasoning')
			.flatMap(i => (Array.isArray(i.summary) ? i.summary : []))
			.map((c: Record<string, any>) => String(c.text || ''))
			.join('');
		const toolCalls = output.filter(i => i?.type === 'function_call').map(i => ({
			id: String(i.call_id || i.id || `tool_${Math.random().toString(36).slice(2)}`),
			name: String(i.name || ''),
			arguments: parseArgs(i.arguments),
		}));
		return { text, toolCalls, reasoning };
	}
	const d = data as Record<string, any>;
	const msg = d?.choices?.[0]?.message || {};
	const text = typeof msg.content === 'string' ? msg.content : '';
	const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : '');
	const calls: Array<Record<string, any>> = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
	const toolCalls = calls.map(c => ({
		id: String(c.id || `tool_${Math.random().toString(36).slice(2)}`),
		name: String(c.function?.name || c.name || ''),
		arguments: parseArgs(c.function?.arguments ?? c.arguments),
	}));
	return { text, toolCalls, reasoning };
}

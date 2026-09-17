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
		return {
			url,
			body: JSON.stringify({
				model: settings.model.trim(),
				max_tokens: 4096,
				temperature: 0,
				system: `${AGENT_SYSTEM_PROMPT}\n${systemExtra}`.trim(),
				messages: toAnthropicMessages(history),
				tools: toolsAnthropic(),
			}),
			headers: anthropicHeaders(settings),
		};
	}
	if (settings.provider === 'openai-responses') {
		return {
			url: joinUrl(base, '/responses'),
			body: JSON.stringify({
				model: settings.model.trim(),
				temperature: 0,
				instructions: `${AGENT_SYSTEM_PROMPT}\n${systemExtra}`.trim(),
				input: toResponsesInput(history),
				tools: toolsOpenAiResponses(),
			}),
			headers: openaiHeaders(settings),
		};
	}
	return {
		url: joinUrl(base, '/chat/completions'),
		body: JSON.stringify({
			model: settings.model.trim(),
			temperature: 0,
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

export function parseAgentResponse(provider: LlmSettings['provider'], data: unknown): ParsedAgentResponse {
	if (provider === 'anthropic') {
		const d = data as Record<string, any>;
		const content: Array<Record<string, any>> = Array.isArray(d?.content) ? d.content : [];
		const text = content.filter(i => i?.type === 'text').map(i => String(i.text || '')).join('');
		const toolCalls = content.filter(i => i?.type === 'tool_use').map(i => ({
			id: String(i.id || `tool_${Math.random().toString(36).slice(2)}`),
			name: String(i.name || ''),
			arguments: parseArgs(i.input),
		}));
		return { text, toolCalls };
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
		const toolCalls = output.filter(i => i?.type === 'function_call').map(i => ({
			id: String(i.call_id || i.id || `tool_${Math.random().toString(36).slice(2)}`),
			name: String(i.name || ''),
			arguments: parseArgs(i.arguments),
		}));
		return { text, toolCalls };
	}
	const d = data as Record<string, any>;
	const msg = d?.choices?.[0]?.message || {};
	const text = typeof msg.content === 'string' ? msg.content : '';
	const calls: Array<Record<string, any>> = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
	const toolCalls = calls.map(c => ({
		id: String(c.id || `tool_${Math.random().toString(36).slice(2)}`),
		name: String(c.function?.name || c.name || ''),
		arguments: parseArgs(c.function?.arguments ?? c.arguments),
	}));
	return { text, toolCalls };
}

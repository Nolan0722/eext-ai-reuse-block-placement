/**
 * 对话编排：多轮 tool 循环 + 确认卡令牌。
 * 模型只能调用 propose_* / search_modules / get_module / refresh_catalog / self_check；
 * 真正的放置/编辑/导出由 iframe 持令牌调用。
 */
import type { CatalogJson, CatalogStatsView } from '../catalog';
import type { CachedGeometry, PlaceBox, PlaceMode, PlaceTarget, RegionStyle } from '../cbb';
import type { HistoryTurn } from './llm';
import type { CatalogStoreRecord, FlatModule } from './store';
import type { AgentToolName } from './tools';
import { fetchCatalog } from '../catalog';
import { activateSchematicPage, cacheGeometry, collectPageObstacles, DEFAULT_PAGE_WIDTH, estimateGeometry, getCurrentDocState, loadGeometry, modifyCbbModule, parsePlaceTarget, placeCbbModule, planAlignedPlacement, premeasureGeometry, readCbbSchematicSummary } from '../cbb';
import { effectiveLibraryScope, runSelfCheck } from '../env';
import { exportProjectPackage } from '../pkg';
import { getLlmSettings, getPlacementSettings } from '../settings';
import { classifyLlmError, registerAbort, releaseAbort, sendLlmRequest, STREAM_SENTINEL } from './http';
import { buildAgentRequest, buildPingRequest, parseAgentResponse, StreamAccumulator } from './llm';
import { buildCatalogSummaryPayload, clearCatalogRecord, EMPTY_CATALOG_NOTE, flattenCatalog, humanizeAge, loadCatalogRecord, lookupModule, searchInCatalog, storeCatalog } from './store';
import { AGENT_TOOL_NAMES, MAX_DESC_LEN } from './tools';

/** 单条消息最多发起的模型调用轮数（每轮 = 思考 + 可选工具执行；工具结果驱动下一轮）。 */
const MAX_AGENT_ROUNDS = 12;
/** 单轮对话工具调用总量上限（Round ≠ Tool Call：模型一轮可返回多个调用，需独立限制防异常循环）。 */
const MAX_TOOL_CALLS = 48;
const MAX_HISTORY = 12;
/** compact_history 保留的最近用户轮次：折叠只影响更早的历史（trimHistory 的 12 轮硬兜底不变）。 */
const COMPACT_KEEP_TURNS = 4;
/** 注入轮数信号的阈值：超过该值时每轮提示建议调用 compact_history。 */
const COMPACT_SUGGEST_TURNS = 8;
/** propose_placement 单卡最大候选数（与 schema maxItems 一致；网格批量放置的上限）。 */
const MAX_PLACEMENT_PICKS = 20;

/** Agent 事件流：chatTurn 执行过程中实时推给 UI 的所有事件。 */
export type AgentEvent
	/** 一条思维链增量（仅思考模式且端点返回时出现）。 */
	= | { type: 'reasoning_delta'; delta: string; round: number }
	/** 一条正文增量（流式模式）。 */
		| { type: 'text_delta'; delta: string; round: number }
	/** 模型发起一次工具调用（UI 立即显示"Running"状态）。 */
		| { type: 'tool_start'; name: string; argsSummary: string; round: number; args?: unknown }
	/** 工具执行结束，与 tool_start 按 seqId 对应（UI 原位更新状态与结果）。 */
		| { type: 'tool_end'; seqId: number; event: ChatToolEvent; round: number }
	/** 提案确认卡生成（UI 立即渲染卡片，不等整轮结束）。 */
		| { type: 'card'; card: ChatCardView }
	/** 一个 agent 轮次结束（模型决定调工具 → 工具执行完毕，进入下一轮请求）。 */
		| { type: 'round_end'; round: number }
	/** 整轮结束的最终快照（含完整文本与状态，UI 用于对账）。 */
		| { type: 'final'; result: ChatTurnResult };

export interface ChatTurnCallbacks {
	/** 每个事件实时回调；UI 不在场（如测试）时可不传。 */
	onEvent?: (ev: AgentEvent) => void;
}

/** onEvent 缺省时的空实现。 */
function noopEmitter(_ev: AgentEvent): void { /* 忽略 */ }

export interface ChatToolEvent {
	name: string;
	argsSummary: string;
	status: 'ok' | 'err' | 'skip';
	detail?: unknown;
	/** 模型传入的真实参数（截断后），UI 展示用。 */
	args?: unknown;
	error?: string;
}

export interface PlacePickView {
	uuid: string;
	libraryUuid: string;
	name: string;
	src: string;
	reason: string;
	pageSupport: boolean;
	mode: PlaceMode;
	target: PlaceTarget;
}

export interface PlaceCardView {
	type: 'place';
	token: string;
	picks: Array<PlacePickView>;
	filtered: Array<string>;
	grid?: { dx: number; dy: number };
	notFoundHint?: string;
}

export interface EditCardView {
	type: 'edit';
	token: string;
	libraryUuid: string;
	cbbUuid: string;
	src: string;
	/** 目录中的原始模块名（卡头展示用；name 为 AI 建议名，供输入框预填）。 */
	origName: string;
	name: string;
	description: string;
	/** 本会话内已对该模块成功做过原理图分析（名称/描述由 AI 依据原理图内容生成）。 */
	analyzed?: boolean;
}

export interface ExportPickView {
	uuid: string;
	name: string;
	src: string;
	storage: 'cloud' | 'local';
	/** 本地模块且工程文件路径已解析（zip 内会附带 .eprj2）。 */
	hasFile: boolean;
}

export interface ExportCardView {
	type: 'export';
	token: string;
	stats: CatalogStatsView;
	picks: Array<ExportPickView>;
}

export type ChatCardView = PlaceCardView | EditCardView | ExportCardView;

export type { CatalogStatsView };

export interface ChatTurnResult {
	assistantText: string;
	tools: Array<ChatToolEvent>;
	cards: Array<ChatCardView>;
	gotoSettings?: boolean;
	llmConfigured: boolean;
	error?: { kind: string; message: string; gotoSettings?: boolean };
}

/** 放置形式：symbol=复用模块符号，page=复用模块图页。两种都会标注。位置见 PlaceTarget。 */
export type { PlaceMode, PlaceTarget };

export interface PlaceCbbItem {
	libraryUuid: string;
	cbbUuid: string;
	name: string;
	mode: PlaceMode;
	target: PlaceTarget;
	/** 标注框样式（确认卡可调；缺省=宿主默认）。标题样式固定。 */
	style?: RegionStyle;
}

/**
 * 确认卡令牌记录。status 之外必须绑定提案内容：confirm 以卡上载荷为权威，
 * 不信任客户端回传的 libraryUuid/cbbUuid——授权语义是「按这张���执行」，
 * 而非「持卡可对目录里任意模块执行一次」。
 */
interface CardRecord {
	type: 'place' | 'edit' | 'export';
	status: 'open' | 'done' | 'dead';
	/** edit 提案：身份字段不可变；confirm 只接受用户可编辑的 name/description。 */
	edit?: { libraryUuid: string; cbbUuid: string; name: string; description: string };
	/** place/export 提案：允许勾选的 uuid 全集（= 卡上 picks），提交范围必须是它的子集。 */
	allowedUuids?: Set<string>;
}

interface ChatSession {
	history: Array<HistoryTurn>;
	cards: Map<string, CardRecord>;
	/** 本会话内已成功做过原理图分析的模块 uuid（给编辑卡打"已分析"标记）。 */
	analyzed: Set<string>;
}

const sessions = new Map<string, ChatSession>();

function sessionOf(id: string): ChatSession {
	let s = sessions.get(id);
	if (!s) {
		s = { history: [], cards: new Map(), analyzed: new Set() };
		sessions.set(id, s);
	}
	return s;
}

export function resetChatSession(sessionId: string): void {
	sessions.delete(sessionId);
}

function newToken(): string {
	return `card_${randomTokenSuffix()}`;
}

/** 确认卡令牌的随机部分：优先 crypto.randomUUID / getRandomValues，宿主不支持时退回时间戳+Math.random。 */
function randomTokenSuffix(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
	if (typeof c?.randomUUID === 'function')
		return c.randomUUID();
	if (typeof c?.getRandomValues === 'function') {
		const a = new Uint8Array(16);
		c.getRandomValues(a);
		return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
	}
	return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 确认卡传来的标注样式未填字段用设置页「放置排布」里的全局值补齐。 */
function mergeStyleWithSettings(style?: RegionStyle): RegionStyle {
	const s = getPlacementSettings();
	return {
		borderColor: style?.borderColor ?? (s.borderColor || null),
		borderWidth: typeof style?.borderWidth === 'number' && style.borderWidth > 0 ? style.borderWidth : s.borderWidth,
		margin: typeof style?.margin === 'number' && style.margin >= 0 ? style.margin : s.margin,
	};
}

function invalidateOpenCards(s: ChatSession): void {
	for (const rec of s.cards.values()) {
		if (rec.status === 'open')
			rec.status = 'dead';
	}
}

function redactSecrets(text: string): string {
	return text.replace(/\b(sk-|sk-ant-|rk-)[\w\-]{8,}\b/g, '$1***');
}

function settingsReady(): { ok: true } | { ok: false; missing: Array<string> } {
	const s = getLlmSettings();
	const missing: Array<string> = [];
	if (!s.baseUrl.trim())
		missing.push('baseUrl');
	if (!s.apiKey.trim())
		missing.push('apiKey');
	if (!s.model.trim())
		missing.push('model');
	return missing.length ? { ok: false, missing } : { ok: true };
}

/**
 * 确保目录记录可用：优先读持久化缓存（跨会话），缓存为空或 force 时拉取并落盘。
 * 返回 summary 供工具结果与事件展示；force 时作废未处理确认卡。
 */
async function ensureCatalog(s: ChatSession, force: boolean): Promise<{ record: CatalogStoreRecord; summary: string }> {
	if (!force) {
		const cached = await loadCatalogRecord();
		if (cached)
			return { record: cached, summary: `使用持久化目录缓存：${cached.stats.modules} 个模块（${humanizeAge(Date.now() - cached.fetchedAt)}拉取）` };
	}
	const report = await fetchCatalog(await effectiveLibraryScope());
	const stats = await storeCatalog(report);
	if (force)
		invalidateOpenCards(s);
	const record = (await loadCatalogRecord())!;
	const failed = record.catalog.libraries.filter(l => l.failed).map(l => `${l.moduleName}：${l.error}`).join('；');
	const summary = failed
		? `目录 ${stats.modules} 个模块，失败库 ${stats.failed}（${failed}）`
		: `目录 ${stats.modules} 个模块 / ${stats.libraries} 库`;
	return { record, summary };
}

function trimHistory(s: ChatSession): void {
	const users = s.history.filter(h => h.role === 'user').length;
	if (users <= MAX_HISTORY)
		return;
	const drop = users - MAX_HISTORY;
	let seen = 0;
	let idx = 0;
	for (let i = 0; i < s.history.length; i++) {
		if (s.history[i].role === 'user') {
			seen++;
			if (seen > drop) {
				idx = i;
				break;
			}
		}
	}
	const omitted = `此前已完成 ${drop} 轮对话（详情已折叠）。`;
	s.history = [{ role: 'user', content: omitted }, ...s.history.slice(idx)];
}

function toolResultJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	}
	catch {
		return String(value);
	}
}

/** UI 展示用 JSON 截断：完整数据要给模型，给用户看的只保留开头防刷屏。 */
const UI_JSON_PREVIEW_LEN = 600;

function uiJsonPreview(value: unknown): string {
	const text = toolResultJson(value);
	if (text.length <= UI_JSON_PREVIEW_LEN)
		return text;
	return `${text.slice(0, UI_JSON_PREVIEW_LEN)}…（已截断，共 ${text.length} 字符）`;
}

interface ToolRunOutcome {
	event: ChatToolEvent;
	card?: ChatCardView;
	gotoSettings?: boolean;
	result: unknown;
}
type ToolHandler = (s: ChatSession, args: Record<string, unknown>, bridgeVersion: string) => Promise<ToolRunOutcome>;

/** 目录缓存为空时返回统一的错误结果，引导模型先调用 refresh_catalog。 */
function missingCatalogOutcome(name: AgentToolName): ToolRunOutcome {
	return {
		event: { name, argsSummary: '目录缓存为空', status: 'err', error: '当前没有目录缓存' },
		result: { ok: false, error: EMPTY_CATALOG_NOTE },
	};
}

/** 检索结果 → 紧凑条目（给 LLM 看的最小字段集）。 */
function compactHit(hit: { module: FlatModule }): Record<string, unknown> {
	const m = hit.module;
	return {
		cbbUuid: m.uuid,
		name: m.name,
		classification: m.classification || [],
		libraryKind: m.libraryKind,
		pageSupport: m.pageSupport,
		descBrief: (m.description || '').slice(0, 80) || undefined,
	};
}

/**
 * 工具执行注册表：键与 AGENT_TOOLS 一一对应（Record<AgentToolName, ...> 穷尽约束），
 * 新增工具漏实现会得到 TS 编译错误——不再依赖 runTool 的字符串 if 链两处手工对齐。
 * 每个 handler 独立作用域，event.name 用字面量，避免与模块名等局部变量遮蔽。
 */
const TOOL_HANDLERS: Record<AgentToolName, ToolHandler> = {
	search_modules: async (_s, args) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('search_modules');
		const query = typeof args.query === 'string' ? args.query : '';
		const limit = Math.min(Math.max(typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 10, 1), 30);
		const hits = searchInCatalog(rec, query, limit);
		return {
			event: { name: 'search_modules', argsSummary: query ? `“${query}”` : '浏览前若干条', status: 'ok', detail: { matched: hits.length, limit } },
			result: {
				ok: true,
				matched: hits.length,
				modules: hits.map(compactHit),
				hint: hits.length ? '推荐/放置/编辑前用 get_module 获取目标模块完整详情；cbbUuid 必须逐字复制。' : '没有匹配模块。可换关键词重试，或提示用户把开源广场模块复制到个人库后 refresh_catalog。',
			},
		};
	},
	get_module: async (_s, args) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('get_module');
		const cbbUuid = String(args.cbbUuid || '');
		const hit = await lookupModule(cbbUuid);
		if (!hit) {
			return {
				event: { name: 'get_module', argsSummary: cbbUuid || '(空)', status: 'err', error: '目录外 uuid' },
				result: { ok: false, error: 'cbbUuid 不在当前目录缓存中。请用 search_modules 重新检索获取有效 uuid。' },
			};
		}
		return {
			event: { name: 'get_module', argsSummary: hit.name, status: 'ok' },
			result: {
				ok: true,
				module: {
					cbbUuid: hit.uuid,
					libraryUuid: hit.libraryUuid,
					name: hit.name,
					description: hit.description || '',
					classification: hit.classification || [],
					boards: hit.boards || [],
					storage: hit.storage,
					localFilePath: hit.localFilePath,
					localBackupDir: hit.localBackupDir,
					libraryKind: hit.libraryKind,
					pageSupport: hit.pageSupport,
				},
			},
		};
	},
	refresh_catalog: async (s) => {
		const got = await ensureCatalog(s, true);
		return {
			event: { name: 'refresh_catalog', argsSummary: '全量重拉并落盘', status: 'ok', detail: got.record.stats },
			result: { ok: true, stats: got.record.stats, summary: got.summary },
		};
	},
	self_check: async (_s, _args, bridgeVersion) => {
		const text = await runSelfCheck(bridgeVersion);
		return {
			event: { name: 'self_check', argsSummary: '宿主 API 面', status: 'ok', detail: text },
			result: { ok: true, text },
		};
	},
	propose_export: async (s) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('propose_export');
		const picks: Array<ExportPickView> = flattenCatalog(rec.catalog).map(m => ({
			uuid: m.uuid,
			name: m.name,
			src: m.src,
			storage: m.storage,
			hasFile: m.storage === 'local' && m.filePathSource === 'indexed',
		}));
		const token = newToken();
		s.cards.set(token, { type: 'export', status: 'open', allowedUuids: new Set(picks.map(p => p.uuid)) });
		const card: ExportCardView = { type: 'export', token, stats: rec.stats, picks };
		return {
			event: { name: 'propose_export', argsSummary: `${card.stats.modules} 模块`, status: 'ok' },
			card,
			result: { ok: true, token, stats: card.stats, hint: '已出示导出确认卡（默认全选），等待用户勾选并确认后才会写文件' },
		};
	},
	inspect_module: async (s, args) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('inspect_module');
		const cbbUuid = String(args.cbbUuid || '');
		const hit = await lookupModule(cbbUuid);
		if (!hit) {
			return {
				event: { name: 'inspect_module', argsSummary: cbbUuid || '(空)', status: 'err', error: '目录外 uuid' },
				result: { ok: false, error: 'cbbUuid 不在当前目录缓存中。请用 search_modules 重新检索获取有效 uuid。' },
			};
		}
		try {
			const summary = await readCbbSchematicSummary(hit.libraryUuid, hit.uuid, hit.name);
			s.analyzed.add(hit.uuid);
			return {
				event: {
					name: 'inspect_module',
					argsSummary: hit.name,
					status: 'ok',
					detail: { deviceCount: summary.deviceCount, nets: summary.nets.length, texts: summary.texts.length },
				},
				result: {
					ok: true,
					current: { name: hit.name, description: hit.description || '', classification: hit.classification || [] },
					summary,
					hint: '已读取模块自带原理图（器件清单/网络名/文字标注）。请据此直接给出建议的 name 与 description（中文、准确、≤300 字），再调用 propose_edit。写库仍需用户在确认卡上确认。',
				},
			};
		}
		catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				event: { name: 'inspect_module', argsSummary: hit.name, status: 'err', error: msg },
				result: { ok: false, error: `读取模块原理图失败：${msg}。可基于目录信息提议，或请用户补充描述。` },
			};
		}
	},
	propose_edit: async (s, args) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('propose_edit');
		const cbbUuid = String(args.cbbUuid || '');
		const hit = await lookupModule(cbbUuid);
		if (!hit) {
			return {
				event: { name: 'propose_edit', argsSummary: cbbUuid || '(空)', status: 'err', error: '目录外 uuid' },
				result: { ok: false, error: 'cbbUuid 不在当前目录缓存中。请用 search_modules 重新检索获取有效 uuid。' },
			};
		}
		// 运行时兜底校验：描述超长直接截断到与目录载荷一致的口径（prompt 只是行为引导，不是安全边界）。
		const suggestedName = typeof args.name === 'string' && args.name.trim() ? args.name : hit.name;
		const description = (typeof args.description === 'string' ? args.description : (hit.description || '')).slice(0, MAX_DESC_LEN);
		const token = newToken();
		// 令牌绑定提案：身份字段（libraryUuid/cbbUuid）以卡为准，confirm 不信任客户端回传。
		s.cards.set(token, { type: 'edit', status: 'open', edit: { libraryUuid: hit.libraryUuid, cbbUuid: hit.uuid, name: suggestedName, description } });
		const card: EditCardView = {
			type: 'edit',
			token,
			libraryUuid: hit.libraryUuid,
			cbbUuid: hit.uuid,
			src: hit.src,
			origName: hit.name,
			name: suggestedName,
			description,
			analyzed: s.analyzed.has(hit.uuid) || undefined,
		};
		return {
			event: { name: 'propose_edit', argsSummary: card.name, status: 'ok' },
			card,
			result: { ok: true, token, name: card.name, hint: '已出示编辑确认卡，等待用户确认后才会写库' },
		};
	},
	propose_placement: async (s, args) => {
		const rec = await loadCatalogRecord();
		if (!rec)
			return missingCatalogOutcome('propose_placement');
		const raw = Array.isArray(args.picks) ? args.picks as Array<Record<string, unknown>> : [];
		const filtered: Array<string> = [];
		const picks: Array<PlacePickView> = [];
		for (const it of raw.slice(0, MAX_PLACEMENT_PICKS)) {
			const uuid = typeof it.cbbUuid === 'string' ? it.cbbUuid : '';
			const hit = await lookupModule(uuid);
			if (!hit) {
				filtered.push(`${String(it.name || uuid || '(空)')}（不在目录中）`);
				continue;
			}
			// 默认图页形式：模块符号可能尚未生成（空符号不可见且会重叠），仅 LLM 显式给 symbol 才用符号。
			// pageSupport 兜底：不支持图页的库类型强制回符号（2026-09-16 起三类库均支持图页——
			// 本地库 uuid 由 .eprj2 解析，不再依赖会崩溃的 lib_Cbb.get）。
			let mode: PlaceMode = it.mode === 'symbol' ? 'symbol' : 'page';
			if (!hit.pageSupport)
				mode = 'symbol';
			const target: PlaceTarget = parsePlaceTarget(it.target);
			picks.push({
				uuid: hit.uuid,
				libraryUuid: hit.libraryUuid,
				name: typeof it.name === 'string' && it.name ? it.name : hit.name,
				src: hit.src,
				reason: typeof it.reason === 'string' ? it.reason : '',
				pageSupport: hit.pageSupport,
				mode,
				target,
			});
		}
		const notFoundHint = typeof args.notFoundHint === 'string' ? args.notFoundHint : undefined;
		if (!picks.length) {
			return {
				event: { name: 'propose_placement', argsSummary: '无有效候选', status: 'ok', detail: { filtered, notFoundHint } },
				result: { ok: true, picks: [], filtered, notFoundHint: notFoundHint || '没有可出示的有效模块' },
			};
		}
		const token = newToken();
		// 令牌绑定提案：用户只能勾选卡上 picks 的子集，不能提交提案外的模块。
		s.cards.set(token, { type: 'place', status: 'open', allowedUuids: new Set(picks.map(p => p.uuid)) });
		const card: PlaceCardView = {
			type: 'place',
			token,
			picks,
			filtered,
			grid: undefined,
			notFoundHint,
		};
		return {
			event: { name: 'propose_placement', argsSummary: `${picks.length} 个候选`, status: 'ok', detail: { filtered } },
			card,
			result: { ok: true, token, picks: picks.map(p => p.name), filtered, hint: '已出示放置确认卡，等待用户确认后才会改动画布' },
		};
	},
	compact_history: async (s, args) => {
		const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
		if (!summary) {
			return {
				event: { name: 'compact_history', argsSummary: '摘要为空', status: 'err', error: '缺少 summary' },
				result: { ok: false, error: 'summary 不能为空：把此前对话的完整摘要（用户的要求与约束、已完成/进行中的事项、已达成的决定）写入 summary 后重试。' },
			};
		}
		const users = s.history.filter(h => h.role === 'user').length;
		if (users <= COMPACT_KEEP_TURNS) {
			return {
				event: { name: 'compact_history', argsSummary: '历史较短', status: 'skip' },
				result: { ok: true, compacted: false, hint: `当前仅 ${users} 轮对话，无需折叠。` },
			};
		}
		// 保留窗口起点：倒数第 COMPACT_KEEP_TURNS 个用户消息处；其后内容（含工具流量与进行中的本轮）原样保留。
		let seen = 0;
		let idx = 0;
		for (let i = s.history.length - 1; i >= 0; i--) {
			if (s.history[i].role === 'user') {
				seen++;
				if (seen === COMPACT_KEEP_TURNS) {
					idx = i;
					break;
				}
			}
		}
		const dropped = users - COMPACT_KEEP_TURNS;
		// 摘要以用户轮占位（与 trimHistory 的折叠存根同构）：摘要由调用模型在参数里自带，
		// 此刻完整历史仍在该模型上下文中，它自己就是摘要器——不发起额外 LLM 请求。
		s.history = [{ role: 'user', content: `[对话摘要] ${summary}` }, ...s.history.slice(idx)];
		return {
			event: { name: 'compact_history', argsSummary: `折叠 ${dropped} 轮`, status: 'ok' },
			result: { ok: true, compacted: true, droppedTurns: dropped, hint: '已折叠早期对话，最近几轮原样保留；基于摘要与保留轮次继续当前任务。' },
		};
	},
};

function isAgentToolName(name: string): name is AgentToolName {
	return AGENT_TOOL_NAMES.includes(name);
}

async function runTool(
	s: ChatSession,
	name: string,
	args: Record<string, unknown>,
	bridgeVersion: string,
): Promise<ToolRunOutcome> {
	// name 来自模型输出，是不可信输入——静态穷尽性只约束注册表本身，运行时仍需校验。
	if (!isAgentToolName(name)) {
		return {
			event: { name, argsSummary: '', status: 'err', error: `未知工具 ${name}` },
			result: { ok: false, error: `未知工具 ${name}` },
		};
	}
	return TOOL_HANDLERS[name](s, args, bridgeVersion);
}

export async function chatTurn(
	sessionId: string,
	userText: string,
	bridgeVersion: string,
	callbacks?: ChatTurnCallbacks,
): Promise<ChatTurnResult> {
	const text = redactSecrets((userText || '').trim());
	const s = sessionOf(sessionId);
	const tools: Array<ChatToolEvent> = [];
	const cards: Array<ChatCardView> = [];
	let gotoSettings = false;
	let toolCallCount = 0;
	const emit = callbacks?.onEvent ?? noopEmitter;
	const ac = registerAbort(sessionId);
	const signal = ac.signal;

	const ready = settingsReady();
	if (!ready.ok) {
		releaseAbort(sessionId);
		return {
			assistantText: `尚未配置模型接入（缺少 ${ready.missing.join('、')}）。请到 设置 → 模型接入 填写 baseUrl / apiKey / model。出站走嘉立创代理，请使用国内可达端点，不要填 api.openai.com。`,
			tools,
			cards,
			gotoSettings: true,
			llmConfigured: false,
			error: { kind: 'unconfigured', message: `缺少 ${ready.missing.join('、')}`, gotoSettings: true },
		};
	}

	/** 用户中止的统一出口：已推送的增量作废，恢复话术由 UI 以中止标记呈现。 */
	function abortedResult(): ChatTurnResult {
		return {
			assistantText: '（已停止）',
			tools,
			cards,
			gotoSettings,
			llmConfigured: true,
			error: { kind: 'aborted', message: '用户中止了本轮回复', gotoSettings: false },
		};
	}

	// 目录获取完全由模型调用 search_modules / refresh_catalog 驱动（提示词与上下文摘要引导），插件不在循环外自动预取。
	s.history.push({ role: 'user', content: text });
	trimHistory(s);

	try {
		for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
			if (signal.aborted)
				return abortedResult();
			// 每轮重建目录摘要注入：refresh_catalog 落盘后旧摘要必须作废，
			// 否则同轮上下文里是旧统计、observation 是新统计，模型会被两份数据打架。
			// 摘要仅含统计 + 各库计数 + 新鲜度（几百 token）；模块明细走 search_modules/get_module。
			// loadCatalogRecord 读内存缓存 → sys_Storage（唯一持久层）：扩展重启后内存层为空，
			// 首轮经此从落盘缓存回填——持久化缓存有效时注入真实摘要而非"缓存为空"，
			// 避免模型每次重启都盲目 refresh_catalog 重拉全量（约 20 秒）；refresh 落盘后内存层已更新，仍即时生效。
			const catalogRecord = await loadCatalogRecord();
			const userTurns = s.history.filter(h => h.role === 'user').length;
			// 轮数信号：模型无法自数轮数，注入确定性计数；超过阈值时明确建议压缩（compact_history）。
			const historyNote = `\n\n当前对话 ${userTurns} 轮${userTurns > COMPACT_SUGGEST_TURNS ? '，建议调用 compact_history 折叠早期对话（把此前对话的完整摘要写入 summary 参数）' : ''}。`;
			const catalogNote = catalogRecord
				? `\n\n目录缓存摘要（模块明细不在上下文中，检索用 search_modules）：\n${buildCatalogSummaryPayload(catalogRecord)}${historyNote}`
				: `\n\n${EMPTY_CATALOG_NOTE}${historyNote}`;
			const settings = getLlmSettings();
			const req = buildAgentRequest(settings, catalogNote, s.history);
			req.stream = true;
			// 流式路径：delta 实时转发；累积器负责把三家协议的增量拼回完整响应。
			// 通道不支持分块时 sendLlmRequest 自动降级返回完整 JSON（旧解析路径）。
			const acc = new StreamAccumulator();
			const data = await sendLlmRequest(req, {
				onChunk: (chunk) => {
					const { textDelta, reasoningDelta } = acc.feed(settings.provider, chunk);
					if (reasoningDelta)
						emit({ type: 'reasoning_delta', delta: reasoningDelta, round });
					if (textDelta)
						emit({ type: 'text_delta', delta: textDelta, round });
				},
			}, signal);
			if (signal.aborted)
				return abortedResult();
			// STREAM_SENTINEL：流式路径已完成（载荷经 acc 拼装）；否则为缓冲完整 JSON。
			const streamed = data === STREAM_SENTINEL;
			const parsed = streamed ? acc.result() : parseAgentResponse(settings.provider, data);
			if (!streamed) {
				// 缓冲路径没走过增量回调：整段一次性补发，UI 渲染口径与流式一致。
				if (parsed.reasoning)
					emit({ type: 'reasoning_delta', delta: parsed.reasoning, round });
				if (parsed.text)
					emit({ type: 'text_delta', delta: parsed.text, round });
			}
			if (!parsed.toolCalls.length) {
				const assistantText = redactSecrets(parsed.text || '（模型没有返回文本）');
				s.history.push({ role: 'assistant', content: assistantText });
				const finalResult: ChatTurnResult = { assistantText, tools, cards, gotoSettings, llmConfigured: true };
				emit({ type: 'final', result: finalResult });
				return finalResult;
			}
			s.history.push({ role: 'assistant', content: parsed.text || '', toolCalls: parsed.toolCalls });
			// 思维链属于过程信息，不进 history（避免污染下一轮上下文与 token 预算）。
			for (const call of parsed.toolCalls) {
				// 用户中止：补写占位工具结果，保持 assistant(tool_calls)/tool 成对，下一轮请求才合法。
				if (signal.aborted) {
					s.history.push({
						role: 'tool',
						content: toolResultJson({ ok: false, error: '用户中止了本轮回复' }),
						toolCallId: call.id,
						toolName: call.name,
					});
					return abortedResult();
				}
				const args = (call.arguments && typeof call.arguments === 'object' ? call.arguments : {}) as Record<string, unknown>;
				if (toolCallCount >= MAX_TOOL_CALLS) {
					const skipEvent: ChatToolEvent = { name: call.name, argsSummary: '已达调用总量上限', status: 'skip', error: '工具调用总量已达上限', args: uiJsonPreview(args) };
					tools.push(skipEvent);
					emit({ type: 'tool_start', name: call.name, argsSummary: '已达调用总量上限', round, args: uiJsonPreview(args) });
					emit({ type: 'tool_end', seqId: tools.length - 1, event: skipEvent, round });
					s.history.push({
						role: 'tool',
						content: toolResultJson({ ok: false, error: '工具调用总量已达上限，请基于已有信息直接总结回复用户' }),
						toolCallId: call.id,
						toolName: call.name,
					});
					continue;
				}
				toolCallCount++;
				const argsSummary = summarizeToolArgs(call.name, args);
				emit({ type: 'tool_start', name: call.name, argsSummary, round, args: uiJsonPreview(args) });
				const seqId = tools.length;
				try {
					// 工具内中止检查：长工具（refresh_catalog / inspect_module）执行完立即停下，不再发起下一轮。
					const ran = signal.aborted ? null : await runTool(s, call.name, args, bridgeVersion);
					if (!ran) {
						tools.push({ name: call.name, argsSummary, status: 'skip', error: '用户中止', args: uiJsonPreview(args) });
						s.history.push({
							role: 'tool',
							content: toolResultJson({ ok: false, error: '用户中止了本轮回复' }),
							toolCallId: call.id,
							toolName: call.name,
						});
						return abortedResult();
					}
					ran.event.args = uiJsonPreview(args);
					tools.push(ran.event);
					if (ran.card) {
						cards.push(ran.card);
						emit({ type: 'card', card: ran.card });
					}
					if (ran.gotoSettings)
						gotoSettings = true;
					emit({ type: 'tool_end', seqId, event: ran.event, round });
					s.history.push({
						role: 'tool',
						content: toolResultJson(ran.result),
						toolCallId: call.id,
						toolName: call.name,
					});
				}
				catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					const errEvent: ChatToolEvent = { name: call.name, argsSummary: '', status: 'err', error: msg, args: uiJsonPreview(args) };
					tools.push(errEvent);
					emit({ type: 'tool_end', seqId, event: errEvent, round });
					s.history.push({
						role: 'tool',
						content: toolResultJson({ ok: false, error: msg }),
						toolCallId: call.id,
						toolName: call.name,
					});
				}
			}
			// 本轮工具全部执行完毕：通知 UI 轮次边界（下一轮请求即将发出，模型会重新思考）。
			emit({ type: 'round_end', round });
		}
		const capped: ChatTurnResult = {
			assistantText: '本轮工具调用次数已达上限。你可以再发一条消息继续，或直接在确认卡上操作。',
			tools,
			cards,
			gotoSettings,
			llmConfigured: true,
		};
		emit({ type: 'final', result: capped });
		return capped;
	}
	catch (e) {
		if (signal.aborted)
			return abortedResult();
		const { kind, message } = classifyLlmError(e);
		const goto = kind === 'auth' || kind === 'path' || kind === 'unconfigured' || kind === 'permission';
		// llm.request 伪工具事件已移除：出站 HTTP 是插件行为而非模型工具调用，
		// 失败信息经 assistantText 恢复话术与 error 字段呈现。
		const failed: ChatTurnResult = {
			assistantText: recoverySpeech(kind, message),
			tools,
			cards,
			gotoSettings: goto,
			llmConfigured: true,
			error: { kind, message, gotoSettings: goto },
		};
		emit({ type: 'final', result: failed });
		return failed;
	}
	finally {
		releaseAbort(sessionId);
	}
}

/** tool_start 的参数摘要：与各工具 event.argsSummary 的口径保持一致（轻量，不发敏感内容）。 */
function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case 'search_modules':
			return String(args.query || '').trim() ? `“${String(args.query).trim()}”` : '浏览目录';
		case 'refresh_catalog':
			return '全量重拉并落盘';
		case 'self_check':
			return '宿主 API 面';
		case 'inspect_module':
		case 'propose_edit':
		case 'get_module':
			return String(args.cbbUuid || '(待解析)');
		case 'propose_placement':
			return Array.isArray(args.picks) ? `${args.picks.length} 个候选` : '候选';
		case 'propose_export':
			return '导出确认卡';
		case 'compact_history':
			return '折叠早期对话';
		default:
			return '';
	}
}

function recoverySpeech(kind: string, message: string): string {
	switch (kind) {
		case 'auth':
			return '调用模型端点失败了：**鉴权失败**——通常是 apiKey 无效或已过期。请到 设置 → 模型接入 检查 Key 是否完整。';
		case 'path':
			return '调用模型端点失败了：**HTTP 404**。baseUrl 应填到 /v1 这一级（例如 https://api.deepseek.com/v1），可在设置中修改。';
		case 'rate':
			return '调用模型端点失败了：**请求被限流**。请稍后重试或更换端点。';
		case 'timeout':
			return '调用模型端点失败了：**响应超时（120s）**。请检查网络或更换 baseUrl。';
		case 'format':
			return '调用模型端点失败了：**响应不是合法 JSON**。路径可能指向了非 API 地址，请确认 baseUrl 含完整路径。';
		case 'permission':
			return '无法出网：**外部交互权限未开启**。请在扩展管理中为本插件启用「外部交互权限」。';
		case 'unconfigured':
			return '尚未配置模型接入，请到 设置 → 模型接入 完成 baseUrl / apiKey / model。';
		default:
			return `调用模型失败：${message}`;
	}
}

function requireCard(sessionId: string, token: string, type: CardRecord['type']): { session: ChatSession; card: CardRecord } {
	const s = sessionOf(sessionId);
	const card = s.cards.get(token);
	if (!card || card.type !== type)
		throw new Error('确认卡无效或已过期，请重新发起。');
	if (card.status !== 'open')
		throw new Error(card.status === 'dead' ? '确认卡已作废（目录已更新），请重新发起。' : '确认卡已处理。');
	return { session: s, card };
}

/** 仅取卡记录（不需要 session 的路径：如导出确认后置 done）。 */
function requireCardRecord(sessionId: string, token: string): CardRecord | undefined {
	return sessionOf(sessionId).cards.get(token);
}

export async function confirmPlace(
	sessionId: string,
	token: string,
	items: Array<PlaceCbbItem>,
	grid?: { dx: number; dy: number },
): Promise<{ results: Array<{ cbbUuid: string; name: string; ok: boolean; error?: string; pageName?: string; fallbackFromSymbol?: boolean }> }> {
	const { session: s, card } = requireCard(sessionId, token, 'place');
	if (!items.length)
		throw new Error('未勾选任何模块');
	// 令牌绑定提案：只接受卡上 picks 的子集，拒绝提案外模块（客户端错传/换模块一律拒绝）。
	if (!card.allowedUuids)
		throw new Error('确认卡缺少提案内容，请重新发起。');
	for (const it of items) {
		if (!card.allowedUuids.has(it.cbbUuid))
			throw new Error(`模块 ${it.name || it.cbbUuid} 不在这张确认卡的提案中，请重新发起。`);
	}
	for (const it of items) {
		const hit = await lookupModule(it.cbbUuid);
		if (!hit || hit.libraryUuid !== it.libraryUuid)
			throw new Error(`模块 ${it.name || it.cbbUuid} 不在当前目录缓存中`);
		if (it.mode === 'page' && !hit.pageSupport)
			throw new Error(`${it.name} 所在库不支持复用模块图页放置`);
	}
	// 目录权威模块名（与 items 同序）：本地库图页放置按它定位 .eprj2（卡上的 it.name 可被用户改，不作文件定位键）。
	const moduleNames = await Promise.all(items.map(async (it) => {
		const hit = await lookupModule(it.cbbUuid);
		return hit?.name || it.name;
	}));
	const origin = await getCurrentDocState();
	const staysOnPage = (t: PlaceTarget) => t === 'current' || t === 'new';
	const needsOrigin = items.some(it => staysOnPage(parsePlaceTarget(it.target)));
	if (needsOrigin && (!origin.ok || !origin.uuid))
		throw new Error('当前活动文档不是原理图页，无法在当前/新建图页放置。请切换到原理图页，或改用「新建板子」「新建工程」。');
	const placement = getPlacementSettings();
	const gapX = grid?.dx && grid.dx > 0 ? grid.dx : placement.gapX;
	const gapY = grid?.dy && grid.dy > 0 ? grid.dy : placement.gapY;
	const currentFlags = items.map(it => parsePlaceTarget(it.target) === 'current');
	// 唯一排布路径：先收集当前图页已占用区域与图页宽度，再按等大单元格网格规划落点。
	// 单个模块即 1×1 网格（⌈√1⌉=1），与批量走完全相同的对齐/避让/换行算法；
	// 新建图页/板子/工程落点不需要避让，坐标恒为页面中心 (0,0)。
	const metrics = origin.ok
		? await collectPageObstacles()
		: { obstacles: [] as Array<PlaceBox>, pageWidth: DEFAULT_PAGE_WIDTH, pageHeight: 825 };
	const gridObstacles = metrics.obstacles;
	const pageWidth = metrics.pageWidth;
	// 几何已知用缓存；未命中时先预测量（打开模块自带页量包围盒后切回），失败再用保守估计。
	// 预测量让首批排布即精确，消除"首批与后续批次不一致"的问题；放置后实测回写仍是最终口径。
	const currentGeoms: Array<CachedGeometry> = [];
	for (let i = 0; i < items.length; i++) {
		if (!currentFlags[i])
			continue;
		const cached = loadGeometry(items[i].libraryUuid, items[i].cbbUuid);
		if (cached) {
			currentGeoms.push(cached);
			continue;
		}
		const pre = await premeasureGeometry(items[i].libraryUuid, items[i].cbbUuid).catch(() => null);
		currentGeoms.push(pre ?? estimateGeometry());
	}
	const plans = planAlignedPlacement(currentGeoms, gapX, gapY, gridObstacles, pageWidth);
	const plansByItem: Array<{ x: number; y: number } | null> = [];
	{
		let k = 0;
		for (let i = 0; i < items.length; i++) {
			if (!currentFlags[i]) {
				plansByItem.push(null);
				continue;
			}
			plansByItem.push(plans[k] ?? null);
			k++;
		}
	}
	const results: Array<{ cbbUuid: string; name: string; ok: boolean; error?: string; pageName?: string; fallbackFromSymbol?: boolean }> = [];
	let onOrigin = !!(origin.ok && origin.uuid);
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		const target = parsePlaceTarget(it.target);
		const isCurrent = currentFlags[i];
		const isSymbol = it.mode !== 'page';
		const plan = plansByItem[i];
		const x = plan ? plan.x : 0;
		const y = plan ? plan.y : 0;
		try {
			if (staysOnPage(target)) {
				if (target === 'new') {
					onOrigin = false;
				}
				else if (!onOrigin && origin.uuid) {
					await activateSchematicPage(origin.uuid);
					onOrigin = true;
				}
			}
			else {
				onOrigin = false;
			}
			const placed = await placeCbbModule({
				libraryUuid: it.libraryUuid,
				cbbUuid: it.cbbUuid,
				anchor: { x, y },
				mode: isSymbol ? 'symbol' : 'page',
				target,
				title: it.name,
				// 本地库图页放置的 .eprj2 文件定位键，见 moduleNames 收集处的注释。
				moduleName: moduleNames[i],
				style: mergeStyleWithSettings(it.style),
			});
			if (isCurrent && placed.occupied) {
				// 实测几何写入缓存：锚点即排布器给的落点（无二次避让修正），缓存悬出量准确。
				cacheGeometry(it.libraryUuid, it.cbbUuid, placed.occupied, placed.anchor.x, placed.anchor.y);
				gridObstacles.push(placed.occupied);
			}
			results.push({ cbbUuid: it.cbbUuid, name: it.name, ok: true, pageName: placed.pageName || undefined, fallbackFromSymbol: placed.fallbackFromSymbol });
		}
		catch (e) {
			results.push({ cbbUuid: it.cbbUuid, name: it.name, ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	}
	const rec = s.cards.get(token);
	if (rec)
		rec.status = 'done';
	return { results };
}

export async function confirmEdit(
	sessionId: string,
	token: string,
	editable: { name: string; description: string },
): Promise<{ ok: boolean; error?: string }> {
	const { session: s, card } = requireCard(sessionId, token, 'edit');
	const proposal = card.edit;
	if (!proposal)
		throw new Error('确认卡缺少提案内容，请重新发起。');
	// 身份字段（libraryUuid/cbbUuid）以卡上提案为准，不信任客户端回传；用户只能改 name/description。
	const name = typeof editable?.name === 'string' ? editable.name : proposal.name;
	const description = typeof editable?.description === 'string' ? editable.description : proposal.description;
	try {
		await modifyCbbModule({ libraryUuid: proposal.libraryUuid, cbbUuid: proposal.cbbUuid, name, description });
		const rec = s.cards.get(token);
		if (rec)
			rec.status = 'done';
		// 写库成功后持久化目录立即作废：服务器端模块标识与内容都可能变化，
		// 继续沿用旧缓存提议放置会拿旧 uuid/旧信息，导致「编辑成功 → 同会话放置失败」。
		// 清除后下一轮对话模型会先 refresh_catalog 重拉最新目录（2026-09-16 真机回归发现）。
		await clearCatalogRecord();
		// 模块内容已变，此前的原理图分析结论视为过期（uuid 若变化则旧键自然作废）。
		s.analyzed.delete(proposal.cbbUuid);
		return { ok: true };
	}
	catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function confirmExport(sessionId: string, token: string, uuids: Array<string>): Promise<{ ok: boolean; stats?: CatalogStatsView; fileCount?: number; cloudCount?: number; fileName?: string; failed?: Array<{ name: string; error: string }>; error?: string }> {
	const { card } = requireCard(sessionId, token, 'export');
	if (!Array.isArray(uuids) || !uuids.length)
		throw new Error('未勾选任何模块');
	if (!card.allowedUuids)
		throw new Error('确认卡缺少提案内容，请重新发起。');
	for (const uuid of uuids) {
		if (!card.allowedUuids.has(uuid))
			throw new Error('导出清单与确认卡提案不一致，请重新发起。');
	}
	try {
		// 复用持久化目录导出（与用户确认的内容同源，避免确认后重拉目录导致清单漂移）；
		// 传入深拷贝，防止 pkg 内的过滤/回写污染存储状态；文件定位在导出时仍按磁盘实况执行。
		// 缓存为空时 pkg 回退为重新拉取（exportProjectPackage 内置该路径）。
		const catalogRec = await loadCatalogRecord();
		const snapshot = catalogRec
			? JSON.parse(JSON.stringify(catalogRec.catalog)) as CatalogJson
			: undefined;
		const r = await exportProjectPackage(uuids, snapshot);
		if (!r.ok && !r.cancelled)
			throw new Error('导出失败');
		const cardRec = requireCardRecord(sessionId, token);
		if (cardRec && r.ok)
			cardRec.status = 'done';
		return { ok: r.ok, stats: r.stats, fileCount: r.fileCount, cloudCount: r.cloudCount, fileName: r.fileName, failed: r.failed, error: r.cancelled ? '已取消' : undefined };
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/cancel|取消|abort/i.test(msg))
			return { ok: false, error: '已取消' };
		return { ok: false, error: msg };
	}
}

export function cancelCard(sessionId: string, token: string): void {
	const rec = sessionOf(sessionId).cards.get(token);
	if (rec && rec.status === 'open')
		rec.status = 'dead';
}

export async function testLlmConnection(): Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }> {
	const ready = settingsReady();
	if (!ready.ok)
		return { ok: false, model: '', latencyMs: 0, error: `缺少 ${ready.missing.join('、')}` };
	const settings = getLlmSettings();
	const started = Date.now();
	try {
		await sendLlmRequest(buildPingRequest(settings));
		return { ok: true, model: settings.model.trim(), latencyMs: Date.now() - started };
	}
	catch (e) {
		const { message } = classifyLlmError(e);
		return { ok: false, model: settings.model.trim(), latencyMs: Date.now() - started, error: message };
	}
}

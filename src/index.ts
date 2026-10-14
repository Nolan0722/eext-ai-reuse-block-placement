/**
 * 扩展入口 + iframe 桥。UI 在 iframe/chat.html；写画布/写库/导出必须走确认卡令牌。
 */
import type { AgentEvent, CatalogStatsView, ChatTurnResult, CreateModuleConfirmResult, CreateModuleEditable, PlaceCbbItem } from './agent/loop';
import type { CatalogImportApplied, CatalogImportPolicy, CatalogImportPreview, CatalogLibraryAdmin } from './agent/store';
import type { JevSettings, LlmSettings, PlacementSettings } from './settings';
import * as extensionConfig from '../extension.json';
import { abortSession } from './agent/http';
import { testJevConnection } from './agent/jev';
import { cancelCard, chatTurn, confirmCreateModule, confirmEdit, confirmExport, confirmPlace, resetChatSession, testLlmConnection } from './agent/loop';
import { applyCatalogImport, describeCatalogLibraries, exportCatalog, previewCatalogImport, refreshCatalogExclusive } from './agent/store';
import { runSelfCheck } from './env';
import { edaGlobal } from './host';
import { getDefaultStylePrompt, getJevSettings, getLlmSettings, getLocalLibraryPath, getPlacementSettings, getStylePresets, getStylePrompt, saveHiddenLibraryKeys, saveJevSettings, saveLlmSettings, saveLocalLibraryPath, savePlacementSettings, saveStylePrompt } from './settings';

export const VERSION = extensionConfig.version;

export interface CbbCopilotBridge {
	version: string;
	getLlmSettings: () => LlmSettings;
	saveLlmSettings: (s: LlmSettings) => void;
	/** Jev 语义推荐设置（独立 Key 与开关；与主 LLM 相互独立）。 */
	getJevSettings: () => JevSettings;
	saveJevSettings: (s: JevSettings) => void;
	getLocalLibraryPath: () => string;
	saveLocalLibraryPath: (path: string) => void;
	getPlacementSettings: () => PlacementSettings;
	savePlacementSettings: (s: PlacementSettings) => void;
	/** 用户自定义的风格与限制（附在固定工作流程之后）。 */
	getStylePrompt: () => string;
	getDefaultStylePrompt: () => string;
	getStylePresets: () => { rigorous: string; relaxed: string };
	saveStylePrompt: (text: string) => void;
	/** 已拉取目录的库列表，以及各库是否对模型可见。 */
	getCatalogAdmin: () => Promise<{ empty: boolean; fetchedAt: number; moduleCount: number; libraries: Array<CatalogLibraryAdmin> }>;
	/** 手动全量重拉目录并落盘。 */
	refreshCatalogNow: () => Promise<{ ok: boolean; modules?: number; libraries?: number; error?: string }>;
	/** 对照当前目录，不写存储。raw 为导出的目录 JSON（或带 catalog 字段的存储记录）。 */
	previewCatalogImport: (raw: unknown) => Promise<{ ok: boolean; preview?: CatalogImportPreview; error?: string }>;
	/** 按策略合并进 catalog_store.v1。文件没提到的库保持不变。 */
	applyCatalogImport: (raw: unknown, policy: CatalogImportPolicy) => Promise<{ ok: boolean; error?: string } & Partial<CatalogImportApplied>>;
	/** 另存当前勾选的库。未勾选的库不写入文件。 */
	exportCatalog: (libraryKeys: Array<string>) => Promise<{ ok: boolean; cancelled?: boolean; fileName?: string; modules?: number; libraries?: number; error?: string }>;
	/** 保存当前勾选：未勾选的库对模型不可见。 */
	saveHiddenLibraryKeys: (keys: Array<string>) => void;
	/** 注册 Agent 事件监听（每次 chatTurn 实时推送 reasoning/text delta、工具状态、卡片）。重复注册覆盖旧监听。 */
	onAgentEvent: (sessionId: string, handler: (ev: AgentEvent) => void) => void;
	/** 中止进行中的 chatTurn（按钮置为停止时的调用）。返回是否有进行中的轮次被中止。 */
	abortChatTurn: (sessionId: string) => boolean;
	chatTurn: (sessionId: string, userText: string) => Promise<ChatTurnResult>;
	confirmPlace: (sessionId: string, token: string, items: Array<PlaceCbbItem>, grid?: { dx: number; dy: number }) => Promise<{ results: Array<{ cbbUuid: string; name: string; ok: boolean; error?: string; pageName?: string; fallbackFromSymbol?: boolean }> }>;
	confirmEdit: (sessionId: string, token: string, editable: { name: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
	confirmExport: (sessionId: string, token: string, uuids: Array<string>) => Promise<{ ok: boolean; stats?: CatalogStatsView; fileName?: string; error?: string }>;
	/** 建模块确认：libraryKey 是卡上的不透明键，uuid 由主进程解析——前端无法指定任意目标库。 */
	confirmCreateModule: (sessionId: string, token: string, editable: CreateModuleEditable) => Promise<CreateModuleConfirmResult>;
	cancelCard: (sessionId: string, token: string) => void;
	resetChatSession: (sessionId: string) => void;
	selfCheck: () => Promise<string>;
	testConnection: () => Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }>;
	/** Jev 链路连通性测试（最小 noul 评估）：校验 Jev baseUrl / Key / model。 */
	testJevConnection: () => Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }>;
}

/** 会话 → 事件监听（UI 注册；同一会话只保留最新监听，UI 重载后自动覆盖旧引用）。 */
const agentEventListeners = new Map<string, (ev: AgentEvent) => void>();

function installBridge(): void {
	const edaRef = edaGlobal();
	if (!edaRef)
		return;
	const bridge: CbbCopilotBridge = {
		version: VERSION,
		getLlmSettings,
		saveLlmSettings,
		getJevSettings,
		saveJevSettings,
		getLocalLibraryPath,
		saveLocalLibraryPath,
		getPlacementSettings,
		savePlacementSettings,
		getStylePrompt,
		getDefaultStylePrompt,
		getStylePresets,
		saveStylePrompt,
		getCatalogAdmin: () => describeCatalogLibraries(),
		refreshCatalogNow: async () => {
			try {
				const stats = await refreshCatalogExclusive();
				return { ok: true, modules: stats.modules, libraries: stats.libraries };
			}
			catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		saveHiddenLibraryKeys,
		previewCatalogImport: async (raw) => {
			try {
				return { ok: true, preview: await previewCatalogImport(raw) };
			}
			catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		applyCatalogImport: async (raw, policy) => {
			try {
				return { ok: true, ...await applyCatalogImport(raw, policy) };
			}
			catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		exportCatalog: async (libraryKeys) => {
			try {
				return { ok: true, ...await exportCatalog(libraryKeys) };
			}
			catch (e) {
				return { ok: false, error: e instanceof Error ? e.message : String(e) };
			}
		},
		onAgentEvent: (sessionId, handler) => {
			if (typeof handler === 'function')
				agentEventListeners.set(sessionId, handler);
			else
				agentEventListeners.delete(sessionId);
		},
		abortChatTurn: sessionId => abortSession(sessionId),
		chatTurn: (sessionId, userText) => chatTurn(sessionId, userText, VERSION, {
			onEvent: (ev) => {
				// 监听器异常与 UI 生命周期解耦：回调抛错只记日志，不中断 agent 循环。
				try {
					agentEventListeners.get(sessionId)?.(ev);
				}
				catch (e) {
					console.warn('[cbb-copilot] onAgentEvent handler error:', e);
				}
			},
		}),
		confirmPlace,
		confirmEdit,
		confirmExport,
		confirmCreateModule,
		cancelCard,
		resetChatSession: (sessionId) => {
			agentEventListeners.delete(sessionId);
			resetChatSession(sessionId);
		},
		selfCheck: () => runSelfCheck(VERSION),
		testConnection: () => testLlmConnection(),
		testJevConnection: () => testJevConnection(getJevSettings()),
	};
	edaRef.ai_reuse_block_placement = bridge;
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	console.warn(`ai-reuse-block-placement v${VERSION} activated`);
	installBridge();
}

export function deactivate(): void {
	console.warn('AI Reuse Block Placement deactivated');
}

export async function openCopilot(): Promise<void> {
	installBridge();
	if (typeof eda !== 'undefined' && eda.sys_IFrame) {
		let title = 'AI Reuse Block Placement';
		try {
			const lang = await eda.sys_I18n?.getCurrentLanguage?.();
			if (lang && String(lang).toLowerCase().startsWith('zh')) {
				title = '复用模块智能助手';
			}
		}
		catch { /* 回退英文标题 */ }
		const success = await eda.sys_IFrame.openIFrame(
			'/iframe/chat.html',
			960,
			720,
			'ai-reuse-block-placement',
			{ title, maximizeButton: true, minimizeButton: true },
		);
		if (!success) {
			console.error('Failed to open AI Reuse Block Placement panel');
		}
	}
}

if (typeof window !== 'undefined' && typeof eda !== 'undefined') {
	activate();
}

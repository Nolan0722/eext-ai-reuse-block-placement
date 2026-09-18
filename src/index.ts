/**
 * 扩展入口 + iframe 桥。UI 在 iframe/chat.html；写画布/写库/导出必须走确认卡令牌。
 */
import type { CatalogStatsView, ChatTurnResult, PlaceCbbItem } from './agent/loop';
import type { ClientEnv } from './env';
import type { LlmSettings, PlacementSettings } from './settings';
import * as extensionConfig from '../extension.json';
import { cancelCard, chatTurn, confirmEdit, confirmExport, confirmPlace, resetChatSession, testLlmConnection } from './agent/loop';
import { detectClientEnv, runSelfCheck } from './env';
import { edaGlobal } from './host';
import { importProjectPackage } from './pkg';
import { getLibraryScope, getLlmSettings, getLocalLibraryPath, getPlacementSettings, getProjectDirs, saveLibraryScope, saveLlmSettings, saveLocalLibraryPath, savePlacementSettings, saveProjectDirs } from './settings';

export const VERSION = extensionConfig.version;

export interface CbbCopilotBridge {
	version: string;
	getLlmSettings: () => LlmSettings;
	saveLlmSettings: (s: LlmSettings) => void;
	getLibraryScope: () => Record<string, boolean>;
	saveLibraryScope: (scope: Record<string, boolean>) => void;
	getLocalLibraryPath: () => string;
	saveLocalLibraryPath: (path: string) => void;
	getProjectDirs: () => string;
	saveProjectDirs: (dirs: string) => void;
	importProjectPackage: () => Promise<{ ok: boolean; imported: Array<string>; failed: Array<{ file: string; error: string }>; targetDir: string; note?: string; error?: string }>;
	getPlacementSettings: () => PlacementSettings;
	savePlacementSettings: (s: PlacementSettings) => void;
	chatTurn: (sessionId: string, userText: string) => Promise<ChatTurnResult>;
	confirmPlace: (sessionId: string, token: string, items: Array<PlaceCbbItem>, grid?: { dx: number; dy: number }) => Promise<{ results: Array<{ cbbUuid: string; name: string; ok: boolean; error?: string; pageName?: string; fallbackFromSymbol?: boolean }> }>;
	confirmEdit: (sessionId: string, token: string, editable: { name: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
	confirmExport: (sessionId: string, token: string, uuids: Array<string>) => Promise<{ ok: boolean; stats?: CatalogStatsView; fileCount?: number; cloudCount?: number; fileName?: string; failed?: Array<{ name: string; error: string }>; error?: string }>;
	cancelCard: (sessionId: string, token: string) => void;
	resetChatSession: (sessionId: string) => void;
	selfCheck: () => Promise<string>;
	testConnection: () => Promise<{ ok: boolean; model: string; latencyMs: number; error?: string }>;
	getClientEnv: () => Promise<ClientEnv>;
}

function installBridge(): void {
	const edaRef = edaGlobal();
	if (!edaRef)
		return;
	const bridge: CbbCopilotBridge = {
		version: VERSION,
		getLlmSettings,
		saveLlmSettings,
		getLibraryScope,
		saveLibraryScope,
		getLocalLibraryPath,
		saveLocalLibraryPath,
		getProjectDirs,
		saveProjectDirs,
		importProjectPackage: () => importProjectPackage().catch(e => ({ ok: false, imported: [], failed: [], targetDir: '', error: e instanceof Error ? e.message : String(e) })),
		getPlacementSettings,
		savePlacementSettings,
		chatTurn: (sessionId, userText) => chatTurn(sessionId, userText, VERSION),
		confirmPlace,
		confirmEdit,
		confirmExport,
		cancelCard,
		resetChatSession,
		selfCheck: () => runSelfCheck(VERSION),
		testConnection: () => testLlmConnection(),
		getClientEnv: () => detectClientEnv(),
	};
	edaRef.jlc_cbb_copilot = bridge;
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	console.warn(`CBB Copilot v${VERSION} activated`);
	installBridge();
}

export function deactivate(): void {
	console.warn('CBB Copilot deactivated');
}

export async function openCopilot(): Promise<void> {
	installBridge();
	if (typeof eda !== 'undefined' && eda.sys_IFrame) {
		let title = 'CBB Copilot';
		try {
			const lang = await eda.sys_I18n?.getCurrentLanguage?.();
			if (lang && String(lang).toLowerCase().startsWith('zh')) {
				title = '复用模块智能助手';
			}
		}
		catch { /* 回退英文标题 */ }
		const success = await eda.sys_IFrame.openIFrame(
			'/iframe/chat.html',
			440,
			720,
			'jlc-cbb-copilot',
			{ title, maximizeButton: true, minimizeButton: true },
		);
		if (!success) {
			console.error('Failed to open CBB Copilot panel');
		}
	}
}

if (typeof window !== 'undefined' && typeof eda !== 'undefined') {
	activate();
}

/**
 * 设置持久化：localStorage 优先、sys_Storage 兜底（双写）。
 * localStorage 在 EDA 主进程不可用（iframe 内才有），读写都 try/catch 双通道。
 */
import { edaGlobal } from './host';

export type LlmProvider = 'openai-chat' | 'openai-responses' | 'anthropic';

export interface LlmSettings {
	provider: LlmProvider;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** 思考模式开关：true 时请求端点返回思维链（reasoning/thinking），聊天面板可展开查看。 */
	enableThinking: boolean;
}

function parseProvider(raw: string): LlmProvider {
	if (raw === 'anthropic')
		return 'anthropic';
	if (raw === 'openai-responses')
		return 'openai-responses';
	return 'openai-chat';
}

const LS_PREFIX = 'jlc_cbb_copilot_';

const K_PROVIDER = 'llm_provider';
const K_BASE = 'llm_base_url';
const K_KEY = 'llm_api_key';
const K_MODEL = 'llm_model';
const K_THINKING = 'llm_enable_thinking';
const K_SCOPE = 'library_scope';
const K_LOCAL_PATH = 'local_library_path';
const K_PLACE = 'placement_settings';
const K_PROJECT_DIRS = 'project_dirs';

/** 半离线模式下路径发现 API 全部失效时的本地库兜底路径。 */
export const DEFAULT_LOCAL_LIBRARY_PATH = 'C:\\Users\\JLC\\Documents\\LCEDA-Pro\\libraries';

/** 本地工程目录默认路径（EasyEDA Pro 约定位置；在线版 getProjectsPaths 不可用时用此兜底）。 */
export const DEFAULT_PROJECT_DIRS = 'C:\\Users\\JLC\\Documents\\LCEDA-Pro\\projects;C:\\Users\\JLC\\Documents\\LCEDA-Pro\\libraries';

/** 放置排布设置：模块间距与标注框样式（确认卡不再逐次调整，全局生效）。 */
export interface PlacementSettings {
	/** 模块占用框水平空隙（0.01 英寸），默认 80。 */
	gapX: number;
	/** 模块占用框垂直空隙（0.01 英寸），默认 80。 */
	gapY: number;
	/** 标注框颜色 #RRGGBB；空串 = 宿主默认。 */
	borderColor: string;
	/** 标注框线宽；空 = 宿主默认。 */
	borderWidth: number | null;
	/** 包围盒外扩边距（0.01 英寸），默认 40。 */
	margin: number;
}

export const DEFAULT_PLACEMENT_SETTINGS: PlacementSettings = {
	gapX: 80,
	gapY: 80,
	borderColor: '',
	borderWidth: null,
	margin: 40,
};

function storage(): { getExtensionUserConfig?: (k: string) => string; setExtensionUserConfig?: (k: string, v: string) => void } | undefined {
	return (edaGlobal()?.sys_Storage ?? undefined) as { getExtensionUserConfig?: (k: string) => string; setExtensionUserConfig?: (k: string, v: string) => void } | undefined;
}

function lsGet(key: string): string {
	try {
		const v = localStorage?.getItem(LS_PREFIX + key);
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}
function lsSet(key: string, val: string): void {
	try {
		localStorage?.setItem(LS_PREFIX + key, val);
	}
	catch { /* 主进程无 localStorage */ }
}
function sysGet(key: string): string {
	try {
		const v = storage()?.getExtensionUserConfig?.(key);
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}
function sysSet(key: string, val: string): void {
	try {
		storage()?.setExtensionUserConfig?.(key, val);
	}
	catch { /* 独立脚本环境无 sys_Storage */ }
}

export function getLlmSettings(): LlmSettings {
	const thinkRaw = (lsGet(K_THINKING) || sysGet(K_THINKING) || '').trim().toLowerCase();
	return {
		provider: parseProvider(lsGet(K_PROVIDER) || sysGet(K_PROVIDER) || 'openai-chat'),
		baseUrl: lsGet(K_BASE) || sysGet(K_BASE),
		apiKey: lsGet(K_KEY) || sysGet(K_KEY),
		model: lsGet(K_MODEL) || sysGet(K_MODEL),
		enableThinking: thinkRaw === '1' || thinkRaw === 'true',
	};
}

export function saveLlmSettings(s: LlmSettings): void {
	const provider = parseProvider(s.provider);
	lsSet(K_PROVIDER, provider);
	sysSet(K_PROVIDER, provider);
	lsSet(K_BASE, s.baseUrl || '');
	sysSet(K_BASE, s.baseUrl || '');
	lsSet(K_KEY, s.apiKey || '');
	sysSet(K_KEY, s.apiKey || '');
	lsSet(K_MODEL, s.model || '');
	sysSet(K_MODEL, s.model || '');
	lsSet(K_THINKING, s.enableThinking ? '1' : '0');
	sysSet(K_THINKING, s.enableThinking ? '1' : '0');
}

export function getLibraryScope(): Record<string, boolean> {
	const raw = lsGet(K_SCOPE) || sysGet(K_SCOPE);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Record<string, boolean>;
			if (parsed && typeof parsed === 'object') {
				return {
					personal: parsed.personal !== false,
					team: parsed.team !== false,
					local: parsed.local !== false,
				};
			}
		}
		catch { /* 损坏则回退默认 */ }
	}
	return { personal: true, team: true, local: true };
}

export function saveLibraryScope(scope: Record<string, boolean>): void {
	const text = JSON.stringify({
		personal: scope?.personal !== false,
		team: scope?.team !== false,
		local: scope?.local !== false,
	});
	lsSet(K_SCOPE, text);
	sysSet(K_SCOPE, text);
}

export function getLocalLibraryPath(): string {
	return lsGet(K_LOCAL_PATH) || sysGet(K_LOCAL_PATH) || DEFAULT_LOCAL_LIBRARY_PATH;
}

export function saveLocalLibraryPath(path: string): void {
	const p = (path || '').trim();
	lsSet(K_LOCAL_PATH, p);
	sysSet(K_LOCAL_PATH, p);
}

export function getPlacementSettings(): PlacementSettings {
	const raw = lsGet(K_PLACE) || sysGet(K_PLACE);
	if (raw) {
		try {
			const p = JSON.parse(raw) as Partial<PlacementSettings>;
			const gap = (v: unknown, d: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
			const color = typeof p.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(p.borderColor.trim()) ? p.borderColor.trim() : '';
			const width = Number.isFinite(Number(p.borderWidth)) && Number(p.borderWidth) > 0 ? Number(p.borderWidth) : null;
			return {
				gapX: gap(p.gapX, DEFAULT_PLACEMENT_SETTINGS.gapX),
				gapY: gap(p.gapY, DEFAULT_PLACEMENT_SETTINGS.gapY),
				borderColor: color,
				borderWidth: width,
				margin: Number.isFinite(Number(p.margin)) && Number(p.margin) >= 0 ? Number(p.margin) : DEFAULT_PLACEMENT_SETTINGS.margin,
			};
		}
		catch { /* 损坏则回退默认 */ }
	}
	return { ...DEFAULT_PLACEMENT_SETTINGS };
}

export function savePlacementSettings(s: PlacementSettings): void {
	const clean = getPlacementSettings();
	const text = JSON.stringify({
		gapX: s.gapX > 0 ? Number(s.gapX) : clean.gapX,
		gapY: s.gapY > 0 ? Number(s.gapY) : clean.gapY,
		borderColor: typeof s.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.borderColor.trim()) ? s.borderColor.trim() : '',
		borderWidth: Number.isFinite(Number(s.borderWidth)) && Number(s.borderWidth) > 0 ? Number(s.borderWidth) : null,
		margin: Number.isFinite(Number(s.margin)) && Number(s.margin) >= 0 ? Number(s.margin) : clean.margin,
	});
	lsSet(K_PLACE, text);
	sysSet(K_PLACE, text);
}

/** 工程目录列表（分号分隔）：本地工程索引器的扫描范围。 */
export function getProjectDirs(): string {
	return lsGet(K_PROJECT_DIRS) || sysGet(K_PROJECT_DIRS) || DEFAULT_PROJECT_DIRS;
}

export function saveProjectDirs(dirs: string): void {
	const v = (dirs || '').trim() || DEFAULT_PROJECT_DIRS;
	lsSet(K_PROJECT_DIRS, v);
	sysSet(K_PROJECT_DIRS, v);
}

export function parseProjectDirs(dirs: string): Array<string> {
	return (dirs || '')
		.split(/[;\n]/)
		.map(d => d.trim())
		.filter(Boolean);
}

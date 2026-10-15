/**
 * 复用模块目录：类型、拉取、JSON 落盘。
 * search() 不返回符号/图页 UUID；最小三元组 uuid + name + description。
 * 三源（2026-09-11）：个人库 + 团队库（在线，getAllLibrariesList 枚举）+ 本地库（离线路径）。
 */
import { edaGlobal, withTimeout } from './host';
import { getLocalLibraryPath } from './settings';

/**
 * 复用模块图页放置能力：个人/团队库经 lib_Cbb.get().boards[].schematic；
 * 本地库 get() 必崩，图页 uuid 由插件解析 .eprj2 工程文件获得（2026-09-16 半离线实测放置可用）。
 */
export function pageSupportOf(libraryKind: string): boolean {
	return libraryKind === 'personal' || libraryKind === 'team' || libraryKind === 'local';
}

export const CATALOG_FORMAT_VERSION = '0.2';
export const CATALOG_GENERATOR = 'ai-reuse-block-placement';

export type LibraryKind = 'personal' | 'team' | 'local';
export type LibraryScope = Record<LibraryKind, boolean>;

export interface CatalogModuleBoard {	itemType: string;	name: string;
	/** 模块自带原理图页 uuid（整页放置用）。 */
	schematic?: string;
	/** 模块自带 PCB uuid。 */
	pcb?: string;
	/** 模块源工程 uuid（云端溯源）。 */
	parentProjectUuid?: string; }

export interface CatalogModule {
	uuid: string;
	name: string;
	description: string;
	classification?: Array<string>;
	updateTimestamp?: number;
	ascription?: string;
	/** 模块工程结构（lib_Cbb.get().boards 裁剪）：图页放置用的 schematic uuid。 */
	boards?: Array<CatalogModuleBoard>;
	/** 内容存储位置：cloud=云端库；local=本地库。 */
	storage: 'cloud' | 'local';
}

export interface CatalogLibrary {
	libraryUuid: string;
	libraryKind: LibraryKind;
	moduleName: string;
	failed: boolean;
	error: string | null;
	modules: Array<CatalogModule>;
}

/** 目录统计视图（对话卡片与 JSON 导出共用）。 */
export interface CatalogStatsView {
	libraries: number;
	modules: number;
	emptyDesc: number;
	failed: number;
	elapsedMs: number;
}

export interface CatalogJson {
	formatVersion: string;
	generator: string;
	exportedAt: string;
	source: { app: 'easyeda-pro'; appVersion: string };
	libraries: Array<CatalogLibrary>;
}

export interface CatalogFetchReport {
	catalog: CatalogJson;
	totalModules: number;
	failedLibraries: number;
	elapsedMs: number;
}

const PAGE_SIZE = 50;
const MAX_PAGES = 200;

const KIND_ORDER: Array<LibraryKind> = ['personal', 'team', 'local'];

/** 显示名只用宿主给出的 name；没有 name 时用 uuid（本地库的 uuid 就是路径）。 */
function hostLibraryLabel(name: string | undefined, uuid: string): string {
	const label = String(name || '').trim();
	return label || uuid;
}

interface ResolvedLibrary {
	kind: LibraryKind;
	label: string;
	uuid: string | null;
}

type ClientModeHint = 'online' | 'half-offline' | 'offline' | 'unknown';

function readAppVersion(): string {
	try {
		const env = edaGlobal()?.sys_Environment as { getEditorCurrentVersion?: (onlySemantic?: boolean) => string } | undefined;
		const v = typeof env?.getEditorCurrentVersion === 'function' ? env.getEditorCurrentVersion(true) : '';
		return typeof v === 'string' ? v : '';
	}
	catch { return ''; }
}

function assembleCatalog(libraries: Array<CatalogLibrary>): CatalogJson {
	return {
		formatVersion: CATALOG_FORMAT_VERSION,
		generator: CATALOG_GENERATOR,
		exportedAt: new Date().toISOString(),
		source: { app: 'easyeda-pro', appVersion: readAppVersion() },
		libraries,
	};
}

/**
 * 库枚举（三源）。clientMode 用于 getAllLibrariesList 双语义消歧：
 * 在线版返回团队库列表，桌面离线版返回本地库路径（2026-09-11 实测）。
 * 本地库路径三级回退：getAllLibrariesList（离线）→ getLibrariesPaths（仅全离线）→ 设置路径（半离线）。
 */
async function resolveLibraries(scope: Partial<LibraryScope>, clientMode: ClientModeHint): Promise<Array<ResolvedLibrary>> {
	const libsList = edaGlobal()?.lib_LibrariesList as Record<string, unknown> | undefined;
	const out: Array<ResolvedLibrary> = [];
	const seenUuids = new Set<string>();
	for (const kind of KIND_ORDER) {
		if (!scope[kind])
			continue;
		if (kind === 'team') {
			// 团队库：离线模式下不可达（推断，未实测）；getAllLibrariesList 在离线返回本地路径，不能当团队库用
			if (clientMode === 'half-offline' || clientMode === 'offline')
				continue;
			try {
				const getAll = libsList?.getAllLibrariesList as (() => Promise<Array<{ name?: string; uuid?: string }>>) | undefined;
				const all = typeof getAll === 'function' ? await getAll.call(libsList) : undefined;
				for (const entry of Array.isArray(all) ? all : []) {
					if (typeof entry?.uuid === 'string' && entry.uuid && !seenUuids.has(entry.uuid)) {
						seenUuids.add(entry.uuid);
						out.push({ kind: 'team', label: hostLibraryLabel(entry.name, entry.uuid), uuid: entry.uuid });
					}
				}
			}
			catch { /* 失败隔离：团队库拉不到不阻塞其余库 */ }
			continue;
		}
		if (kind === 'local') {
			const candidates: Array<{ label: string; uuid: string }> = [];
			// 在线版 getAllLibrariesList 返回的是团队库，不能当本地路径用
			if (clientMode !== 'online') {
				try {
					const getAll = libsList?.getAllLibrariesList as (() => Promise<Array<{ name?: string; uuid?: string }>>) | undefined;
					const all = typeof getAll === 'function' ? await getAll.call(libsList) : undefined;
					for (const entry of Array.isArray(all) ? all : []) {
						if (typeof entry?.uuid === 'string' && entry.uuid)
							candidates.push({ label: hostLibraryLabel(entry.name, entry.uuid), uuid: entry.uuid });
					}
				}
				catch { /* 走下一级 */ }
			}
			if (!candidates.length) {
				try {
					const getPaths = edaGlobal()?.sys_FileSystem as
						| { getLibrariesPaths?: () => Promise<Array<string>> }
						| undefined;
					const paths = typeof getPaths?.getLibrariesPaths === 'function' ? await getPaths.getLibrariesPaths() : [];
					for (const p of Array.isArray(paths) ? paths : []) {
						if (typeof p === 'string' && p)
							candidates.push({ label: p, uuid: p });
					}
				}
				catch { /* 仅全离线可用 */ }
			}
			if (!candidates.length) {
				const fallback = getLocalLibraryPath();
				if (fallback)
					candidates.push({ label: fallback, uuid: fallback });
			}
			for (const cand of candidates) {
				if (seenUuids.has(cand.uuid))
					continue;
				seenUuids.add(cand.uuid);
				out.push({ kind: 'local', label: cand.label, uuid: cand.uuid });
			}
			continue;
		}
		let uuid: string | null = null;
		try {
			const getter = libsList?.getPersonalLibraryUuid as (() => Promise<string | null>) | undefined;
			const got = typeof getter === 'function' ? await getter.call(libsList) : null;
			if (typeof got === 'string' && got)
				uuid = got;
		}
		catch { uuid = null; }
		if (uuid)
			seenUuids.add(uuid);
		out.push({ kind, label: uuid || '', uuid });
	}
	return out;
}

/** 可写入的云库（创建模块的目标库候选）。本地库是磁盘路径、lib_Cbb.create 不适用，故排除。 */
export interface WritableLibrary {
	kind: 'personal' | 'team';
	label: string;
	uuid: string;
}

/**
 * 列出可作为「创建模块」目标的可写云库：个人库 + 团队库，个人库优先。
 *
 * 不复用目录缓存（loadCatalogRecord）——目录可能为空或过期，而创建模块不应依赖先拉目录。
 * 半离线/全离线模式下个人库与团队库都不可达，此处自然返回空数组，由调用方给出明确提示。
 */
export async function listWritableLibraries(): Promise<Array<WritableLibrary>> {
	let mode: ClientModeHint = 'unknown';
	try {
		const { detectClientEnv } = await import('./env');
		mode = (await detectClientEnv()).mode;
	}
	catch { /* 模式未知时按在线处理，靠失败隔离兜底 */ }
	let resolved: Array<ResolvedLibrary> = [];
	try {
		resolved = await resolveLibraries({ personal: true, team: true, local: false }, mode);
	}
	catch {
		return [];
	}
	const order: Record<string, number> = { personal: 0, team: 1 };
	return resolved
		.filter((l): l is ResolvedLibrary & { kind: 'personal' | 'team'; uuid: string } =>
			(l.kind === 'personal' || l.kind === 'team') && typeof l.uuid === 'string' && !!l.uuid)
		.map(l => ({ kind: l.kind, label: friendlyLibraryLabel(l.kind, l.label), uuid: l.uuid }))
		.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
}

/** 宿主不给个人库名字时 label 会退化成 32 位 uuid，卡片上要显示成人话。 */
function friendlyLibraryLabel(kind: 'personal' | 'team', label: string): string {
	const text = String(label || '').trim();
	if (text && !/^[0-9a-f]{32}$/i.test(text))
		return text;
	return kind === 'personal' ? '个人库' : '团队库';
}

/** 单库分页拉全量。page 为 1 起（page 0 恒空）。uuid 去重 + 空页/无新增即停。 */
async function fetchLibraryModules(uuid: string): Promise<Array<CatalogModule>> {
	const cbb = edaGlobal()?.lib_Cbb as Record<string, unknown> | undefined;
	const search = cbb?.search as
		| ((key: string, libraryUuid?: string, classification?: unknown, itemsOfPage?: number, page?: number) => Promise<Array<Record<string, unknown>>>)
		| undefined;
	if (typeof search !== 'function')
		throw new Error('lib_Cbb.search 不可用（宿主版本过低或当前环境不支持）');

	const modules: Array<CatalogModule> = [];
	const seen = new Set<string>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const rows = (await search.call(cbb, '', uuid, undefined, PAGE_SIZE, page)) || [];
		let added = 0;
		for (const row of rows) {
			const mUuid = String(row.uuid ?? '');
			if (!mUuid || seen.has(mUuid))
				continue;
			seen.add(mUuid);
			added++;
			modules.push({
				uuid: mUuid,
				name: String(row.name ?? ''),
				description: String(row.description ?? ''),
				// storage 在 fetchCatalog 中按库类型正确标记；此处先给占位默认
				storage: 'cloud',
				// search 行的 classification 实测恒为空数组（V4.1.71），真值由 fetchModuleDetail 的
				// get 回填；这里保留读取是为了宿主将来若开始返回时不丢数据。
				classification: Array.isArray(row.classification) ? row.classification.map(String) : undefined,
				updateTimestamp: typeof row.updateTimestamp === 'number' ? row.updateTimestamp : undefined,
				ascription: typeof row.ascription === 'string' ? row.ascription : undefined,
			});
		}
		if (rows.length === 0 || added === 0)
			break;
	}
	return modules;
}

/** get() 单次取回的模块详情：工程结构 + 分类。 */
interface ModuleDetail {
	boards: Array<CatalogModuleBoard>;
	classification: Array<string>;
}

/**
 * 读模块详情（boards 含 schematic/pcb/parentProjectUuid + classification），失败返回 null 不阻塞。
 *
 * 分类必须从这里取、不能从 search 取（2026-10-14 V4.1.71 实测）：`search` 返回的每一行
 * classification 恒为 `[]`（官方库 40 个模块、个人库、团队库全部为空，连名字与次分类同名的
 * 模块也是空），而 `get` 返回真实分类路径数组，如 `["树莓派系列最小系统","树莓派紧凑型号"]`。
 * 目录拉取本就为拿图页 uuid 逐模块调 get，接上分类不增加任何请求。
 */
async function fetchModuleDetail(cbbUuid: string, libraryUuid: string): Promise<ModuleDetail | null> {
	const cbb = edaGlobal()?.lib_Cbb as Record<string, unknown> | undefined;
	const get = cbb?.get as ((cbbUuid: string, libraryUuid?: string) => Promise<Record<string, unknown> | undefined>) | undefined;
	if (typeof get !== 'function')
		return null;
	try {
		// 15s 超时与放置路径（cbb.getCbbPageUuid）同口径：本地模块 get() 已知崩溃/挂起，
		// 目录拉取逐模块调它，不能只靠 catch——挂起会卡住整轮 fetchCatalog。
		const detail = await withTimeout(get.call(cbb, cbbUuid, libraryUuid), 15000, '获取模块详情超时');
		if (!detail || typeof detail !== 'object')
			return null;
		const rawBoards = Array.isArray(detail.boards) ? detail.boards as Array<Record<string, unknown>> : [];
		return {
			boards: rawBoards.map(b => ({
				itemType: String(b.itemType ?? 'Board'),
				name: String(b.name ?? ''),
				schematic: typeof b.schematic === 'string' && b.schematic ? b.schematic : undefined,
				pcb: typeof b.pcb === 'string' && b.pcb ? b.pcb : undefined,
				parentProjectUuid: typeof b.parentProjectUuid === 'string' && b.parentProjectUuid ? b.parentProjectUuid : undefined,
			})),
			classification: Array.isArray(detail.classification)
				? detail.classification.map(String).map(s => s.trim()).filter(Boolean)
				: [],
		};
	}
	catch {
		// 本地库 get() 已知崩溃（SPEC §7.3）；工程库副本拒绝——静默降级为无 boards/无分类
		return null;
	}
}

/**
 * 按模块名从 .eprj2 行列表定位工程文件：精确匹配文件名主干，其次前缀匹配（防同名变体带后缀）。
 * 「文件名主干 = 模块名」对原生与导入模块均成立。本地库图页放置解析 schematic uuid 时使用。
 */
export function matchLocalEprjRow<T extends { name?: string; fullPath?: string }>(rows: Array<T>, moduleName: string): T | null {
	const stem = moduleName.replace(/[\\/:*?"<>|]/g, '_').trim();
	if (!stem)
		return null;
	const stemOf = (n: string | undefined): string => String(n || '').replace(/\.eprj2$/i, '').trim();
	return rows.find(r => stemOf(r.name) === stem) || rows.find(r => stemOf(r.name).startsWith(stem)) || null;
}

export async function fetchCatalog(scope: Partial<LibraryScope>): Promise<CatalogFetchReport> {
	const startedAt = Date.now();
	let clientMode: ClientModeHint = 'unknown';
	try {
		const { detectClientEnv } = await import('./env');
		clientMode = (await detectClientEnv()).mode;
	}
	catch { /* 模式未知时按双源都试，靠失败隔离兜底 */ }
	const resolved = await resolveLibraries(scope, clientMode);
	const libraries: Array<CatalogLibrary> = [];

	for (const lib of resolved) {
		if (!lib.uuid) {
			libraries.push({
				libraryUuid: '',
				libraryKind: lib.kind,
				moduleName: lib.label,
				failed: true,
				error: '库不可用（未获取到 UUID，可能未登录或为私有化部署限制）',
				modules: [],
			});
			continue;
		}
		try {
			const modules = await fetchLibraryModules(lib.uuid);
			// 每模块一次 lib_Cbb.get（数百 ms）：取图页放置用的 schematic uuid，并顺带接上分类
			// （分类真值只在 get 里，search 恒返回空——见 fetchModuleDetail 注释）。
			for (const m of modules) {
				const detail = await fetchModuleDetail(m.uuid, lib.uuid);
				if (detail) {
					if (detail.boards.length)
						m.boards = detail.boards;
					if (detail.classification.length)
						m.classification = detail.classification;
				}
				m.storage = lib.kind === 'local' ? 'local' : 'cloud';
			}
			libraries.push({
				libraryUuid: lib.uuid,
				libraryKind: lib.kind,
				moduleName: lib.label,
				failed: false,
				error: null,
				modules,
			});
		}
		catch (e) {
			libraries.push({
				libraryUuid: lib.uuid,
				libraryKind: lib.kind,
				moduleName: lib.label,
				failed: true,
				error: e instanceof Error ? e.message : String(e),
				modules: [],
			});
		}
	}

	const catalog = assembleCatalog(libraries);
	const totalModules = libraries.reduce((sum, lib) => sum + lib.modules.length, 0);
	const failedLibraries = libraries.filter(lib => lib.failed).length;
	return { catalog, totalModules, failedLibraries, elapsedMs: Date.now() - startedAt };
}

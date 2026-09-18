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
export const CATALOG_GENERATOR = 'jlc-cbb-copilot';

export type LibraryKind = 'personal' | 'team' | 'local';
export type LibraryScope = Record<LibraryKind, boolean>;

export interface CatalogModuleBoard {	itemType: string;	name: string;
	/** 模块自带原理图页 uuid（整页放置用）。 */
	schematic?: string;
	/** 模块自带 PCB uuid。 */
	pcb?: string;
	/** 模块源工程 uuid（云端溯源；本地模块可经索引器映射到磁盘路径）。 */
	parentProjectUuid?: string; }

export interface CatalogModule {
	uuid: string;
	name: string;
	description: string;
	classification?: Array<string>;
	updateTimestamp?: number;
	ascription?: string;
	/** 模块工程结构（lib_Cbb.get().boards 裁剪）：与实际工程的 uuid 级对应。 */
	boards?: Array<CatalogModuleBoard>;
	/** 内容存储位置：cloud=云端工程（本机仅备份）；local=本地磁盘工程文件。 */
	storage: 'cloud' | 'local';
	/** 本地模块的磁盘工程文件路径（.eprj2）；仅 storage=local 时可能有。 */
	localFilePath?: string;
	/** localFilePath 的来源说明：indexed=索引器实测解析；search=库路径直接对应。 */
	filePathSource?: 'indexed' | 'search';
	/** 云端模块在本机的每日备份文件夹（online-projects-backup 下、以模块名精确匹配）；仅本机编辑过该工程才有。 */
	localBackupDir?: string;
}

export interface CatalogLibrary {
	libraryUuid: string;
	libraryKind: LibraryKind;
	moduleName: string;
	failed: boolean;
	error: string | null;
	modules: Array<CatalogModule>;
}

/** 目录统计视图（对话卡片 / 工程包导出共用）。 */
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
const KIND_LABELS: Record<LibraryKind, string> = {
	personal: '个人库',
	team: '团队库',
	local: '本地库',
};

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
						out.push({ kind: 'team', label: entry.name || '团队库', uuid: entry.uuid });
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
							candidates.push({ label: entry.name || '本地库', uuid: entry.uuid });
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
							candidates.push({ label: '本地库', uuid: p });
					}
				}
				catch { /* 仅全离线可用 */ }
			}
			if (!candidates.length) {
				const fallback = getLocalLibraryPath();
				if (fallback)
					candidates.push({ label: '本地库', uuid: fallback });
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
		out.push({ kind, label: KIND_LABELS[kind], uuid });
	}
	return out;
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
				// storage 在 fetchCatalog 中按库类型���确标记；此处先给占位默认
				storage: 'cloud',
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

/** 读模块工程结构（boards 含 schematic/pcb/parentProjectUuid），失败返回 null 不阻塞。 */
async function fetchModuleBoards(cbbUuid: string, libraryUuid: string): Promise<Array<CatalogModuleBoard> | null> {
	const cbb = edaGlobal()?.lib_Cbb as Record<string, unknown> | undefined;
	const get = cbb?.get as ((cbbUuid: string, libraryUuid?: string) => Promise<Record<string, unknown> | undefined>) | undefined;
	if (typeof get !== 'function')
		return null;
	try {
		// 15s 超时与放置路径（cbb.getCbbPageUuid）同口径：本地模块 get() 已知崩溃/挂起，
		// 目录拉取逐模块调它，不能只靠 catch——挂起会卡住整轮 fetchCatalog。
		const detail = await withTimeout(get.call(cbb, cbbUuid, libraryUuid), 15000, '获取模块详情超时');
		const boards = Array.isArray(detail?.boards) ? detail.boards as Array<Record<string, unknown>> : [];
		if (!boards.length)
			return null;
		return boards.map(b => ({
			itemType: String(b.itemType ?? 'Board'),
			name: String(b.name ?? ''),
			schematic: typeof b.schematic === 'string' && b.schematic ? b.schematic : undefined,
			pcb: typeof b.pcb === 'string' && b.pcb ? b.pcb : undefined,
			parentProjectUuid: typeof b.parentProjectUuid === 'string' && b.parentProjectUuid ? b.parentProjectUuid : undefined,
		}));
	}
	catch {
		// 本地库 get() 已知崩溃（SPEC §7.3）；工程库副本拒绝——静默降级为无 boards
		return null;
	}
}

/**
 * 列出本地库目录下全部 .eprj2 工程文件（文件名主干 = 模块名，实测原生与导入模块均成立；
 * 导入模块的 uuid 是客户端重新分配的，与文件内容中的源 uuid 不同，uuid 索引对它必然失效）。
 */
export async function listLocalEprjFiles(dirs: Array<string>): Promise<Array<{ name: string; fullPath: string }>> {
	const fs = edaGlobal()?.sys_FileSystem as
		| { listFilesOfFileSystem?: (path: string) => Promise<Array<{ name?: string; isDirectory?: boolean; fullPath?: string }>> }
		| undefined;
	const out: Array<{ name: string; fullPath: string }> = [];
	if (typeof fs?.listFilesOfFileSystem !== 'function')
		return out;
	const seen = new Set<string>();
	for (const dir of dirs) {
		if (!dir)
			continue;
		let entries: Array<{ name?: string; isDirectory?: boolean; fullPath?: string }> = [];
		try {
			entries = (await fs.listFilesOfFileSystem(dir)) || [];
		}
		catch { /* 目录不可达跳过 */ }
		for (const entry of entries) {
			if (!entry || entry.isDirectory || !/\.eprj2$/i.test(String(entry.name || '')))
				continue;
			const name = String(entry.name);
			const fullPath = typeof entry.fullPath === 'string' ? entry.fullPath : `${dir.replace(/\/+$/, '')}/${entry.name}`;
			const key = fullPath.toLowerCase();
			if (!name.trim() || seen.has(key))
				continue;
			seen.add(key);
			out.push({ name, fullPath });
		}
	}
	return out;
}

/**
 * 按模块名从 .eprj2 行列表定位工程文件：精确匹配文件名主干，其次前缀匹配（防同名变体带后缀）。
 * 「文件名主干 = 模块名」对原生与导入模块均成立，目录拉取 / 工程包导出 / 本地摘要读取三处共用这一个实现。
 */
export function matchLocalEprjRow<T extends { name?: string; fullPath?: string }>(rows: Array<T>, moduleName: string): T | null {
	const stem = moduleName.replace(/[\\/:*?"<>|]/g, '_').trim();
	if (!stem)
		return null;
	const stemOf = (n: string | undefined): string => String(n || '').replace(/\.eprj2$/i, '').trim();
	return rows.find(r => stemOf(r.name) === stem) || rows.find(r => stemOf(r.name).startsWith(stem)) || null;
}

/**
 * 云端工程备份索引：扫描配置目录的兄弟目录 online-projects-backup（EasyEDA Pro 约定位置），
 * 其子文件夹名 = 工程 friendlyName（实测 project2.json 的 title 与文件夹名一致）。
 * 云端 CBB 模块的模块名恰为工程 friendlyName，故模块名精确匹配即可定位本机备份文件夹。
 * 只建索引不改文件；目录不可达返回空映射（云端模块无 localBackupDir，正常降级）。
 */
export async function buildCloudBackupIndex(dirs: Array<string>): Promise<Map<string, string>> {
	const fs = edaGlobal()?.sys_FileSystem as
		| { listFilesOfFileSystem?: (path: string) => Promise<Array<{ name?: string; isDirectory?: boolean; fullPath?: string }>> }
		| undefined;
	const map = new Map<string, string>();
	if (typeof fs?.listFilesOfFileSystem !== 'function')
		return map;
	const seenRoots = new Set<string>();
	for (const dir of dirs) {
		// 在线版 getDocumentsPath 返回空、getProjectsPaths 抛错（实测），用配置目录推导兄弟备份目录
		const parent = dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');
		const backupRoot = parent ? `${parent}/online-projects-backup` : '';
		if (!backupRoot || seenRoots.has(backupRoot))
			continue;
		seenRoots.add(backupRoot);
		try {
			const folders = (await fs.listFilesOfFileSystem(backupRoot)) || [];
			for (const folder of folders) {
				if (!folder?.isDirectory || typeof folder.name !== 'string' || !folder.name)
					continue;
				if (!map.has(folder.name))
					map.set(folder.name, folder.fullPath || `${backupRoot}/${folder.name}`);
			}
		}
		catch { /* 备份目录不存在/不可达跳过 */ }
	}
	return map;
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
	// 本地模块工程文件只可能在其所属库目录（resolveLibraries 的 local 候选）；
	// 按文件名定位（文件名主干 = 模块名）——导入模块的 uuid 是重新分配的，uuid 索引对它必然失效。
	// 云端备份索引仍按设置页工程目录推导兄弟目录 online-projects-backup。
	const { getProjectDirs, parseProjectDirs } = await import('./settings');
	const localLibDirs = [...new Set(resolved.filter(l => l.kind === 'local' && l.uuid).map(l => l.uuid as string))];
	const localEprjFiles = await listLocalEprjFiles(localLibDirs);
	const cloudBackupIndex = await buildCloudBackupIndex(parseProjectDirs(getProjectDirs()));
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
			// 工程对应增强：boards 每模块一次 lib_Cbb.get（数百 ms）；本地模块优先用索引器实测路径。
			// 云端模块的 parentProjectUuid 只是云端工程 uuid，不对应磁盘文件。
			for (const m of modules) {
				const boards = await fetchModuleBoards(m.uuid, lib.uuid);
				if (boards)
					m.boards = boards;
				if (lib.kind === 'local') {
					m.storage = 'local';
					// 文件定位：文件名主干 = 模块名（实测原生与导入模块均成立；导入模块 uuid 已被重新分配，uuid 索引对它必然失效）
					const hit = matchLocalEprjRow(localEprjFiles, m.name);
					if (hit) {
						m.localFilePath = hit.fullPath;
						m.filePathSource = 'indexed';
					}
					else {
						m.localFilePath = lib.uuid;
						m.filePathSource = 'search';
					}
				}
				else {
					// 云端模块：模块名 = 工程 friendlyName（实测），精确匹配本机备份文件夹名
					m.storage = 'cloud';
					const backup = cloudBackupIndex.get(m.name);
					if (backup)
						m.localBackupDir = backup;
				}
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

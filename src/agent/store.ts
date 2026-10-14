/**
 * 目录持久化存储（插件级，跨会话/跨重启）。
 * 单持久层：sys_Storage 是 EasyEDA 官方扩展存储，主进程与 iframe 通用，
 * 桌面端与网页版均已实测跨重启持久化（2026-09-18 网页版真机验证）。
 * 无第二后端、无静默降级：写路径 await 官方 Promise<boolean>，失败向上抛，
 * 由 refresh_catalog 的工具错误通道把「目录已拉取但落盘失败，仅本次会话可用」
 * 显式上报给模型与用户；删除路径尽力而为（残留记录会在下次落盘时被整体覆盖，仅记日志）。
 * 内存层是会话内缓存（agent 每轮注入目录摘要都要读），不是兜底：落盘失败时保证本会话仍可用。
 *
 * 目录检索：search_modules 关键词评分 + get_module 单模块详情，替代整包注入 LLM。
 */
import type { CatalogFetchReport, CatalogJson, CatalogLibrary, CatalogModule, CatalogStatsView } from '../catalog';
import { CATALOG_FORMAT_VERSION, CATALOG_GENERATOR, fetchCatalog, pageSupportOf } from '../catalog';
import { effectiveLibraryScope } from '../env';
import { edaGlobal } from '../host';
import { getHiddenLibraryKeys, libraryVisibilityKey } from '../settings';

/** 存储记录键：v1。结构不兼容时靠 formatVersion 判废重建。 */
const STORE_KEY = 'catalog_store.v1';

/** 与 catalog.ts 的 CATALOG_FORMAT_VERSION 对齐的兼容口径；不匹配即视为过期数据。 */
const COMPAT_FORMAT_VERSION = '0.2';

/** 目录数据最长信任期（毫秒）：超过只影响提示文案，不自动失效。 */
const STALE_HINT_MS = 6 * 60 * 60 * 1000;

export interface CatalogStoreRecord {
	formatVersion: string;
	/** 拉取完成时刻（epoch ms），新鲜度提示用。 */
	fetchedAt: number;
	catalog: CatalogJson;
	stats: CatalogStatsView;
}

/** 扁平模块视图：目录遍历与 uuid 反查的统一形态（含所属库信息）。 */
export type FlatModule = CatalogModule & {
	libraryUuid: string;
	libraryKind: string;
	src: string;
	pageSupport: boolean;
};

// ── 内存缓存（会话内；非持久层） ─────────────────────────────────────

let memoryRecord: CatalogStoreRecord | null = null;

// ── 持久层：sys_Storage（唯一持久化后端） ────────────────────────────

interface SysStorageApi {
	/** 官方签名：同步返回任意值，key 不存在返回 undefined（非 Promise）。 */
	getExtensionUserConfig?: (k: string) => unknown;
	/** 官方签名：Promise<boolean>，成败需 await 后才知道。 */
	setExtensionUserConfig?: (k: string, v: string) => Promise<boolean>;
	/** 官方签名：Promise<boolean>，成败需 await 后才知道。 */
	deleteExtensionUserConfig?: (k: string) => Promise<boolean>;
}

function sysStorage(): SysStorageApi | undefined {
	try {
		return (edaGlobal()?.sys_Storage ?? undefined) as SysStorageApi | undefined;
	}
	catch {
		return undefined;
	}
}

/** 同步读：API 缺失/抛错/非字符串返回一律视为缺失，交由上层走空缓存流程。 */
function sysGet(key: string): string {
	const api = sysStorage();
	if (typeof api?.getExtensionUserConfig !== 'function')
		return '';
	try {
		const v = api.getExtensionUserConfig(key);
		return typeof v === 'string' ? v : '';
	}
	catch {
		return '';
	}
}

/**
 * 异步写：同步抛错、Promise 拒绝、返回 false 都视为失败并抛出。
 * 调用方（saveCatalogRecord）负责补充业务上下文后继续上抛。
 */
async function sysSet(key: string, val: string): Promise<void> {
	const api = sysStorage();
	if (typeof api?.setExtensionUserConfig !== 'function')
		throw new Error('宿主未注入 sys_Storage.setExtensionUserConfig');
	const ok = await api.setExtensionUserConfig(key, val);
	if (ok === false)
		throw new Error(`sys_Storage 写入返回失败（key=${key}，可能超出存储限额）`);
}

/** 异步删：失败抛出，由 clearCatalogRecord 决定降级策略（尽力而为 + 日志）。 */
async function sysDelete(key: string): Promise<void> {
	const api = sysStorage();
	if (typeof api?.deleteExtensionUserConfig !== 'function')
		throw new Error('宿主未注入 sys_Storage.deleteExtensionUserConfig');
	const ok = await api.deleteExtensionUserConfig(key);
	if (ok === false)
		throw new Error(`sys_Storage 删除返回失败（key=${key}）`);
}

// ── 记录读写：内存缓存 → sys_Storage；写失败显式上抛，不做静默降级 ──

function parseRecord(raw: string): CatalogStoreRecord | null {
	if (!raw)
		return null;
	try {
		const rec = JSON.parse(raw) as CatalogStoreRecord;
		if (rec && rec.formatVersion === COMPAT_FORMAT_VERSION && rec.catalog && Array.isArray(rec.catalog.libraries) && rec.stats)
			return rec;
	}
	catch { /* 损坏记录视为缺失 */ }
	return null;
}

/** 读目录记录：内存缓存 → sys_Storage。全部未命中返回 null。 */
export async function loadCatalogRecord(): Promise<CatalogStoreRecord | null> {
	if (memoryRecord)
		return memoryRecord;
	const hit = parseRecord(sysGet(STORE_KEY));
	if (!hit)
		return null;
	memoryRecord = hit;
	return hit;
}

/** 模型可见目录：按设置隐藏指定库。存储里的全量目录不变，取消勾选可恢复。 */
export async function loadModelCatalogRecord(): Promise<CatalogStoreRecord | null> {
	const rec = await loadCatalogRecord();
	if (!rec)
		return null;
	const hidden = new Set(getHiddenLibraryKeys());
	if (!hidden.size)
		return rec;
	const libraries = rec.catalog.libraries.filter(lib => !hidden.has(libraryVisibilityKey(lib)));
	let emptyDesc = 0;
	let modules = 0;
	for (const lib of libraries) {
		modules += lib.modules.length;
		for (const m of lib.modules) {
			if (!String(m.description || '').trim())
				emptyDesc++;
		}
	}
	return {
		...rec,
		catalog: { ...rec.catalog, libraries },
		stats: {
			...rec.stats,
			libraries: libraries.length,
			modules,
			emptyDesc,
			failed: libraries.filter(lib => lib.failed).length,
		},
	};
}

export interface CatalogLibraryAdmin {
	key: string;
	kind: string;
	name: string;
	modules: number;
	failed: boolean;
	visible: boolean;
}

/** 设置页用的全量目录：每个库的类型、名称、模块数，以及是否对模型可见。 */
export async function describeCatalogLibraries(): Promise<{ empty: boolean; fetchedAt: number; moduleCount: number; libraries: Array<CatalogLibraryAdmin> }> {
	const rec = await loadCatalogRecord();
	if (!rec)
		return { empty: true, fetchedAt: 0, moduleCount: 0, libraries: [] };
	const hidden = new Set(getHiddenLibraryKeys());
	return {
		empty: false,
		fetchedAt: rec.fetchedAt,
		moduleCount: rec.stats.modules,
		libraries: rec.catalog.libraries.map(lib => ({
			key: libraryVisibilityKey(lib),
			kind: lib.libraryKind,
			name: lib.moduleName,
			modules: lib.modules.length,
			failed: lib.failed,
			visible: !hidden.has(libraryVisibilityKey(lib)),
		})),
	};
}

/**
 * 写目录记录：内存必写（保证落盘失败时本会话仍可用）；落盘失败带上业务上下文上抛。
 * 抛出的错误经 refresh_catalog 工具错误通道反馈给模型与用户。
 */
export async function saveCatalogRecord(rec: CatalogStoreRecord): Promise<void> {
	memoryRecord = rec;
	try {
		await sysSet(STORE_KEY, JSON.stringify(rec));
	}
	catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		throw new Error(`目录已拉取但落盘失败：仅本次会话可用，重启后需重新 refresh_catalog。原因：${why}`);
	}
}

/** 清目录记录：内存必清；磁盘残留尽力而为（下次 refresh_catalog 落盘会整体覆盖），仅记日志。 */
export async function clearCatalogRecord(): Promise<void> {
	memoryRecord = null;
	try {
		await sysDelete(STORE_KEY);
	}
	catch (e) {
		console.warn('[cbb-copilot] 目录缓存删除失败（下次 refresh_catalog 落盘会覆盖）:', e);
	}
}

// ── 目录写入与查询 ───────────────────────────────────────────────────

export function catalogStatsOf(report: CatalogFetchReport): CatalogStatsView {
	let emptyDesc = 0;
	for (const lib of report.catalog.libraries) {
		for (const m of lib.modules) {
			if (!String(m.description || '').trim())
				emptyDesc++;
		}
	}
	return {
		libraries: report.catalog.libraries.length,
		modules: report.totalModules,
		emptyDesc,
		failed: report.failedLibraries,
		elapsedMs: report.elapsedMs,
	};
}

/**
 * 手动重拉与 refresh_catalog 共用同一次进行中的拉取。
 * 后到的一方等待这一次结束，不再并行打宿主接口。
 */
let refreshInflight: Promise<CatalogStatsView> | null = null;

export function refreshCatalogExclusive(): Promise<CatalogStatsView> {
	if (refreshInflight)
		return refreshInflight;
	const job = (async () => {
		const report = await fetchCatalog(await effectiveLibraryScope());
		return storeCatalog(report);
	})();
	refreshInflight = job;
	void job.finally(() => {
		if (refreshInflight === job)
			refreshInflight = null;
	});
	return job;
}

/** 拉取结果落盘：构建记录并写入存储（落盘失败会抛出，见 saveCatalogRecord）。 */
export async function storeCatalog(report: CatalogFetchReport): Promise<CatalogStatsView> {
	const stats = catalogStatsOf(report);
	await saveCatalogRecord({
		formatVersion: COMPAT_FORMAT_VERSION,
		fetchedAt: Date.now(),
		catalog: report.catalog,
		stats,
	});
	return stats;
}

/** 设置页导出：只含当前勾选的库。格式与对话里另存的 CatalogJson 相同。 */
export async function exportCatalog(libraryKeys: Array<string>): Promise<{ cancelled?: boolean; fileName: string; modules: number; libraries: number }> {
	const keys = new Set((libraryKeys || []).filter(k => typeof k === 'string' && k));
	if (!keys.size)
		throw new Error('请先勾选要导出的库');
	const rec = await loadCatalogRecord();
	if (!rec || !rec.catalog.libraries.length)
		throw new Error('目录还是空的，请先重新拉取');
	const saveFile = (edaGlobal()?.sys_FileSystem as { saveFile?: (fileData: Blob, fileName?: string) => Promise<void> } | undefined)?.saveFile;
	if (typeof saveFile !== 'function')
		throw new Error('sys_FileSystem.saveFile 不可用，无法另存 JSON');
	const catalog = JSON.parse(JSON.stringify(rec.catalog)) as CatalogJson;
	catalog.libraries = catalog.libraries.filter(lib => keys.has(libraryVisibilityKey(lib)));
	if (!catalog.libraries.length)
		throw new Error('勾选的库不在当前目录里，请先重新拉取');
	let modules = 0;
	for (const lib of catalog.libraries)
		modules += lib.modules.length;
	catalog.exportedAt = new Date().toISOString();
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const fileName = `cbb-catalog-${stamp}.json`;
	const blob = new Blob([JSON.stringify(catalog, null, '\t')], { type: 'application/json' });
	try {
		await saveFile(blob, fileName);
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/取消|cancel/i.test(msg))
			return { cancelled: true, fileName, modules, libraries: catalog.libraries.length };
		throw new Error(`保存 JSON 失败：${msg}`);
	}
	return { fileName, modules, libraries: catalog.libraries.length };
}

// ── 目录 JSON 导入：与当前目录对照后按策略合并 ─────────────────────

export interface CatalogImportPolicy {
	/** 同一库、同一 uuid，但名称/描述/分类/图页等不一致。 */
	onConflict: 'keep' | 'import' | 'newer';
	/** 文件里有、当前目录没有的模块。 */
	onAdded: 'add' | 'skip';
	/** 同一库里当前有、文件里没有的模块。文件完全没提到的库不在此列，始终保留。 */
	onMissing: 'keep' | 'drop';
}

export interface CatalogImportItem {
	name: string;
	library: string;
	uuid: string;
	/** 冲突时不一致的字段。 */
	fields?: Array<string>;
}

export interface CatalogImportPreview {
	identical: number;
	conflicts: number;
	added: number;
	missing: number;
	fileDuplicates: number;
	invalid: number;
	skippedFailedLibraries: number;
	untouchedLibraries: number;
	samples: {
		conflicts: Array<CatalogImportItem>;
		added: Array<CatalogImportItem>;
		missing: Array<CatalogImportItem>;
	};
}

export interface CatalogImportApplied {
	keptIdentical: number;
	conflictsKept: number;
	conflictsImported: number;
	added: number;
	missingKept: number;
	missingDropped: number;
	modules: number;
	libraries: number;
}

const IMPORT_SAMPLE = 12;
const LIBRARY_KINDS = new Set(['personal', 'team', 'local']);

interface IndexedLib {
	key: string;
	lib: CatalogLibrary;
	modules: Map<string, CatalogModule>;
	duplicateUuids: number;
	invalid: number;
}

function emptyImportedCatalog(source: CatalogJson['source'] | undefined): CatalogJson {
	return {
		formatVersion: CATALOG_FORMAT_VERSION,
		generator: CATALOG_GENERATOR,
		exportedAt: new Date().toISOString(),
		source: source?.app === 'easyeda-pro' ? source : { app: 'easyeda-pro', appVersion: '' },
		libraries: [],
	};
}

/** 接受导出的 CatalogJson，也接受带 catalog 字段的存储记录。格式必须是当前 0.2。 */
export function parseImportedCatalog(raw: unknown): CatalogJson {
	if (!raw || typeof raw !== 'object')
		throw new Error('文件不是 JSON 对象');
	const obj = raw as Record<string, unknown>;
	const nested = obj.catalog;
	const body = nested && typeof nested === 'object' && Array.isArray((nested as CatalogJson).libraries)
		? nested as CatalogJson
		: obj as unknown as CatalogJson;
	if (!Array.isArray(body.libraries))
		throw new Error('文件里没有 libraries，不是本插件导出的目录 JSON');
	const ver = String(body.formatVersion || '');
	if (!ver)
		throw new Error('文件缺少 formatVersion，无法确认为目录 JSON');
	if (ver !== COMPAT_FORMAT_VERSION)
		throw new Error(`目录格式 ${ver} 与当前 ${COMPAT_FORMAT_VERSION} 不兼容`);
	return body;
}

function indexCatalog(catalog: CatalogJson): { libs: Map<string, IndexedLib>; invalidLibraries: number } {
	const libs = new Map<string, IndexedLib>();
	let invalidLibraries = 0;
	for (const lib of catalog.libraries) {
		if (!lib || typeof lib !== 'object' || !LIBRARY_KINDS.has(String(lib.libraryKind))) {
			invalidLibraries++;
			continue;
		}
		const key = libraryVisibilityKey(lib);
		let slot = libs.get(key);
		if (!slot) {
			slot = { key, lib, modules: new Map(), duplicateUuids: 0, invalid: 0 };
			libs.set(key, slot);
		}
		for (const mod of Array.isArray(lib.modules) ? lib.modules : []) {
			const uuid = typeof mod?.uuid === 'string' ? mod.uuid.trim() : '';
			if (!uuid) {
				slot.invalid++;
				continue;
			}
			if (slot.modules.has(uuid))
				slot.duplicateUuids++;
			slot.modules.set(uuid, mod);
		}
	}
	return { libs, invalidLibraries };
}

function classSig(mod: CatalogModule): string {
	return [...(mod.classification || [])].map(s => String(s)).sort().join('\u0001');
}

function boardSig(mod: CatalogModule): string {
	return (mod.boards || []).map(b => [b.itemType, b.name, b.schematic || '', b.pcb || '', b.parentProjectUuid || ''].join('\u0001')).join('\u0002');
}

function conflictFields(current: CatalogModule, incoming: CatalogModule): Array<string> {
	const fields: Array<string> = [];
	if ((current.name || '') !== (incoming.name || ''))
		fields.push('名称');
	if ((current.description || '') !== (incoming.description || ''))
		fields.push('描述');
	if (classSig(current) !== classSig(incoming))
		fields.push('分类');
	if ((current.updateTimestamp ?? null) !== (incoming.updateTimestamp ?? null))
		fields.push('更新时间');
	if ((current.ascription || '') !== (incoming.ascription || ''))
		fields.push('归属');
	if ((current.storage || 'cloud') !== (incoming.storage || 'cloud'))
		fields.push('存储位置');
	if (boardSig(current) !== boardSig(incoming))
		fields.push('图页');
	return fields;
}

function importIsNewer(current: CatalogModule, incoming: CatalogModule): boolean {
	const next = incoming.updateTimestamp;
	const prev = current.updateTimestamp;
	return typeof next === 'number' && (typeof prev !== 'number' || next > prev);
}

function takeImport(current: CatalogModule, incoming: CatalogModule, policy: CatalogImportPolicy): boolean {
	if (policy.onConflict === 'import')
		return true;
	if (policy.onConflict === 'newer')
		return importIsNewer(current, incoming);
	return false;
}

function pushSample(list: Array<CatalogImportItem>, item: CatalogImportItem): void {
	if (list.length < IMPORT_SAMPLE)
		list.push(item);
}

function libraryLabel(lib: CatalogLibrary): string {
	return lib.moduleName || lib.libraryUuid || lib.libraryKind;
}

/** 失败且没有任何模块的库不参与对照，避免一份空的失败记录把现有模块算成「文件里没有」。 */
function importLibraryUsable(slot: IndexedLib): boolean {
	return !(slot.lib.failed && slot.modules.size === 0);
}

function statsFromCatalog(catalog: CatalogJson): CatalogStatsView {
	let modules = 0;
	let emptyDesc = 0;
	let failed = 0;
	for (const lib of catalog.libraries) {
		if (lib.failed)
			failed++;
		modules += lib.modules.length;
		for (const mod of lib.modules) {
			if (!String(mod.description || '').trim())
				emptyDesc++;
		}
	}
	return { libraries: catalog.libraries.length, modules, emptyDesc, failed, elapsedMs: 0 };
}

export async function previewCatalogImport(raw: unknown): Promise<CatalogImportPreview> {
	const incoming = parseImportedCatalog(raw);
	const inc = indexCatalog(incoming);
	const current = await loadCatalogRecord();
	const cur = indexCatalog(current?.catalog || emptyImportedCatalog(incoming.source));
	const preview: CatalogImportPreview = {
		identical: 0,
		conflicts: 0,
		added: 0,
		missing: 0,
		fileDuplicates: 0,
		invalid: inc.invalidLibraries,
		skippedFailedLibraries: 0,
		untouchedLibraries: 0,
		samples: { conflicts: [], added: [], missing: [] },
	};
	const touched = new Set<string>();
	for (const [key, slot] of inc.libs) {
		preview.fileDuplicates += slot.duplicateUuids;
		preview.invalid += slot.invalid;
		if (!importLibraryUsable(slot)) {
			preview.skippedFailedLibraries++;
			continue;
		}
		touched.add(key);
		const curSlot = cur.libs.get(key);
		if (!curSlot) {
			preview.added += slot.modules.size;
			for (const mod of slot.modules.values())
				pushSample(preview.samples.added, { name: mod.name || mod.uuid, library: libraryLabel(slot.lib), uuid: mod.uuid });
			continue;
		}
		for (const [uuid, mod] of slot.modules) {
			const exist = curSlot.modules.get(uuid);
			if (!exist) {
				preview.added++;
				pushSample(preview.samples.added, { name: mod.name || uuid, library: libraryLabel(slot.lib), uuid });
				continue;
			}
			const fields = conflictFields(exist, mod);
			if (!fields.length) {
				preview.identical++;
				continue;
			}
			preview.conflicts++;
			pushSample(preview.samples.conflicts, { name: exist.name || uuid, library: libraryLabel(curSlot.lib), uuid, fields });
		}
		for (const [uuid, mod] of curSlot.modules) {
			if (slot.modules.has(uuid))
				continue;
			preview.missing++;
			pushSample(preview.samples.missing, { name: mod.name || uuid, library: libraryLabel(curSlot.lib), uuid });
		}
	}
	for (const key of cur.libs.keys()) {
		if (!touched.has(key))
			preview.untouchedLibraries++;
	}
	return preview;
}

export async function applyCatalogImport(raw: unknown, policy: CatalogImportPolicy): Promise<CatalogImportApplied> {
	if (!policy || !['keep', 'import', 'newer'].includes(policy.onConflict) || !['add', 'skip'].includes(policy.onAdded) || !['keep', 'drop'].includes(policy.onMissing))
		throw new Error('导入策略无效');
	const incoming = parseImportedCatalog(raw);
	const inc = indexCatalog(incoming);
	const current = await loadCatalogRecord();
	const catalog = JSON.parse(JSON.stringify(current?.catalog || emptyImportedCatalog(incoming.source))) as CatalogJson;
	const base = indexCatalog(catalog);
	const applied: CatalogImportApplied = {
		keptIdentical: 0,
		conflictsKept: 0,
		conflictsImported: 0,
		added: 0,
		missingKept: 0,
		missingDropped: 0,
		modules: 0,
		libraries: 0,
	};
	for (const [key, slot] of inc.libs) {
		if (!importLibraryUsable(slot))
			continue;
		let dest = base.libs.get(key);
		if (!dest) {
			if (policy.onAdded !== 'add')
				continue;
			const shell: CatalogLibrary = {
				libraryUuid: slot.lib.libraryUuid,
				libraryKind: slot.lib.libraryKind,
				moduleName: slot.lib.moduleName,
				failed: false,
				error: null,
				modules: [],
			};
			catalog.libraries.push(shell);
			dest = { key, lib: shell, modules: new Map(), duplicateUuids: 0, invalid: 0 };
			base.libs.set(key, dest);
		}
		for (const [uuid, mod] of slot.modules) {
			const exist = dest.modules.get(uuid);
			if (!exist) {
				if (policy.onAdded !== 'add')
					continue;
				const copy = JSON.parse(JSON.stringify(mod)) as CatalogModule;
				dest.lib.modules.push(copy);
				dest.modules.set(uuid, copy);
				applied.added++;
				continue;
			}
			if (!conflictFields(exist, mod).length) {
				applied.keptIdentical++;
				continue;
			}
			if (!takeImport(exist, mod, policy)) {
				applied.conflictsKept++;
				continue;
			}
			const copy = JSON.parse(JSON.stringify(mod)) as CatalogModule;
			const at = dest.lib.modules.findIndex(m => m.uuid === uuid);
			if (at >= 0)
				dest.lib.modules[at] = copy;
			dest.modules.set(uuid, copy);
			applied.conflictsImported++;
		}
		if (policy.onMissing === 'drop') {
			dest.lib.modules = dest.lib.modules.filter((mod) => {
				if (slot.modules.has(mod.uuid))
					return true;
				applied.missingDropped++;
				return false;
			});
		}
		else {
			for (const mod of dest.lib.modules) {
				if (!slot.modules.has(mod.uuid))
					applied.missingKept++;
			}
		}
		if (dest.lib.modules.length && dest.lib.failed && !slot.lib.failed) {
			dest.lib.failed = false;
			dest.lib.error = null;
		}
	}
	const stats = statsFromCatalog(catalog);
	await saveCatalogRecord({
		formatVersion: COMPAT_FORMAT_VERSION,
		fetchedAt: Date.now(),
		catalog,
		stats,
	});
	applied.modules = stats.modules;
	applied.libraries = stats.libraries;
	return applied;
}

export function flattenCatalog(catalog: CatalogJson): Array<FlatModule> {
	const out: Array<FlatModule> = [];
	for (const lib of catalog.libraries) {
		for (const m of lib.modules) {
			out.push({
				...m,
				libraryUuid: lib.libraryUuid,
				libraryKind: lib.libraryKind,
				src: lib.moduleName,
				pageSupport: pageSupportOf(lib.libraryKind),
			});
		}
	}
	return out;
}

/** uuid 反查（O(n) 一次遍历；目录 ≤ 数百条，无需建索引）。 */
export async function lookupModule(cbbUuid: string): Promise<FlatModule | null> {
	const rec = await loadModelCatalogRecord();
	if (!rec)
		return null;
	return flattenCatalog(rec.catalog).find(m => m.uuid === cbbUuid) || null;
}

/** 单词命中得分：名称前缀 > 名称包含 > 分类包含 > 描述包含。 */
function tokenScore(token: string, name: string, cls: string, desc: string): number {
	if (name.startsWith(token))
		return 6;
	if (name.includes(token))
		return 4;
	if (cls.includes(token))
		return 3;
	if (desc.includes(token))
		return 1;
	return 0;
}

/**
 * 关键词检索：空格分词、逐词 AND；评分 = 名称命中 > 分类命中 > 描述命中，前缀加成。
 * 空查询返回按库序的前 limit 条（浏览用）。
 *
 * 两段式（回退段为 2026-10-14 新增）：严格 AND 有结果就只返回严格结果；
 * 一个都没有时放宽为「命中至少一个词」，按命中词数优先、总分次之排序。
 * 此前只有严格段，多词需求少命中一个词就直接空手而归（如「3.3V LDO 低功耗」
 * 而模块只写了其中两个词）。relaxed=true 表示这批是放宽结果，供上层提示换词再试。
 *
 * 分类维度的有效性取决于目录数据：classification 真值来自 lib_Cbb.get（见 catalog.ts
 * fetchModuleDetail），search 行里恒为空。get 不可达的库（本地库崩溃）分类仍为空，
 * 此时该维度自然不参与打分。
 */
export function searchInCatalog(rec: CatalogStoreRecord, query: string, limit: number): { hits: Array<{ module: FlatModule; score: number }>; relaxed: boolean } {
	const flat = flattenCatalog(rec.catalog);
	const tokens = (query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length)
		return { hits: flat.slice(0, limit).map(module => ({ module, score: 0 })), relaxed: false };

	const strict: Array<{ module: FlatModule; score: number }> = [];
	const loose: Array<{ module: FlatModule; score: number; hit: number }> = [];
	for (const m of flat) {
		const name = (m.name || '').toLowerCase();
		const desc = (m.description || '').toLowerCase();
		const cls = (m.classification || []).join(' ').toLowerCase();
		let total = 0;
		let hit = 0;
		for (const t of tokens) {
			const s = tokenScore(t, name, cls, desc);
			if (s)
				hit++;
			total += s;
		}
		if (!hit)
			continue;
		if (hit === tokens.length)
			strict.push({ module: m, score: total });
		else
			loose.push({ module: m, score: total, hit });
	}
	if (strict.length) {
		strict.sort((a, b) => b.score - a.score);
		return { hits: strict.slice(0, limit), relaxed: false };
	}
	loose.sort((a, b) => b.hit - a.hit || b.score - a.score);
	return { hits: loose.slice(0, limit).map(({ module, score }) => ({ module, score })), relaxed: loose.length > 0 };
}

// ── 新鲜度提示（供 system 注入的统计摘要） ───────────────────────────

export function humanizeAge(ms: number): string {
	if (ms < 60_000)
		return '刚刚';
	if (ms < 3_600_000)
		return `${Math.floor(ms / 60_000)} 分钟前`;
	if (ms < 86_400_000)
		return `${Math.floor(ms / 3_600_000)} 小时前`;
	return `${Math.floor(ms / 86_400_000)} 天前`;
}

/**
 * system 注入用的目录摘要（几百 token 级）：统计 + 各库计数 + 新鲜度 + 使用指引。
 * 完整模块数据不进上下文——检索走 search_modules / recommend_modules 分工。
 */
export interface HiddenLibraryBrief {
	name: string;
	modules: number;
	failed?: true;
}

/** 已拉取但用户关掉可见范围的库。模型检索不到这些库里的模块。 */
export async function hiddenLibraryBriefs(): Promise<Array<HiddenLibraryBrief>> {
	const rec = await loadCatalogRecord();
	if (!rec)
		return [];
	const hidden = new Set(getHiddenLibraryKeys());
	if (!hidden.size)
		return [];
	return rec.catalog.libraries
		.filter(lib => hidden.has(libraryVisibilityKey(lib)))
		.map(lib => ({
			name: lib.moduleName || lib.libraryUuid,
			modules: lib.modules.length,
			failed: lib.failed ? true as const : undefined,
		}));
}

/** 分类摘要最多列几条（控制注入体积）。 */
const CLASS_SUMMARY_MAX = 12;

/**
 * 目录里的分类分布：分类是路径数组（如 ["树莓派系列最小系统","树莓派紧凑型号"]），
 * 用 / 连接成一条完整路径，按模块数降序取前 N 条。
 * 数据来自 lib_Cbb.get（见 catalog.ts fetchModuleDetail）；get 不可达的库贡献为空。
 */
function classificationBrief(catalog: CatalogJson): Array<{ name: string; modules: number }> {
	const counts = new Map<string, number>();
	for (const lib of catalog.libraries) {
		for (const m of lib.modules) {
			const path = (m.classification || []).map(s => String(s).trim()).filter(Boolean).join('/');
			if (path)
				counts.set(path, (counts.get(path) || 0) + 1);
		}
	}
	return [...counts.entries()]
		.map(([name, modules]) => ({ name, modules }))
		.sort((a, b) => b.modules - a.modules || a.name.localeCompare(b.name))
		.slice(0, CLASS_SUMMARY_MAX);
}

export function buildCatalogSummaryPayload(rec: CatalogStoreRecord, hidden: Array<HiddenLibraryBrief> = []): string {
	const perLib = rec.catalog.libraries.map(l => ({
		kind: l.libraryKind,
		name: l.moduleName,
		modules: l.modules.length,
		failed: l.failed || undefined,
		error: l.failed ? (l.error || '拉取失败') : undefined,
	}));
	const classes = classificationBrief(rec.catalog);
	const ageMs = Math.max(0, Date.now() - rec.fetchedAt);
	const hiddenLibraries = hidden.length ? hidden : undefined;
	return JSON.stringify({
		moduleCount: rec.stats.modules,
		emptyDesc: rec.stats.emptyDesc || undefined,
		failedLibraries: rec.stats.failed || undefined,
		fetchedAt: humanizeAge(ageMs),
		stale: ageMs > STALE_HINT_MS || undefined,
		staleHint: ageMs > STALE_HINT_MS ? '目录数据较旧，若用户关心最新模块可调用 refresh_catalog' : undefined,
		libraries: perLib,
		// 分类是路径（父/子）；模型可直接拿它当 search_modules 的关键词，用于「按类别找模块」类需求。
		classifications: classes.length ? classes : undefined,
		classificationHint: classes.length
			? 'classifications 是各库现有分类（路径用 / 连接，父在前）。用户按类别找模块时，可把分类名当关键词传给 search_modules——分类参与检索打分。'
			: undefined,
		hiddenLibraries,
		visibilityHint: hiddenLibraries
			? '这些库已经在本地目录里，只是用户关闭了对你的可见范围，所以检索结果里没有。找不到模块时，请用户打开设置里的「模块库目录」，勾选对应库并点「保存可见范围」。不要为此调用 refresh_catalog，也不要建议重新拉取、导入或复制模块。'
			: undefined,
		usage: '模块明细不在上下文中。是否已经具体到可以检索，按系统提示【系统提示词】判断。可以检索时：模块名/型号用 search_modules；带具体功能参数的描述用 recommend_modules（query 传用户原始需求整句）。改名称/描述前用 inspect_module，看单个模块详情用 get_module(cbbUuid)，需要最新数据用 refresh_catalog。',
	});
}

/** 目录缓存为空时注入的提示（引导模型先 refresh_catalog）。 */
export const EMPTY_CATALOG_NOTE = '当前目录缓存为空。请先调用 refresh_catalog 拉取目录（首次约 20 秒），再执行需要模块信息的操作。';

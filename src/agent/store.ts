/**
 * 目录持久化存储（插件级，跨会话/跨重启）。
 * 三级降级适配器：sys_Storage →（API 缺失/抛错）IndexedDB →（都不可用）会话内存。
 * 两端同代码路径：桌面端与网页版 sys_Storage 均已实测持久化（2026-09-18 网页版真机跨重启验证），
 * IndexedDB 仅为防御性兜底（某版本 API 缺失或抛错时自动降级）。
 * 功能探测只做一次并缓存结果；任何一层失败静默降级，不阻塞主流程。
 *
 * 目录检索：search_modules 关键词评分 + get_module 单模块详情，替代整包注入 LLM。
 */
import type { CatalogFetchReport, CatalogJson, CatalogModule, CatalogStatsView } from '../catalog';
import { pageSupportOf } from '../catalog';
import { edaGlobal } from '../host';

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

// ── 三级适配器：内存（永远可用） ─────────────────────────────────────

let memoryRecord: CatalogStoreRecord | null = null;

// ── 一级：sys_Storage ────────────────────────────────────────────────

type SysStorageApi = {
	getExtensionUserConfig?: (k: string) => string;
	setExtensionUserConfig?: (k: string, v: string) => void;
	deleteExtensionUserConfig?: (k: string) => void;
};

function sysStorage(): SysStorageApi | undefined {
	try {
		return (edaGlobal()?.sys_Storage ?? undefined) as SysStorageApi | undefined;
	}
	catch {
		return undefined;
	}
}

let sysStorageAvailable: boolean | null = null;

function sysGet(key: string): string {
	const api = sysStorage();
	if (typeof api?.getExtensionUserConfig !== 'function') {
		sysStorageAvailable = false;
		return '';
	}
	try {
		const v = api.getExtensionUserConfig(key);
		sysStorageAvailable = true;
		return typeof v === 'string' ? v : '';
	}
	catch {
		sysStorageAvailable = false;
		return '';
	}
}

function sysSet(key: string, val: string): boolean {
	const api = sysStorage();
	if (typeof api?.setExtensionUserConfig !== 'function') {
		sysStorageAvailable = false;
		return false;
	}
	try {
		api.setExtensionUserConfig(key, val);
		sysStorageAvailable = true;
		return true;
	}
	catch {
		sysStorageAvailable = false;
		return false;
	}
}

function sysDelete(key: string): void {
	const api = sysStorage();
	if (typeof api?.deleteExtensionUserConfig !== 'function')
		return;
	try {
		api.deleteExtensionUserConfig(key);
	}
	catch { /* 尽力而为 */ }
}

// ── 二级：IndexedDB（iframe 可用的标准浏览器存储；主进程缺失时静默跳过） ──

const IDB_NAME = 'jlc-cbb-copilot';
const IDB_STORE = 'kv';
const IDB_VERSION = 1;

let idbDb: IDBDatabase | null = null;
let idbBroken = false;

function idbOpen(): Promise<IDBDatabase | null> {
	if (idbDb)
		return Promise.resolve(idbDb);
	if (idbBroken || typeof indexedDB === 'undefined' || indexedDB === null) {
		idbBroken = true;
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		try {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(IDB_STORE))
					req.result.createObjectStore(IDB_STORE);
			};
			req.onsuccess = () => {
				idbDb = req.result;
				resolve(idbDb);
			};
			req.onerror = () => {
				idbBroken = true;
				resolve(null);
			};
		}
		catch {
			idbBroken = true;
			resolve(null);
		}
	});
}

async function idbGet(key: string): Promise<string> {
	const db = await idbOpen();
	if (!db)
		return '';
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, 'readonly');
			const req = tx.objectStore(IDB_STORE).get(key);
			req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : '');
			req.onerror = () => resolve('');
		}
		catch {
			resolve('');
		}
	});
}

async function idbSet(key: string, val: string): Promise<boolean> {
	const db = await idbOpen();
	if (!db)
		return false;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, 'readwrite');
			tx.objectStore(IDB_STORE).put(val, key);
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => resolve(false);
			tx.onabort = () => resolve(false);
		}
		catch {
			resolve(false);
		}
	});
}

async function idbDelete(key: string): Promise<void> {
	const db = await idbOpen();
	if (!db)
		return;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(IDB_STORE, 'readwrite');
			tx.objectStore(IDB_STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
			tx.onabort = () => resolve();
		}
		catch {
			resolve();
		}
	});
}

// ── 记录读写：内存 → sys_Storage → IndexedDB 逐级读取；写则尽力全写 ──

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

/** 读目录记录：内存 → sys_Storage → IndexedDB。全部未命中返回 null。 */
export async function loadCatalogRecord(): Promise<CatalogStoreRecord | null> {
	if (memoryRecord)
		return memoryRecord;
	const hit = parseRecord(sysGet(STORE_KEY));
	if (hit) {
		memoryRecord = hit;
		return hit;
	}
	const idbRaw = await idbGet(STORE_KEY);
	const idbHit = parseRecord(idbRaw);
	if (idbHit) {
		memoryRecord = idbHit;
		// 回填更稳的一级存储（尽力而为）
		sysSet(STORE_KEY, idbRaw);
		return idbHit;
	}
	return null;
}

/** 写目录记录：内存永远写；sys_Storage / IndexedDB 尽力写（互为备份，允许部分失败）。 */
export async function saveCatalogRecord(rec: CatalogStoreRecord): Promise<void> {
	memoryRecord = rec;
	const raw = JSON.stringify(rec);
	const sysOk = sysSet(STORE_KEY, raw);
	if (!sysOk)
		await idbSet(STORE_KEY, raw);
}

export async function clearCatalogRecord(): Promise<void> {
	memoryRecord = null;
	sysDelete(STORE_KEY);
	await idbDelete(STORE_KEY);
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

/** 拉取结果落盘：构建记录并写入三级存储。 */
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
	const rec = await loadCatalogRecord();
	if (!rec)
		return null;
	return flattenCatalog(rec.catalog).find(m => m.uuid === cbbUuid) || null;
}

/** 同步读取已加载的内存记录（仅命中内存层，不触发磁盘读）；未加载返回 null。 */
export function memoryRecordIfLoaded(): CatalogStoreRecord | null {
	return memoryRecord;
}

/**
 * 关键词检索：空格分词、逐词 AND；评分 = 名称命中 > 分类命中 > 描述命中，前缀加成。
 * 空查询返回按库序的前 limit 条（浏览用）。
 */
export function searchInCatalog(rec: CatalogStoreRecord, query: string, limit: number): Array<{ module: FlatModule; score: number }> {
	const flat = flattenCatalog(rec.catalog);
	const q = (query || '').trim().toLowerCase();
	const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
	const scored: Array<{ module: FlatModule; score: number }> = [];
	for (const m of flat) {
		if (!tokens.length) {
			scored.push({ module: m, score: 0 });
			continue;
		}
		const name = (m.name || '').toLowerCase();
		const desc = (m.description || '').toLowerCase();
		const cls = (m.classification || []).join(' ').toLowerCase();
		let total = 0;
		let matchedAll = true;
		for (const t of tokens) {
			let s = 0;
			if (name.startsWith(t))
				s = 6;
			else if (name.includes(t))
				s = 4;
			else if (cls.includes(t))
				s = 3;
			else if (desc.includes(t))
				s = 1;
			if (!s) {
				matchedAll = false;
				break;
			}
			total += s;
		}
		if (matchedAll && total > 0)
			scored.push({ module: m, score: total });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit);
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
 * 完整模块数据不进上下文——检索一律走 search_modules / get_module。
 */
export function buildCatalogSummaryPayload(rec: CatalogStoreRecord): string {
	const perLib = rec.catalog.libraries.map(l => ({
		kind: l.libraryKind,
		name: l.moduleName,
		modules: l.modules.length,
		failed: l.failed || undefined,
		error: l.failed ? (l.error || '拉取失败') : undefined,
	}));
	const ageMs = Math.max(0, Date.now() - rec.fetchedAt);
	return JSON.stringify({
		moduleCount: rec.stats.modules,
		emptyDesc: rec.stats.emptyDesc || undefined,
		failedLibraries: rec.stats.failed || undefined,
		fetchedAt: humanizeAge(ageMs),
		stale: ageMs > STALE_HINT_MS || undefined,
		staleHint: ageMs > STALE_HINT_MS ? '目录数据较旧，若用户关心最新模块可调用 refresh_catalog' : undefined,
		libraries: perLib,
		usage: '模块明细不在上下文中：找模块用 search_modules（关键词），看单个模块详情用 get_module(cbbUuid)，需要最新数据用 refresh_catalog。',
	});
}

/** 目录缓存为空时注入的提示（引导模型先 refresh_catalog）。 */
export const EMPTY_CATALOG_NOTE = '当前目录缓存为空。请先调用 refresh_catalog 拉取目录（首次约 20 秒），再执行需要模块信息的操作。';

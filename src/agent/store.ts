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

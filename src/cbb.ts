/**
 * 对复用模块的读与写操作：读模块原理图摘要（AI 分析用）、符号放置、图页放置、改名称/描述。
 * 写画布/写库前由 agent 确认卡令牌把关；读模块页只切视图不改画布。
 *
 * 放置两轴（不再有第三种「区域」形式）：
 * - 形式 mode：复用模块符号 / 复用模块图页；两种都画矩形框 + 模块名标题
 * - 位置 target：当前图页 / 新建图页 / 新建板子（含原理图） / 新建工程
 *
 * 实测：createCbbSymbol 可省略符号 uuid；假 uuid 会挂起 ≥8s，必须超时；
 * placeCbbSchematicPage 把模块原理图内容落到当前活动图页（不会自己建页）；
 * lib_Cbb.create 静默失败，只做 modify；每次放置有双重副作用（背板原理图 + 工程库副本）。
 * 本地图页放置（2026-09-16 半离线 V3.2.166 实测）：lib_Cbb.get 对本地模块必崩（parent_tag），
 * 图页 uuid 改由 .eprj2 明文工程树解析（resolveCbbPageUuid → readLocalSheetUuid），放置返回 true。
 */
import { matchLocalEprjRow } from './catalog';
import { edaGlobal, fmtErr, sleep, withTimeout } from './host';

const PLACE_TIMEOUT_MS = 30000;
const MODIFY_TIMEOUT_MS = 20000;
const PAGE_SWITCH_TIMEOUT_MS = 8000;
const SAVE_TIMEOUT_MS = 20000;
/** EDMT_EditorDocumentType：原理图页 / PCB / 面板，对应 sch|pcb|pnl_Document.save。 */
const DOC_SCHEMATIC_PAGE = 1;
const DOC_PCB = 3;
const DOC_PANEL = 26;

export type PlaceMode = 'symbol' | 'page';
export type PlaceTarget = 'current' | 'new' | 'board' | 'project';

export function parsePlaceTarget(raw: unknown): PlaceTarget {
	if (raw === 'new' || raw === 'board' || raw === 'project')
		return raw;
	return 'current';
}

interface PlaceParams {
	libraryUuid: string;
	cbbUuid: string;
}

interface PlaceResult {
	primitiveId: string;
	designator: string;
}

export interface PlaceBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface PlaceModuleResult {
	primitiveId?: string;
	designator?: string;
	pageUuid: string;
	pageName: string;
	/** 含标注框的占用范围，供同页多模块错开。 */
	occupied?: PlaceBox;
	/** 实际使用的放置锚点：避让扫描可能修正提议点，缓存/对齐必须用它。 */
	anchor: { x: number; y: number };
	/** 实际放置形式：请求 symbol 但模块符号为空时会回退为 page。 */
	mode: PlaceMode;
	/** 请求 symbol 但因空符号回退为 page 时为 true，供结果提示。 */
	fallbackFromSymbol?: boolean;
}

// （历史常量 DEFAULT_PACK_GAP 已删除：排布间距由设置页 gapX/gapY 与确认卡 grid 提供。）

export interface DocState {
	/** EDMT_EditorDocumentType：1 = 原理图页。 */
	documentType: number | null;
	ok: boolean;
	uuid: string | null;
}

export interface ModifyCbbParams {
	cbbUuid: string;
	libraryUuid: string;
	name: string;
	description: string;
}

export async function getCurrentDocState(): Promise<DocState> {
	const sel = edaGlobal()?.dmt_SelectControl as
		| { getCurrentDocumentInfo?: () => Promise<{ documentType?: number; uuid?: string } | null> }
		| undefined;
	try {
		const doc = typeof sel?.getCurrentDocumentInfo === 'function' ? await sel.getCurrentDocumentInfo() : null;
		const documentType = doc && typeof doc.documentType === 'number' ? doc.documentType : null;
		const uuid = doc && typeof doc.uuid === 'string' ? doc.uuid : null;
		return { documentType, ok: documentType === 1, uuid };
	}
	catch {
		return { documentType: null, ok: false, uuid: null };
	}
}

async function getCurrentPageMeta(): Promise<{ pageUuid: string; pageName: string }> {
	const state = await getCurrentDocState();
	if (!state.ok || !state.uuid)
		throw new Error('当前活动文档不是原理图页，无法放置。请切换到原理图页后重试。');
	const sch = edaGlobal()?.dmt_Schematic as
		| { getCurrentSchematicPageInfo?: () => Promise<{ uuid?: string; name?: string } | null> }
		| undefined;
	try {
		const page = typeof sch?.getCurrentSchematicPageInfo === 'function' ? await sch.getCurrentSchematicPageInfo() : null;
		return {
			pageUuid: (page && typeof page.uuid === 'string' && page.uuid) || state.uuid,
			pageName: (page && typeof page.name === 'string' && page.name) || '',
		};
	}
	catch {
		return { pageUuid: state.uuid, pageName: '' };
	}
}

/** 工程库条目是放置时自动生成的内嵌副本，对它调放置/编辑会挂起或抛普通对象。 */
function assertPlaceableLibrary(libraryUuid: string): void {
	if (libraryUuid === 'project')
		throw new Error('工程库中的条目是放置时自动生成的工程内嵌副本，不支持放置与编辑。请对个人库或本地库中的原模块操作。');
}

export async function activateSchematicPage(pageUuid: string): Promise<void> {
	const editor = edaGlobal()?.dmt_EditorControl as
		| { openDocument?: (documentUuid: string) => Promise<string | undefined> }
		| undefined;
	if (typeof editor?.openDocument !== 'function')
		throw new Error('dmt_EditorControl.openDocument 不可用，无法切换图页');
	const tabId = await withTimeout(editor.openDocument(pageUuid), 15000, '打开图页超时');
	if (!tabId)
		throw new Error('打开图页失败');
	const deadline = Date.now() + PAGE_SWITCH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const state = await getCurrentDocState();
		if (state.ok && state.uuid === pageUuid)
			return;
		await sleep(200);
	}
	throw new Error('切换图页后未能激活目标原理图页，请手动打开后重试');
}

async function openNewSchematicPage(): Promise<{ pageUuid: string; pageName: string }> {
	const state = await getCurrentDocState();
	if (!state.ok)
		throw new Error('当前活动文档不是原理图页，无法新建图页。请切换到原理图页后重试。');
	const sch = edaGlobal()?.dmt_Schematic as
		| {
			getCurrentSchematicInfo?: () => Promise<{ uuid?: string } | null>;
			createSchematicPage?: (schematicUuid: string) => Promise<string | undefined>;
			getSchematicPageInfo?: (uuid: string) => Promise<{ uuid?: string; name?: string } | null>;
		}
		| undefined;
	const getSch = sch?.getCurrentSchematicInfo;
	const createPage = sch?.createSchematicPage;
	if (!sch || typeof getSch !== 'function' || typeof createPage !== 'function')
		throw new Error('dmt_Schematic.createSchematicPage 不可用（宿主版本过低或不支持）');
	const current = await withTimeout(getSch.call(sch), 10000, '读取当前原理图超时');
	const schematicUuid = current && typeof current.uuid === 'string' ? current.uuid : '';
	if (!schematicUuid)
		throw new Error('无法确定当前原理图，新建图页失败。');
	const pageUuid = await withTimeout(createPage.call(sch, schematicUuid), 15000, '新建图页超时');
	if (!pageUuid)
		throw new Error('新建图页未成功（未返回图页 uuid）');
	await activateSchematicPage(pageUuid);
	let pageName = '';
	try {
		const info = typeof sch.getSchematicPageInfo === 'function' ? await sch.getSchematicPageInfo(pageUuid) : null;
		pageName = info && typeof info.name === 'string' ? info.name : '';
	}
	catch { pageName = ''; }
	return { pageUuid, pageName };
}

function stampName(base: string): string {
	const cleaned = (base || '复用模块').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || '复用模块';
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${cleaned}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function firstPageFromSchematic(schematic: { uuid?: string; page?: Array<{ uuid?: string; name?: string }> } | null | undefined): Promise<{ pageUuid: string; pageName: string } | null> {
	const pages = Array.isArray(schematic?.page) ? schematic.page : [];
	const first = pages.find(p => typeof p?.uuid === 'string' && p.uuid);
	if (!first?.uuid)
		return null;
	await activateSchematicPage(first.uuid);
	return { pageUuid: first.uuid, pageName: typeof first.name === 'string' ? first.name : '' };
}

async function openBoardSchematicPage(boardName: string): Promise<{ pageUuid: string; pageName: string }> {
	const boardApi = edaGlobal()?.dmt_Board as
		| { getBoardInfo?: (boardName: string) => Promise<{ name?: string; schematic?: { uuid?: string; page?: Array<{ uuid?: string; name?: string }> } } | null> }
		| undefined;
	const getInfo = boardApi?.getBoardInfo;
	if (typeof getInfo !== 'function')
		throw new Error('dmt_Board.getBoardInfo 不可用，无法打开新建板子的原理图');
	const deadline = Date.now() + 12000;
	while (Date.now() < deadline) {
		try {
			const info = await withTimeout(getInfo.call(boardApi, boardName), 8000, '读取板子信息超时');
			const page = await firstPageFromSchematic(info?.schematic);
			if (page)
				return page;
		}
		catch { /* 板子刚创建时可能尚未同步 */ }
		await sleep(300);
	}
	throw new Error('新建板子后未能打开原理图页，请手动打开后再放置');
}

async function openNewBoardAndSchematic(): Promise<{ pageUuid: string; pageName: string }> {
	const proj = edaGlobal()?.dmt_Project as
		| { getCurrentProjectInfo?: () => Promise<{ uuid?: string } | null> }
		| undefined;
	let current: { uuid?: string } | null = null;
	try {
		current = typeof proj?.getCurrentProjectInfo === 'function' ? await proj.getCurrentProjectInfo() : null;
	}
	catch { current = null; }
	if (!current?.uuid)
		throw new Error('当前没有打开的工程，无法新建板子。请先打开工程，或改用「新建工程」。');
	const boardApi = edaGlobal()?.dmt_Board as
		| { createBoard?: (schematicUuid?: string, pcbUuid?: string) => Promise<string | undefined> }
		| undefined;
	const createBoard = boardApi?.createBoard;
	if (typeof createBoard !== 'function')
		throw new Error('dmt_Board.createBoard 不可用（宿主版本过低或不支持）');
	const boardName = await withTimeout(createBoard.call(boardApi), 20000, '新建板子超时');
	if (!boardName)
		throw new Error('新建板子未成功（未返回板子名）');
	return openBoardSchematicPage(boardName);
}

async function resolveFallbackTeamUuid(): Promise<string | undefined> {
	const teamApi = edaGlobal()?.dmt_Team as
		| { getAllTeamsInfo?: () => Promise<Array<{ uuid?: string; name?: string; identity?: number }>> }
		| undefined;
	if (typeof teamApi?.getAllTeamsInfo !== 'function')
		return undefined;
	try {
		const teams = await withTimeout(teamApi.getAllTeamsInfo(), 10000, '读取团队列表超时');
		const hit = (Array.isArray(teams) ? teams : []).find(t => typeof t?.uuid === 'string' && t.uuid);
		return hit?.uuid;
	}
	catch {
		return undefined;
	}
}

function documentSaveFn(documentType: number | null): { ns: object; save: () => Promise<boolean> } | null {
	const e = edaGlobal();
	const ns
		= documentType === DOC_SCHEMATIC_PAGE
			? e?.sch_Document
			: documentType === DOC_PCB
				? e?.pcb_Document
				: documentType === DOC_PANEL
					? e?.pnl_Document
					: undefined;
	const save = (ns as { save?: () => Promise<boolean> } | undefined)?.save;
	if (!ns || typeof save !== 'function')
		return null;
	return { ns, save };
}

/**
 * 新建工程前保存当前活动文档。宿主没有工程级 save；
 * 未保存时 createProject/openProject 会弹窗，扩展点不了确认就会失败。
 * 只保存当前文档：分屏树 tabId 与 activateDocument 对不上，切标签会误报失败。
 */
async function saveCurrentProjectDocuments(): Promise<void> {
	const origin = await getCurrentDocState();
	const saver = documentSaveFn(origin.documentType);
	if (!saver)
		return;
	const ok = await withTimeout(saver.save.call(saver.ns), SAVE_TIMEOUT_MS, '保存当前工程超时——请先手动保存后再试');
	if (ok !== true)
		throw new Error('保存当前工程失败，无法继续新建工程。请先手动保存后再试。');
	await sleep(1000);
}

interface ProjectApi {
	createProject?: (friendlyName: string, name?: string, teamUuid?: string, folderUuid?: string, description?: string) => Promise<string | undefined>;
	openProject?: (projectUuid: string) => Promise<boolean>;
	getCurrentProjectInfo?: () => Promise<{ uuid?: string } | null>;
	getProjectInfo?: (projectUuid: string) => Promise<{ uuid?: string } | null>;
}

async function readCurrentProjectUuid(proj: ProjectApi | undefined): Promise<string> {
	if (typeof proj?.getCurrentProjectInfo !== 'function')
		return '';
	try {
		const cur = await proj.getCurrentProjectInfo();
		return typeof cur?.uuid === 'string' ? cur.uuid : '';
	}
	catch {
		return '';
	}
}

async function waitForCurrentProject(proj: ProjectApi | undefined, projectUuid: string, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await readCurrentProjectUuid(proj) === projectUuid)
			return true;
		await sleep(400);
	}
	return await readCurrentProjectUuid(proj) === projectUuid;
}

async function waitForProjectRecord(proj: ProjectApi | undefined, projectUuid: string): Promise<void> {
	if (typeof proj?.getProjectInfo !== 'function') {
		await sleep(1500);
		return;
	}
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		try {
			const info = await proj.getProjectInfo(projectUuid);
			if (info?.uuid === projectUuid)
				return;
		}
		catch { /* 刚创建尚未可查 */ }
		await sleep(400);
	}
}

async function findOpenSchematicPage(): Promise<{ pageUuid: string; pageName: string } | null> {
	const schApi = edaGlobal()?.dmt_Schematic as
		| { getAllSchematicsInfo?: () => Promise<Array<{ uuid?: string; page?: Array<{ uuid?: string; name?: string }> }>> }
		| undefined;
	try {
		const schematics = typeof schApi?.getAllSchematicsInfo === 'function' ? await schApi.getAllSchematicsInfo() : [];
		for (const s of Array.isArray(schematics) ? schematics : []) {
			try {
				const page = await firstPageFromSchematic(s);
				if (page)
					return page;
			}
			catch { /* 图页尚未可打开 */ }
		}
	}
	catch { /* 空工程 */ }
	try {
		const state = await getCurrentDocState();
		if (state.ok && state.uuid)
			return getCurrentPageMeta();
	}
	catch { /* ignore */ }
	return null;
}

async function openNewProjectThenPlacePage(title: string): Promise<{ pageUuid: string; pageName: string }> {
	const proj = edaGlobal()?.dmt_Project as ProjectApi | undefined;
	const createProject = proj?.createProject;
	if (!proj || typeof createProject !== 'function')
		throw new Error('dmt_Project.createProject 不可用（宿主版本过低或不支持）');
	await saveCurrentProjectDocuments();
	const friendlyName = stampName(title);
	let projectUuid = await withTimeout(createProject.call(proj, friendlyName), 20000, '新建工程超时');
	if (!projectUuid) {
		const teamUuid = await resolveFallbackTeamUuid();
		if (teamUuid)
			projectUuid = await withTimeout(createProject.call(proj, friendlyName, undefined, teamUuid), 20000, '新建工程超时');
	}
	if (!projectUuid)
		throw new Error('新建工程未成功。私有部署可能需要团队权限，请确认已登录且有建工程权限。');
	await waitForProjectRecord(proj, projectUuid);
	if (!(await waitForCurrentProject(proj, projectUuid, 8000))) {
		const cur = await readCurrentProjectUuid(proj);
		if (!cur) {
			if (!(await waitForCurrentProject(proj, projectUuid, 15000)))
				throw new Error('新建工程已创建，但未能打开。请手动打开该工程后再试放置。');
		}
		else if (typeof proj.openProject === 'function') {
			void proj.openProject(projectUuid).catch(() => undefined);
			if (!(await waitForCurrentProject(proj, projectUuid, 25000)))
				throw new Error('新建工程已创建，但未能打开。请手动打开该工程后再试放置。');
		}
		else {
			throw new TypeError('dmt_Project.openProject 不可用，无法打开新建工程');
		}
	}
	let page = await findOpenSchematicPage();
	if (!page) {
		const deadline = Date.now() + 8000;
		while (!page && Date.now() < deadline) {
			await sleep(400);
			page = await findOpenSchematicPage();
		}
	}
	if (!page)
		page = await openNewBoardAndSchematic();
	if (await readCurrentProjectUuid(proj) !== projectUuid)
		throw new Error('未能稳定切到新建工程，已中止放置以免放到错误工程。');
	const state = await getCurrentDocState();
	if (!state.ok)
		throw new Error('新建工程已打开，但当前不是原理图页，无法放置。');
	return page;
}

/** 空符号特征错误：模块未生成符号（符号内无任何图元/引脚），放置会得到一个空壳。 */
export class EmptySymbolError extends Error {
	constructor() {
		super('该模块未生成复用模块符号（符号为空）。已自动改用复用模块图页形式放置。');
		this.name = 'EmptySymbolError';
	}
}

async function placeCbbSymbol(params: PlaceParams & { x: number; y: number }): Promise<PlaceResult> {
	assertPlaceableLibrary(params.libraryUuid);
	const state = await getCurrentDocState();
	if (!state.ok)
		throw new Error('当前活动文档不是原理图页，无法放置。请切换到原理图页后重试。');
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| {
			createCbbSymbol?: (cbbSymbol: { libraryUuid: string; cbbUuid: string }, x: number, y: number) => Promise<Record<string, unknown> | undefined>;
			delete?: (ids: Array<string>) => Promise<boolean>;
		}
		| undefined;
	if (typeof comp?.createCbbSymbol !== 'function')
		throw new Error('sch_PrimitiveComponent.createCbbSymbol 不可用（宿主版本过低或不支持）');
	let prim: Record<string, unknown> | undefined;
	try {
		prim = await withTimeout(
			comp.createCbbSymbol({ libraryUuid: params.libraryUuid, cbbUuid: params.cbbUuid }, params.x, params.y),
			PLACE_TIMEOUT_MS,
			'放置超时（30s）——模块数据可能异常，请重试或换一个模块',
		);
	}
	catch (e) {
		throw new Error(fmtErr(e));
	}
	if (!prim || typeof prim !== 'object')
		throw new Error('放置未返回图元，可能未成功。');
	const primitiveId = String(prim.primitiveId ?? '');
	const designator = String(prim.designator ?? '');
	// 空符号检测：宿主不提供"模块是否已生成符号"的查询 API，只能放置后实测。
	// 空符号（无包围盒或包围盒为零）在画布上不可见且不参与避让，会导致后续模块与之重叠——
	// 当场删除这个空壳并抛 EmptySymbolError，由上层自动回退图页放置。
	let bbox: BBox | null = null;
	if (primitiveId)
		bbox = await getSymbolBBox(primitiveId);
	if (!bbox || bbox.maxX - bbox.minX <= 0 || bbox.maxY - bbox.minY <= 0) {
		if (primitiveId && typeof comp.delete === 'function') {
			try {
				await withTimeout(comp.delete([primitiveId]), 10000, '删除空符号超时');
			}
			catch { /* 删除失败不阻塞回退流程，提示用户手动清理 */ }
		}
		throw new EmptySymbolError();
	}
	return { primitiveId, designator };
}

const REGION_MARGIN = 40;
const REGION_FALLBACK_W = 400;
const REGION_FALLBACK_H = 300;

/** 未实测尺寸模块的预放置估计占位（含标注框），也是避让扫描的默认估计。 */
export const EST_OCCUPIED_W = REGION_FALLBACK_W + 2 * REGION_MARGIN;
export const EST_OCCUPIED_H = REGION_FALLBACK_H + 2 * REGION_MARGIN;

export function boxWithMargin(bbox: PlaceBox | null, x: number, y: number, margin: number): PlaceBox {
	return {
		minX: (bbox ? bbox.minX : x - REGION_FALLBACK_W / 2) - margin,
		maxX: (bbox ? bbox.maxX : x + REGION_FALLBACK_W / 2) + margin,
		minY: (bbox ? bbox.minY : y - REGION_FALLBACK_H / 2) - margin,
		maxY: (bbox ? bbox.maxY : y + REGION_FALLBACK_H / 2) + margin,
	};
}

function styleMargin(style?: RegionStyle): number {
	return typeof style?.margin === 'number' && style.margin >= 0 ? style.margin : REGION_MARGIN;
}

/** 两段式对齐用的单个模块信息：放置时记录锚点与实测占位，对齐阶段删除后按网格重放。 */
function findFreeRect(obstacles: Array<PlaceBox>, w: number, h: number, spacing: number, pageWidth: number): { left: number; top: number } {
	if (!obstacles.length)
		return { left: 0, top: 0 };
	for (let row = 0; row < 500; row++) {
		const top = -row * (h + spacing);
		// 区域比页宽还宽时放不进任何列，退化为 x=0 垂直下移扫描。
		const maxCols = Math.max(1, Math.floor((pageWidth + spacing) / (w + spacing)));
		for (let col = 0; col < maxCols; col++) {
			const left = col * (w + spacing);
			const cand: PlaceBox = { minX: left - spacing, minY: top - h - spacing, maxX: left + w + spacing, maxY: top + spacing };
			if (!obstacles.some(o => overlapsBox(cand, o)))
				return { left, top };
		}
	}
	return { left: 0, top: 0 };
}

/** 模块占位几何缓存：宿主不提供 CBB 几何（lib 详情只有 uuid），首次放置实测后持久化，之后即可预计算直放。 */
export interface CachedGeometry {
	leftOverhang: number;
	topOverhang: number;
	width: number;
	height: number;
}

function geomKey(libraryUuid: string, cbbUuid: string): string {
	// v3：移除旋转/镜像参数后作废 v2 条目。
	return `geom.v3.${libraryUuid}|${cbbUuid}`;
}

function sysStoreValue(key: string, value: string): void {
	try {
		(edaGlobal()?.sys_Storage as { setExtensionUserConfig?: (k: string, v: string) => void } | undefined)?.setExtensionUserConfig?.(key, value);
	}
	catch { /* 缓存失败不阻塞放置 */ }
}

function sysLoadValue(key: string): string {
	try {
		return (edaGlobal()?.sys_Storage as { getExtensionUserConfig?: (k: string) => string } | undefined)?.getExtensionUserConfig?.(key) || '';
	}
	catch { return ''; }
}

export function cacheGeometry(libraryUuid: string, cbbUuid: string, occupied: PlaceBox, createX: number, createY: number): void {
	const geo: CachedGeometry = {
		leftOverhang: createX - occupied.minX,
		topOverhang: occupied.maxY + createY,
		width: occupied.maxX - occupied.minX,
		height: occupied.maxY - occupied.minY,
	};
	sysStoreValue(geomKey(libraryUuid, cbbUuid), JSON.stringify(geo));
	// v3 换键后顺手作废同模块的 v2 旧缓存条目（尽力而为；v1 键格式已不可考，无法定点清理）。
	sysStoreValue(`geom.v2.${libraryUuid}|${cbbUuid}`, '');
}

export function loadGeometry(libraryUuid: string, cbbUuid: string): CachedGeometry | null {
	try {
		const raw = sysLoadValue(geomKey(libraryUuid, cbbUuid));
		if (!raw)
			return null;
		const geo = JSON.parse(raw) as CachedGeometry;
		if (Number.isFinite(geo.leftOverhang) && Number.isFinite(geo.topOverhang) && geo.width > 0 && geo.height > 0)
			return geo;
	}
	catch { /* 损坏缓存视为缺失 */ }
	return null;
}

/** 首次模块的保守估计几何：锚点假设在框左下角（实测常见位置），宽/高取保守估计占位；放置后实测回写覆盖。 */
export function estimateGeometry(): CachedGeometry {
	return { leftOverhang: 0, topOverhang: EST_OCCUPIED_H, width: EST_OCCUPIED_W, height: EST_OCCUPIED_H };
}

/**
 * 放置前预测量：打开模块自带原理图页读全部图元包围盒，推算排布几何后写缓存，再切回原页。
 * 消除首批排布误差（宿主不提供 CBB 几何，此前只能保守估计）。
 * 全程只切视图不改画布；任一步失败静默降级返回 null（仍走保守估计，放置后实测回写）。
 * 注意：page 模式预测量值即精确值；symbol 模式放置后宿主折叠为符号，尺寸与整页不同，仍以放置后实测为准。
 */
export async function premeasureGeometry(libraryUuid: string, cbbUuid: string): Promise<CachedGeometry | null> {
	assertPlaceableLibrary(libraryUuid);
	// 本地模块的自带页属于磁盘工程，未在客户端打开时 openDocument 无法按 uuid 激活（与云端模块
	// 「打开图页失败」同类），预测量跳过：首放置走保守估计，放置后实测回写缓存，之后即精确。
	if (isLocalLibraryUuid(libraryUuid))
		return null;
	const origin = await getCurrentDocState();
	if (!origin.ok || !origin.uuid)
		return null;
	const cbbPageUuid = await getCbbPageUuid(cbbUuid, libraryUuid);
	// 打开模块自带页 → 等图元落盘 → 量全图元 → 必须切回原页，否则后续放置落错页。
	await activateSchematicPage(cbbPageUuid);
	try {
		await sleep(500);
		const ids = await listPagePrimitiveIdsDetailed();
		if (!ids.complete || !ids.ids.length) {
			await activateSchematicPage(origin.uuid);
			return null;
		}
		const bbox = await getIdsBBox(ids.ids);
		if (!bbox || bbox.maxX - bbox.minX <= 0 || bbox.maxY - bbox.minY <= 0) {
			await activateSchematicPage(origin.uuid);
			return null;
		}
		// 模块页内容围出"模块符号"占位：锚点按框左下角假设（与放置后实测同口径），占用含标注框边距。
		const occupied = boxWithMargin(bbox, 0, 0, REGION_MARGIN);
		const geo: CachedGeometry = {
			leftOverhang: -occupied.minX,
			topOverhang: occupied.maxY,
			width: occupied.maxX - occupied.minX,
			height: occupied.maxY - occupied.minY,
		};
		sysStoreValue(geomKey(libraryUuid, cbbUuid), JSON.stringify(geo));
		await activateSchematicPage(origin.uuid);
		return geo;
	}
	catch (e) {
		// 任何异常都要先回到原页，再放弃预测量。
		try {
			await activateSchematicPage(origin.uuid);
		}
		catch { /* 恢复失败无法补救，放置流程自会因文档状态校验中止 */ }
		void e;
		return null;
	}
}

/**
 * 预计算等大单元格网格（唯一排布路径，单个模块即 1×1 网格）：
 * 1) 行/列数 = ⌈√n⌉；2) 单元格宽/高统一取本批最大模块框；
 * 3) 行列间距固定；4) 模块框左上角对齐单元格左上角，一一填入；
 * 5) 整个区域被占用时整体位移直至无重叠（findFreeRect 按图页宽度换行扫描）。
 */
export function planAlignedPlacement(geometries: Array<CachedGeometry>, gapX: number, gapY: number, obstacles: Array<PlaceBox>, pageWidth: number): Array<{ x: number; y: number }> {
	if (!geometries.length)
		return [];
	const cols = Math.ceil(Math.sqrt(geometries.length));
	const rows = Math.ceil(geometries.length / cols);
	const cellW = Math.max(...geometries.map(g => g.width));
	const cellH = Math.max(...geometries.map(g => g.height));
	const spot = findFreeRect(obstacles, cols * cellW + (cols - 1) * gapX, rows * cellH + (rows - 1) * gapY, Math.max(gapX, gapY), pageWidth);
	return geometries.map((g, i) => ({
		x: spot.left + (i % cols) * (cellW + gapX) + g.leftOverhang,
		y: g.topOverhang - (spot.top - Math.floor(i / cols) * (cellH + gapY)),
	}));
}

export interface PagePlacementMetrics {
	obstacles: Array<PlaceBox>;
	pageWidth: number;
	pageHeight: number;
}

export const DEFAULT_PAGE_WIDTH = 1170;
const DEFAULT_PAGE_HEIGHT = 825;

/**
 * 收集当前图页已占用区域与图页尺寸。逐个组件/矩形（标注框）图元取包围盒后做簇合并：
 * 同一模块区域（标注框 + 内部组件）必须并成一个障碍，否则扫描会顺着组件缝隙
 * 把新模块塞进旧模块区域内部，形成框套框的嵌套。
 * 矩形源不可用（宿主缺 getAllPrimitiveId 等）而组件 ≥2 时，退化为整体包络一个大框——
 * 宁可绕远，不可嵌套。数量超限同样退化为全局大框。
 * 图页尺寸取自被排除的页框组件（如 A4 0,0,1170,825）；无页框时用 A4 默认值。
 */
export async function collectPageObstacles(): Promise<PagePlacementMetrics> {
	const root = edaGlobal() || {};
	const entries: Array<{ id: string; isRect: boolean }> = [];
	let rectSourceOk = false;
	let pageWidth = DEFAULT_PAGE_WIDTH;
	let pageHeight = DEFAULT_PAGE_HEIGHT;
	for (const [key, isRect] of [['sch_PrimitiveComponent', false], ['sch_PrimitiveRectangle', true]] as const) {
		const api = root[key] as { getAllPrimitiveId?: () => Promise<unknown> } | undefined;
		if (typeof api?.getAllPrimitiveId !== 'function')
			continue;
		if (isRect)
			rectSourceOk = true;
		try {
			const rows = await withTimeout(api.getAllPrimitiveId(), 10000, '读取图元列表超时');
			for (const id of Array.isArray(rows) ? rows : []) {
				if (typeof id === 'string' && id)
					entries.push({ id, isRect });
			}
		}
		catch { /* 单类失败忽略 */ }
	}
	if (!entries.length)
		return { obstacles: [], pageWidth, pageHeight };
	if (entries.length > 120) {
		const all = await getIdsBBox(entries.map(e => e.id));
		return { obstacles: all ? [all] : [], pageWidth, pageHeight };
	}
	const sch = edaGlobal() as { sch_Primitive?: { getPrimitivesBBox?: (ids: Array<string>) => Promise<BBox | undefined> } };
	const bboxFn = sch.sch_Primitive?.getPrimitivesBBox;
	if (typeof bboxFn !== 'function')
		return { obstacles: [], pageWidth, pageHeight };
	const boxes: Array<{ box: PlaceBox; isRect: boolean }> = [];
	for (const entry of entries) {
		try {
			const got = await withTimeout(bboxFn.call(sch.sch_Primitive, [entry.id]), 8000, '读取图元范围超时');
			if (!got || !Number.isFinite(got.minX) || !Number.isFinite(got.maxX))
				continue;
			// 页框/标题栏类背景组件：图页大小的框（如 A4 0,0,1170,825）不算障碍。
			// 它覆盖全页，会把所有落点判成占用，扫描退化或把模块挤到页面外。
			// 其尺寸即图页边界，记录下来供排布扫描换行使用。
			if (!entry.isRect && got.minX <= 20 && got.minY >= -20
				&& got.maxX - got.minX >= 900 && got.maxY - got.minY >= 600) {
				pageWidth = Math.round(got.maxX - got.minX);
				pageHeight = Math.round(got.maxY - got.minY);
				continue;
			}
			// 组件本体可能不含引脚，外扩一点；矩形本身就是标注框，不外扩。
			const pad = entry.isRect ? 0 : 20;
			boxes.push({
				box: { minX: got.minX - pad, minY: got.minY - pad, maxX: got.maxX + pad, maxY: got.maxY + pad },
				isRect: entry.isRect,
			});
		}
		catch { /* 单个失败跳过 */ }
	}
	if (!boxes.length)
		return { obstacles: [], pageWidth, pageHeight };
	const compCount = boxes.filter(b => !b.isRect).length;
	const rectCount = boxes.filter(b => b.isRect).length;
	const rects = boxes.map(b => b.box);
	// 标注框一个都没收到时，区域边界不可知——用整体包络防止落进旧模块内部。
	if (!rectSourceOk || (rectCount === 0 && compCount >= 2)) {
		const hull = rects.reduce((acc, b) => ({
			minX: Math.min(acc.minX, b.minX),
			minY: Math.min(acc.minY, b.minY),
			maxX: Math.max(acc.maxX, b.maxX),
			maxY: Math.max(acc.maxY, b.maxY),
		}));
		return { obstacles: [hull], pageWidth, pageHeight };
	}
	return { obstacles: mergeObstacleClusters(rects), pageWidth, pageHeight };
}

/** 簇合并：外扩 CLUSTER_PAD 判定连通，取并集后再缩回，得到各模块区域的紧凑包络。 */
function mergeObstacleClusters(boxes: Array<PlaceBox>): Array<PlaceBox> {
	const pad = 60;
	const pending = boxes.map(b => ({ minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }));
	const mergeOnce = (a: PlaceBox, b: PlaceBox): PlaceBox | null => {
		if (!overlapsBox(a, b))
			return null;
		return {
			minX: Math.min(a.minX, b.minX),
			minY: Math.min(a.minY, b.minY),
			maxX: Math.max(a.maxX, b.maxX),
			maxY: Math.max(a.maxY, b.maxY),
		};
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < pending.length && !changed; i++) {
			for (let j = i + 1; j < pending.length; j++) {
				const u = mergeOnce(pending[i], pending[j]);
				if (u) {
					pending.splice(j, 1);
					pending.splice(i, 1);
					pending.push(u);
					changed = true;
					break;
				}
			}
		}
	}
	return pending.map(b => ({ minX: b.minX + pad, minY: b.minY + pad, maxX: b.maxX - pad, maxY: b.maxY - pad }));
}

function overlapsBox(a: PlaceBox, b: PlaceBox): boolean {
	return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/** ESCH_PrimitiveTextAlignMode.CENTER：文本以给定坐标水平垂直居中。 */
const TEXT_ALIGN_CENTER = 5;
/** 标题固定样式（业务拍板 2026-09-11，不暴露）：红色 · 0.2 英寸 · 不加粗 · 居中锚点。 */
const TITLE_COLOR = '#FF0000';
/** 字号单位 = 0.01 英寸（实测 fontSize 20 → 渲染高 20 单位 = 0.2 英寸）。 */
const TITLE_FONT_SIZE = 20;

const PAGE_PRIMITIVE_GETTERS = [
	'sch_PrimitiveComponent',
	'sch_PrimitiveWire',
	'sch_PrimitiveBus',
	'sch_PrimitiveText',
	'sch_PrimitiveRectangle',
	'sch_PrimitivePolygon',
	'sch_PrimitiveCircle',
	'sch_PrimitiveArc',
	'sch_PrimitiveObject',
	'sch_PrimitivePin',
] as const;

/** 区域框可调样式（确认卡暴露；null/缺省 = 宿主默认）。标题样式固定不暴露。 */
export interface RegionStyle {
	/** 框颜色，#RRGGBB；缺省宿主默认。 */
	borderColor?: string | null;
	/** 框线宽（原理图线宽单位）；缺省宿主默认。 */
	borderWidth?: number | null;
	/** 包围盒外扩边距（0.01 英寸），默认 40。 */
	margin?: number;
}

function normalizeHex(v: unknown): string | null {
	return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null;
}

interface BBox { minX: number; minY: number; maxX: number; maxY: number }

function unionBBox(a: BBox | null, b: BBox | null): BBox | null {
	if (!a)
		return b;
	if (!b)
		return a;
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY),
	};
}

async function getIdsBBox(ids: Array<string>): Promise<BBox | null> {
	if (!ids.length)
		return null;
	const sch = edaGlobal() as { sch_Primitive?: { getPrimitivesBBox?: (ids: Array<string>) => Promise<BBox | undefined> } };
	const fn = sch.sch_Primitive?.getPrimitivesBBox;
	if (typeof fn !== 'function')
		return null;
	try {
		const got = await withTimeout(fn.call(sch.sch_Primitive, ids), 10000, '读取图元范围超时');
		if (got && Number.isFinite(got.minX) && Number.isFinite(got.maxY))
			return got;
	}
	catch { /* 回退固定框 */ }
	return null;
}

interface PagePrimitiveSnapshot {
	ids: Array<string>;
	/** 所有图元类别都读取成功才为 true；任一类别超时/失败即为 false。 */
	complete: boolean;
}

async function listPagePrimitiveIdsDetailed(): Promise<PagePrimitiveSnapshot> {
	const root = edaGlobal() || {};
	const ids: Array<string> = [];
	const seen = new Set<string>();
	let complete = true;
	for (const key of PAGE_PRIMITIVE_GETTERS) {
		const api = root[key] as { getAllPrimitiveId?: (...args: Array<unknown>) => Promise<unknown> } | undefined;
		if (typeof api?.getAllPrimitiveId !== 'function')
			continue;
		try {
			const rows = await withTimeout(api.getAllPrimitiveId(), 10000, '读取图元列表超时');
			const arr = Array.isArray(rows) ? rows : [];
			for (const id of arr) {
				if (typeof id === 'string' && id && !seen.has(id)) {
					seen.add(id);
					ids.push(id);
				}
			}
		}
		catch { /* 任一类失败都会让差集失真，标记不可信 */ complete = false; }
	}
	return { ids, complete };
}

async function getSymbolBBox(primitiveId: string): Promise<BBox | null> {
	const sch = edaGlobal() as {
		sch_Primitive?: { getPrimitivesBBox?: (ids: Array<string>) => Promise<BBox | undefined> };
		sch_PrimitiveComponent?: { getAllPinsByPrimitiveId?: (primitiveId: string) => Promise<unknown> };
	};
	let body: BBox | null = null;
	try {
		const fn = sch.sch_Primitive?.getPrimitivesBBox;
		if (typeof fn === 'function') {
			const got = await withTimeout(fn.call(sch.sch_Primitive, [primitiveId]), 10000, '读取符号范围超时');
			if (got && Number.isFinite(got.minX) && Number.isFinite(got.maxY))
				body = got;
		}
	}
	catch { body = null; }
	let pins: BBox | null = null;
	try {
		const fn = sch.sch_PrimitiveComponent?.getAllPinsByPrimitiveId;
		if (typeof fn === 'function') {
			const rows = await withTimeout(fn.call(sch.sch_PrimitiveComponent, primitiveId), 10000, '读取模块引脚超时');
			const arr = Array.isArray(rows) ? rows : ((rows as { pins?: unknown[] })?.pins ?? []);
			const xs: Array<number> = [];
			const ys: Array<number> = [];
			for (const p of arr as Array<Record<string, unknown>>) {
				if (typeof p?.x === 'number')
					xs.push(p.x);
				if (typeof p?.y === 'number')
					ys.push(p.y);
			}
			if (xs.length && ys.length)
				pins = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
		}
	}
	catch { pins = null; }
	return unionBBox(body, pins);
}

async function drawAnnotation(box: PlaceBox, title: string, style?: RegionStyle): Promise<void> {
	const { minX, maxX, minY, maxY } = box;

	const sch = edaGlobal() as {
		sch_PrimitiveRectangle?: { create?: (topLeftX: number, topLeftY: number, width: number, height: number, cornerRadius?: number, rotation?: number, color?: string | null, fillColor?: string | null, lineWidth?: number | null, lineType?: unknown, fillStyle?: unknown) => Promise<unknown> };
		sch_PrimitiveText?: { create?: (x: number, y: number, content: string, rotation?: number, textColor?: string | null, fontName?: string | null, fontSize?: number | null, bold?: boolean, italic?: boolean, underLine?: boolean, alignMode?: number) => Promise<unknown> };
	};
	const rectCreate = sch.sch_PrimitiveRectangle?.create;
	if (typeof rectCreate !== 'function')
		throw new Error('sch_PrimitiveRectangle.create 不可用，无法绘制标注框（模块已放置，可手动补框）');
	const rectFailed = (): Error => new Error('标注框绘制未成功（模块已放置，可手动补框）');
	const label = title.trim();
	try {
		const rect = await withTimeout(
			rectCreate.call(
				sch.sch_PrimitiveRectangle,
				minX,
				maxY,
				maxX - minX,
				maxY - minY,
				0,
				0,
				normalizeHex(style?.borderColor),
				null,
				typeof style?.borderWidth === 'number' && style.borderWidth > 0 ? style.borderWidth : null,
			),
			15000,
			'标注框绘制超时',
		);
		if (!rect)
			throw rectFailed();
		if (label) {
			const textCreate = sch.sch_PrimitiveText?.create;
			if (typeof textCreate === 'function') {
				await withTimeout(
					textCreate.call(
						sch.sch_PrimitiveText,
						(minX + maxX) / 2,
						maxY - 12,
						label,
						0,
						TITLE_COLOR,
						null,
						TITLE_FONT_SIZE,
						false,
						false,
						false,
						TEXT_ALIGN_CENTER,
					),
					15000,
					'标注标题绘制超时',
				);
			}
		}
	}
	catch (e) {
		if (e instanceof Error && /不可用|未成功|超时/.test(e.message))
			throw e;
		throw rectFailed();
	}
}

/**
 * 云端模块：lib_Cbb.get().boards[].schematic；本地模块 get() 必崩（不在此路径，见 resolveCbbPageUuid）。
 */
async function getCbbPageUuid(cbbUuid: string, libraryUuid: string): Promise<string> {
	assertPlaceableLibrary(libraryUuid);
	const cbbApi = edaGlobal()?.lib_Cbb as
		| { get?: (cbbUuid: string, libraryUuid?: string) => Promise<Record<string, unknown> | undefined> }
		| undefined;
	const get = cbbApi?.get;
	if (typeof get !== 'function')
		throw new Error('lib_Cbb.get 不可用（宿主版本过低或不支持）');
	let detail: Record<string, unknown> | undefined;
	try {
		detail = await withTimeout(get.call(cbbApi, cbbUuid, libraryUuid), 15000, '获取模块详情超时');
	}
	catch (e) {
		const msg = fmtErr(e);
		if (msg.includes('parent_tag'))
			throw new Error('获取模块详情失败（宿主 get 接口缺陷），无法按图页放置，请改用符号方式。');
		throw new Error(`获取模块详情失败：${msg}`);
	}
	const boards = Array.isArray(detail?.boards) ? detail.boards as Array<Record<string, unknown>> : [];
	for (const board of boards) {
		const schUuid = typeof board?.schematic === 'string' ? board.schematic : '';
		if (schUuid)
			return schUuid;
	}
	throw new Error('该模块没有原理图内容，无法按复用模块图页放置。');
}

/**
 * 统一解析模块自带原理图页 uuid（图页放置入口）：云端库走 lib_Cbb.get().boards[].schematic；
 * 本地库 get() 必崩（2026-09-16 半离线实测 TypeError: parent_tag），改走 readLocalSheetUuid 的
 * .eprj2 明文工程树解析——同日实测 placeCbbSchematicPage 用解析 uuid 放置返回 true（2.2s，器件可读）。
 */
async function resolveCbbPageUuid(libraryUuid: string, cbbUuid: string, moduleName: string): Promise<string> {
	if (isLocalLibraryUuid(libraryUuid)) {
		if (!moduleName.trim())
			throw new Error('本地库模块图页放置缺少模块名，无法定位 .eprj2 工程文件');
		return readLocalSheetUuid(libraryUuid, cbbUuid, moduleName);
	}
	return getCbbPageUuid(cbbUuid, libraryUuid);
}

export async function placeCbbPage(params: { libraryUuid: string; cbbUuid: string; x: number; y: number; moduleName?: string }): Promise<{ cbbPageUuid: string }> {
	const state = await getCurrentDocState();
	if (!state.ok)
		throw new Error('当前活动文档不是原理图页，无法放置。请切换到原理图页后重试。');
	const cbbPageUuid = await resolveCbbPageUuid(params.libraryUuid, params.cbbUuid, params.moduleName || '');
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { placeCbbSchematicPage?: (cbbSchematicPage: { libraryUuid: string; cbbUuid: string; uuid: string }, x: number, y: number) => Promise<boolean> }
		| undefined;
	const place = comp?.placeCbbSchematicPage;
	if (typeof place !== 'function')
		throw new Error('placeCbbSchematicPage 不可用（宿主版本过低或不支持）');
	const ok = await withTimeout(
		place.call(comp, { libraryUuid: params.libraryUuid, cbbUuid: params.cbbUuid, uuid: cbbPageUuid }, params.x, params.y),
		PLACE_TIMEOUT_MS,
		'图页放置超时（30s）——请重试',
	);
	if (ok !== true)
		throw new Error('复用模块图页放置未成功（接口返回 false）');
	return { cbbPageUuid };
}

/**
 * 按形式 × 位置放置，并始终用矩形框 + 模块名标题标注。
 * 落点 x/y 由唯一排布路径 planAlignedPlacement 预先算好传入（单个模块 = 1×1 网格），
 * 本函数只负责建页/切页 → 落内容 → 实测占位 → 画标注。
 * target=new 新建图页；board 在当前工程新建板子+原理图；project 新建工程后放置。
 */
export async function placeCbbModule(params: PlaceParams & {
	mode: PlaceMode;
	target: PlaceTarget;
	/** 排布器算好的放置锚点（0.01 英寸），缓存回写用它。 */
	anchor: { x: number; y: number };
	title?: string;
	/** 目录中的模块显示名：本地库图页放置按它定位 .eprj2 工程文件（title 可被用户改，不混用）。 */
	moduleName?: string;
	style?: RegionStyle;
}): Promise<PlaceModuleResult> {
	let page: { pageUuid: string; pageName: string };
	if (params.target === 'project')
		page = await openNewProjectThenPlacePage(params.title || '复用模块');
	else if (params.target === 'board')
		page = await openNewBoardAndSchematic();
	else if (params.target === 'new')
		page = await openNewSchematicPage();
	else
		page = await getCurrentPageMeta();
	const anchor = params.anchor;
	let primitiveId = '';
	let designator = '';
	let mode = params.mode;
	let fallbackFromSymbol = false;
	// 空符号自动回退：模块未生成符号时改放图页（同一落点，用户无感，结果里给出说明）。
	if (mode === 'symbol') {
		try {
			const placed = await placeCbbSymbol({ ...params, x: anchor.x, y: anchor.y });
			primitiveId = placed.primitiveId;
			designator = placed.designator;
		}
		catch (e) {
			if (!(e instanceof EmptySymbolError))
				throw e;
			mode = 'page';
			fallbackFromSymbol = true;
		}
	}
	let pageBefore: Awaited<ReturnType<typeof listPagePrimitiveIdsDetailed>> | null = null;
	if (mode === 'page') {
		pageBefore = await listPagePrimitiveIdsDetailed();
		await placeCbbPage({ libraryUuid: params.libraryUuid, cbbUuid: params.cbbUuid, x: anchor.x, y: anchor.y, moduleName: params.moduleName });
		primitiveId = '';
		designator = '';
	}
	let bbox: BBox | null = null;
	if (mode === 'symbol' && primitiveId) {
		bbox = await getSymbolBBox(primitiveId);
	}
	else {
		// 等内容图元全部落盘再取差集；快照任一次不完整就放弃差集，
		// 宁可画保守的小框，也不把旧图元算进新模块导致标注框套住整页内容。
		await sleep(300);
		const after = await listPagePrimitiveIdsDetailed();
		if (pageBefore && pageBefore.complete && after.complete && after.ids.length >= pageBefore.ids.length) {
			const beforeSet = new Set(pageBefore.ids);
			bbox = await getIdsBBox(after.ids.filter(id => !beforeSet.has(id)));
		}
	}
	const occupied = boxWithMargin(bbox, anchor.x, anchor.y, styleMargin(params.style));
	await drawAnnotation(occupied, params.title || '', params.style);
	return { primitiveId: primitiveId || undefined, designator: designator || undefined, pageUuid: page.pageUuid, pageName: page.pageName, occupied, anchor: { x: anchor.x, y: anchor.y }, mode, fallbackFromSymbol: fallbackFromSymbol || undefined };
}

export async function modifyCbbModule(params: ModifyCbbParams): Promise<void> {
	if (!params.cbbUuid || !params.libraryUuid)
		throw new Error('缺少模块或库标识');
	if (!params.name.trim())
		throw new Error('模块名称不能为空');
	assertPlaceableLibrary(params.libraryUuid);
	const cbbApi = edaGlobal()?.lib_Cbb as
		| { modify?: (cbbUuid: string, libraryUuid: string, cbbName?: string, classification?: unknown, description?: string | null) => Promise<boolean> }
		| undefined;
	const modify = cbbApi?.modify;
	if (typeof modify !== 'function')
		throw new Error('lib_Cbb.modify 不可用（宿主版本过低或不支持）');
	let ok: boolean;
	try {
		ok = await withTimeout(
			modify.call(cbbApi, params.cbbUuid, params.libraryUuid, params.name.trim(), undefined, params.description),
			MODIFY_TIMEOUT_MS,
			'修改超时（20s）——请重试',
		);
	}
	catch (e) {
		throw new Error(fmtErr(e));
	}
	if (ok !== true)
		throw new Error('修改未成功（接口返回 false），请稍后重试');
}

/** 摘要里的单行器件：位号 d / 画布名 n / 库器件名 dev / 封装名 fp。 */
export interface CbbSummaryComponent {
	d?: string;
	n?: string;
	dev?: string;
	fp?: string;
}

/** 模块自带原理图页的内容摘要，供 LLM 自动分析出模块名称与描述。 */
export interface CbbSchematicSummary {
	pageUuid: string;
	/** 器件总数（含未列入 components 明细的超额部分）。 */
	deviceCount: number;
	components: Array<CbbSummaryComponent>;
	/** 网络标志 / 网络端口 / 离图连接器的网络名（去重），反映电源域与对外接口信号。 */
	nets: Array<string>;
	/** 页面文字标注（含模块标题、说明文字）。 */
	texts: Array<string>;
}

const SUMMARY_MAX_COMPONENTS = 80;
const SUMMARY_MAX_NETS = 60;
const SUMMARY_MAX_TEXTS = 30;
const SUMMARY_MAX_TEXT_LEN = 120;
const SUMMARY_READ_TIMEOUT_MS = 15000;
/** ESCH_PrimitiveComponentType（字符串枚举）：普通器件。 */
const SCH_COMP_PART = 'part';
/** 反映对外连接的组件类型：网络标志 / 网络端口 / 离图连接器。 */
const SCH_COMP_NET_TYPES = new Set(['netflag', 'netport', 'offPageConnector']);

/** 读取结束后恢复打开前的活动文档。模块页属于模块工程，必须切回，否则后续放置会落错页。 */
async function restoreOriginDocument(origin: DocState): Promise<void> {
	if (!origin.uuid || origin.documentType == null)
		return;
	if (origin.documentType === DOC_SCHEMATIC_PAGE) {
		if ((await getCurrentDocState()).uuid === origin.uuid)
			return;
		await activateSchematicPage(origin.uuid);
		return;
	}
	const editor = edaGlobal()?.dmt_EditorControl as
		| { openDocument?: (documentUuid: string) => Promise<string | undefined> }
		| undefined;
	if (typeof editor?.openDocument !== 'function')
		return;
	await withTimeout(editor.openDocument(origin.uuid), 15000, '切回原文档超时');
}

/**
 * 读取模块自带原理图页内容（只读）：打开模块页 → 读器件/网络/文字 → 切回原文档。
 * 与 premeasureGeometry 同一安全模式。
 * 三源统一入口：
 * - 云端模块（个人库/团队库）：激活 lib_Cbb.get().boards[].schematic 自带页后读取，无残留。
 * - 本地库模块：宿主 lib_Cbb.get 对本地模块未实现（必崩），且 .eprj2 内容加密无法离线解析——
 *   走放置读取路径：placeCbbSchematicPage 会新建一个专属板子承载模块内容（并非放入活动页），
 *   读摘要后删除新板子的全部图页——宿主在末页删除后自动移除空板（实测 2026-09-16，21 个残留板清零）。
 *   已知无法消除的副作用：每次放置仍会向工程库写入一个 CBB 副本（与正常放置相同，宿主行为）。
 */
export async function readCbbSchematicSummary(libraryUuid: string, cbbUuid: string, moduleName = ''): Promise<CbbSchematicSummary> {
	const origin = await getCurrentDocState();
	if (isLocalLibraryUuid(libraryUuid)) {
		const boardsBefore = await listBoardUuids();
		const pageUuid = await placeOnTempPageForRead(libraryUuid, cbbUuid, moduleName);
		try {
			return await readActivePageSummary(pageUuid);
		}
		finally {
			// 清理放置新产生的板子（删其全部图页，宿主自动移除空板）后切回原文档；
			// 切回失败若读取成功不算硬错误。
			await deleteBoardsCreatedAfter(boardsBefore);
			await restoreOriginDocument(origin);
		}
	}
	assertPlaceableLibrary(libraryUuid);
	const pageUuid = await getCbbPageUuid(cbbUuid, libraryUuid);
	await activateSchematicPage(pageUuid);
	try {
		return await readActivePageSummary(pageUuid);
	}
	finally {
		await restoreOriginDocument(origin);
	}
}

/** 本地库路径特征：resolveLibraries 的 local 候选是磁盘路径（盘符/UNC），云端库 uuid 是十六进制串。 */
function isLocalLibraryUuid(libraryUuid: string): boolean {
	return /^[a-z]:[\\/]/i.test(libraryUuid) || libraryUuid.startsWith('\\\\');
}

/** 记录当前工程全部板子 uuid（放置前快照用）。 */
async function listBoardUuids(): Promise<Set<string>> {
	const b = edaGlobal()?.dmt_Board as
		| { getAllBoardsInfo?: () => Promise<Array<Record<string, unknown>>> }
		| undefined;
	if (typeof b?.getAllBoardsInfo !== 'function')
		return new Set();
	try {
		const rows = (await b.getAllBoardsInfo()) || [];
		return new Set(rows.map(r => String(r.uuid)).filter(u => u));
	}
	catch {
		return new Set();
	}
}

/**
 * 删除放置新产生的板子：对每个新板子删除其全部图页——宿主在末页删除后自动移除空板（实测 2026-09-16，
 * 21 个残留板清到 0）。deleteBoard 本身在此宿主版本为 no-op（恒返回 false），不能直接用。
 * 返回成功清理的板子数。
 */
async function deleteBoardsCreatedAfter(before: Set<string>): Promise<number> {
	const b = edaGlobal()?.dmt_Board as
		| { getAllBoardsInfo?: () => Promise<Array<Record<string, unknown>>> }
		| undefined;
	const sch = edaGlobal()?.dmt_Schematic as
		| { deleteSchematicPage?: (pageUuid: string) => Promise<boolean> }
		| undefined;
	if (typeof b?.getAllBoardsInfo !== 'function' || typeof sch?.deleteSchematicPage !== 'function')
		return 0;
	const rows = (await b.getAllBoardsInfo()) || [];
	const newBoards = rows.filter(r => !before.has(String(r.uuid)));
	let cleaned = 0;
	for (const nb of newBoards) {
		const schematic: unknown = nb.schematic;
		const pages = schematic && typeof schematic === 'object' && Array.isArray((schematic as { page?: unknown }).page)
			? ((schematic as { page: Array<{ uuid?: unknown }> }).page).map(p => String(p.uuid ?? '')).filter(u => u)
			: [];
		let allDeleted = true;
		for (const pUuid of pages) {
			try {
				const r = await withTimeout(sch.deleteSchematicPage(pUuid), 10000, '删除图页超时');
				if (r !== true)
					allDeleted = false;
			}
			catch {
				allDeleted = false;
			}
		}
		if (allDeleted)
			cleaned++;
	}
	return cleaned;
}

/**
 * 本地库读取：.eprj2 明文工程树解析 sheet uuid → placeCbbSchematicPage 放置（宿主新建专属板子承载
 * 模块内容并自动激活其页，并非放入活动页）→ 返回激活的页 uuid。调用方读取后清理新板子（删其全部
 * 图页，宿主自动移除空板）。半离线模式实测（2026-09-15/16）：放置返回 true，器件可读，删页后零残留。
 */
async function placeOnTempPageForRead(libraryUuid: string, cbbUuid: string, moduleName: string): Promise<string> {
	const sheetUuid = await readLocalSheetUuid(libraryUuid, cbbUuid, moduleName);
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { placeCbbSchematicPage?: (args: { libraryUuid: string; cbbUuid: string; uuid: string }, x: number, y: number) => Promise<boolean> }
		| undefined;
	const place = comp?.placeCbbSchematicPage;
	if (typeof place !== 'function')
		throw new Error('placeCbbSchematicPage 不可用（宿主版本过低或不支持）');
	const ok = await withTimeout(
		place.call(comp, { libraryUuid, cbbUuid, uuid: sheetUuid }, 0, 0),
		PLACE_TIMEOUT_MS,
		'临时页放置模块超时（30s）',
	);
	if (ok !== true)
		throw new Error('临时页放置模块未成功（接口返回 false）');
	const doc = await getCurrentDocState();
	if (!doc.uuid)
		throw new Error('放置后未获取到激活的图页');
	return doc.uuid;
}

/** 从 .eprj2 明文工程树解析首个 schematic uuid（SQLite 行数据以 JSON 明文存储，无需 SQLite 库）。 */
async function readLocalSheetUuid(libraryUuid: string, cbbUuid: string, moduleName: string): Promise<string> {
	const fsApi = edaGlobal()?.sys_FileSystem as
		| {
			readFileFromFileSystem?: (path: string) => Promise<Blob | undefined>;
			listFilesOfFileSystem?: (path: string) => Promise<Array<{ name?: string; isDirectory?: boolean; fullPath?: string }>>;
		}
		| undefined;
	if (typeof fsApi?.readFileFromFileSystem !== 'function' || typeof fsApi?.listFilesOfFileSystem !== 'function')
		throw new Error('sys_FileSystem 文件读取接口不可用');
	// 文件定位统一走 catalog.matchLocalEprjRow：文件名主干 = 模块名（原生/导入通用），全项目唯一实现。
	const rows = ((await fsApi.listFilesOfFileSystem(libraryUuid)) || [])
		.filter(r => !r.isDirectory && /\.eprj2$/i.test(String(r.name || '')));
	const target = matchLocalEprjRow(rows, moduleName);
	if (!target)
		throw new Error(`本地库目录中未找到模块对应的工程文件（${moduleName}.eprj2）`);
	const filePath = target.fullPath || `${libraryUuid.replace(/[\\/]+$/, '')}/${target.name}`;
	const blob = await fsApi.readFileFromFileSystem(filePath);
	if (!blob)
		throw new Error('读取模块工程文件失败');
	const latin = new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));
	const start = latin.indexOf('{"boards"');
	if (start < 0)
		throw new Error('模块工程文件中未找到工程树（可能为空基座或格式变更）');
	let depth = 0;
	let inStr = false;
	let esc = false;
	let end = -1;
	for (let i = start; i < latin.length; i++) {
		const c = latin[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (c === '\\') {
			esc = true;
			continue;
		}
		if (c === '"') {
			inStr = !inStr;
			continue;
		}
		if (inStr)
			continue;
		if (c === '{')
			depth++;
		if (c === '}' && depth > 0) {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end < 0)
		throw new Error('模块工程树 JSON 解析失败');
	const tree = JSON.parse(latin.slice(start, end + 1)) as { schematics?: Record<string, { uuid?: string }> };
	const sheetUuid = Object.values(tree.schematics || {})[0]?.uuid;
	if (!sheetUuid)
		throw new Error('模块工程树中没有原理图（空模块基座）');
	return sheetUuid;
}

/** 在当前活动页读取器件/网络/文字摘要（调用方负责已切换到目标页并善后）。 */
async function readActivePageSummary(pageUuid: string): Promise<CbbSchematicSummary> {
	let summary: CbbSchematicSummary | null = null;
	let readError: unknown = null;
	try {
		const root = edaGlobal() || {};
		const compApi = root.sch_PrimitiveComponent as
			| { getAll?: (...args: Array<unknown>) => Promise<Array<Record<string, unknown>>> }
			| undefined;
		const textApi = root.sch_PrimitiveText as
			| { getAllPrimitiveId?: () => Promise<Array<string>> }
			| undefined;
		const primApi = root.sch_Primitive as
			| { getPrimitivesByPrimitiveId?: (ids: Array<string>) => Promise<Array<Record<string, unknown>>> }
			| undefined;
		if (typeof compApi?.getAll !== 'function')
			throw new Error('sch_PrimitiveComponent.getAll 不可用（宿主版本过低或不支持）');
		const comps = (await withTimeout(compApi.getAll(), SUMMARY_READ_TIMEOUT_MS, '读取模块器件列表超时')) || [];
		const components: Array<CbbSummaryComponent> = [];
		const netSet = new Set<string>();
		let deviceCount = 0;
		for (const c of Array.isArray(comps) ? comps : []) {
			const type = typeof c.getState_ComponentType === 'function' ? String(c.getState_ComponentType()) : '';
			if (type === SCH_COMP_PART) {
				deviceCount++;
				if (components.length >= SUMMARY_MAX_COMPONENTS)
					continue;
				const row: CbbSummaryComponent = {};
				if (typeof c.getState_Designator === 'function') {
					const d = c.getState_Designator();
					if (d)
						row.d = String(d);
				}
				if (typeof c.getState_Name === 'function') {
					const n = c.getState_Name();
					if (n)
						row.n = String(n);
				}
				if (typeof c.getState_Component === 'function') {
					const dev = c.getState_Component() as { name?: unknown } | undefined;
					if (dev && typeof dev.name === 'string' && dev.name)
						row.dev = dev.name;
				}
				if (typeof c.getState_Footprint === 'function') {
					const fp = c.getState_Footprint() as { name?: unknown } | undefined;
					if (fp && typeof fp.name === 'string' && fp.name)
						row.fp = fp.name;
				}
				components.push(row);
			}
			else if (SCH_COMP_NET_TYPES.has(type) && typeof c.getState_Net === 'function') {
				const net = c.getState_Net();
				if (net && netSet.size < SUMMARY_MAX_NETS)
					netSet.add(String(net));
			}
		}
		const texts: Array<string> = [];
		if (typeof textApi?.getAllPrimitiveId === 'function' && typeof primApi?.getPrimitivesByPrimitiveId === 'function') {
			try {
				const ids = (await withTimeout(textApi.getAllPrimitiveId(), SUMMARY_READ_TIMEOUT_MS, '读取模块文字列表超时')) || [];
				if (ids.length) {
					const objs = (await withTimeout(
						primApi.getPrimitivesByPrimitiveId(ids.slice(0, 100)),
						SUMMARY_READ_TIMEOUT_MS,
						'读取模块文字内容超时',
					)) || [];
					for (const t of Array.isArray(objs) ? objs : []) {
						if (typeof t.getState_Content !== 'function' || texts.length >= SUMMARY_MAX_TEXTS)
							continue;
						const content = String(t.getState_Content() || '').trim();
						if (content)
							texts.push(content.slice(0, SUMMARY_MAX_TEXT_LEN));
					}
				}
			}
			catch { /* 文字标注读取失败不阻塞摘要，器件+网络已够分析 */ }
		}
		summary = { pageUuid, deviceCount, components, nets: [...netSet], texts };
	}
	catch (e) {
		readError = e;
	}
	if (readError !== null)
		throw readError;
	return summary!;
}

/**
 * 对复用模块的读与写操作：读模块原理图摘要（AI 分析用）、符号放置、图页放置、改名称/描述、
 * 从画布选中内容创建新模块。
 * 写画布/写库前由 agent 确认卡令牌把关；读模块页只切视图不改画布。
 *
 * 放置两轴（不再有第三种「区域」形式）：
 * - 形式 mode：复用模块符号 / 复用模块图页；两种都画矩形框 + 模块名标题
 * - 位置 target：当前图页 / 新建图页 / 新建板子（含原理图） / 新建工程
 *
 * 实测：createCbbSymbol 可省略符号 uuid；假 uuid 会挂起 ≥8s，必须超时；
 * placeCbbSchematicPage 把模块原理图内容落到当前活动图页（不会自己建页）；
 * 每次放置有双重副作用（背板原理图 + 工程库副本）。
 * 本地图页放置（2026-09-16 半离线 V3.2.166 实测）：lib_Cbb.get 对本地模块必崩（parent_tag），
 * 图页 uuid 改由 .eprj2 明文工程树解析（resolveCbbPageUuid → readLocalSheetUuid），放置返回 true。
 *
 * lib_Cbb.create 的版本差异（2026-10-14 更正）：V3.2.166 上静默返回 undefined（当年据此
 * 判定「不可用」，见 SPEC §F1）；**V4.1.71 上已修复**——返回新模块 uuid，且新建模块自带
 * board（含 schematic + pcb）。createCbbModuleFromSelection 依赖后者，失败时给出明确版本提示。
 */
import { matchLocalEprjRow } from './catalog';
import { edaGlobal, fmtErr, sleep, withTimeout } from './host';

const PLACE_TIMEOUT_MS = 30000;
const MODIFY_TIMEOUT_MS = 20000;
/** 切页后等待激活的预算：openDocument 返回后画布激活仍可能滞后，从 8s 放宽到 15s。 */
const PAGE_SWITCH_TIMEOUT_MS = 15000;
/** 预测量打开模块自带页的等待预算：打不开要快速降级，不占全额切页预算。 */
const PREMEASURE_OPEN_WAIT_MS = 8000;
/** 新建板子后其原理图页同步进板信息的等待预算（实测 2026-09-30 可超 12s 才出现）。 */
const BOARD_PAGE_WAIT_MS = 30000;
/** 新建板子后板子行本身出现在 getAllBoardsInfo 的等待预算（板行比图页同步快，失败时不必干等满额切页预算）。 */
const BOARD_APPEAR_WAIT_MS = 10000;
const SAVE_TIMEOUT_MS = 20000;
/** lib_Cbb.create：建空壳模块并拿到 cbbUuid。 */
const CREATE_TIMEOUT_MS = 30000;
/** lib_Cbb.openProjectInEditor / dmt_Project.openProject：切工程。 */
const OPEN_MODULE_TIMEOUT_MS = 30000;
/** lib_Device.search：按元件名回库找器件对象（重建元件用）。 */
const DEVICE_LOOKUP_TIMEOUT_MS = 10000;
/** 单个图元重建（component/wire/flag/port create）。 */
const REBUILD_ONE_TIMEOUT_MS = 15000;
/** 选区规模上限：超限直接拒绝，避免一次重建耗时过长。 */
const MAX_CREATE_PARTS = 300;
const MAX_CREATE_WIRES = 1000;
/** 选中集超出此数时不在卡上逐个列位号，只给计数。 */
export const SELECTION_DESIGNATOR_LIMIT = 20;
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

/**
 * 打开并激活目标原理图页。成败只看激活状态，不看 openDocument 的返回值——宿主实测（2026-09-30）
 * 该接口打开成功时也恒返回 undefined，旧实现按返回值判失败，导致每次切页都误报「打开图页失败」
 * （inspect_module 读取、新建图页/板子放置、切回原文档全数中招，是普遍性而非个别模块问题）。
 * waitMs 仅限「目标可能根本无法激活」的调用方（如预测量打开库侧自带页）收紧等待预算用。
 */
export async function activateSchematicPage(pageUuid: string, waitMs = PAGE_SWITCH_TIMEOUT_MS): Promise<void> {
	const editor = edaGlobal()?.dmt_EditorControl as
		| { openDocument?: (documentUuid: string) => Promise<string | undefined> }
		| undefined;
	if (typeof editor?.openDocument !== 'function')
		throw new Error('dmt_EditorControl.openDocument 不可用，无法切换图页');
	await withTimeout(editor.openDocument(pageUuid), 15000, '打开图页超时');
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const state = await getCurrentDocState();
		if (state.ok && state.uuid === pageUuid)
			return;
		await sleep(200);
	}
	throw new Error('打开图页失败：目标图页未能激活（图页不存在或不属于当前工程时会发生），请手动打开后重试');
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

/**
 * 打开新建板子的原理图页。图页同步进板信息可能明显滞后（实测 2026-09-30：createBoard 后
 * getBoardInfo 的图页列表 12s 后仍为空），等待预算放宽到 30s，并双源兜底——
 * getBoardInfo 取不到时扫 getAllBoardsInfo（同日实测图页更早出现在该列表里）。
 */
async function openBoardSchematicPage(boardName: string): Promise<{ pageUuid: string; pageName: string }> {
	interface BoardSchematicInfo { uuid?: string; page?: Array<{ uuid?: string; name?: string }> }
	const boardApi = edaGlobal()?.dmt_Board as
		| {
			getBoardInfo?: (boardName: string) => Promise<{ name?: string; schematic?: BoardSchematicInfo } | null>;
			getAllBoardsInfo?: () => Promise<Array<{ name?: string; schematic?: BoardSchematicInfo }>>;
		}
		| undefined;
	const getInfo = boardApi?.getBoardInfo;
	if (typeof getInfo !== 'function')
		throw new Error('dmt_Board.getBoardInfo 不可用，无法打开新建板子的原理图');
	const deadline = Date.now() + BOARD_PAGE_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const info = await withTimeout(getInfo.call(boardApi, boardName), 8000, '读取板子信息超时');
			const page = await firstPageFromSchematic(info?.schematic);
			if (page)
				return page;
		}
		catch { /* 板子刚创建时可能尚未同步，或目标页暂不可激活 */ }
		if (typeof boardApi?.getAllBoardsInfo === 'function') {
			try {
				const rows = (await withTimeout(boardApi.getAllBoardsInfo(), 8000, '读取板子列表超时')) || [];
				const hit = rows.find(r => String(r?.name || '') === boardName);
				const page = await firstPageFromSchematic(hit?.schematic);
				if (page)
					return page;
			}
			catch { /* 兜底源同样可能未同步 */ }
		}
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
		| {
			createBoard?: (schematicUuid?: string, pcbUuid?: string) => Promise<string | undefined>;
			getAllBoardsInfo?: () => Promise<Array<{ name?: string; uuid?: string }>>;
		}
		| undefined;
	const createBoard = boardApi?.createBoard;
	if (typeof createBoard !== 'function')
		throw new Error('dmt_Board.createBoard 不可用（宿主版本过低或不支持）');
	// createBoard 成功时也常只返回 undefined（与 openDocument 同类，宿主 2026-09-30 实测）。
	// 旧实现拿返回值当成功判据，导致板子其实已建好却误报「未返回板子名」，对所有模块普遍触发。
	// 改为「返回值优先 + 新增板 diff 兜底」：新建前后扫全量板列表，从新增行取板名，不再依赖返回值。
	const before = await snapshotBoardUuids(boardApi);
	let returnedName = '';
	try {
		const ret = await withTimeout(createBoard.call(boardApi), 20000, '新建板子超时');
		if (typeof ret === 'string')
			returnedName = ret.trim();
	}
	catch (e) {
		throw new Error(`新建板子失败：${fmtErr(e)}`);
	}
	const boardName = await resolveNewBoardName(boardApi, before, returnedName);
	if (!boardName)
		throw new Error('新建板子未成功（工程中未出现新板子）');
	return openBoardSchematicPage(boardName);
}

/** 扫全量板列表的 uuid 集合；接口缺失/异常返回空集，供新建前后 diff 兜底。 */
async function snapshotBoardUuids(boardApi: { getAllBoardsInfo?: () => Promise<Array<{ uuid?: string }>> } | undefined): Promise<Set<string>> {
	if (typeof boardApi?.getAllBoardsInfo !== 'function')
		return new Set();
	try {
		const rows = (await withTimeout(boardApi.getAllBoardsInfo(), 8000, '读取板子列表超时')) || [];
		return new Set(rows.map(r => String(r?.uuid || '')).filter(u => u));
	}
	catch {
		return new Set();
	}
}

/**
 * 解析新建板子的板名：优先用 createBoard 的返回值（部分宿主会返回板名）；
 * 否则轮询全量板列表，取 uuid 不在 before 里的新增行的 name。都取不到返回空串（调用方判失败）。
 */
async function resolveNewBoardName(
	boardApi: { getAllBoardsInfo?: () => Promise<Array<{ name?: string; uuid?: string }>> } | undefined,
	before: Set<string>,
	returnedName: string,
): Promise<string> {
	if (returnedName)
		return returnedName;
	if (typeof boardApi?.getAllBoardsInfo !== 'function')
		return '';
	const deadline = Date.now() + BOARD_APPEAR_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			const rows = (await withTimeout(boardApi.getAllBoardsInfo(), 8000, '读取板子列表超时')) || [];
			const hit = rows.find((r) => {
				const u = String(r?.uuid || '');
				return Boolean(u && !before.has(u) && String(r?.name || ''));
			});
			if (hit)
				return String(hit.name);
		}
		catch { /* 刚建板时列表可能尚未同步 */ }
		await sleep(300);
	}
	return '';
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
	// 本地模块的自带页属于磁盘工程，未在客户端打开时无法按 uuid 激活，预测量跳过：
	// 首放置走保守估计，放置后实测回写缓存，之后即精确。
	if (isLocalLibraryUuid(libraryUuid))
		return null;
	const origin = await getCurrentDocState();
	if (!origin.ok || !origin.uuid)
		return null;
	const cbbPageUuid = await getCbbPageUuid(cbbUuid, libraryUuid);
	// 打开模块自带页 → 等图元落盘 → 量全图元 → 必须切回原页，否则后续放置落错页。
	// 库侧自带页可能无法激活（如宿主不支持打开库侧原理图）：用收紧的等待预算快速降级，不拖慢放置。
	await activateSchematicPage(cbbPageUuid, PREMEASURE_OPEN_WAIT_MS);
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

// ── 从画布选中内容创建复用模块 ──────────────────────────────────────────
//
// 链路（2026-10-14 真机 V4.1.71 逐段实测通过）：
//   记原工程/原页 → 保存当前文档（否则切工程弹窗、扩展点不了）→ lib_Cbb.create 建空壳
//   → openProjectInEditor 打开模块工程 → getAllSchematicPagesInfo 取模块页 → openDocument
//   → 逐图元重建 → sch_Document.save → finally 切回原工程与原页
//
// 两个实测坑（违反必出错）：
// 1) 器件重建必须传**完整器件对象**（lib_Device.search 的结果），传裸 {libraryUuid, uuid}
//    会静默失败。而元件自带的 getState_Component().uuid 是**工程内副本 uuid**，拿它回库
//    查（lib_Device.get 返回 undefined）查不到——唯一可靠的桥是**器件名**：search(元件名)
//    再取 name 精确匹配的那条。
// 2) create() 返回的 primitiveId **不可靠**：同一调用有时返回、有时不返回，但元件都落页了。
//    成败一律以「回读页面」判定，不看返回值。同理，改动后立刻读���会拿到旧值，故回读前先 sleep。

/** 单个待重建器件。 */
export interface SelectionPart {
	designator?: string;
	/** 库器件名：回库查器件对象的唯一依据（不能用元件自带 uuid，那是工程内副本）。 */
	deviceName: string;
	/**
	 * 元件自带的 libraryUuid。★ 实测多为**工程 uuid**（工程内副本库），不能拿它当库去搜——
	 * 那样会搜到同名副本而非真库器件。仅作兜底，正常走 resolveDeviceItem 的库优先顺序。
	 */
	libraryUuid: string;
	/** 元件所用符号名：用于在多个同名候选中挑出符号一致的那个（保形状）。 */
	symbolName?: string;
	subPartName?: string;
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
	// ── 以下为「属性保真」：create() 只会给器件默认值，位号/值/采购信息等都要靠 modify 事后还原 ──
	/** 显示名表达式（如 `={Value}` / `={Manufacturer Part}`）。 */
	name?: string;
	manufacturer?: string;
	manufacturerId?: string;
	supplier?: string;
	supplierId?: string;
	addIntoBom?: boolean;
	addIntoPcb?: boolean;
	/** 用户属性（已剔除指向工程内副本的引用键，见 pickCarryOverProperties）。 */
	otherProperty?: Record<string, string | number | boolean>;
}

/**
 * 不从原工程带过去的属性键。
 * - `Device` / `Symbol` / `Footprint`：值是**当前工程的库内副本 uuid**，带到新模块里指向不存在的对象；
 * - `Reuse Block` / `Group ID` / `Channel ID`：放置 CBB 时产生的分组标记，带过去会残留旧分组关系。
 * 其余用户属性（Value、采购信息、Description、PCB Layer、3D/仿真模型等）一律保留。
 */
const NON_PORTABLE_PROPERTY_KEYS = new Set(['Device', 'Symbol', 'Footprint', 'Reuse Block', 'Group ID', 'Channel ID']);

/** 过滤出可跨工程携带的属性（只留标量值；引用类键见 NON_PORTABLE_PROPERTY_KEYS）。 */
function pickCarryOverProperties(raw: unknown): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!raw || typeof raw !== 'object')
		return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (NON_PORTABLE_PROPERTY_KEYS.has(k))
			continue;
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
			out[k] = v;
	}
	return out;
}

/** 单条待重建走线。 */
export interface SelectionWire {
	line: Array<number> | Array<Array<number>>;
	/** 逻辑走线上**存储**的 net（可能为空串 = 原图就没存，网络靠连接推导）。 */
	net: string;
	color: string | null;
	lineWidth: number | null;
	lineType: unknown;
}

/** 单个待重建网络标志 / 网络端口：类型由 componentName 解析（见 parseNetFlagKind / parseNetPortDirection）。 */
export interface SelectionPortLike {
	componentName: string;
	net: string;
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
}

/** 画布选区的规范化快照：propose 时读一次，confirm 时以它为准重建。 */
export interface SelectionSnapshot {
	parts: Array<SelectionPart>;
	wires: Array<SelectionWire>;
	netFlags: Array<SelectionPortLike>;
	netPorts: Array<SelectionPortLike>;
	/** 选区里被跳过的图元类型（文字/图形/离图连接器等），仅在卡上提示。 */
	unsupported: Array<string>;
	/** 选区图元 id（空选区判定用）。 */
	primitiveIds: Array<string>;
}

function emptySnapshot(): SelectionSnapshot {
	return { parts: [], wires: [], netFlags: [], netPorts: [], unsupported: [], primitiveIds: [] };
}

/**
 * 网络标志类型解析。实测（V4.1.71）createNetFlag 传入 → 读回 getState_Component().name：
 *   Power → `Power-*`；Ground → `Ground-GND`；AnalogGround → `Ground-AGND`；ProtectGround → `Ground-PGND`。
 * 后缀是**类型标签不是网络名**（用 net='ZZTEST' 建过，读回仍是 AGND/PGND），故可确定映射。
 * ★ 必须先判 AnalogGround / ProtectGround 再判 Ground，否则都被 `Ground` 前缀抢先命中。
 */
function parseNetFlagKind(componentName: string): 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround' | null {
	const n = (componentName || '').trim();
	if (n.startsWith('Power'))
		return 'Power';
	// Ground 家族三者都带 `Ground-` 前缀，靠后缀标签区分，顺序不可调（先 AGND/PGND 再 Ground）。
	if (n.includes('AGND') || n.includes('AnalogGround'))
		return 'AnalogGround';
	if (n.includes('PGND') || n.includes('ProtectGround'))
		return 'ProtectGround';
	if (n.startsWith('Ground'))
		return 'Ground';
	return null;
}

/**
 * 网络端口方向解析：实测 createNetPort 传入 IN/OUT/BI → 读回 `Netport-IN` / `Netport-OUT` / `Netport-BI`。
 * 同时接受裸的 IN/OUT/BI（宿主若改变命名仍可用）；不做宽松后缀匹配，避免 'PIN' 之类被误判成 IN。
 */
function parseNetPortDirection(componentName: string): 'IN' | 'OUT' | 'BI' | null {
	const n = (componentName || '').trim();
	const bare = n.startsWith('Netport-') ? n.slice('Netport-'.length).toUpperCase() : n.toUpperCase();
	return bare === 'IN' || bare === 'OUT' || bare === 'BI' ? bare : null;
}

/**
 * 读当前画布的选中内容并规范化。只读，不改画布。
 * 非原理图页抛错；空选区返回空快照（由上层给出「请先选中」提示，不在此抛）。
 */
export async function readSelectionSnapshot(): Promise<SelectionSnapshot> {
	const state = await getCurrentDocState();
	if (!state.ok)
		throw new Error('当前活动文档不是原理图页。请先切换到原理图页并选中要存成模块的内容。');
	const sel = edaGlobal()?.sch_SelectControl as
		| { getAllSelectedPrimitives?: () => Promise<Array<Record<string, unknown>>> }
		| undefined;
	if (typeof sel?.getAllSelectedPrimitives !== 'function')
		throw new Error('sch_SelectControl.getAllSelectedPrimitives 不可用（宿主版本过低或不支持）');
	// ★ 必须用 getAllSelectedPrimitives 直接取对象，**不能**用 sch_Primitive.getPrimitivesByPrimitiveId：
	// 实测（V4.1.71）后者只返回元件，**走线一条都不返回**，用它读选区会永远拿不到走线。
	// 本 API 同时给出元件与走线对象，且两者的 getState_* 与属性面都可用。
	// 走线以**分段**形式出现：一条折线拆成若干段，每段仍带自己的 line/net/color/lineWidth/lineType，
	// 逐段重建与原折线等价。
	let objs: Array<Record<string, unknown>> = [];
	try {
		objs = (await withTimeout(sel.getAllSelectedPrimitives(), 15000, '读取选区超时')) || [];
	}
	catch (e) {
		throw new Error(`读取选区失败：${fmtErr(e)}`);
	}
	objs = (Array.isArray(objs) ? objs : []).filter(o => o && typeof o === 'object');
	if (!objs.length)
		return emptySnapshot();
	const ids = objs.map(o => (typeof o.primitiveId === 'string' ? o.primitiveId : '')).filter(Boolean);

	const snap = emptySnapshot();
	snap.primitiveIds = ids;
	const read = (o: Record<string, unknown>, k: string): unknown => {
		try {
			const fn = o?.[k];
			return typeof fn === 'function' ? (fn as () => unknown).call(o) : undefined;
		}
		catch { return undefined; }
	};
	const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
	/** 被跳过的零长度走线数（不承载连接，宿主必拒；末尾计入"未写入"提示）。 */
	let degenerate = 0;

	for (const o of Array.isArray(objs) ? objs : []) {
		// 鸭子分型：元件有 getState_ComponentType，走线有 getState_Line。
		const cType = read(o, 'getState_ComponentType');
		const line = read(o, 'getState_Line');
		if (typeof cType === 'string') {
			if (cType === 'sheet')
				continue; // 页框不是内容
			const comp = read(o, 'getState_Component') as { name?: unknown; libraryUuid?: unknown } | undefined;
			const cName = comp && typeof comp.name === 'string' ? comp.name : '';
			const libUuid = comp && typeof comp.libraryUuid === 'string' ? comp.libraryUuid : '';
			// 符号名做「多个同名器件」的择优依据。实测选区的 getState_Symbol() 常拿不到 name，
			// 故属性面也试一次；都拿不到就是 undefined（不影响主流程，只是少一个择优条件）。
			const symByFn = read(o, 'getState_Symbol') as { name?: unknown } | undefined;
			const symByProp = o.symbol as { name?: unknown } | undefined;
			const symbolName = (symByFn && typeof symByFn.name === 'string' && symByFn.name)
				|| (symByProp && typeof symByProp.name === 'string' && symByProp.name)
				|| undefined;
			const at = { x: num(read(o, 'getState_X')), y: num(read(o, 'getState_Y')), rotation: num(read(o, 'getState_Rotation')), mirror: read(o, 'getState_Mirror') === true };
			// ★ 网络名的取法按类型不同（V4.1.71 实测）：走线对象 getState_Net() 正常；
			// netflag/netport 对象上 getState_Net() 返回**空串**，网络名在 getState_Name() 里
			// （'GND' / '5V' / 'ENC_2'）。两者都试，先 Net 后 Name。
			const netRaw = read(o, 'getState_Net');
			const nameRaw = read(o, 'getState_Name');
			const net = (typeof netRaw === 'string' && netRaw) ? netRaw : (typeof nameRaw === 'string' ? nameRaw : '');
			if (cType === 'part') {
				const sub = read(o, 'getState_SubPartName');
				const str = (k: string): string | undefined => {
					const v = read(o, k);
					return typeof v === 'string' && v ? v : undefined;
				};
				// 属性保真：create() 只给器件默认值，位号/显示名/厂商/采购/自定义属性都在这里记下来，
				// 创建后用 modify 还原（见 rebuildParts）。otherProperty 过滤掉指向工程内副本的引用键。
				const otherRaw = read(o, 'getState_OtherProperty') ?? o.otherProperty;
				snap.parts.push({
					designator: str('getState_Designator'),
					deviceName: cName,
					libraryUuid: libUuid,
					symbolName,
					subPartName: typeof sub === 'string' && sub ? sub : undefined,
					name: str('getState_Name'),
					manufacturer: str('getState_Manufacturer'),
					manufacturerId: str('getState_ManufacturerId'),
					supplier: str('getState_Supplier'),
					supplierId: str('getState_SupplierId'),
					addIntoBom: read(o, 'getState_AddIntoBom') === true,
					addIntoPcb: read(o, 'getState_AddIntoPcb') === true,
					otherProperty: pickCarryOverProperties(otherRaw),
					...at,
				});
			}
			else if (cType === 'netflag') {
				snap.netFlags.push({ componentName: cName, net, ...at });
			}
			else if (cType === 'netport') {
				snap.netPorts.push({ componentName: cName, net, ...at });
			}
			else {
				snap.unsupported.push(cType);
			}
			continue;
		}
		if (line !== undefined) {
			// 走线按**分段**直接入快照，段上带的 net 一并保留。
			// 曾试过归并回逻辑走线以求「不多出网络标签」，但归并后不带 net 建会被宿主拒绝
			// （create failed!），把线丢了——**连通性优先，标签不管**，这里回退为逐段带 net。
			// 唯一的例外是零长度段（所有点重合）：宿主必拒且它不承载任何连接，跳过并计入"未写入"。
			if (isDegenerateWireLine(flattenWireLine(line))) {
				degenerate++;
				continue;
			}
			const color = read(o, 'getState_Color');
			const lw = read(o, 'getState_LineWidth');
			const lt = read(o, 'getState_LineType');
			const net = read(o, 'getState_Net');
			snap.wires.push({
				line: line as Array<number> | Array<Array<number>>,
				net: typeof net === 'string' ? net : '',
				color: typeof color === 'string' ? color : null,
				lineWidth: typeof lw === 'number' ? lw : null,
				lineType: lt === undefined ? null : lt,
			});
			continue;
		}
		snap.unsupported.push('unknown');
	}
	if (degenerate)
		snap.unsupported.push(`零长度走线×${degenerate}`);
	return snap;
}

/** 把 getState_Line() 的返回值（扁平或嵌套）拉平成一维数字数组 `[x1,y1,x2,y2,…]`。 */
function flattenWireLine(line: unknown): Array<number> {
	if (!Array.isArray(line))
		return [];
	return (Array.isArray(line[0]) ? (line as Array<Array<number>>).flat() : (line as Array<number>)).filter(n => typeof n === 'number');
}

/**
 * 零长度走线：点数不足两个，或所有点都重合。
 * 实测（V4.1.71）宿主**拒绝创建**这种走线，抛「create failed!」；而它不承载任何连接、
 * 在原图上也看不见，因此跳过是对的——但必须计入「未写入」提示，不能静默吞掉。
 */
function isDegenerateWireLine(pts: Array<number>): boolean {
	if (pts.length < 4)
		return true;
	for (let i = 2; i + 1 < pts.length; i += 2) {
		if (pts[i] !== pts[0] || pts[i + 1] !== pts[1])
			return false;
	}
	return true;
}

/** 选区规模校验：超限拒绝，避免一次重建耗时过长。 */
export function assertSelectionSize(snap: SelectionSnapshot): void {
	if (snap.parts.length > MAX_CREATE_PARTS)
		throw new Error(`选中的器件过多（${snap.parts.length} 个，上限 ${MAX_CREATE_PARTS}）。请缩小选择范围后重试。`);
	if (snap.wires.length > MAX_CREATE_WIRES)
		throw new Error(`选中的走线过多（${snap.wires.length} 条，上限 ${MAX_CREATE_WIRES}）。请缩小选择范围后重试。`);
}

/**
 * 按器件名回库取器件对象：search(名, 库) 后取 name **精确匹配**的那条。
 * 实测 search 会返回模糊命中的其它器件（如搜 'Res_0603' 首条是 'YFT0603X103F3950FA'），
 * 不精确匹配就会建出错件。找不到返回 null（调用方计入失败清单）。
 */
async function resolveDeviceItem(part: SelectionPart): Promise<Record<string, unknown> | null> {
	const deviceName = part.deviceName;
	if (!deviceName)
		return null;
	const dev = edaGlobal()?.lib_Device as
		| { search?: (key: string, libraryUuid?: string) => Promise<Array<Record<string, unknown>>> }
		| undefined;
	if (typeof dev?.search !== 'function')
		return null;

	// ★ 库优先顺序：系统库（不传 libraryUuid = 系统库）→ 个人库 → 元件自带库。
	// 实测（V4.1.71）元件自带的 libraryUuid 多数是**当前工程 uuid**（工程内副本库），
	// 拿它搜会搜到同名**工程内副本**而非真库器件；而副本不能跨工程解析，拿去建模块会
	// 形状对不上或建不出来。所以真库器件优先，元件自带库只作最后兜底。
	const libs: Array<string | undefined> = [undefined];
	try {
		const libsApi = edaGlobal()?.lib_LibrariesList as { getPersonalLibraryUuid?: () => Promise<string | undefined> } | undefined;
		const personal = typeof libsApi?.getPersonalLibraryUuid === 'function' ? await libsApi.getPersonalLibraryUuid() : undefined;
		if (typeof personal === 'string' && personal)
			libs.push(personal);
	}
	catch { /* 个人库拿不到就跳过 */ }
	if (part.libraryUuid && !libs.includes(part.libraryUuid))
		libs.push(part.libraryUuid);

	for (const lib of libs) {
		try {
			const rows = await withTimeout(dev.search(deviceName, lib), DEVICE_LOOKUP_TIMEOUT_MS, '查找器件超时');
			const exact = (Array.isArray(rows) ? rows : []).filter(r => String(r?.name ?? '') === deviceName);
			if (!exact.length)
				continue;
			// 同名多条时优先符号名一致的那个（保形状）；拿不到符号名则取首个。
			const bySymbol = part.symbolName
				? exact.find(r => String(r?.symbolName ?? '') === part.symbolName)
				: undefined;
			return bySymbol || exact[0];
		}
		catch { /* 该库搜不到就试下一个 */ }
	}
	return null;
}

export interface CreateCbbModuleParams {
	libraryUuid: string;
	name: string;
	description: string;
	classification?: Array<string>;
	snapshot: SelectionSnapshot;
}

export interface CreateCbbModuleResult {
	cbbUuid: string;
	pageUuid: string;
	pageName: string;
	rebuilt: { parts: number; wires: number; netFlags: number; netPorts: number };
	/** 逐条失败说明（器件缺库、走线创建失败等），不中断整体。 */
	failures: Array<string>;
}

/**
 * 从选区快照创建复用模块并写入库。
 *
 * 重建顺序固定为 器件 → 网络标志 → 网络端口 → 走线：走线放最后，端点才落在已带网的引脚上
 * （若先建走线再接网络，端点会落在无网或异网的图元上，宿主会拒绝创建）。
 *
 * 无论中途哪一步失败，finally 都会切回原工程与原页——否则用户被留在模块工程里。
 */
export async function createCbbModuleFromSelection(params: CreateCbbModuleParams): Promise<CreateCbbModuleResult> {
	if (!params.libraryUuid)
		throw new Error('缺少目标库标识');
	if (!params.name.trim())
		throw new Error('模块名称不能为空');
	assertPlaceableLibrary(params.libraryUuid);
	assertSelectionSize(params.snapshot);

	const cbbApi = edaGlobal()?.lib_Cbb as
		| {
			create?: (libraryUuid: string, cbbName: string, classification?: unknown, description?: string) => Promise<string | undefined>;
			openProjectInEditor?: (cbbUuid: string, libraryUuid: string) => Promise<boolean>;
			delete?: (cbbUuid: string, libraryUuid: string) => Promise<boolean>;
		}
		| undefined;
	if (typeof cbbApi?.create !== 'function')
		throw new Error('lib_Cbb.create 不可用（宿主版本过低或不支持）。创建模块需要 V4.1.71 及以上。');

	const proj = edaGlobal()?.dmt_Project as ProjectApi | undefined;
	const originProjectUuid = await readCurrentProjectUuid(proj);
	const originDoc = await getCurrentDocState();
	const originPageUuid = originDoc.uuid || '';

	// 1) 切工程前先保存：未保存时 openProjectInEditor 会弹确认框，扩展点不了，调用直接失败。
	await saveCurrentProjectDocuments();

	// 2) 建空壳。失败是静默 undefined，不抛错——必须显式判。
	let cbbUuid = '';
	try {
		const got = await withTimeout(
			cbbApi.create(params.libraryUuid, params.name.trim(), params.classification || [], params.description),
			CREATE_TIMEOUT_MS,
			'新建模块超时（30s）——请重试',
		);
		cbbUuid = typeof got === 'string' ? got : '';
	}
	catch (e) {
		throw new Error(`新建模块失败：${fmtErr(e)}`);
	}
	if (!cbbUuid)
		throw new Error('新建模块未成功（宿主静默返回空 uuid）。可能是该库无写权限，或客户端版本低于 V4.1.71。');

	const failures: Array<string> = [];
	const rebuilt = { parts: 0, wires: 0, netFlags: 0, netPorts: 0 };
	let pageUuid = '';
	let pageName = '';
	try {
		// 3) 打开模块工程。文档警告：会丢弃原工程未保存内容（已在上方保存当前文档）。
		if (typeof cbbApi.openProjectInEditor !== 'function')
			throw new Error('lib_Cbb.openProjectInEditor 不可用（宿主版本过低或不支持）');
		const opened = await withTimeout(
			cbbApi.openProjectInEditor(cbbUuid, params.libraryUuid),
			OPEN_MODULE_TIMEOUT_MS,
			'打开模块工程超时（30s）',
		);
		if (opened !== true)
			throw new Error('打开新建的模块工程失败');
		await sleep(1500);

		// 4) 模块工程打开后没有活动文档，必须自行找到并激活它的原理图页。
		const page = await openModuleFirstPage();
		pageUuid = page.pageUuid;
		pageName = page.pageName;

		// 5) 重建：顺序不可调（见函数注释）。
		await rebuildParts(params.snapshot.parts, failures, rebuilt);
		await rebuildFlags(params.snapshot.netFlags, failures, rebuilt);
		await rebuildPorts(params.snapshot.netPorts, failures, rebuilt);
		await rebuildWires(params.snapshot.wires, failures, rebuilt);

		// 6) 落盘。回读前先等一拍：实测改动后立刻读会拿到旧值。
		await sleep(800);
		const doc = edaGlobal()?.sch_Document as { save?: () => Promise<boolean> } | undefined;
		if (typeof doc?.save !== 'function')
			throw new Error('sch_Document.save 不可用');
		const saved = await withTimeout(doc.save(), SAVE_TIMEOUT_MS, '保存模块超时（20s）');
		if (saved !== true)
			throw new Error('保存模块失败（接口返回 false）');
	}
	catch (e) {
		// 模块已建成但内容写入失败：回滚删除，避免库里留空壳。删除失败只记录不覆盖原错误。
		try {
			if (typeof cbbApi.delete === 'function')
				await withTimeout(cbbApi.delete(cbbUuid, params.libraryUuid), MODIFY_TIMEOUT_MS, '回滚删除超时');
		}
		catch { /* 回滚失败不掩盖原始错误，提示里已含模块名 */ }
		throw new Error(`创建模块内容失败，已回滚（${params.name.trim()}）：${fmtErr(e)}`);
	}
	finally {
		// 必须切回：否则用户被留在模块工程里。切回失败无法补救，只能靠上层提示。
		try {
			if (originProjectUuid && typeof proj?.openProject === 'function')
				await withTimeout(proj.openProject(originProjectUuid), OPEN_MODULE_TIMEOUT_MS, '切回原工程超时');
			await sleep(1500);
			if (originPageUuid)
				await activateSchematicPage(originPageUuid);
		}
		catch { /* 见上 */ }
	}

	return { cbbUuid, pageUuid, pageName, rebuilt, failures };
}

/** 打开模块工程里的第一个原理图页（优先名为 P1 的）。 */
async function openModuleFirstPage(): Promise<{ pageUuid: string; pageName: string }> {
	const sch = edaGlobal()?.dmt_Schematic as
		| { getAllSchematicPagesInfo?: () => Promise<Array<{ uuid?: string; name?: string }>> }
		| undefined;
	if (typeof sch?.getAllSchematicPagesInfo !== 'function')
		throw new Error('dmt_Schematic.getAllSchematicPagesInfo 不可用');
	const pages = (await withTimeout(sch.getAllSchematicPagesInfo(), 15000, '读取模块图页超时')) || [];
	const list = (Array.isArray(pages) ? pages : []).filter(p => typeof p?.uuid === 'string' && p.uuid);
	if (!list.length)
		throw new Error('新建的模块工程里没有原理图页');
	const first = list.find(p => p.name === 'P1') || list[0];
	await activateSchematicPage(String(first.uuid));
	return { pageUuid: String(first.uuid), pageName: typeof first.name === 'string' ? first.name : '' };
}

/** 回读页面现存器件数与走线数（成败判定只能靠它，create 的返回值不可靠）。 */
async function countPageContent(): Promise<{ comps: number; wires: number }> {
	const comp = edaGlobal()?.sch_PrimitiveComponent as { getAll?: () => Promise<unknown> } | undefined;
	const wire = edaGlobal()?.sch_PrimitiveWire as { getAllPrimitiveId?: () => Promise<unknown> } | undefined;
	let comps = 0;
	let wires = 0;
	try {
		const rows = typeof comp?.getAll === 'function' ? await comp.getAll() : [];
		comps = Array.isArray(rows) ? rows.length : 0;
	}
	catch { /* 读不到按 0 计，由调用方按差值判断 */ }
	try {
		const rows = typeof wire?.getAllPrimitiveId === 'function' ? await wire.getAllPrimitiveId() : [];
		wires = Array.isArray(rows) ? rows.length : 0;
	}
	catch { /* 同上 */ }
	return { comps, wires };
}

async function rebuildParts(parts: Array<SelectionPart>, failures: Array<string>, rebuilt: { parts: number }): Promise<void> {
	if (!parts.length)
		return;
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { create?: (...args: Array<unknown>) => Promise<unknown> }
		| undefined;
	if (typeof comp?.create !== 'function') {
		failures.push(`器件重建不可用：sch_PrimitiveComponent.create 缺失（${parts.length} 个未重建）`);
		return;
	}
	const before = (await countPageContent()).comps;
	for (const p of parts) {
		const label = p.designator || p.deviceName || '(未命名器件)';
		const dev = await resolveDeviceItem(p);
		if (!dev) {
			failures.push(`器件 ${label}：系统库/个人库中找不到名为「${p.deviceName}」的器件`);
			continue;
		}
		let made: unknown = null;
		try {
			made = await withTimeout(
				comp.create(dev, p.x, p.y, p.subPartName, p.rotation, p.mirror, p.addIntoBom !== false, p.addIntoPcb !== false),
				REBUILD_ONE_TIMEOUT_MS,
				`重建器件 ${label} 超时`,
			);
		}
		catch (e) {
			failures.push(`器件 ${label}：${fmtErr(e)}`);
			continue;
		}
		// 属性还原：create() 只给器件默认值（位号是自动编的 R?、值取器件默认），
		// 原件的位号/显示名/厂商/采购信息/自定义属性都要用 modify 补回去。
		// ★ modify 的 target 接受 primitiveId 或图元对象：create() 的返回值有时没有 primitiveId
		//   （实测同一调用有时有有时无，但元件都落页了），所以对象本身也当作 target 传。
		const mod = (comp as { modify?: (target: unknown, property: Record<string, unknown>) => Promise<unknown> }).modify;
		if (typeof mod !== 'function')
			continue;
		const target = (made && typeof (made as { primitiveId?: unknown }).primitiveId === 'string' && (made as { primitiveId: string }).primitiveId)
			? (made as { primitiveId: string }).primitiveId
			: made;
		if (!target)
			continue;
		const props: Record<string, unknown> = {
			// ★ rotation/mirror 也要在 modify 里再设一次：实测 create(rotation=90) 读回是 270，
			// 而 modify(rotation=90) 读回就是 90——两者约定不一致。以 modify 的 1:1 口径为准。
			rotation: p.rotation,
			mirror: p.mirror,
			designator: p.designator,
			name: p.name,
			manufacturer: p.manufacturer,
			manufacturerId: p.manufacturerId,
			supplier: p.supplier,
			supplierId: p.supplierId,
			addIntoBom: p.addIntoBom,
			addIntoPcb: p.addIntoPcb,
		};
		if (p.otherProperty && Object.keys(p.otherProperty).length)
			props.otherProperty = p.otherProperty;
		// 未取到的字段保持 undefined 直接传：modify 把 undefined 当「不改」，与不传该键等价
		// （对象过 JSON 时 undefined 值的键本来也会被丢弃），故无需预先剔除。
		try {
			await withTimeout(mod.call(comp, target, props), REBUILD_ONE_TIMEOUT_MS, `还原器件 ${label} 属性超时`);
		}
		catch (e) {
			// 属性还原失败不算重建失败（元件本身已在页上），但要��实告知，否则用户以为属性保住了。
			failures.push(`器件 ${label}：已放置但属性未完全还原（${fmtErr(e)}）`);
		}
	}
	await sleep(500);
	// create 的返回值不可靠（实测同一调用有时无 primitiveId 但元件已落页），按数量差计入成功数。
	rebuilt.parts = Math.max(0, (await countPageContent()).comps - before);
}

/**
 * 网络标志 / 网络端口的旋转落定。
 *
 * ★ 实测（V4.1.71）`createNetFlag` / `createNetPort` 的 rotation **入参与读回值不一致**：
 * 传 0→0、180→180 一致，但传 90 读回 270、传 270 读回 90（即 `(360 - 传入) % 360`）。
 * 器件那边可以用 `modify` 补偿，这里不行——`sch_PrimitiveComponent.modify` 对网络标志/端口
 * 会报「仅当器件类型为元件时允许使用该函数进行修改」。可用的是 `setState_Rotation` + `done()`，
 * 实测能把方向正确落定。修正失败不阻断（方向只是显示属性，网络名才是电气语义）。
 */
function settlePortLikeRotation(created: unknown, rotation: number): void {
	const o = created as { setState_Rotation?: (r: number) => void; done?: () => void } | undefined;
	if (!o || typeof o.setState_Rotation !== 'function')
		return;
	try {
		o.setState_Rotation(rotation);
		if (typeof o.done === 'function')
			o.done();
	}
	catch { /* 见上：失败不阻断 */ }
}

async function rebuildFlags(flags: Array<SelectionPortLike>, failures: Array<string>, rebuilt: { netFlags: number }): Promise<void> {
	if (!flags.length)
		return;
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { createNetFlag?: (...args: Array<unknown>) => Promise<unknown> }
		| undefined;
	if (typeof comp?.createNetFlag !== 'function') {
		failures.push(`网络标志重建不可用：createNetFlag 缺失（${flags.length} 个未重建）`);
		return;
	}
	const before = (await countPageContent()).comps;
	for (const f of flags) {
		const kind = parseNetFlagKind(f.componentName);
		if (!kind) {
			failures.push(`网络标志 ${f.net || f.componentName}：无法识别类型（${f.componentName}）`);
			continue;
		}
		try {
			const made = await withTimeout(comp.createNetFlag(kind, f.net, f.x, f.y, f.rotation, f.mirror), REBUILD_ONE_TIMEOUT_MS, `重建网络标志 ${f.net} 超时`);
			settlePortLikeRotation(made, f.rotation);
		}
		catch (e) {
			failures.push(`网络标志 ${f.net}：${fmtErr(e)}`);
		}
	}
	await sleep(500);
	rebuilt.netFlags = Math.max(0, (await countPageContent()).comps - before);
}

async function rebuildPorts(ports: Array<SelectionPortLike>, failures: Array<string>, rebuilt: { netPorts: number }): Promise<void> {
	if (!ports.length)
		return;
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { createNetPort?: (...args: Array<unknown>) => Promise<unknown> }
		| undefined;
	if (typeof comp?.createNetPort !== 'function') {
		failures.push(`网络端口重建不可用：createNetPort 缺失（${ports.length} 个未重建）`);
		return;
	}
	const before = (await countPageContent()).comps;
	for (const p of ports) {
		const dir = parseNetPortDirection(p.componentName);
		if (!dir) {
			failures.push(`网络端口 ${p.net || p.componentName}：无法识别方向（${p.componentName}）`);
			continue;
		}
		try {
			const made = await withTimeout(comp.createNetPort(dir, p.net, p.x, p.y, p.rotation, p.mirror), REBUILD_ONE_TIMEOUT_MS, `重建网络端口 ${p.net} 超时`);
			settlePortLikeRotation(made, p.rotation);
		}
		catch (e) {
			failures.push(`网络端口 ${p.net}：${fmtErr(e)}`);
		}
	}
	await sleep(500);
	rebuilt.netPorts = Math.max(0, (await countPageContent()).comps - before);
}

/**
 * 隐藏走线上的网络名标签。
 *
 * 实测（V4.1.71）：`create(line, net, …)` 传了 net 时，宿主会给走线挂一条
 * `key='Name'`、`value=<网络名>`、`valueVisible=true` 的属性——画布上就是那个蓝标签。
 * 该属性**删不掉**（`sch_PrimitiveAttribute.delete` 实测返回 false、属性仍在），
 * 但可以置 `valueVisible=false` 隐藏：这正是原图里 Symbol/Footprint/Device 这类内部引用的
 * 状态（页面源码里 42 处 `valueVisible:false` 全是这类不显示的内部字段）。
 *
 * 用 `getAll(wireId)` 一次拿到该走线的全部属性（不逐个 get，省往返），再对可见的那条置 false。
 * 隐藏失败不阻断重建——标签只是显示问题，线的连通性不受影响。
 */
async function hideWireNetLabel(wireId: string): Promise<void> {
	const api = edaGlobal()?.sch_PrimitiveAttribute as
		| {
			getAll?: (parentPrimitiveId?: string) => Promise<Array<Record<string, unknown>>>;
			modify?: (target: unknown, property: Record<string, unknown>) => Promise<unknown>;
		}
		| undefined;
	if (typeof api?.getAll !== 'function' || typeof api.modify !== 'function')
		return;
	try {
		const attrs = (await withTimeout(api.getAll(wireId), DEVICE_LOOKUP_TIMEOUT_MS, '读取走线属性超时')) || [];
		for (const attr of Array.isArray(attrs) ? attrs : []) {
			if (!attr || attr.valueVisible !== true)
				continue;
			await withTimeout(api.modify(attr, { valueVisible: false }), DEVICE_LOOKUP_TIMEOUT_MS, '隐藏网络标签超时');
		}
	}
	catch { /* 见上：不阻断 */ }
}

async function rebuildWires(wires: Array<SelectionWire>, failures: Array<string>, rebuilt: { wires: number }): Promise<void> {
	if (!wires.length)
		return;
	const wire = edaGlobal()?.sch_PrimitiveWire as
		| { create?: (...args: Array<unknown>) => Promise<unknown> }
		| undefined;
	if (typeof wire?.create !== 'function') {
		failures.push(`走线重建不可用：sch_PrimitiveWire.create 缺失（${wires.length} 条未重建）`);
		return;
	}
	const before = (await countPageContent()).wires;
	for (const w of wires) {
		// 逐段带 net 建（最初始的写法）。**连通性优先**：不带 net 建会被宿主拒绝（create failed!）
		// 而丢线。多出的网络标签在建完后隐藏掉（见 hideWireNetLabel），不靠省掉 net 来避标签。
		let made: unknown = null;
		try {
			made = await withTimeout(wire.create(w.line, w.net || undefined, w.color, w.lineWidth, w.lineType), REBUILD_ONE_TIMEOUT_MS, '重建走线超时');
		}
		catch (e) {
			failures.push(`走线（${w.net || '无网络'}）：${fmtErr(e)}`);
			continue;
		}
		// 只有传了 net 才会有那条可见标签；create 的��回值有时没有 primitiveId，拿不到就跳过隐藏。
		const id = made && typeof (made as { primitiveId?: unknown }).primitiveId === 'string' ? String((made as { primitiveId: string }).primitiveId) : '';
		if (w.net && id)
			await hideWireNetLabel(id);
	}
	await sleep(500);
	rebuilt.wires = Math.max(0, (await countPageContent()).wires - before);
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
/** 物化放置（读取用）超时：多板模块实测 25s 级才落完副本板，比常规放置给更长预算。 */
const PLACE_READ_TIMEOUT_MS = 60000;
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
 * 读取模块自带原理图页内容（只读）：读器件/网络/文字摘要后切回原文档。三源统一入口（个人/团队/本地库同路径）。
 * 不直接「激活模块自带页」：boards[].schematic 是库侧原理图 uuid（非工程内图页 uuid），本地库模块还须走
 * .eprj2 解析，统一改走两条路径读取：
 * - 快路径（零副作用）：工程里已有该模块的 CBB 副本（放置时宿主自动生成）时，直接打开副本板的图页读取。
 *   任一环节失败不判死，退化到物化路径再试。
 * - 物化路径：自建临时板并激活其页 → placeCbbSchematicPage 把模块内容落到调用时的活动图页（宿主行为，
 *   实测 2026-09-30：内容落在活动页、不切换活动页、并新建"模块名_N"副本板承载原样拷贝）→ 读摘要 →
 *   切回原文档 → 删除新产生的板子（临时板 + 副本板；deleteBoard 优先、删页兜底、两轮清迟到板）。
 *   本地库模块 lib_Cbb.get 必崩（TypeError: parent_tag）且 .eprj2 加密，sheet uuid 走 readLocalSheetUuid
 *   的明文工程树解析；云端直接取 boards[].schematic（实测 placeCbbSchematicPage 用它放置返回 true）。
 * 已知无法消除的副作用：每次物化会向工程库写入一个 CBB 副本（与正常放置相同，宿主行为）。
 */
export async function readCbbSchematicSummary(libraryUuid: string, cbbUuid: string, moduleName = ''): Promise<CbbSchematicSummary> {
	assertPlaceableLibrary(libraryUuid);
	const origin = await getCurrentDocState();
	const copyPage = await findCbbCopyPageUuid(cbbUuid);
	let fastErr: unknown = null;
	if (copyPage) {
		try {
			await activateSchematicPage(copyPage);
			try {
				return await readActivePageSummary(copyPage);
			}
			finally {
				await restoreOriginDocument(origin);
			}
		}
		catch (e) {
			// 快路径任一环节失败（副本页打不开/读不到、切回失败）都不判死，退化到物化路径再试一次。
			fastErr = e;
		}
	}
	const boardsBefore = await listBoardUuids();
	try {
		let tempPage = '';
		try {
			tempPage = (await openNewBoardAndSchematic()).pageUuid;
		}
		catch (e) {
			throw new Error(`无法自建临时图页读取模块原理图：${fmtErr(e)}`);
		}
		const sheetUuid = isLocalLibraryUuid(libraryUuid)
			? await readLocalSheetUuid(libraryUuid, cbbUuid, moduleName)
			: await getCbbPageUuid(cbbUuid, libraryUuid);
		await placeCbbSheetForRead(libraryUuid, cbbUuid, sheetUuid);
		// 内容落在调用时的活动图页（自建临时页），读活动页即读到模块内容。
		const activeUuid = (await getCurrentDocState()).uuid || tempPage;
		let summary = await readActivePageSummary(activeUuid);
		// 保险：宿主版本差异导致活动页为空时（内容只落到副本板、或落到临时页但活动页被切换），
		// 逐个候选页补读，取首个非空摘要。
		if (!summary.deviceCount && !summary.nets.length && !summary.texts.length) {
			for (const candidate of [tempPage, await findCbbCopyPageUuid(cbbUuid)]) {
				if (!candidate || candidate === activeUuid)
					continue;
				await activateSchematicPage(candidate);
				const s = await readActivePageSummary(candidate);
				if (s.deviceCount || s.nets.length || s.texts.length) {
					summary = s;
					break;
				}
			}
		}
		return summary;
	}
	catch (e) {
		// 两条路径都失败时把快路径的失败原因一并带上，便于区分「副本页打不开」与「物化失败」。
		if (fastErr !== null)
			throw new Error(`读取模块原理图失败（副本页路径：${fmtErr(fastErr)}；临时页物化路径：${fmtErr(e)}）`);
		throw e;
	}
	finally {
		// 切回原文档后删板（避免删除活动文档）；清理不被切回异常跳过，否则物化副产品残留工程。
		try {
			await restoreOriginDocument(origin);
		}
		finally {
			await deleteBoardsCreatedAfter(boardsBefore);
		}
	}
}

/**
 * 工程里已有的该模块 CBB 副本图页：放置时宿主自动生成"模块名_N"板（内容为模块原样拷贝），
 * 其页可直接打开读取，零副作用。找不到返回 null（首次读取走物化路径）。多板模块有多份副本时
 * 取第一份——读取范围同为单页，与物化路径的 boards[0] 口径一致量级。
 */
async function findCbbCopyPageUuid(cbbUuid: string): Promise<string | null> {
	const sch = edaGlobal()?.dmt_Schematic as
		| { getAllSchematicsInfo?: () => Promise<Array<Record<string, unknown>>> }
		| undefined;
	if (typeof sch?.getAllSchematicsInfo !== 'function')
		return null;
	try {
		const rows = (await withTimeout(sch.getAllSchematicsInfo(), 15000, '读取工程原理图列表超时')) || [];
		for (const row of rows) {
			const sym = row.cbbSymbol as { cbbUuid?: unknown } | undefined;
			if (!sym || typeof sym.cbbUuid !== 'string' || sym.cbbUuid !== cbbUuid)
				continue;
			const pages = Array.isArray(row.page) ? (row.page as Array<{ uuid?: unknown }>) : [];
			const pageUuid = pages.map(p => String(p?.uuid || '')).find(u => u);
			if (pageUuid)
				return pageUuid;
		}
	}
	catch { /* 查不到副本不阻塞，走物化路径 */ }
	return null;
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
 * 清理放置新产生的板子（自建临时板 + 宿主副产品副本板）：优先 deleteBoard 整板删除（实测 2026-09-30
 * 返回 true 可删，含空板）；失败回退删除其全部图页——宿主在末页删除后自动移除空板（实测 2026-09-16）。
 * 删完等一拍再清一轮，兜底多板模块异步迟到的副本板（实测 25s 级陆续生成）。
 * 返回成功清理的板子数。
 */
async function deleteBoardsCreatedAfter(before: Set<string>): Promise<number> {
	let cleaned = await deleteNewBoardsOnce(before);
	await sleep(800);
	cleaned += await deleteNewBoardsOnce(before);
	return cleaned;
}

/** 一轮清理：删除快照之后新出现的板子。deleteBoard 优先、删页兜底；两者都未成功不计数。 */
async function deleteNewBoardsOnce(before: Set<string>): Promise<number> {
	const b = edaGlobal()?.dmt_Board as
		| { getAllBoardsInfo?: () => Promise<Array<Record<string, unknown>>>; deleteBoard?: (boardName: string) => Promise<boolean> }
		| undefined;
	const sch = edaGlobal()?.dmt_Schematic as
		| { deleteSchematicPage?: (pageUuid: string) => Promise<boolean> }
		| undefined;
	if (typeof b?.getAllBoardsInfo !== 'function')
		return 0;
	const rows = (await b.getAllBoardsInfo()) || [];
	const newBoards = rows.filter(r => !before.has(String(r.uuid)));
	let cleaned = 0;
	for (const nb of newBoards) {
		let done = false;
		const name = String(nb.name || '');
		if (name && typeof b.deleteBoard === 'function') {
			try {
				done = (await withTimeout(b.deleteBoard(name), 10000, '删除板子超时')) === true;
			}
			catch { done = false; }
		}
		if (!done && typeof sch?.deleteSchematicPage === 'function') {
			const schematic: unknown = nb.schematic;
			const pages = schematic && typeof schematic === 'object' && Array.isArray((schematic as { page?: unknown }).page)
				? ((schematic as { page: Array<{ uuid?: unknown }> }).page).map(p => String(p.uuid ?? '')).filter(u => u)
				: [];
			if (pages.length) {
				done = true;
				for (const pUuid of pages) {
					try {
						const r = await withTimeout(sch.deleteSchematicPage(pUuid), 10000, '删除图页超时');
						if (r !== true)
							done = false;
					}
					catch {
						done = false;
					}
				}
			}
		}
		if (done)
			cleaned++;
	}
	return cleaned;
}

/**
 * 物化路径放置：placeCbbSchematicPage 把 sheet 内容落到调用时的活动图页（调用方自建的临时页）原点，
 * 由调用方读取活动页摘要并清理新板子。读取场景给更长超时（多板模块实测 25s 级才落完副本板）。
 */
async function placeCbbSheetForRead(libraryUuid: string, cbbUuid: string, sheetUuid: string): Promise<void> {
	const comp = edaGlobal()?.sch_PrimitiveComponent as
		| { placeCbbSchematicPage?: (args: { libraryUuid: string; cbbUuid: string; uuid: string }, x: number, y: number) => Promise<boolean> }
		| undefined;
	const place = comp?.placeCbbSchematicPage;
	if (typeof place !== 'function')
		throw new Error('placeCbbSchematicPage 不可用（宿主版本过低或不支持）');
	const ok = await withTimeout(
		place.call(comp, { libraryUuid, cbbUuid, uuid: sheetUuid }, 0, 0),
		PLACE_READ_TIMEOUT_MS,
		'临时页放置模块超时（60s）',
	);
	if (ok !== true)
		throw new Error('临时页放置模块未成功（接口返回 false）');
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

/**
 * 库范围/客户端模式判定（2026-09-17 重构）：一次性并发直测三源，单轮合成判定，无兜底链。
 *
 * 实测（2026-09-16/17，V3.2.166 三种客户端模式）：
 * - 在线版：`sys_Environment` 模式布尔（isOnlineMode 等）**不可用**（undefined）；
 *   `getPersonalLibraryUuid` 返回 uuid；`getAllLibrariesList` 返回团队库列表（无团队时 []）；
 *   `getLibrariesPaths` 抛「非全离线」错。
 * - 半离线版：`isHalfOfflineMode()` = true（布尔判定可用）；
 *   `getAllLibrariesList` 返回 []；`getLibrariesPaths` 失效（本地库走设置路径兜底）。
 * - 全离线版：`isOfflineMode()` = true（布尔判定可用）；
 *   `getAllLibrariesList` 按双语义返回本地库路径；`getLibrariesPaths` 可用。
 *
 * 判定映射（单次合成，探测结果即结论）：
 * - 在线个人库 = getPersonalLibraryUuid 返回非空 uuid；
 * - 在线团队库 = 在线模式可达（与个人库同属云端在线源，无团队时枚举为空列表）；
 * - 本地库     = 非在线（结构性互斥：在线拉不到本地库，半/全离线拉不到云端）；
 * - 模式       = 个人库可达 → 在线；否则按半/全离线布尔细分；
 *               布尔不可用 → 在线版特征（实测：在线无模式布尔，uuid 探测失败即未登录）。
 */
import type { LibraryScope } from './catalog';
import { edaGlobal } from './host';

export type ClientMode = 'online' | 'half-offline' | 'offline' | 'unknown';

export interface ClientEnv {
	mode: ClientMode;
	/** 判定来源：一次性三源直测 / 不可测。 */
	modeSource: 'probe' | 'unknown';
	isWeb: boolean | null;
	isClient: boolean | null;
	edition: string;
	appVersion: string;
	compliedDate: string;
	username: string;
	/** getUserInfo().uuid —— 即 personalLibraryUuid。 */
	userUuid: string;
	login: boolean;
	personalAvailable: boolean;
	/** 在线团队库（getAllLibrariesList 枚举；无团队时空列表；离线不可达）。 */
	teamAvailable: boolean;
	localAvailable: boolean;
	notes: Array<string>;
}

/** 模式不可随会话变化（切换需重启客户端），进程内缓存一次。 */
let cached: Promise<ClientEnv> | null = null;

export function detectClientEnv(): Promise<ClientEnv> {
	if (!cached) {
		cached = detectInner().catch((e) => {
			cached = null;
			throw e;
		});
	}
	return cached;
}

function modeBoolean(env: Record<string, unknown> | undefined, name: string): boolean | null {
	try {
		const fn = env?.[name];
		if (typeof fn !== 'function')
			return null;
		const v = fn.call(env);
		return typeof v === 'boolean' ? v : null;
	}
	catch {
		return null;
	}
}

async function probePersonalUuid(): Promise<string> {
	const libs = edaGlobal()?.lib_LibrariesList as Record<string, unknown> | undefined;
	const fn = libs?.getPersonalLibraryUuid;
	if (typeof fn !== 'function')
		return '';
	const v = await Promise.resolve(fn.call(libs));
	return typeof v === 'string' ? v : '';
}

async function probeAllLibraries(): Promise<Array<{ name?: unknown; uuid?: unknown }>> {
	const libs = edaGlobal()?.lib_LibrariesList as Record<string, unknown> | undefined;
	const fn = libs?.getAllLibrariesList;
	if (typeof fn !== 'function')
		return [];
	const v = await Promise.resolve(fn.call(libs));
	return Array.isArray(v) ? v : [];
}

async function probeLocalPaths(): Promise<Array<string>> {
	const fs = edaGlobal()?.sys_FileSystem as Record<string, unknown> | undefined;
	const fn = fs?.getLibrariesPaths;
	if (typeof fn !== 'function')
		return [];
	const v = await Promise.resolve(fn.call(fs));
	return Array.isArray(v) ? v : [];
}

async function probeUserInfo(): Promise<{ username: string; uuid: string }> {
	const env = edaGlobal()?.sys_Environment as Record<string, unknown> | undefined;
	const fn = env?.getUserInfo;
	if (typeof fn !== 'function')
		return { username: '', uuid: '' };
	const u = await Promise.resolve(fn.call(env)) as { username?: unknown; uuid?: unknown } | null | undefined;
	if (!u || typeof u !== 'object')
		return { username: '', uuid: '' };
	return {
		username: typeof u.username === 'string' ? u.username : '',
		uuid: typeof u.uuid === 'string' ? u.uuid : '',
	};
}

async function detectInner(): Promise<ClientEnv> {
	const env = edaGlobal()?.sys_Environment as Record<string, unknown> | undefined;

	/* ── 一次性并发探测：三源可达性 + 登录信息，单轮完成 ── */
	const [personalR, allLibsR, pathsR, infoR] = await Promise.allSettled([
		probePersonalUuid(),
		probeAllLibraries(),
		probeLocalPaths(),
		probeUserInfo(),
	]);

	const personalUuid = personalR.status === 'fulfilled' ? String(personalR.value) : '';
	const entries = allLibsR.status === 'fulfilled' ? allLibsR.value : [];
	const paths = pathsR.status === 'fulfilled' ? pathsR.value : [];
	const info = infoR.status === 'fulfilled' ? infoR.value : { username: '', uuid: '' };

	/* 本地路径形态：含盘符/分隔符/.eprj2 后缀（getAllLibrariesList 桌面双语义） */
	const isPathLike = (u: string) => /[\\/]/.test(u) || u.includes(':') || u.endsWith('.eprj2');
	const localEntries = entries.filter(e => typeof e?.uuid === 'string' && isPathLike(e.uuid));

	/* 模式布尔（实测：半/全离线可用；在线版不可用） */
	const halfBool = modeBoolean(env, 'isHalfOfflineMode') === true;
	const offlineBool = modeBoolean(env, 'isOfflineMode') === true;

	/* ── 单次合成判定：探测结果即结论，无兜底链 ── */
	// 在线个人库：getPersonalLibraryUuid 返回非空 uuid（未登录/离线为 null 或抛错）
	const personalAvailable = !!personalUuid;
	// 模式：个人库可达 → 在线；否则按半/全离线布尔（实测半/全离线布尔可用）细分；
	//       布尔不可用 → 在线版特征（实测在线无模式布尔），uuid 探测失败即未登录
	let mode: ClientMode;
	if (personalAvailable)
		mode = 'online';
	else if (halfBool)
		mode = 'half-offline';
	else if (offlineBool)
		mode = 'offline';
	else
		mode = 'online'; /* 模式布尔不可用 = 在线版特征；uuid 探测失败 = 未登录 */

	// 在线团队库：与个人库同属云端在线源（登录即可枚举；无团队时空列表）
	const teamAvailable = mode === 'online';
	// 本地库：结构性互斥——在线拉不到本地库，半/全离线本地库可用
	const localAvailable = mode !== 'online';

	const notes: Array<string> = [];
	notes.push(`一次性探测：在线个人库=${personalAvailable ? '✓' : '✗'} 在线团队库=${teamAvailable ? '✓' : '✗'} 本地库=${localAvailable ? '✓' : '✗'}`);
	notes.push(`探测明细：uuid=${personalUuid || 'null'} 团队/库条目=${entries.length} 本地路径=${paths.length} 本地形态条目=${localEntries.length} 模式布尔=半${halfBool ? '✓' : '✗'}/全${offlineBool ? '✓' : '✗'}`);

	let edition = '';
	if (modeBoolean(env, 'isJLCEDAProEdition') === true)
		edition = 'jlc-eda-pro';
	else if (modeBoolean(env, 'isEasyEDAProEdition') === true)
		edition = 'easyeda-pro';
	else if (modeBoolean(env, 'isProPrivateEdition') === true)
		edition = 'pro-private';

	function textOf(name: string, arg?: unknown): string {
		try {
			const fn = env?.[name];
			if (typeof fn !== 'function')
				return '';
			const v = fn.call(env, arg);
			return typeof v === 'string' ? v : '';
		}
		catch {
			return '';
		}
	}
	const appVersion = textOf('getEditorCurrentVersion', true);
	const compliedDate = textOf('getEditorCompliedDate');

	return {
		mode,
		modeSource: 'probe',
		isWeb: modeBoolean(env, 'isWeb'),
		isClient: modeBoolean(env, 'isClient'),
		edition,
		appVersion,
		compliedDate,
		username: info.username,
		userUuid: info.uuid,
		login: !!info.uuid,
		personalAvailable,
		teamAvailable,
		localAvailable,
		notes,
	};
}

export function modeLabel(mode: ClientMode): string {
	if (mode === 'online')
		return '在线版';
	if (mode === 'half-offline')
		return '半离线版';
	if (mode === 'offline')
		return '全离线版';
	return '模式未判定';
}

/**
 * 有效库范围 = 一次性三源直测的结构性可用性（个人/团队/本地），用户不可更改。
 * 探测失败（异常）时三源全开（各源都试，靠失败隔离兜底）。
 */
export async function effectiveLibraryScope(): Promise<LibraryScope> {
	let env: ClientEnv;
	try {
		env = await detectClientEnv();
	}
	catch {
		return { personal: true, team: true, local: true };
	}
	return { personal: env.personalAvailable, team: env.teamAvailable, local: env.localAvailable };
}

function mark(ok: boolean, label: string, detail: string): string {
	return `${ok ? '✅' : '❌'} ${label.padEnd(22, ' ')} ${detail}`;
}

function probeFn(obj: unknown, path: string): boolean {
	const parts = path.split('.');
	let cur: any = obj;
	for (const p of parts) {
		if (!cur || typeof cur !== 'object')
			return false;
		cur = cur[p];
	}
	return typeof cur === 'function';
}

/** 宿主 API 面自检，供对话工具与设置页共用。 */
export async function runSelfCheck(bridgeVersion: string): Promise<string> {
	const e = edaGlobal();
	const lines: Array<string> = [];
	lines.push(`bridge version          ${bridgeVersion}`);
	try {
		const env = await detectClientEnv();
		lines.push(`🧭 客户端模式            ${modeLabel(env.mode)}（三源直测）· 版次 ${env.edition || '?'} · ${env.appVersion || '版本?'} ${env.compliedDate || ''}`.trimEnd());
		lines.push(`👤 登录                 ${env.login ? `${env.username}（uuid 即 personalLibraryUuid）` : '未登录/未获取'}｜个人库=${env.personalAvailable ? '可用' : '不可达'} 团队库=${env.teamAvailable ? '可用' : '不可达'} 本地库=${env.localAvailable ? '可用' : '不可达'}`);
	}
	catch (err) {
		lines.push(`🧭 客户端模式 检测失败：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!e) {
		lines.push('❌ eda 全局不可用（主进程未注入）');
		return lines.join('\n');
	}
	lines.push(mark(probeFn(e, 'lib_Cbb.search'), 'lib_Cbb.search', '目录拉取（分页 1 起）'));
	lines.push(mark(probeFn(e, 'lib_Cbb.get'), 'lib_Cbb.get', '复用模块图页取图页 uuid（云端模块；本地模块会崩溃，改走 .eprj2 解析）'));
	lines.push(mark(probeFn(e, 'lib_Cbb.modify'), 'lib_Cbb.modify', '模块名称/描述写回'));
	lines.push(mark(probeFn(e, 'sch_PrimitiveComponent.createCbbSymbol'), 'createCbbSymbol', '复用模块符号放置'));
	lines.push(mark(probeFn(e, 'sch_PrimitiveComponent.placeCbbSchematicPage'), 'placeCbbSchematicPage', '复用模块图页放置（落到当前活动图页）'));
	lines.push(mark(probeFn(e, 'dmt_Schematic.createSchematicPage'), 'createSchematicPage', '新建图页'));
	lines.push(mark(probeFn(e, 'dmt_Board.createBoard'), 'createBoard', '新建板子（含原理图）'));
	lines.push(mark(probeFn(e, 'dmt_Project.createProject'), 'createProject', '新建工程'));
	lines.push(mark(probeFn(e, 'dmt_Project.openProject'), 'openProject', '打开工程（会先保存当前工程）'));
	lines.push(mark(probeFn(e, 'sch_Document.save'), 'sch_Document.save', '保存原理图（新建工程前）'));
	lines.push(mark(probeFn(e, 'pcb_Document.save'), 'pcb_Document.save', '保存 PCB（新建工程前）'));
	lines.push(mark(probeFn(e, 'sch_PrimitiveRectangle.create'), 'PrimitiveRectangle.create', '标注框'));
	lines.push(mark(probeFn(e, 'sch_PrimitiveText.create'), 'PrimitiveText.create', '标注标题'));
	lines.push(mark(probeFn(e, 'dmt_SelectControl.getCurrentDocumentInfo'), 'getCurrentDocumentInfo', '文档类型（1=原理图页）'));
	lines.push(mark(probeFn(e, 'sys_ClientUrl.request'), 'sys_ClientUrl.request', 'LLM HTTP（出站代理）'));
	lines.push(mark(probeFn(e, 'sys_FileSystem.saveFile'), 'sys_FileSystem.saveFile', '目录另存'));
	lines.push(mark(probeFn(e, 'sys_Storage.setExtensionUserConfig'), 'sys_Storage', '设置双写兜底'));
	try {
		const sel = e.dmt_SelectControl as { getCurrentDocumentInfo?: () => Promise<{ documentType?: number } | null> } | undefined;
		const doc = typeof sel?.getCurrentDocumentInfo === 'function' ? await sel.getCurrentDocumentInfo() : null;
		lines.push(`📄 当前文档 documentType=${doc?.documentType ?? 'null'}（1=原理图页）`);
	}
	catch (err) {
		lines.push(`📄 当前文档 读取失败：${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		const libs = e.lib_LibrariesList as { getPersonalLibraryUuid?: () => Promise<string | null> } | undefined;
		const personal = typeof libs?.getPersonalLibraryUuid === 'function' ? await libs.getPersonalLibraryUuid() : null;
		lines.push(`📚 个人库 uuid=${personal || 'null（未登录/私有化/离线模式）'}`);
	}
	catch (err) {
		lines.push(`📚 个人库 读取失败：${err instanceof Error ? err.message : String(err)}`);
	}
	return lines.join('\n');
}

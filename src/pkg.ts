import type { CatalogFetchReport, CatalogJson, CatalogStatsView } from './catalog';
/**
 * 模块工程包：本地模块 .eprj2 打包导出 / zip 导入本地库。
 * 边界（2026-09-15 实测）：
 * - 云端模块工程数据在立创服务器，无下载 API——导出 zip 内不含其工程文件，仅 catalog.json 清单留痕。
 * - 导入写回本地库目录（settings 的本地库路径），宿主识别新文件可能需重启客户端；在线客户端本地库不可见（宿主限制）。
 * - zip 打包用 JSZip（依赖已随构建打包）。
 */
import JSZip from 'jszip';
import { fetchCatalog, matchLocalEprjRow } from './catalog';
import { effectiveLibraryScope } from './env';
import { edaGlobal } from './host';
import { getLocalLibraryPath } from './settings';

export interface PackageExportResult {
	ok: boolean;
	/** 打包进 zip 的本地工程文件数。 */
	fileCount: number;
	/** 无法打包的云端模块数。 */
	cloudCount: number;
	/** 读取失败清单（模块名 + 原因）。 */
	failed: Array<{ name: string; error: string }>;
	/** 导出的文件名（另存对话框确认后）。 */
	fileName?: string;
	/** 用户取消另存。 */
	cancelled?: boolean;
	/** 本次拉取的目录统计。 */
	stats: CatalogStatsView;
}

export interface PackageImportResult {
	ok: boolean;
	/** 成功写入本地库目录的文件名。 */
	imported: Array<string>;
	/** 写入失败清单。 */
	failed: Array<{ file: string; error: string }>;
	/** 写入目标目录。 */
	targetDir: string;
	/** 提示（如需重启客户端）。 */
	note?: string;
}

interface FileSystemApi {
	saveFile?: (fileData: Blob | File, fileName?: string) => Promise<void>;
	readFileFromFileSystem?: (path: string) => Promise<Blob | undefined>;
	listFilesOfFileSystem?: (path: string) => Promise<Array<{ name?: string; isDirectory?: boolean; fullPath?: string }>>;
	saveFileToFileSystem?: (dir: string, data: Blob | File, fileName: string) => Promise<unknown>;
	openReadFileDialog?: (extensions: Array<string>, multiFiles?: boolean) => Promise<unknown>;
}

function fs(): FileSystemApi {
	return (edaGlobal()?.sys_FileSystem ?? undefined) as FileSystemApi;
}

interface ClientFsApi extends FileSystemApi {
	readFileFromFileSystem: (path: string) => Promise<Blob | undefined>;
	saveFile: (fileData: Blob | File, fileName?: string) => Promise<void>;
	listFilesOfFileSystem: (path: string) => Promise<Array<{ name?: string; isDirectory?: boolean; fullPath?: string }>>;
}

function requireClientFs(): ClientFsApi {
	const api = fs();
	if (!api?.readFileFromFileSystem || !api?.saveFile || !api?.listFilesOfFileSystem)
		throw new Error('sys_FileSystem 不可用（工程包导出/导入仅客户端环境支持）');
	return api as ClientFsApi;
}

function stamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** zip 内条目名安全化：去路径分隔与非法字符，追加 uuid 前 8 位防重名。 */
function zipEntryName(moduleName: string, uuid: string): string {
	const base = (moduleName || 'module').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'module';
	return `${base}-${uuid.slice(0, 8)}.eprj2`;
}

/**
 * 导出模块工程包：勾选模块的 .eprj2 + catalog.json 清单（同样按勾选过滤）→ 另存 zip。
 * snapshot：确认卡对应的会话目录快照（与用户确认的内容同源）。传入时跳过重新拉取，
 * 避免确认后重拉导致清单与卡片不一致；模块的磁盘文件定位仍在导出时按实况执行。
 */
export async function exportProjectPackage(selectedUuids: Array<string>, snapshot?: CatalogJson): Promise<PackageExportResult> {
	const api = requireClientFs();
	const report: CatalogFetchReport = snapshot
		? {
				catalog: snapshot,
				totalModules: snapshot.libraries.reduce((n, lib) => n + lib.modules.length, 0),
				failedLibraries: snapshot.libraries.filter(lib => lib.failed).length,
				elapsedMs: 0,
			}
		: await fetchCatalog(await effectiveLibraryScope());
	// 只保留勾选模块；勾选后为空的库整条剔除
	const selected = new Set(selectedUuids);
	report.catalog.libraries = report.catalog.libraries
		.map(lib => ({ ...lib, modules: lib.modules.filter(m => selected.has(m.uuid)) }))
		.filter(lib => lib.modules.length > 0);
	report.totalModules = report.catalog.libraries.reduce((n, lib) => n + lib.modules.length, 0);
	const stats: CatalogStatsView = {
		libraries: report.catalog.libraries.length,
		modules: report.totalModules,
		emptyDesc: report.catalog.libraries.reduce((n, lib) => n + lib.modules.filter(m => !String(m.description || '').trim()).length, 0),
		failed: report.failedLibraries,
		elapsedMs: report.elapsedMs,
	};
	const failed: Array<{ name: string; error: string }> = [];
	const zip = new JSZip();
	const usedNames = new Set<string>();
	let fileCount = 0;
	let cloudCount = 0;

	for (const lib of report.catalog.libraries) {
		// 本地库：列出库目录下全部 .eprj2，按「文件名主干 = 模块名」定位文件。
		// 导入模块的 uuid 是客户端重新分配的（与文件内容中的源 uuid 不同），uuid 索引对它必然失效，
		// 文件名是原生/导入模块通用的可靠键（实测 2026-09-16）。
		let libFiles: Array<{ name: string; fullPath: string }> = [];
		if (lib.libraryKind === 'local' && lib.libraryUuid) {
			try {
				libFiles = ((await api.listFilesOfFileSystem(lib.libraryUuid)) || [])
					.filter(r => !r.isDirectory && /\.eprj2$/i.test(String(r.name || '')))
					.map(r => ({ name: String(r.name), fullPath: r.fullPath || `${lib.libraryUuid.replace(/[\\/]+$/, '')}/${r.name}` }));
			}
			catch { /* 列目录失败按未解析处理 */ }
		}
		for (const m of lib.modules) {
			if (lib.libraryKind !== 'local') {
				cloudCount++;
				continue;
			}
			m.storage = 'local';
			// 文件定位统一走 catalog.matchLocalEprjRow（文件名主干 = 模块名，全项目唯一实现）。
			const hit = matchLocalEprjRow(libFiles, m.name);
			if (!hit) {
				failed.push({ name: m.name, error: '本地库目录中未找到对应的 .eprj2 工程文件' });
				continue;
			}
			m.localFilePath = hit.fullPath;
			m.filePathSource = 'indexed';
			try {
				const blob = await api.readFileFromFileSystem(hit.fullPath);
				if (!blob)
					throw new Error('读取返回空');
				let entry = zipEntryName(m.name, m.uuid);
				while (usedNames.has(entry))
					entry = zipEntryName(`${m.name}-${stamp()}`, m.uuid);
				usedNames.add(entry);
				zip.file(`modules/${entry}`, blob);
				fileCount++;
			}
			catch (e) {
				failed.push({ name: m.name, error: e instanceof Error ? e.message : String(e) });
			}
		}
	}

	// 清单：完整目录快照（含 boards/localFilePath/localBackupDir），消费方可溯源
	zip.file('catalog.json', JSON.stringify(report.catalog, null, '\t'));
	const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
	const fileName = `cbb-modules-${stamp()}.zip`;
	try {
		await api.saveFile(blob, fileName);
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/取消|cancel/i.test(msg))
			return { ok: false, fileCount, cloudCount, failed, cancelled: true, stats };
		throw new Error(`保存 zip 失败：${msg}`);
	}
	return { ok: true, fileCount, cloudCount, failed, fileName, stats };
}

/** 导入模块工程包：选 zip → 解包 modules/*.eprj2 → 写回本地库目录（重名加后缀防覆盖）。 */
/**
 * 对话框返回 → zip 数据源。
 * 实测 3.2.166 客户端：openReadFileDialog 直接返回 File 文件对象（带 size 与 arrayBuffer），而非路径；
 * 按 File 对象取数据是唯一经过真机验证的生效路径（此前按路径二次读取会产生垃圾字节，已移除）。
 */
async function pickZipBlob(api: ClientFsApi): Promise<{ data: Blob; name: string } | { data: null; reason: string }> {
	const dialog = api.openReadFileDialog;
	if (typeof dialog !== 'function')
		throw new Error('sys_FileSystem.openReadFileDialog 不可用');
	const picked = await dialog(['zip']);
	if (picked === undefined || picked === null)
		return { data: null, reason: '未选择文件' };
	if (typeof picked === 'object' && !Array.isArray(picked)) {
		const o = picked as { size?: unknown; arrayBuffer?: unknown; name?: unknown; canceled?: unknown };
		if (o.canceled === true)
			return { data: null, reason: '已取消选择' };
		if (typeof o.size === 'number' && typeof o.arrayBuffer === 'function')
			return { data: picked as unknown as Blob, name: typeof o.name === 'string' ? o.name : '' };
	}
	throw new Error(`文件选择对话框返回了无法识别的形态（${JSON.stringify(picked).slice(0, 120)}）`);
}

function headHex(bytes: Uint8Array): string {
	return Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

export async function importProjectPackage(): Promise<PackageImportResult> {
	const api = requireClientFs();
	if (typeof api.openReadFileDialog !== 'function' || typeof api.saveFileToFileSystem !== 'function')
		throw new Error('sys_FileSystem 文件选择/写入接口不可用（仅客户端环境支持）');
	const pickedZip = await pickZipBlob(api);
	if (!pickedZip.data)
		return { ok: false, imported: [], failed: [], targetDir: '', note: pickedZip.reason };

	const targetDir = getLocalLibraryPath().replace(/[\\/]+$/, '');
	// 客户端 File/Blob 为非标准实现，JSZip 内部 Blob 读取器会拿到空数据（实测报"找不到中央目录"）；
	// 显式取字节后以 Uint8Array 交给 JSZip（其最基础输入类型）。
	const bytes = new Uint8Array(await pickedZip.data.arrayBuffer());
	if (!bytes.length)
		throw new Error(`所选文件读取为空（0 字节）：${pickedZip.name}`);
	// zip 完整性预检：EOCD 标记（PK\x05\x06）必须存在于末尾 64KB，否则给出可读诊断而非 JSZip 内部报错
	let hasEocd = false;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65536); i--) {
		if (bytes[i] === 0x50 && bytes[i + 1] === 0x4B && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
			hasEocd = true;
			break;
		}
	}
	if (!hasEocd)
		throw new Error(`所选文件不是有效的 zip（${bytes.length} 字节，文件头 ${headHex(bytes)}）：${pickedZip.name}`);
	const zip = await JSZip.loadAsync(bytes);

	// 现有文件名集合：防覆盖（.eprj2 文件名 = 模块显示名，覆盖会损坏既有模块）
	const existing = new Set<string>();
	try {
		for (const row of (await api.listFilesOfFileSystem(targetDir)) || []) {
			if (row && !row.isDirectory && typeof row.name === 'string')
				existing.add(row.name.toLowerCase());
		}
	}
	catch { /* 列目录失败时不做重名保护，仍尝试写入 */ }

	const imported: Array<string> = [];
	const failed: Array<{ file: string; error: string }> = [];
	const entries = Object.values(zip.files).filter(f => !f.dir && /^modules\/.+\.eprj2$/i.test(f.name));
	if (!entries.length)
		throw new Error('zip 中未找到 modules/*.eprj2 工程文件（请确认是本插件导出的工程包）');

	for (const entry of entries) {
		const base = entry.name.split('/').pop() || 'module.eprj2';
		let finalName = base;
		try {
			if (existing.has(finalName.toLowerCase())) {
				const dot = base.lastIndexOf('.');
				finalName = `${base.slice(0, dot)}-imported-${stamp()}${base.slice(dot)}`;
			}
			const data = await entry.async('blob');
			await api.saveFileToFileSystem(`${targetDir}/`, data, finalName);
			existing.add(finalName.toLowerCase());
			imported.push(finalName);
		}
		catch (e) {
			failed.push({ file: base, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return {
		ok: failed.length === 0,
		imported,
		failed,
		targetDir,
		note: '若本地库面板未立即出现新模块，请重启客户端后刷新目录。',
	};
}

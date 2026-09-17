/**
 * 系统提示与 LLM 可见工具。写工具（place/edit/export）不在此表，必须经确认卡令牌。
 */
import type { CatalogJson } from '../catalog';
import { pageSupportOf } from '../catalog';

const MAX_CATALOG_ITEMS = 500;
/** 模块描述长度上限：目录载荷截断与 propose_edit 运行时校验共用同一口径（提示词里的 ≤300 字）。 */
export const MAX_DESC_LEN = 300;

export const AGENT_SYSTEM_PROMPT = [
	'你是嘉立创EDA的复用模块（CBB）对话助手。用户用自然语言找模块、改描述、导出目录。',
	'规则：',
	'1. 只能调用提供的工具。禁止声称已经放置、已经写库或已经导出——这些必须等用户在确认卡片上点确认。',
	'2. 需要推荐模块时调用 propose_placement；cbbUuid 必须逐字复制自目录，禁止编造。',
	'3. 需要改名称/描述时：先对目标模块调用 inspect_module 读取其自带原理图内容（器件清单/网络名/文字标注），据此**直接分析**出建议名称与描述，不要反问用户要信息；随后调用 propose_edit 出卡。描述用中文、≤300字，可按【功能】【输入输出】【参数】【注意事项】组织；名称简洁准确。三种库（个人/团队/本地）都支持读取；仅当读取失败时，才退化为基于目录信息提议或请用户补充。',
	'4. 需要导出目录或模块工程包时调用 propose_export（产出 zip：内含 catalog.json 清单与本地模块工程文件）。',
	'5. 目录快照不存在或已失效时（上下文会明确标注），必须先调用 get_catalog 获取目录，再执行推荐/编辑/导出等需要目录的工具；目录已在上下文中时不要重复调用，除非用户明确要求刷新。',
	'6. 放置位置由插件自动计算：统一按对齐网格排列（列对齐、行对齐、等间距，单个模块同样适用），并自动避开图页已占用区域。不要向用户询问坐标，也不要填 x/y、旋转或镜像。',
	'7. 放置形式 mode 二选一：page（复用模块图页，默认）、symbol（复用模块符号）。默认一律用 page——模块符号可能尚未生成（空符号不可见且会重叠），只有用户明确说"用符号/放符号"才用 symbol。两种形式都会用矩形框 + 模块名标题标注。三种库（个人/团队/本地）都支持两种形式。',
	'8. 放置位置 target 四选一：current（当前图页，默认）、new（新建图页）、board（当前工程下新建板子+原理图）、project（新建工程后放置）。用户说「单独一页」用 new；「新板子」「新原理图」用 board；「新工程」用 project。',
	'9. 没有合适模块时 picks 为空数组，并在 notFoundHint 与回复正文说明：可把开源广场模块复制到个人库/团队库后再刷新目录。',
	'10. 回复用中文，可用 Markdown 排版提升可读性：**加粗**模块名与关键参数、行内代码 `uuid`、列表、表格、```围栏代码块```。不要输出图片和 HTML 标签。不要在回复中写出 apiKey 或完整密钥。',
	'11. 可以新建图页、新建板子或新建工程后再放置。新建工程会先保存当前工程再切换，避免未保存弹窗阻塞；确认卡上须让用户知情。',
].join('\n');

const GET_CATALOG_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		force: { type: 'boolean', description: 'true 时强制重新拉取目录并作废未处理确认卡' },
	},
} as const;

const PROPOSE_PLACEMENT_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		picks: {
			type: 'array',
			description: '推荐模块，按匹配度从高到低，推荐 1～3 个，最多 20 个（确认卡支持网格批量放置）',
			maxItems: 20,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					cbbUuid: { type: 'string', description: '必须逐字复制自目录' },
					name: { type: 'string', description: '回显目录中的模块名' },
					reason: { type: 'string', description: '一句话中文推荐理由' },
					mode: { type: 'string', enum: ['symbol', 'page'], description: '放置形式：page=复用模块图页（默认，优先用）；symbol=复用模块符号（仅用户明确要求时用，模块可能未生成���号）。两种都会标注框+标题' },
					target: { type: 'string', enum: ['current', 'new', 'board', 'project'], description: '放置位置：current=当前图页（默认）；new=新建图页；board=当前工程新建板子+原理图；project=新建工程后放置' },
				},
				required: ['cbbUuid', 'name', 'reason'],
			},
		},
		notFoundHint: { type: 'string', description: '没有合适模块时的说明' },
	},
	required: ['picks'],
} as const;

const PROPOSE_EDIT_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		cbbUuid: { type: 'string', description: '必须逐字复制自目录' },
		name: { type: 'string', description: '建议名称，空则沿用目录' },
		description: { type: 'string', description: '建议描述，中文，空则沿用目录；不超过 300 字', maxLength: 300 },
	},
	required: ['cbbUuid'],
} as const;

const INSPECT_MODULE_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		cbbUuid: { type: 'string', description: '必须逐字复制自目录' },
	},
	required: ['cbbUuid'],
} as const;

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;

/**
 * 工具注册表（单一事实源）：名称 / 描述 / 参数 schema 全部只在这里登记；
 * AgentToolName 与 AGENT_TOOL_NAMES 由本表推导，loop.ts 的执行分发表（Record<AgentToolName, Handler>）
 * 受类型穷尽约束——新增工具只需在本表登记一处，漏实现会得到编译错误。
 */
export const AGENT_TOOLS = [
	{ name: 'get_catalog', description: '拉取或刷新复用模块目录（个人库 + 团队库 + 本地库）。会话已有快照时不要重复调用，除非 force。', parameters: GET_CATALOG_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_placement', description: '向用户出示放置确认卡（不会真正放置）。选出匹配模块并给出放置形式（符号或图页）与位置（当前图页 / 新建图页 / 新建板子 / 新建工程）。落点由插件自动排布，无需坐标。', parameters: PROPOSE_PLACEMENT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'inspect_module', description: '读取模块（个人库/团队库/本地库）自带原理图页的内容摘要：器件清单（位号/名称/器件名/封装）、网络名、文字标注。只读不改画布（本地库通过临时页方式，读取后自动删除）。用于在改名称/描述前自动分析模块功能。', parameters: INSPECT_MODULE_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_edit', description: '向用户出示模块名称/描述编辑确认卡（不会真正写库）。', parameters: PROPOSE_EDIT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_export', description: '向用户出示工程包导出确认卡（不会真正写文件）。产出 zip：catalog.json 清单 + 本地模块 .eprj2 工程文件；用户可在卡上勾选要导出的模块，云端模块仅清单留痕。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
	{ name: 'self_check', description: '探测宿主 API 与桥接是否可用，返回诊断文本。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
	{ name: 'goto_settings', description: '打开设置页，让用户检查 API Key / baseUrl / 库范围。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number]['name'];

/** 运行时工具名清单（loop.isAgentToolName 用），由注册表推导，不会漂移。 */
export const AGENT_TOOL_NAMES: ReadonlyArray<string> = AGENT_TOOLS.map(t => t.name);

export function toolsOpenAiChat(): unknown {
	return AGENT_TOOLS.map(t => ({
		type: 'function',
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
}

export function toolsOpenAiResponses(): unknown {
	return AGENT_TOOLS.map(t => ({
		type: 'function',
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}

export function toolsAnthropic(): unknown {
	return AGENT_TOOLS.map(t => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));
}

export function buildAgentCatalogPayload(catalog: CatalogJson): string {
	const modules: Array<Record<string, unknown>> = [];
	let total = 0;
	for (const lib of catalog.libraries) {
		if (lib.failed)
			continue;
		total += lib.modules.length;
		for (const m of lib.modules) {
			if (modules.length >= MAX_CATALOG_ITEMS)
				break;
			modules.push({
				uuid: m.uuid,
				name: m.name,
				description: (m.description || '').slice(0, MAX_DESC_LEN),
				classification: m.classification || [],
				libraryKind: lib.libraryKind,
				libraryUuid: lib.libraryUuid,
				pageSupport: pageSupportOf(lib.libraryKind),
			});
		}
	}
	const failed = catalog.libraries.filter(l => l.failed).map(l => ({ name: l.moduleName, error: l.error }));
	return JSON.stringify({
		moduleCount: total,
		listed: modules.length,
		truncated: total > modules.length,
		failedLibraries: failed,
		modules,
	});
}

/**
 * 系统提示与 LLM 可见工具。写工具（place/edit/export）不在此表，必须经确认卡令牌。
 */
/** 模块描述长度上限：propose_edit 运行时校验口径（提示词里的 ≤300 字）。 */
export const MAX_DESC_LEN = 300;

export const AGENT_SYSTEM_PROMPT = [
	'你是嘉立创EDA的复用模块（CBB）对话助手。用户用自然语言找模块、改描述、导出目录。',
	'规则：',
	'1. 只能调用提供的工具。禁止声称已经放置、已经写库或已经导出——这些必须等用户在确认卡片上点确认。',
	'2. 模块明细不在上下文中。需要找模块时调用 search_modules（关键词检索）；要推荐/放置/编辑某个模块前，先用 get_module 拿到该模块的 cbbUuid 与详情；cbbUuid 必须逐字复制自工具返回，禁止编造。',
	'3. 需要改名称/描述时：先对目标模块调用 inspect_module 读取其自带原理图内容（器件清单/网络名/文字标注），据此**直接分析**出建议名称与描述，不要反问用户要信息；随后调用 propose_edit 出卡。描述用中文、≤300字，可按【功能】【输入输出】【参数】【注意事项】组织；名称简洁准确。三种库（个人/团队/本地）都支持读取；仅当读取失败时，才退化为基于目录信息提议或请用户补充。',
	'4. 需要导出目录或模块工程包时调用 propose_export（产出 zip：内含 catalog.json 清单与本地模块工程文件）。',
	'5. 目录持久化在插件存储中，跨会话可用。上下文中的目录摘要标注了拉取时间（如「3 天前」）；摘要 stale 标记为 true 或用户明确要求刷新时调用 refresh_catalog，其余情况用 search_modules 查询即可，不要重复刷新。',
	'6. 放置位置由插件自动计算：统一按对齐网格排列（列对齐、行对齐、等间距，单个模块同样适用），并自动避开图页已占用区域。不要向用户询问坐标，也不要填 x/y、旋转或镜像。',
	'7. 放置形式 mode 二选一：page（复用模块图页，默认）、symbol（复用模块符号）。默认一律用 page——模块符号可能尚未生成（空符号不可见且会重叠），只有用户明确说"用符号/放符号"才用 symbol。两种形式都会用矩形框 + 模块名标题标注。三种库（个人/团队/本地）都支持两种形式。',
	'8. 放置位置 target 四选一：current（当前图页，默认）、new（新建图页）、board（当前工程下新建板子+原理图）、project（新建工程后放置）。用户说「单独一页」用 new；「新板子」「新原理图」用 board；「新工程」用 project。',
	'9. 没有合适模块时 picks 为空数组，并在 notFoundHint 与回复正文说明：可把开源广场模块复制到个人库/团队库后调用 refresh_catalog 刷新目录。',
	'10. 回复用中文，可用 Markdown 排版提升可读性：**加粗**模块名与关键参数、行内代码 `uuid`、列表、表格、```围栏代码块```。不要输出图片和 HTML 标签。不要在回复中写出 apiKey 或完整密钥。',
	'11. 可以新建图页、新建板子或新建工程后再放置。新建工程会先保存当前工程再切换，避免未保存弹窗阻塞；确认卡上须让用户知情。',
	'12. 对话较长（上下文摘要显示轮数超过 8）或发现缺少早期对话中的约定/结果时，调用 compact_history 折叠早期对话：summary 写入自足的中文摘要（用户的要求与约束、已完成/进行中的事项、已达成的决定）；最近几轮会原样保留，不影响当前任务。',
].join('\n');

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

const SEARCH_MODULES_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		query: { type: 'string', description: '检索关键词：空格分隔多个词，逐词 AND 匹配模块名称/分类/描述（如「3.3 LDO」「以太网 PHY」）。空串返回按库序的前若干条（浏览用）。' },
		limit: { type: 'number', description: '最多返回条数，默认 10，上限 30。' },
	},
	required: ['query'],
} as const;

const GET_MODULE_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		cbbUuid: { type: 'string', description: '模块 uuid，必须逐字来自 search_modules 的返回' },
	},
	required: ['cbbUuid'],
} as const;

const REFRESH_CATALOG_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {},
} as const;

const EMPTY_PARAMS = { type: 'object', properties: {}, additionalProperties: false } as const;

const COMPACT_HISTORY_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		summary: { type: 'string', description: '此前对话的自足中文摘要：用户提出的要求与约束、已完成/进行中的事项、已达成的决定、未解决的问题。写入后早期对话将被折叠，此后只能看到本摘要与最近几轮。' },
	},
	required: ['summary'],
} as const;

/**
 * 工具注册表（单一事实源）：名称 / 描述 / 参数 schema 全部只在这里登记；
 * AgentToolName 与 AGENT_TOOL_NAMES 由本表推导，loop.ts 的执行分发表（Record<AgentToolName, Handler>）
 * 受类型穷尽约束——新增工具只需在本表登记一处，漏实现会得到编译错误。
 */
export const AGENT_TOOLS = [
	{ name: 'search_modules', description: '按关键词检索复用模块目录（个人库 + 团队库 + 本地库）。空格分词逐词 AND，匹配名称/分类/描述；返回紧凑条目（uuid/名称/分类/库类型）。空 query 返回前若干条用于浏览。', parameters: SEARCH_MODULES_PARAMS as unknown as Record<string, unknown> },
	{ name: 'get_module', description: '读取单个模块的完整详情：名称、描述、分类、boards（自带原理图/PCB uuid）、云端/本地存储标记、本地文件路径。cbbUuid 必须来自 search_modules。', parameters: GET_MODULE_PARAMS as unknown as Record<string, unknown> },
	{ name: 'refresh_catalog', description: '重新拉取全部库的模块目录并落盘持久化（首次约 20 秒）。上下文中的目录摘要标注数据较旧（stale）或用户明确要求刷新时调用；其余情况用 search_modules 即可。', parameters: REFRESH_CATALOG_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_placement', description: '向用户出示放置确认卡（不会真正放置）。选出匹配模块并给出放置形式（符号或图页）与位置（当前图页 / 新建图页 / 新建板子 / 新建工程）。落点由插件自动排布，无需坐标。', parameters: PROPOSE_PLACEMENT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'inspect_module', description: '读取模块（个人库/团队库/本地库）自带原理图页的内容摘要：器件清单（位号/名称/器件名/封装）、网络名、文字标注。只读不改画布（本地库通过临时页方式，读取后自动删除）。用于在改名称/描述前自动分析模块功能。', parameters: INSPECT_MODULE_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_edit', description: '向用户出示模块名称/描述编辑确认卡（不会真正写库）。', parameters: PROPOSE_EDIT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_export', description: '向用户出示工程包导出确认卡（不会真正写文件）。产出 zip：catalog.json 清单 + 本地模块 .eprj2 工程文件；用户可在卡上勾选要导出的模块，云端模块仅清单留痕。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
	{ name: 'self_check', description: '探测宿主 API 与桥接是否可用，返回诊断文本。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
	{ name: 'compact_history', description: '折叠早期对话：用一段摘要替换较早的历史（最近几轮原样保留），防止上下文膨胀与早期信息丢失。上下文摘要显示轮数超过 8、或你发现缺少早期对话中的约定/结果时调用；把此前对话的完整摘要写入 summary。', parameters: COMPACT_HISTORY_PARAMS as unknown as Record<string, unknown> },
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

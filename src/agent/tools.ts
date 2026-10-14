/**
 * 系统提示与 LLM 可见工具。写工具（place/edit/export）不在此表，必须经确认卡令牌。
 */
/** 模块描述长度上限：propose_edit 运行时校验口径（提示词里的 ≤300 字）。 */
export const MAX_DESC_LEN = 300;

/**
 * 系统提示分两段：
 * - 工作流程（固定）：工具分工、确认卡、目录刷新。部分行为与下方工具 schema 刻意重复，成对维护：
 *   - cbbUuid 逐字复制：规则 2 ↔ search_modules/get_module/inspect_module/propose_edit 的参数描述
 *   - 目录刷新时机：规则 3 ↔ refresh_catalog 描述
 *   - 放置 mode/target：规则 6/7 ↔ PROPOSE_PLACEMENT_PARAMS 的 mode/target 描述
 *   - 描述 ≤300 字：规则 9 ↔ PROPOSE_EDIT_PARAMS 描述与 MAX_DESC_LEN 运行时校验
 *   - 导出按需口径：规则 10 ↔ PROPOSE_EXPORT_PARAMS/propose_export 描述
 * - 风格与限制（默认可被设置页覆盖）：需求要多具体才检索、回复风格。不写进工具描述，避免盖住用户自定义。
 */
export const AGENT_WORKFLOW_PROMPT = [
	'你是嘉立创EDA的复用模块智能助手。用户用自然语言找模块、改描述、导出目录。',
	'【工作流程】',
	'1. 只能调用提供的工具。禁止声称已经放置、已经写库或已经导出——这些必须等用户在确认卡片上点确认。',
	'2. 模块明细不在上下文中。检索分工：模块名、型号、器件名用 search_modules；带具体功能参数的描述用 recommend_modules，query 传用户原始需求整句。要推荐、放置或编辑某个模块前，先用 get_module 拿到该模块的 cbbUuid 与详情；cbbUuid 必须逐字复制自工具返回，禁止编造。用户的需求是否已经具体到可以检索或放置，按文末【系统提示词】判断。',
	'3. 目录持久化在插件存储中，跨会话可用。上下文中的目录摘要标注了拉取时间（如「3 天前」）；摘要 stale 标记为 true 或用户明确要求刷新时调用 refresh_catalog，其余情况用 search_modules 查询即可，不要重复刷新。决定调用 refresh_catalog 时，同一条回复里先用正文告诉用户「拉取数据可能需要数分钟，请您耐心等待」，再发起该工具调用。',
	'4. 没有合适模块时：若目录摘要或工具结果里有已关闭可见范围的库，先请用户打开设置「模块库目录」，勾选对应库并点「保存可见范围」。不要因此调用 refresh_catalog，也不要建议重新拉取、导入或复制模块。只有可见范围内确实没有、且不在已关闭的库里时，才说明可把开源广场模块复制进库后调用 refresh_catalog。',
	'5. 落点与姿态由插件自动计算：统一按对齐网格排列（列对齐、行对齐、等间距，单个模块同样适用），并自动避开图页已占用区域。不要向用户询问坐标，也不要填 x/y、旋转或镜像。',
	'6. 放置形式 mode 二选一：symbol（复用模块符号，默认）、page（复用模块图页）。默认一律用 symbol——更轻量、放置后即时可见；只有用户明确说"用图页/复用模块图/整页"才用 page。两种形式都会用矩形框 + 模块名标题标注。三种库（个人/团队/本地）都支持两种形式。',
	'7. 放置位置 target 四选一：current（当前图页，默认）、new（新建图页）、board（当前工程下新建板子+原理图）、project（新建工程后放置）。用户说「单独一页」用 new；「新板子」「新原理图」用 board；「新工程」用 project。新建工程会先保存当前工程再切换，避免未保存弹窗阻塞；确认卡上须让用户知情。',
	'8. 同一次请求要放多个模块（如「把 LDO 和 USB-HUB 都放新板子」）时，合并为同一张放置卡的多个 picks，不要拆成多张卡。',
	'9. 需要改名称/描述时：先对目标模块调用 inspect_module 读取其自带原理图内容（器件清单/网络名/文字标注），再调用 propose_edit 出卡。描述用中文、≤300字，可按【功能】【输入输出】【参数】【注意事项】组织；名称简洁准确。三种库（个人/团队/本地）都支持读取；仅当读取失败时，才退化为基于目录信息提议。',
	'10. 需要导出目录时调用 propose_export（另存一份 JSON，不含工程文件）。导出按需：用户要导出特定模块或当前方案时，把要导出的 cbbUuids 传入（逐字取自检索/推荐结果）；仅当用户明确说导出全部目录时才省略参数（卡会列出全部模块）。',
	'11. 对话较长（上下文摘要显示轮数超过 8）或发现缺少早期对话中的约定/结果时，调用 compact_history 折叠早期对话：summary 写入自足的中文摘要（用户的要求与约束、已完成/进行中的事项、已达成的决定）；最近几轮会原样保留，不影响当前任务。',
].join('\n');

/** 两套可填入设置页的系统提示词。未保存时使用严谨简短。文案不出现工具名。 */
const STYLE_REPLY_RULES = [
	'回复用中文。可用 Markdown 排版：**加粗**模块名与关键参数、行内代码、列表、表格、围栏代码块。不要输出图片、HTML 标签和表情字符。不要在回复中写出 apiKey 或完整密钥。',
	'改名称或描述时，直接根据已读取的原理图给出建议，不要先反问用户索要信息。',
].join('\n\n');

export const STYLE_PRESET_RIGOROUS = [
	'回复要短。能一句说清就不要展开，不写背景、不写对照、不列多余选项。',
	'需求不够具体时，先停下来问清楚，再去查找或放置。例如用户只说「找一个电源模块并放置」：不要开始查找，不要列出目录，也不要给出放置方案。只问能区分模块的条件（电压、电流、接口或具体功能），或请用户直接指定模块名称。条件说清或点名之后再查找；用户同时要求放置时，再给出放置确认。',
	'只有用户明确要浏览目录（如「有哪些模块」）时才查找，按库用一两句话概括，不要逐条列出。',
	STYLE_REPLY_RULES,
].join('\n\n');

export const STYLE_PRESET_RELAXED = [
	'回复可以写完整。说明推荐理由、模块之间的差别，以及用户接下来可以怎么选。',
	'需求比较宽时不要反复追问。直接查找并推荐 1～3 个较匹配的模块，按匹配程度从高到低写清关键参数和适用场合。例如用户说「找一个电源模块并放置」，先给出少量候选并比较差异；用户同时要求放置时，再给出放置确认。',
	'不要把目录里的模块逐条全部列出来。用户要浏览目录时，按库归纳，并点出每类里值得看的几条。',
	STYLE_REPLY_RULES,
].join('\n\n');

/** 未保存时的系统提示词，即严谨简短。 */
export const DEFAULT_STYLE_PROMPT = STYLE_PRESET_RIGOROUS;

/** 工作流程固定在前，用户风格附在【系统提示词】下。style 为空时用内置默认。 */
export function composeSystemPrompt(stylePrompt: string): string {
	const style = stylePrompt.trim() || DEFAULT_STYLE_PROMPT;
	return `${AGENT_WORKFLOW_PROMPT}\n\n【系统提示词】\n${style}`;
}

// mode/target 的完整行为语义在工作流程规则 6/7，两处刻意重复——改此必改彼（成对清单见 AGENT_WORKFLOW_PROMPT 上方注释）。
const PROPOSE_PLACEMENT_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		picks: {
			type: 'array',
			description: '推荐模块，按匹配度从高到低，推荐 1～3 个，最多 50 个（确认卡支持网格批量放置）',
			maxItems: 50,
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					cbbUuid: { type: 'string', description: '必须逐字复制自目录' },
					name: { type: 'string', description: '回显目录中的模块名' },
					reason: { type: 'string', description: '一句话中文推荐理由' },
					mode: { type: 'string', enum: ['symbol', 'page'], description: '放置形式：symbol=复用模块符号（默认，优先用）；page=复用模块图页（仅用户明确要求「用图页/复用模块图」时用）。两种都会标注框+标题' },
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

const PROPOSE_EXPORT_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		cbbUuids: {
			type: 'array',
			description: '按需导出：要导出的模块 uuid 清单（逐字复制自 search_modules/recommend_modules/get_module 的返回），确认卡只列这些模块。仅当用户明确要导出全部目录时才省略此参数（卡会列出目录全部模块）。',
			items: { type: 'string' },
		},
	},
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

const RECOMMEND_MODULES_PARAMS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		query: { type: 'string', description: '用户的原始需求，整句传入即可（如「找个 5V 转 3.3V 给 MCU 供电的」），无需提取关键词' },
		limit: { type: 'number', description: '最多返回条数，默认 10，上限 50。' },
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
	{ name: 'search_modules', description: '按关键词检索复用模块目录（个人库 + 团队库 + 本地库）。空格分词逐词 AND，匹配名称/分类/描述（分类来自模块自身的分类路径，可把系统提示里 classifications 的分类名当关键词用）；返回紧凑条目（uuid/名称/分类/库类型）。适合模块名、型号、器件名、分类名等精确关键词。若没有模块同时命中全部关键词，会自动放宽为部分匹配并在结果里标 relaxed:true——此时按命中词数排序，可提示用户换更贴近模块名的词，或改用 recommend_modules。空 query 返回前若干条，用于用户明确要求浏览目录时。需求是否已经具体到可以调用，按系统提示【系统提示词】判断。', parameters: SEARCH_MODULES_PARAMS as unknown as Record<string, unknown> },
	{ name: 'recommend_modules', description: 'Jev 语义推荐：语义检索+排序流水线——预设分类（缓存）→ 类别筛选 → 类内全量 0-10 打分 → 放置意图判定，返回按 jevScore 排序的明细。适合已经包含具体功能参数的描述，query 传用户原始需求整句；精确型号/模块名改用 search_modules。用户明确要求放置时本工具才可能自动出示放置确认卡；否则返回明细不出卡。需求是否已经具体到可以调用，按系统提示【系统提示词】判断。', parameters: RECOMMEND_MODULES_PARAMS as unknown as Record<string, unknown> },
	{ name: 'get_module', description: '读取单个模块的完整详情：名称、描述、分类、boards（自带原理图/PCB uuid）、云端/本地存储标记。cbbUuid 必须来自 search_modules。', parameters: GET_MODULE_PARAMS as unknown as Record<string, unknown> },
	{ name: 'refresh_catalog', description: '重新拉取全部库的模块目录并落盘持久化（首次约 20 秒，库大时可能数分钟）。上下文中的目录摘要标注数据较旧（stale）或用户明确要求刷新时调用；其余情况用 search_modules 即可。调用本工具的同一条回复中，先用正文告诉用户「拉取数据可能需要数分钟，请您耐心等待」，再发起调用。', parameters: REFRESH_CATALOG_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_placement', description: '向用户出示放置确认卡（不会真正放置）。选出匹配模块并给出放置形式（符号或图页）与位置（当前图页 / 新建图页 / 新建板子 / 新建工程）。落点由插件自动排布，无需坐标。', parameters: PROPOSE_PLACEMENT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'inspect_module', description: '读取模块（个人库/团队库/本地库）自带原理图页的内容摘要：器件清单（位号/名称/器件名/封装）、网络名、文字标注。只读不改画布（优先读工程内已有副本；否则经临时板物化读取，读取后自动删除临时内容）。用于在改名称/描述前自动分析模块功能。', parameters: INSPECT_MODULE_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_edit', description: '向用户出示模块名称/描述编辑确认卡（不会真正写库）。', parameters: PROPOSE_EDIT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'propose_export', description: '向用户出示目录 JSON 导出确认卡（不会真正写文件）。确认后另存一份 JSON，只含勾选模块的目录条目，不含工程文件。按需导出：传 cbbUuids 则卡上只列这些模块（推荐用法，如导出当前推荐方案/用户点名的模块）；仅当用户明确要导出全部目录时才省略 cbbUuids。', parameters: PROPOSE_EXPORT_PARAMS as unknown as Record<string, unknown> },
	{ name: 'self_check', description: '探测宿主 API 与桥接是否可用，返回诊断文本。', parameters: EMPTY_PARAMS as unknown as Record<string, unknown> },
	{ name: 'compact_history', description: '折叠早期对话：用一段摘要替换较早的历史（最近几轮原样保留），防止上下文膨胀与早期信息丢失。上下文摘要显示轮数超过 8、或你发现缺少早期对话中的约定/结果时调用；把此前对话的完整摘要写入 summary。', parameters: COMPACT_HISTORY_PARAMS as unknown as Record<string, unknown> },
] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number]['name'];

/** 运行时工具名清单（loop.isAgentToolName 用），由注册表推导，不会漂移。 */
export const AGENT_TOOL_NAMES: ReadonlyArray<string> = AGENT_TOOLS.map(t => t.name);

/**
 * 工具列表恒全量注入：search_modules（精确关键词）与 recommend_modules（Jev 语义推荐）
 * 并存分工，靠两者 description 的「分工」段引导模型选择；
 * Jev 未配置 Key 时由 recommend_modules 运行时温和回落（不报错、提示补 Key）。
 */
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

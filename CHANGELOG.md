# Changelog

## 0.7.0 (2026-09-18)

- **目录存储收敛为单持久层**：store.ts 移除 IndexedDB 降级层，唯一持久化后端为 sys_Storage（EasyEDA 官方扩展存储，主进程与 iframe 通用）；写路径 await 官方 `Promise<boolean>`，落盘失败经 refresh_catalog 的工具错误通道显式上报（目录已拉取但仅本次会话可用），不再静默降级。桌面端与网页版均已实测跨重启持久化
- **新增 compact_history 工具**：对话较长（上下文摘要轮数超过 8）或模型发现缺少早期对话约定时，可调用折叠早期历史——summary 写入自足摘要，最近 4 轮原样保留，防止上下文膨胀；单轮工具调用上限由 24 提至 48
- 用户气泡支持点击定位：点击会话中任意用户气泡，滚动到该消息分段开头（气泡随滚动吸顶）
- 设置存储对齐官方签名：`setExtensionUserConfig` 按 `Promise<boolean>` 处理并显式吞掉 rejection，避免 unhandled rejection
- 版本号升至 0.7.0

## 0.6.0 (2026-09-17)

- 顶栏主题按钮样式统一：移除 #themeBtn 专属的描边/悬停变色规则，完全继承 .icon-btn（无背景、悬停浅灰底、文本色过渡），与清空对话、设置两个图标按钮一致；亮/暗切换功能不变。
- 版本号由 0.5.x 升至 0.6.0。

## 0.5.39 (2026-09-17)

- 快捷选项更新为四条：现在有哪些模块？／找一个电源模块／帮我把模块描述写规范／导出复用模块工程和索引json（首屏与对话中建议条共用同一组）。
- 设置页各区块标题移除表情符号图标（模型接入 / 库范围 / 放置排布 / 本地库复用 / 关于）。

## 0.5.38 (2026-09-17)

- **恢复对话中横滑建议条（与首屏选项互斥）**：新增 #chipsBar（原样式横滑 + 滚轮转发），与首屏居中选项共用同一组 CHIP_PROMPTS 与点击逻辑；空会话（首屏显示）时建议条隐藏，发出首条消息后首屏消失、建议条出现。
- 首屏助手名由渐变改为主题蓝纯色；副标题简化为「可以帮你……」句式。

## 0.5.37 (2026-09-17)

- **空会话改为 Gemini 式首屏**：新会话不再流式输出 AI 问候语，改为大字问候（「你好，我是 复用模块 AI 助手」，助手名渐变蓝）+ 一句能力说明 + 居中建议选项；选项直接复用原 #chips 五条快捷指令及点击逻辑（chips 容器整体移入首屏，居中换行布局，原底部横滑条及其滚轮转发逻辑移除）。用户发出首条消息后首屏消失进入对话流；关闭会话/清空对话后首屏恢复。实现：#page-chat 以 empty 类切换 #hero 与 #msgList 的显隐。

## 0.5.36 (2026-09-17)

- 会话标签移动到顶栏最左缘（去除 header 左内边距，标签从 x=0 起，右侧按钮区仍保留 14px 边距）；激活态顶部蓝色指示条由 2px 加厚至 3px。

## 0.5.35 (2026-09-17)

- 修复会话标签未占满顶栏的问题：header 的 `align-items:center` 使标签条按内容塌缩（约 21px 高、垂直居中悬浮），为 `.tabs` 加 `align-self:stretch` 后标签条与标签均撑满 header 全高（46px，top=0），标签真正内嵌于顶部栏。

## 0.5.34 (2026-09-17)

- 会话标签页改为直角矩形（去除上沿圆角），高度撑满顶栏（46px，与 header 一致，底部覆盖分隔线实现与内容区连通），关闭按钮悬停底同步去圆角；标签样式其余不变。

## 0.5.33 (2026-09-17)

- **顶栏改为 VS Code / Cursor 风格标签页**：移除品牌区（CBB 徽标 + 「复用模块 AI 助手」标题）与固定「对话」页签，改为单一会话标签页——名称默认「复用模块助手」，用户发出首条消息后取其前 8 字（超长加省略号）；标签页内嵌 × 关闭按钮，与右上角「清空对话」图标按钮同效（确认后重置会话、清空消息与目录快照，标签名复位为默认）。清空逻辑收敛为共用的 resetChat()。
- 设置页「库范围」「放置排布」等此前各轮简化在本版一并生效（0530–0532 的设置页精简、启动提示移除均包含在内）。

## 0.5.32 (2026-09-17)

- **移除对话页启动系统提示**：不再输出「客户端模式：…」环境注记（模式信息保留在设置页「库范围」区块的 🧭 行）与「当前为浏览器预览 / 已接入插件真桥」欢迎注记，对话页开场仅保留 AI 欢迎语。交互过程注记（已取消放置、未勾选任何模块等）不受影响。

## 0.5.31 (2026-09-17)

- 顶栏「清空对话」图标由垃圾桶改为循环/更新（refresh-cw 双向环形箭头），并移动到「设置」按钮左侧（顺序：清空对话 · 设置 · 主题），title 更新为「清空对话（新会话）」。

## 0.5.30 (2026-09-17)

- **设置页精简**：移除「数据与诊断」区块及「运行自检」按钮（连同 diagOut 输出区）；「清空对话」改为顶栏图标按钮（垃圾桶线性图标，与设置/主题同一视觉语言），行为不变（确认后重置会话、清空消息与目录快照）。
- **「工程包」区块简化为「本地库复用」**：标题与描述重写为本地库复用模块的全部导出和导入，按钮行改用紧凑 prow 布局，说明压缩为一行（保留云端模块不参与打包、导入后需重启客户端两条关键提示），导出/导入功能不变。

## 0.5.12 (2026-09-16)

- **恢复本地库「复用模块图页」放置**：半离线 V3.2.166 真机实测，宿主 `lib_Cbb.get` 对本地模块仍必崩（`TypeError: parent_tag`，立即抛出），但 `placeCbbSchematicPage` 用 .eprj2 明文工程树解析出的 schematic uuid 放置**返回 true**（2.2s，5 个器件落页可读，临时页删除无残留）——图页能力一直在，缺的只是 uuid 来源。图页 uuid 解析收敛为 `resolveCbbPageUuid`：云端走 `lib_Cbb.get`、本地走 `readLocalSheetUuid`（按「文件名主干 = 模块名」定位库目录下的 .eprj2）。`pageSupportOf` 恢复对 local 返回 true：确认卡图页选项解除置灰、放置提案/系统提示/目录载荷同步放开；`confirmPlace` 向放置器传目录权威模块名（卡上可编辑的标题不再参与文件定位）。
- 本地模块跳过放置前预测量（模块自带页属于磁盘工程，`openDocument` 无法按 uuid 激活）：首个本地模块走保守估计占位，放置后实测回写几何缓存，之后即精确。空符号自动回退图页的路径对本地库随之生效。

## 0.5.11 (2026-09-16)

- **工具注册表单源化收尾**：AGENT_TOOLS 改为 as const 单一事实源，AgentToolName / AGENT_TOOL_NAMES 由它推导（原先是三处手工对齐的声明）。新增工具只在注册表登记一处：漏实现 handler 得到编译错误，schema / 名册 / 执行器三方不可能漂移。移除失去用途的 AgentToolDef 接口。
- **Loop 双限流补齐**：新增 MAX_TOOL_CALLS=12 工具调用总量上限（轮数与调用数独立限制，防止模型一轮多调用的异常循环），超限的调用以「已跳过」呈现并回填引导模型直接总结。

## 0.5.10 (2026-09-16)

- **目录获取完全收口到模型调用**：移除 chatTurn 循环外的自动预取路径——会话无目录快照时，上下文会明确标注「请先调用 get_catalog」，系统提示同步要求模型先拉目录再执行推荐/编辑/导出；四个需要目录的工具（propose_placement / inspect_module / propose_edit / propose_export）在快照缺失时返回统一错误引导模型先调 get_catalog，不再插件侧静默补拉。get_catalog 从此只有模型调用一个入口。
- **移除 llm.request 伪工具事件**：出站 HTTP 是插件行为而非模型工具调用，失败信息经恢复话术（assistantText）与 error 字段呈现，不再伪装成工具气泡。
- 编辑卡写回成功的提示同步改为「下一条消息 AI 会先刷新目录」。

## 0.5.9 (2026-09-16)

- **修复真机回归问题**：同会话「编辑确认卡写库成功 → 再放置该模块」时，放置卡���示旧信息且确认放置失败——根因是会话目录快照在写库后仍为旧数据。现在 confirmEdit 写库成功后立即作废本会话目录快照并清空该模块的原理图分析标记，下一条消息自动重新拉取最新目录，放置提案与确认均基于新数据；confirmPlace 对快照已失效的情况给出明确提示而非「不在当前目录中」。
- 编辑卡写回成功的对话提示同步说明目录将自动刷新。

## 0.5.8 (2026-09-16)

- **确认卡令牌绑定提案**：CardRecord 记录提案载荷（edit 的模块与内容、place/export 的允许勾选集），confirm* 以卡上载荷为权威、不再信任客户端回传的 libraryUuid/cbbUuid——授权语义从「持卡可对目录任意模块执行一次」收紧为「按这张卡执行」。confirmEdit 签名相应收窄为只传用户可编辑的 name/description。
- **导出复用会话快照**：confirmExport 把卡上目录快照传给 exportProjectPackage，不再确认后重新全量拉取目录，消除清单与卡片不一致。
- **目录注入逐轮重建**：chatTurn 每轮重新生成 catalogNote，get_catalog(force) 后同轮请求不再携带旧目录（新旧目录打架问题）。
- **目录拉取补超时**：fetchModuleBoards 的 lib_Cbb.get 加 15s 超时（与放置路径同口径），本地模块挂起不再卡住整轮 fetchCatalog。
- **工具注册穷尽化**：runTool 改为 `Record<AgentToolName, Handler>` 分发表，新增工具漏实现变成 TS 编译错误；顺带修复 propose_edit 事件名被模块名遮蔽的问题。
- **Schema/runtime 双层校验**：全部工具 schema 加 additionalProperties: false；description 补 maxLength 300 并在 propose_edit 运行时截断；picks 补 maxItems 20 并与提示词口径统一（推荐 1～3，上限 20）。
- **重复逻辑收敛**：「文件名主干 = 模块名」匹配三处实现收敛为 `catalog.matchLocalEprjRow` 单一实现（目录拉取 / 工程包导出 / 本地摘要读取共用）；pageSupport 规则两处收敛为 `catalog.pageSupportOf`；LLM 错误短标签映射移到 `http.llmErrorKindLabel` 共享；anthropic 端点推导抽公共函数。
- **杂项清理**：删除死常量 DEFAULT_PACK_GAP；收窄 cbb.ts 导出面（placeCbbSymbol / PlaceResult / PlaceParams / DEFAULT_PAGE_HEIGHT 转内部）；几何缓存写 v3 时顺手作废 v2 旧键；确认卡令牌随机部分优先 crypto.randomUUID / getRandomValues（宿主不支持时降级时间戳+Math.random）；自动预取目录的 UI 事件标注「自动预取（非模型调用）」，不再伪装成模型工具调用。
- **有意不做**：settings 排布校验的 get/save 合并——两者回退语义不同（保存无效值是清空、读取无效值是回默认），强行统一会改变行为。

## 0.5.4 (2026-09-15)

- **AI 自动分析模块名称/描述**：新增只读工具 `inspect_module`，打开模块自带原理图页读取器件清单（位号/名称/器件名/封装）、网络名（网络标志/端口/离图连接器）与文字标注后自动切回原页；LLM 据此直接得出建议名称与描述再出 `propose_edit` 确认卡，不再要求人工提供信息。写库仍需确认卡把关。
- 系统提示更新：改名称/描述时先 inspect 再提议；本地库模块（`lib_Cbb.get` 崩溃缺陷）或读取失败时才退化为目录信息提议或询问用户。
- 编辑确认卡新增「已按模块自带原理图自动分析」标记（会话内按模块记录）。

## 0.5.0 (2026-09-10)

- **只保留对话 agent**：删除旧表单面板 `iframe/index.html`、一次性 `select_module` 匹配器，以及桥上给表单用的直调 API（`matchModules` / `placeCbbGrid` / `placeCbbNewProject` / 裸 `place*` / `fetchCatalog`）。
- 面板入口改为 `iframe/chat.html`。写画布 / 写库 / 导出只经确认卡令牌。
- 源码收敛为 10 个 TS 文件：`index`（入口+桥）/ `host` / `settings` / `env` / `catalog` / `cbb` + `agent/{loop,tools,llm,http}`。不再兼容旧产品形态。

## 0.4.0 (2026-09-10)

- **对话形态**：默认面板改为 `iframe/chat-prototype.html`（对话 / 设置 tab）。用户用自然语言完成找模块、确认放置、改描述、导出目录；写操作必须经确认卡令牌。旧表单 `iframe/index.html` 保留至验收。
- 主进程新增 `chatTurn` 多轮工具循环（三格式 auto tools：get_catalog / propose_* / self_check / goto_settings），写桥 `confirmPlace` / `confirmEdit` / `confirmExport` 校验令牌。
- **不含 F4.4**：对话确认卡与工具表不暴露新建工程放置。
- 整页能力按 F4.3：仅个人库 `pageSupport=true`；本地模块整页置灰（`lib_Cbb.get` 崩溃）。
- 网格默认间距 400（单位 0.01 英寸），与 F4.6 一致。LLM 请求仍为非流式（经 `sys_ClientUrl`），UI 打字渲染。
- **AI 气泡富文本**：Markdown-lite 渲染（标题/列表/行内代码/代码块/表格/引用/链接/加粗斜体删除线），渲染前整体转义 HTML；系统提示允许模型用 Markdown 排版。
- **初始模式检测**：面板打开即经 `sys_Environment` 互斥布尔（isOnlineMode/isHalfOfflineMode/isOfflineMode）+ `getUserInfo`（uuid 即 personalLibraryUuid）判定模式与登录态；个人库/本地库互斥，不可达来源在设置页禁用并标注，目录拉取自动取「勾选 ∩ 可用」。SPEC §7.3 勘误：路径发现 API 挂在 sys_FileSystem 原型上。

## 0.3.0 (2026-09-10)

- **目录来源收敛为两源**：个人库（在线）+ 本地库（离线/半离线）。工程库（条目全为放置副本，get/modify/copy 死路、放置挂起）与系统/收藏库（只读容器）从面板勾选与拉取范围移除，旧配置键兼容忽略。
 - 全库能力矩阵实测（SPEC §7.3）：本地库 modify/copy 可用、delete 返回 false、get 崩溃、关键字搜索不生效；半离线模式下路径发现 API 全部失效。
- 本地库路径设置兜底：fetcher 三级回退（getAllLibrariesList → getLibrariesPaths → 设置路径）+ 面板路径输入框。
- 工程库前置拦截：符号/整页/编辑对工程库条目给出明确提示（不再挂起或报 [object Object]）。
- 错误格式化全链路补全：placement/author/iframe 所有 catch 对普通对象 rejection 做 JSON.stringify。
- F4.3 整页放置验收通过（云端模块）；本地 create/get/delete 复测确认确定性失败。

## 0.2.3 (2026-09-09)

- **移除 F5 虚拟库**（Nolan 拍板）：F5.3 宿主不支持原生打开/放置（纯文本与 `.eprj2` Blob 挂载均实测无效），纯目录挂载无实际作用。删除 `src/vlib/`、桥接挂载与激活时后台预拉取；浏览/搜索收敛到插件面板。`registerExtendLibrary` 经验保留在 SPEC §11，未来宿主支持原生放置时可低成本恢复。

## 0.2.2 (2026-09-09)

- F5.3 spike 结论：宿主 V3.2.x 对虚拟库 CBB 条目**不支持原生打开/放置**（纯文本与挂载 `.eprj2` Blob 两种条目均实测无效）。降级方案转正：虚拟库 = 官方面板可浏览/可搜索目录，放置统一走插件面板；`data` 挂载保留以兼容未来宿主版本。
- 用户在官方面板查看虚拟条目（触发 getDetail）时 toast 引导到插件面板放置（每会话一次）。
- SPEC：F5.3 验收结论回填；R9 更新为「宿主限制，接受降级」。

## 0.2.1 (2026-09-09)

- F5 虚拟库条目挂真实工程：本地库模块经 `sys_FileSystem.readFileFromFileSystem` 读取 `.eprj2`，以 **Blob** 挂到 `ILIB_ExtendLibraryItem.data`（带会话级缓存；浏览器环境/无权限/缺文件静默退化为纯文本条目）；云端模块无下载 API（`getCbbFileByCbbUuid` 未暴露）仍为纯文本。宿主对 data 的实际行为（能否原生打开/放置）待真机验证。
- 开箱有数据：每会话激活后后台自动拉取一次目录填充虚拟库（失败静默，不阻塞激活）。
- 开源广场：确认 SDK 无任何 API（记录为 SPEC R8 限制，v0.2 不支持）。

## 0.2.0 (2026-09-09)

- F1 作者助手：目录行「编辑」→ 第⑤节表单（名称/描述 + 模板插入）→ `lib_Cbb.modify` 写回（已拍板只做修改，不做创建）。
- F4.3 整页放置：放置表单新增「目标」选择（符号/整页）；整页经 `get().boards[].schematic` 取图页 uuid → `placeCbbSchematicPage`；本地模块 get 有缺陷，明确提示不支持并引导用符号方式。
- F4.6 多模块网格放置：AI 返回多候选时出现「全部网格放置(N)」按钮，sqrt(n) 网格布点防叠放，单块失败不中断，结果清单进输出框。
- F5 虚拟库：`registerExtendLibrary('复用模块AI目录')` 会话级注册（挂桥即注册，目录拉取自动刷新）；getList 支持 wd 关键字过滤与分页，条目用 name 字段（M0 教训）；虚拟条目无 CBB 库文件，原生放置降级为面板放置（SPEC §11）。
- M1 已验收：主流程 A 端到端跑通（Anthropic Messages 格式实测）。

## 0.1.6 (2026-09-09)

- AI 设置改为三格式（Nolan 拍板）：**OpenAI Chat Completions / OpenAI Responses API / Anthropic Messages**，同一份目录提示词与 PlacePlan 契约；旧 provider 值（openai/custom）自动迁移为 openai-chat；anthropic 线从 M2 提前落地（max_tokens=4096、x-api-key + anthropic-version、tool_use.input 解析）。
- Responses 适配：instructions 承载 system、扁平 function 工具、output[] function_call 解析、failed 状态错误透出。
- 工具定义按格式分别构造（嵌套 function / 扁平 function / input_schema）。

## 0.1.5 (2026-09-09)

- F3 AI 匹配（openai/custom 线）：需求 → 目录注入提示词 → 强制 `select_module` tool 调用 → PlacePlan 解析 → cbbUuid 白名单校验（F3.3）→ 自动填入放置表单；错误分类提示（F3.4：设置缺失 / 外部交互权限 / 超时 / 401·403 鉴权 / 404 路径 / 429 限流 / 契约不符）；多候选列在输出文本框，自动填第 1 个。
- 目录载荷上限 500 条（超出标注 truncated）；描述截断 300 字。
- anthropic 线留待 M2（provider 下拉已标注）。
- 放置表单补充 CBB? 位号说明（未标注属正常，官方「工具→标注」分配）。
- 端到端待用户配置 OpenAI 兼容端点（baseUrl/apiKey/model）后验证。

## 0.1.4 (2026-09-09)

- F4.1/4.2 确认放置：目录行「放置」→ 确认表单（坐标 0.01inch/旋转/镜像）→ `createCbbSymbol` 当前原理图落位；活动文档类型前置检查（F4.5）+ 30s 超时保护；确认前不改动画布。
- M0 复测收口：`createCbbSymbol` 省略符号 uuid 可行（本地+云端）；`placeCbbSchematicPage` 用 `get().boards[].schematic` 作 uuid；`copy`/`modify`/`delete` 可用、`create` 穷尽复测不可用——F1 拍板只做修改既有模块。
- 面板：目录行加「放置」按钮与第③节放置表单；报错输出到可复制文本框；「自检」按钮（跨 realm API 探测）。

## 0.1.0 (2026-09-08)

- 工程骨架：extension.json（sch headerMenus）+ esbuild 构建 + packaged.ts 打包（从 git 历史恢复的模板）。
- F2 目录导出：多库枚举（个人/工程/系统/收藏/本地，可勾选；本地库经 getAllLibrariesList 路径搜索——M0 实测）、`lib_Cbb.search` 分页聚合（1 起分页实测确认；uuid 去重）、单库失败隔离、目录 JSON v0.1 组装、`sys_FileSystem.saveFile` 另存。
- 面板：库范围勾选、拉取/导出、统计（库数/模块数/失败库/描述为空计数/耗时）、空库提示、LLM 设置存储（F3 预留）。
- 未含：F3 请求/解析（端点待定）、F4 放置（阻塞于 M0-②③）、F1 作者助手、F5 虚拟库。

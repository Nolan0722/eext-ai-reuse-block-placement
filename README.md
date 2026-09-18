# jlc-cbb-copilot 复用模块智能助手

嘉立创EDA专业版（EasyEDA）扩展：**复用模块（CBB）对话助手**。

用自然语言找模块、改描述、导出目录；放置 / 写库 / 导出都会先出确认卡，确认前不改动画布。

## 使用

原理图菜单 →「CBB Copilot → Open CBB Copilot...」打开对话面板：

1. **对话**：自然语言找模块、改描述、导出目录。写操作走确认卡令牌。
2. **设置**：模型接入（openai-chat / openai-responses / anthropic）、库范围（个人库 + 本地库）、本地库路径兜底、自检、清空对话。
3. 未配置 baseUrl / apiKey / model 时，对话会引导到设置页。

## 开发

```bash
npm install
npm run compile   # esbuild 产出 dist/index.js
npm run build     # compile + 打包 build/dist/jlc-cbb-copilot_v<ver>.eext
npm run lint
```

安装：客户端「设置 → 扩展 → 导入扩展」选择 `.eext`。

## 当前状态（v0.5.0）

| 能力 | 状态 |
|---|---|
| 对话 agent（多轮工具 + 确认卡） | ✅ |
| 目录拉取 / JSON 导出 | ✅ 真机验证（离线桌面版 + 在线版） |
| 确认后符号放置（当前原理图） | ✅ 真机验证 |
| 整页放置 | ✅ 仅个人库；本地模块 `lib_Cbb.get` 崩溃，置灰 |
| 多模块网格放置 | ✅ 确认卡内 |
| 编辑名称/描述 | ✅ `modify` 实测可用 |
| 三格式 LLM | ✅ OpenAI Chat / Responses / Anthropic Messages |

不包含：新建工程后放置、旧表单面板、一次性 `select_module` 匹配器。

## 已知限制

- 出网走嘉立创代理（`sys_ClientUrl.request`）；`api.openai.com` 经代理实测 500——`baseUrl` 必须可配，用国内可达端点。
- `lib_Cbb.search` 分页 1 起；本地库须把磁盘路径作 libraryUuid。
- `lib_Cbb.create` 静默失败 → 只做修改，不做创建。
- 假 uuid 调放置 API 会挂起 ≥8s——放置/修改均有超时。
- 开源广场无扩展 API；要纳入目录请先复制到个人库。

## 源码结构

```
src/
  index.ts          入口 + iframe 桥
  host.ts / settings.ts / env.ts
  catalog.ts        目录类型、拉取、导出
  cbb.ts            放置 + 改描述
  agent/            对话循环、工具、三格式 LLM、HTTP
iframe/chat.html    对话面板
```

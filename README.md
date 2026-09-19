# douyin-ide-control

本地 stdio MCP，用于在 Codex 或其他 MCP 宿主中安全调用抖音开发者工具。调用优先级为：官方 `tt-ide-cli` → IDE 本地 CDP/DevTools → Windows 原生窗口能力。

## 安全与路径边界

- 工作区由环境变量 `DOUYIN_WORKSPACE_ROOT` 指定。**未配置时工具会明确拒绝并返回 `WORKSPACE_NOT_CONFIGURED`**，不会静默把插件安装目录当成工作区。
- 所有项目和输出路径都必须位于工作区内，避免误操作其他目录。
- 本仓库不包含 AppID、Token、Cookie、密码、API key、登录配置或本机截图。
- 上传、提审、设置 AppID Token 等高风险动作必须显式确认。
- 工具不会回显 Cookie 内容或 Cookie 文件路径；日志对 token/cookie/password/authorization 等字段做脱敏。

## 工作区配置（必读）

工作区必须由宿主显式传入。**没有环境变量时唯一安全的行为是拒绝执行**：MCP 服务器由宿主拉起，`process.cwd()` 通常是插件安装目录，若默认采用它，真实项目会被白名单错误拒绝，而错误信息还会误导排查方向。

配置方式（任选其一，按宿主能力）：

```toml
# ~/.codex/config.toml —— 全局注册 MCP 服务器时指定 env
[mcp_servers.douyin-ide-control]
command = 'node'
args = ['<插件目录>/src/server.mjs']

[mcp_servers.douyin-ide-control.env]
DOUYIN_WORKSPACE_ROOT = '<你的项目根目录>'
```

```powershell
# 或通过 CLI 注册
codex mcp add douyin-ide-control --env DOUYIN_WORKSPACE_ROOT=<你的项目根目录> -- node <插件目录>/src/server.mjs
```

未配置时的表现：

- 需要工作区的工具（打开/编译/预览/上传等）顶层失败，错误码 `WORKSPACE_NOT_CONFIGURED`，并在 `hint` 里给出配置方法。
- `douyin_check_environment` 不抛错，而是返回 `workspaceConfigured:false` 与 `workspaceError`，便于直接排障。

## 环境变量

| 变量 | 用途 | 是否必需 |
| --- | --- | --- |
| `DOUYIN_WORKSPACE_ROOT` | 工作区根目录；**未设置时工具拒绝执行** | 必需 |
| `DOUYIN_TMA_CLI_JS` | 显式指定本机 `tt-ide-cli` 的 `tma.js` 路径 | 可选 |
| `DOUYIN_NPM_GLOBAL_ROOT` | npm 全局安装根目录，用于推导 `tt-ide-cli` / `tt-minigame-ide-cli` 位置 | 可选 |
| `DOUYIN_TMG_PACKAGE` | 显式指定 `tt-minigame-ide-cli`（tmg）包目录 | 可选 |
| `DOUYIN_IDE_CDP_PORT` | 覆盖 IDE workbench CDP 端口（新版 IDE 端口动态，通常无需设置） | 可选 |
| `DOUYIN_SMOKE_PROJECT` | `npm run smoke` 的被测工程路径 | 可选 |
| `DOUYIN_SMOKE_OUTPUT_DIR` | `npm run smoke` 的输出目录 | 可选 |

CLI 位置解析顺序：显式环境变量 → PATH 上的 `tma` shim → npm 全局根目录。任何一步都不写死盘符或用户目录，换机器无需改代码。

## 小程序 / 小游戏路由

- `expectedProjectType=minigame` 使用 `tmg`（microgame 协议）。
- `expectedProjectType=miniapp` 使用 `tma`（microapp 协议）。
- 未指定类型时，先根据工程结构做路由提示，再用 IDE 权威信号复核。
- IDE 同时打开多个工程时，按 `projectPath` 绑定目标，避免其他工程的错误污染判断。

## 已提供的 MCP 工具

- `douyin_check_environment`：检查 `tt-ide-cli`、登录状态、IDE 主窗口、本地 CDP 目标和项目目录元数据，不读取源码内容。
- `douyin_open_project`：按类型路由打开工程，轮询等待 IDE 窗口/CDP 就绪；支持 `expectedAppid`/`expectedProjectType` 做身份校验，不符时不误报成功。
- `douyin_project_identity`：从 IDE 实际状态/已登录元数据识别项目类型、实际 AppID 与权限状态；文件结构仅辅助。结构化错误：`APP_PERMISSION_DENIED` / `PROJECT_TYPE_MISMATCH` / `APPID_MISMATCH` / `PROJECT_TYPE_UNKNOWN`。
- `douyin_create_minigame_project`：仅创建 `minigame` 类型工程；通过 IDE 启动页真实“小游戏”入口（CDP DOM 语义控件）；非空目录默认拒绝；启动页不可控时返回 `CREATE_PROJECT_UI_UNSUPPORTED`。
- `douyin_preview`：按工程类型路由生成预览二维码，输出路径必须在工作区内。
- `douyin_build_npm`：按工程类型路由执行 npm 构建。
- `douyin_compile_refresh`：优先点击 IDE workbench 的“编译/刷新”DOM 控件，可显式使用快捷键兜底。
- `douyin_capture`：`ide_window` 保存 IDE 全窗 PNG；`simulator` 保存本地 `MiniApp Webview` PNG。
- `douyin_read_console_errors`：尽力读取 IDE 内嵌 DevTools 控制台文本，拿不到时返回明确的不支持原因。
- `douyin_project_size` / `douyin_audit_hosts` / `douyin_project_version`：包体积、提审 Host、最新已发布版本查询。
- `douyin_upload` / `douyin_audit` / `douyin_set_app_config`：官方高风险动作，必须显式传入 `confirm=true`，否则返回 `CONFIRMATION_REQUIRED`。
- `douyin_ide_preview`：**绕过 CLI 登录**——直接点击已登录 IDE workbench 的「预览」按钮，从 DOM 提取二维码 PNG 保存到工作区。
- `douyin_ide_upload`：**绕过 CLI 登录**——直接操控已登录 IDE 完成「上传→填版本/日志→确定→核验结果」。

## 通过 IDE 上传的流程与安全约束

`douyin_ide_upload` 的 `projectPath`、`appVersion`、`appChangelog` 均为**必填**，`confirm` 必须为 `true`。

**执行顺序是正确性的一部分**（顺序错了会导致点击落在被遮挡的界面上、静默失效）：

1. **输入校验**：缺少版本号返回 `UPLOAD_VERSION_REQUIRED`，缺少更新日志返回 `UPLOAD_CHANGELOG_REQUIRED`。工具不会猜测版本号，也没有默认值。
2. **身份核对**：上传前调用身份识别核对目标工程与类型（可传 `expectedAppid`/`expectedProjectType`）。
3. **严格绑定工程**：见下方「严格工程绑定」。命中不到、缺失 `projectPath` 或命中多个都**拒绝执行**（`IDE_PROJECT_NOT_BOUND`），绝不退回"第一个 workbench"，也不按工程名模糊匹配。
4. **先处理信任弹窗**：IDE 若正在显示项目信任提示（`.tila-modal` 内含「信任并运行」），默认**不自动点击**，返回顶层错误 `IDE_PROJECT_TRUST_REQUIRED`。信任意味着允许在模拟器中运行该工程代码，属于用户决定，因此与上传授权**相互独立**：只有显式传入 `confirmTrust=true` 才会自动点击「信任并运行」，并等待弹窗真正消失。
5. **再点击上传入口**：信任处理完毕后才点击 **workbench 页面内的工具栏「上传」**。这一步必须在第 4 步之后——信任弹窗会遮挡工具栏，先点上传不会生效。IDE 顶部的「工具/上传」是**原生 Electron 菜单**（`Menu.setApplicationMenu`），CDP 无法点击，因此不作为路径。
6. **放行上传流程中间弹窗**：点击上传之后才处理「继续上传」这类版本重复确认，上限 4 轮；超过上限停止并返回 `UPLOAD_INTERMEDIATE_DIALOG_LIMIT`。同一个弹窗（相同文本）不会被重复点击。
7. **填写并回读**：版本号与更新日志只在**上传表单弹窗内**定位；写入后立即回读校验，写不进去就中止。
8. **提交一次**：「确定」**只在上传表单弹窗内查找**（作用域 `form`），找不到即失败，不会退化成整页搜索第一个同名元素。按钮作用域严格三分：`form`（表单弹窗）/ `dialog`（任意可见弹窗，用于中间确认）/ `toolbar`（工作台工具栏，用于「上传」入口）。
9. **结果核验**：提交前先做提示基线快照，提交后只承认**新增或变化**的提示文本，返回三态：
   - `success`：IDE 明确提示成功
   - `failed`：IDE 明确提示失败（以顶层错误码 `IDE_UPLOAD_REPORTED_FAILURE` 返回）
   - `unverified`：**已确认点击提交**但没有取得最终证据
10. **禁止自动重试**：结果不明确时返回 `autoRetry:false` / `retryRecommended:false`，绝不自动重试，避免重复上传。

## 严格工程绑定

只读探测允许宽松匹配（标题含工程名即可），但**任何可能产生副作用的操作**（上传、IDE 预览、点击 workbench 工具栏）必须使用严格绑定：

- target 必须是 workbench 页面（路径以 `workbench/index.html` 结尾的 `page`）；
- URL 必须**存在** `projectPath` 参数；
- 归一化后必须与传入路径**完全相等**；
- 缺失 / 零匹配 / 多匹配**全部拒绝**，不做标题或工程名模糊匹配。

因此"标题里带着目标工程名、但 URL 没有 `projectPath`"的 target 也会被拒绝，避免误操作到别的工程实例。

**附属 target 的关联**（模拟器、控制台）不使用工程名猜测，而是走真机实测的 `parentId` 继承关系：

```
workbench(page, id=X)                       ← 唯一带 projectPath
  ├─ webview "MiniApp Webview"  (parentId=X)          ← 模拟器
  └─ webview "<工程名> - 抖音开发者工具" (parentId=X)
       └─ iframe "byted/index.html" (parentId=该 webview)  ← DevTools 控制台
```

交叉验证：MiniApp Webview 的 `sessionId` 与 DevTools 控制台的 `project` 参数是同一个值。两个工程同时打开时，各自的模拟器/控制台因挂在不同 workbench 子树下而天然区分；目标子树内出现 0 个或多个候选时返回 `NOT_BOUND` / `AMBIGUOUS`，不会退回到别的工程。

"没能真正提交"的情况一律返回**顶层错误**，不会返回 `ok:true`：

| 情况 | 错误码 |
| --- | --- |
| 工作区未配置 | `WORKSPACE_NOT_CONFIGURED` |
| 未取得目标工程的 workbench（缺失/不匹配/多匹配） | `IDE_PROJECT_NOT_BOUND` |
| IDE 正在显示信任弹窗且未授权 | `IDE_PROJECT_TRUST_REQUIRED` |
| 已授权但信任失败/弹窗未消失 | `IDE_PROJECT_TRUST_FAILED` |
| 上传表单弹窗未出现 | `IDE_UPLOAD_DIALOG_NOT_FOUND` |
| 中间弹窗超过 4 轮 | `UPLOAD_INTERMEDIATE_DIALOG_LIMIT` |
| 版本号/更新日志写入失败 | `IDE_UPLOAD_FILL_FAILED` |
| 表单内没有「确定」按钮 | `IDE_UPLOAD_SUBMIT_NOT_FOUND` |
| IDE 明确报告失败 | `IDE_UPLOAD_REPORTED_FAILURE` |

`unverified` 只用于"已点击提交、但没有拿到成功或失败证据"这一种情况。`submitted:true` 只代表"已点击确定"，最终结论一律看 `status`。

结果核验的提示来源限于**上传弹窗内文本**与**受限的全局浮层**（`tila-message` / `tila-notification` / `[role=alert]` 等），不读取整页正文，也不读取任何输入框内容（避免把版本号、日志或凭据当作证据）。返回的 `evidence` 是脱敏后的真实提示文本，不是正则字面量。

## 运行与验证

```powershell
npm install
npm run check   # 语法检查
npm test        # 单元测试（上传流程用真实 DOM 实现执行源码表达式，非手写替身语义）
npm run smoke   # 冒烟：需设置 DOUYIN_SMOKE_PROJECT，否则只做只读探测
node src/server.mjs
```

插件清单位于 `.codex-plugin/plugin.json`，MCP 配置位于插件根的 `.mcp.json`，采用官方支持的直接 server map：

```json
{
  "douyin-ide-control": {
    "command": "node",
    "args": ["./src/server.mjs"],
    "startup_timeout_sec": 30
  }
}
```

`.mcp.json` 不携带任何机器相关环境变量；工作区通过宿主的全局 MCP 注册或用户环境变量传入（例如 `DOUYIN_WORKSPACE_ROOT`）。
`args` 按插件根解析；宿主运行时会以已安装插件根作为 cwd。

## 官方依赖与 Skill

```powershell
npm install -g tt-ide-cli
npx skills add $(tma get-skill-path)
```

官方文档参考：[小程序命令行工具](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/dev-tools/developer-instrument/development-assistance/ide-cli)、[douyin-ide-cli Skill 使用指南](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/dev-tools/developer-instrument/development-assistance/cli-skill)。

## IDE 实测边界

以下事实来自**真机 CDP 实测**（打开一个占位小游戏工程后抓取 target 清单与 DOM），不是从代码推断。改动选择器前请先复核。

### 工程打开后的 CDP target 清单（实测）

| type | target | 带 projectPath |
| --- | --- | --- |
| `webview` | `MiniApp Webview`（`/miniapp/index.html?sessionId=..&openApplicationType=microgame`） | ✗ |
| `webview` | `<工程名> - 抖音开发者工具`（VS Code `workbench.html`，即工程窗口） | ✗ |
| `iframe` | `byted/index.html`（DevTools 控制台） | ✗ |
| **`page`** | **`applications/<类型>/workbench/index.html?...&projectPath=<编码路径>`** | **✓** |
| `page` | front-page `index.html#/projects`（启动页） | ✗ |

结论：

- **只有 workbench page 带 `projectPath`**，因此它是工程绑定的唯一权威依据。多开 IDE 时按它精确匹配；命中 0 个或多个都拒绝（`IDE_PROJECT_NOT_BOUND`），绝不退回第一个。
- **没有独立的 simulator-page CDP target**。上传工具栏、上传弹窗、表单与结果提示**都在同一个 workbench page 内**，因此上传流程全程只操作一个 target。
- workbench URL 的路径形态是 `applications/<类型>/workbench/index.html`（不是 `/workbench/index.html`）。判定用"路径以 `workbench/index.html` 结尾"，并排除 VS Code 的 `workbench.html`（那是工程窗口 webview）。

### workbench 内 DOM（实测）

- **工具栏**：`DIV.tila-toolbar-container` > `DIV.tila-toolbar-item-container`（内含 `button.tila-button.tila-button-secondary[aria-label="上传"]` 与 `DIV.tila-toolbar-item-title` 文本「上传」）。同级还有 模拟器 / 调试器 / 编辑器 / 刷新 / 清除缓存 / 编译 / 预览 / 真机调试 / 性能测试 / Wasm 分包 / AI助手。
- **顶部菜单是原生 Electron 菜单**（`Menu.buildFromTemplate` + `Menu.setApplicationMenu`，上传项 `douyinide.upload`）。**CDP 无法点击原生菜单**，因此上传入口走工具栏按钮。
- **信任弹窗**：首次打开未信任工程会先弹 `.tila-modal.tila-modal-medium`，按钮「信任并运行」/「稍后运行」。它是上传前的必经中间步骤，工具会放行「信任并运行」。
- **弹窗容器**：`tila-modal`（含 `tila-modal-body` / `tila-modal-footer` / `tila-modal-mask`）。注意 `tila-upload-*` 是通用"上传文件"组件，与发布弹窗无关，不可混用。
- **表单未打开**时页面内 `input/textarea` 数量为 0。
- **上传表单文案**：版本号 placeholder「请输入本次上传版本号，版本号填写示例: 1.0.0」；另有「上传版本」「线上版本」「前序版本」。
- **结果文案**：成功「上传成功」「上传成功，」「上传成功（代码已深度防护）」；失败「上传失败，请检查网络连接」「上传失败，未接入必接能力」。
- **中间确认弹窗**：「继续上传」（key `...upload-inspection-button.upload`），正文为工程分析建议。

其他边界：

- IDE 主进程 CDP 端口随实例动态变化，可读取前置管理页、workbench、MiniApp Webview、权限弹窗的 DOM；workbench 调试端口可由 `DOUYIN_IDE_CDP_PORT` 覆盖。
- 不使用截图识别或坐标猜测。系统 `UIAutomationClient` 对 IDE 窗口只暴露 `Chrome Legacy Window`，未暴露 webview 控件，因此 webview 不可用时返回明确不支持，或使用用户显式选择的快捷键。
- IDE 全窗截图使用 Windows `CopyFromScreen`，要求窗口可见；它不是遮挡安全的 Windows.Graphics.Capture。模拟器截图使用 MiniApp Webview 的 CDP `Page.captureScreenshot`。
- 控制台读取是 DevTools DOM 的 best-effort，拿不到时不会伪造错误内容。
- 权限/类型识别：IDE 权限弹窗（如“获取域名白名单失败”）优先识别为 `APP_PERMISSION_DENIED`；IDE 按小程序编译器查找 `app.json`（报“can't find app.json”）是 `miniapp` 的权威类型证据；文件结构仅作辅助线索，不单独判定类型。

## 安全边界

插件不会读取、打印或写入密码、AppID token、Cookie 或 API key，也不回显 Cookie 文件路径。除项目构建产生的正常输出外，不修改被操作工程的源码；上传和提审不在默认烟测中执行。

## 版本

- **0.3.0**（当前）：同步实际运行插件的演进实现。`douyin_ide_upload` 全面收紧：`projectPath`/`appVersion`/`appChangelog` 必填（不再提供默认版本号），上传前严格绑定目标工程并核对身份，信任弹窗独立授权（`confirmTrust`），提交按钮只在表单弹窗内查找，结果三态 `success`/`failed`/`unverified`，结果不明不自动重试；工作区未配置时返回 `WORKSPACE_NOT_CONFIGURED`（不再回退 `process.cwd()`）；`douyin_ide_preview` 支持 `expectedAppid` 预核对；CLI 与 tmg 包路径不再写死盘符。上传逻辑独立为 `src/ide-upload.mjs`，新增 `tests/ide-upload.test.mjs` 与 `tests/cwd.test.mjs`，MCP 协议层直接验证 `douyin_ide_upload` 的确认门。
- **0.2.0**：初版 IDE 内预览/上传工具（`douyin_ide_preview`/`douyin_ide_upload`）。

## 目录结构

```
src/            运行时代码（server / cli / cdp / ide-upload / identity / tmg / proc / native / path-policy）
tests/          单元测试（上传流程用真实 DOM 实现执行源码表达式，非手写替身语义）
scripts/        冒烟脚本
skills/         供宿主加载的 Skill 提示词
scratch/        本机历史上传实验脚本归档（不入库，见 .gitignore）
```

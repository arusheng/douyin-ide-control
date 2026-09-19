---
name: douyin-ide-control
description: 使用本地 douyin-ide-control MCP 检查、打开、编译、预览、截图或识别抖音小程序/小游戏项目；通过 CLI 或已登录 IDE 上传、提审时必须先取得明确确认，并在提交后核验实际结果。
---

# 抖音 IDE 控制

先明确目标项目，再调用 `douyin_check_environment` 检查 CLI、IDE 和项目状态。所有项目路径和输出路径必须位于 MCP 配置的工作区内（`DOUYIN_WORKSPACE_ROOT`）；不要猜测路径，也不要把工作区外的路径传给工具。

工作区必须由宿主通过 `DOUYIN_WORKSPACE_ROOT` 显式配置。未配置时工具会返回 `WORKSPACE_NOT_CONFIGURED`（`douyin_check_environment` 则返回 `workspaceConfigured:false` + `workspaceError`）——此时应请用户先配置工作区并重启 MCP，**不要**改用插件目录或猜测项目路径继续操作。

IDE 同时打开多个项目时，必须显式传入 `projectPath`。工具会按 `projectPath` 精确绑定目标 workbench；命中不到或命中多个时返回 `IDE_PROJECT_NOT_BOUND` 并拒绝操作，不要试图改用其他方式绕过这个拒绝。涉及预览、上传、提审或修改配置前，先用 `douyin_project_identity` 核对项目类型；用户提供了 AppID 时同时传入 `expectedAppid`，不要自行补全或猜测。目标工程不确定时先问用户，不要用“第一个打开的工程”代替。

## 项目身份与类型（重要）

抖音小游戏与小程序的文件结构不同（小游戏 = `game.js` + `game.json` + `project.config.json`；小程序 = `app.js` + `app.json` + `pages/`），但**文件结构不能作为工程类型的独立证据**。判断类型必须优先使用：

- `douyin_project_identity`：从 IDE 实际状态（前置管理页 DOM、workbench、MiniApp Webview 编译错误）或已登录应用元数据识别。传入 `expectedAppid` 和 `expectedProjectType`（`minigame`/`miniapp`）可获得结构化校验。
- 结构化错误码：
  - `APP_PERMISSION_DENIED`：当前账号无权限访问该 AppID（IDE 权限弹窗，如“获取域名白名单失败”）。
  - `PROJECT_TYPE_MISMATCH`：已取得权威类型证据且与预期不符。
  - `APPID_MISMATCH`：IDE 实际 AppID 与预期不同。
  - `PROJECT_TYPE_UNKNOWN`：无法取得可靠类型证据。
- 真实信号示例：IDE 按小程序编译器报“can't find app.json” → 工程被当作 `miniapp` 处理；IDE 编译游戏时报 game.json 相关错误 → `minigame`。

## 创建小游戏工程

`douyin_create_minigame_project` 只能创建 `minigame` 类型（JavaScript + 空白模板）。通过 IDE 启动页真实“小游戏”入口（CDP DOM 语义控件）创建，禁止截图坐标点击。目标目录非空时默认拒绝（`DIRECTORY_NOT_EMPTY`）。启动页 UI 不可控时返回 `CREATE_PROJECT_UI_UNSUPPORTED`，此时应请用户人工在抖音开发者工具中选择“小游戏”新建。

**不得**用手写三件套冒充正式创建成功；创建后必须调用 `douyin_project_identity` 复核类型。

## 操作选择

日常编译使用 `douyin_compile_refresh`；读取编译结果使用 `douyin_read_console_errors`。需要证据时使用 `douyin_capture`，目标可选 `ide_window` 或 `simulator`。打开项目使用 `douyin_open_project`（可传 `expectedAppid`/`expectedProjectType` 做身份校验，不符时返回结构化错误而非成功）。

- 普通预览优先使用 `douyin_preview`；CLI 登录不可用或用户明确要求使用当前 IDE 登录态时，使用 `douyin_ide_preview`（传 `expectedAppid` 可避免在多开 IDE 时取错工程）。
- 官方 CLI 上传使用 `douyin_upload`；只有 CLI 登录不可用或用户明确要求“用 IDE 上传”时，才使用 `douyin_ide_upload`。
- 提审使用 `douyin_audit`。不要把“上传”理解成“提审”，也不要在上传后自动提审。

## 上传与提审安全边界

上传和提审会产生远程副作用。调用前必须确认目标项目、项目类型、版本号和更新日志，并取得用户对本次操作的明确授权；不得沿用之前任务中的授权。只有满足这些条件时才传入 `confirm=true`。

`douyin_ide_upload` 的 `projectPath`、`appVersion`、`appChangelog` 均为必填。版本号和更新日志必须来自用户或项目中可验证的信息，禁止自行猜测或补全默认版本；缺失时工具会返回 `UPLOAD_VERSION_REQUIRED` 或 `UPLOAD_CHANGELOG_REQUIRED`，此时应回到用户确认，而不是编造一个版本号。

若 IDE 正在显示项目信任弹窗，工具默认返回 `IDE_PROJECT_TRUST_REQUIRED` 且**不会**自动信任。信任意味着允许 IDE 在模拟器中运行该工程代码，属于用户决定；`confirmTrust` 与上传授权 `confirm` **相互独立**，不要因为用户已授权上传就顺手替他同意信任。需要自动信任时必须先向用户说明含义并取得单独授权。工具会在信任完成后重新点击上传入口，顺序由工具保证，不要手动补点。

`douyin_ide_upload` 点击「确定」只代表已触发提交，不等于平台已经上传成功。工具的 `status` 字段才是结论：

- `success`：IDE 给出明确成功提示。
- `failed`：IDE 给出明确失败提示（以顶层错误返回）。
- `unverified`：**已经确认点击了提交**，但超时或没有取得成功/失败证据，只能如实报告“已触发提交，最终结果未核验”，不得表述为上传成功。

如果工具返回的是顶层错误（而不是 `submitted` 结果），说明**根本没有提交成功**，应按错误码定位问题、不要当作“结果未核验”：

- `IDE_PROJECT_NOT_BOUND`：没有严格绑定到目标工程的 workbench（缺失 `projectPath`、不匹配或多匹配）。工具不会按工程名模糊匹配，也不回退第一个，请确认工程已在 IDE 中打开且路径一致。
- `IDE_PROJECT_TRUST_REQUIRED`：IDE 正在显示项目信任弹窗且未获授权（见上）。这不是故障，是需要用户决定。
- `IDE_PROJECT_TRUST_FAILED`：已授权自动信任，但点击失败或弹窗未消失。
- `IDE_UPLOAD_DIALOG_NOT_FOUND` / `UPLOAD_INTERMEDIATE_DIALOG_LIMIT`：上传弹窗没出现，或「继续上传」等中间确认超过轮次上限。
- `IDE_UPLOAD_FILL_FAILED`：版本号或更新日志没能写入表单。
- `IDE_UPLOAD_SUBMIT_NOT_FOUND`：表单里没有「确定」按钮。
- `IDE_UPLOAD_REPORTED_FAILURE`：IDE 明确报告上传失败（错误信息里带脱敏后的真实提示）。

结果不明确时不要自动重试（工具已返回 `autoRetry:false`），否则会造成重复上传。需要重试时必须先向用户报告当前状态并取得新的明确授权。

模拟器截图与控制台读取通过 workbench 的 `parentId` 子树关联到目标工程，不按工程名猜测；无法唯一关联时返回 `NOT_BOUND`/`AMBIGUOUS`，此时应先确认工程状态，而不是换一个 target 重试。

上传入口与放行由工具自行完成（IDE 顶部的「工具/上传」是原生 Electron 菜单，CDP 点不到；工具走 workbench 工具栏）。不要为了“绕过”失败而改用截图坐标点击或人工点菜单来替代工具的流程。

不要提供或回显密码、Cookie、token、Authorization、API key 等凭据，也不要回显 Cookie 文件路径。AppID、项目名称和本机绝对路径只在当前任务确有必要时展示，不要写入示例、测试或公开内容。

---
name: douyin-ide-control
description: 当用户需要在 Codex 中检查、编译、刷新、截图、识别项目身份或创建抖音小游戏工程时使用本地 douyin-ide-control MCP；上传和提审必须先获得明确确认。
---

# 抖音 IDE 控制

优先调用 `douyin_check_environment`，确认当前项目和 IDE 状态。路径默认限定在 `DOUYIN_WORKSPACE_ROOT` 指定的工作区，不要把工作区之外的路径传给工具。

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

## 日常操作

日常编译使用 `douyin_compile_refresh`；读取编译结果使用 `douyin_read_console_errors`。需要证据时使用 `douyin_capture`，目标可选 `ide_window` 或 `simulator`。打开项目使用 `douyin_open_project`（可传 `expectedAppid`/`expectedProjectType` 做身份校验，不符时返回结构化错误而非成功）。

`douyin_upload` 和 `douyin_audit` 会产生远程副作用，除非用户明确要求并在调用参数中传入 `confirm=true`，否则保持拒绝。不要提供或回显密码、Cookie、token 或 API key。

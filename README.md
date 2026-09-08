# douyin-ide-control

本地 stdio MCP，用于在 Codex 或其他 MCP 宿主中安全调用抖音开发者工具。调用优先级为：官方 `tt-ide-cli` → IDE 本地 CDP/DevTools → Windows 原生窗口能力。

## 安全与路径边界

- 工作区由环境变量 `DOUYIN_WORKSPACE_ROOT` 指定；未指定时使用启动进程的当前目录。
- 所有项目和输出路径都必须位于工作区内，避免误操作其他目录。
- `DOUYIN_TMA_CLI_JS` 可选，用于显式指定本机 `tt-ide-cli` 的 `tma.js`。
- 本仓库不包含 AppID、Token、Cookie、密码、API key、登录配置或本机截图。
- 上传、提审、设置 AppID Token 等高风险动作必须显式确认。

## 小程序 / 小游戏路由

- `expectedProjectType=minigame` 使用 `tmg`（microgame 协议）。
- `expectedProjectType=miniapp` 使用 `tma`（microapp 协议）。
- 未指定类型时，先根据工程结构做路由提示，再用 IDE 权威信号复核。
- IDE 同时打开多个工程时，按 `projectPath` 绑定目标，避免其他工程的错误污染判断。

## 已提供的 MCP 工具

- `douyin_check_environment`：检查 CLI、登录状态、IDE、CDP 和项目元数据。
- `douyin_open_project`：打开工程并等待 IDE/CDP 就绪。
- `douyin_project_identity`：识别工程类型、AppID 和权限状态。
- `douyin_create_minigame_project`：通过 IDE 创建小游戏工程，非空目录默认拒绝。
- `douyin_preview`、`douyin_build_npm`、`douyin_project_size`：预览、构建和体积检查。
- `douyin_compile_refresh`、`douyin_capture`、`douyin_read_console_errors`：编译刷新、截图和控制台读取。
- `douyin_upload`、`douyin_audit`：上传和提审，必须显式传入 `confirm=true`。
- `douyin_audit_hosts`、`douyin_set_app_config`、`douyin_project_version`：平台信息和版本辅助操作。

所有动作都有超时；返回值包含 `ok`、`action`、`elapsedMs` 和结构化错误字段。日志只写入 stderr，并对 Token、Cookie、密码和 Authorization 等字段脱敏。

## 安装与验证

```powershell
cd C:\path\to\douyin-ide-control
npm install
npm run check
npm test
```

运行 MCP 前设置工作区：

```powershell
$env:DOUYIN_WORKSPACE_ROOT = 'C:\path\to\your\douyin-workspace'
# 如果 tma 不在 PATH 中：
# $env:DOUYIN_TMA_CLI_JS = 'C:\path\to\tt-ide-cli\bin\tma.js'
node src/server.mjs
```

插件清单位于 `.codex-plugin/plugin.json`，MCP 配置位于 `.mcp.json`。配置示例：

```json
{
  "douyin-ide-control": {
    "command": "node",
    "args": ["./src/server.mjs"],
    "startup_timeout_sec": 30
  }
}
```

## 官方依赖

```powershell
npm install -g tt-ide-cli
```

官方 CLI 文档：[小程序命令行工具](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/dev-tools/developer-instrument/development-assistance/ide-cli)。

## 烟测

默认烟测只初始化 MCP、列出工具并检查环境，不会打开工程、编译、截图或上传。需要对具体工程做完整烟测时，再设置：

```powershell
$env:DOUYIN_SMOKE_PROJECT = 'C:\path\to\your\project'
$env:DOUYIN_SMOKE_OUTPUT_DIR = 'C:\path\to\smoke-output'
npm run smoke
```

## IDE 兼容边界

- CDP 端口会随 IDE 实例变化，可通过 `DOUYIN_IDE_CDP_PORT` 显式指定。
- MCP 优先使用本地 CDP DOM，不使用截图识别或坐标猜测。
- IDE 全窗截图要求窗口可见；模拟器截图使用 Webview CDP。
- 控制台读取属于 best-effort，无法取得时返回明确的不支持状态，不伪造错误内容。

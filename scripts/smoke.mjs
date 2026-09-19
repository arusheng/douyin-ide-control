import { spawn } from "node:child_process";
import path from "node:path";

// 冒烟脚本：只做只读探测，除非显式提供被测工程。
//
// 工作区**不**用 process.cwd() 兜底：那会把插件目录冒充成工作区，让 WORKSPACE_NOT_CONFIGURED
// 这条真实故障被掩盖。这里如实把宿主环境传下去，未配置时验证并报告该错误码。
//
// 环境变量：
//   DOUYIN_WORKSPACE_ROOT   工作区根目录（未设置时脚本会验证 WORKSPACE_NOT_CONFIGURED）
//   DOUYIN_SMOKE_PROJECT    被测工程路径；设置了才会执行打开/预览/编译/截图
//   DOUYIN_SMOKE_OUTPUT_DIR 截图等输出目录（默认 <工作区>/.mcp-smoke）
const workspaceRoot = process.env.DOUYIN_WORKSPACE_ROOT || "";
const smokeProject = process.env.DOUYIN_SMOKE_PROJECT || "";
const smokeOutput = process.env.DOUYIN_SMOKE_OUTPUT_DIR
  || (workspaceRoot ? path.join(workspaceRoot, ".mcp-smoke") : "");

function startServer() {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    // 原样继承环境：不注入任何"看起来像工作区"的默认值
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); callback(message); }
    }
  });
  return {
    child,
    request(method, params = {}) {
      const id = Date.now() + pending.size;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 180000);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
    close() { child.kill(); },
  };
}

async function initialize(client) {
  const response = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-smoke", version: "0.2.0" },
  });
  client.notify("notifications/initialized");
  return response;
}

async function call(client, name, args = {}) {
  const response = await client.request("tools/call", { name, arguments: args });
  const text = response.result?.content?.[0]?.text;
  let payload;
  try { payload = text ? JSON.parse(text) : response.error; } catch { payload = { raw: text }; }
  return { isError: Boolean(response.result?.isError), payload };
}

const results = {};
const client = startServer();
try {
  results.initialize = await initialize(client);
  results.toolNames = (await client.request("tools/list")).result?.tools?.map((t) => t.name) || [];
  results.workspaceConfigured = Boolean(workspaceRoot);
  results.environment = await call(client, "douyin_check_environment");

  if (!workspaceRoot) {
    // 未配置工作区：验证并如实报告拒绝行为，而不是假装正常
    results.workspaceProbe = await call(client, "douyin_project_size", {
      projectPath: smokeProject || path.join(process.cwd(), "nonexistent-project"),
    });
    results.note = "未设置 DOUYIN_WORKSPACE_ROOT：已按未配置工作区验证（期望 WORKSPACE_NOT_CONFIGURED）";
  } else if (smokeProject) {
    results.open = await call(client, "douyin_open_project", { projectPath: smokeProject });
    results.preview = await call(client, "douyin_preview", {
      projectPath: smokeProject, qrcodeOutput: path.join(smokeOutput, "smoke-preview.png"),
    });
    results.buildNpm = await call(client, "douyin_build_npm", { projectPath: smokeProject });
    results.compile = await call(client, "douyin_compile_refresh", { mode: "compile", projectPath: smokeProject });
    results.ideCapture = await call(client, "douyin_capture", {
      target: "ide_window", outputPath: path.join(smokeOutput, "smoke-ide-window.png"), projectPath: smokeProject,
    });
    results.simulatorCapture = await call(client, "douyin_capture", {
      target: "simulator", outputPath: path.join(smokeOutput, "smoke-simulator.png"), projectPath: smokeProject,
    });
    results.console = await call(client, "douyin_read_console_errors", { projectPath: smokeProject });
  } else {
    results.note = "已配置工作区但未设置 DOUYIN_SMOKE_PROJECT：只做只读探测，已跳过打开/预览/编译/截图";
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  client.close();
}

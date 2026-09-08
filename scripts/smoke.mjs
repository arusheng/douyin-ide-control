import { spawn } from "node:child_process";
import path from "node:path";

const workspaceRoot = process.env.DOUYIN_WORKSPACE_ROOT || process.cwd();
const smokeProject = process.env.DOUYIN_SMOKE_PROJECT || "";
const smokeOutput = process.env.DOUYIN_SMOKE_OUTPUT_DIR || path.join(workspaceRoot, ".mcp-smoke");

function startServer() {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DOUYIN_WORKSPACE_ROOT: workspaceRoot },
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
    clientInfo: { name: "douyin-ide-control-smoke", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  return response;
}

async function call(client, name, args = {}) {
  const response = await client.request("tools/call", { name, arguments: args });
  const text = response.result?.content?.[0]?.text;
  return { isError: Boolean(response.result?.isError), payload: text ? JSON.parse(text) : response.error };
}

const client = startServer();
try {
  const results = {};
  results.initialize = await initialize(client);
  results.tools = await client.request("tools/list");
  results.environment = await call(client, "douyin_check_environment");
  if (smokeProject) {
    results.open = await call(client, "douyin_open_project", { projectPath: smokeProject });
    results.preview = await call(client, "douyin_preview", { projectPath: smokeProject, qrcodeOutput: path.join(smokeOutput, "smoke-preview.png") });
    results.buildNpm = await call(client, "douyin_build_npm", { projectPath: smokeProject });
    results.compile = await call(client, "douyin_compile_refresh", { mode: "compile", projectPath: smokeProject });
    results.ideCapture = await call(client, "douyin_capture", { target: "ide_window", outputPath: path.join(smokeOutput, "smoke-ide-window.png"), projectPath: smokeProject });
    results.simulatorCapture = await call(client, "douyin_capture", { target: "simulator", outputPath: path.join(smokeOutput, "smoke-simulator.png"), projectPath: smokeProject });
    results.console = await call(client, "douyin_read_console_errors", { projectPath: smokeProject });
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  client.close();
}

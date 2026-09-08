import fs from "node:fs";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandFailure } from "../src/cli.mjs";
import { ensureOutputPath, WORKSPACE_ROOT } from "../src/path-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer() {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: { ...process.env, DOUYIN_WORKSPACE_ROOT: "D:\\动物大作战" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); callback(message); }
    }
  });
  return {
    child,
    request(method, params = {}, timeoutMs = 15000) {
      const id = pending.size + Date.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 请求超时: ${method}`)); }, timeoutMs);
        pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
    close() { child.kill(); },
  };
}

test("stdio MCP 注册工具并拒绝危险动作默认执行", async (t) => {
  const client = startServer();
  t.after(() => client.close());
  const initialized = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-test", version: "0.1.0" },
  });
  assert.equal(initialized.jsonrpc, "2.0");
  client.notify("notifications/initialized");
  const listed = await client.request("tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("douyin_check_environment"));
  assert.ok(names.includes("douyin_capture"));
  assert.ok(names.includes("douyin_upload"));
  // 专项完善新增工具必须注册
  assert.ok(names.includes("douyin_project_identity"), "应注册 douyin_project_identity");
  assert.ok(names.includes("douyin_create_minigame_project"), "应注册 douyin_create_minigame_project");
  // tmg（小游戏专用 CLI）工具必须注册
  assert.ok(names.includes("douyin_tmg_check"), "应注册 douyin_tmg_check");
  assert.ok(names.includes("douyin_tmg_open"), "应注册 douyin_tmg_open");
  // 第二轮优化新增工具必须注册
  assert.ok(names.includes("douyin_project_size"), "应注册 douyin_project_size");
  assert.ok(names.includes("douyin_audit_hosts"), "应注册 douyin_audit_hosts");
  assert.ok(names.includes("douyin_set_app_config"), "应注册 douyin_set_app_config");
  assert.ok(names.includes("douyin_project_version"), "应注册 douyin_project_version");
  assert.equal(names.length, 17, `工具总数应为 17，实际 ${names.length}`);

  const blocked = await client.request("tools/call", {
    name: "douyin_upload",
    arguments: { appChangelog: "smoke" },
  });
  assert.equal(blocked.result.isError, true);
  const payload = JSON.parse(blocked.result.content[0].text);
  assert.equal(payload.data.error.code, "CONFIRMATION_REQUIRED");
});

test("路径白名单拒绝工作区外路径", async (t) => {
  const client = startServer();
  t.after(() => client.close());
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-test", version: "0.1.0" },
  });
  const blocked = await client.request("tools/call", {
    name: "douyin_check_environment",
    arguments: { projectPath: "C:\\Windows" },
  });
  assert.equal(blocked.result.isError, true);
  const payload = JSON.parse(blocked.result.content[0].text);
  assert.equal(payload.data.error.code, "PATH_NOT_ALLOWED");
});

test("识别官方 CLI 退出码为 0 但 stderr 报错", () => {
  assert.throws(
    () => commandFailure({ exitCode: 0, timedOut: false, stdout: "", stderr: "Project Error: AppId is not valid" }, "preview"),
    (error) => error.code === "CLI_COMMAND_FAILED",
  );
});

test("识别退出码为 0 但 stdout 含 Project Error 的 CLI 失败", () => {
  assert.throws(
    () => commandFailure({ exitCode: 0, timedOut: false, stdout: "Project Error: invalid AppId", stderr: "" }, "preview"),
    (error) => error.code === "CLI_COMMAND_FAILED",
  );
});

test("拒绝解析到工作区外的目录联接和输出目标", (t) => {
  // 测试夹具放在系统临时目录下：安全删除 shim 对 temp 目录豁免（原生删除），
  // 避免 WorkBuddy 沙箱将 rmSync 拦截为回收站 trash 导致清理失败。
  const fixtureRoot = path.join(os.tmpdir(), `douyin-ide-control-fixtures-${process.pid}-${Date.now()}`);
  const junction = path.join(fixtureRoot, "windows-junction");
  const fileLink = path.join(fixtureRoot, "windows-file-link");
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });

  try {
    try {
      fs.symlinkSync(process.env.WINDIR || "C:\\Windows", junction, "junction");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        t.skip(`当前 Windows 策略不允许创建测试目录联接: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => ensureOutputPath(path.join(junction, "new-output.png")),
      (error) => error.code === "PATH_NOT_ALLOWED",
    );
    assert.throws(
      () => ensureOutputPath(junction),
      (error) => error.code === "PATH_NOT_ALLOWED",
    );

    try {
      fs.symlinkSync(path.join(process.env.WINDIR || "C:\\Windows", "win.ini"), fileLink, "file");
      assert.throws(
        () => ensureOutputPath(fileLink),
        (error) => error.code === "PATH_NOT_ALLOWED",
      );
    } catch (error) {
      if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
      t.diagnostic(`跳过文件链接子检查: ${error.code}`);
    }
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("create_minigame_project 对非空目录返回顶层失败（ok:false / isError:true）", async (t) => {
  const client = startServer();
  t.after(() => client.close());
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-test", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  // minigame 目录非空（三件套在），应顶层拒绝
  const called = await client.request("tools/call", {
    name: "douyin_create_minigame_project",
    arguments: { projectPath: "D:\\动物大作战\\minigame", appid: "tt00000000000000000000" },
  });
  assert.equal(called.result.isError, true, "非空目录必须顶层失败");
  const payload = JSON.parse(called.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.data.error.code, "DIRECTORY_NOT_EMPTY");
});

test("create_minigame_project 对工作区外路径返回 PATH_NOT_ALLOWED 顶层失败", async (t) => {
  const client = startServer();
  t.after(() => client.close());
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-test", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  const called = await client.request("tools/call", {
    name: "douyin_create_minigame_project",
    arguments: { projectPath: "C:\\Windows\\evil", appid: "tt00000000000000000000" },
  });
  assert.equal(called.result.isError, true);
  const payload = JSON.parse(called.result.content[0].text);
  assert.equal(payload.data.error.code, "PATH_NOT_ALLOWED");
});

test("open_project 身份错误必须顶层失败（isError:true），不得塞入 identity.ok:false 返回成功", async (t) => {
  // 真实集成测试：会调用官方 CLI 打开工程并读取 IDE 状态，需要本机已装 IDE/已登录。
  // 默认跳过以保证 npm test 无副作用；设置 DOUYIN_LIVE_TESTS=1 才执行。
  if (!process.env.DOUYIN_LIVE_TESTS) {
    t.skip("需要真实 IDE/登录态，设置 DOUYIN_LIVE_TESTS=1 才会执行");
    return;
  }
  // 通过 stdio 协议调用，利用真实 IDE 状态验证：minigame 当前被 IDE 按 miniapp 编译，
  // 期望 minigame 应返回 PROJECT_TYPE_MISMATCH 顶层失败（若 IDE 不在则 PROJECT_TYPE_UNKNOWN 也属顶层失败）
  const client = startServer();
  t.after(() => client.close());
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "douyin-ide-control-test", version: "0.1.0" },
  });
  client.notify("notifications/initialized");
  const called = await client.request("tools/call", {
    name: "douyin_open_project",
    arguments: {
      projectPath: "D:\\动物大作战\\minigame",
      expectedAppid: "tt00000000000000000000",
      expectedProjectType: "minigame",
      timeoutMs: 60000,
    },
  }, 120000);
  // 无论身份结果是哪种错误，都必须是顶层失败
  assert.equal(called.result.isError, true, "身份不符必须顶层失败");
  const payload = JSON.parse(called.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.ok(
    ["APP_PERMISSION_DENIED", "PROJECT_TYPE_MISMATCH", "APPID_MISMATCH", "PROJECT_TYPE_UNKNOWN", "IDE_STARTUP_TIMEOUT"].includes(payload.data.error.code),
    `错误码应为身份类或超时，实际 ${payload.data.error.code}`,
  );
});




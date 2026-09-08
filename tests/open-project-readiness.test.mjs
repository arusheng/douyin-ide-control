import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTmaEnv, setCliRunner, setReadinessProbes, openProjectWithReadiness } from "../src/cli.mjs";

// 恒成功的 CLI 替身：模拟 tma open 打印 "Open IDE success" 且 exitCode 0
function stubCliSuccess() {
  setCliRunner(async () => ({
    exitCode: 0,
    timedOut: false,
    stdout: "Open project. [path=D:\\动物大作战\\project]\nOpen IDE success\n",
    stderr: "",
  }));
}

test("cleanTmaEnv 删除 ELECTRON_RUN_AS_NODE 且保留其他环境变量与 FORCE_COLOR=0", () => {
  const before = process.env.ELECTRON_RUN_AS_NODE;
  const preserveKey = "DOUYIN_TEST_PRESERVE";
  const preserveValue = "keep-me";
  // Windows 环境变量键不区分大小写，但 JS 对象键区分，且不同宿主可能实际使用
  // Path/path、windir 等不同大小写形式——因此这里只用唯一临时变量验证"保留"，
  // 避免对固定大小写键名的脆弱断言。
  const hadPreserve = Object.prototype.hasOwnProperty.call(process.env, preserveKey);
  const previousPreserve = process.env[preserveKey];
  process.env.ELECTRON_RUN_AS_NODE = "1";
  process.env[preserveKey] = preserveValue;
  try {
    const env = cleanTmaEnv();
    assert.equal("ELECTRON_RUN_AS_NODE" in env, false, "必须删除 ELECTRON_RUN_AS_NODE");
    assert.equal(env.FORCE_COLOR, "0", "必须保留 FORCE_COLOR=0");
    // 唯一临时变量必须被保留，证明除 ELECTRON_RUN_AS_NODE 外其他变量不被删除
    assert.equal(env[preserveKey], preserveValue, "其他环境变量应保持不变");
  } finally {
    if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = before;
    if (hadPreserve) process.env[preserveKey] = previousPreserve;
    else delete process.env[preserveKey];
  }
});

test("cleanTmaEnv 生成全新对象，不修改 process.env 本身", () => {
  const preserveKey = "DOUYIN_TEST_PRESERVE";
  const preserveValue = "keep-me";
  const hadPreserve = Object.prototype.hasOwnProperty.call(process.env, preserveKey);
  const previousPreserve = process.env[preserveKey];
  process.env[preserveKey] = preserveValue;
  try {
    const snapshot = { ...process.env };
    const env = cleanTmaEnv();
    assert.notEqual(env, process.env, "必须是新对象");
    // 调用后 process.env 原对象不应被改动（cleanTmaEnv 只在副本上操作）
    assert.equal(process.env[preserveKey], preserveValue);
    assert.equal(env[preserveKey], preserveValue, "副本应保留该变量");
    assert.equal(env.FORCE_COLOR, "0");
  } finally {
    if (hadPreserve) process.env[preserveKey] = previousPreserve;
    else delete process.env[preserveKey];
  }
});

test("CLI 报成功但只有进程存活、无窗口/CDP 时抛出 IDE_STARTUP_TIMEOUT，不得误报成功", async () => {
  stubCliSuccess();
  setReadinessProbes({
    window: async () => { throw new Error("target IDE window was not found"); },
    cdp: async () => { throw new Error("IDE CDP 不可用: fetch failed"); },
    process: async () => ({ running: true }),   // 仅进程存活
  });

  let rejected = null;
  try {
    await openProjectWithReadiness("D:\\动物大作战\\project", {
      cliTimeoutMs: 5000,
      pollTotalMs: 3000,
      pollIntervalMs: 100,
    });
  } catch (error) {
    rejected = error;
  }

  assert.ok(rejected, "仅进程存活不应视为就绪，必须抛出错误");
  assert.equal(rejected.code, "IDE_STARTUP_TIMEOUT");
  assert.match(rejected.message, /未在预期时间内就绪/);
  // 进程状态仍应作为诊断信息保留
  assert.equal(rejected.details.attempts[0].process.running, true);
  assert.equal(rejected.details.attempts[0].window.ok, false);
  assert.equal(rejected.details.attempts[0].cdp.ok, false);
});

test("CLI 报成功但 IDE 窗口/CDP/进程均未就绪时抛出 IDE_STARTUP_TIMEOUT，绝不误报成功", async () => {
  stubCliSuccess();
  setReadinessProbes({
    window: async () => { throw new Error("target IDE window was not found"); },
    cdp: async () => { throw new Error("IDE CDP 不可用: fetch failed"); },
    process: async () => ({ running: false }),
  });

  let rejected = null;
  try {
    await openProjectWithReadiness("D:\\动物大作战\\project", {
      cliTimeoutMs: 5000,
      pollTotalMs: 3000,
      pollIntervalMs: 100,
    });
  } catch (error) {
    rejected = error;
  }

  assert.ok(rejected, "应当抛出错误而不是返回成功");
  assert.equal(rejected.code, "IDE_STARTUP_TIMEOUT");
  assert.match(rejected.message, /未在预期时间内就绪/);
  assert.ok(rejected.details.cli, "错误详情应包含 CLI 输出");
  assert.match(rejected.details.cli.stdout, /Open IDE success/);
  assert.ok(Array.isArray(rejected.details.attempts), "错误详情应包含探测记录");
  assert.ok(rejected.details.attempts.length >= 1, "至少应有一次探测记录");
  assert.equal(rejected.details.attempts[0].window.ok, false);
  assert.equal(rejected.details.attempts[0].cdp.ok, false);
  assert.equal(rejected.details.attempts[0].process.running, false);
});

test("窗口探针就绪时视为 IDE 启动成功", async () => {
  stubCliSuccess();
  setReadinessProbes({
    window: async () => ({ supported: true, pid: 1234, title: "抖音开发者工具 - project" }),
    cdp: async () => { throw new Error("IDE CDP 不可用"); },
    process: async () => ({ running: true }),
  });

  const result = await openProjectWithReadiness("D:\\动物大作战\\project", {
    cliTimeoutMs: 5000,
    pollTotalMs: 3000,
    pollIntervalMs: 100,
  });
  assert.equal(result.ready, true);
  assert.equal(result.lastState.window.ok, true);
  assert.equal(result.command.exitCode, 0);
});

test("CDP 探针就绪（含 port/targets 字段，未显式 supported）时视为 IDE 启动成功", async () => {
  stubCliSuccess();
  setReadinessProbes({
    window: async () => { throw new Error("target IDE window was not found"); },
    cdp: async () => ({ port: 8830, workbench: true, simulator: true, targets: [] }),
    process: async () => ({ running: false }),
  });

  const result = await openProjectWithReadiness("D:\\动物大作战\\project", {
    cliTimeoutMs: 5000,
    pollTotalMs: 3000,
    pollIntervalMs: 100,
  });
  assert.equal(result.ready, true);
  assert.equal(result.lastState.cdp.ok, true);
});

test("恢复注入替身，避免影响其他用例", () => {
  setCliRunner(null);
  setReadinessProbes(null);
  assert.ok(true);
});

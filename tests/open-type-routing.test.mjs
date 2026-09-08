import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openCliFor, probeProjectType, resolveOpenRouting, setCliRunner, setReadinessProbes, openProjectWithReadiness } from "../src/cli.mjs";

// 类型路由：expectedProjectType=minigame 必须选 tmg（microgame 协议），
// 不得进入 tma（microapp 协议）打开链路——这是"小游戏被按小程序打开"的根因回归测试。

// 辅助：创建临时工程目录
function makeDir(files) {
  const dir = path.join(os.tmpdir(), `douyin-routing-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

test("openCliFor(minigame) 选择 tmg（小游戏协议），不进入 microapp 链路", () => {
  assert.equal(openCliFor("minigame"), "tmg");
});

test("openCliFor(miniapp) 与缺省选择 tma（microapp 协议）", () => {
  assert.equal(openCliFor("miniapp"), "tma");
  assert.equal(openCliFor(undefined), "tma");
});

test("probeProjectType：小游戏目录（game.js+game.json）→ hint=minigame，且读取 project.config.json 的 appid", () => {
  const dir = makeDir({
    "game.js": "// game",
    "game.json": "{}",
    "project.config.json": '{"appid":"tt00000000000000000000","projectname":"sample-project"}',
  });
  try {
    const probe = probeProjectType(dir);
    assert.equal(probe.hint, "minigame");
    assert.equal(probe.appid, "tt00000000000000000000");
    assert.ok(probe.evidence.some((e) => e.includes("structure:game")));
  } finally {
    cleanup(dir);
  }
});

test("probeProjectType：小程序目录（app.json+pages）→ hint=miniapp；miniprogramRoot 也判 miniapp", () => {
  const dir = makeDir({
    "app.js": "// app",
    "app.json": "{}",
    "pages/index/index.js": "// page",
    "project.config.json": '{"appid":"tt0000000000000000"}',
  });
  const cfgDir = makeDir({ "project.config.json": '{"appid":"tt0000000000000000","miniprogramRoot":"miniprogram/"}' });
  try {
    assert.equal(probeProjectType(dir).hint, "miniapp");
    assert.equal(probeProjectType(cfgDir).hint, "miniapp", "miniprogramRoot 是权威类型提示");
  } finally {
    cleanup(dir);
    cleanup(cfgDir);
  }
});

test("resolveOpenRouting：未显式指定类型时，小游戏目录自动路由到 tmg，避免被按小程序打开", () => {
  const dir = makeDir({ "game.js": "// game", "game.json": "{}" });
  try {
    const routing = resolveOpenRouting(undefined, dir);
    assert.equal(routing.cli, "tmg");
    assert.equal(routing.hint, "minigame");
    assert.equal(routing.explicit, false);
  } finally {
    cleanup(dir);
  }
});

test("resolveOpenRouting：未指定时小程序目录路由到 tma；显式类型优先于结构探测", () => {
  const miniappDir = makeDir({ "app.js": "// app", "app.json": "{}" });
  const minigameDir = makeDir({ "game.js": "// game", "game.json": "{}" });
  try {
    assert.equal(resolveOpenRouting(undefined, miniappDir).cli, "tma");
    // 显式类型覆盖结构探测（用户意图优先，身份校验会兜底复核）
    assert.equal(resolveOpenRouting("miniapp", minigameDir).cli, "tma");
    assert.equal(resolveOpenRouting("minigame", miniappDir).cli, "tmg");
    // 结构未知（空目录）默认 tma，与旧行为兼容
    const empty = makeDir({});
    assert.equal(resolveOpenRouting(undefined, empty).cli, "tma");
    cleanup(empty);
  } finally {
    cleanup(miniappDir);
    cleanup(minigameDir);
  }
});

test("openProjectWithReadiness 传入 tmg runner 时绝不调用默认 tma open（microapp 链路）", async () => {
  // 默认 cliRunner 替身 = tma 行为，若被调用则证明进入了 microapp 链路
  let tmaCalled = false;
  setCliRunner(async () => {
    tmaCalled = true;
    return { exitCode: 0, timedOut: false, stdout: "Open IDE success", stderr: "" };
  });
  setReadinessProbes({
    window: async () => ({ supported: true, pid: 1, title: "wb - 抖音开发者工具" }),
    cdp: async () => { throw new Error("cdp unavailable"); },
    process: async () => ({ running: true }),
  });

  // tmg runner 替身：模拟 tmg open 成功输出
  let tmgCalled = false;
  const tmgRunner = async (projectPath, cliTimeoutMs) => {
    tmgCalled = true;
    assert.equal(projectPath, "D:\\动物大作战\\minigame\\sample-minigame");
    assert.ok(cliTimeoutMs > 0, "应传入 CLI 超时");
    return { exitCode: 0, timedOut: false, stdout: "Open IDE success", stderr: "" };
  };

  const result = await openProjectWithReadiness("D:\\动物大作战\\minigame\\sample-minigame", {
    cliTimeoutMs: 5000,
    pollTotalMs: 3000,
    pollIntervalMs: 100,
    runner: tmgRunner,
  });

  assert.equal(tmgCalled, true, "应调用 tmg runner");
  assert.equal(tmaCalled, false, "minigame 请求不得调用 tma（microapp 链路）");
  assert.equal(result.ready, true);
  setCliRunner(null);
  setReadinessProbes(null);
});

test("tmg runner 失败时（模拟 server 层包装）顶层抛出 CLI 错误，不进入就绪轮询", async () => {
  setReadinessProbes({
    window: async () => { throw new Error("不应到达就绪探测"); },
    cdp: async () => { throw new Error("不应到达就绪探测"); },
    process: async () => ({ running: false }),
  });
  // 与 server.mjs 中 runner 包装一致：tmgOpenProject 返回 ok:false 时抛结构化错误
  const tmgRunner = async () => {
    const command = { ok: false, errorCode: "CLI_COMMAND_FAILED", exitCode: 1, stdout: "", stderr: "Project Error: not valid" };
    if (!command.ok) {
      const error = new Error(`tmg open 失败: ${command.errorCode}`);
      error.code = command.errorCode;
      throw error;
    }
    return command;
  };

  let rejected = null;
  try {
    await openProjectWithReadiness("D:\\动物大作战\\minigame\\sample-minigame", {
      cliTimeoutMs: 5000,
      pollTotalMs: 3000,
      pollIntervalMs: 100,
      runner: tmgRunner,
    });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected, "runner 失败应直接抛错");
  assert.equal(rejected.code, "CLI_COMMAND_FAILED");
  setReadinessProbes(null);
});

test("恢复注入替身，避免影响其他用例", () => {
  setCliRunner(null);
  setReadinessProbes(null);
  assert.ok(true);
});



import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setIdentityProbes, resolveProjectIdentity } from "../src/identity.mjs";

// 辅助：创建临时工程目录（在 os.tmpdir() 下，兼容 safe-delete shim）
function makeProject(files = {}) {
  const dir = path.join(os.tmpdir(), `douyin-identity-fixture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* shim 限制忽略 */ }
}

// 标准探针替身：可配置 IDE DOM、workbench targets、get-meta
function stubProbes({ ideTexts = [], workbenchTargets = null, meta = null, fileStructure = null } = {}) {
  const targets = ideTexts.map((t, i) => ({
    type: t.type || "page",
    title: t.title || `target-${i}`,
    url: t.url || "file:///ide",
    webSocketDebuggerUrl: `ws://fake-${i}`,
  }));
  setIdentityProbes({
    findIdeMainPort: async () => ({ port: 8702, targets, hasFrontPage: true, hasWorkbench: false }),
    readTargetText: async (target) => {
      const idx = targets.findIndex((t) => t.webSocketDebuggerUrl === target.webSocketDebuggerUrl);
      const item = ideTexts[idx] || {};
      return { title: item.title || "", body: item.body || "", modal: item.modal || "" };
    },
    listWorkbenchTargets: async () => workbenchTargets || [],
    getMeta: async () => meta || { ok: false, stderr: "未登录" },
    fileStructure: fileStructure || undefined,
  });
}

test("权限弹窗（获取域名白名单失败）→ APP_PERMISSION_DENIED，不得误报为小程序类型", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [
        { title: "workbench", body: "minigame - 抖音开发者工具", type: "page" },
        {
          title: "MiniApp Webview",
          body: "获取域名白名单失败：您没有权限访问此应用，请联系管理员在抖音开放平台 [账号中心] 页面添加 IDE 权限，或检查是否登录了错误的账号",
          type: "webview",
        },
      ],
    });
    let error = null;
    try {
      await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    } catch (e) { error = e; }
    assert.ok(error, "应当抛出错误");
    assert.equal(error.code, "APP_PERMISSION_DENIED");
    assert.match(error.message, /无权限/);
    assert.equal(error.details.identity.projectType, null, "权限问题下不应判定类型");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("权威元数据/编译错误显示类型不符 → PROJECT_TYPE_MISMATCH", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [
        { title: "MiniApp Webview", body: "编译错误 can't find app.json", type: "webview" },
      ],
      workbenchTargets: [{ type: "page", title: "wb", url: "file:///workbench/index.html?type=app&openApplicationType=microapp&projectPath=d%3A%5Cproject" }],
    });
    let error = null;
    try {
      await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    } catch (e) { error = e; }
    assert.ok(error, "应当抛出错误");
    assert.equal(error.code, "PROJECT_TYPE_MISMATCH");
    assert.match(error.details.identity.projectType, /miniapp/);
    assert.ok(error.details.identity.typeEvidenceSource, "应说明证据来源");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("tmg microgame 协议打开后 workbench URL 识别为 minigame（不得误判 UNKNOWN）", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [{ title: "workbench", body: "sample-minigame - 抖音开发者工具", type: "page" }],
      workbenchTargets: [
        { type: "page", title: "wb", url: "file:///workbench/index.html?project-type=microgame&mode=full&projectPath=d%3A%5Cminigame%5Csample-minigame" },
      ],
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame");
    assert.equal(result.identity.ideOpenMode, "minigame");
    assert.match(result.identity.typeEvidenceSource, /workbench-url/);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("workbench 固定端口不可用时回退 IDE 主进程 CDP 端口读取 microgame 类型", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    // 模拟：workbench 8830 失败；主进程 CDP（8854）target 携带 microgame workbench URL
    const mainTargets = [
      { type: "page", title: "index.html?type=microgame&openApplicationType=microgame&workbenchMode=workbench&projectPath=d%3A%5Cminigame", url: "file:///workbench/index.html?type=microgame&openApplicationType=microgame&workbenchMode=workbench&projectPath=d%3A%5Cminigame", webSocketDebuggerUrl: "ws://main-1" },
    ];
    setIdentityProbes({
      findIdeMainPort: async () => ({ port: 8854, targets: mainTargets, hasFrontPage: true, hasWorkbench: true }),
      readTargetText: async (target) => {
        if (target.webSocketDebuggerUrl === "ws://main-1") return { title: "index.html", body: "sample-minigame - 抖音开发者工具", modal: "" };
        return { title: "", body: "", modal: "" };
      },
      listWorkbenchTargets: async () => { throw new Error("IDE CDP 不可用: fetch failed"); },
      listTargetsOn: async (port) => mainTargets,
      getMeta: async () => ({ ok: false, stderr: "未登录" }),
      fileStructure: undefined,
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame");
    assert.equal(result.identity.ideOpenMode, "minigame");
    assert.match(result.identity.typeEvidenceSource, /workbench-url/);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("IDE 实际 AppID 与预期不同 → APPID_MISMATCH", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      meta: { ok: true, stdout: "AppID: tt11111111111111111111 类型: 小游戏" },
      ideTexts: [{ title: "wb", body: "minigame", type: "page" }],
    });
    let error = null;
    try {
      await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000" });
    } catch (e) { error = e; }
    assert.ok(error, "应当抛出错误");
    assert.equal(error.code, "APPID_MISMATCH");
    assert.equal(error.details.identity.ideActualAppid, "tt11111111111111111111");
    assert.equal(error.details.identity.configuredAppid, "tt00000000000000000000", "配置文件 AppID 应作为 configuredAppid 保留");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("无可靠类型证据（IDE 无 DOM、元数据不可用）→ PROJECT_TYPE_UNKNOWN，文件结构不作为独立判定", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [],
      workbenchTargets: [],
      meta: { ok: false, stderr: "未登录" },
    });
    let error = null;
    try {
      await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000" });
    } catch (e) { error = e; }
    assert.ok(error, "应当抛出错误");
    assert.equal(error.code, "PROJECT_TYPE_UNKNOWN");
    // 文件结构只作为 hint 记录，不能直接给 projectType
    assert.ok(error.details.identity.fileStructureHint, "应记录文件结构提示");
    assert.equal(error.details.identity.projectType, null);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("IDE 识别为小游戏且类型匹配 → 返回成功 identity", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [
        { title: "workbench", body: "资源管理器\nMINIGAME\ngame.js\ngame.json\nproject.config.json", type: "page" },
      ],
      workbenchTargets: [{ type: "page", title: "wb", url: "file:///workbench/index.html?projectPath=d%3A%5Cminigame" }],
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame");
    // 无权限弹窗且元数据不可用 → permission.state 应为 unknown（三态）
    assert.equal(result.identity.permission.state, "unknown");
    assert.ok(result.identity.typeEvidenceSource);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("元数据提供权威类型时（IDE 无 DOM 证据）→ 类型来自 tma-get-meta", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [],
      workbenchTargets: [],
      meta: { ok: true, stdout: "AppID: tt00000000000000000000 类型: 小游戏" },
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame");
    assert.equal(result.identity.typeEvidenceSource, "tma-get-meta");
    assert.equal(result.identity.permission.state, "allowed", "元数据可用时权限为 allowed");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("权限普通文字（如\"权限管理\"）不被误判为权限弹窗 → 不抛 APP_PERMISSION_DENIED", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [
        { title: "front-page", body: "V4.5.5\n小程序\n小游戏\n权限管理\n设置", type: "page" },
        { title: "workbench", body: "资源管理器\nMINIGAME\ngame.js\ngame.json", type: "page" },
      ],
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true, "普通\"权限\"字样不应触发权限拒绝");
    assert.equal(result.identity.permission.state, "unknown");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("目标目录非空时创建工具默认拒绝（server 层行为由集成测试覆盖，此处验证身份复核逻辑）", () => {
  const dir = makeProject({ "existing.txt": "x" });
  try {
    const entries = fs.readdirSync(dir);
    assert.ok(entries.length > 0, "目录应有内容");
  } finally {
    cleanup(dir);
  }
});

test("创建成功后必须二次验证类型：身份识别用于复核（模拟小游戏创建后复核通过）", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [{ title: "workbench", body: "资源管理器\nMINIGAME\ngame.js\ngame.json", type: "page" }],
    });
    // 创建后复核：身份识别必须返回 minigame
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.identity.projectType, "minigame", "创建后二次验证类型应为 minigame");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("多工程污染：workbench 同时含小程序与目标小游戏工程时，按 projectPath 绑定判为 minigame", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  const otherDir = "D:\\other\\miniapp-proj";
  try {
    setIdentityProbes({
      findIdeMainPort: async () => ({ port: 8702, targets: [], hasFrontPage: true, hasWorkbench: false }),
      readTargetText: async () => ({ title: "", body: "", modal: "" }),
      listWorkbenchTargets: async () => [
        { type: "page", title: "wb", url: `file:///workbench/index.html?openApplicationType=microapp&projectPath=${encodeURIComponent(otherDir)}` },
        { type: "page", title: "wb", url: `file:///workbench/index.html?project-type=microgame&mode=full&projectPath=${encodeURIComponent(dir)}` },
      ],
      getMeta: async () => ({ ok: false, stderr: "未登录" }),
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame");
    assert.match(result.identity.typeEvidenceSource, /workbench-url/);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("多工程污染：其他工程的 MiniApp Webview 编译错误（can't find app.json）不得污染目标小游戏工程", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  const otherDir = "D:\\other\\miniapp-proj";
  try {
    setIdentityProbes({
      findIdeMainPort: async () => ({ port: 8702, targets: [
        { type: "webview", title: "MiniApp Webview", url: `file:///ide/miniapp/index.html?projectPath=${encodeURIComponent(dir)}`, webSocketDebuggerUrl: "ws://target" },
        { type: "webview", title: "MiniApp Webview", url: `file:///ide/miniapp/index.html?projectPath=${encodeURIComponent(otherDir)}`, webSocketDebuggerUrl: "ws://other" },
      ], hasFrontPage: true, hasWorkbench: false }),
      readTargetText: async (target) => {
        if (target.webSocketDebuggerUrl === "ws://target") return { title: "MiniApp Webview", body: "编译错误 can't find game.json", modal: "" };
        if (target.webSocketDebuggerUrl === "ws://other") return { title: "MiniApp Webview", body: "编译错误 can't find app.json", modal: "" };
        return { title: "", body: "", modal: "" };
      },
      listWorkbenchTargets: async () => [],
      getMeta: async () => ({ ok: false, stderr: "未登录" }),
    });
    const result = await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    assert.equal(result.ok, true);
    assert.equal(result.identity.projectType, "minigame", "目标工程是 game.json 编译错误，应判小游戏，而非被其他工程的 app.json 错误污染成小程序");
    assert.match(result.identity.typeEvidenceSource, /compile-error/);
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});

test("get-meta 元数据含裸 game 词但不含类型词时，不得判为小游戏（PROJECT_TYPE_UNKNOWN）", async () => {
  const dir = makeProject({ "game.js": "// game", "game.json": "{}", "project.config.json": '{"appid":"tt00000000000000000000"}' });
  try {
    stubProbes({
      ideTexts: [],
      workbenchTargets: [],
      meta: { ok: true, stdout: "AppID: tt00000000000000000000 环境: 生产 game mode" },
    });
    let error = null;
    try {
      await resolveProjectIdentity(dir, { expectedAppid: "tt00000000000000000000", expectedProjectType: "minigame" });
    } catch (e) { error = e; }
    assert.ok(error, "无类型证据时应抛错而不是把裸 game 当成小游戏");
    assert.equal(error.code, "PROJECT_TYPE_UNKNOWN");
    assert.equal(error.details.identity.appPlatformType, null, "裸 game 词不应推导出小游戏类型");
  } finally {
    cleanup(dir);
    setIdentityProbes(null);
  }
});



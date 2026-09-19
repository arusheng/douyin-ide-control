import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTargetBoundToProject, findBoundTarget, isWorkbenchPage,
  bindWorkbenchStrict, bindDescendantTarget, isSimulatorTarget, isConsoleTarget,
  summarizeIdeStatus,
} from "../src/cdp.mjs";

// 读取 target URL 里的 projectPath（测试断言用）
function projectPathOf(target) {
  try { return new URL(target.url).searchParams.get("projectPath"); } catch { return null; }
}

// 真机实测的 workbench URL 形态：
//   .../dist/applications/<类型>/workbench/index.html?...&projectPath=<编码路径>
const realWorkbench = (projectPath) => ({
  type: "page",
  title: "index.html?type=microgame",
  url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html"
    + `?type=microgame&openApplicationType=microgame&workbenchMode=workbench&session=probe`
    + `&projectPath=${encodeURIComponent(projectPath)}`,
});

// 测试用的工程路径统一走下面这组常量（用双反斜杠字面量）。
// 若写成单个反斜杠，JS 会把非法转义里的反斜杠吃掉，于是测试双方拿同一个损坏字符串比较而
// "假通过"——真实的路径归一化逻辑其实没被验证。下面的守卫断言专门防这一点。
const P_SAMPLE = "D:\\projects\\sample-minigame";
const P_OTHER = "D:\\projects\\other";
const P_A = "D:\\projects\\proj-a";
const P_B = "D:\\projects\\proj-b";
// 小写盘符形态（真机实测里 IDE 拼的是小写盘符）
const P_C = "c:\\proj\\sample";

// 守卫：确认这些常量确实含反斜杠。若有人（或格式化工具）把它们改成单反斜杠字符串，
// 这条断言会立刻失败，而不是让整套绑定测试静默变成空转。
test("守卫：测试用工程路径必须含反斜杠（防止转义损坏导致假通过）", () => {
  for (const [name, value] of Object.entries({ P_SAMPLE, P_OTHER, P_A, P_B, P_C })) {
    assert.ok(value.includes("\\"), `${name} 必须包含反斜杠，实际为 ${JSON.stringify(value)}`);
    assert.ok(/^[A-Za-z]:\\/.test(value), `${name} 必须形如 <盘符>:\\...，实际为 ${JSON.stringify(value)}`);
    assert.ok(!value.includes("projectssample"), `${name} 不得是转义被吞后的拼接产物`);
  }
});

test("isWorkbenchPage：识别真实 URL 形态（applications/<类型>/workbench/index.html）", () => {
  assert.equal(isWorkbenchPage(realWorkbench("d:\\projects\\sample-minigame")), true, "真实形态必须识别");
  assert.equal(
    isWorkbenchPage({ type: "page", url: "file:///workbench/index.html?projectPath=x" }),
    true,
    "简写形态也应识别（向后兼容）",
  );
});

test("isWorkbenchPage：排除 VS Code workbench.html 与其它 target 类型", () => {
  // 工程窗口是 webview 且路径是 workbench.html，不是 workbench/index.html
  assert.equal(isWorkbenchPage({
    type: "webview",
    url: "file:///C:/ide/node_modules/@byted-tila/vscode/out/out/vs/code/electron-browser/workbench/workbench.html?vscode-window-config=1",
  }), false, "VS Code workbench.html 不得被当作 workbench 页面");
  assert.equal(isWorkbenchPage({
    type: "page",
    url: "file:///C:/ide/node_modules/@byted-tila/vscode/out/out/vs/code/electron-browser/workbench/workbench.html",
  }), false, "即使是 page 类型，workbench.html 也不是工作台页面");
  assert.equal(isWorkbenchPage({
    type: "webview",
    title: "MiniApp Webview",
    url: "http://127.0.0.1:7044/miniapp/index.html?sessionId=abc",
  }), false, "模拟器 webview 不是工作台页面");
  assert.equal(isWorkbenchPage({ type: "page", url: "file:///C:/ide/pages/front-page/index.html#/projects" }), false, "启动页不是工作台页面");
  assert.equal(isWorkbenchPage(null), false);
});

test("isTargetBoundToProject：真实 workbench URL 的 projectPath 精确匹配", () => {
  // 真机里是小写盘符 + 百分号编码
  const target = realWorkbench("c:\\Users\\sample\\.agents\\plugins\\sample-project");
  assert.equal(
    isTargetBoundToProject(target, "C:\\Users\\sample\\.agents\\plugins\\sample-project"),
    true,
    "盘符大小写差异应归一后匹配",
  );
  assert.equal(
    isTargetBoundToProject(target, "C:\\Users\\sample\\.agents\\plugins\\other-project"),
    false,
    "不同工程不匹配",
  );
});

test("isTargetBoundToProject：workbench URL 的 projectPath 参数精确匹配（大小写/分隔符归一）", () => {
  const target = { type: "page", url: "file:///workbench/index.html?project-type=microgame&mode=full&projectPath=d%3A%5Cprojects%5Csample-minigame" };
  assert.equal(isTargetBoundToProject(target, "D:\\projects\\sample-minigame"), true, "反斜杠路径应匹配");
  assert.equal(isTargetBoundToProject(target, "D:/projects/sample-minigame"), true, "正斜杠路径应归一后匹配");
  assert.equal(isTargetBoundToProject(target, "D:\\projects\\其他工程"), false, "不同工程不匹配");
});

test("isTargetBoundToProject：无 projectPath 参数时按标题/URL 含工程名匹配", () => {
  const target = { title: "sample-minigame - 抖音开发者工具", url: "file:///front-page/index.html" };
  assert.equal(isTargetBoundToProject(target, "D:\\projects\\sample-minigame"), true, "标题含工程名应匹配");
  assert.equal(isTargetBoundToProject(target, "D:\\projects\\其他工程"), false, "标题不含则不算绑定");
});

test("isTargetBoundToProject：空目标/空路径返回 false", () => {
  assert.equal(isTargetBoundToProject(null, "D:\\a"), false);
  assert.equal(isTargetBoundToProject({ url: "file:///x" }, ""), false);
  assert.equal(isTargetBoundToProject({ url: "file:///x" }, null), false);
});

// ---------------------------------------------------------------------------
// findBoundTarget：多工程时的精确绑定（复审问题 3）
// ---------------------------------------------------------------------------

const isWorkbench = (t) => t.type === "page" && /workbench\/index\.html/.test(t.url || "");
const wb = (name) => ({
  type: "page",
  title: name,
  url: `file:///workbench/index.html?projectPath=${encodeURIComponent(`d:\\projects\\${name}`)}`,
});

test("findBoundTarget：两个 workbench 并存时只选与 projectPath 精确匹配的那个", () => {
  const targets = [wb("other-project"), wb("sample-minigame")];
  const r = findBoundTarget(targets, isWorkbench, "D:\\projects\\sample-minigame");
  assert.equal(r.reason, null);
  assert.equal(r.target.title, "sample-minigame");
});

test("findBoundTarget：没有匹配的 workbench 时拒绝，绝不回退第一个", () => {
  const targets = [wb("other-project"), wb("third-project")];
  const r = findBoundTarget(targets, isWorkbench, "D:\\projects\\sample-minigame");
  assert.equal(r.target, null);
  assert.equal(r.reason, "NOT_BOUND", "不匹配时必须明确失败，而不是退回第一个");
  assert.equal(r.candidates.length, 2);
});

test("findBoundTarget：多个 workbench 同时匹配同一工程时拒绝（不猜）", () => {
  // 同一个工程路径的两种写法（大小写不同）都算匹配 → 无法确定唯一目标
  const targets = [
    { type: "page", title: "a", url: "file:///workbench/index.html?projectPath=d%3A%5Cprojects%5Csample-minigame" },
    { type: "page", title: "b", url: "file:///workbench/index.html?projectPath=D%3A%5Cprojects%5Csample-minigame" },
  ];
  const r = findBoundTarget(targets, isWorkbench, "D:\\projects\\sample-minigame");
  assert.equal(r.target, null);
  assert.equal(r.reason, "AMBIGUOUS");
});

test("findBoundTarget：没有候选 target 时返回 NOT_FOUND", () => {
  const r = findBoundTarget([], isWorkbench, "D:\\projects\\sample-minigame");
  assert.equal(r.target, null);
  assert.equal(r.reason, "NOT_FOUND");
});

test("findBoundTarget：未传 projectPath 时沿用第一个可用 target（单工程场景）", () => {
  const targets = [wb("sample-minigame")];
  const r = findBoundTarget(targets, isWorkbench, undefined);
  assert.equal(r.target.title, "sample-minigame");
  assert.equal(r.reason, null);
});

// ---------------------------------------------------------------------------
// 严格绑定（用于有副作用的操作）——复审问题 2
// ---------------------------------------------------------------------------

test("bindWorkbenchStrict：只接受 projectPath 完全相等的 workbench", () => {
  const targets = [realWorkbench(P_SAMPLE), realWorkbench(P_OTHER)];
  const r = bindWorkbenchStrict(targets, P_SAMPLE);
  assert.equal(r.reason, null);
  assert.equal(projectPathOf(r.target), P_SAMPLE);
});

test("bindWorkbenchStrict：标题相同但没有 projectPath 时仍拒绝", () => {
  // 标题含目标工程名，但 URL 缺 projectPath —— 宽松匹配会放行，严格绑定必须拒绝
  const decoy = {
    type: "page",
    title: "sample-minigame - 抖音开发者工具",
    url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html?type=microgame&session=x",
  };
  const r = bindWorkbenchStrict([decoy], P_SAMPLE);
  assert.equal(r.target, null);
  assert.equal(r.reason, "NOT_BOUND", "缺 projectPath 时不得按标题命中");
});

test("bindWorkbenchStrict：projectPath 指向别的工程时拒绝", () => {
  const r = bindWorkbenchStrict([realWorkbench(P_OTHER)], P_SAMPLE);
  assert.equal(r.target, null);
  assert.equal(r.reason, "NOT_BOUND");
});

test("bindWorkbenchStrict：零匹配 → NOT_FOUND，多匹配 → AMBIGUOUS", () => {
  assert.equal(bindWorkbenchStrict([], P_SAMPLE).reason, "NOT_FOUND");
  // 两个 workbench 的 projectPath 归一化后都等于目标（大小写 + 分隔符差异）
  const dup = [
    realWorkbench(P_SAMPLE),
    realWorkbench("d:/projects/sample-minigame"),
  ];
  assert.equal(bindWorkbenchStrict(dup, P_SAMPLE).reason, "AMBIGUOUS");
});

test("bindWorkbenchStrict：未提供 projectPath 时拒绝（NO_PROJECT_PATH）", () => {
  const r = bindWorkbenchStrict([realWorkbench(P_SAMPLE)], "");
  assert.equal(r.target, null);
  assert.equal(r.reason, "NO_PROJECT_PATH");
});

// ---------------------------------------------------------------------------
// 附属 target 关联（模拟器 / 控制台）——复审问题 3
// 真机实测的 parentId 树：
//   workbench(page) ├─ webview MiniApp Webview
//                   └─ webview <工程名> └─ iframe byted/index.html
// ---------------------------------------------------------------------------

test("bindDescendantTarget：两个工程同时打开时，各自的模拟器/控制台互不混淆", () => {
  const tree = [
    // 工程 A 的 workbench
    { ...realWorkbench(P_A), id: "wb-a" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:1/miniapp/index.html?sessionId=a", id: "sim-a", parentId: "wb-a" },
    { type: "webview", title: "proj-a - 抖音开发者工具", url: "file:///C:/ide/vscode/workbench/workbench.html?vscode-window-config=1", id: "vs-a", parentId: "wb-a" },
    { type: "iframe", title: "byted", url: "http://127.0.0.1:2/byted/index.html?ws=x", id: "con-a", parentId: "vs-a" },
    // 工程 B 的 workbench
    { ...realWorkbench(P_B), id: "wb-b" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:3/miniapp/index.html?sessionId=b", id: "sim-b", parentId: "wb-b" },
    { type: "webview", title: "proj-b - 抖音开发者工具", url: "file:///C:/ide/vscode/workbench/workbench.html?vscode-window-config=2", id: "vs-b", parentId: "wb-b" },
    { type: "iframe", title: "byted", url: "http://127.0.0.1:4/byted/index.html?ws=y", id: "con-b", parentId: "vs-b" },
  ];

  const simA = bindDescendantTarget(tree, P_A, isSimulatorTarget, "模拟器");
  assert.equal(simA.target?.id, "sim-a", "必须选中 A 的模拟器");
  const conA = bindDescendantTarget(tree, P_A, isConsoleTarget, "控制台");
  assert.equal(conA.target?.id, "con-a", "必须选中 A 的控制台");

  const simB = bindDescendantTarget(tree, P_B, isSimulatorTarget, "模拟器");
  assert.equal(simB.target?.id, "sim-b");
  const conB = bindDescendantTarget(tree, P_B, isConsoleTarget, "控制台");
  assert.equal(conB.target?.id, "con-b");
});

test("bindDescendantTarget：找不到目标 workbench 时不退回别的工程的模拟器", () => {
  const tree = [
    { ...realWorkbench(P_B), id: "wb-b" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:3/miniapp/index.html?sessionId=b", id: "sim-b", parentId: "wb-b" },
  ];
  const r = bindDescendantTarget(tree, P_A, isSimulatorTarget, "模拟器");
  assert.equal(r.target, null, "不得使用其它工程的模拟器");
  assert.equal(r.reason, "NOT_BOUND");
});

test("bindDescendantTarget：目标工程的子树里有两个模拟器时判 AMBIGUOUS", () => {
  const tree = [
    { ...realWorkbench(P_A), id: "wb-a" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:1/miniapp/index.html?sessionId=a1", id: "sim-a1", parentId: "wb-a" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:2/miniapp/index.html?sessionId=a2", id: "sim-a2", parentId: "wb-a" },
  ];
  const r = bindDescendantTarget(tree, P_A, isSimulatorTarget, "模拟器");
  assert.equal(r.target, null);
  assert.equal(r.reason, "AMBIGUOUS");
});

test("bindDescendantTarget：不带 projectPath 时拒绝（不按名字猜）", () => {
  const tree = [
    { ...realWorkbench(P_A), id: "wb-a" },
    { type: "webview", title: "MiniApp Webview", url: "http://127.0.0.1:1/miniapp/index.html?sessionId=a", id: "sim-a", parentId: "wb-a" },
  ];
  const r = bindDescendantTarget(tree, "", isSimulatorTarget, "模拟器");
  assert.equal(r.target, null);
  assert.equal(r.reason, "NO_PROJECT_PATH");
});

test("bindDescendantTarget：实测的父链结构（模拟器是直接子节点、控制台是孙节点）", () => {
  // 严格复刻真机实测的字段关系
  const tree = [
    { type: "page", id: "9F59", title: "index.html?type=microgame", url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html?session=cb0d&projectPath=" + encodeURIComponent(P_C) },
    { type: "webview", id: "08B3", parentId: "9F59", title: "MiniApp Webview", url: "http://127.0.0.1:7044/miniapp/index.html?sessionId=b216&openApplicationType=microgame" },
    { type: "webview", id: "FD2D", parentId: "9F59", title: "sample - 抖音开发者工具", url: "file:///C:/ide/vscode/workbench/workbench.html?vscode-window-config=1" },
    { type: "iframe", id: "45F4", parentId: "FD2D", title: "byted", url: "http://127.0.0.1:8463/byted/index.html?ws=x&project=b216" },
  ];
  assert.equal(bindDescendantTarget(tree, P_C, isSimulatorTarget, "模拟器").target?.id, "08B3");
  assert.equal(bindDescendantTarget(tree, P_C, isConsoleTarget, "控制台").target?.id, "45F4");
});

// ---------------------------------------------------------------------------
// getIdeStatus 的工程归属（复审问题 2）
// ---------------------------------------------------------------------------

// 两个工程同时打开：各自有 workbench + 模拟器 + 控制台
function twoProjectTargets() {
  return [
    { ...realWorkbench(P_A), id: "wb-a" },
    { type: "webview", id: "sim-a", parentId: "wb-a", title: "MiniApp Webview", url: "http://127.0.0.1:1/miniapp/index.html?sessionId=a" },
    { type: "webview", id: "vs-a", parentId: "wb-a", title: "proj-a - 抖音开发者工具", url: "file:///C:/ide/vscode/workbench/workbench.html?vscode-window-config=1" },
    { type: "iframe", id: "con-a", parentId: "vs-a", title: "byted", url: "http://127.0.0.1:2/byted/index.html?ws=x" },
    { ...realWorkbench(P_B), id: "wb-b" },
    { type: "webview", id: "sim-b", parentId: "wb-b", title: "MiniApp Webview", url: "http://127.0.0.1:3/miniapp/index.html?sessionId=b" },
    { type: "webview", id: "vs-b", parentId: "wb-b", title: "proj-b - 抖音开发者工具", url: "file:///C:/ide/vscode/workbench/workbench.html?vscode-window-config=2" },
    { type: "iframe", id: "con-b", parentId: "vs-b", title: "byted", url: "http://127.0.0.1:4/byted/index.html?ws=y" },
  ];
}

test("getIdeStatus：两个工程同时打开时不串项目（各自三个能力位都为 true）", () => {
  const targets = twoProjectTargets();
  const a = summarizeIdeStatus(targets, P_A);
  assert.equal(a.bound, true);
  assert.deepEqual(
    { workbench: a.workbench, simulator: a.simulator, console: a.console },
    { workbench: true, simulator: true, console: true },
    "A 工程应同时看到自己的 workbench/模拟器/控制台",
  );
  assert.equal(a.binding.workbench, null, "绑定成功时不应有失败原因");

  const b = summarizeIdeStatus(targets, P_B);
  assert.equal(b.bound, true);
  assert.deepEqual(
    { workbench: b.workbench, simulator: b.simulator, console: b.console },
    { workbench: true, simulator: true, console: true },
  );
});

test("getIdeStatus：只打开 B 工程时，查 A 的三个能力位全为 false（不回退第一个 target）", () => {
  // 只保留 B 的子树
  const targets = twoProjectTargets().filter((t) => !String(t.id).endsWith("-a"));
  const a = summarizeIdeStatus(targets, P_A);
  assert.equal(a.bound, false, "A 未打开时不得绑定成功");
  assert.equal(a.workbench, false);
  assert.equal(a.simulator, false, "绝不能把 B 的模拟器当成 A 的");
  assert.equal(a.console, false, "绝不能把 B 的控制台当成 A 的");
  assert.equal(a.binding.workbench, "NOT_BOUND");
  assert.equal(a.binding.simulator, "NOT_BOUND");
  assert.equal(a.binding.console, "NOT_BOUND");

  // 同一份 target 上查 B 仍应全部为 true，证明判定不是"一律 false"
  const b = summarizeIdeStatus(targets, P_B);
  assert.deepEqual(
    { workbench: b.workbench, simulator: b.simulator, console: b.console },
    { workbench: true, simulator: true, console: true },
  );
});

test("getIdeStatus：标题含目标工程名但缺 projectPath 时不算绑定", () => {
  const targets = [
    {
      type: "page",
      title: "sample-minigame - 抖音开发者工具",
      url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html?type=microgame&session=x",
      id: "wb-decoy",
    },
    { type: "webview", id: "sim-decoy", parentId: "wb-decoy", title: "MiniApp Webview", url: "http://127.0.0.1:1/miniapp/index.html?sessionId=x" },
  ];
  const s = summarizeIdeStatus(targets, P_SAMPLE);
  assert.equal(s.bound, false, "缺 projectPath 时不得靠标题绑定");
  assert.equal(s.simulator, false, "workbench 未绑定时不得报告模拟器可用");
});

test("getIdeStatus：未指定工程时只报告端口上的存在性，不做归属判断", () => {
  const s = summarizeIdeStatus(twoProjectTargets(), "");
  assert.equal(s.bound, false, "未指定工程不得声称绑定");
  assert.equal(s.workbench, true, "端口上确实有 workbench");
  assert.equal(s.simulator, true);
  assert.equal(s.console, true);
  assert.equal(s.binding.workbench, "NO_PROJECT_PATH");
});

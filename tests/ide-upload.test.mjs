// IDE 上传流程测试。
//
// 关键设计：不手写"假 DOM 语义"去模仿源码表达式（那是上一版的假通过根源）。
// 这里用**真实 DOM 实现（linkedom）**挂载 fixture，把**源码实际生成的表达式**交给它求值，
// 并用**唯一坐标 + 真实 CDP 事件序**驱动点击：只有同一坐标收到 mouseReleased 才产生副作用。
// 因此：
//   - 测试不再重复实现生产定位规则；
//   - CDP 事件缺失或失败时 DOM 不会变化（可断言）；
//   - 源码改了选择器，fixture 必须跟着改才会通过。
import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { parseHTML } from "linkedom";
import {
  setUploadDeps, validateUploadInput, clickLabel, uploadInIde, waitForUploadForm, verifyUploadResult,
} from "../src/ide-upload.mjs";

// ---------------------------------------------------------------------------
// 真实 DOM fixture（结构与文案均取自真机 CDP 实测）
// ---------------------------------------------------------------------------

// 上传工具栏在 **workbench 页面内**（实测：没有独立的 simulator-page target）。
// 真实结构：DIV.tila-toolbar-item-container > button.tila-button[aria-label] + DIV.tila-toolbar-item-title
const HTML = `
<div id="root">
  <div class="workbench-container workbench">
    <div class="tila-toolbar-container" id="toolbar">
      <div class="tila-toolbar-item-container" id="tb-upload">
        <button class="tila-button tila-button-secondary" aria-label="上传"></button>
        <div class="tila-toolbar-item-title">上传</div>
      </div>
      <div class="tila-toolbar-item-container" id="tb-compile">
        <button class="tila-button tila-button-secondary" aria-label="编译"></button>
        <div class="tila-toolbar-item-title">编译</div>
      </div>
      <div class="tila-toolbar-item-container" id="tb-preview">
        <button class="tila-button tila-button-secondary" aria-label="预览"></button>
        <div class="tila-toolbar-item-title">预览</div>
      </div>
    </div>
  </div>
  <div class="tila-editor-panel">
    <button id="editor-confirm">确定</button>
  </div>
</div>
`;

function makeDom(extraHtml = "") {
  const { document, window } = parseHTML(`<!doctype html><html><body>${HTML}${extraHtml}</body></html>`);

  // linkedom 的 Event 实现不允许写入 eventPhase，而源码的填表逻辑会 dispatchEvent
  // 一个 input/change 事件（模拟 React 受控组件）。这里换成最小可用的原生 Event，
  // 让 dispatchEvent 语义（冒泡、触发监听器）保持不变。
  window.Event = class Event {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.defaultPrevented = false;
      this.target = null;
      this.currentTarget = null;
      this.eventPhase = 0;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() {}
    stopImmediatePropagation() {}
  };

  // linkedom 无布局：用一个可编程的可见性模型模拟 offsetParent / getBoundingClientRect。
  const hidden = new Set();
  const rects = new WeakMap();
  // 元素 → 被点击时的效果（fixture 通过 dom.onClick(el, fn) 登记）
  const clicks = new Map();
  let nextCoord = 0;

  // 每个元素分配**唯一坐标**：这样"命中哪个元素"完全由坐标决定，
  // 不需要在测试里重新实现一遍生产定位规则（那会产生假阳性）。
  function coordsFor(el) {
    if (!rects.has(el)) {
      const seq = nextCoord += 1;
      // 每个元素独占一个 (x,y) 格子，保证坐标 → 元素是一对一
      const rect = { x: (seq % 200) * 10, y: Math.floor(seq / 200) * 10, width: 8, height: 8 };
      rect.left = rect.x; rect.top = rect.y;
      rect.right = rect.x + rect.width; rect.bottom = rect.y + rect.height;
      rects.set(el, rect);
    }
    return rects.get(el);
  }

  applyVisibility(document, hidden, coordsFor);

  // 坐标 → 元素 的反查表（只在被点击时构建，保证已分配的坐标都登记）
  function elementAt(x, y) {
    for (const el of document.querySelectorAll("*")) {
      if (!rects.has(el)) continue;
      const r = rects.get(el);
      if (Math.round(r.x + r.width / 2) === x && Math.round(r.y + r.height / 2) === y) return el;
    }
    return null;
  }

  const dom = {
    document,
    window,
    clicks,
    hide(el) { hidden.add(el); },
    show(el) { hidden.delete(el); },
    coordsFor,
    elementAt,
    // 让新插入的节点也具备同样的可见性模型与唯一坐标
    refresh() { applyVisibility(document, hidden, coordsFor, true); },
    // 登记"这个元素被点击时发生什么"（对应真实 IDE 里点击按钮后的界面变化）
    onClick(el, fn) { clicks.set(el, fn); return el; },
  };
  return dom;
}

// 给所有（含后续动态插入的）元素挂上 visibility 模型与唯一坐标
function applyVisibility(document, hidden, coordsFor, onlyUnpatched = false) {
  for (const el of document.querySelectorAll("*")) {
    if (onlyUnpatched && el.__visibilityPatched) continue;
    el.__visibilityPatched = true;
    Object.defineProperty(el, "offsetParent", {
      get() {
        // 自身或任一祖先被标记隐藏 → 视为不可见
        let node = el;
        while (node) {
          if (hidden.has(node)) return null;
          node = node.parentNode;
        }
        return document.body;
      },
      configurable: true,
    });
    el.getBoundingClientRect = () => coordsFor(el);
  }
}

// 上传表单弹窗（真实判别证据：placeholder 含"版本号"/"更新日志"）
// 按钮使用真实类名 tila-button（实测弹窗按钮即 tila-button.tila-button-primary/tertiary）。
function uploadFormDialog({ open = true, buttons = ["取消", "确定"] } = {}) {
  return `
  <div class="tila-modal" id="upload-modal"${open ? "" : ' style="display:none"'}>
    <div class="tila-modal-body">
      <span>上传版本</span>
      <input placeholder="请输入本次上传版本号，版本号填写示例: 1.0.0" />
      <textarea placeholder="请输入更新日志"></textarea>
    </div>
    <div class="tila-modal-footer">
      ${buttons.map((b) => `<button class="tila-button ${b === "确定" ? "tila-button-primary" : "tila-button-tertiary"}">${b}</button>`).join("")}
    </div>
  </div>`;
}

// 中间确认弹窗（巡检提示 + 继续上传），来自真实 i18n key
function intermediateDialog({ open = true } = {}) {
  return `
  <div class="tila-modal" id="inspection-modal"${open ? "" : ' style="display:none"'}>
    <div class="tila-modal-body"><span>上传前建议使用工程分析能力动态检测小程序各项指标</span></div>
    <div class="tila-modal-footer"><button class="tila-button tila-button-primary">继续上传</button></div>
  </div>`;
}

// 信任弹窗（实测：首次打开未信任工程时先出现，按钮「稍后运行」/「信任并运行」）
function trustDialog({ open = true } = {}) {
  return `
  <div class="tila-modal tila-modal-medium" id="trust-modal"${open ? "" : ' style="display:none"'}>
    <div class="tila-modal-body"><span>是否信任此项目？信任后将在模拟器中运行该工程代码</span></div>
    <div class="tila-modal-footer">
      <button class="tila-button tila-button-tertiary tila-button-light">稍后运行</button>
      <button class="tila-button tila-button-primary">信任并运行</button>
    </div>
  </div>`;
}

// 全局浮层提示
function toast(text, { id = "toast-1" } = {}) {
  return `<div class="tila-message" id="${id}"><span>${text}</span></div>`;
}

// ---------------------------------------------------------------------------
// 测试替身：evaluate 真的在 fixture DOM 上执行源码表达式
// ---------------------------------------------------------------------------

// 真实 IDE 的 workbench URL 形态（实测）：
//   .../dist/applications/<类型>/workbench/index.html?...&projectPath=<编码路径>
// 测试默认使用这个真实形态，避免"测试用的 URL 与真实不同"导致的假通过。
const REAL_WORKBENCH_URL = "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html"
  + "?type=microgame&openApplicationType=microgame&workbenchMode=workbench&session=probe"
  + "&projectPath=d%3A%5Cprojects%5Csample-minigame";

// 构造一个真实形态的 workbench target（可覆盖标题/ws/target 类型，用于边界用例）
function realWorkbench(projectPath, { title = "index.html?type=microgame", ws = "ws://wb", type = "page" } = {}) {
  return {
    type,
    title,
    url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html"
      + "?type=microgame&openApplicationType=microgame&workbenchMode=workbench&session=probe"
      + `&projectPath=${encodeURIComponent(projectPath)}`,
    webSocketDebuggerUrl: ws,
  };
}

function makeHarness({
  html = "",
  workbenchUrl = REAL_WORKBENCH_URL,
  targets,
  failMouseTypes = new Set(),
} = {}) {
  const dom = makeDom(html);
  const evaluations = [];
  const cdpCalls = [];

  // 源码表达式在 fixture DOM 上**真实求值**
  const runExpression = (expression) => {
    const fn = new Function(
      "document", "window", "HTMLInputElement", "HTMLTextAreaElement", "Event",
      `return ${expression}`,
    );
    return fn(
      dom.document, dom.window, dom.window.HTMLInputElement, dom.window.HTMLTextAreaElement, dom.window.Event,
    );
  };

  // 上一次 mousePressed 记录的按下坐标；只有同一坐标收到 mouseReleased 才算完成一次点击。
  let pressedAt = null;

  const deps = {
    resolveContext: async (projectPath) => ({
      port: 8830,
      targets: targets || [{ type: "page", url: workbenchUrl, title: "workbench", webSocketDebuggerUrl: "ws://wb" }],
    }),
    // CDP 鼠标事件按真实语义处理：
    //  - 只有 mouseReleased 成功送达，且落在某个元素坐标上，才触发该元素的点击效果；
    //  - mouseMoved / mousePressed 抛错时整次点击作废，DOM 不得发生任何变化；
    //  - 坐标由每个元素唯一分配，因此"点了谁"完全由坐标决定。
    openConnection: async () => ({
      call: async (method, params) => {
        cdpCalls.push({ method, params });
        if (method !== "Input.dispatchMouseEvent") return {};
        if (failMouseTypes.has(params.type)) {
          throw new Error(`CDP 注入失败: ${params.type}`);
        }
        if (params.type === "mousePressed") {
          pressedAt = { x: params.x, y: params.y };
          return {};
        }
        if (params.type === "mouseReleased") {
          const samePoint = pressedAt && pressedAt.x === params.x && pressedAt.y === params.y;
          pressedAt = null;
          if (!samePoint) return {}; // 按下与释放不在同一点 → 不算点击
          const el = dom.elementAt(params.x, params.y);
          if (el && dom.clicks.has(el)) dom.clicks.get(el)();
        }
        return {};
      },
      close: () => {},
    }),
    evaluate: async (target, expression) => {
      evaluations.push(expression);
      // 表达式在 fixture DOM 上**真实求值**；测试不再重新实现生产定位规则。
      return runExpression(expression);
    },
    isTargetBoundToProject,
  };

  return { dom, deps, evaluations, cdpCalls, failMouseTypes };
}

// 与源码一致的绑定判定（用于 resolveWorkbench 的注入）
function isTargetBoundToProject(target, projectPath) {
  const norm = (v) => String(v || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const wanted = norm(projectPath);
  if (!wanted || !target) return false;
  let ref;
  try { ref = new URL(target.url).searchParams.get("projectPath"); } catch { ref = null; }
  if (ref) return norm(ref) === wanted;
  const base = String(projectPath).split(/[\\/]/).filter(Boolean).pop() || "";
  if (!base) return false;
  return `${target.title || ""} ${target.url || ""}`.toLowerCase().includes(base.toLowerCase());
}

const PROJECT = "D:\\projects\\sample-minigame";

let harness;
afterEach(() => { setUploadDeps({}); });

// 便捷：装配harness并注入
function use(harnessOpts) {
  harness = makeHarness(harnessOpts);
  setUploadDeps(harness.deps);
  return harness;
}

// 往 fixture 里动态插入 HTML，并让新节点带上可见性模型。
// 用 insertAdjacentHTML 追加到 #root（而不是重写 body），保持已有监听器有效。
function appendHtml(html) {
  harness.dom.document.querySelector("#root").insertAdjacentHTML("beforeend", html);
  harness.dom.refresh();
}

// 移除某个弹窗/提示节点
function removeEl(selector) {
  const el = harness.dom.document.querySelector(selector);
  if (el) el.remove();
}

// 替换某个容器内的 HTML（用于模拟弹窗内容变化），并刷新可见性模型
function setInnerHtml(selector, html) {
  const el = harness.dom.document.querySelector(selector);
  if (!el) throw new Error(`fixture 缺少元素: ${selector}`);
  el.innerHTML = html;
  harness.dom.refresh();
}

// 上传表单里的「确定」按钮
function confirmButton() {
  const btns = [...harness.dom.document.querySelectorAll("#upload-modal .tila-modal-footer button")];
  const el = btns.find((b) => String(b.textContent).trim() === "确定");
  if (!el) throw new Error("fixture 缺少上传表单的「确定」按钮");
  return el;
}

// 找出生产代码在该作用域下**实际会点中**的元素（内层候选，文本最短）。
// 测试把点击副作用登记到这个元素上，避免"登记在容器、生产点按钮"造成假通过。
function clickTargetFor(scope, label) {
  const formScopes = () => [...harness.dom.document.querySelectorAll(".tila-modal,[role=dialog]")]
    .filter((box) => [...box.querySelectorAll("input,textarea")]
      .some((el) => /版本号|更新日志|日志/.test(String(el.placeholder || ""))));
  const visibleDialogs = () => [...harness.dom.document.querySelectorAll(".tila-modal,[role=dialog]")];
  const toolbarScopes = () => [...harness.dom.document.querySelectorAll(
    ".tila-toolbar-container,.tila-toolbar-item-container,[class*=toolbar],[role=menubar],[role=menu],[role=menuitem]",
  )];
  const roots = scope === "form" ? formScopes() : scope === "dialog" ? visibleDialogs() : toolbarScopes();
  const BUTTONS = "button,[role=button],[aria-label],.tila-toolbar-item-container,.tila-button,[class*=btn],[class*=Btn],[class*=button],[class*=Button]";
  const norm = (v) => String(v || "").replace(/\s+/g, "").trim();
  const found = [];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll(BUTTONS)]) {
      if (norm(el.textContent || el.getAttribute?.("aria-label")) === norm(label)) found.push(el);
    }
  }
  found.sort((a, b) => norm(a.innerText || a.textContent).length - norm(b.innerText || b.textContent).length);
  if (!found.length) throw new Error(`fixture 中找不到作用域 ${scope} 的「${label}」`);
  return found[0];
}

// 登记"点击「确定」之后界面变成什么"（对应真实上传提交后的结果展示）
function onSubmit(fn) {
  harness.dom.onClick(confirmButton(), fn);
}

// ---------------------------------------------------------------------------
// 1. 未确认时拒绝
// ---------------------------------------------------------------------------
test("未确认（confirm 缺失/false）时拒绝执行上传", async () => {
  use({ html: uploadFormDialog() });
  for (const confirm of [undefined, false]) {
    await assert.rejects(
      () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm }),
      (error) => error.code === "CONFIRMATION_REQUIRED",
    );
  }
  const submits = harness.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(submits.length, 0, "拒绝时不得产生任何鼠标事件");
});

// ---------------------------------------------------------------------------
// 2. 缺少版本号 / 更新日志
// ---------------------------------------------------------------------------
test("缺少 appVersion 时返回 UPLOAD_VERSION_REQUIRED，不使用默认版本号", async () => {
  use({ html: uploadFormDialog() });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appChangelog: "日志", confirm: true }),
    (error) => error.code === "UPLOAD_VERSION_REQUIRED",
  );
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "   ", appChangelog: "日志", confirm: true }),
    (error) => error.code === "UPLOAD_VERSION_REQUIRED",
  );
});

test("缺少 appChangelog 时返回 UPLOAD_CHANGELOG_REQUIRED", async () => {
  use({ html: uploadFormDialog() });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", confirm: true }),
    (error) => error.code === "UPLOAD_CHANGELOG_REQUIRED",
  );
});

test("validateUploadInput 不产生任何猜测默认值", () => {
  assert.throws(() => validateUploadInput({}), (e) => e.code === "UPLOAD_VERSION_REQUIRED");
  assert.throws(() => validateUploadInput({ appVersion: "1.0.0" }), (e) => e.code === "UPLOAD_CHANGELOG_REQUIRED");
  const ok = validateUploadInput({ appVersion: " 2.3.4 ", appChangelog: " 修复问题 " });
  assert.equal(ok.appVersion, "2.3.4");
  assert.equal(ok.appChangelog, "修复问题");
});

// ---------------------------------------------------------------------------
// 3. CDP 鼠标事件必须带 type（复审问题 1）
// ---------------------------------------------------------------------------
test("CDP 鼠标事件依次为 mouseMoved / mousePressed / mouseReleased 且都带 type", async () => {
  use({ html: uploadFormDialog() });
  const result = await clickLabel({
    target: { webSocketDebuggerUrl: "ws://wb" }, label: "确定", scope: "form", timeoutMs: 1000,
  });
  assert.equal(result.clicked, true);

  const mouse = harness.cdpCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(mouse.length, 3, `应发送 3 个鼠标事件，实际 ${mouse.length}`);
  assert.deepEqual(mouse.map((c) => c.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  // 每个事件都必须带 type（缺 type 时 CDP 会拒绝整个调用）
  for (const call of mouse) {
    assert.ok(call.params.type, "每个 Input.dispatchMouseEvent 都必须带 type");
    assert.equal(typeof call.params.x, "number");
    assert.equal(typeof call.params.y, "number");
  }
  // 按下/释放必须是左键
  assert.equal(mouse[1].params.button, "left");
  assert.equal(mouse[2].params.button, "left");
  assert.equal(mouse[1].params.clickCount, 1);
});

// ---------------------------------------------------------------------------
// 4. 作用域拆分（复审问题 2）
// ---------------------------------------------------------------------------
test("顶部工具栏的「上传」能从 toolbar 作用域找到", async () => {
  use({ html: "" });
  const found = await clickLabel({ target: {}, label: "上传", scope: "toolbar", timeoutMs: 1000 });
  assert.equal(found.clicked, true, "工具栏「上传」应可点击");
  assert.equal(found.scope, "toolbar");
});

test("「确定」只能从上传表单内找到：只有编辑器区的同名按钮时不点击", async () => {
  // 只有编辑器里的「确定」，没有上传弹窗
  use({ html: "" });
  const viaForm = await clickLabel({ target: {}, label: "确定", scope: "form", timeoutMs: 1000 });
  assert.equal(viaForm.clicked, false, "form 作用域内没有「确定」时必须失败");
  assert.equal(harness.cdpCalls.length, 0, "找不到时不得发出任何鼠标事件");

  // 确认那个「确定」确实存在于页面（说明不是 fixture 缺元素，而是作用域把它排除了）
  const viaToolbar = await clickLabel({ target: {}, label: "确定", scope: "dialog", timeoutMs: 1000 });
  assert.equal(viaToolbar.clicked, false, "非弹窗内的按钮不应被 dialog 作用域命中");
});

test("toolbar 作用域不会命中弹窗内的「确定」", async () => {
  use({ html: uploadFormDialog() });
  const viaToolbar = await clickLabel({ target: {}, label: "确定", scope: "toolbar", timeoutMs: 1000 });
  assert.equal(viaToolbar.clicked, false, "弹窗内按钮不属于工具栏作用域");
});

test("弹窗内与工具栏存在同名按钮时，提交只命中表单内那个", async () => {
  // 工具栏也放一个「确定」
  use({ html: uploadFormDialog() });
  appendHtml('<div class="tila-toolbar-item-container" id="tb-confirm"><span class="tila-toolbar-item-title">确定</span></div>');

  const formHit = await clickLabel({ target: {}, label: "确定", scope: "form", timeoutMs: 1000 });
  assert.equal(formHit.clicked, true);
  const toolbarHit = await clickLabel({ target: {}, label: "确定", scope: "toolbar", timeoutMs: 1000 });
  assert.equal(toolbarHit.clicked, true, "工具栏确实也有一个同名「确定」");

  // 完整流程：提交必须落在表单弹窗内
  setUploadDeps(harness.deps);
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 2000, verifyTimeoutMs: 300,
  });
  assert.equal(result.submit.scope, "form");
});

// ---------------------------------------------------------------------------
// 5. 中间弹窗探测与轮次上限（复审问题 4、5）
// ---------------------------------------------------------------------------
test("中间确认弹窗的「继续上传」能被探测到并点击", async () => {
  // 最初只有巡检弹窗，没有上传表单
  use({ html: intermediateDialog() });
  // 点击「继续上传」后换上真正的上传表单
  const continueBtn = clickTargetFor("dialog", "继续上传");
  harness.dom.onClick(continueBtn, () => {
    removeEl("#inspection-modal");
    appendHtml(uploadFormDialog());
  });

  const result = await waitForUploadForm({ target: {}, timeoutMs: 8000, intervalMs: 100 });
  assert.equal(result.ready, true, "处理「继续上传」后应看到上传表单");
  assert.equal(result.intermediate.length, 1);
  assert.equal(result.intermediate[0].label, "继续上传");
  assert.equal(result.intermediate[0].clicked, true);
});

test("中间弹窗超过 4 轮仍未进入表单时停止并报错，不会点到超时", async () => {
  // 每轮点击后弹窗正文都变化 → 每轮 key 都不同，必然触发上限
  use({ html: intermediateDialog() });
  let round = 0;
  const continueBtn = clickTargetFor("dialog", "继续上传");
  harness.dom.onClick(continueBtn, () => {
    round += 1;
    const box = harness.dom.document.querySelector("#inspection-modal .tila-modal-body span");
    if (box) box.textContent = `上传前建议使用工程分析能力动态检测小程序各项指标 ${round}`;
  });

  const result = await waitForUploadForm({ target: {}, timeoutMs: 20000, intervalMs: 50 });
  assert.equal(result.ready, false);
  assert.equal(result.errorCode, "UPLOAD_INTERMEDIATE_DIALOG_LIMIT");
  assert.ok(result.intermediate.length <= 4, `点击次数不得超过 4，实际 ${result.intermediate.length}`);
  assert.match(result.reason, /超过 4 轮/);
});

test("同一个中间弹窗不会被无意义重复点击", async () => {
  // 「继续上传」点了也不消失 → 同一 key 只应点一次
  use({ html: intermediateDialog() });
  const result = await waitForUploadForm({ target: {}, timeoutMs: 1500, intervalMs: 50 });
  assert.equal(result.ready, false);
  assert.equal(result.intermediate.length, 1, `同一弹窗只应点击一次，实际 ${result.intermediate.length}`);
});

// ---------------------------------------------------------------------------
// 6. 未提交必须返回顶层错误（复审问题 6）
// ---------------------------------------------------------------------------
test("找不到上传表单弹窗 → 顶层错误 IDE_UPLOAD_DIALOG_NOT_FOUND", async () => {
  use({ html: "" });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_UPLOAD_DIALOG_NOT_FOUND",
  );
});

test("版本号或更新日志填写失败 → 顶层错误 IDE_UPLOAD_FILL_FAILED", async () => {
  // 表单存在，但只有版本号字段，没有更新日志字段 → 日志填不进去
  use({
    html: `<div class="tila-modal" id="upload-modal">
      <div class="tila-modal-body"><input placeholder="请输入本次上传版本号" /></div>
      <div class="tila-modal-footer"><button class="tila-btn">确定</button></div>
    </div>`,
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1000 }),
    (error) => error.code === "IDE_UPLOAD_FILL_FAILED",
  );
});

test("上传弹窗内没有提交按钮 → 顶层错误 IDE_UPLOAD_SUBMIT_NOT_FOUND", async () => {
  // 表单齐备但没有「确定」；编辑区那个「确定」不属于 form 作用域
  use({ html: uploadFormDialog({ buttons: ["取消"] }) });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1200 }),
    (error) => error.code === "IDE_UPLOAD_SUBMIT_NOT_FOUND",
  );
});

test("提交按钮点击失败（CDP 抛错）→ 顶层错误，不返回 unverified", async () => {
  use({ html: uploadFormDialog() });
  // 表单已打开，因此流程中唯一的鼠标点击就是提交。
  // 让所有 Input.dispatchMouseEvent 失败 → 提交点击必然失败。
  harness.deps.openConnection = async () => ({
    close: () => {},
    call: async (method, params) => {
      harness.cdpCalls.push({ method, params });
      if (method === "Input.dispatchMouseEvent") throw new Error("CDP 连接已断开");
      return {};
    },
  });
  setUploadDeps(harness.deps);
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1200 }),
    // 关键：必须是"失败"而不是返回 unverified（那会被误读成已提交）
    (error) => /CDP/.test(error.message) || Boolean(error.code),
  );
  // 且不得出现"已点击提交"的返回：没有返回值就说明确实抛错了
});

test("多工程未绑定时 → 顶层错误 IDE_PROJECT_NOT_BOUND，不退回第一个 workbench", async () => {
  use({
    targets: [
      { type: "page", url: "file:///workbench/index.html?projectPath=d%3A%5Cprojects%5Cother", title: "other", webSocketDebuggerUrl: "ws://other" },
    ],
    html: uploadFormDialog(),
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

// ---------------------------------------------------------------------------
// 7. 结果核验（复审问题 7）
// ---------------------------------------------------------------------------
test("弹窗内出现成功提示 → status=success", async () => {
  use({ html: uploadFormDialog() });
  onSubmit(() => setInnerHtml("#upload-modal .tila-modal-body", "<span>上传成功，版本 1.0.0 已提交</span>"));
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 2000, verifyTimeoutMs: 2000,
  });
  assert.equal(result.submitted, true);
  assert.equal(result.status, "success");
  assert.equal(result.verification.autoRetry, false);
  // 摘要必须是可读文本，不是正则字符串
  assert.ok(result.verification.evidence.some((e) => e.includes("上传成功")));
  assert.ok(!result.verification.evidence.some((e) => e.startsWith("/")), "证据不得是正则字面量");
});

test("全局 Toast 成功提示也能被识别（不只是弹窗内文本）", async () => {
  use({ html: uploadFormDialog() });
  onSubmit(() => {
    removeEl("#upload-modal");
    appendHtml(toast("上传成功"));
  });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 2000, verifyTimeoutMs: 2000,
  });
  assert.equal(result.status, "success", "全局 Toast 的成功提示应被采纳");
});

test("IDE 明确失败提示 → status=failed", async () => {
  use({ html: uploadFormDialog() });
  onSubmit(() => setInnerHtml("#upload-modal .tila-modal-body", "<span>上传失败，请检查网络连接</span>"));
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 2000, verifyTimeoutMs: 2000,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.verification.retryRecommended, false);
});

test("同时出现成功与失败提示时判失败（失败优先）", async () => {
  use({ html: uploadFormDialog() });
  onSubmit(() => setInnerHtml("#upload-modal .tila-modal-body", "<span>上传成功</span><span>上传失败，请检查网络连接</span>"));
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 2000, verifyTimeoutMs: 2000,
  });
  assert.equal(result.status, "failed", "失败信号优先，绝不能报成功");
});

test("提交后无任何提示 → status=unverified（已提交但无证据）", async () => {
  use({ html: uploadFormDialog() });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 500,
  });
  assert.equal(result.submitted, true, "确实点击了提交");
  assert.equal(result.status, "unverified");
  assert.equal(result.verification.autoRetry, false);
});

test("历史 Toast（提交前就存在）不得误判为本次成功", async () => {
  // 页面上残留上一次的「上传成功」
  use({ html: `${uploadFormDialog()}${toast("上传成功")}` });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 600,
  });
  assert.equal(result.status, "unverified", "历史成功提示不得作为本次证据");
});

test("结果核验不读取输入框内容（避免把版本号/日志当证据）", async () => {
  use({ html: uploadFormDialog() });
  // 把「上传成功」写进输入框值里（不是可见文本）
  harness.dom.document.querySelector("#upload-modal input").value = "上传成功 1.0.0";
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 500,
  });
  assert.equal(result.status, "unverified", "输入框里的文字不得被当作结果证据");
});

test("verifyUploadResult 超时返回 unverified 且禁止重试", async () => {
  use({ html: uploadFormDialog() });
  const v = await verifyUploadResult({
    target: {}, baseline: new Set(), expectedVersion: "1.0.0", timeoutMs: 300, intervalMs: 50,
  });
  assert.equal(v.status, "unverified");
  assert.equal(v.autoRetry, false);
  assert.equal(v.retryRecommended, false);
});

// ---------------------------------------------------------------------------
// 8. 不自动重试：统计真实 CDP 提交点击次数（复审问题 10）
// ---------------------------------------------------------------------------
test("结果不明时只提交一次：统计真实 CDP 点击次数", async () => {
  use({ html: uploadFormDialog() });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 600,
  });
  assert.equal(result.status, "unverified");

  // 直接数 CDP 的 mouseReleased（一次点击恰好一次释放）
  const releases = harness.cdpCalls.filter(
    (c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mouseReleased",
  );
  // 只有「确定」被点击（表单已开，不需要点工具栏「上传」）
  assert.equal(releases.length, 1, `提交点击必须只发生一次，实际 ${releases.length}`);
});

// ---------------------------------------------------------------------------
// 9. 多工程绑定（复审问题 3、10）
// ---------------------------------------------------------------------------
test("两个 workbench 并存时选择与 projectPath 精确匹配的 target", async () => {
  const h = use({
    html: uploadFormDialog(),
    targets: [
      { type: "page", url: "file:///workbench/index.html?projectPath=d%3A%5Cprojects%5Cother-project", title: "other", webSocketDebuggerUrl: "ws://other" },
      { type: "page", url: "file:///workbench/index.html?projectPath=d%3A%5Cprojects%5Csample-minigame", title: "target", webSocketDebuggerUrl: "ws://target-wb" },
    ],
  });
  // 记录 evaluate 实际使用的 target
  const usedTargets = [];
  const baseEval = h.deps.evaluate;
  h.deps.evaluate = async (target, expr) => { usedTargets.push(target.webSocketDebuggerUrl); return baseEval(target, expr); };
  setUploadDeps(h.deps);

  await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 400,
  });
  assert.ok(usedTargets.length > 0, "应发生求值");
  assert.ok(
    usedTargets.every((u) => u === "ws://target-wb"),
    `所有操作必须落在绑定目标工程的那个 workbench，实际 ${JSON.stringify([...new Set(usedTargets)])}`,
  );
});

test("存在多个匹配同一工程的 workbench 时拒绝（不猜）", async () => {
  use({
    html: uploadFormDialog(),
    targets: [
      realWorkbench("D:\\projects\\sample-minigame", { ws: "ws://a" }),
      realWorkbench("d:\\projects\\sample-minigame", { ws: "ws://b" }),
    ],
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND" && /多个/.test(error.message),
  );
});

test("严格绑定：标题相同但没有 projectPath 时仍拒绝（不做工程名模糊匹配）", async () => {
  use({
    html: uploadFormDialog(),
    targets: [
      // 标题里含目标工程目录名，但 URL 没有 projectPath 参数
      {
        type: "page",
        title: "sample-minigame - 抖音开发者工具",
        url: "file:///C:/ide/dist/applications/microgame-mix/workbench/index.html?type=microgame&session=x",
        webSocketDebuggerUrl: "ws://wb",
      },
    ],
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

test("严格绑定：其它工程的 workbench 不会被误用（即使标题含目标工程名）", async () => {
  use({
    html: uploadFormDialog(),
    targets: [
      realWorkbench("D:\\projects\\other-project", {
        title: "sample-minigame - 抖音开发者工具",
        ws: "ws://other",
      }),
    ],
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

test("没有任何 workbench 时 → 顶层错误，不提交", async () => {
  use({ targets: [], html: uploadFormDialog() });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

// ---------------------------------------------------------------------------
// 10. 其他
// ---------------------------------------------------------------------------
test("hitsSubmit=false 时只填表不提交", async () => {
  use({ html: uploadFormDialog() });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    hitsSubmit: false, timeoutMs: 1500,
  });
  assert.equal(result.submitted, false);
  assert.match(result.note, /未提交/);
  assert.equal(harness.cdpCalls.filter((c) => c.params?.type === "mouseReleased").length, 0, "不得发生点击");
});

test("弹窗已打开时不重复点「上传」（避免把弹窗关掉）", async () => {
  use({ html: uploadFormDialog() });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 400,
  });
  assert.equal(result.click.alreadyOpen, true);
  // 唯一的点击应该是「确定」
  const releases = harness.cdpCalls.filter((c) => c.params?.type === "mouseReleased");
  assert.equal(releases.length, 1);
});

// ---------------------------------------------------------------------------
// 11. 点击模拟的正确性（复审问题 3）
// ---------------------------------------------------------------------------
test("元素坐标唯一：不同按钮不会被同一坐标命中", async () => {
  use({ html: uploadFormDialog() });
  const dom = harness.dom.document;
  const confirmBtn = [...dom.querySelectorAll("#upload-modal button")].find((b) => b.textContent.trim() === "确定");
  const cancelBtn = [...dom.querySelectorAll("#upload-modal button")].find((b) => b.textContent.trim() === "取消");
  const uploadItem = clickTargetFor("toolbar", "上传");
  assert.ok(confirmBtn && cancelBtn && uploadItem);
  const seen = new Set([confirmBtn, cancelBtn, uploadItem].map((el) => {
    const r = harness.dom.coordsFor(el);
    return `${Math.round(r.x + r.width / 2)},${Math.round(r.y + r.height / 2)}`;
  }));
  assert.equal(seen.size, 3, "三个元素必须落在不同坐标，否则无法用坐标区分点击目标");
});

test("mouseMoved 失败时不改变 DOM（不发生点击、无结果文案）", async () => {
  use({ html: uploadFormDialog(), failMouseTypes: new Set(["mouseMoved"]) });
  // 登记"若被点击就会改变弹窗状态"的副作用，用于证明它没被触发
  let sideEffect = 0;
  onSubmit(() => { sideEffect += 1; setInnerHtml("#upload-modal .tila-modal-body", "<span>上传成功</span>"); });

  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1200,
    }),
  );

  assert.equal(sideEffect, 0, "CDP 失败时点击副作用不得被触发");
  const text = harness.dom.document.querySelector("#upload-modal").textContent;
  assert.ok(!/上传成功|上传失败/.test(text), "不得出现任何【提交后】才可能出现的结果文案");
  assert.ok(/上传版本/.test(text), "弹窗应仍停留在上传表单状态");
});

test("mousePressed 失败时不改变 DOM（不发生点击、无结果文案）", async () => {
  use({ html: uploadFormDialog(), failMouseTypes: new Set(["mousePressed"]) });
  let sideEffect = 0;
  onSubmit(() => { sideEffect += 1; setInnerHtml("#upload-modal .tila-modal-body", "<span>上传成功</span>"); });

  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1200,
    }),
  );

  assert.equal(sideEffect, 0, "CDP 失败时点击副作用不得被触发");
  const text = harness.dom.document.querySelector("#upload-modal").textContent;
  assert.ok(!/上传成功|上传失败/.test(text), "不得出现任何【提交后】才可能出现的结果文案");
});

test("mouseReleased 失败时不改变 DOM（即使前面事件都成功）", async () => {
  use({ html: uploadFormDialog(), failMouseTypes: new Set(["mouseReleased"]) });
  // 登记一个"若被触发就会改 DOM"的副作用，用于证明它没有被触发
  let sideEffect = 0;
  onSubmit(() => { sideEffect += 1; setInnerHtml("#upload-modal .tila-modal-body", "<span>上传成功</span>"); });
  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1200,
    }),
  );
  assert.equal(sideEffect, 0, "mouseReleased 失败时点击副作用绝不能被触发");
  assert.match(harness.dom.document.querySelector("#upload-modal .tila-modal-body").innerHTML, /上传版本|请输入/);
});

test("CDP 事件序完整时才生效：按下与释放同坐标才触发一次点击", async () => {
  // 直接驱动依赖层，验证"同坐标 按下→释放"才生效的语义
  use({ html: uploadFormDialog() });
  let fired = 0;
  const dom = harness.dom.document;
  const confirmBtn = [...dom.querySelectorAll("#upload-modal button")].find((b) => b.textContent.trim() === "确定");
  harness.dom.onClick(confirmBtn, () => { fired += 1; });
  const r = harness.dom.coordsFor(confirmBtn);
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  const conn = await harness.deps.openConnection();
  const press = (px, py) => conn.call("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
  const release = (rx, ry) => conn.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rx, y: ry, button: "left", clickCount: 1 });

  // ① 孤立 mouseReleased（没有按下）不触发
  await release(x, y);
  assert.equal(fired, 0, "没有 mousePressed 的孤立 mouseReleased 不得触发点击");

  // ② 仅按下不触发
  await press(x, y);
  assert.equal(fired, 0, "仅按下不触发点击");

  // ③ 按下与释放不同坐标不触发（且按下状态被清除）
  await release(x + 3, y + 3);
  assert.equal(fired, 0, "按下与释放不在同一点不得触发点击");

  // ④ 同坐标按下→释放才触发一次
  await press(x, y);
  await release(x, y);
  assert.equal(fired, 1, "同坐标 按下→释放 应触发一次点击");
});

// ---------------------------------------------------------------------------
// 12. 信任弹窗：必须在点击「上传」之前处理（复审问题 1）
// ---------------------------------------------------------------------------

// 构造"信任弹窗遮挡工具栏"的场景：信任弹窗存在时点「上传」不生效。
// uploadBlocked 表示工具栏被遮挡；只有信任弹窗消失后才解除。
function trustBlockedScenario({ dismissTrust = true } = {}) {
  use({ html: `${trustDialog()}${uploadFormDialog({ open: false })}` });
  const dom = harness.dom.document;
  // 上传表单初始不显示（真实场景：还没点上传，表单不该存在）
  const form = dom.querySelector("#upload-modal");
  harness.dom.hide(form);

  const state = { uploadClicks: 0, uploadEffective: 0, trustClicks: 0, blocked: true };

  // 生产代码会点中最内层候选（button[aria-label="上传"]），因此副作用登记到该元素。
  const uploadItem = clickTargetFor("toolbar", "上传");
  harness.dom.onClick(uploadItem, () => {
    state.uploadClicks += 1;
    if (state.blocked) return; // 被遮挡 → 点击无效
    state.uploadEffective += 1;
    harness.dom.show(form);
  });

  const trustBtn = clickTargetFor("dialog", "信任并运行");
  harness.dom.onClick(trustBtn, () => {
    state.trustClicks += 1;
    if (!dismissTrust) return; // 点名信任但弹窗不消失（模拟点击无效/IDE 未响应）
    removeEl("#trust-modal");
    state.blocked = false;
  });
  return state;
}

test("信任弹窗存在时默认拒绝：返回 IDE_PROJECT_TRUST_REQUIRED 且不点上传", async () => {
  const state = trustBlockedScenario();
  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 1500,
    }),
    (error) => error.code === "IDE_PROJECT_TRUST_REQUIRED",
  );
  assert.equal(state.trustClicks, 0, "默认绝不自作主张点击「信任并运行」");
  assert.equal(state.uploadClicks, 0, "信任未处理前不得点击上传入口");
});

test("confirmTrust 与 confirm 相互独立：只给 confirm=true 仍拒绝信任", async () => {
  const state = trustBlockedScenario();
  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
      confirm: true, confirmTrust: false, timeoutMs: 1500,
    }),
    (error) => error.code === "IDE_PROJECT_TRUST_REQUIRED",
  );
  assert.equal(state.trustClicks, 0);
});

test("confirmTrust=true 时：先信任，弹窗消失后**重新**点击上传并进入表单", async () => {
  const state = trustBlockedScenario();
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
    confirm: true, confirmTrust: true, timeoutMs: 8000, verifyTimeoutMs: 400,
  });

  assert.equal(state.trustClicks, 1, "应恰好点击一次「信任并运行」");
  assert.equal(state.blocked, false, "信任后遮挡应解除");
  assert.equal(state.uploadClicks, 1, "信任完成后应点击上传入口");
  assert.equal(state.uploadEffective, 1, "这次上传点击必须是在信任之后、因而真正生效");
  assert.equal(result.trustAction.clicked.clicked, true);
  assert.equal(result.trustAction.cleared, true);
  assert.equal(result.submitted, true, "应走到提交");
});

test("若在信任之前抢跑点击上传，那次点击无效，信任后必须补点一次", async () => {
  // 反向验证：证明"顺序错误会导致第一次上传点击无效"，因此代码必须在信任后重新点击。
  const state = trustBlockedScenario();
  // 模拟错误顺序：信任前先点一次上传（登记副作用的正是生产会点中的那个元素）
  harness.dom.clicks.get(clickTargetFor("toolbar", "上传"))();
  assert.equal(state.uploadClicks, 1);
  assert.equal(state.uploadEffective, 0, "被遮挡时的上传点击不生效（这正是旧实现的缺陷）");

  // 正确顺序：信任 → 再点上传
  await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
    confirm: true, confirmTrust: true, timeoutMs: 8000, verifyTimeoutMs: 400,
  });
  assert.equal(state.uploadClicks, 2, "信任后必须再点一次上传");
  assert.equal(state.uploadEffective, 1, "只有信任后的那次点击生效");
});

test("信任弹窗不会被「稍后运行」误放行（只认「信任并运行」）", async () => {
  use({ html: trustDialog() });
  let later = 0;
  const btn = clickTargetFor("dialog", "稍后运行");
  harness.dom.onClick(btn, () => { later += 1; });

  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
      confirm: true, confirmTrust: true, timeoutMs: 1200,
    }),
  );
  assert.equal(later, 0, "「稍后运行」不是放行标签，不得被点击");
});

test("点击信任后弹窗未消失 → 顶层错误，不继续上传", async () => {
  trustBlockedScenario({ dismissTrust: false }); // 点了信任但遮挡不解除
  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
      confirm: true, confirmTrust: true, timeoutMs: 2500,
    }),
    (error) => error.code === "IDE_PROJECT_TRUST_FAILED",
  );
});

test("无信任弹窗时 confirmTrust 默认值不影响正常上传", async () => {
  use({ html: uploadFormDialog() });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
    confirm: true, timeoutMs: 1500, verifyTimeoutMs: 400,
  });
  assert.equal(result.submitted, true);
  assert.equal(result.trustAction, null, "无信任弹窗时不应有信任动作");
});

test("信任弹窗 + 上传流程「继续上传」：信任前置、中间弹窗后置", async () => {
  // 信任弹窗与「继续上传」同时在页面上：信任必须先处理，且只点一次上传
  use({ html: `${trustDialog()}${intermediateDialog()}${uploadFormDialog({ open: false })}` });
  const dom = harness.dom.document;
  const form = dom.querySelector("#upload-modal");
  harness.dom.hide(form);

  const order = [];
  const uploadItem = clickTargetFor("toolbar", "上传");
  harness.dom.onClick(uploadItem, () => {
    order.push("upload");
    // 点上传后才出现上传流程的中间确认弹窗；表单要等「继续上传」之后才出现
  });
  const trustBtn = clickTargetFor("dialog", "信任并运行");
  harness.dom.onClick(trustBtn, () => { order.push("trust"); removeEl("#trust-modal"); });
  const contBtn = clickTargetFor("dialog", "继续上传");
  harness.dom.onClick(contBtn, () => {
    order.push("continue");
    removeEl("#inspection-modal");
    harness.dom.show(form);
  });

  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
    confirm: true, confirmTrust: true, timeoutMs: 8000, verifyTimeoutMs: 400,
  });

  assert.equal(order[0], "trust", "第一步必须是信任");
  assert.equal(order[1], "upload", "信任之后才点击上传");
  assert.deepEqual(result.intermediateDialogs.map((i) => i.label), ["继续上传"]);
});

// ---------------------------------------------------------------------------
// 13. 两个独立 target：工具栏在 workbench，MiniApp Webview 是另一个 target
// ---------------------------------------------------------------------------
test("工具栏 fixture 位于 workbench target；模拟器是独立 target 且不被用于上传", async () => {
  // 真实拓扑：workbench(page, 带 projectPath) 与 MiniApp Webview(webview, 不带) 是不同 target
  use({
    html: uploadFormDialog(),
    targets: [
      {
        type: "page",
        title: "index.html?type=microgame",
        url: REAL_WORKBENCH_URL,
        webSocketDebuggerUrl: "ws://workbench",
      },
      {
        type: "webview",
        title: "MiniApp Webview",
        url: "http://127.0.0.1:7044/miniapp/index.html?sessionId=abc&openApplicationType=microgame&type=microgame",
        webSocketDebuggerUrl: "ws://simulator",
      },
    ],
  });

  // 所有 evaluate 必须只落在 workbench target 上
  const used = [];
  const baseEval = harness.deps.evaluate;
  harness.deps.evaluate = async (target, expr) => { used.push(target.webSocketDebuggerUrl); return baseEval(target, expr); };
  setUploadDeps(harness.deps);

  await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 400,
  });
  assert.ok(used.length > 0);
  assert.ok(
    used.every((u) => u === "ws://workbench"),
    `工具栏/弹窗/表单操作必须只落在 workbench，实际 ${JSON.stringify([...new Set(used)])}`,
  );
});

test("只有 MiniApp Webview（无 workbench）时拒绝，不把模拟器当工作台", async () => {
  use({
    html: uploadFormDialog(),
    targets: [
      {
        type: "webview",
        title: "MiniApp Webview",
        url: "http://127.0.0.1:7044/miniapp/index.html?sessionId=abc&openApplicationType=microgame",
        webSocketDebuggerUrl: "ws://simulator",
      },
    ],
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

test("真实 workbench URL 形态能被正确识别（applications/<类型>/workbench/index.html）", async () => {
  use({ html: uploadFormDialog(), workbenchUrl: REAL_WORKBENCH_URL });
  const result = await uploadInIde({
    projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true,
    timeoutMs: 1500, verifyTimeoutMs: 400,
  });
  assert.equal(result.submitted, true, "真实 URL 形态必须能被绑定并完成提交");
});

test("VS Code workbench.html（工程窗口）不被误认为 workbench 页面", async () => {
  use({
    html: uploadFormDialog(),
    targets: [
      {
        type: "webview",
        title: "sample-minigame - 抖音开发者工具",
        url: "file:///C:/ide/node_modules/@byted-tila/vscode/out/vs/code/electron-browser/workbench/workbench.html?vscode-window-config=1",
        webSocketDebuggerUrl: "ws://vscode",
      },
    ],
  });
  await assert.rejects(
    () => uploadInIde({ projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志", confirm: true, timeoutMs: 800 }),
    (error) => error.code === "IDE_PROJECT_NOT_BOUND",
  );
});

// ---------------------------------------------------------------------------
// 14. 信任弹窗消失确认必须 fail-closed（复审问题 1）
// ---------------------------------------------------------------------------
test("点击信任后所有状态读取都失败 → 顶层错误，绝不继续点击上传或提交", async () => {
  // 场景：信任弹窗存在；点击「信任并运行」之后，CDP 读取**全部失败**
  // （IDE 卡死/窗口重建/target 失效都可能这样）。此时无法确认弹窗是否消失，
  // 必须按"未消失"处理：不能当作信任完成，更不能去点上传。
  use({ html: `${trustDialog()}${uploadFormDialog({ open: false })}` });
  const dom = harness.dom.document;
  const form = dom.querySelector("#upload-modal");
  harness.dom.hide(form);

  const state = { uploadClicks: 0, submitClicks: 0, trustClicks: 0 };
  const uploadItem = clickTargetFor("toolbar", "上传");
  harness.dom.onClick(uploadItem, () => { state.uploadClicks += 1; harness.dom.show(form); });

  // 点击信任之后，让所有"弹窗探测"表达式抛错。
  // 注意：dom.onClick 对同一元素是**覆盖**语义，因此两个副作用必须写在同一个回调里。
  let trustClicked = false;
  const trustBtn = clickTargetFor("dialog", "信任并运行");
  harness.dom.onClick(trustBtn, () => {
    state.trustClicks += 1;
    trustClicked = true;
  });

  const baseEvaluate = harness.deps.evaluate;
  const baseOpen = harness.deps.openConnection;
  harness.deps.evaluate = async (target, expression) => {
    if (trustClicked && expression.includes("uploadFormVisible")) {
      throw new Error("CDP 读取失败（模拟 target 失效）");
    }
    return baseEvaluate(target, expression);
  };
  harness.deps.openConnection = async (...a) => {
    const conn = await baseOpen(...a);
    return {
      close: conn.close,
      call: async (method, params) => {
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
          // 统计是否有人试图点击「确定」
          const el = harness.dom.elementAt(params.x, params.y);
          if (el && String(el.textContent || "").trim() === "确定") state.submitClicks += 1;
        }
        return conn.call(method, params);
      },
    };
  };

  setUploadDeps(harness.deps);
  await assert.rejects(
    () => uploadInIde({
      projectPath: PROJECT, appVersion: "1.0.0", appChangelog: "日志",
      confirm: true, confirmTrust: true, timeoutMs: 3000,
    }),
    (error) => error.code === "IDE_PROJECT_TRUST_FAILED",
  );

  assert.equal(state.trustClicks, 1, "授权后应点击过一次信任按钮");
  assert.equal(state.uploadClicks, 0, "无法确认弹窗消失时，绝不能点击上传入口");
  assert.equal(state.submitClicks, 0, "绝不能发生提交点击");
});

test("waitForTrustCleared：读取失败不算消失；只有明确看不到按钮才算 cleared", async () => {
  // 直接测函数语义
  const { waitForTrustCleared } = await import("../src/ide-upload.mjs");

  // ① 读取一直失败 → 超时 cleared:false，且记录失败次数
  {
    use({ html: trustDialog() });
    harness.deps.evaluate = async () => { throw new Error("读取失败"); };
    setUploadDeps(harness.deps);
    const r = await waitForTrustCleared({}, { timeoutMs: 700, intervalMs: 100 });
    assert.equal(r.cleared, false, "读取失败绝不能被当成弹窗消失");
    assert.ok(r.failedReads > 0, "应记录读取失败次数以便诊断");
  }

  // ② 返回 supported:false（解析失败）→ 同样不算消失
  {
    use({ html: trustDialog() });
    harness.deps.evaluate = async () => "not-json";
    setUploadDeps(harness.deps);
    const r = await waitForTrustCleared({}, { timeoutMs: 700, intervalMs: 100 });
    assert.equal(r.cleared, false, "解析失败不得视为消失");
  }

  // ③ 明确读到按钮消失 → cleared:true
  {
    use({ html: uploadFormDialog() }); // 页面上没有信任按钮
    const r = await waitForTrustCleared({}, { timeoutMs: 1500, intervalMs: 100 });
    assert.equal(r.cleared, true, "读取成功且看不到按钮时才可判定消失");
    assert.equal(r.failedReads, 0);
  }

  // ④ 读取成功但按钮仍在 → 超时 cleared:false
  {
    use({ html: trustDialog() });
    const r = await waitForTrustCleared({}, { timeoutMs: 700, intervalMs: 100 });
    assert.equal(r.cleared, false, "按钮仍可见时不得判定消失");
  }
});

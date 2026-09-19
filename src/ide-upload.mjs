// IDE 内上传（绕过 CLI 登录，直接操控已登录的抖音开发者工具）。
//
// 设计约束（对应工具的安全边界）：
// 1. 版本号/更新日志必须由调用方提供，绝不使用猜测的默认值。
// 2. 提交前必须回读校验表单，填不进去就中止（返回顶层错误，不返回 unverified）。
// 3. 提交按钮只在"已确认的上传表单弹窗"内查找，绝不回退整页搜索。
// 4. 点击「确定」只代表"已触发提交"；必须继续读取成功/失败提示才能判定结果。
// 5. unverified 只用于"已确认点击提交但未取得最终证据"；结果不明确时绝不自动重试。
//
// 真实 IDE 结构（2026-09-10 用真机 CDP 实测，勿凭记忆改动）：
// - 打开工程后 CDP target 只有 5 类：MiniApp Webview(webview)、工程窗口(webview)、
//   DevTools 控制台(iframe)、workbench(page)、front-page(page)。
//   **没有独立的 simulator-page target**——上传工具栏就在 workbench page 内。
// - workbench URL 形如：
//   .../dist/applications/<类型>/workbench/index.html?type=..&openApplicationType=..
//   &workbenchMode=..&session=..&projectPath=<百分号编码的工程路径>
//   其中只有它带 projectPath，因此工程绑定以它为唯一依据。
// - 工具栏结构：DIV.tila-toolbar-item-container（文本「上传」）
//   > button.tila-button.tila-button-secondary[aria-label="上传"] + div.tila-toolbar-item-title
// - 首次打开未信任工程会先弹信任弹窗：.tila-modal.tila-modal-medium，
//   按钮「信任并运行」/「稍后运行」——这是上传前的必经中间步骤。
// - 弹窗容器：tila-modal（tila-modal-body / tila-modal-footer / tila-modal-confirm / tila-modal-mask）。
//   注意 tila-upload-* 是通用上传文件组件，与发布弹窗无关，不可混用。
// - 版本号输入框真实 placeholder：
//   「请输入本次上传版本号，版本号填写示例: 1.0.0」（key ...upload.info-version-placeholder）。
import { redact, trimText } from "./path-policy.mjs";

// ---------- 常量 ----------

// 上传弹窗容器：优先 tila-modal（真实类名），保留 role=dialog 兜底。
const DIALOG_SELECTOR = '.tila-modal,[role=dialog]';
// 按钮候选：真实工具栏/弹窗按钮类名 + 语义控件。
const BUTTON_SELECTOR = 'button,[role=button],[aria-label],.tila-toolbar-item-container,.tila-button,[class*=btn],[class*=Btn],[class*=button],[class*=Button]';
// 工作台全局可点区域（工具栏）：用于「上传」入口，不含弹窗内部。
const TOOLBAR_SELECTOR = '.tila-toolbar-container,.tila-toolbar-item-container,[class*=toolbar],[class*=Toolbar],[role=menubar],[role=menu],[role=menuitem]';

// 上传表单的判别证据：placeholder 含"版本号"/"更新日志"的可见输入框。
const FORM_FIELD_HINTS = ["版本号", "更新日志", "日志"];

// 信任弹窗的放行按钮（必须在点击「上传」之前处理，见 detectTrustDialog）
const TRUST_LABEL = "信任并运行";
// 上传流程内（点击「上传」之后）可能出现的中间确认弹窗。
// 刻意**不**包含信任弹窗：它属于上传入口的前置条件，顺序错了第一次上传点击会失效。
const INTERMEDIATE_LABELS = ["继续上传"];
const MAX_INTERMEDIATE_ROUNDS = 4;

// 成功/失败信号词（取自 IDE 真实 i18n 文案，见文件头注释）。
const SUCCESS_PATTERNS = [
  /上传成功/, /代码已深度防护/, /已上传/, /上传完成/, /提交成功/, /发布成功/,
];
const FAILURE_PATTERNS = [
  /上传失败/, /未接入必接能力/, /请检查网络连接/, /上传错误/, /提交失败/, /上传异常/, /上传超时/,
  /版本号小于/, /版本号格式错误/, /版本号.*(?:已存在|重复)/, /不可上传/, /无权限上传/, /登录已过期/,
];

// 全局提示探测限定在真正的浮层容器内，避免把整页正文当成成功证据。
const TOAST_SELECTOR = '.tila-message,.tila-notification,.tila-toast,.tila-alert,[role=alert],[class*=message],[class*=Message],[class*=notification],[class*=Notification],[class*=toast],[class*=Toast],[class*=alert],[class*=Alert]';
const TOAST_MAX = 12;

// ---------- 注入式依赖（测试替身） ----------
// cdp 基础件默认从 ./cdp.mjs 懒加载：便于单测注入 DOM 替身，无需真实 IDE。

let cdpModule = null;
async function cdp() {
  if (!cdpModule) cdpModule = await import("./cdp.mjs");
  return cdpModule;
}

let deps = {};
export function setUploadDeps(next) {
  deps = next || {};
  cdpModule = null;
}
function dep(name) {
  return deps[name];
}

async function callBase(name, ...args) {
  if (dep(name)) return dep(name)(...args);
  const module = await cdp();
  return module[name](...args);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 输入校验 ----------

function uploadError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

export function validateUploadInput({ appVersion, appChangelog } = {}) {
  const version = String(appVersion ?? "").trim();
  const changelog = String(appChangelog ?? "").trim();
  if (!version) {
    throw uploadError("UPLOAD_VERSION_REQUIRED", "必须显式提供 appVersion；工具不会猜测或使用默认版本号", {
      hint: "请从用户或项目中可验证的信息取得版本号后再调用",
    });
  }
  if (!changelog) {
    throw uploadError("UPLOAD_CHANGELOG_REQUIRED", "必须显式提供 appChangelog", {
      hint: "更新日志必须来自用户或项目中可验证的信息",
    });
  }
  return { appVersion: version, appChangelog: changelog };
}

// ---------- 页面表达式 ----------
// 三类作用域严格分开，互不fallback：
//   form    — 已确认的上传表单弹窗内部（只用于填写与提交）
//   dialog  — 任意可见弹窗内部（用于「继续上传」这类中间确认）
//   toolbar — 工作台全局可点区域（用于「上传」入口）

function sharedHelpers() {
  return `
    const norm = (v) => String(v || '').replace(/\\s+/g, '').trim();
    const visible = (el) => {
      if (!el || el.offsetParent === null) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const hints = ${JSON.stringify(FORM_FIELD_HINTS)};
    const isUploadForm = (box) => [...box.querySelectorAll('input,textarea')].some((el) => {
      const ph = norm(el.placeholder);
      if (!visible(el) || !ph) return false;
      return hints.some((h) => ph.includes(h));
    });
    const visibleDialogs = () => [...document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)})].filter(visible);
    const formDialogs = () => visibleDialogs().filter(isUploadForm);`;
}

// 统一探测：分别返回表单状态/表单按钮、全部可见弹窗按钮、可见弹窗文本、全局浮层提示。
function dialogProbeExpression() {
  return `(function(){
    ${sharedHelpers()}
    const all = visibleDialogs();
    const forms = formDialogs();
    const formInputs = [];
    const formButtons = [];
    for (const box of forms) {
      for (const el of box.querySelectorAll('input,textarea')) {
        if (!visible(el)) continue;
        formInputs.push({ placeholder: String(el.placeholder || ''), tag: el.tagName, type: el.type || 'text' });
      }
      for (const el of box.querySelectorAll(${JSON.stringify(BUTTON_SELECTOR)})) {
        const label = norm(el.innerText || el.textContent || el.getAttribute('aria-label'));
        if (label && visible(el)) formButtons.push(label);
      }
    }
    // 所有可见弹窗的按钮（中间确认弹窗就在这里被看见）
    const dialogButtons = [];
    for (const box of all) {
      for (const el of box.querySelectorAll(${JSON.stringify(BUTTON_SELECTOR)})) {
        const label = norm(el.innerText || el.textContent || el.getAttribute('aria-label'));
        if (label && visible(el)) dialogButtons.push(label);
      }
    }
    // 可见弹窗文本（结果核验基线用；不含整页正文）
    const dialogTexts = [];
    for (const box of all) {
      const text = String(box.innerText || '').trim();
      if (text) dialogTexts.push(text.slice(0, 300));
    }
    // 受限全局提示探测：只看真正的浮层容器，不读整页
    const toasts = [];
    for (const el of document.querySelectorAll(${JSON.stringify(TOAST_SELECTOR)})) {
      if (!visible(el)) continue;
      const text = String(el.innerText || el.textContent || '').trim();
      if (text && text.length <= 200) toasts.push(text);
      if (toasts.length >= ${TOAST_MAX}) break;
    }
    return JSON.stringify({
      dialogVisible: all.length > 0,
      uploadFormVisible: forms.length > 0,
      dialogCount: all.length,
      formCount: forms.length,
      formInputs: formInputs.slice(0, 12),
      formButtons: [...new Set(formButtons)].slice(0, 20),
      dialogButtons: [...new Set(dialogButtons)].slice(0, 30),
      dialogTexts: [...new Set(dialogTexts)].slice(0, 10),
      toasts: [...new Set(toasts)].slice(0, ${TOAST_MAX}),
    });
  })()`;
}

// 按作用域定位按钮。scope 必须是 'form' | 'dialog' | 'toolbar' 之一。
// 提交按钮固定用 'form'，因此不存在"回退全页"的路径。
function locateClickableExpression(label, scope) {
  const scopesExpr = {
    form: "formDialogs()",
    dialog: "visibleDialogs()",
    toolbar: `[...document.querySelectorAll(${JSON.stringify(TOOLBAR_SELECTOR)})].filter(visible)`,
  }[scope];
  if (!scopesExpr) throw new Error(`未知的按钮作用域: ${scope}`);
  return `(function(){
    ${sharedHelpers()}
    const wanted = ${JSON.stringify(label)};
    const roots = ${scopesExpr};
    const candidates = [];
    for (const root of roots) {
      // root 自身可能就是按钮（工具栏项），因此先查自身再查后代
      const nodes = [root, ...root.querySelectorAll(${JSON.stringify(BUTTON_SELECTOR)})];
      for (const el of nodes) {
        if (!visible(el)) continue;
        const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label'));
        if (text === wanted) candidates.push(el);
      }
    }
    if (!candidates.length) return JSON.stringify({ found: false, matched: 0, scope: ${JSON.stringify(scope)}, roots: roots.length });
    // 取最内层（文本最短）的候选，避免点到包裹容器
    candidates.sort((a, b) => norm(a.innerText || a.textContent).length - norm(b.innerText || b.textContent).length);
    const el = candidates[0];
    const rect = el.getBoundingClientRect();
    return JSON.stringify({
      found: true,
      matched: candidates.length,
      scope: ${JSON.stringify(scope)},
      roots: roots.length,
      tag: el.tagName,
      className: String(el.className || '').slice(0, 60),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    });
  })()`;
}

// ---------- CDP 鼠标点击 ----------

// 依次发送 mouseMoved → mousePressed → mouseReleased，每个事件都必须带 type。
// CDP 的 Input.dispatchMouseEvent 以 type 决定事件种类；缺 type 整个调用无效。
async function clickAt(target, point, timeoutMs) {
  const connection = await callBase("openConnection", target, timeoutMs);
  try {
    await connection.call("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0,
    });
    await sleep(60);
    await connection.call("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    });
    await sleep(80);
    await connection.call("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    });
    return { clicked: true, method: "cdp-mouse", x: point.x, y: point.y, tag: point.tag };
  } finally {
    connection.close();
  }
}

// 在指定作用域内按文本点击。找不到时返回 clicked:false（由调用方决定是否升级为顶层错误）。
export async function clickLabel({ target, label, scope = "form", timeoutMs = 8000 }) {
  const located = await callBase("evaluate", target, locateClickableExpression(label, scope), timeoutMs);
  let parsed = {};
  try { parsed = JSON.parse(located || "{}"); } catch { parsed = { found: false, matched: 0 }; }
  const meta = { label, scope, matched: parsed.matched || 0, roots: parsed.roots ?? null };
  if (!parsed.found) return { clicked: false, ...meta };
  const clicked = await clickAt(target, parsed, timeoutMs);
  return { ...meta, ...clicked, tag: parsed.tag };
}

// ---------- 弹窗状态 ----------

export async function readDialogState(target, timeoutMs = 6000) {
  const raw = await callBase("evaluate", target, dialogProbeExpression(), timeoutMs);
  try { return { supported: true, ...JSON.parse(raw || "{}") }; } catch { return { supported: false, reason: "上传弹窗读取失败" }; }
}

// ---------- 工程绑定 ----------

// 获取绑定到目标工程的 workbench target（**严格**）。
// 上传会产生远程副作用，因此必须用 bindWorkbenchStrict：
//   target 必须是 workbench 页面、URL 必须存在 projectPath、归一化后必须完全相等。
// 不做标题/工程名模糊匹配——"标题相同但没有 projectPath"也会被拒绝。
// 命中 0 个 → NOT_BOUND；命中多个 → AMBIGUOUS。
export async function resolveWorkbench(projectPath, timeoutMs = 8000) {
  const context = await callBase("resolveContext", projectPath, timeoutMs);
  const bindStrict = dep("bindWorkbenchStrict") || (await cdp()).bindWorkbenchStrict;
  const binding = bindStrict(context.targets || [], projectPath);
  if (!binding.target) {
    return { supported: false, reason: binding.reason, candidates: binding.candidates, port: context.port || null };
  }
  return { supported: true, target: binding.target, port: context.port || null, targetUrl: binding.target.url || "" };
}

// ---------- 表单填写 ----------

// 只在表单弹窗内定位输入框并写值；写入后立即回读，value 不一致即视为未填成功。
function fillFormExpression(version, changelog) {
  return `(function(){
    ${sharedHelpers()}
    const scope = formDialogs()[0] || null;
    if (!scope) return JSON.stringify({ scopeFound: false });
    const fields = [...scope.querySelectorAll('input,textarea')].filter(visible);
    let verEl = null, logEl = null;
    for (const el of fields) {
      const ph = norm(el.placeholder);
      if (!verEl && ph.includes('版本号')) verEl = el;
    }
    // 更新日志优先取 textarea；没有 textarea 时退回含"日志"的任意输入
    for (const el of fields) {
      const ph = norm(el.placeholder);
      if (el.tagName === 'TEXTAREA' && (ph.includes('更新日志') || ph.includes('日志'))) { logEl = el; break; }
    }
    if (!logEl) {
      for (const el of fields) {
        const ph = norm(el.placeholder);
        if (ph.includes('更新日志') || ph.includes('日志')) { logEl = el; break; }
      }
    }
    const setter = (el, v) => {
      if (!el) return { filled: false };
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const s = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (s) s.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // 回读：React 受控组件可能回滚值，必须确认最终 DOM 值再提交
      return { filled: el.value === String(v) };
    };
    return JSON.stringify({
      scopeFound: true,
      versionFieldFound: Boolean(verEl),
      changelogFieldFound: Boolean(logEl),
      versionFilled: setter(verEl, ${JSON.stringify(String(version))}).filled,
      changelogFilled: setter(logEl, ${JSON.stringify(String(changelog))}).filled,
    });
  })()`;
}

export async function fillUploadForm({ target, appVersion, appChangelog, timeoutMs = 8000 }) {
  const raw = await callBase("evaluate", target, fillFormExpression(appVersion, appChangelog), timeoutMs);
  try { return { supported: true, ...JSON.parse(raw || "{}") }; } catch { return { supported: false, reason: "上传表单填写失败" }; }
}

// ---------- 信任弹窗（必须在点击上传之前处理） ----------

// 检测当前是否存在信任弹窗。
// 实测：首次打开未信任工程会先弹 .tila-modal.tila-modal-medium，按钮「信任并运行」/「稍后运行」。
// 它通常**遮挡工具栏**，因此若先点「上传」再关弹窗，那次点击不会生效——顺序必须是先信任、后上传。
export async function detectTrustDialog(target, timeoutMs = 4000) {
  const state = await readDialogState(target, timeoutMs).catch(() => null);
  if (!state?.supported) return { present: false, state: null };
  const buttons = state.dialogButtons || [];
  const present = buttons.includes(TRUST_LABEL);
  return {
    present,
    state,
    // 供调用方展示（已脱敏的短文本），不返回整页内容
    label: present ? TRUST_LABEL : null,
    alt: buttons.includes("稍后运行") ? "稍后运行" : null,
  };
}

// 等待信任弹窗消失（**fail-closed**）。
//
// 关键：只有"读取成功（supported===true）"且"明确看不到「信任并运行」按钮"才算消失。
// 读取抛错 / 返回 null / supported:false 都**不能**当作弹窗已消失——否则 IDE 抖动一下
// 就会被判定为信任完成，后续上传点击落在被遮挡的工具栏上，静默失效。
// 读取失败时继续有限轮询；超时返回 cleared:false，由上层抛 IDE_PROJECT_TRUST_FAILED。
export async function waitForTrustCleared(target, { timeoutMs = 15000, intervalMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  let failedReads = 0;
  while (Date.now() < deadline) {
    let state = null;
    let readError = null;
    try {
      state = await readDialogState(target, Math.min(4000, timeoutMs));
    } catch (error) {
      readError = trimText(error?.message || String(error));
    }
    last = state;
    lastError = readError;
    const readable = Boolean(state && state.supported === true);
    if (!readable) {
      // 读不到状态 → 不视为消失，继续轮询
      failedReads += 1;
      await sleep(intervalMs);
      continue;
    }
    const stillThere = (state.dialogButtons || []).includes(TRUST_LABEL);
    if (!stillThere) {
      return { cleared: true, state, failedReads };
    }
    await sleep(intervalMs);
  }
  return {
    cleared: false,
    state: last,
    failedReads,
    reason: lastError
      ? `等待信任弹窗消失期间状态读取失败：${lastError}`
      : `等待 ${timeoutMs}ms 仍未确认信任弹窗消失（最后一次读取${last && last.supported === true ? "仍看到「信任并运行」" : "不可用"}）`,
  };
}

// ---------- 打开上传入口 ----------

// 打开上传弹窗。入口是 workbench 工具栏的「上传」项（实测：tila-toolbar-item-container +
// button[aria-label="上传"]），与后续弹窗/表单同属一个 workbench target。
// 顶部「工具 → 上传」是原生 Electron 菜单（Menu.setApplicationMenu），CDP 点不到，不走它。
//
// 调用前提：信任弹窗已处理完毕（否则弹窗遮挡工具栏，这次点击不会生效）。
// 弹窗已开时不重复点击（二次点击会关掉弹窗）。
export async function openUploadDialog({ target, timeoutMs = 8000 }) {
  const existing = await readDialogState(target, Math.min(4000, timeoutMs)).catch(() => null);
  if (existing?.uploadFormVisible) return { alreadyOpen: true, click: { alreadyOpen: true, clicked: false } };
  const viaToolbar = await clickLabel({ target, label: "上传", scope: "toolbar", timeoutMs });
  if (viaToolbar.clicked) return { alreadyOpen: false, click: { ...viaToolbar, method: "toolbar" } };
  return { alreadyOpen: false, click: viaToolbar };
}

// ---------- 等待表单 + 上传流程中间弹窗 ----------

// 等待上传表单弹窗出现，期间只处理**上传流程内**的中间确认弹窗（「继续上传」）。
// 信任弹窗不在这里处理：它必须在点击「上传」之前单独放行（见 detectTrustDialog）。
// 轮次上限 MAX_INTERMEDIATE_ROUNDS：超过就停止并报错，不会一直点到超时。
// 同一个可见弹窗 + 相同文本只点一次，避免无效重复点击。
export async function waitForUploadForm({ target, timeoutMs = 30000, intervalMs = 1200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const intermediate = [];
  const clickedKeys = new Set();
  let last = null;
  while (Date.now() < deadline) {
    const state = await readDialogState(target, Math.min(4000, timeoutMs)).catch(() => null);
    last = state;
    if (state?.uploadFormVisible) return { ready: true, state, intermediate };
    const buttons = state?.dialogButtons || [];
    const label = INTERMEDIATE_LABELS.find((candidate) => buttons.includes(candidate));
    if (label) {
      // 用「标签 + 可见弹窗文本」标识当前这一关；同一关不重复点
      const key = `${label}::${(state?.dialogTexts || []).join("|")}`;
      if (clickedKeys.has(key)) {
        await sleep(intervalMs);
        continue;
      }
      if (clickedKeys.size >= MAX_INTERMEDIATE_ROUNDS) {
        const remaining = INTERMEDIATE_LABELS.find((c) => buttons.includes(c));
        return {
          ready: false,
          state: last,
          intermediate,
          errorCode: "UPLOAD_INTERMEDIATE_DIALOG_LIMIT",
          reason: `中间确认弹窗超过 ${MAX_INTERMEDIATE_ROUNDS} 轮仍未进入上传表单（最后卡在「${remaining || label}」），已停止以避免无效重复点击`,
        };
      }
      clickedKeys.add(key);
      // 中间弹窗不是表单弹窗，用 'dialog' 作用域（仍限定在可见弹窗内，不是整页）
      const click = await clickLabel({ target, label, scope: "dialog", timeoutMs }).catch(() => ({ clicked: false }));
      intermediate.push({ label, key, ...click });
      await sleep(2000);
      continue;
    }
    await sleep(intervalMs);
  }
  return { ready: false, state: last, intermediate };
}

// ---------- 结果提示读取与核验 ----------

// 读取"结果提示"文本：上传弹窗内的文本 + 受限的全局浮层提示。
// 不读整页正文，也不读任何输入框内容（避免把版本号/日志/凭据当证据）。
export async function readResultTexts(target, timeoutMs = 4000) {
  const state = await readDialogState(target, timeoutMs).catch(() => null);
  if (!state) return { supported: false, texts: [] };
  const texts = [...(state.dialogTexts || []), ...(state.toasts || [])];
  return {
    supported: Boolean(state.supported),
    dialogVisible: Boolean(state.dialogVisible),
    uploadFormVisible: Boolean(state.uploadFormVisible),
    texts: [...new Set(texts)],
  };
}

// 提交前的提示基线：记录当前已存在的提示文本。
// 提交后只承认"新增"或"内容发生变化"的提示，避免历史 Toast 被误判成本次成功。
export async function snapshotResultTexts(target, timeoutMs = 4000) {
  const snapshot = await readResultTexts(target, timeoutMs);
  return new Set(snapshot.texts || []);
}

function matchSignals(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// 从提示文本里挑出可读摘要（脱敏后返回），而不是回正则字符串。
function summarize(texts) {
  return texts
    .map((text) => redact(String(text)).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => (text.length > 160 ? `${text.slice(0, 160)}…` : text))
    .slice(0, 5);
}

// 提交后轮询核验，返回三态：
//   success    — 出现明确成功提示
//   failed     — 出现明确失败提示（失败优先：同时出现时判失败）
//   unverified — 已提交但没有取得明确证据（超时/弹窗消失且无提示）
// 任何情况下都不重试：重复上传会产生线上副作用。
export async function verifyUploadResult({ target, baseline, expectedVersion, timeoutMs = 30000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const base = baseline instanceof Set ? baseline : new Set(baseline || []);
  let last = null;
  while (Date.now() < deadline) {
    const current = await readResultTexts(target, Math.min(4000, timeoutMs)).catch(() => null);
    if (current) {
      last = current;
      // 只认基线里没有的文本（含全局 Toast）
      const fresh = (current.texts || []).filter((text) => !base.has(text));
      const freshCombined = fresh.join("\n");
      const failed = matchSignals(freshCombined, FAILURE_PATTERNS);
      const succeeded = matchSignals(freshCombined, SUCCESS_PATTERNS);
      // 失败优先：同时出现两种信号时不能报成功
      if (failed) {
        return { status: "failed", evidence: summarize(fresh), autoRetry: false, retryRecommended: false };
      }
      if (succeeded) {
        return {
          status: "success",
          evidence: summarize(fresh),
          versionConfirmed: expectedVersion ? freshCombined.includes(expectedVersion) : false,
          autoRetry: false,
          retryRecommended: false,
        };
      }
    }
    await sleep(intervalMs);
  }
  const reason = last && !last.dialogVisible && !(last.texts || []).length
    ? `上传弹窗在 ${timeoutMs}ms 内消失，但未观察到成功或失败提示`
    : `等待 ${timeoutMs}ms 未观察到成功或失败提示`;
  return { status: "unverified", reason, autoRetry: false, retryRecommended: false };
}

// ---------- 主编排 ----------

// 严格按以下顺序执行（顺序本身是正确性的一部分）：
//   1. 校验输入（版本号/更新日志必填，confirm=true）
//   2. **严格**绑定目标工程的 workbench（缺 projectPath / 不匹配 / 多匹配都拒绝）
//   3. 检查信任弹窗：存在且未授权 → 抛 IDE_PROJECT_TRUST_REQUIRED（不自动信任）
//   4. 授权后点击「信任并运行」并确认弹窗消失
//   5. 点击上传入口（必须在信任处理**之后**，否则弹窗遮挡会导致点击无效）
//   6. 处理上传流程内中间弹窗（「继续上传」）→ 等待表单
//   7. 填表 → 回读 → 快照基线 → 提交一次 → 核验结果
// 任何"没能真正提交"的情况都抛顶层错误，绝不返回 ok:true + unverified。
export async function uploadInIde({
  projectPath,
  appVersion,
  appChangelog,
  confirm,
  // 信任弹窗的授权与上传授权**分开**：信任意味着允许在模拟器中运行该工程代码，
  // 与"是否同意本次远程上传"是两件事，因此不复用 confirm。
  confirmTrust = false,
  hitsSubmit = true,
  timeoutMs = 45000,
  verifyTimeoutMs = 30000,
} = {}) {
  const input = validateUploadInput({ appVersion, appChangelog });
  if (hitsSubmit && confirm !== true) {
    throw uploadError("CONFIRMATION_REQUIRED", "IDE 上传默认禁用，必须传入 confirm=true 才会执行", {
      dangerous: true, action: "douyin_ide_upload", sideEffect: "远程上传",
    });
  }

  const wb = await resolveWorkbench(projectPath, timeoutMs);
  if (!wb.supported) {
    // 统一用 IDE_PROJECT_NOT_BOUND，并在 message 里区分"没找到/不匹配/多个匹配"，
    // 让调用方只需处理一个错误码，同时保留可读原因。
    const detail = {
      NOT_BOUND: "未找到 projectPath 与目标完全一致的 workbench，已拒绝操作其他工程",
      AMBIGUOUS: "有多个 workbench 的 projectPath 与目标完全一致，无法确定唯一目标",
      NOT_FOUND: "未找到任何 workbench 页面（工程可能未在 IDE 中打开）",
      NO_PROJECT_PATH: "未提供 projectPath，拒绝在不确定的工程上执行有副作用的操作",
    }[wb.reason] || "workbench 绑定失败";
    const error = uploadError("IDE_PROJECT_NOT_BOUND", `IDE workbench 未绑定到目标工程：${detail}`, {
      reason: wb.reason, port: wb.port, candidates: wb.candidates,
    });
    error.details.bindingReason = wb.reason;
    throw error;
  }

  // ---- 顺序要点 1：先处理信任弹窗，再点击上传 ----
  // 信任弹窗会遮挡工具栏；若先点「上传」再关弹窗，那次点击不生效，且之后不会自动补点。
  // 默认**不**自动信任：信任意味着在模拟器中运行该工程代码，属于用户决定。
  const trust = await detectTrustDialog(wb.target, Math.min(4000, timeoutMs));
  let trustAction = null;
  if (trust.present) {
    if (confirmTrust !== true) {
      throw uploadError(
        "IDE_PROJECT_TRUST_REQUIRED",
        "IDE 正在显示项目信任弹窗（「信任并运行」）。信任后 IDE 会在模拟器中运行该工程代码，属于用户决定，工具不会自动确认",
        {
          hint: "请在 IDE 中确认信任，或显式传入 confirmTrust=true 表示你已授权本次自动信任",
          trustLabel: trust.label,
          altLabel: trust.alt,
          workbench: trimText(wb.targetUrl || "", 200),
        },
      );
    }
    const clicked = await clickLabel({ target: wb.target, label: TRUST_LABEL, scope: "dialog", timeoutMs });
    if (!clicked.clicked) {
      throw uploadError("IDE_PROJECT_TRUST_FAILED", "已授权自动信任，但未能点击「信任并运行」按钮", { clicked });
    }
    // 必须确认弹窗真的消失（读取失败不算消失），否则后续上传点击仍会被遮挡
    const cleared = await waitForTrustCleared(wb.target, { timeoutMs: Math.min(15000, timeoutMs) });
    trustAction = { clicked, cleared: cleared.cleared, failedReads: cleared.failedReads ?? 0 };
    if (!cleared.cleared) {
      throw uploadError(
        "IDE_PROJECT_TRUST_FAILED",
        "点击「信任并运行」后无法确认信任弹窗已消失，已中止以避免在被遮挡的界面上空点",
        { trustAction, reason: cleared.reason, lastState: cleared.state ?? null },
      );
    }
  }

  // ---- 顺序要点 2：信任完成（或本无信任弹窗）后才点击上传入口 ----
  const opened = await openUploadDialog({ target: wb.target, timeoutMs });
  // ---- 顺序要点 3：点击上传之后才处理上传流程内的中间弹窗（「继续上传」） ----
  const form = await waitForUploadForm({ target: wb.target, timeoutMs });
  if (!form.ready) {
    throw uploadError(form.errorCode || "IDE_UPLOAD_DIALOG_NOT_FOUND", form.reason || "上传弹窗未出现或无法读取表单", {
      click: opened.click,
      intermediateDialogs: form.intermediate,
      trustAction,
      lastState: form.state,
    });
  }

  const filled = await fillUploadForm({
    target: wb.target, appVersion: input.appVersion, appChangelog: input.appChangelog, timeoutMs,
  });
  // 填不进去就不提交：否则会带着空版本号/空日志点「确定」
  const fillFailed = !filled.supported || !filled.versionFilled || !filled.changelogFilled;
  if (fillFailed) {
    throw uploadError("IDE_UPLOAD_FILL_FAILED", "版本号或更新日志未能写入上传表单，已中止提交", {
      filled, intermediateDialogs: form.intermediate, trustAction,
    });
  }

  if (!hitsSubmit) {
    return {
      submitted: false, filled, trustAction,
      note: "已填写未提交（hitsSubmit=false）", intermediateDialogs: form.intermediate,
    };
  }

  // 提交前快照：只认提交后新增的提示文本
  const baseline = await snapshotResultTexts(wb.target, Math.min(4000, timeoutMs));
  const submit = await clickLabel({ target: wb.target, label: "确定", scope: "form", timeoutMs });
  if (!submit.clicked) {
    throw uploadError("IDE_UPLOAD_SUBMIT_NOT_FOUND", "上传表单弹窗内未找到「确定」按钮，未提交", {
      submit, filled, intermediateDialogs: form.intermediate, trustAction,
    });
  }

  const verification = await verifyUploadResult({
    target: wb.target, baseline, expectedVersion: input.appVersion, timeoutMs: verifyTimeoutMs,
  });

  return {
    // submitted 仅表示"已点击提交"；status 才是结果核验结论
    submitted: true,
    filled,
    submit,
    click: opened.click,
    trustAction,
    intermediateDialogs: form.intermediate,
    verification,
    status: verification.status,
  };
}

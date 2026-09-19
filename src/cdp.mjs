import WebSocket from "ws";
import { redact, trimText } from "./path-policy.mjs";
import { listIdeListeningPorts } from "./proc.mjs";

// IDE 4.5.5 CDP 端口是动态的（本机实测 8702/8422 等随实例变化）：
// - workbench 调试端口早期固定 8830，新版 IDE 每次启动随机
// - IDE 主进程 CDP（front-page/workbench/DevTools iframe）端口也动态
// 通过 DOUYIN_IDE_CDP_PORT 显式指定，或运行时从 netstat 动态发现。
const DEFAULT_PORT = Number(process.env.DOUYIN_IDE_CDP_PORT) || 0;

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

// 动态发现 IDE CDP 端口：从 IDE 进程监听端口里找含 front-page 或 workbench 的 CDP
let discoveredPort = null;
export async function discoverCdpPort(timeoutMs = 3000) {
  if (discoveredPort) return discoveredPort;
  const ports = await listIdeListeningPorts(timeoutMs);
  // 优先找有 front-page 或 workbench 的 CDP 端口
  for (const port of ports) {
    try {
      const request = timeoutSignal(1500);
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: request.signal });
      request.close();
      if (!response.ok) continue;
      const targets = await response.json();
      const hasIde = targets.some((t) => (t.url || "").includes("front-page") || (t.url || "").includes("workbench"));
      if (hasIde) { discoveredPort = port; return port; }
    } catch { /* skip */ }
  }
  return null;
}

async function resolvePort(timeoutMs) {
  if (DEFAULT_PORT) return DEFAULT_PORT;
  const found = await discoverCdpPort(timeoutMs);
  if (found) return found;
  const wrapped = new Error("IDE CDP 不可用: 未找到 IDE 调试端口");
  wrapped.code = "CDP_UNAVAILABLE";
  throw wrapped;
}

export async function listTargets(port, timeoutMs = 3000) {
  const activePort = port || await resolvePort(timeoutMs);
  const request = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${activePort}/json/list`, { signal: request.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const wrapped = new Error(`IDE CDP 不可用: ${redact(error.message)}`);
    wrapped.code = "CDP_UNAVAILABLE";
    throw wrapped;
  } finally {
    request.close();
  }
}

function chooseTarget(targets, predicate) {
  return targets.find(predicate) || null;
}

export function targetSummary(targets) {
  return targets.map((target) => ({
    type: target.type,
    title: trimText(target.title, 240),
    hasWebSocket: Boolean(target.webSocketDebuggerUrl),
    projectPath: projectPathFromTarget(target),
  }));
}

function projectPathFromTarget(target) {
  try {
    return new URL(target.url).searchParams.get("projectPath") || undefined;
  } catch {
    return undefined;
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// workbench 页面判定（真机实测的 URL 形态）：
//   .../dist/applications/<类型>/workbench/index.html?type=..&projectPath=<编码路径>
// 只认"路径以 workbench/index.html 结尾"，不能用 ^/workbench/ 这类绝对前缀，
// 否则真实形态会被漏掉；同时排除 VS Code 的 workbench.html（工程窗口 webview，不是 page）。
export function isWorkbenchPage(target) {
  if (!target || target.type !== "page") return false;
  const url = String(target.url || "");
  if (!url) return false;
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch { /* 非标准 URL 时按原文匹配 */ }
  return /\/workbench\/index\.html$/i.test(pathname);
}

// 判断 target 是否绑定到目标工程（**宽松**）：workbench URL 的 projectPath 参数精确匹配，
// 或标题/URL 含目标工程名（front-page 等无 projectPath 参数的场景）。
//
// ⚠ 只用于只读探测/信息展示。会产生副作用（上传、预览等）的操作必须用
// bindWorkbenchStrict()：模糊匹配可能把操作打到别的工程上。
export function isTargetBoundToProject(target, projectPath) {
  const wanted = normalizePath(projectPath);
  if (!wanted || !target) return false;
  const ref = projectPathFromTarget(target);
  if (ref) return normalizePath(ref) === wanted;
  const base = String(projectPath).split(/[\\/]/).filter(Boolean).pop() || "";
  if (!base) return false;
  const hay = `${target.title || ""} ${target.url || ""}`.toLowerCase();
  return hay.includes(base.toLowerCase());
}

// 严格工程绑定（用于任何有副作用的 workbench 操作）：
//   1. target 必须是 workbench 页面；
//   2. URL 必须**存在** projectPath（缺参数一律拒绝，不看标题）；
//   3. 归一化后必须与传入路径**完全相等**；
//   4. 命中 0 个 → NOT_BOUND；命中多个 → AMBIGUOUS。
// 不做标题/工程名模糊匹配，因此"标题相同但缺 projectPath"也会被拒绝。
export function bindWorkbenchStrict(targets, projectPath) {
  const wanted = normalizePath(projectPath);
  if (!wanted) return { target: null, reason: "NO_PROJECT_PATH", candidates: [] };
  const workbenches = (targets || []).filter(isWorkbenchPage);
  if (!workbenches.length) return { target: null, reason: "NOT_FOUND", candidates: [] };
  const strict = workbenches.filter((t) => {
    const ref = projectPathFromTarget(t);
    return Boolean(ref) && normalizePath(ref) === wanted;
  });
  if (strict.length === 1) return { target: strict[0], reason: null, candidates: strict };
  if (strict.length === 0) {
    return {
      target: null,
      reason: "NOT_BOUND",
      candidates: workbenches.map((t) => trimText(t.url || t.title || "", 200)),
    };
  }
  return {
    target: null,
    reason: "AMBIGUOUS",
    candidates: strict.map((t) => trimText(t.url, 200)),
  };
}

// 从 workbench 出发，用 CDP 的 parentId 继承关系定位同一工程的附属 target。
//
// 真机实测的 target 树（parentId 链）：
//   workbench(page, id=X)
//     ├─ webview "MiniApp Webview"        (parentId = X)
//     ├─ webview "<工程名> - 抖音开发者工具" (parentId = X)
//     │    └─ iframe "byted/index.html"   (parentId = 该 webview)
//     └─ …
// 交叉验证：MiniApp Webview 的 sessionId === DevTools 控制台的 project 参数。
// 因此"从 workbench 的 id 出发向下找"是有证据的关联，不需要按工程名猜。
function descendantTargets(targets, rootId) {
  const byParent = new Map();
  for (const t of targets) {
    if (!t.parentId) continue;
    if (!byParent.has(t.parentId)) byParent.set(t.parentId, []);
    byParent.get(t.parentId).push(t);
  }
  const out = [];
  const queue = [rootId];
  const seen = new Set([rootId]);
  while (queue.length) {
    const current = queue.shift();
    for (const child of byParent.get(current) || []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

export function isSimulatorTarget(target) {
  return Boolean(target) && target.type === "webview"
    && (target.title === "MiniApp Webview" || /\/miniapp\/index\.html/.test(target.url || ""));
}

export function isConsoleTarget(target) {
  return Boolean(target) && target.type === "iframe" && /\/byted\/index\.html/.test(target.url || "");
}

// 在"目标 workbench 的子树"内挑选唯一附属 target。
// 传 projectPath 时先做严格绑定；不做工程名/第一个 target 的猜测。
export function bindDescendantTarget(targets, projectPath, predicate, kind) {
  const binding = bindWorkbenchStrict(targets, projectPath);
  if (!binding.target) {
    return { target: null, reason: binding.reason, binding, candidates: binding.candidates };
  }
  const all = descendantTargets(targets, binding.target.id);
  const matched = all.filter(predicate);
  if (matched.length === 1) return { target: matched[0], reason: null, binding, candidates: matched };
  if (matched.length === 0) {
    return { target: null, reason: "NOT_BOUND", binding, candidates: all.map((t) => `${t.type}:${trimText(t.title || t.url || "", 80)}`) };
  }
  return {
    target: null,
    reason: "AMBIGUOUS",
    binding,
    candidates: matched.map((t) => `${t.type}:${trimText(t.title || t.url || "", 80)}`),
  };
}

// 按目标工程选择 CDP 端口与 target 列表（多开 IDE 时避免打错工程实例）：
// 1. 端口内存在 projectPath 参数精确匹配的 target
// 2. 端口内存在标题/URL 含工程名的 target
// 3. 兜底第一个可用端口
export async function resolveIdeTargets(projectPath, timeoutMs = 3000) {
  const ports = await listIdeListeningPorts(timeoutMs);
  if (!ports.length) return { port: null, targets: [] };
  if (projectPath) {
    for (const port of ports) {
      try {
        const targets = await listTargets(port, 1500);
        if (targets.some((t) => projectPathFromTarget(t) && isTargetBoundToProject(t, projectPath))) {
          return { port, targets };
        }
      } catch { /* skip */ }
    }
    for (const port of ports) {
      try {
        const targets = await listTargets(port, 1500);
        if (targets.some((t) => isTargetBoundToProject(t, projectPath))) {
          return { port, targets };
        }
      } catch { /* skip */ }
    }
  }
  for (const port of ports) {
    try {
      const targets = await listTargets(port, 1500);
      if (targets.length) return { port, targets };
    } catch { /* skip */ }
  }
  return { port: null, targets: [] };
}

// 统一上下文解析：传了 projectPath 按工程绑定端口；否则走 discoverCdpPort 缓存。
// 导出供 ide-upload.mjs 复用（避免 CDP 连接逻辑重复实现）。
export async function resolveContext(projectPath, timeoutMs) {
  if (projectPath) {
    const ctx = await resolveIdeTargets(projectPath, timeoutMs);
    if (ctx.port) return ctx;
  }
  const port = await resolvePort(timeoutMs);
  return { port, targets: await listTargets(port, timeoutMs) };
}

export function openConnection(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!target?.webSocketDebuggerUrl) return reject(new Error("目标没有 WebSocket 调试地址"));
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    let opened = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("CDP WebSocket 连接超时"));
    }, timeoutMs);
    socket.on("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        call(method, params = {}) {
          return new Promise((resolveCall, rejectCall) => {
            const id = ++nextId;
            const callTimer = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`CDP 调用超时: ${method}`));
            }, timeoutMs);
            pending.set(id, (message) => {
              clearTimeout(callTimer);
              if (message.error) rejectCall(new Error(message.error.message || "CDP 调用失败"));
              else resolveCall(message.result || {});
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { socket.close(); },
      });
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const callback = pending.get(message.id);
      if (callback) {
        pending.delete(message.id);
        callback(message);
      }
    });
    socket.on("error", (error) => {
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 错误: ${redact(error.message)}`));
      }
    });
  });
}

export async function evaluate(target, expression, timeoutMs) {
  const connection = await openConnection(target, timeoutMs);
  try {
    const result = await connection.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.result?.value;
  } finally {
    connection.close();
  }
}

// 从 target 列表归纳工程状态（纯函数，便于在不连 IDE 的情况下测试）。
//
// 传 projectPath 时一律**严格绑定**：绝不按工程名模糊匹配、也不回退第一个 target。
// 模拟器与控制台自身不带 projectPath，只能通过 workbench 的 parentId 子树关联。
export function summarizeIdeStatus(targets, projectPath) {
  if (!projectPath) {
    // 未指定工程：只报告"本端口上有没有这类 target"，不做工程归属判断
    return {
      bound: false,
      binding: { workbench: "NO_PROJECT_PATH", simulator: "NO_PROJECT_PATH", console: "NO_PROJECT_PATH" },
      workbench: Boolean(chooseTarget(targets, isWorkbenchPage)),
      simulator: Boolean(chooseTarget(targets, isSimulatorTarget)),
      console: Boolean(chooseTarget(targets, isConsoleTarget)),
    };
  }
  const wbBinding = bindWorkbenchStrict(targets, projectPath);
  const simBinding = bindDescendantTarget(targets, projectPath, isSimulatorTarget, "模拟器");
  const consoleBinding = bindDescendantTarget(targets, projectPath, isConsoleTarget, "控制台");
  return {
    bound: Boolean(wbBinding.target),
    // 保留可诊断的绑定状态：为什么 true / 为什么 false
    binding: {
      workbench: wbBinding.reason,
      simulator: simBinding.reason,
      console: consoleBinding.reason,
    },
    workbench: Boolean(wbBinding.target),
    simulator: Boolean(simBinding.target),
    console: Boolean(consoleBinding.target),
  };
}

export async function getIdeStatus(timeoutMs = 3000, projectPath) {
  const { port, targets } = await resolveContext(projectPath, timeoutMs);
  return { port, ...summarizeIdeStatus(targets, projectPath), targets: targetSummary(targets) };
}

// 在候选 target 中挑出绑定到目标工程的 target（**宽松**，允许标题/工程名匹配）。
//
// ⚠ 仅供只读状态探测（如 getIdeStatus）使用，**不得**用于任何有副作用的操作：
// 它会在缺少 projectPath 时按工程目录名模糊匹配，可能命中别的工程。
// 有副作用的操作请用 bindWorkbenchStrict() / bindDescendantTarget()。
export function findBoundTarget(targets, predicate, projectPath) {
  const matched = (targets || []).filter(predicate);
  if (!matched.length) return { target: null, reason: "NOT_FOUND", candidates: [] };
  if (!projectPath) return { target: matched[0], reason: null, candidates: matched };
  const bound = matched.filter((t) => isTargetBoundToProject(t, projectPath));
  if (bound.length === 1) return { target: bound[0], reason: null, candidates: bound };
  if (bound.length === 0) {
    return {
      target: null,
      reason: "NOT_BOUND",
      candidates: matched.map((t) => trimText(t.url || t.title || "", 200)),
    };
  }
  return {
    target: null,
    reason: "AMBIGUOUS",
    candidates: bound.map((t) => trimText(t.url || t.title || "", 200)),
  };
}

// 把"找不到/不唯一"翻译成结构化不支持结果（保持调用方返回 supported:false 的既有约定）
function bindingFailure(kind, projectPath, binding) {
  const detail = binding.reason === "NOT_BOUND"
    ? `未找到绑定到目标工程的${kind}（候选 ${binding.candidates.length} 个，均不匹配），已拒绝操作其他工程`
    : `有多个${kind}同时匹配目标工程，无法确定唯一目标`;
  return { supported: false, reason: detail, binding: binding.reason, projectPath };
}

// 严格 workbench 绑定失败的可读原因（用于所有会点击 IDE 界面的操作）
function workbenchFailure(projectPath, binding) {
  const detail = {
    NO_PROJECT_PATH: "未提供 projectPath，拒绝在不确定的工程上执行有副作用的操作",
    NOT_FOUND: "未找到任何 workbench 页面（工程可能未在 IDE 中打开）",
    NOT_BOUND: `未找到 projectPath 与目标完全一致的 workbench（已打开 ${binding.candidates.length} 个但不匹配），已拒绝操作其他工程`,
    AMBIGUOUS: `有多个 workbench 的 projectPath 与目标完全一致（${binding.candidates.length} 个），无法确定唯一目标`,
  }[binding.reason] || "workbench 绑定失败";
  return { supported: false, reason: detail, binding: binding.reason, projectPath, candidates: binding.candidates };
}

export async function clickWorkbenchText(label, timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  // 有副作用的点击：用严格绑定（必须存在 projectPath 且完全相等）
  const binding = bindWorkbenchStrict(targets, projectPath);
  if (!binding.target) return workbenchFailure(projectPath, binding);
  const target = binding.target;
  // 同时查找 button/role=button/aria-label 和工具栏 DIV 按钮（tila-toolbar-item-container）
  // 对DIV按钮触发完整的鼠标事件序列（mousedown→mouseup→click），因为有些框架监听mousedown/mouseup
  const expression = `(function(){const wanted=${JSON.stringify(label)};const norm=(v)=>String(v||'').replace(/\\s+/g,'').trim();const nodes=[...document.querySelectorAll('button,[role="button"],[aria-label],.tila-toolbar-item-container,[class*=toolbar-item]')];const matches=nodes.filter((node)=>norm(node.innerText||node.getAttribute('aria-label')||node.title)===wanted);if(!matches.length)return {clicked:false,matched:0};const el=matches[0];const rect=el.getBoundingClientRect();const x=rect.x+rect.width/2,y=rect.y+rect.height/2;const opts={bubbles:true,cancelable:true,clientX:x,clientY:y,button:0};el.dispatchEvent(new MouseEvent('mousedown',opts));el.dispatchEvent(new MouseEvent('mouseup',opts));el.click();return {clicked:true,matched:matches.length,tag:el.tagName,className:String(el.className||'').substring(0,60),x:Math.round(x),y:Math.round(y)};})()`;
  const result = await evaluate(target, expression, timeoutMs);
  return { supported: true, label, ...(result || { clicked: false, matched: 0 }) };
}

export async function captureSimulator(timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  // 模拟器 webview 不带 projectPath，因此先严格绑定 workbench，再沿 parentId 子树定位它。
  const binding = bindDescendantTarget(targets, projectPath, isSimulatorTarget, "模拟器");
  if (!binding.target) {
    return {
      supported: false,
      reason: descendantFailureReason("模拟器 MiniApp Webview 页面", binding),
      binding: binding.reason,
      projectPath,
      candidates: binding.candidates,
    };
  }
  const target = binding.target;
  const connection = await openConnection(target, timeoutMs);
  try {
    const result = await connection.call("Page.captureScreenshot", { format: "png", fromSurface: true });
    if (!result.data) return { supported: false, reason: "IDE 未返回模拟器截图数据" };
    return { supported: true, data: Buffer.from(result.data, "base64"), target: "MiniApp Webview" };
  } finally {
    connection.close();
  }
}

function extractErrorLines(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => trimText(line, 600)).filter(Boolean);
  const pattern = /(error|exception|failed|failure|typeerror|referenceerror|syntaxerror|unhandled|错误|异常|失败)/i;
  return { lines: lines.slice(-100), errors: lines.filter((line) => pattern.test(line)).slice(-50) };
}

// 附属 target 绑定失败时给出可读原因（与 workbench 严格绑定失败区分开）
function descendantFailureReason(kind, binding) {
  switch (binding.reason) {
    case "NOT_BOUND":
      return `未在目标工程的 workbench 子树中找到${kind}（该 target 不带 projectPath，只能按 parentId 关联）`;
    case "AMBIGUOUS":
      return `目标工程的 workbench 子树中有多个${kind}，无法确定唯一目标`;
    case "NO_PROJECT_PATH":
      return `未提供 projectPath，拒绝按工程名猜测${kind}`;
    default:
      return `未找到目标工程的 workbench，因此无法定位${kind}`;
  }
}

export async function readConsoleErrors(timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  // 控制台 iframe 同样不带 projectPath；它在 VS Code webview 之下，
  // 而该 webview 的 parentId 指向 workbench，因此用子树关联。
  const binding = bindDescendantTarget(targets, projectPath, isConsoleTarget, "控制台");
  if (!binding.target) {
    return {
      supported: false,
      reason: descendantFailureReason("DevTools 控制台页面", binding),
      binding: binding.reason,
      projectPath,
      candidates: binding.candidates,
    };
  }
  const target = binding.target;
  const text = await evaluate(target, "document.body?.innerText || document.documentElement?.innerText || ''", timeoutMs);
  return { supported: true, ...extractErrorLines(text), source: "IDE DevTools DOM" };
}

// ---------- IDE 内预览（绕过 CLI 登录，直接操控已登录的 IDE） ----------

// 从 workbench 页面提取预览弹窗中的二维码：
// 优先 canvas（toDataURL），其次 data:image 的 img；返回 { kind, data(base64), mime, width, height } 或 null
function qrImageExpression() {
  return `(function(){
    try {
      const canvases = [...document.querySelectorAll("canvas")].map((c) => ({ c, box: c.getBoundingClientRect() }));
      canvases.sort((a, b) => b.box.width - a.box.width);
      const top = canvases.find((x) => x.box.width >= 100 && x.box.height >= 100 && x.box.width <= 600);
      if (top) {
        const data = top.c.toDataURL("image/png");
        if (data && data.startsWith("data:image")) {
          return { kind: "canvas", data: data.split(",")[1], mime: "image/png", width: Math.round(top.box.width), height: Math.round(top.box.height), left: Math.round(top.box.left), top: Math.round(top.box.top) };
        }
      }
      for (const im of [...document.querySelectorAll("img")]) {
        const src = im.src || "";
        if (src.startsWith("data:image/") && im.naturalWidth >= 80 && im.naturalHeight >= 80 && Math.abs(im.naturalWidth - im.naturalHeight) <= 4) {
          return { kind: "img", data: src.split(",")[1], mime: src.slice(5, src.indexOf(",")), width: im.naturalWidth, height: im.naturalHeight };
        }
      }
      return null;
    } catch (e) { return null; }
  })()`;
}

// 在已登录的 IDE 中点击「预览」并等待、提取二维码（不依赖 CLI 登录态）
export async function previewInIde({ projectPath, timeoutMs = 20000 } = {}) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  // 预览会点击 IDE 界面（有副作用），因此用严格绑定：拿不到唯一 workbench 就拒绝
  const binding = bindWorkbenchStrict(targets, projectPath);
  if (!binding.target) return workbenchFailure(projectPath, binding);
  const wb = binding.target;
  // 弹窗可能已打开：先直接找二维码，避免二次点击把弹窗关掉
  const existing = await evaluate(wb, qrImageExpression(), 3000).catch(() => null);
  if (existing && existing.data) return { supported: true, qr: existing, click: { alreadyOpen: true, clicked: false } };
  const click = await clickWorkbenchText("预览", timeoutMs, projectPath);
  if (!click.clicked) return { supported: false, reason: "workbench 未找到可点击的「预览」按钮", click };
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(wb, qrImageExpression(), Math.min(3000, timeoutMs));
      if (value && value.data) return { supported: true, click, qr: value };
      lastError = value ? null : "二维码元素未出现";
    } catch (error) {
      lastError = trimText(error.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { supported: false, reason: `预览弹窗未提取到二维码（等待 ${timeoutMs}ms）`, click, lastError };
}

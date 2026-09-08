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

// 判断 target 是否绑定到目标工程：workbench URL 的 projectPath 参数精确匹配，
// 或标题/URL 含目标工程名（front-page 等无 projectPath 参数的场景）。
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

// 统一上下文解析：传了 projectPath 按工程绑定端口；否则走 discoverCdpPort 缓存
async function resolveContext(projectPath, timeoutMs) {
  if (projectPath) {
    const ctx = await resolveIdeTargets(projectPath, timeoutMs);
    if (ctx.port) return ctx;
  }
  const port = await resolvePort(timeoutMs);
  return { port, targets: await listTargets(port, timeoutMs) };
}

function openConnection(target, timeoutMs) {
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

async function evaluate(target, expression, timeoutMs) {
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

export async function getIdeStatus(timeoutMs = 3000, projectPath) {
  const { port, targets } = await resolveContext(projectPath, timeoutMs);
  return {
    port,
    workbench: Boolean(chooseTarget(targets, (target) => target.type === "page" && /workbench\/index\.html/.test(target.url || ""))),
    simulator: Boolean(chooseTarget(targets, (target) => target.title === "MiniApp Webview" || /\/miniapp\/index\.html/.test(target.url || ""))),
    console: Boolean(chooseTarget(targets, (target) => target.type === "iframe" && /\/byted\/index\.html/.test(target.url || ""))),
    targets: targetSummary(targets),
  };
}

export async function clickWorkbenchText(label, timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  const target = chooseTarget(targets, (item) => item.type === "page" && /workbench\/index\.html/.test(item.url || ""));
  if (!target) return { supported: false, reason: "未找到 IDE workbench 调试页面" };
  const expression = `(function(){const wanted=${JSON.stringify(label)};const norm=(v)=>String(v||'').replace(/\\s+/g,'').trim();const nodes=[...document.querySelectorAll('button,[role="button"],[aria-label]')];const matches=nodes.filter((node)=>norm(node.innerText||node.getAttribute('aria-label')||node.title)===wanted);if(!matches.length)return {clicked:false,matched:0};matches[0].click();return {clicked:true,matched:matches.length};})()`;
  const result = await evaluate(target, expression, timeoutMs);
  return { supported: true, label, ...(result || { clicked: false, matched: 0 }) };
}

export async function captureSimulator(timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  const target = chooseTarget(targets, (item) => item.title === "MiniApp Webview" || /\/miniapp\/index\.html/.test(item.url || ""));
  if (!target) return { supported: false, reason: "未找到模拟器 MiniApp Webview 调试页面" };
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

export async function readConsoleErrors(timeoutMs = 5000, projectPath) {
  const { targets } = await resolveContext(projectPath, timeoutMs);
  const target = chooseTarget(
    targets,
    (item) => item.type === "iframe" && /\/byted\/index\.html/.test(item.url || ""),
  );
  if (!target) return { supported: false, reason: "未找到 IDE DevTools 控制台页面，IDE 4.5.5 未提供稳定控制台接口" };
  const text = await evaluate(target, "document.body?.innerText || document.documentElement?.innerText || ''", timeoutMs);
  return { supported: true, ...extractErrorLines(text), source: "IDE DevTools DOM" };
}

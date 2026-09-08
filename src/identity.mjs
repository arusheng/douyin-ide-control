import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { redact, trimText } from "./path-policy.mjs";

// IDE 4.5.5 端口：
// - 8830：workbench 调试端口（工程载入后监听；可被 DOUYIN_IDE_CDP_PORT 覆盖）
// - 8702（动态）：IDE 主进程 CDP（前置管理页/权限弹窗/启动页 UI；端口随实例变化）
const WORKBENCH_PORT = Number(process.env.DOUYIN_IDE_CDP_PORT) || 8830;

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

// ---------- CDP 基础 ----------

export async function listTargets(port, timeoutMs = 3000) {
  const request = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: request.signal });
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

export function chooseTarget(targets, predicate) {
  return targets.find(predicate) || null;
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

export async function evaluateOn(target, expression, timeoutMs = 8000) {
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

// ---------- IDE 主进程端口发现 ----------

// 扫描 IDE 主进程实际监听的 CDP 端口（workbench 端口之外、Electron 主窗口对应的端口）
export async function discoverIdeMainPort(candidatePorts = [8702, 8368], timeoutMs = 2500) {
  const tried = [];
  for (const port of candidatePorts) {
    try {
      const targets = await listTargets(port, timeoutMs);
      tried.push(port);
      const hasFrontPage = targets.some((t) => (t.url || "").includes("front-page"));
      const hasWorkbench = targets.some((t) => (t.url || "").includes("workbench"));
      if (hasFrontPage || hasWorkbench) return { port, targets, hasFrontPage, hasWorkbench };
    } catch {
      tried.push(port);
    }
  }
  return { port: null, targets: [], hasFrontPage: false, hasWorkbench: false, tried };
}

// 扫描系统里 IDE 主进程（抖音开发者工具.exe）所有监听端口，找 CDP 主端口
export async function findIdeMainPortByNetstat(timeoutMs = 5000) {
  // 先探测已知候选；失败时按 IDE 进程监听端口全量扫描
  const known = await discoverIdeMainPort();
  if (known.port) return known;
  const { listIdeListeningPorts } = await import("./proc.mjs");
  const ports = await listIdeListeningPorts(timeoutMs);
  for (const port of ports) {
    try {
      const targets = await listTargets(port, 2000);
      const hasFrontPage = targets.some((t) => (t.url || "").includes("front-page"));
      if (hasFrontPage) return { port, targets, hasFrontPage: true, hasWorkbench: targets.some((t) => (t.url || "").includes("workbench")) };
    } catch { /* skip */ }
  }
  return { port: null, targets: [], hasFrontPage: false, hasWorkbench: false, ports };
}

// ---------- DOM 读取 ----------

async function readTargetText(target, timeoutMs = 8000) {
  const expr = `(function(){
    const txt = document.body ? document.body.innerText : '';
    const modals = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[class*="Modal"],[class*="Dialog"],[role="dialog"]')]
      .map(el => el.innerText).filter(Boolean).join('\\n---\\n');
    return JSON.stringify({ title: document.title, body: (txt||'').slice(0, 4000), modal: (modals||'').slice(0, 2000) });
  })()`;
  const raw = await evaluateOn(target, expr, timeoutMs);
  try { return JSON.parse(raw); } catch { return { title: "", body: String(raw || ""), modal: "" }; }
}

const PERMISSION_PATTERNS = [
  // 强信号：明确的权限拒绝/弹窗措辞，避免裸词"权限"误伤普通文本
  "获取域名白名单失败", "没有权限访问此应用", "无权限访问", "没有权限访问",
  "permission denied", "no permission", "无此权限", "not authorized",
  "添加 IDE 权限", "未绑定", "账号中心", "IDE 权限",
  "请先在抖音开放平台", "没有权限", "无权访问",
];
const TYPE_SIGNALS = {
  minigame: ["小游戏", "minigame", "game.js", "game.json", "miniapp-game"],
  miniapp: ["小程序", "app.json", "app.js", "pages", "can't find app.json", "cannot find app.json", "找不到 app.json"],
};

// 从文本判断权限弹窗/类型信号
function analyzeText(text, source) {
  const hits = PERMISSION_PATTERNS.filter((p) => text.includes(p));
  const hasPermissionIssue = hits.length >= 1;
  const minigameSignals = TYPE_SIGNALS.minigame.filter((s) => text.includes(s));
  const miniappSignals = TYPE_SIGNALS.miniapp.filter((s) => text.includes(s));
  // "can't find app.json" 是小程序编译器在找 app.json 的强信号
  const lookingForAppJson = /can'?t find app\.json|找不到 app\.json|app\.json.*not found|not found.*app\.json/i.test(text);
  const isMinigameByCompile = /can'?t find game\.json|找不到 game\.json/i.test(text);
  return {
    source,
    permissionHits: hits,
    hasPermissionIssue,
    minigameSignals,
    miniappSignals,
    lookingForAppJson,
    isMinigameByCompile,
  };
}

// ---------- 文件结构辅助（仅辅助证据） ----------

function fileStructureEvidence(projectPath) {
  const entries = fs.existsSync(projectPath) ? fs.readdirSync(projectPath) : [];
  const hasGameJs = entries.includes("game.js");
  const hasGameJson = entries.includes("game.json");
  const hasAppJs = entries.includes("app.js");
  const hasAppJson = entries.includes("app.json");
  const hasPagesDir = entries.includes("pages");
  const hasProjectConfig = entries.includes("project.config.json");
  let appidFromConfig = null;
  let typeHintFromConfig = null;
  try {
    const cfgPath = path.join(projectPath, "project.config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      appidFromConfig = cfg.appid || null;
      // 官方小游戏 project.config.json 无显式 type 字段；小程序可能有 miniprogramRoot
      if (cfg.miniprogramRoot) typeHintFromConfig = "miniapp";
      else if (cfg.minigameRoot) typeHintFromConfig = "minigame";
    }
  } catch { /* 解析失败不阻断 */ }
  return {
    entries,
    hasGameJs,
    hasGameJson,
    hasAppJs,
    hasAppJson,
    hasPagesDir,
    hasProjectConfig,
    appidFromConfig,
    typeHintFromConfig,
    // 小游戏 = game.js/game.json 存在且无 app.json/pages；仅作辅助，不单独判定
    structureLooksLike: hasGameJs && hasGameJson && !hasAppJson && !hasPagesDir ? "minigame" : (hasAppJs || hasAppJson ? "miniapp" : "unknown"),
  };
}

// ---------- 工程绑定工具 ----------
// 判断 IDE target 的文本/URL 是否属于要识别的工程。
// 核心思路：workbench URL 的 projectPath 参数是强绑定；当多个不同工程同时在 IDE 打开时，
// 只采用与目标工程一致的证据，避免"分不清小程序和小游戏"（跨工程污染）。

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sameProject(a, b) {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

// 从 target url 的 projectPath 参数提取工程路径
function projectPathFromTarget(target) {
  const m = String(target?.url || "").match(/[?&]projectPath=([^&\s]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// 只保留与目标工程匹配的 workbench target：
// - 无目标工程路径 → 全部采用（视为当前活动工程）
// - 没有 target 带 projectPath 参数 → 全部采用（当前活动工程）
// - 只有一个不同工程 → 全部采用（单工程假设）
// - 多个不同工程 → 仅采用与目标匹配的；无匹配则不用 workbench 证据（避免用错工程判型）
export function boundWorkbenchTargets(workbenchTargets, projectPath) {
  const targets = workbenchTargets || [];
  if (!projectPath) return targets;
  const withPath = targets.filter((t) => projectPathFromTarget(t));
  if (withPath.length === 0) return targets;
  const distinct = [...new Set(withPath.map((t) => normalizePath(projectPathFromTarget(t))))];
  if (distinct.length <= 1) return targets;
  const bound = targets.filter((t) => {
    const ref = projectPathFromTarget(t);
    return ref ? sameProject(ref, projectPath) : false;
  });
  return bound.length ? bound : [];
}

// 只保留与目标工程匹配的 IDE target 文本（类型证据用）：
// 规则同 boundWorkbenchTargets；多工程时不带 projectPath 参数的 target（如 front-page）
// 不再作为类型证据，避免把其他工程/启动页的文本算进来。
export function boundIdeTexts(ideTexts, projectPath, expectedAppid) {
  const texts = ideTexts || [];
  if (!projectPath && !expectedAppid) return texts;
  const withPath = texts.filter((t) => projectPathFromTarget(t));
  if (withPath.length === 0) return texts;
  const distinct = [...new Set(withPath.map((t) => normalizePath(projectPathFromTarget(t))))];
  if (distinct.length <= 1) return texts;
  return texts.filter((t) => {
    const ref = projectPathFromTarget(t);
    if (!ref) return false;
    return sameProject(ref, projectPath);
  });
}

// ---------- 身份识别主入口 ----------

export class IdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// 测试注入：替换外部探测（IDE CDP / netstat / tma get-meta / 文件结构）
let identityProbes = null;
export function setIdentityProbes(probes) {
  identityProbes = probes;
}

function probe() {
  return identityProbes || {};
}

// 返回 { ok, identity } 或抛出 IdentityError（APP_PERMISSION_DENIED / PROJECT_TYPE_MISMATCH / APPID_MISMATCH / PROJECT_TYPE_UNKNOWN）
export async function resolveProjectIdentity(projectPath, { expectedAppid, expectedProjectType, timeoutMs = 15000 } = {}) {
  const probes = probe();
  const evidence = [];
  const file = probes.fileStructure
    ? probes.fileStructure(projectPath)
    : fileStructureEvidence(projectPath);
  evidence.push({ source: "file-structure", ...file });

  // 1. IDE 主进程 CDP（前置管理页 + workbench + MiniApp Webview 编译错误）
  let mainPort = null;
  let ideTexts = [];
  let permissionText = null;
  try {
    const found = probes.findIdeMainPort
      ? await probes.findIdeMainPort()
      : await findIdeMainPortByNetstat();
    mainPort = found.port;
    if (mainPort && found.targets) {
      evidence.push({ source: "ide-main-cdp", port: mainPort, targetTitles: found.targets.map((t) => t.title) });
      for (const t of found.targets) {
        if (t.type !== "page" && t.type !== "webview") continue;
        try {
          const dom = probes.readTargetText
            ? await probes.readTargetText(t, timeoutMs)
            : await readTargetText(t, timeoutMs);
          ideTexts.push({ title: t.title, body: dom.body, modal: dom.modal, url: t.url || "" });
          const combined = `${dom.title}\n${dom.body}\n${dom.modal}`;
          const analysis = analyzeText(combined, `ide-main:${t.title}`);
          // 权限证据需绑定目标工程上下文：MiniApp Webview 含 appConfig 的 target 需含目标 AppID
          const isTargetContext = t.title.includes("MiniApp Webview")
            ? (combined.includes(expectedAppid || "") || combined.includes("app.json") || combined.includes("game.json"))
            : true;
          if (analysis.hasPermissionIssue && !permissionText && isTargetContext) {
            permissionText = { source: t.title, hits: analysis.permissionHits, text: combined.slice(0, 1200) };
          }
        } catch { /* 单个 target 失败不阻断 */ }
      }
    }
  } catch (error) {
    evidence.push({ source: "ide-main-cdp", error: trimText(error.message) });
  }

  // 2. workbench 调试端口 target 列表（默认 8830；新版 IDE 端口动态，失败时回退到 IDE 主进程 CDP 端口）
  let workbenchInfo = null;
  try {
    const targets = probes.listWorkbenchTargets
      ? await probes.listWorkbenchTargets()
      : await listTargets(WORKBENCH_PORT, 3000);
    workbenchInfo = { port: WORKBENCH_PORT, targets: targets.map((t) => ({ type: t.type, title: trimText(t.title, 200), url: trimText(t.url, 200) })) };
    evidence.push({ source: "workbench-cdp", ...workbenchInfo });
  } catch (error) {
    // workbench 固定端口不可用时，回退到 IDE 主进程 CDP（mainPort）中携带的 workbench target，
    // 避免新版 IDE 动态端口导致类型证据缺失（PROJECT_TYPE_UNKNOWN 误判）。
    if (mainPort && mainPort !== WORKBENCH_PORT) {
      try {
        const targets = probes.listTargetsOn
          ? await probes.listTargetsOn(mainPort)
          : await listTargets(mainPort, 3000);
        const workbenchTargets = targets.filter((t) => (t.url || "").includes("workbench"));
        if (workbenchTargets.length) {
          workbenchInfo = { port: mainPort, targets: workbenchTargets.map((t) => ({ type: t.type, title: trimText(t.title, 200), url: trimText(t.url, 200) })) };
          evidence.push({ source: "workbench-cdp", port: mainPort, fallbackFrom: WORKBENCH_PORT, targets: workbenchInfo.targets });
        }
      } catch { /* 回退失败不阻断 */ }
    }
    if (!workbenchInfo) evidence.push({ source: "workbench-cdp", error: trimText(error.message) });
  }

  // 3. 已登录应用元数据（tma get-meta）——权威来源
  let meta = null;
  let metaError = null;
  if (expectedAppid) {
    if (probes.getMeta) {
      meta = await probes.getMeta(expectedAppid);
    } else {
      // 与 cli.mjs 的 resolveTmaCli 保持一致（PATH/DOUYIN_TMA_CLI_JS/默认路径探测），
      // 不再硬编码 npm 全局路径——npm prefix 变化时 get-meta 不会单独断掉。
      const { execFile } = await import("node:child_process");
      let cliPath = null;
      try {
        const { resolveTmaCli } = await import("./cli.mjs");
        cliPath = await resolveTmaCli();
      } catch (error) {
        meta = { ok: false, stderr: `未找到官方 tt-ide-cli: ${trimText(error.message)}` };
        metaError = meta.stderr;
      }
      if (cliPath) {
        meta = await new Promise((resolve) => {
          const child = execFile(process.execPath, [cliPath, "get-meta", expectedAppid], {
            windowsHide: true, timeout: 10000,
            env: { ...process.env, FORCE_COLOR: "0" },
          }, (err, stdout, stderr) => {
            if (err) return resolve({ ok: false, stderr: trimText(String(stderr || err.message), 400) });
            resolve({ ok: true, stdout: trimText(String(stdout), 600) });
          });
          child.on("error", (e) => resolve({ ok: false, stderr: trimText(e.message) }));
        });
      }
    }
    if (meta.ok) {
      const text = meta.stdout || "";
      // CLI 返回 exit 0 但无有效内容（如无 Cookie 时空输出）→ 视为不可用
      const empty = text.trim().length === 0 || /未登录|重新登录|no cookie/i.test(text);
      if (empty) {
        meta = { ok: false, stderr: "CLI 未返回有效元数据（可能未登录）" };
        metaError = meta.stderr;
      } else {
        const appidMatch = text.match(/tt[a-zA-Z0-9]{16,20}/);
        meta.actualAppid = appidMatch ? appidMatch[0] : null;
        meta.typeHints = {
          // 只认明确的类型词（小游戏/minigame/microgame vs 小程序/miniapp/microapp），
          // 不用裸 "game"/"app" 这类易误伤的词（get-meta 文本里出现 game 不代表是小游戏）。
          isMinigame: /小游戏|minigame|microgame/i.test(text) && !/小程序|miniapp|microapp/i.test(text),
          isMiniapp: /小程序|miniapp|microapp/i.test(text) && !/小游戏|minigame|microgame/i.test(text),
          raw: text.slice(0, 300),
        };
      }
    } else {
      metaError = meta.stderr;
    }
    evidence.push({ source: "tma-get-meta", ok: meta.ok, error: metaError, typeHints: meta.typeHints, actualAppid: meta.actualAppid });
  }

  // ---- 综合判定 ----

  // ---- 权限判定（用全部 IDE DOM 文本，权限弹窗优先于绑定过滤）----
  const allIdeText = ideTexts.map((t) => `${t.title}\n${t.body}\n${t.modal}`).join("\n---\n");
  const permissionAnalysis = analyzeText(allIdeText, "combined");
  const strongPermission = permissionText || (permissionAnalysis.hasPermissionIssue && /白名单|没有权限访问|无权限访问|未绑定|IDE 权限|账号中心|无权访问/i.test(allIdeText));
  // permissionText 已在上层循环按目标上下文收集；此处再兜底检测全量强信号
  // allowed 需要元数据确实返回了有效内容（actualAppid 或类型），仅 ok:true 但空输出不算
  const metaUsable = Boolean(meta?.ok && (meta.actualAppid || meta.typeHints?.isMinigame || meta.typeHints?.isMiniapp));
  const permissionState = strongPermission ? "denied" : (metaUsable ? "allowed" : "unknown");

  // 判定 1：权限问题（优先于类型，denied 才阻断）
  if (permissionState === "denied") {
    const identity = {
      projectPath,
      configuredAppid: file.appidFromConfig,
      ideActualAppid: meta?.ok ? meta.actualAppid : null,
      appPlatformType: meta?.ok ? (meta.typeHints.isMinigame ? "minigame" : meta.typeHints.isMiniapp ? "miniapp" : null) : null,
      ideOpenMode: null,
      projectType: null,
      evidence: evidence.slice(0, 6),
      permission: { state: "denied", reason: "IDE 提示当前账号无权限访问该 AppID", details: permissionText || { source: "combined-dom" } },
    };
    throw new IdentityError("APP_PERMISSION_DENIED", "当前账号无权限访问该 AppID（IDE 权限弹窗）", { identity });
  }

  // 类型判定用绑定过滤后的文本（避免读取其他工程窗口误判）
  // 多工程同时打开时，只采用与目标工程（projectPath/AppID）绑定的 target 文本。
  const boundForType = boundIdeTexts(ideTexts, projectPath, expectedAppid);
  const relevantTexts = boundForType.filter((t) => {
    const combined = `${t.title}\n${t.body}`;
    if (t.title.includes("MiniApp Webview") || combined.includes("appConfig")) {
      return combined.includes(expectedAppid || "") || combined.includes("app.json") || combined.includes("game.json");
    }
    return true;
  });
  const allText = relevantTexts.length ? relevantTexts.map((t) => `${t.title}\n${t.body}\n${t.modal}`).join("\n---\n") : "";

  // ---- AppID 判定 ----
  // configuredAppid：来自 project.config.json（配置声明）
  // ideActualAppid：来自 IDE 当前工程（get-meta 权威元数据 或 MiniApp Webview appConfig）
  const configuredAppid = file.appidFromConfig;
  const ideActualAppid = meta?.ok ? meta.actualAppid : null;
  if (expectedAppid && ideActualAppid && ideActualAppid !== expectedAppid) {
    const identity = {
      projectPath,
      configuredAppid,
      ideActualAppid,
      expectedAppid,
      appPlatformType: meta?.ok ? (meta.typeHints.isMinigame ? "minigame" : meta.typeHints.isMiniapp ? "miniapp" : null) : null,
      projectType: null,
      evidence: evidence.slice(0, 5),
      permission: { state: permissionState },
    };
    throw new IdentityError("APPID_MISMATCH", `IDE 实际 AppID ${ideActualAppid} 与预期 ${expectedAppid} 不同`, { identity });
  }

  // ---- 类型判定 ----
  // appPlatformType：应用权威类型（来自 get-meta 元数据）
  // ideOpenMode：IDE 当前按小游戏还是小程序编译（来自 workbench URL / 编译错误）
  const appPlatformType = meta?.ok ? (meta.typeHints.isMinigame ? "minigame" : meta.typeHints.isMiniapp ? "miniapp" : null) : null;
  const ideTypeSignal = analyzeIdeTypeSignals(relevantTexts, workbenchInfo, mainPort, expectedAppid, projectPath);
  const ideOpenMode = ideTypeSignal.type; // "minigame" | "miniapp" | null
  let projectType = ideOpenMode || appPlatformType || null;
  let typeEvidenceSource = ideOpenMode ? ideTypeSignal.source : (appPlatformType ? "tma-get-meta" : null);
  if (!projectType) {
    // 文件结构仅作为辅助证据：能确认时记录，但权限/类型权威证据缺失时保持 unknown
    const fileLooks = file.structureLooksLike;
    if (fileLooks !== "unknown") {
      evidence.push({ source: "file-structure-candidate", candidate: fileLooks });
    }
    const identity = {
      projectPath,
      configuredAppid,
      ideActualAppid,
      appPlatformType,
      ideOpenMode,
      projectType: null,
      expectedAppid,
      expectedProjectType,
      evidence,
      fileStructureHint: file.structureLooksLike,
      permission: { state: permissionState },
    };
    throw new IdentityError("PROJECT_TYPE_UNKNOWN", "无法取得可靠的工程类型证据", { identity });
  }

  // 判定 4：类型不匹配（有权威证据且确实不符）
  if (expectedProjectType && projectType !== expectedProjectType) {
    const identity = {
      projectPath,
      configuredAppid,
      ideActualAppid,
      appPlatformType,
      ideOpenMode,
      projectType,
      expectedProjectType,
      typeEvidenceSource,
      evidence: evidence.slice(0, 5),
      permission: { state: permissionState },
    };
    throw new IdentityError("PROJECT_TYPE_MISMATCH", `IDE 识别工程类型为 ${projectType}，与预期 ${expectedProjectType} 不同`, { identity });
  }

  return {
    ok: true,
    identity: {
      projectPath,
      configuredAppid,
      ideActualAppid,
      appPlatformType,
      ideOpenMode,
      projectType,
      expectedAppid,
      expectedProjectType,
      typeEvidenceSource,
      permission: { state: permissionState },
      evidence,
    },
  };
}

// 从 IDE DOM/编译错误判定类型（权威）；证据必须与目标 projectPath/AppID 绑定。
// 判定顺序：编译错误（绑定后）> workbench URL 协议（绑定后）> workbench 编辑器内容（绑定后）。
// 不再用 front-page 导航的"含小游戏不含小程序"文本猜测——启动页同时含两类标签，最易误判。
function analyzeIdeTypeSignals(ideTexts, workbenchInfo, mainPort, expectedAppid, projectPath) {
  // ideTexts 已由调用方按目标工程绑定（boundIdeTexts）；此处再做 MiniApp Webview 的 AppID 过滤
  const targetTexts = ideTexts.filter((t) => {
    const combined = `${t.title}\n${t.body}`;
    if (t.title.includes("MiniApp Webview") || combined.includes("appConfig")) {
      return combined.includes(expectedAppid || "") || combined.includes("app.json") || combined.includes("game.json");
    }
    return true;
  });
  // 1. MiniApp Webview 编译错误："can't find app.json" → 小程序编译器
  const compileTexts = targetTexts.map((t) => `${t.title}\n${t.body}`).join("\n");
  if (/can'?t find app\.json|找不到 app\.json|app\.json.*not found/i.test(compileTexts)) {
    return { type: "miniapp", source: "ide-compile-error(app.json 缺失)" };
  }
  if (/can'?t find game\.json|找不到 game\.json|game\.json.*not found/i.test(compileTexts)) {
    return { type: "minigame", source: "ide-compile-error(game.json 缺失)" };
  }
  // 2. workbench URL 的 openApplicationType（须绑定目标 projectPath）
  const boundWorkbench = boundWorkbenchTargets(workbenchInfo?.targets, projectPath);
  for (const t of boundWorkbench) {
    const url = t.url || "";
    if (!url.includes("workbench")) continue;
    // workbench URL 带 projectPath 参数时校验绑定；无参数则视为当前活动工程
    const projectPathMatch = url.match(/[?&]projectPath=([^&]+)/);
    const targetProject = projectPathMatch ? decodeURIComponent(projectPathMatch[1]).toLowerCase() : null;
    const urlLower = url.toLowerCase();
    // tma 打开 → microapp 协议；tmg 打开 → microgame 协议（小游戏专用 CLI）
    if (urlLower.includes("openApplicationType=miniapp") || urlLower.includes("type=microapp") || urlLower.includes("project-type=microapp")) {
      return { type: "miniapp", source: `workbench-url(${targetProject || "active"})` };
    }
    if (urlLower.includes("openApplicationType=minigame") || urlLower.includes("type=game") || urlLower.includes("type=minigame")
      || urlLower.includes("type=microgame") || urlLower.includes("project-type=microgame")) {
      return { type: "minigame", source: `workbench-url(${targetProject || "active"})` };
    }
  }
  // 3. workbench 编辑器内容：game.js/game.json 在资源管理器（小游戏），app.json/pages（小程序）
  for (const t of targetTexts) {
    if (t.body.includes("game.json") && t.body.includes("game.js")) return { type: "minigame", source: "workbench-editor" };
    if (t.body.includes("app.json") && t.body.includes("pages")) return { type: "miniapp", source: "workbench-editor" };
  }
  return { type: null, source: null };
}

// ---------- 启动页 UI 操作（CDP DOM 语义控件，禁截图坐标） ----------

// 获取前置管理页 target（IDE 主进程 CDP 中的 front-page）
export async function getFrontPageTarget(timeoutMs = 8000) {
  const found = await findIdeMainPortByNetstat(timeoutMs);
  if (!found.port || !found.targets) return { supported: false, reason: "未找到 IDE 主进程 CDP 端口" };
  const target = chooseTarget(found.targets, (t) => (t.url || "").includes("front-page"));
  if (!target) return { supported: false, reason: "未找到 IDE 前置管理页 target（front-page）", port: found.port };
  return { supported: true, port: found.port, target };
}

// 在前置管理页 DOM 中点击文本控件（语义控件，不依赖坐标）
export async function clickFrontPageText(label, timeoutMs = 8000) {
  const page = await getFrontPageTarget(timeoutMs);
  if (!page.supported) return page;
  const expression = `(function(){
    const wanted = ${JSON.stringify(label)};
    const norm = (v) => String(v || '').replace(/\\s+/g, '').trim();
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[aria-label],[class*="nav"],[class*="Nav"],[class*="tab"],[class*="Tab"],a,li,span,div')];
    const matches = nodes.filter((node) => norm(node.innerText || node.getAttribute('aria-label') || node.title) === wanted);
    if (!matches.length) {
      // 模糊：包含匹配（避免子节点重复文本）
      const fuzzy = nodes.filter((node) => norm(node.innerText || node.getAttribute('aria-label') || node.title).includes(wanted) && norm(node.innerText).length <= wanted.length + 8);
      if (!fuzzy.length) return { clicked: false, matched: 0, label: wanted };
      fuzzy[0].click();
      return { clicked: true, matched: fuzzy.length, method: 'fuzzy' };
    }
    matches[0].click();
    return { clicked: true, matched: matches.length, method: 'exact' };
  })()`;
  try {
    const result = await evaluateOn(page.target, expression, timeoutMs);
    return { supported: true, label, port: page.port, ...(result || { clicked: false, matched: 0 }) };
  } catch (error) {
    return { supported: true, label, port: page.port, clicked: false, matched: 0, error: trimText(error.message) };
  }
}

// 读取前置管理页表单字段（输入框）并写入值
export async function fillFrontPageInput({ placeholder, label, value, index = 0 }, timeoutMs = 8000) {
  const page = await getFrontPageTarget(timeoutMs);
  if (!page.supported) return page;
  const expression = `(function(){
    const wantedValue = ${JSON.stringify(value)};
    const norm = (v) => String(v || '').replace(/\\s+/g, '').trim();
    const inputs = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')];
    // 按 placeholder 或 aria-label 或关联 label 匹配；无匹配时按 index 兜底
    const wantedPh = ${JSON.stringify(placeholder)};
    const wantedLb = ${JSON.stringify(label)};
    let target = inputs.find((el) => norm(el.placeholder) === wantedPh || norm(el.getAttribute('aria-label')) === wantedLb || norm(el.title) === wantedLb) || inputs[${index}] || null;
    if (!target) return { filled: false, matched: 0 };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(target, wantedValue); else target.value = wantedValue;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, matched: 1, value: target.value };
  })()`;
  try {
    const result = await evaluateOn(page.target, expression, timeoutMs);
    return { supported: true, ...(result || { filled: false, matched: 0 }) };
  } catch (error) {
    return { supported: false, reason: trimText(error.message) };
  }
}

// 读取前置管理页当前可见文本（用于识别创建表单状态）
export async function readFrontPageText(timeoutMs = 8000) {
  const page = await getFrontPageTarget(timeoutMs);
  if (!page.supported) return page;
  const expr = `(function(){
    const txt = document.body ? document.body.innerText : '';
    const inputs = [...document.querySelectorAll('input,textarea')].map((el) => ({
      placeholder: el.placeholder || '', value: el.value || '', type: el.type || 'text'
    }));
    const buttons = [...document.querySelectorAll('button,[role="button"],[class*="btn"],[class*="Button"],[aria-label]')]
      .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 30);
    return JSON.stringify({ body: (txt || '').slice(0, 3000), inputs, buttons });
  })()`;
  try {
    const raw = await evaluateOn(page.target, expr, timeoutMs);
    try { return { supported: true, ...JSON.parse(raw) }; } catch { return { supported: true, body: String(raw || ""), inputs: [], buttons: [] }; }
  } catch (error) {
    return { supported: false, reason: trimText(error.message) };
  }
}

// 等待目标出现（轮询 DOM 直到命中文本/控件，用于表单加载、创建完成判定）
export async function waitForFrontPageText(matchText, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastBody = "";
  while (Date.now() < deadline) {
    const page = await getFrontPageTarget(5000);
    if (!page.supported) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const expr = `(function(){
      const txt = document.body ? document.body.innerText : '';
      const inputs = [...document.querySelectorAll('input,textarea')].map((el) => ({ placeholder: el.placeholder || '', value: el.value || '' }));
      const buttons = [...document.querySelectorAll('button,[role="button"],[class*="btn"],[class*="Button"]')]
        .map((el) => (el.innerText || el.getAttribute('aria-label') || '').trim()).filter(Boolean);
      return JSON.stringify({ body: (txt || '').slice(0, 3000), inputs, buttons });
    })()`;
    let state;
    try {
      const raw = await evaluateOn(page.target, expr, 5000);
      state = JSON.parse(raw || "{}");
    } catch { state = { body: "" }; }
    lastBody = state.body || "";
    if (lastBody.includes(matchText)) {
      return { supported: true, matched: true, body: lastBody, inputs: state.inputs || [], buttons: state.buttons || [] };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { supported: true, matched: false, body: lastBody, reason: `等待「${matchText}」超时 ${timeoutMs}ms` };
}

// 点击表单中的选项文本（下拉项/单选/radio，语义控件）
export async function clickFrontPageOption(label, { exact = false } = {}, timeoutMs = 8000) {
  const page = await getFrontPageTarget(timeoutMs);
  if (!page.supported) return page;
  const expression = `(function(){
    const wanted = ${JSON.stringify(label)};
    const norm = (v) => String(v || '').replace(/\\s+/g, '').trim();
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="radio"],[role="option"],[class*="option"],[class*="Option"],[class*="select"],[class*="Select"],[class*="radio"],[class*="Radio"],[class*="item"],[class*="Item"],li,div,span')];
    const exactMatch = nodes.filter((node) => norm(node.innerText || node.getAttribute('aria-label') || node.title) === wanted);
    const candidates = exactMatch.length ? exactMatch : (${exact} ? [] : nodes.filter((node) => {
      const t = norm(node.innerText || node.getAttribute('aria-label') || node.title);
      return t === wanted || (t.includes(wanted) && t.length <= wanted.length + 10);
    }));
    if (!candidates.length) return { clicked: false, matched: 0, label: wanted };
    // 点击最具体的（文本最短的）候选，避免点中容器
    candidates.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
    candidates[0].click();
    return { clicked: true, matched: candidates.length, label: wanted };
  })()`;
  try {
    const result = await evaluateOn(page.target, expression, timeoutMs);
    return { supported: true, label, ...(result || { clicked: false, matched: 0 }) };
  } catch (error) {
    return { supported: true, label, clicked: false, matched: 0, error: trimText(error.message) };
  }
}

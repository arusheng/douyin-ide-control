import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PROJECT_ROOT, redact, trimText } from "./path-policy.mjs";
import { killTree } from "./proc.mjs";

// IDE 启动就绪探测：窗口/进程检测与 CDP 检测的依赖，仅用于轮询就绪状态
let readinessProbes = null;
// CLI 调用替身（测试注入用），默认走真实 tma open
let cliRunner = null;

let cliPathPromise;

export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function file(pathname) {
  return pathname && fs.existsSync(pathname) && fs.statSync(pathname).isFile();
}

function fromShim(shim) {
  const base = path.dirname(shim);
  const candidate = path.join(base, "node_modules", "tt-ide-cli", "bin", "tma.js");
  return file(candidate) ? candidate : null;
}

function pathCandidates() {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return entries.flatMap((entry) => [
    path.join(entry, "tma.cmd"),
    path.join(entry, "tma.ps1"),
    path.join(entry, "tma.exe"),
  ]);
}

export async function resolveTmaCli() {
  if (!cliPathPromise) cliPathPromise = Promise.resolve().then(() => {
    const explicit = process.env.DOUYIN_TMA_CLI_JS;
    if (file(explicit)) return explicit;
    for (const candidate of pathCandidates()) {
      const resolved = fromShim(candidate);
      if (resolved) return resolved;
    }
    throw new CliError("CLI_NOT_FOUND", "未找到官方 tt-ide-cli/tma。", {
      hint: "请先执行 npm install -g tt-ide-cli，或设置 DOUYIN_TMA_CLI_JS 指向 tma.js",
    });
  });
  return cliPathPromise;
}

// 构造 MCP 启动 tma 及其后代进程使用的子进程环境：
// 复制 process.env（不修改任何全局/用户/系统环境变量，也不改动 process.env 本身），
// 仅删除会强制 Electron 应用以 Node 模式运行的 ELECTRON_RUN_AS_NODE，
// 其余变量原样保留，并维持 FORCE_COLOR=0。
export function cleanTmaEnv() {
  const env = { ...process.env, FORCE_COLOR: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runProcess(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || cleanTmaEnv(),
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, stdout: trimText(stdout.join("")), stderr: trimText(stderr.join("")) });
    };
    const timer = setTimeout(() => {
      killTree(child.pid).finally(() => finish({ exitCode: null, timedOut: true }));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ exitCode: null, timedOut: false, error: redact(error.message) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      finish({ exitCode, timedOut: false });
    });
  });
}

export async function runTma(args, { cwd = PROJECT_ROOT, timeoutMs = 30000, env } = {}) {
  const cli = await resolveTmaCli();
  return runProcess(process.execPath, [cli, ...args], { cwd, timeoutMs, env });
}

export function commandFailure(result, command) {
  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  const explicitError = /(Project Error:|\bError:|ENOENT|not valid|failed|失败|未登录|Not logged in)/i.test(combinedOutput);
  if (!result.timedOut && result.exitCode === 0 && !explicitError) return result;
  const code = result.timedOut ? "CLI_TIMEOUT" : "CLI_COMMAND_FAILED";
  throw new CliError(code, `官方 CLI 命令失败: ${command}`, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    processError: result.error || undefined,
  });
}

export async function inspectCli() {
  const cli = await resolveTmaCli();
  const version = await runTma(["--version"], { timeoutMs: 10000 });
  const session = await runTma(["check-session"], { timeoutMs: 10000 });
  const sessionOutput = session.stdout || session.stderr;
  return {
    path: cli,
    version: version.stdout || version.stderr,
    session: {
      loggedIn: session.exitCode === 0 && !/(not logged in|未登录|no cookie|没有 Cookie)/i.test(sessionOutput),
      output: sessionOutput,
    },
  };
}

export async function openProject(projectPath, timeoutMs) {
  const result = await runTma(["open", projectPath], { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, `open ${projectPath}`);
}

// 可注入的就绪探测函数（测试替身用），返回 { window, cdp, process 三态 }
export function setReadinessProbes(probes) {
  readinessProbes = probes;
}

// 可注入的 CLI 调用替身（测试用），返回 openProject 的同等结果
export function setCliRunner(runner) {
  cliRunner = runner;
}

function defaultProbes() {
  return {
    window: async () => { throw new Error("native window probe unavailable"); },
    cdp: async () => { throw new Error("cdp probe unavailable"); },
    process: async () => ({ running: false }),
  };
}

function readinessProbe() {
  return readinessProbes || defaultProbes();
}

// 打开前的工程类型初步探测（只用于路由 CLI 协议与默认身份校验，不作为身份权威证据）。
// 依据：project.config.json 的 appid/miniprogramRoot/minigameRoot/projectname
//       + 顶层文件 game.js/game.json（小游戏）vs app.js/app.json/pages（小程序）。
// 文件结构在这里允许当线索，因为路由错了会直接白屏；真正的类型仍由身份识别复核。
export function probeProjectType(projectPath) {
  const result = { hint: null, appid: null, config: null, evidence: [] };
  const cfgPath = path.join(projectPath, "project.config.json");
  let cfg = null;
  try {
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      result.appid = cfg.appid || null;
      if (cfg.projectname) result.evidence.push(`project.config:projectname=${cfg.projectname}`);
      if (cfg.minigameRoot) result.evidence.push("project.config:minigameRoot");
      if (cfg.miniprogramRoot) result.evidence.push("project.config:miniprogramRoot");
    }
  } catch { /* 解析失败不阻断 */ }
  result.config = cfg;
  let entries = [];
  try { entries = fs.readdirSync(projectPath); } catch { /* 目录不存在 */ }
  const hasGame = entries.includes("game.js") || entries.includes("game.json");
  const hasApp = entries.includes("app.js") || entries.includes("app.json") || entries.includes("pages");
  if (cfg?.minigameRoot) result.hint = "minigame";
  else if (cfg?.miniprogramRoot) result.hint = "miniapp";
  else if (hasGame && !hasApp) result.hint = "minigame";
  else if (hasApp && !hasGame) result.hint = "miniapp";
  if (hasGame) result.evidence.push("structure:game");
  if (hasApp) result.evidence.push("structure:app");
  return result;
}

// 打开路由：显式 expectedProjectType 优先；未指定时用结构探测 hint；
// 探测不到时默认 tma（保持与旧行为兼容）。返回 { cli, hint, appid, evidence, explicit }。
export function resolveOpenRouting(expectedProjectType, projectPath) {
  const probe = projectPath ? probeProjectType(projectPath) : null;
  let cli;
  if (expectedProjectType === "minigame") cli = "tmg";
  else if (expectedProjectType === "miniapp") cli = "tma";
  else cli = probe?.hint === "minigame" ? "tmg" : "tma";
  return {
    cli,
    hint: probe?.hint || null,
    appid: probe?.appid || null,
    evidence: probe?.evidence || [],
    explicit: Boolean(expectedProjectType),
  };
}

// 根据期望工程类型选择打开 CLI：小游戏必须用 tmg（microgame 协议），
// 小程序/缺省走 tma（microapp 协议）。tma open 硬编码 type=microapp，
// 会把小游戏工程按小程序协议打开（找 app.json 报 ENOENT），这是类型误判根因。
// projectPath 可选：未显式指定类型时用它做结构探测路由（小游戏目录→tmg）。
export function openCliFor(expectedProjectType, projectPath) {
  return resolveOpenRouting(expectedProjectType, projectPath).cli;
}

// 轮询等待 IDE 就绪：窗口可见或 CDP 可连任一满足即视为就绪。
// 仅有 IDE 进程存活不算就绪（进程状态只作为诊断信息），
// CLI 报成功但 IDE 未就绪时抛结构化 IDE_STARTUP_TIMEOUT，绝不误报成功。
// runner 参数用于按工程类型注入打开函数（如 tmg open），缺省用 tma open。
export async function openProjectWithReadiness(projectPath, { cliTimeoutMs = 30000, pollTotalMs = 60000, pollIntervalMs = 2000, runner } = {}) {
  const command = runner
    ? await runner(projectPath, cliTimeoutMs)
    : cliRunner
      ? await cliRunner(projectPath, cliTimeoutMs)
      : await openProject(projectPath, cliTimeoutMs);
  const probes = readinessProbe();
  const attempts = [];
  const deadline = Date.now() + pollTotalMs;
  let ready = false;
  let lastState = null;

  while (Date.now() < deadline) {
    const windowState = await probes.window().then(
      (value) => ({ ok: true, ...value }),
      (error) => ({ ok: false, reason: redact(error.message) }),
    );
    const cdpState = await probes.cdp().then(
      (value) => ({ ok: true, ...value }),
      (error) => ({ ok: false, reason: redact(error.message) }),
    );
    const processState = await probes.process().then(
      (value) => ({ ok: true, ...value }),
      (error) => ({ ok: false, reason: redact(error.message) }),
    );
    lastState = { window: windowState, cdp: cdpState, process: processState };
    attempts.push(lastState);
    // IDE 就绪判定：窗口可见 或 CDP 可连；进程存活仅作诊断，不算就绪
    // 窗口探测返回 supported 字段；CDP 探测返回 port/workbench 等字段（未显式标记 supported 即视为可用）
    const windowReady = Boolean(windowState.ok && windowState.supported);
    const cdpReady = Boolean(cdpState.ok && cdpState.supported !== false && (cdpState.port || cdpState.targets));
    ready = windowReady || cdpReady;
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (!ready) {
    const error = new Error("CLI 报告打开成功，但 IDE 未在预期时间内就绪");
    error.code = "IDE_STARTUP_TIMEOUT";
    error.details = {
      cli: { exitCode: command.exitCode, timedOut: Boolean(command.timedOut), stdout: command.stdout, stderr: command.stderr },
      attempts: attempts.slice(-5),
      pollTotalMs,
    };
    throw error;
  }

  return { command, ready, lastState, attempts: attempts.slice(-3) };
}

export async function previewProject(projectPath, outputPath, { timeoutMs = 90000, small, copy, query, scene, launchFrom } = {}) {
  const args = ["preview"];
  if (outputPath) args.push("--qrcode-output", outputPath);
  if (small) args.push("--small");
  if (copy) args.push("--copy");
  if (query) args.push("--miniapp-query", query);
  if (scene) args.push("--miniapp-scene", String(scene));
  if (launchFrom) args.push("--miniapp-launch-from", launchFrom);
  args.push(projectPath);
  const result = await runTma(args, { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, `preview ${projectPath}`);
}

export async function buildNpm(projectPath, timeoutMs) {
  const result = await runTma(
    ["build-npm", "--project-path", projectPath],
    { cwd: PROJECT_ROOT, timeoutMs },
  );
  return commandFailure(result, `build-npm ${projectPath}`);
}

export async function projectSize(projectPath, { json = false, timeoutMs = 30000 } = {}) {
  const args = ["project-size"];
  if (json) args.push("--json");
  args.push(projectPath);
  const result = await runTma(args, { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, `project-size ${projectPath}`);
}

export async function auditHosts(appid, timeoutMs = 30000) {
  const result = await runTma(["hosts", appid], { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, `hosts ${appid}`);
}

export async function setAppConfig(appid, token, timeoutMs = 30000) {
  const result = await runTma(["set-app-config", appid, "--token", token], { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, `set-app-config ${appid}`);
}

export async function uploadProject(projectPath, args, timeoutMs) {
  const cliArgs = ["upload", "--app-changelog", args.appChangelog];
  if (args.appVersion) cliArgs.push("--app-version", args.appVersion);
  if (args.channel) cliArgs.push("--channel", args.channel);
  cliArgs.push(projectPath);
  const result = await runTma(cliArgs, { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, "upload [已确认]");
}

export async function auditProject(appid, args, timeoutMs) {
  const cliArgs = ["audit", "--host", args.host || "douyin"];
  if (args.autoPublish !== undefined) cliArgs.push("--auto-publish", String(args.autoPublish));
  if (args.channel) cliArgs.push("--channel", args.channel);
  cliArgs.push(appid);
  const result = await runTma(cliArgs, { cwd: PROJECT_ROOT, timeoutMs });
  return commandFailure(result, "audit [已确认]");
}

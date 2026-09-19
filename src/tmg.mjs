// tmg（tt-minigame-ide-cli 2.1.1）封装
// 注意：tmg 在非包目录 cwd 下存在相对路径解析缺陷（Windows + 自定义 npm prefix），
// 必须 cwd=包目录 + node bin/tmg.js 方式调用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { redact, trimText } from "./path-policy.mjs";
import { killTree } from "./proc.mjs";

// tmg 包位置不写死：优先 DOUYIN_TMG_PACKAGE，其次 DOUYIN_NPM_GLOBAL_ROOT / npm root -g 推导。
// 绑定固定盘符会导致换机器或 npm prefix 变化后整个 tmg 链路失效。
function resolveTmgPackage() {
  if (process.env.DOUYIN_TMG_PACKAGE) return process.env.DOUYIN_TMG_PACKAGE;
  const roots = [];
  if (process.env.DOUYIN_NPM_GLOBAL_ROOT) roots.push(process.env.DOUYIN_NPM_GLOBAL_ROOT);
  try {
    const out = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8", windowsHide: true, timeout: 8000, shell: true,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const resolved = String(out || "").trim().split(/\r?\n/).filter(Boolean).pop();
    if (resolved) roots.push(resolved);
  } catch { /* npm 不可用时继续用包目录候选 */ }
  // 兜底：本包自身的 node_modules（本地安装 tt-minigame-ide-cli 的场景）
  roots.push(path.join(process.cwd(), "node_modules"));
  for (const root of roots) {
    const candidate = path.join(root, "tt-minigame-ide-cli");
    if (fs.existsSync(path.join(candidate, "bin", "tmg.js"))) return candidate;
  }
  return null;
}

const TMG_PACKAGE = resolveTmgPackage();
const TMG_BIN = TMG_PACKAGE ? path.join(TMG_PACKAGE, "bin", "tmg.js") : null;
// tmg 登录 cookie 文件：~/.tmg-cli/.cookies（tmg 2.1.1 无 check-session 命令）。
// 仅用于本机存在性判断，路径本身不对调用方回显。
const TMG_COOKIE = path.join(os.homedir(), ".tmg-cli", ".cookies");

export function tmgBinPath() {
  return TMG_BIN && fs.existsSync(TMG_BIN) ? TMG_BIN : null;
}

// 运行 tmg 命令（必须 cwd=包目录）
export function runTmg(args, { timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    if (!TMG_BIN || !TMG_PACKAGE) {
      resolve({
        exitCode: null,
        timedOut: false,
        error: "tt-minigame-ide-cli (tmg) 未找到",
        stdout: "",
        stderr: "tt-minigame-ide-cli (tmg) 未找到：请设置 DOUYIN_TMG_PACKAGE 或 DOUYIN_NPM_GLOBAL_ROOT",
      });
      return;
    }
    const childEnv = { ...process.env, FORCE_COLOR: "0" };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    if (env) Object.assign(childEnv, env);
    const child = spawn(process.execPath, [TMG_BIN, ...args], {
      cwd: TMG_PACKAGE,
      env: childEnv,
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
    }, timeoutMs);
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

export async function inspectTmg() {
  const cli = tmgBinPath();
  if (!cli) {
    return {
      installed: false,
      reason: "未找到 tt-minigame-ide-cli（tmg）",
      hint: "请设置 DOUYIN_TMG_PACKAGE 指向 tt-minigame-ide-cli 包目录，或 DOUYIN_NPM_GLOBAL_ROOT 指向 npm 全局根目录",
    };
  }
  const version = await runTmg(["--version"], { timeoutMs: 10000 });
  // tmg 2.1.1 无 check-session 命令；登录态以 cookie 文件是否存在为准。
  // 只回状态，不回显 cookie 文件路径（路径属于本机信息，对调用方无价值）。
  const cookieExists = fs.existsSync(TMG_COOKIE) && fs.statSync(TMG_COOKIE).size > 0;
  return {
    installed: true,
    version: version.stdout || version.stderr || null,
    session: {
      loggedIn: cookieExists,
      output: cookieExists ? "已登录（检测到本机 tmg cookie）" : "未登录（未检测到本机 tmg cookie）",
    },
  };
}

// tmg 命令通用"运行 + 失败判定"，返回 { ...result, ok, errorCode? }
function runTmgChecked(args, { timeoutMs = 30000, env } = {}) {
  return runTmg(args, { timeoutMs, env }).then((result) => {
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    const explicitError = /(Project Error:|\bError:|ENOENT|not valid|failed|失败|未登录|Not logged in)/i.test(combined);
    if (!result.timedOut && result.exitCode === 0 && !explicitError) return { ...result, ok: true };
    return {
      ...result,
      ok: false,
      errorCode: result.timedOut ? "CLI_TIMEOUT" : "CLI_COMMAND_FAILED",
    };
  });
}

// tmg open：用小游戏协议唤起 IDE 打开工程（区别于 tma 的小程序协议）
export async function tmgOpenProject(projectPath, { mode = "full", timeoutMs = 30000 } = {}) {
  const args = ["open", projectPath];
  if (mode) args.push("--mode", mode);
  return runTmgChecked(args, { timeoutMs });
}

// tmg preview：小游戏预览二维码（--output 而非 tma 的 --qrcode-output）
export async function tmgPreviewProject(projectPath, { output, small, copy, query, scene, launchFrom, timeoutMs = 90000 } = {}) {
  const args = ["preview"];
  if (output) args.push("--output", output);
  if (small) args.push("--small");
  if (copy) args.push("--copy");
  if (query) args.push("--minigame-query", query);
  if (scene) args.push("--minigame-scene", String(scene));
  if (launchFrom) args.push("--minigame-launch-from", launchFrom);
  args.push(projectPath);
  return runTmgChecked(args, { timeoutMs });
}

// tmg upload：小游戏上传（-v/-c/--channel）
export async function tmgUploadProject(projectPath, { appVersion, appChangelog, channel, output, small, copy, timeoutMs = 120000 } = {}) {
  const args = ["upload"];
  if (appVersion) args.push("--app-version", appVersion);
  if (appChangelog) args.push("--app-changelog", appChangelog);
  if (channel) args.push("--channel", channel);
  if (output) args.push("--output", output);
  if (small) args.push("--small");
  if (copy) args.push("--copy");
  args.push(projectPath);
  return runTmgChecked(args, { timeoutMs });
}

// tmg build-npm：小游戏 npm 构建（positional projectPath）
export async function tmgBuildNpm(projectPath, timeoutMs = 90000) {
  return runTmgChecked(["build-npm", projectPath], { timeoutMs });
}

// tmg version：查询最新已发布版本（上传/提审前核对版本号用）
export async function tmgVersionProject(projectPath, timeoutMs = 30000) {
  return runTmgChecked(["version", projectPath], { timeoutMs });
}

// 从 tmg version 输出中提取最新版本号（如 1.2.3）；取不到返回 null
export function extractLatestVersion(text) {
  const m = String(text || "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return m ? m[0] : null;
}

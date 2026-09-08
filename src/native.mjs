import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { redact } from "./path-policy.mjs";

const SCRIPT = fileURLToPath(new URL("./native-windows.ps1", import.meta.url));

// PowerShell 子进程专用环境：构造最小干净环境，隔离宿主注入的任何异常变量
// （宿主注入的超长 TEMP/其他变量会导致 Add-Type 编译临时文件失败）。
// 保留系统必要变量 + 用户 PATH/SystemRoot，其余不继承。
// 不修改任何全局/用户/系统环境变量，也不改动 process.env 本身。
function powershellEnv() {
  const keep = [
    "PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "TZ",
  ];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // 固定使用已知存在的短临时目录，确保 Add-Type 编译临时文件可写
  const temp = fs.existsSync("C:\\Users\\12138\\AppData\\Local\\Temp")
    ? "C:\\Users\\12138\\AppData\\Local\\Temp"
    : os.tmpdir();
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  return env;
}

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath(), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args,
    ], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"], env: powershellEnv() });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; callback(value); };
    const timer = setTimeout(() => { child.kill(); finish(reject, new Error("Windows 原生操作超时")); }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => { clearTimeout(timer); finish(reject, error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // PowerShell 5.1 默认以 GBK(cp936) 输出 stderr，Node 按 UTF-8 解析会乱码；
        // 统一按 GBK 解码后再脱敏，保留真实错误文本。
        const raw = Buffer.concat(stderr);
        let decoded;
        try { decoded = new TextDecoder("gbk").decode(raw); }
        catch { decoded = raw.toString("utf8"); }
        return finish(reject, new Error(redact(decoded || raw.toString("utf8") || `PowerShell exit ${code}`)));
      }
      try { finish(resolve, JSON.parse(stdout.join("").trim())); }
      catch { finish(reject, new Error("Windows 原生操作返回了无法解析的结果")); }
    });
  });
}

export function nativeScriptPath() { return fs.existsSync(SCRIPT) ? SCRIPT : null; }

export function getIdeWindowInfo(timeoutMs = 5000) {
  return runPowerShell(["-Action", "window-info"], timeoutMs);
}

export function focusIde(timeoutMs = 5000) {
  return runPowerShell(["-Action", "focus"], timeoutMs);
}

export function captureIdeWindow(outputPath, timeoutMs = 15000) {
  return runPowerShell(["-Action", "capture", "-OutputPath", outputPath], timeoutMs);
}

export function sendShortcut(shortcut, timeoutMs = 5000) {
  return runPowerShell(["-Action", "shortcut", "-Shortcut", shortcut], timeoutMs);
}

export function getUiaInfo(timeoutMs = 5000) {
  return runPowerShell(["-Action", "uia-info"], timeoutMs);
}

export function invokeUiaControl(controlName, timeoutMs = 5000) {
  return runPowerShell(["-Action", "uia-invoke", "-ControlName", controlName], timeoutMs);
}

import { execFile, spawn } from "node:child_process";
import path from "node:path";

// 进程/端口发现工具。
// 用 PowerShell Get-CimInstance 替代已被弃用的 wmic（Windows 11 起移除），
// netstat 解析保留（Windows 10/11 均可用）。

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// 返回抖音开发者工具.exe 进程的 PID 列表（按可执行路径匹配，避免中文进程名编码差异误判）
export function getIdeProcessIds(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const script = "Get-CimInstance Win32_Process -Filter \"ExecutablePath LIKE '%@bytedminiprogram-ide%'\" | ForEach-Object { $_.ProcessId }";
    const child = spawn(powershellPath(), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const stdout = [];
    const timer = setTimeout(() => { child.kill(); resolve([]); }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.on("error", () => { clearTimeout(timer); resolve([]); });
    child.on("close", () => {
      clearTimeout(timer);
      const pids = stdout.join("").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .map(Number).filter((n) => Number.isInteger(n) && n > 0);
      resolve([...new Set(pids)]);
    });
  });
}

// 解析 netstat -ano 输出中的本地监听行 → [{ port, pid }]
export function parseTcpListeners(stdout) {
  const result = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) result.push({ port: Number(m[1]), pid: m[2] });
  }
  return result;
}

// 列出本机 127.0.0.1 上处于 LISTENING 的 TCP 端口与 PID
export function listTcpListeners(timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parseTcpListeners(stdout));
    });
  });
}

// IDE 进程监听的本地端口集合（升序，供 CDP 动态发现）
export async function listIdeListeningPorts(timeoutMs = 5000) {
  const pids = await getIdeProcessIds(timeoutMs);
  if (!pids.length) return [];
  const pidSet = new Set(pids.map(String));
  const listeners = await listTcpListeners(timeoutMs);
  return [...new Set(listeners.filter((l) => pidSet.has(l.pid)).map((l) => l.port))].sort((a, b) => a - b);
}

// 强制结束进程树（含后代进程），避免 CLI 超时后遗留 IDE 等子进程（child.kill 只杀父进程）
export function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

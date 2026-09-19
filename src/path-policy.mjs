import fs from "node:fs";
import path from "node:path";

// 工作区必须由宿主显式配置（DOUYIN_WORKSPACE_ROOT）。
//
// 为什么不再回退到 process.cwd()：MCP 服务器由宿主拉起，cwd 往往是插件安装目录，
// 静默采用它会让"工作区"变成插件目录，真实项目随即被白名单拒绝——失败信息还会误导用户。
// 因此未配置时显式标记未配置，由调用方返回结构化的 WORKSPACE_NOT_CONFIGURED。
const CONFIGURED_ROOT = process.env.DOUYIN_WORKSPACE_ROOT;
export const WORKSPACE_CONFIGURED = Boolean(CONFIGURED_ROOT && String(CONFIGURED_ROOT).trim());
// WORKSPACE_ROOT 在未配置时仅在内存里作为占位，任何路径校验都会先被 WORKSPACE_CONFIGURED 拦下。
export const WORKSPACE_ROOT = path.resolve(
  WORKSPACE_CONFIGURED ? String(CONFIGURED_ROOT).trim() : process.cwd(),
);
export const PROJECT_ROOT = path.join(WORKSPACE_ROOT, "project");

// 未配置工作区时统一的错误。调用方（server 层）把它转成顶层失败，而不是继续用插件目录。
export function workspaceNotConfigured() {
  const error = new Error("未配置工作区：请设置环境变量 DOUYIN_WORKSPACE_ROOT 指向你的项目根目录");
  error.code = "WORKSPACE_NOT_CONFIGURED";
  error.details = {
    hint: "在宿主的 MCP 配置里为该服务器设置 DOUYIN_WORKSPACE_ROOT（例如 codex mcp 的 env，或插件/宿主的环境变量）",
    configured: false,
  };
  return error;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathError(message) {
  const error = new Error(message);
  error.code = "PATH_NOT_ALLOWED";
  return error;
}

function entryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (!entryExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function realpath(candidate) {
  const resolver = fs.realpathSync.native || fs.realpathSync;
  return path.resolve(resolver(candidate));
}

function workspaceRealRoot() {
  return entryExists(WORKSPACE_ROOT) ? realpath(WORKSPACE_ROOT) : WORKSPACE_ROOT;
}

function assertResolvedInside(candidate) {
  const root = workspaceRealRoot();
  const ancestor = nearestExistingAncestor(candidate);
  let realAncestor;
  try {
    realAncestor = realpath(ancestor);
  } catch (error) {
    throw pathError(`Unable to resolve output ancestor: ${ancestor}`);
  }
  if (!inside(root, realAncestor)) {
    throw pathError(`Output ancestor resolves outside workspace: ${ancestor}`);
  }

  if (entryExists(candidate)) {
    let realTarget;
    try {
      realTarget = realpath(candidate);
    } catch (error) {
      throw pathError(`Unable to resolve output target: ${candidate}`);
    }
    if (!inside(root, realTarget)) {
      throw pathError(`Output target resolves outside workspace: ${candidate}`);
    }
  }
}

export function allowedPath(input, fallback = PROJECT_ROOT) {
  // 未配置工作区时直接失败：否则会把插件 cwd 当成工作区，真实项目被误判为越界。
  if (!WORKSPACE_CONFIGURED) throw workspaceNotConfigured();
  const candidate = path.resolve(input || fallback);
  if (!inside(WORKSPACE_ROOT, candidate)) {
    throw pathError(`Path is outside allowed workspace: ${candidate}`);
  }
  return candidate;
}

export function ensureOutputPath(input, fallback) {
  const output = allowedPath(input, fallback);
  assertResolvedInside(output);
  return output;
}

export function redact(value) {
  return String(value ?? "")
    .replace(/([?&](?:token|access_token|refresh_token|password|cookie|authorization|api[_-]?key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|cookie|authorization|api[_-]?key)\s*[=:]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
}

export function trimText(value, limit = 8000) {
  const text = redact(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function errorObject(code, message, details = {}) {
  return { code, message: redact(message), details };
}

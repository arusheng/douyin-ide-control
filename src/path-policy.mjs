import fs from "node:fs";
import path from "node:path";

// 未显式配置时只允许访问当前进程工作目录，避免依赖任何机器的固定路径。
const DEFAULT_WORKSPACE_ROOT = process.cwd();

export const WORKSPACE_ROOT = path.resolve(
  process.env.DOUYIN_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT,
);
export const PROJECT_ROOT = path.join(WORKSPACE_ROOT, "project");

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

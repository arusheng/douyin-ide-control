import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 测试工作区：系统临时目录下的独立目录，测试前创建、测试后清理。
// 关键：ESM 的 import 会被提升，因此必须在**动态导入** cli.mjs 之前设置环境变量，
// 否则 path-policy.mjs 中的 WORKSPACE_ROOT 会按旧值冻结。
const FIXTURE_WORKSPACE = path.join(os.tmpdir(), `douyin-ide-control-cwd-test-${process.pid}`);
fs.rmSync(FIXTURE_WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_WORKSPACE, { recursive: true });
process.env.DOUYIN_WORKSPACE_ROOT = FIXTURE_WORKSPACE;

const { resolveCwd, CliError } = await import("../src/cli.mjs");
const { WORKSPACE_ROOT } = await import("../src/path-policy.mjs");

test("resolveCwd：项目直接位于工作区根目录时返回 projectPath（不拼接子目录）", () => {
  // 模拟"项目本身就是工作区根目录"的布局（项目根即 DOUYIN_WORKSPACE_ROOT）：
  // projectPath === WORKSPACE_ROOT，不应再去找 WORKSPACE_ROOT/project 子目录。
  const result = resolveCwd({ projectPath: FIXTURE_WORKSPACE });
  assert.equal(result, FIXTURE_WORKSPACE, "项目在工作区根目录时应直接返回该目录");
  assert.equal(result, WORKSPACE_ROOT, "返回值应与 WORKSPACE_ROOT 一致");
});

test("resolveCwd：项目位于工作区子目录时返回 projectPath", () => {
  const subProject = path.join(FIXTURE_WORKSPACE, "sub-project");
  fs.mkdirSync(subProject, { recursive: true });
  try {
    const result = resolveCwd({ projectPath: subProject });
    assert.equal(result, subProject, "应返回项目子目录而非工作区根目录");
  } finally {
    fs.rmSync(subProject, { recursive: true, force: true });
  }
});

test("resolveCwd：未传 projectPath 和 cwd 时回退到 WORKSPACE_ROOT", () => {
  const result = resolveCwd({});
  assert.equal(result, FIXTURE_WORKSPACE, "无项目路径时应使用配置的工作区根目录");
});

test("resolveCwd：projectPath 不存在但 cwd 存在时返回 cwd", () => {
  const nonexistent = path.join(FIXTURE_WORKSPACE, "does-not-exist");
  const explicitCwd = path.join(FIXTURE_WORKSPACE, "explicit-cwd");
  fs.mkdirSync(explicitCwd, { recursive: true });
  try {
    const result = resolveCwd({ projectPath: nonexistent, cwd: explicitCwd });
    assert.equal(result, explicitCwd, "projectPath 不存在时应回退到显式 cwd");
  } finally {
    fs.rmSync(explicitCwd, { recursive: true, force: true });
  }
});

test("resolveCwd：projectPath 和 cwd 均不存在时回退到 WORKSPACE_ROOT", () => {
  const nonexistent = path.join(FIXTURE_WORKSPACE, "nope");
  const result = resolveCwd({ projectPath: nonexistent, cwd: nonexistent });
  assert.equal(result, FIXTURE_WORKSPACE, "projectPath 和 cwd 均不存在时应回退到工作区根目录");
});

test("resolveCwd：工作区不存在时抛出 CLI_CWD_NOT_FOUND，不静默换到 process.cwd()", () => {
  // 用子进程验证：设置 DOUYIN_WORKSPACE_ROOT 为不存在的路径，
  // 动态导入 cli.mjs 后调用 resolveCwd，必须抛出结构化错误。
  // 不能在当前进程内测试，因为 WORKSPACE_ROOT 已在导入时冻结为有效目录。
  const missingWorkspace = path.join(os.tmpdir(), `douyin-cwd-missing-${process.pid}-${Date.now()}`);
  fs.rmSync(missingWorkspace, { recursive: true, force: true });
  assert.equal(fs.existsSync(missingWorkspace), false, "前置条件：工作区目录必须不存在");

  const cliUrl = pathToFileURL(path.join(root, "src", "cli.mjs")).href;
  const script = `
    import { resolveCwd } from ${JSON.stringify(cliUrl)};
    try {
      resolveCwd({ projectPath: ${JSON.stringify(missingWorkspace)} });
      console.log("NO_THROW");
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message, details: error.details }));
    }
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DOUYIN_WORKSPACE_ROOT: missingWorkspace },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  }).trim();

  assert.notEqual(output, "NO_THROW", "工作区不存在时必须抛出错误，不能静默成功");
  const parsed = JSON.parse(output);
  assert.equal(parsed.code, "CLI_CWD_NOT_FOUND", `错误码应为 CLI_CWD_NOT_FOUND，实际 ${parsed.code}`);
  assert.match(parsed.message, /工作目录|工作区/, "错误信息应提及工作目录或工作区");
  assert.equal(parsed.details.workspaceRoot, missingWorkspace, "详情应包含配置的工作区路径");
  assert.equal(parsed.details.workspaceExists, false, "详情应标记工作区不存在");
  assert.equal(parsed.details.projectPath, missingWorkspace, "详情应包含传入的 projectPath");
});

test("resolveCwd：所有候选均不存在时抛出 CLI_CWD_NOT_FOUND 且不含 process.cwd() 回退", () => {
  // 同样用子进程：工作区不存在，projectPath 和 cwd 也不存在，
  // 验证不会静默回退到 process.cwd()。
  const missingWorkspace = path.join(os.tmpdir(), `douyin-cwd-all-missing-${process.pid}-${Date.now()}`);
  fs.rmSync(missingWorkspace, { recursive: true, force: true });

  const cliUrl2 = pathToFileURL(path.join(root, "src", "cli.mjs")).href;
  const script = `
    import { resolveCwd } from ${JSON.stringify(cliUrl2)};
    const missingProject = ${JSON.stringify(path.join(missingWorkspace, "sub"))};
    try {
      const result = resolveCwd({ projectPath: missingProject, cwd: missingProject });
      console.log("RESULT:" + result);
    } catch (error) {
      console.log("CODE:" + error.code);
    }
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, DOUYIN_WORKSPACE_ROOT: missingWorkspace },
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  }).trim();

  assert.match(output, /^CODE:CLI_CWD_NOT_FOUND$/, `应抛出 CLI_CWD_NOT_FOUND，实际输出: ${output}`);
  assert.doesNotMatch(output, /^RESULT:/, "不应返回任何 cwd（不能静默回退到 process.cwd()）");
});

test("清理测试工作区", () => {
  fs.rmSync(FIXTURE_WORKSPACE, { recursive: true, force: true });
  assert.ok(true);
});

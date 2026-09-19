import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  auditHosts, auditProject, buildNpm, inspectCli, openProjectWithReadiness,
  previewProject, projectSize, resolveOpenRouting, setAppConfig, setReadinessProbes, uploadProject,
} from "./cli.mjs";
import { captureSimulator, clickWorkbenchText, getIdeStatus, previewInIde, readConsoleErrors, uploadInIde } from "./cdp.mjs";
import {
  captureIdeWindow, focusIde, getIdeWindowInfo, getUiaInfo, invokeUiaControl, sendShortcut,
} from "./native.mjs";
import {
  inspectTmg, tmgBuildNpm, tmgOpenProject, tmgPreviewProject, tmgUploadProject, tmgVersionProject, extractLatestVersion,
} from "./tmg.mjs";
import {
  clickFrontPageText, clickFrontPageOption, fillFrontPageInput, readFrontPageText,
  waitForFrontPageText, resolveProjectIdentity,
} from "./identity.mjs";
import {
  WORKSPACE_ROOT, allowedPath, ensureOutputPath, errorObject, trimText,
} from "./path-policy.mjs";
import { getIdeProcessIds } from "./proc.mjs";

const VERSION = "0.1.0";
const server = new McpServer({ name: "douyin-ide-control", version: VERSION });

// IDE 进程存活探测：按可执行路径匹配（PowerShell Get-CimInstance，不依赖 wmic）
async function probeIdeProcess() {
  try {
    const pids = await getIdeProcessIds(5000);
    return { running: pids.length > 0, image: pids.length ? "抖音开发者工具.exe" : null, pids };
  } catch (error) {
    return { running: false, reason: trimText(error.message) };
  }
}

// 注入真实就绪探测：窗口/进程检测 + CDP 调试接口
setReadinessProbes({
  window: () => getIdeWindowInfo(5000).then((value) => ({ supported: true, ...value }), (error) => {
    const unavailable = new Error(trimText(error.message));
    unavailable.code = error?.code || "WINDOW_PROBE_UNAVAILABLE";
    throw unavailable;
  }),
  cdp: () => getIdeStatus(3000),
  process: probeIdeProcess,
});

function log(action, message) {
  process.stderr.write(`[douyin-ide-control] ${action}: ${trimText(message, 1000)}\n`);
}

function result(action, data, elapsedMs, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: JSON.stringify({ ok: !isError, action, elapsedMs, data }) }],
  };
}

function failure(action, error, elapsedMs) {
  const message = String(error?.message || error);
  const code = error?.code || (message.includes("路径") ? "PATH_NOT_ALLOWED" : "UNEXPECTED_ERROR");
  const details = error?.details || {};
  log(action, `${code}: ${message}`);
  return result(action, { error: errorObject(code, message, details) }, elapsedMs, true);
}

async function run(action, callback) {
  const started = performance.now();
  try {
    const data = await callback();
    const elapsedMs = Math.round(performance.now() - started);
    log(action, `完成 ${elapsedMs}ms`);
    return result(action, data, elapsedMs);
  } catch (error) {
    return failure(action, error, Math.round(performance.now() - started));
  }
}

function timeout(args, fallback = 30000) {
  return Math.max(1000, Math.min(120000, Number(args?.timeoutMs) || fallback));
}

function projectInfo(projectPath) {
  const exists = fs.existsSync(projectPath);
  const names = exists ? fs.readdirSync(projectPath, { withFileTypes: true }).map((entry) => entry.name) : [];
  return {
    path: projectPath,
    exists,
    isDirectory: exists && fs.statSync(projectPath).isDirectory(),
    entries: names.slice(0, 100),
    hasProjectConfig: fs.existsSync(path.join(projectPath, "project.config.json")),
  };
}

function outputFile(pathname) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  return pathname;
}

function commandData(command) {
  return {
    exitCode: command.exitCode,
    timedOut: Boolean(command.timedOut),
    stdout: command.stdout,
    stderr: command.stderr,
  };
}

function confirmationError(action) {
  const error = new Error(`${action} 默认禁用，必须传入 confirm=true 才会执行`);
  error.code = "CONFIRMATION_REQUIRED";
  error.details = { dangerous: true, action, sideEffect: "远程上传或提审" };
  return error;
}

server.registerTool("douyin_check_environment", {
  title: "检查抖音 IDE 环境",
  description: "检查官方 tt-ide-cli、抖音开发者工具、当前项目和本地调试接口状态，不读取源码内容。",
  inputSchema: { projectPath: z.string().optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_check_environment", async () => {
  const projectPath = allowedPath(args?.projectPath);
  const [cli, ideWindow, cdp, uia] = await Promise.all([
    inspectCli(),
    getIdeWindowInfo(timeout(args, 5000)).catch((error) => ({ supported: false, reason: trimText(error.message) })),
    getIdeStatus(timeout(args, 5000), projectPath).catch((error) => ({ supported: false, reason: trimText(error.message) })),
    getUiaInfo(timeout(args, 5000)).catch((error) => ({ supported: false, reason: trimText(error.message) })),
  ]);
  return { workspaceRoot: WORKSPACE_ROOT, project: projectInfo(projectPath), cli, ideWindow, cdp, uia };
}));

server.registerTool("douyin_open_project", {
  title: "打开抖音项目",
  description: "按期望类型打开白名单内项目：expectedProjectType=minigame 时使用官方小游戏 CLI tmg（microgame 协议）唤起 IDE，其余使用 tma（microapp 协议）；轮询等待 IDE 窗口/CDP 就绪后执行身份检查（可选 expectedAppid/expectedProjectType）。CLI 成功但 IDE 未就绪时返回 IDE_STARTUP_TIMEOUT；权限/类型/AppID 不符时返回对应结构化顶层错误（ok:false/isError:true），不误报成功。",
  inputSchema: {
    projectPath: z.string().optional(),
    expectedAppid: z.string().optional(),
    expectedProjectType: z.enum(["minigame", "miniapp"]).optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_open_project", async () => {
  const projectPath = allowedPath(args?.projectPath);
  if (!fs.existsSync(projectPath)) throw new Error(`项目目录不存在: ${projectPath}`);
  // 关键：小游戏工程必须走 tmg（microgame 协议）；tma 固定 microapp 协议会把
  // 小游戏按小程序打开（找 app.json 报 ENOENT、模拟器白屏），这是类型误判根因。
  // 未显式指定类型时用结构探测路由（小游戏目录→tmg），避免默认按小程序打开。
  const routing = resolveOpenRouting(args?.expectedProjectType, projectPath);
  const useTmg = routing.cli === "tmg";
  // 未传 expectedAppid 时用 project.config.json 里的 appid 做身份校验（get-meta 权威元数据）。
  const effectiveAppid = args?.expectedAppid || routing.appid;
  const runner = useTmg
    ? async (projectPath, cliTimeoutMs) => {
        const command = await tmgOpenProject(projectPath, { mode: "full", timeoutMs: cliTimeoutMs });
        if (!command.ok) {
          const error = new Error(`tmg open 失败: ${command.errorCode}`);
          error.code = command.errorCode;
          error.details = { exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr, timedOut: Boolean(command.timedOut) };
          throw error;
        }
        return command;
      }
    : undefined;
  const result = await openProjectWithReadiness(projectPath, {
    cliTimeoutMs: timeout(args, 30000),
    pollTotalMs: Math.min(timeout(args, 60000), 120000),
    pollIntervalMs: 2000,
    runner,
  });
  // 身份检查：错误必须成为顶层失败（IdentityError 冒泡到 run() 的 catch）
  const identityResult = await resolveProjectIdentity(projectPath, {
    expectedAppid: effectiveAppid,
    expectedProjectType: args?.expectedProjectType,
    timeoutMs: timeout(args, 15000),
  });
  return {
    project: projectPath,
    source: useTmg ? "tt-minigame-ide-cli (tmg)" : "tt-ide-cli",
    routing: { cli: routing.cli, hint: routing.hint, appid: routing.appid, evidence: routing.evidence, explicit: routing.explicit },
    command: commandData(result.command),
    ideReady: result.ready,
    ide: {
      window: result.lastState.window,
      cdp: result.lastState.cdp,
      process: result.lastState.process,
    },
    probes: result.attempts,
    identity: identityResult.identity,
  };
}));

server.registerTool("douyin_tmg_check", {
  title: "检查小游戏 CLI（tmg）",
  description: "检查官方小游戏专用 CLI tt-minigame-ide-cli（tmg 2.x）是否安装、版本与登录状态。tmg 使用小游戏协议唤起 IDE（区别于 tma 的小程序协议）。",
  inputSchema: { timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_tmg_check", async () => inspectTmg()));

server.registerTool("douyin_tmg_open", {
  title: "用小游戏协议打开抖音小游戏工程",
  description: "通过官方小游戏 CLI tmg open 以完整模式打开白名单内工程（IDE 按小游戏类型处理，区别于 tma 的小程序协议）。返回 CLI 输出与 IDE 窗口状态。",
  inputSchema: {
    projectPath: z.string().optional(),
    mode: z.enum(["full", "lite"]).optional(),
    expectedAppid: z.string().optional(),
    expectedProjectType: z.enum(["minigame", "miniapp"]).optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_tmg_open", async () => {
  const projectPath = allowedPath(args?.projectPath);
  if (!fs.existsSync(projectPath)) throw new Error(`项目目录不存在: ${projectPath}`);
  const command = await tmgOpenProject(projectPath, {
    mode: args?.mode || "full",
    timeoutMs: timeout(args, 30000),
  });
  if (!command.ok) {
    const error = new Error(`tmg open 失败: ${command.errorCode}`);
    error.code = command.errorCode;
    error.details = { exitCode: command.exitCode, stdout: command.stdout, stderr: command.stderr, timedOut: Boolean(command.timedOut) };
    throw error;
  }
  return {
    project: projectPath,
    source: "tt-minigame-ide-cli (tmg)",
    mode: args?.mode || "full",
    command: { exitCode: command.exitCode, timedOut: Boolean(command.timedOut), stdout: command.stdout, stderr: command.stderr },
  };
}));

server.registerTool("douyin_project_identity", {
  title: "识别抖音项目身份",
  description: "从 IDE 实际状态/已登录应用元数据判断项目类型、实际 AppID 与权限状态；文件结构仅作辅助证据。结构化错误：APP_PERMISSION_DENIED（无权限）/ PROJECT_TYPE_MISMATCH（类型不符）/ APPID_MISMATCH（AppID 不同）/ PROJECT_TYPE_UNKNOWN（无可靠类型证据）。",
  inputSchema: {
    projectPath: z.string().optional(),
    expectedAppid: z.string().optional(),
    expectedProjectType: z.enum(["minigame", "miniapp"]).optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_project_identity", async () => {
  const projectPath = allowedPath(args?.projectPath);
  return await resolveProjectIdentity(projectPath, {
    expectedAppid: args?.expectedAppid,
    expectedProjectType: args?.expectedProjectType,
    timeoutMs: timeout(args, 15000),
  });
}));

server.registerTool("douyin_create_minigame_project", {
  title: "创建抖音小游戏工程（仅小游戏）",
  description: "通过 IDE 启动页真实\"小游戏\"入口创建工程（CDP DOM 语义控件，禁截图坐标点击）。强制 JavaScript + 空白模板 + 小游戏类型；目标目录非空默认拒绝；创建后调用身份识别复核类型。启动页 UI 不可控时返回 CREATE_PROJECT_UI_UNSUPPORTED 与唯一人工操作。",
  inputSchema: {
    projectPath: z.string(),
    appid: z.string().min(1),
    projectName: z.string().optional(),
    language: z.enum(["javascript", "typescript"]).optional(),
    template: z.enum(["empty", "rich"]).optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_create_minigame_project", async () => {
  const projectPath = allowedPath(args?.projectPath);
  // 非空目录默认拒绝（禁止覆盖）
  if (fs.existsSync(projectPath)) {
    const entries = fs.readdirSync(projectPath);
    if (entries.length > 0) {
      const error = new Error(`目标目录非空（${entries.length} 项），禁止覆盖`);
      error.code = "DIRECTORY_NOT_EMPTY";
      error.details = { projectPath, entries: entries.slice(0, 20) };
      throw error;
    }
  }
  // 语言/模板：仅允许 javascript + empty（小游戏空白模板）
  const language = args?.language || "javascript";
  const template = args?.template || "empty";
  if (language !== "javascript") {
    const error = new Error("仅支持 JavaScript 语言（小游戏环境仅提供 JS 运行时）");
    error.code = "CREATE_PROJECT_PARAM_UNSUPPORTED";
    throw error;
  }
  if (template !== "empty") {
    const error = new Error("仅支持空白模板（empty）");
    error.code = "CREATE_PROJECT_PARAM_UNSUPPORTED";
    throw error;
  }

  // 通过 IDE 启动页真实"小游戏"入口创建
  const ui = await readFrontPageText(timeout(args, 8000));
  if (!ui.supported) {
    const error = new Error("IDE 启动页 UI 不可控（无法通过 CDP 语义控件访问）");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = {
      hint: "请人工在抖音开发者工具中选择「小游戏」类型新建空白工程（JavaScript + 空白模板），目录指向目标路径并填入 AppID",
      reason: ui.reason,
    };
    throw error;
  }

  // 1. 点击"小游戏"类型标签
  const clickGame = await clickFrontPageText("小游戏", timeout(args, 8000));
  if (!clickGame.clicked) {
    const error = new Error("IDE 启动页未找到可点击的「小游戏」类型入口");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = {
      hint: "请人工在抖音开发者工具中选择「小游戏」类型新建空白工程",
      frontPage: { body: ui.body?.slice(0, 400), buttons: ui.buttons },
    };
    throw error;
  }
  // 2. 等待小游戏视图出现输入框（"请输入项目名称"）；若出现则直接进入填表
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let form = await readFrontPageText(timeout(args, 8000));
  const hasNameInput = (form.inputs || []).some((el) => String(el.placeholder || "").includes("项目名称"));
  if (!hasNameInput) {
    // 未出现输入框时尝试"新建"入口
    const clickNew = await clickFrontPageText("新建", timeout(args, 8000));
    if (!clickNew.clicked) {
      const error = new Error("IDE 启动页未找到「新建」入口或小游戏新建表单");
      error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
      error.details = { hint: "请人工在抖音开发者工具中点击「新建」创建小游戏工程", formBody: form.body?.slice(0, 400) };
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    form = await readFrontPageText(timeout(args, 8000));
  }
  if (!form.supported) {
    const error = new Error("IDE 启动页表单不可读（无法通过 CDP 语义控件操作）");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = { hint: "请人工在抖音开发者工具中完成小游戏新建表单（类型小游戏、JavaScript、空白模板、AppID）", reason: form.reason };
    throw error;
  }

  // 4. 填写表单字段（目录 / AppID / 项目名称），并验证关键字段是否真实存在
  const fills = [
    { placeholder: "请输入项目名称", label: "", value: args.projectName || path.basename(projectPath) || "douyin-project", index: 0 },
    { placeholder: "", label: "AppID", value: args.appid, index: 1 },
    { placeholder: "", label: "目录", value: projectPath, index: 2 },
  ].filter((f) => f.value);
  const fillResults = [];
  const formInputs = form.inputs || [];
  for (const fill of fills) {
    const r = await fillFrontPageInput(fill, timeout(args, 8000));
    fillResults.push({ field: fill.label || fill.placeholder || `input[${fill.index}]`, value: fill.value, ...r });
  }
  // 验证 AppID 字段确实被填入（表单字段不全则无法可靠创建）
  const filledInputs = await readFrontPageText(timeout(args, 8000));
  const appidFilled = (filledInputs.inputs || []).some((el) => el.value === args.appid);
  if (!appidFilled) {
    const error = new Error("IDE 小游戏新建表单未暴露 AppID 输入框，无法可靠创建（字段不全）");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = {
      hint: "请人工在抖音开发者工具中选择「小游戏」类型新建：填写目录、AppID、项目名称，选 JavaScript + 空白模板后点击创建",
      formInputs: (filledInputs.inputs || []).slice(0, 10),
      fillResults,
    };
    throw error;
  }

  // 5. 选择语言 JavaScript + 模板空白（语义控件点击，缺失不阻断但记录）
  const langResult = await clickFrontPageOption("JavaScript", { exact: false }, timeout(args, 8000));
  const templateResult = await clickFrontPageOption("空白模板", { exact: false }, timeout(args, 8000));
  const templateResultAlt = templateResult.clicked ? templateResult : await clickFrontPageOption("空白", { exact: false }, timeout(args, 8000));

  // 6. 提交创建：点击"创建"或"确定"或"新建"
  const createResult = await clickFrontPageText("创建", timeout(args, 8000));
  const createResultFinal = createResult.clicked ? createResult : await clickFrontPageText("确定", timeout(args, 8000));
  if (!createResultFinal.clicked) {
    const error = new Error("IDE 启动页未找到可点击的「创建」提交按钮");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = {
      hint: "请人工在抖音开发者工具小游戏新建表单中点击「创建」",
      formBody: filledInputs.body?.slice(0, 600),
      buttons: filledInputs.buttons?.slice(0, 15),
    };
    throw error;
  }

  // 7. 等待工程实际载入（front-page 工程列表出现目标路径）
  const loaded = await waitForFrontPageText(projectPath, { timeoutMs: timeout(args, 45000), intervalMs: 2000 });
  if (!loaded.matched) {
    const error = new Error("IDE 启动页无法确认工程创建完成（等待载入超时）");
    error.code = "CREATE_PROJECT_UI_UNSUPPORTED";
    error.details = {
      hint: "请人工在抖音开发者工具中确认小游戏工程已创建并打开；完成后可调用 douyin_project_identity 复核",
      projectPath,
      appid: args.appid,
      formBody: (loaded.body || filledInputs.body)?.slice(0, 600),
    };
    throw error;
  }

  // 8. 创建后身份核验：必须确认目录、AppID、小游戏类型
  const verify = await resolveProjectIdentity(projectPath, {
    expectedAppid: args.appid,
    expectedProjectType: "minigame",
    timeoutMs: timeout(args, 15000),
  });
  if (!verify.ok || verify.identity.projectType !== "minigame") {
    const error = new Error("创建后身份核验未通过（类型/AppID 不符）");
    error.code = "CREATE_PROJECT_VERIFY_FAILED";
    error.details = { identity: verify.identity, projectPath, appid: args.appid };
    throw error;
  }

  return {
    created: true,
    stage: "created-and-verified",
    projectPath,
    appid: args.appid,
    projectName: args.projectName || null,
    language: "javascript",
    template: "empty",
    identity: verify.identity,
    fillSteps: { fills: fillResults, language: langResult, template: templateResult.clicked ? templateResult : templateResultAlt, submit: createResult },
  };
}));

server.registerTool("douyin_preview", {
  title: "生成抖音预览二维码",
  description: "按工程类型路由：小游戏走 tmg preview（--output），其余走 tma preview（--qrcode-output）。输出二维码只能写入工作区内。可传 small/copy/query/scene/launchFrom 透传官方选项。",
  inputSchema: {
    projectPath: z.string().optional(),
    expectedProjectType: z.enum(["minigame", "miniapp"]).optional(),
    qrcodeOutput: z.string().optional(),
    small: z.boolean().optional(),
    copy: z.boolean().optional(),
    query: z.string().optional(),
    scene: z.string().optional(),
    launchFrom: z.string().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_preview", async () => {
  const projectPath = allowedPath(args?.projectPath);
  const routing = resolveOpenRouting(args?.expectedProjectType, projectPath);
  const useTmg = routing.cli === "tmg";
  const output = ensureOutputPath(args?.qrcodeOutput, path.join(WORKSPACE_ROOT, "qa", "mcp", "preview.png"));
  outputFile(output);
  const command = useTmg
    ? await tmgPreviewProject(projectPath, {
        output, small: args?.small, copy: args?.copy, query: args?.query, scene: args?.scene, launchFrom: args?.launchFrom,
        timeoutMs: timeout(args, 90000),
      })
    : await previewProject(projectPath, output, {
        timeoutMs: timeout(args, 90000), small: args?.small, copy: args?.copy, query: args?.query, scene: args?.scene, launchFrom: args?.launchFrom,
      });
  return {
    project: projectPath,
    output,
    source: useTmg ? "tt-minigame-ide-cli (tmg)" : "tt-ide-cli",
    routing: { cli: routing.cli, hint: routing.hint },
    command: commandData(command),
    fileExists: fs.existsSync(output),
  };
}));

server.registerTool("douyin_build_npm", {
  title: "构建抖音项目 NPM",
  description: "按工程类型路由：小游戏走 tmg build-npm，其余走 tma build-npm，不执行上传或提审。",
  inputSchema: { projectPath: z.string().optional(), expectedProjectType: z.enum(["minigame", "miniapp"]).optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_build_npm", async () => {
  const projectPath = allowedPath(args?.projectPath);
  const routing = resolveOpenRouting(args?.expectedProjectType, projectPath);
  const useTmg = routing.cli === "tmg";
  const command = useTmg
    ? await tmgBuildNpm(projectPath, timeout(args, 90000))
    : await buildNpm(projectPath, timeout(args, 90000));
  return {
    project: projectPath,
    source: useTmg ? "tt-minigame-ide-cli (tmg)" : "tt-ide-cli",
    routing: { cli: routing.cli, hint: routing.hint },
    command: commandData(command),
  };
}));

server.registerTool("douyin_compile_refresh", {
  title: "触发 IDE 编译或刷新",
  description: "优先通过 IDE 4.5.5 本地 workbench 调试页面点击编译/刷新；可显式选择可靠快捷键兜底。传 projectPath 可在多开 IDE 时绑定到目标工程实例。",
  inputSchema: {
    mode: z.enum(["compile", "refresh", "compile_and_refresh"]).optional(),
    useShortcut: z.boolean().optional(),
    shortcut: z.enum(["CTRL_R", "CTRL_S", "F5"]).optional(),
    projectPath: z.string().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_compile_refresh", async () => {
  const mode = args?.mode || "compile";
  const projectPath = args?.projectPath ? allowedPath(args.projectPath) : undefined;
  await focusIde(timeout(args, 5000));
  const labels = mode === "compile_and_refresh" ? ["编译", "刷新"] : [mode === "refresh" ? "刷新" : "编译"];
  const actions = [];
  for (const label of labels) {
    let uia;
    try { uia = await invokeUiaControl(label, timeout(args, 5000)); }
    catch (error) { uia = { supported: false, reason: trimText(error.message) }; }
    if (uia.supported && uia.clicked) actions.push({ label, method: "uia", uia, clicked: true });
    else actions.push({ label, method: "local-cdp-dom", uia, cdp: await clickWorkbenchText(label, timeout(args, 10000), projectPath) });
  }
  const clicked = actions.every((item) => item.clicked || item.cdp?.clicked);
  let shortcutResult;
  if (!clicked && args?.useShortcut) {
    const shortcut = args.shortcut || (mode === "refresh" ? "CTRL_R" : "CTRL_S");
    shortcutResult = await sendShortcut(shortcut, timeout(args, 5000));
    actions.push({ method: "explicit-shortcut", shortcut, result: shortcutResult });
  }
  if (!clicked && !shortcutResult?.supported) {
    const error = new Error("IDE 4.5.5 未提供可用的编译/刷新控件接口，未伪造成功");
    error.code = "IDE_ACTION_UNSUPPORTED";
    error.details = { actions, hint: "可传 useShortcut=true 显式使用 CTRL_R、CTRL_S 或 F5" };
    throw error;
  }
  return { mode, actions, method: clicked ? "uia-or-local-cdp-dom" : "explicit-shortcut-fallback" };
}));

server.registerTool("douyin_capture", {
  title: "截取 IDE 或模拟器画面",
  description: "IDE 全窗使用 Windows 原生窗口拷贝；模拟器使用本地 MiniApp Webview 的 CDP 截图。传 projectPath 可在多开 IDE 时绑定到目标工程实例。",
  inputSchema: {
    target: z.enum(["ide_window", "simulator"]).optional(),
    outputPath: z.string().optional(),
    projectPath: z.string().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_capture", async () => {
  const target = args?.target || "ide_window";
  const projectPath = args?.projectPath ? allowedPath(args.projectPath) : undefined;
  const fallback = path.join(WORKSPACE_ROOT, "qa", "mcp", `${target}.png`);
  const output = ensureOutputPath(args?.outputPath, fallback);
  outputFile(output);
  if (target === "ide_window") {
    const capture = await captureIdeWindow(output, timeout(args, 15000));
    return { target, output, source: "Windows.CopyFromScreen", capture };
  }
  const capture = await captureSimulator(timeout(args, 15000), projectPath);
  if (!capture.supported) {
    const error = new Error(capture.reason);
    error.code = "SIMULATOR_CAPTURE_UNSUPPORTED";
    throw error;
  }
  fs.writeFileSync(output, capture.data);
  return { target, output, source: "IDE MiniApp Webview CDP", bytes: capture.data.length };
}));

server.registerTool("douyin_read_console_errors", {
  title: "读取 IDE 控制台错误",
  description: "尽最大可能从 IDE 内嵌 DevTools DOM 读取错误；接口不存在时返回明确的不支持原因。传 projectPath 可在多开 IDE 时绑定到目标工程实例。",
  inputSchema: { projectPath: z.string().optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_read_console_errors", async () => {
  const projectPath = args?.projectPath ? allowedPath(args.projectPath) : undefined;
  return readConsoleErrors(timeout(args, 10000), projectPath);
}));

server.registerTool("douyin_upload", {
  title: "上传抖音项目（危险）",
  description: "按工程类型路由（小游戏走 tmg upload，其余走 tma upload）。默认拒绝，必须 confirm=true 才会触发远程上传。小游戏上传前先查 tmg version 的最新已发布版本，随结果返回 versionCheck 供核对版本递增（信息性，不阻断）。",
  inputSchema: {
    projectPath: z.string().optional(),
    expectedProjectType: z.enum(["minigame", "miniapp"]).optional(),
    appChangelog: z.string().min(1),
    appVersion: z.string().optional(),
    channel: z.string().optional(),
    small: z.boolean().optional(),
    copy: z.boolean().optional(),
    confirm: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_upload", async () => {
  if (args?.confirm !== true) throw confirmationError("douyin_upload");
  const projectPath = allowedPath(args?.projectPath);
  const routing = resolveOpenRouting(args?.expectedProjectType, projectPath);
  const useTmg = routing.cli === "tmg";
  // 小游戏上传前查最新已发布版本，便于核对版本号递增（信息性，不阻断上传）
  let versionCheck = null;
  if (useTmg) {
    try {
      const v = await tmgVersionProject(projectPath, 20000);
      versionCheck = { ok: v.ok, latestVersion: extractLatestVersion(v.stdout || "") || null, exitCode: v.exitCode, timedOut: Boolean(v.timedOut) };
    } catch (error) {
      versionCheck = { ok: false, error: trimText(error.message) };
    }
  }
  const command = useTmg
    ? await tmgUploadProject(projectPath, {
        appVersion: args?.appVersion, appChangelog: args?.appChangelog, channel: args?.channel,
        small: args?.small, copy: args?.copy, timeoutMs: timeout(args, 120000),
      })
    : await uploadProject(projectPath, args, timeout(args, 120000));
  return {
    project: projectPath,
    source: useTmg ? "tt-minigame-ide-cli (tmg)" : "tt-ide-cli",
    routing: { cli: routing.cli, hint: routing.hint },
    versionCheck,
    command: commandData(command),
    confirmed: true,
  };
}));

server.registerTool("douyin_audit", {
  title: "提审抖音项目（危险）",
  description: "官方 tma audit 的安全封装。默认拒绝，只有 confirm=true 才会触发远程提审。",
  inputSchema: {
    appid: z.string().min(1),
    host: z.string().optional(),
    autoPublish: z.boolean().optional(),
    channel: z.string().optional(),
    confirm: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_audit", async () => {
  if (args?.confirm !== true) throw confirmationError("douyin_audit");
  const command = await auditProject(args.appid, args, timeout(args, 120000));
  return { appid: args.appid, source: "tt-ide-cli", command: commandData(command), confirmed: true };
}));

server.registerTool("douyin_project_size", {
  title: "查看抖音项目包体积",
  description: "调用官方 tma project-size 输出包体积信息；--json 输出结构化结果。上传/提审前核对包体积用。",
  inputSchema: { projectPath: z.string().optional(), json: z.boolean().optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_project_size", async () => {
  const projectPath = allowedPath(args?.projectPath);
  const command = await projectSize(projectPath, { json: args?.json, timeoutMs: timeout(args, 30000) });
  return { project: projectPath, source: "tt-ide-cli", json: Boolean(args?.json), command: commandData(command) };
}));

server.registerTool("douyin_audit_hosts", {
  title: "查询提审 Host 列表",
  description: "调用官方 tma hosts 查询指定 AppID 可用的审核 Host 列表（douyin_audit 的 host 参数取值参考）。",
  inputSchema: { appid: z.string().min(1), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_audit_hosts", async () => {
  const command = await auditHosts(args.appid, timeout(args, 30000));
  return { appid: args.appid, source: "tt-ide-cli", command: commandData(command) };
}));

server.registerTool("douyin_set_app_config", {
  title: "为 AppID 设置访问 Token（CI 登录）",
  description: "调用官方 tma set-app-config 为指定 AppID 设置 token（CI 无交互登录用）。token 仅写入本机 tma 配置，不会回显。属于本地配置写入，请谨慎使用。",
  inputSchema: { appid: z.string().min(1), token: z.string().min(1), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_set_app_config", async () => {
  const command = await setAppConfig(args.appid, args.token, timeout(args, 30000));
  return { appid: args.appid, source: "tt-ide-cli", tokenSet: true, command: commandData(command) };
}));

server.registerTool("douyin_project_version", {
  title: "查询小游戏最新已发布版本",
  description: "调用官方 tmg version 查询最新已发布版本号（上传/提审前核对用）。小程序端 tma 无 version 命令，返回 supported:false。",
  inputSchema: { projectPath: z.string().optional(), expectedProjectType: z.enum(["minigame", "miniapp"]).optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_project_version", async () => {
  const projectPath = allowedPath(args?.projectPath);
  const routing = resolveOpenRouting(args?.expectedProjectType, projectPath);
  if (routing.cli !== "tmg") {
    return { project: projectPath, source: "tt-ide-cli", supported: false, reason: "tma 无 version 命令，小程序端请在开发者平台查看已发布版本" };
  }
  const command = await tmgVersionProject(projectPath, timeout(args, 30000));
  return {
    project: projectPath,
    source: "tt-minigame-ide-cli (tmg)",
    supported: true,
    latestVersion: extractLatestVersion(command.stdout || "") || null,
    command: commandData(command),
  };
}));

server.registerTool("douyin_ide_preview", {
  title: "在 IDE 内生成预览二维码（绕过 CLI 登录）",
  description: "直接点击已登录抖音开发者工具 workbench 的「预览」按钮生成预览二维码（无需 CLI 登录态），从 DOM 提取二维码 PNG 保存到工作区。",
  inputSchema: { projectPath: z.string().optional(), outputPath: z.string().optional(), timeoutMs: z.number().int().optional() },
}, async (args) => run("douyin_ide_preview", async () => {
  const projectPath = args?.projectPath ? allowedPath(args.projectPath) : undefined;
  const output = ensureOutputPath(args?.outputPath, path.join(WORKSPACE_ROOT, "qa", "mcp", "ide-preview-qr.png"));
  const result = await previewInIde({ projectPath, timeoutMs: timeout(args, 25000) });
  if (!result.supported || !result.qr?.data) {
    const error = new Error(result.reason || "未提取到预览二维码");
    error.code = "IDE_PREVIEW_FAILED";
    throw error;
  }
  outputFile(output);
  const data = Buffer.from(result.qr.data, "base64");
  fs.writeFileSync(output, data);
  return {
    output,
    bytes: data.length,
    qr: { width: result.qr.width, height: result.qr.height, mime: result.qr.mime },
    click: result.click,
    source: "IDE workbench DOM",
  };
}));

server.registerTool("douyin_ide_upload", {
  title: "在 IDE 内上传（绕过 CLI 登录，危险）",
  description: "直接操控已登录的抖音开发者工具完成上传：点击「上传」→ 填写版本号/更新日志 → 点击「确定」。无需 CLI 登录态。默认拒绝，必须 confirm=true；上传将以 IDE 当前登录账号执行（远程副作用）。",
  inputSchema: {
    projectPath: z.string().optional(),
    appVersion: z.string().optional(),
    appChangelog: z.string().min(1),
    confirm: z.boolean().optional(),
    timeoutMs: z.number().int().optional(),
  },
}, async (args) => run("douyin_ide_upload", async () => {
  if (args?.confirm !== true) throw confirmationError("douyin_ide_upload");
  const projectPath = args?.projectPath ? allowedPath(args.projectPath) : undefined;
  const result = await uploadInIde({
    projectPath, appVersion: args?.appVersion, appChangelog: args.appChangelog,
    hitsSubmit: true, timeoutMs: timeout(args, 60000),
  });
  if (!result.supported || !result.submitted) {
    const error = new Error(result.reason || "IDE 内上传未完成");
    error.code = "IDE_UPLOAD_FAILED";
    error.details = { click: result.click, submit: result.submit, filled: result.filled };
    throw error;
  }
  return { confirmed: true, submitted: true, filled: result.filled, submit: result.submit };
}));

const transport = new StdioServerTransport();
transport.onerror = (error) => log("transport", error.message);
await server.connect(transport);
log("server", `stdio MCP 已启动，工作区 ${WORKSPACE_ROOT}`);

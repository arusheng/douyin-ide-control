import assert from "node:assert/strict";
import { test } from "node:test";
import { isTargetBoundToProject } from "../src/cdp.mjs";

test("isTargetBoundToProject：workbench URL 的 projectPath 参数精确匹配（大小写/分隔符归一）", () => {
  const target = { type: "page", url: "file:///workbench/index.html?project-type=microgame&mode=full&projectPath=d%3A%5Cminigame%5Csample-minigame" };
  assert.equal(isTargetBoundToProject(target, "D:\\minigame\\sample-minigame"), true, "反斜杠路径应匹配");
  assert.equal(isTargetBoundToProject(target, "D:/minigame/sample-minigame"), true, "正斜杠路径应归一后匹配");
  assert.equal(isTargetBoundToProject(target, "D:\\minigame\\其他工程"), false, "不同工程不匹配");
});

test("isTargetBoundToProject：无 projectPath 参数时按标题/URL 含工程名匹配", () => {
  const target = { title: "sample-minigame - 抖音开发者工具", url: "file:///front-page/index.html" };
  assert.equal(isTargetBoundToProject(target, "D:\\minigame\\sample-minigame"), true, "标题含工程名应匹配");
  assert.equal(isTargetBoundToProject(target, "D:\\minigame\\其他工程"), false, "标题不含则不算绑定");
});

test("isTargetBoundToProject：空目标/空路径返回 false", () => {
  assert.equal(isTargetBoundToProject(null, "D:\\a"), false);
  assert.equal(isTargetBoundToProject({ url: "file:///x" }, ""), false);
  assert.equal(isTargetBoundToProject({ url: "file:///x" }, null), false);
});


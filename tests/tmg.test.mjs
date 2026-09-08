import assert from "node:assert/strict";
import { test } from "node:test";
import { extractLatestVersion } from "../src/tmg.mjs";

test("extractLatestVersion 从 tmg version 输出中提取版本号", () => {
  assert.equal(extractLatestVersion("当前最新版本: 1.2.3\n"), "1.2.3");
  assert.equal(extractLatestVersion("1.0.0"), "1.0.0");
  assert.equal(extractLatestVersion("v2.10.1-beta.2"), "2.10.1-beta.2");
});

test("extractLatestVersion 无版本号时返回 null", () => {
  assert.equal(extractLatestVersion(""), null);
  assert.equal(extractLatestVersion("not logged in"), null);
  assert.equal(extractLatestVersion(null), null);
  assert.equal(extractLatestVersion("请先登录后重试"), null);
});

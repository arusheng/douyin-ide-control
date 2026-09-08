import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTcpListeners } from "../src/proc.mjs";

test("parseTcpListeners 解析 netstat 输出中的本地监听行", () => {
  const stdout = [
    "TCP    127.0.0.1:8702        127.0.0.1:0         LISTENING       1234",
    "TCP    127.0.0.1:8830        0.0.0.0:0           LISTENING       5678",
    "TCP    [::1]:8830            [::]:0              LISTENING       5678",
    "TCP    127.0.0.1:50442       127.0.0.1:8830      ESTABLISHED     1234",
    "  TCP    127.0.0.1:9999        0.0.0.0:0           LISTENING       9999",
  ].join("\r\n");
  const result = parseTcpListeners(stdout);
  assert.deepEqual(
    result.map((l) => [l.port, l.pid]),
    [[8702, "1234"], [8830, "5678"], [9999, "9999"]],
    "只保留 127.0.0.1 上的 LISTENING 行，忽略 IPv6/ESTABLISHED",
  );
});

test("parseTcpListeners 对空/非 netstat 文本返回空数组", () => {
  assert.deepEqual(parseTcpListeners(""), []);
  assert.deepEqual(parseTcpListeners(null), []);
  assert.deepEqual(parseTcpListeners("TCP 127.0.0.1:80 0.0.0.0:0 ESTABLISHED 1"), []);
});

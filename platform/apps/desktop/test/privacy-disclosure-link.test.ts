/**
 * 告知联动（复核 B4-R06；第 46 批从 services/legal-gateway/test/content-safety.test.ts 挪来——拆独立云端仓库后，
 * 读两端源码的门禁放在 monorepo 的客户端一侧）：网关计量落盘字段含内容安全时，桌面端《中软看得到什么》必须写明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("计量落盘字段含内容安全时，《中软看得到什么》必须写明", () => {
  const meter = readFileSync(new URL("../../../services/legal-gateway/src/meter-file.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/pages/Connections.tsx", import.meta.url), "utf8");
  if (/"safety"/.test(meter)) assert.match(page, /内容安全检查命中的类别编号与次数/);
});

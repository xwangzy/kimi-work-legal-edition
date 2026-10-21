/**
 * Z3 #14 时间格式统一：律师层不显示秒、不用斜杠；今天写“刚刚 / n 分钟前 / 14:40”，今年“10月19日 14:40”，往年“2025年10月19日”。
 * 用本地时间构造输入，不依赖测试机时区。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fmtDate, fmtTime, fmtWhen } from "../src/lib/labels.ts";

const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).toISOString();

test("#14 fmtWhen：今天、今年、往年三档", () => {
  const now = new Date(2026, 9, 19, 16, 0, 0).getTime();
  assert.equal(fmtWhen(local(2026, 10, 19, 15, 59, 40), now), "刚刚");
  assert.equal(fmtWhen(local(2026, 10, 19, 15, 15), now), "45 分钟前");
  assert.equal(fmtWhen(local(2026, 10, 19, 9, 5, 33), now), "09:05");
  assert.equal(fmtWhen(local(2026, 10, 18, 14, 40), now), "10月18日 14:40");
  assert.equal(fmtWhen(local(2025, 10, 19, 14, 40), now), "2025年10月19日");
  assert.equal(fmtWhen(null, now), "—");
  assert.equal(fmtWhen("不是时间", now), "—");
  // 本机时钟比记录早（另一台电脑写的时刻）：不写“-3 分钟前”
  assert.equal(fmtWhen(local(2026, 10, 19, 16, 3), now), "16:03");
});

test("#14 fmtTime / fmtDate：完整时刻到分钟，不带秒、不用斜杠", () => {
  assert.equal(fmtTime(local(2026, 10, 19, 14, 40, 59)), "2026年10月19日 14:40");
  assert.equal(fmtDate(local(2026, 1, 4, 10)), "2026年1月4日");
  assert.equal(fmtTime(null), "—");
});

test("#14 门禁：律师层页面与组件不直接用 toLocaleString / toLocaleDateString / toLocaleTimeString 格式化时刻", () => {
  const root = join(import.meta.dirname, "..", "src");
  const hits: string[] = [];
  for (const dir of ["pages", "components"]) {
    for (const f of readdirSync(join(root, dir))) {
      if (!f.endsWith(".tsx") && !f.endsWith(".ts")) continue;
      const src = readFileSync(join(root, dir, f), "utf8");
      src.split("\n").forEach((line, i) => {
        if (/new Date\([^)]*\)\.toLocale(String|DateString|TimeString)\(|toLocale(Date|Time)String\(/.test(line)) hits.push(`${dir}/${f}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(hits, []);
});

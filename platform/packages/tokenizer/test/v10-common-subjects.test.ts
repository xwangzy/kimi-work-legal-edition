/**
 * V10 真实走查 V4：客户背景说明“商场说这是标准文本”把“商场”学成人名，商铺租赁合同第 5.4 条“根据商场整体经营需要”送给模型成了
 * “根据〔自然人·…〕整体经营需要”，审查计划随之写“第 5.4 条自然人代号与出租方主体错位”。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MatterTokenizer } from "../src/index.ts";

const tz = () => new MatterTokenizer({ matterKey: randomBytes(32), parties: [], fullPseudonym: false } as any);

test("“商场说”“房东说”“车主称”不当人名；同一事项里的合同条款原样送出", () => {
  const t = tz();
  for (const s of ["商场说这是标准文本，大条款不能改。", "房东说下个月要涨租。", "车主称车辆已过户。", "商家表示可以退货。"]) {
    const r = t.tokenize(s);
    assert.equal(r.entries.filter((e) => e.category === "person").length, 0, `${s} → ${r.text}`);
  }
  assert.equal(t.tokenize("甲方有权根据商场整体经营需要调整乙方商铺位置。").text, "甲方有权根据商场整体经营需要调整乙方商铺位置。");
});

test("以“商”“房”“车”为姓的真名照常认出", () => {
  for (const [s, name] of [["商鹏说这是标准文本。", "商鹏"], ["房立新表示同意。", "房立新"], ["车晓敏称已经付款。", "车晓敏"]] as const) {
    const r = tz().tokenize(s);
    assert.ok(r.entries.some((e) => e.category === "person" && e.value === name), `${s} → ${r.text}`);
  }
});

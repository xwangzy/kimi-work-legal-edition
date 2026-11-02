/**
 * 第 35 批真实走查 R2：合同里“甲方应进行验收”送给模型时成了“甲方〔自然人〕行验收”，审查意见据此误判“表述不完整”。
 * 合同当事人角色词后直接接的“应”是“应当”，不是姓“应”；诉讼角色词后、有分隔的真名照常认出（召回不变）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeNames } from "../src/names.ts";

test("合同当事人角色词 + 应 + 动词：不是姓名（逐个动词补短语补不完）", () => {
  const verbs = ["进行", "通知", "开具", "完成", "采取", "继续", "签署", "办理", "交付", "配合", "提供", "按照", "进一步", "进入", "在", "于", "向"];
  for (const role of ["甲方", "乙方", "出租人", "承租人", "受让方", "劳动者", "买方", "保证人"]) {
    for (const v of verbs) {
      const t = `${role}应${v}相关事项。`;
      assert.deepEqual([...recognizeNames(t)], [], t);
    }
  }
  assert.deepEqual([...recognizeNames("设备安装调试完成后，甲方应进行验收，验收期限为7日。")], []);
});

test("真名照常认出：有分隔的合同角色、诉讼角色、称谓与言语动词", () => {
  assert.ok(recognizeNames("甲方：应保国，身份证号码见附件。").has("应保国"));
  assert.ok(recognizeNames("联系人：应进，电话见下。").has("应进"));
  assert.ok(recognizeNames("被告应晓明于 2025 年 3 月借款。").has("应晓明"));
  assert.ok(recognizeNames("证人应保国出庭作证。").has("应保国"));
  assert.ok(recognizeNames("应保国律师已到庭。").has("应保国"));
});

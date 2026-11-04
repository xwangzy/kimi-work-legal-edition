// V13 真实走查 N2（审仓储合同，独立律师评分 23/30，交付形式 1 分）：《审查意见书（内部稿）》写着“识别质量正常、无被替代版本”
// “核验状态”“已在受限命令行复算”“请在审查工作台处理……生成”。只对 Word 文书报；Excel 问题清单按方法本就有“风险卡序号”“核验状态”列。
import assert from "node:assert/strict";
import test from "node:test";
import { checkDeliverable } from "../src/services/deliverable-check.ts";

const sections = [
  { heading: "一、审查范围与覆盖说明", paragraphs: ["本次收到并完整读取对方稿一份，识别质量正常，无未读页、无被替代版本。"] },
  { heading: "六、法律依据一览", paragraphs: [], table: { columns: ["法名", "条号", "核验状态"], rows: [["民法典", "第917条", "已核到条"]] } },
  { heading: "七、说明", paragraphs: ["上述金额已在受限命令行复算。修订稿与清洁稿请在审查工作台处理风险卡后生成。"] },
];

test("Word 文书里的界面与环境用语报为内部用语；同样的列在 Excel 问题清单里不报", () => {
  const word = checkDeliverable("审查意见书（内部稿）-仓储合同", sections, { docx: Buffer.from("x") });
  const hits = word.issues.filter((i) => i.kind === "internal_term").map((i) => i.text).join(" ");
  for (const t of ["识别质量", "被替代版本", "核验状态", "受限命令行", "审查工作台", "风险卡"]) assert.match(hits, new RegExp(t), t);
  const sheet = checkDeliverable("问题清单-仓储合同", [{ heading: "问题清单", paragraphs: [], table: { columns: ["序号", "核验状态", "风险卡序号"], rows: [["1", "已核到条", "3"]] } }]);
  assert.equal(sheet.issues.filter((i) => i.kind === "internal_term").length, 0);
});

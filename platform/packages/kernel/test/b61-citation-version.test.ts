/**
 * 第 61 批（V35，D-261）引用版本括注对版——P0：外部评估 R1 实跑复现、主会话复现：
 * “《公司法》（2018年修正）第二十条”“《民事诉讼法》（2021年修正）第二百六十条”被丢掉括注、按 2023 版判“来源与适用版本已核”（错版假通过）。
 * 修复后：括注版本库里没收 → version_not_collected；收了但不是分析时点适用的版本 → version_mismatch（按该版本核条号）；两者都须人工核对、不判已核。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { createDocx } from "@zr-legal/docx-engine";
import { CitationState } from "@zr-legal/domain";
import { citationsVerify, versionNoteOf } from "../src/tools/tools/citations.ts";
import { checkArtifactCitations } from "../src/services/artifact-citations.ts";
import { checkDeliverable } from "../src/services/deliverable-check.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });
const one = (text: string, asOf = "2026-11-24") => citationsVerify(lawdb, { text, as_of: asOf }).verdicts[0]!;

test("版本括注解析：修正、修订按通过年份；施行按施行日；文号括注不算", () => {
  assert.deepEqual(versionNoteOf("《中华人民共和国公司法》（2018年修正）第二十条"), { text: "2018年修正", year: "2018", date: null, by: "promulgated" });
  assert.equal(versionNoteOf("《中华人民共和国公司法（2023年修订）》第二十条")?.year, "2023");
  assert.equal(versionNoteOf("《中华人民共和国民事诉讼法》（2024年1月1日施行）第八十五条")?.date, "2024-01-01");
  assert.equal(versionNoteOf("《中华人民共和国民事诉讼法》（2024-01-01施行）第八十五条")?.date, "2024-01-01");
  assert.equal(versionNoteOf("《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》（法释〔2020〕17号）第二十五条"), null);
});

test("P0：库里没收的旧版本（公司法 2018、民诉法 2021）不再判“来源与适用版本已核”", () => {
  for (const t of ["《中华人民共和国公司法》（2018年修正）第二十条", "《中华人民共和国公司法（2018年修正）》第一百八十二条", "《中华人民共和国民事诉讼法》（2021年修正）第二百六十条"]) {
    const v = one(t);
    assert.equal(v.state, CitationState.intercepted, t);
    assert.ok(v.reasons.some((r) => r.startsWith("version_not_collected:")), t);
  }
});

test("括注版本就是分析时点适用的版本：照常核（公司法 2023 修订、民诉法 2024-01-01 施行）", () => {
  assert.equal(one("《中华人民共和国公司法》（2023年修订）第二十条").state, CitationState.supportPending);
  assert.equal(one("《中华人民共和国民事诉讼法》（2024年1月1日施行）第八十五条").state, CitationState.supportPending);
  assert.equal(one("《中华人民共和国公司法》第二十条").state, CitationState.supportPending, "没写版本的照旧按分析时点");
});

test("库里收了旧版：律师法（2017年修正）在 2026-11-24 报版本不符、按旧版核条号；在旧版施行期间照常核", () => {
  const v = one("《中华人民共和国律师法》（2017年修正）第三十八条");
  assert.equal(v.state, CitationState.intercepted);
  assert.ok(v.reasons.some((r) => r.startsWith("version_mismatch:")), v.reasons.join("|"));
  assert.equal(one("《中华人民共和国律师法》（2017年修正）第三十八条", "2026-05-01").state, CitationState.supportPending);
  const out = one("《中华人民共和国律师法》（2017年修正）第六十三条");
  assert.ok(out.reasons.some((r) => r.startsWith("article_out_of_range:")), "旧版只有 60 条");
});

test("签发页归“须人工核对”（不是已核、也不是定性错误）；交付前检查报回", () => {
  const docx = createDocx("法律意见书", [{ heading: "依据", paragraphs: ["依据《中华人民共和国公司法》（2018年修正）第二十条，股东不得滥用股东权利。"] }] as any);
  const c = checkArtifactCitations(lawdb, "法律意见书.docx", docx, "2026-11-24");
  assert.equal(c.outside_registry, 1);
  assert.equal(c.verified, 0);
  assert.equal(c.wrong, 0);
  const r = checkDeliverable("法律意见书", [{ heading: "依据", paragraphs: ["依据《中华人民共和国公司法》（2018年修正）第二十条，股东不得滥用股东权利。"] }], { lawdb, asOf: "2026-11-24", docx });
  assert.ok(r.issues.some((i) => i.kind === "citation" && /2018年修正/.test(i.fix)), JSON.stringify(r.issues));
});

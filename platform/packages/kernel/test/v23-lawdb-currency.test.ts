/**
 * V23（2026-11-20 本地法规库核验，research/2026-11-20-V23-精修与核验/02-本地法规库核验.md）：随包法规库上的现行性与合读提示。
 * - 《律师法》2026-08-28 修改决定（2026-09-01 施行）：2017 修正本已修改；2026 修正本只收第四十一条（依据修改决定推定，正文同原第三十八条），38→41 条号迁移。
 * - 建工解释（一）各条与法释〔2026〕12号、民间借贷规定第五至八条与第十二条及民诉法解释第九十三条与法释〔2026〕19号的合读提示。
 * - 劳动争议解释（一）第三十二条两款按最高人民法院官网发布页补入，第一款登记“已废止”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { CitationState } from "@zr-legal/domain";
import { citationsVerify } from "../src/tools/tools/citations.ts";
import { lawGetArticle } from "../src/tools/tools/law.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const AS_OF = "2026-11-20";

function verdict(lawdb: ReturnType<typeof openLawdb>, law: string, article: number, asOf: string, topicHint?: string): any {
  return citationsVerify(lawdb, { citations: [{ law, article }], as_of: asOf, ...(topicHint ? { topic_hint: topicHint } : {}) } as any).verdicts[0]!;
}

test("律师法：2026-09-01 起按修正本核；带“保密义务”主题引第三十八条 → 拦截并建议改引第四十一条；第四十一条现行核过；施行前仍按 2017 版", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    const old = verdict(lawdb, "律师法", 38, AS_OF, "保密义务");
    assert.equal(old.state, CitationState.intercepted);
    assert.match(old.suggestion, /改引《中华人民共和国律师法》第四十一条（2026-09-01 施行版本）/);
    assert.match(old.historical_note, /第 38 条系 2018-01-01 施行版本（lsv_lawyers_2017，已修改）的条号/);
    // 现有机制的边界（如实记录）：不带主题时只核“条号在修正本总条数内”，不会提示改号，也不说内容是否变了
    const bare = verdict(lawdb, "律师法", 38, AS_OF);
    assert.equal(bare.state, CitationState.supportPending);
    assert.equal(bare.lsv_id, "lsv_lawyers_2026");
    const neu = verdict(lawdb, "律师法", 41, AS_OF, "保密义务");
    assert.equal(neu.state, CitationState.supportPending);
    assert.equal(neu.lsv_id, "lsv_lawyers_2026");
    const before = verdict(lawdb, "律师法", 38, "2026-08-31", "保密义务");
    assert.equal(before.state, CitationState.supportPending);
    assert.equal(before.lsv_id, "lsv_lawyers_2017");
    // 新增的第六十二条（大湾区律师执业）在修正本总条数内，不再被判“条号不存在”
    assert.ok(!verdict(lawdb, "律师法", 62, AS_OF).reasons.some((r: string) => r.startsWith("article_out_of_range:")));
    const a41 = lawGetArticle(lawdb, { law: "律师法", article: 41, as_of: AS_OF }) as any;
    assert.equal(a41.found, true);
    assert.equal(a41.reliability, "inferred_from_amendment_decision");
    assert.match(a41.note, /依据修改决定推定.*正式引用前须对照官方文本/);
    assert.match(a41.text, /律师应当保守在执业活动中知悉的国家秘密、商业秘密/);
    assert.equal((lawGetArticle(lawdb, { law: "律师法", article: 38, as_of: AS_OF }) as any).reason, "text_not_collected");
  } finally {
    lawdb.close();
  }
});

test("合读提示：建工解释（一）→ 法释〔2026〕12号；民间借贷规定第五条、民诉法解释第九十三条 → 法释〔2026〕19号；劳动争议解释（一）第三十二条第一款已废止", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    const c1 = lawGetArticle(lawdb, { law: "建工解释（一）", article: 1, as_of: AS_OF }) as any;
    assert.equal(c1.read_with.length, 1);
    assert.match(c1.read_with[0], /法释〔2026〕12号.*以前发布的司法解释与本解释不一致的，以本解释为准/);
    const pl5 = lawGetArticle(lawdb, { law: "民间借贷规定", article: 5, as_of: AS_OF }) as any;
    assert.match(pl5.read_with[0], /法释〔2026〕19号.*此前发布的司法解释与本规定不一致的，以本规定为准/);
    assert.equal((lawGetArticle(lawdb, { law: "民间借贷规定", article: 1, as_of: AS_OF }) as any).read_with, undefined, "与民刑交叉无关的条没有合读提示");
    const cp93 = verdict(lawdb, "民诉法解释", 93, AS_OF);
    assert.ok(cp93.reasons.some((r: string) => r.startsWith("read_with:") && r.includes("已为生效刑事裁判所认定的事实")), JSON.stringify(cp93.reasons));
    const i32 = lawGetArticle(lawdb, { law: "劳动争议解释（一）", article: 32, as_of: AS_OF }) as any;
    assert.equal(i32.found, true);
    assert.equal(String(i32.text).split("\n").length, 2, "两款都按官方原文收入，款号对齐");
    assert.match(i32.text, /\n企业停薪留职人员、未达到法定退休年龄的内退人员、下岗待岗人员以及企业经营性停产放长假人员，因与新的用人单位发生用工争议而提起诉讼的，人民法院应当按劳动关系处理。$/);
    assert.match(i32.read_with[0], /第一款已被.*法释〔2025〕12号）第二十一条废止.*第二款仍有效/);
  } finally {
    lawdb.close();
  }
});

test("库外法源：拦截原因是 unknown_source、未匹配法名（界面据此说“法规库未收录”，不说成条号不对）", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    const v = verdict(lawdb, "网络安全法", 21, AS_OF);
    assert.equal(v.state, CitationState.intercepted);
    assert.equal(v.matched_law_name, null);
    assert.ok(v.reasons.some((r: string) => r.startsWith("unknown_source:")));
  } finally {
    lawdb.close();
  }
});

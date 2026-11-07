/**
 * V13 第 38 批：法规库第四批 5 部全文（专利法 2020 修正、反垄断法 2022 修正、劳动合同法实施条例、反不正当竞争法 2025 修订、数据安全法），
 * 国家法律法规数据库官方 Word 文本逐条切分，与人大网 / 中国政府网 / 执法机关官网逐条比对（采集记录 research/2026-11-07-V13核心业务修复/lawdb-collect4/）。
 * 出题 W1（资产收购：专利转让、经营者集中）与 V10 V15 复核（经营者集中申报）用到的法源此前标“法规库未收录”。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { CitationState } from "@zr-legal/domain";
import { citationsVerify, extractCitations } from "../src/tools/tools/citations.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const pub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;

test("第四批 5 部可核验；实施条例只按书名号形态识别，不被认成劳动合同法的同号条文", () => {
  const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: pub });
  try {
    const v = (text: string) => citationsVerify(lawdb, { text, as_of: "2026-11-07" }).verdicts[0]!;
    for (const t of ["《专利法》第十条", "《反垄断法》第二十六条", "《劳动合同法实施条例》第十九条", "《反不正当竞争法》第十条", "《数据安全法》第二十一条"]) {
      const r = v(t);
      assert.notEqual(r.state, CitationState.intercepted, `${t}：${JSON.stringify(r)}`);
    }
    assert.equal(v("《专利法》第八十三条").state, CitationState.intercepted, "专利法只有 82 条");
    assert.equal(extractCitations("依据劳动合同法实施条例第十九条第（三）项").some((c) => c.law === "劳动合同法" && c.article === 19), false);
  } finally {
    lawdb.close();
  }
});

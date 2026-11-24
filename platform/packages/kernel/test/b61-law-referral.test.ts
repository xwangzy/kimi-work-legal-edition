/**
 * 第 61 批（V35，D-259）law.get_article 转介与例外提示：条文含“另有规定的除外 / 依照其规定 / 参照适用 / 但是”时，
 * 单看这一条下不了结论，返回里点出 referral 与 referral_note，让助手先查被转介或优先的规定、核对但书。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { lawGetArticle, referralCues, REFERRAL_NOTE } from "../src/tools/tools/law.ts";
import { LAWDB_SHIPPED } from "./helpers.ts";

const signerPub = JSON.parse(readFileSync(fileURLToPath(new URL("../../../content/keys/content-signing-dev.pub.json", import.meta.url)), "utf8")).publicKeyPem;
const lawdb = openLawdb(LAWDB_SHIPPED, { expectedSignerPubPem: signerPub });

test("转介用语识别", () => {
  assert.ok(referralCues("本法或者其他法律没有明文规定的合同，适用本编通则的规定，并可以参照适用本编或者其他法律最相类似合同的规定。").some((l) => l.startsWith("参照适用")));
  assert.ok(referralCues("当事人对合同变更的内容约定不明确的，推定为未变更。法律另有规定的，依照其规定。").some((l) => l.startsWith("另有规定") || l.startsWith("依照")));
  assert.ok(referralCues("出卖人应当按照约定的期限交付标的物。但是，当事人另有约定的除外。").some((l) => l.startsWith("但书")));
  assert.deepEqual(referralCues("当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。"), []);
});

test("law.get_article：民法典第四百六十七条（无名合同参照适用）返回转介提示；第五百七十七条不给", () => {
  const a = lawGetArticle(lawdb, { law: "中华人民共和国民法典", article: 467, as_of: "2026-11-24" });
  assert.equal(a.found, true);
  assert.ok(a.referral && a.referral.length > 0, JSON.stringify(a.referral));
  assert.equal(a.referral_note, REFERRAL_NOTE);
  const b = lawGetArticle(lawdb, { law: "中华人民共和国民法典", article: 577, as_of: "2026-11-24" });
  assert.equal(b.found, true);
  assert.equal(b.referral, undefined);
});

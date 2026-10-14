/**
 * 阶段 4 审查 S4-02 / S4-07 / S4-09 的回归：实体筛查容忍写法变体（简称与字号、插空格、零宽字符、繁体、全角拉丁、合同中的“以下简称”），
 * 检索式与 URL 中的事项代号，URL 的多重编码与 IDN 主机名标签，IPv6 保留段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, deriveOrgAliases, extractDefinedAliases, foldText } from "@zr-legal/tokenizer";
import { screenSearchQuery, type SearchContext } from "../src/search-guard.ts";
import { checkUrlStatic, isPublicAddress } from "../src/url-guard.ts";

const parties = [
  { name: "华为技术有限公司", kind: "org" as const },
  { name: "ABC科技有限公司", kind: "org" as const },
  { name: "北京字节跳动科技有限公司", kind: "org" as const },
  { name: "张三", kind: "person" as const },
];
const tz = () => new MatterTokenizer({ matterKey: Buffer.alloc(32, 3), parties });
const ctx = (o: Partial<SearchContext> = {}): SearchContext => ({ dataLevel: "L2", basisComplete: true, preauthorizedGeneralize: false, tokenizer: tz(), ...o });

test("S4-02 检索：当事人的简称、字号、插空格、零宽字符、繁体、全角拉丁写法一律命中（L2 未预授权即拒绝）", () => {
  for (const q of [
    "华为公司 股权转让纠纷",
    "华为 股权转让 判例",
    "华为 技术有限公司 股东出资",
    "华为​技术有限公司 股东出资",
    "華為技術有限公司 股东出资",
    "ＡＢＣ科技有限公司 违约",
    "abc科技有限公司 违约",
    "字节跳动 劳动争议",
    "张 三 民间借贷",
    "張三 民间借贷",
    "张­三 借款",
  ]) {
    const v = screenSearchQuery(q, ctx());
    assert.equal(v.decision, "deny", `应命中：${JSON.stringify(q)}`);
  }
  // 不含当事人的一般性查询照常放行（字号派生不得过泛：“中国银行”类通名不派生成“银行”）
  assert.equal(screenSearchQuery("股东未实缴出资 补足责任 判例", ctx()).decision, "pass");
  assert.ok(!deriveOrgAliases("中国银行股份有限公司").includes("银行"));
  assert.deepEqual(deriveOrgAliases("华为技术有限公司"), ["华为技术", "华为"]);
  // 预授权泛化：变体写法也被泛化，原文不发出
  const g = screenSearchQuery("華為技術有限公司 股东出资", ctx({ preauthorizedGeneralize: true }));
  assert.ok(g.decision === "generalized" && !/華為|华为/.test(g.sent), JSON.stringify(g));
});

test("S4-02 合同中的简称定义：“全称（以下简称“X”）”中的 X 作为别名进词典；角色词不作别名", () => {
  const text = "甲方：华为技术有限公司（以下简称“华技”），乙方：张三（以下简称“乙方”）；出借人张三（以下简称“张先生”）。";
  const found = extractDefinedAliases(text, ["华为技术有限公司", "张三"]);
  assert.deepEqual(
    found.map((x) => `${x.name}→${x.alias}`),
    ["华为技术有限公司→华技", "张三→张先生"],
  );
  const t = new MatterTokenizer({ matterKey: Buffer.alloc(32, 3), parties: [{ name: "华为技术有限公司", kind: "org", aliases: ["华技"] }] });
  assert.equal(screenSearchQuery("华技 合同纠纷", { dataLevel: "L2", basisComplete: true, preauthorizedGeneralize: false, tokenizer: t }).decision, "deny");
});

test("S4-02/S4-25 令牌化：词典中的自然人以繁体、插空格写法出现同样替换（不留明文）；插空格写法与词典写法同一代号，繁体写法另有代号、还原逐字等于原文字形", () => {
  const t = tz();
  const a = t.tokenize("出借人张三签字。");
  const spaced = t.tokenize("出借人张 三签字。");
  const trad = t.tokenize("出借人張 三签字。");
  assert.ok(!trad.text.includes("張") && !trad.text.includes("三签"), trad.text);
  const tokA = a.entries.find((e) => e.category === "person")!.token;
  assert.ok(spaced.text.includes(tokA), "插空格写法与词典写法同一代号");
  assert.ok(!trad.text.includes(tokA), "繁体写法另有代号（终核 S4-25）");
  assert.equal(trad.entries.find((e) => e.category === "person")!.value, "張 三");
  assert.equal(foldText("張 三"), foldText("张三"), "比较折叠仍把繁体与简体视为同一当事人（检索、URL 筛查）");
});

test("S4-07 检索式中的事项代号：自然人/机构代号视同实体（L2 未预授权拒绝；预授权泛化为某人/某公司）；标识符代号去除", () => {
  assert.equal(screenSearchQuery("〔自然人·K7Q2MX〕 民间借贷 判决", ctx()).decision, "deny");
  const g = screenSearchQuery("〔自然人·K7Q2MX〕 民间借贷 判决", ctx({ preauthorizedGeneralize: true }));
  assert.ok(g.decision === "generalized" && g.sent.startsWith("某人") && !g.sent.includes("〔"));
  const ids = screenSearchQuery("账户 〔账号·ABCDEF〕 冻结 程序", ctx());
  assert.ok(ids.decision === "pass" && !ids.sent.includes("〔"), JSON.stringify(ids));
});

test("S4-09 URL：多重百分号编码、IDN 主机名标签、全角与零宽写法、事项代号一律拦截", () => {
  const t = tz();
  const once = encodeURIComponent("张三");
  const twice = encodeURIComponent(once);
  for (const [url, reason] of [
    [`https://www.court.gov.cn/s?q=${twice}`, "party_entity_in_url"],
    ["https://张三.court.gov.cn/", "party_entity_in_url"],
    [`https://www.court.gov.cn/s?q=${encodeURIComponent("ＡＢＣ科技有限公司")}`, "party_entity_in_url"],
    [`https://www.court.gov.cn/s?q=${encodeURIComponent("张​三")}`, "party_entity_in_url"],
    [`https://www.court.gov.cn/s?q=${encodeURIComponent("〔自然人·ABCDEF〕")}`, "token_in_url"],
  ] as const) {
    const v = checkUrlStatic(url, t);
    assert.equal(v.ok, false, url);
    const got = !v.ok ? v.reason : "";
    // 词典中的自然人既是当事人实体也是人名：两种原因码都表示拦截
    assert.ok(got === reason || (reason === "party_entity_in_url" && got === "person_name_in_url"), `${url} → ${got}`);
  }
  assert.equal(checkUrlStatic("https://www.court.gov.cn/paper/123.html", t).ok, true);
});

test("S4-09 IPv6：IPv4 兼容地址、NAT64 本地前缀、Teredo 不是公网地址", () => {
  for (const ip of ["::7f00:1", "::127.0.0.1", "64:ff9b:1::a00:1", "2001:0:4136:e378:8000:63bf:3fff:fdd2"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("2400:3200::1"), true);
  assert.equal(isPublicAddress("8.8.8.8"), true);
});

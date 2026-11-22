/**
 * V10 第 36 批（11-03 拍板 B）：地址只换乡镇街道、道路与门牌，省、市、区县留在原文。
 * 第 35 批真实走查 R4：原告住所整体换成〔地址〕，助手判断不了被告住所地与协议管辖法院，只能请律师补法院全称。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findIdentifiers, adminPrefixLength } from "../src/patterns.ts";
import { MatterTokenizer, restoreTokens } from "../src/index.ts";

const addr = (s: string) => findIdentifiers(s).filter((h) => h.category === "address").map((h) => h.value);

test("地址：省、市、区县留在原文，乡镇街道以下换成代号", () => {
  const cases: [string, string, string][] = [
    ["住所：浙江省宁波市北仑区新碶街道明州路388号", "浙江省宁波市北仑区", "新碶街道明州路388号"],
    // 第 58 批（D-240）：门牌后的楼栋保留原文
    ["住所：上海市浦东新区蔡伦路780号5幢", "上海市浦东新区", "蔡伦路780号"],
    ["住所：常州市新北区春江镇锦绣路18号", "常州市新北区", "春江镇锦绣路18号"],
    ["主要经营场所苏州工业园区星湖街328号", "苏州工业园区", "星湖街328号"],
    ["住址：河北省保定市清苑区东闾乡王庄村三组。", "河北省保定市清苑区", "东闾乡王庄村三组"],
    ["住所：上海市南京西路1266号", "上海市", "南京西路1266号"],
  ];
  for (const [text, kept, replaced] of cases) {
    assert.deepEqual(addr(text), [replaced], text);
    const r = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], fullPseudonym: false } as any).tokenize(text);
    assert.ok(r.text.includes(kept), `区划应留在原文：${r.text}`);
    assert.ok(!r.text.includes(replaced), `街道门牌应换成代号：${r.text}`);
    assert.match(r.text, /〔地址·[0-9A-Z]{6}〕/);
  }
});

test("地址：以“区”结尾的小区、社区不当区县保留；只有区划没有街道门牌的整段照旧", () => {
  assert.deepEqual(addr("原告王某住翠湖花园3幢2单元。"), ["翠湖花园"], "第 58 批：楼栋单元保留原文");
  assert.deepEqual(addr("住阳光小区5栋。"), ["阳光小区"], "“阳光小区”不是区县；楼栋保留原文");
  assert.equal(adminPrefixLength("阳光小区5栋"), 0);
  assert.equal(adminPrefixLength("北京市朝阳区"), 0, "剩下不足 3 字不保留");
  assert.equal(adminPrefixLength("北京市阳光小区5栋"), 3, "只留“北京市”");
});

test("地址前的场所引导词（主要经营场所、注册地址、送达地址）不并进代号", () => {
  assert.deepEqual(addr("送达地址：杭州市西湖区文三路90号12层"), ["文三路90号"]);
  assert.deepEqual(addr("注册地址：北京市海淀区上地十街10号7层"), ["上地十街10号"]);
  const r = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], fullPseudonym: false } as any).tokenize("主要经营场所苏州工业园区星湖街328号");
  assert.ok(r.text.startsWith("主要经营场所苏州工业园区〔地址·"), r.text);
});

test("地址：全角、半角括号内的楼栋与房号——门牌之后的整段保留原文（第 58 批 D-240），其余照旧一起替换，原样还原", () => {
  // [保留的区划, 换成代号的部分, 门牌之后保留原文的楼栋房号]
  const cases: [string, string, string][] = [
    ["上海市浦东新区", "张江路1288号", "（3幢）501室"],
    ["北京市朝阳区", "建国路88号院", " ( ２ 号楼 ) 1203室"],
    ["成都市锦江区", "翠湖华庭二期（三栋2单元）701室", ""],
    ["杭州市西湖区", "文三路（90号A座）2层（501室）", ""],
    ["", "翠湖花园", "（A座）501室"],
  ];
  for (const [kept, replaced, tail] of cases) {
    const text = `住址：${kept}${replaced}${tail}（仅供送达）。`;
    assert.deepEqual(addr(text), [replaced], text);
    const tokenizer = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], table: [], fullPseudonym: false });
    const result = tokenizer.tokenize(text);
    const esc = tail.replace(/[()（）]/g, (c) => `\\${c}`);
    assert.match(result.text, new RegExp(`^住址：${kept}〔地址·[0-9A-Z]{6}〕${esc}（仅供送达）。$`), result.text);
    assert.deepEqual(restoreTokens(result.text, result.entries), { text, restored: 1, unknown: [] });
  }
  assert.deepEqual(addr("北京市朝阳区（另行通知）；附件（3栋）。"), []);
  assert.deepEqual(addr("住所：北京市朝阳区建国路88号（工作日9时到访）。"), ["建国路88号"]);
});

test("同一门牌的两处地址（一处带楼栋）得到同一个代号：跨主体同址的线索留得住（第 58 批 D-240）", () => {
  const t = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], table: [], fullPseudonym: false });
  const r = t.tokenize("原告住所：浙江省嘉兴市秀洲区亚太路1288号。受托方住所：浙江省嘉兴市秀洲区亚太路1288号3幢。");
  const toks = r.text.match(/〔地址·[0-9A-Z]{6}〕/g) ?? [];
  assert.equal(toks.length, 2, r.text);
  assert.equal(toks[0], toks[1], r.text);
  assert.ok(r.text.includes(`${toks[0]}3幢`), r.text);
  assert.ok(!r.text.includes("亚太路"), r.text);
});

/**
 * V10 第 36 批（11-03 拍板 B）：地址只换乡镇街道、道路与门牌，省、市、区县留在原文。
 * 第 35 批真实走查 R4：原告住所整体换成〔地址〕，助手判断不了被告住所地与协议管辖法院，只能请律师补法院全称。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findIdentifiers, adminPrefixLength } from "../src/patterns.ts";
import { MatterTokenizer } from "../src/index.ts";

const addr = (s: string) => findIdentifiers(s).filter((h) => h.category === "address").map((h) => h.value);

test("地址：省、市、区县留在原文，乡镇街道以下换成代号", () => {
  const cases: [string, string, string][] = [
    ["住所：浙江省宁波市北仑区新碶街道明州路388号", "浙江省宁波市北仑区", "新碶街道明州路388号"],
    ["住所：上海市浦东新区蔡伦路780号5幢", "上海市浦东新区", "蔡伦路780号5幢"],
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
  assert.deepEqual(addr("原告王某住翠湖花园3幢2单元。"), ["翠湖花园3幢2单元"]);
  assert.deepEqual(addr("住阳光小区5栋。"), ["阳光小区5栋"], "“阳光小区”不是区县");
  assert.equal(adminPrefixLength("阳光小区5栋"), 0);
  assert.equal(adminPrefixLength("北京市朝阳区"), 0, "剩下不足 3 字不保留");
  assert.equal(adminPrefixLength("北京市阳光小区5栋"), 3, "只留“北京市”");
});

test("地址前的场所引导词（主要经营场所、注册地址、送达地址）不并进代号", () => {
  assert.deepEqual(addr("送达地址：杭州市西湖区文三路90号12层"), ["文三路90号12层"]);
  assert.deepEqual(addr("注册地址：北京市海淀区上地十街10号7层"), ["上地十街10号7层"]);
  const r = new MatterTokenizer({ matterKey: randomBytes(32), parties: [], fullPseudonym: false } as any).tokenize("主要经营场所苏州工业园区星湖街328号");
  assert.ok(r.text.startsWith("主要经营场所苏州工业园区〔地址·"), r.text);
});

/**
 * 自然人姓名识别召回（第 04 篇 §11 P6：“自然人姓名识别召回在合成测试集上报告（漏识别如实列出）”；第 06 篇 R14）。
 *
 * 合成集：确定性伪随机生成的姓名（姓氏表 × 常见名字用字，不对应真实人物）放进典型法律文书语境；每类语境分别统计召回，
 * 漏识别逐条列出。阈值只约束“有上下文”的类别；“无上下文、不在词典”的类别是已知盲区，只报告不设阈值——这正是方案要求
 * L3a 事项人工核对当事人词典的原因。另测机构名称（以姓氏字开头）不被误判为自然人。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer } from "../src/index.ts";

/** 确定性 PRNG（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = [..."王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦方白邹孟熊秦邱江尹薛段雷侯龙史陶黎贺顾毛郝龚邵万钱严武戴莫孔汤常温康施牛樊葛邢齐易乔伍庞颜倪庄聂章鲁岳翟殷詹耿关焦俞左柳甘祝包宁尚舒阮柯纪梅童凌毕季裴霍涂苗谷盛曲翁骆蓝游辛靳管柴鲍华喻祁房滕屈饶牟艾"];
const COMPOUNDS = ["欧阳", "司马", "上官", "诸葛", "皇甫", "慕容", "令狐", "司徒"];
const GIVEN = [..."伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉兰萍红鹏辉建斌宇浩凯健俊帆帅旭宁玲婷雪琳晶颖倩琪蕾薇志国峰波晨阳欣怡佳慧梓涵子轩雨萱思远嘉懿博文"];

function makeName(r: () => number): string {
  const compound = r() < 0.06;
  const s = compound ? COMPOUNDS[Math.floor(r() * COMPOUNDS.length)]! : SURNAMES[Math.floor(r() * SURNAMES.length)]!;
  const len = r() < 0.55 ? 2 : 1;
  let g = "";
  for (let i = 0; i < len; i++) g += GIVEN[Math.floor(r() * GIVEN.length)]!;
  return s + g;
}

type Case = { kind: string; text: (n: string, m: string) => string; names: (n: string, m: string) => string[] };

const CASES: Case[] = [
  { kind: "角色词+冒号", text: (n) => `原告：${n}，男，1985年3月2日出生，汉族。`, names: (n) => [n] },
  { kind: "角色词+冒号", text: (n) => `被申请人：${n}，女，住所地略。`, names: (n) => [n] },
  { kind: "角色词+冒号", text: (n) => `委托代理人：${n}，某律师事务所律师。`, names: (n) => [n] },
  { kind: "角色词+括注", text: (n) => `被告（反诉原告）：${n}，男。`, names: (n) => [n] },
  { kind: "角色词直接接名", text: (n) => `法定代表人${n}，执行董事。`, names: (n) => [n] },
  { kind: "角色词直接接名", text: (n) => `证人${n}出庭作证称，其于当日在场。`, names: (n) => [n] },
  { kind: "角色词直接接名", text: (n) => `出借人${n}向借款人转账五万元。`, names: (n) => [n] },
  { kind: "角色词+序号", text: (n, m) => `被告一：${n}；被告二：${m}。`, names: (n, m) => [n, m] },
  { kind: "称谓", text: (n) => `我所已与${n}律师电话沟通。`, names: (n) => [n] },
  { kind: "称谓", text: (n) => `${n}女士表示同意调解方案。`, names: (n) => [n] },
  { kind: "称谓", text: (n) => `本案由${n}法官独任审理。`, names: (n) => [n] },
  { kind: "传播（同文有上下文）", text: (n) => `申请人：${n}。${n}于2023年入职，${n}主张加班费。`, names: (n) => [n, n, n] },
  { kind: "无上下文且不在词典（已知盲区）", text: (n, m) => `${n}和${m}在餐厅见面并签署了协议。`, names: (n, m) => [n, m] },
  { kind: "言语/行为动词", text: (n) => `据${n}回忆，货物于当天送达。`, names: (n) => [n] },
  { kind: "言语/行为动词", text: (n) => `另查明，${n}证实该笔款项系借款。`, names: (n) => [n] },
  { kind: "言语/行为动词", text: (n) => `庭审中，${n}辩称其已还清全部欠款。`, names: (n) => [n] },
];

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

test("自然人姓名识别召回：有上下文的语境 ≥ 95%，词典 100%；无上下文且不在词典的姓名如实报告为盲区", () => {
  const r = rng(20261012);
  const stats = new Map<string, { total: number; hit: number; misses: string[] }>();
  const add = (kind: string, total: number, hit: number, miss?: string) => {
    const s = stats.get(kind) ?? { total: 0, hit: 0, misses: [] };
    s.total += total;
    s.hit += hit;
    if (miss && s.misses.length < 12) s.misses.push(miss);
    stats.set(kind, s);
  };
  for (let round = 0; round < 40; round++) {
    for (const c of CASES) {
      const n = makeName(r);
      let m = makeName(r);
      while (m === n || m.includes(n) || n.includes(m)) m = makeName(r);
      const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9) });
      const text = c.text(n, m);
      const out = tz.tokenize(text).text;
      const expected = c.names(n, m);
      const uniq = [...new Set(expected)];
      for (const name of uniq) {
        const want = countOccurrences(text, name);
        const left = countOccurrences(out, name);
        add(c.kind, want, want - left, left > 0 ? `${name}｜${text}` : undefined);
      }
    }
  }
  // 词典：任何语境都替换
  {
    const r2 = rng(7);
    let total = 0;
    let hit = 0;
    for (let i = 0; i < 200; i++) {
      const n = makeName(r2);
      const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9), parties: [{ name: n, kind: "person" }] });
      const text = `${n}和对方在餐厅见面；次日${n}付款。`;
      const out = tz.tokenize(text).text;
      total += 2;
      hit += 2 - countOccurrences(out, n);
    }
    add("当事人词典", total, hit);
  }
  // 词典 + 版面折行（阶段 4 终核核验 S4-27）：姓名被单个换行（含 \r\n、前后空格）断开，照常替换
  {
    const r3 = rng(11);
    let total = 0;
    let hit = 0;
    const misses: string[] = [];
    const breaks = ["\n", "\r\n", " \n", "\n　"];
    for (let i = 0; i < 200; i++) {
      const n = makeName(r3);
      const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9), parties: [{ name: n, kind: "person" }] });
      const chars = [...n];
      const cut = 1 + (i % (chars.length - 1));
      const wrapped = `${chars.slice(0, cut).join("")}${breaks[i % breaks.length]}${chars.slice(cut).join("")}`;
      const text = `原告：${wrapped}，男，汉族。`;
      const out = tz.tokenize(text).text;
      total += 1;
      if (out.includes(wrapped)) misses.push(JSON.stringify(wrapped));
      else hit += 1;
    }
    add("当事人词典（版面折行断开）", total, hit, misses[0]);
  }
  const report: string[] = [];
  for (const [kind, s] of stats) {
    report.push(`${kind}：召回 ${((100 * s.hit) / s.total).toFixed(1)}%（${s.hit}/${s.total}）${s.misses.length ? `；漏识别示例：${s.misses.join(" / ")}` : ""}`);
  }
  console.log(`[姓名识别召回报告]\n${report.join("\n")}`);
  for (const [kind, s] of stats) {
    const recall = s.hit / s.total;
    if (kind.includes("已知盲区")) continue;
    if (kind.startsWith("当事人词典")) assert.equal(recall, 1, kind);
    else assert.ok(recall >= 0.95, `${kind} 召回 ${recall}`);
  }
});

test("不误判：以姓氏字开头的机构名称、常见词不被替换为自然人代号（默认保留机构名称）", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9) });
  const text = [
    "被告：张家港市华盛机械有限公司，住所地略。",
    "原告王府井百货集团股份有限公司诉称。",
    "第三人：江苏银行股份有限公司南京分行。",
    "由项目经理负责现场管理，公司法务出具意见。",
    "申请人：黄河水利委员会。",
    "经查，银行称该账户已冻结；物业表示设备需停机。",
  ].join("\n");
  const out = tz.tokenize(text).text;
  for (const org of ["张家港市华盛机械有限公司", "王府井百货集团股份有限公司", "江苏银行股份有限公司南京分行", "项目经理", "公司法务", "黄河水利委员会", "银行称", "物业表示"]) {
    assert.ok(out.includes(org), `误替换：${org}\n${out}`);
  }
});

test("误替换率报告：一组不含自然人姓名的常见法律文书句子（只报告，不设阈值；误替换只影响可读性，界面与交付件会还原）", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 9) });
  const sentences = [
    "本院认为，双方签订的买卖合同系真实意思表示，合法有效。",
    "被告辩称其已按约交付货物，不应承担违约责任。",
    "经审理查明，2023年5月1日双方签订《房屋租赁合同》。",
    "原告主张的违约金过高，本院依法予以调整。",
    "高温天气持续，施工方表示工期需顺延。",
    "金额以银行流水为准，利息按年利率3.65%计算。",
    "江苏省高级人民法院二审维持原判。",
    "公司章程约定，股东会会议由董事会召集。",
    "方案经董事会审议通过后报股东会批准。",
    "关于管辖权异议，本院裁定驳回。",
    "周末加班费按照劳动合同约定的标准支付。",
    "石油化工企业应当履行安全生产主体责任。",
    "海关总署公告称，相关商品自即日起适用新税率。",
    "文书送达后，当事人应当在十五日内提出上诉。",
    "宋体小四号字，行距固定值二十磅。",
  ];
  let fp = 0;
  const shown: string[] = [];
  for (const s of sentences) {
    const r = tz.tokenize(s);
    if (r.counts.person) {
      fp += r.counts.person;
      shown.push(r.text);
    }
  }
  console.log(`[误替换报告] ${sentences.length} 句中误替换 ${fp} 处${shown.length ? `：${shown.join(" / ")}` : ""}`);
});

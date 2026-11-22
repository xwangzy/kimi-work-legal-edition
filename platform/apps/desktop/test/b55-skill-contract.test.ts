// 第 55 批：场景卡 ↔ 方法（SKILL.md）契约（审计 A 的 P1-4、P1-5）。
//
// ① 参数名：开始面板会作为“方法参数”传出的字段键（不标 goalOnly、键为小写字母与下划线），卡上固定参数 args，
//    以及按勾选材料补的参数（docArgsFor），都要在对应方法 frontmatter 的 arguments 里声明——方法正文用“方法参数 `键名`”引用（第 56 批前是 `$键名`），
//    没声明的参数模型只能自己猜对应。另核一次项数不超过内核上限（方法参数至多 8 项，packages/kernel/src/api/index.ts）。
// ② 交付物：卡片“你得到什么”（gets）与方法 outputs 的判定规则——
//    a. 名称归一：文件名后的括注说明去掉（“证据目录.xlsx（附件）”→“证据目录.xlsx”）；“修订说明（致客户 / 致对方）.docx”
//       展开成两项；不带扩展名的条目按词干比（去掉扩展名与末尾括注：“提交前核对清单（附件）”→“提交前核对清单”）。
//    b. 主交付物必须一致：卡上 primary（没写取 outputs 第一项）与 primaryBy 的每个取值都要出现在 gets 里。
//    c. gets 里写了 .docx / .xlsx 的条目，必须是方法 outputs 里的文件（不能写方法不出的文件名）。
//    d. gets 里不带扩展名、却像交付文件的条目（以“表”“清单”“目录”结尾），词干要对得上某项 outputs；
//       其余不带扩展名的条目（“逐条审查意见（在审查工作台逐项决定）”“内部通报要点（写在答复里）”）是说明，不核。
//    e. 方法只有一种用法时（用这个方法的卡主交付物相同、都没有 primaryBy 与固定参数 args），outputs 里的每个文件
//       都要在 gets 里出现；名称带“（可选）”的和不是文件的（风险卡、工作表）允许卡上不写。一个方法分几种模式出不同
//       交付物的（劳动争议、尽调、顾问答复、决议、修订说明……），卡只写本模式的交付物，不核这一条。
// 卡片侧已知要改的不一致先列进 KNOWN_CARD_GAPS 豁免；卡片改好后这里的条目会报“豁免已过时”，届时删掉对应条目。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS, docArgsFor, type ScenarioCard } from "../src/lib/scenarios.ts";

const SKILLS = fileURLToPath(new URL("../../../content/skills/", import.meta.url));
const skillText = (id: string) => readFileSync(`${SKILLS}${id}/SKILL.md`, "utf8").replace(/\r\n/g, "\n");
const list = (m: RegExpExecArray | null) => (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const argumentsOf = (id: string) => list(/^arguments:\s*\[([^\]]*)\]/m.exec(skillText(id)));
const outputsOf = (id: string) => list(/^\s{2}outputs:\s*\[(.*)\]\s*$/m.exec(skillText(id)));

const ARG_KEY = /^[a-z][a-z_]{0,31}$/;
const FILE = /\.(docx|xlsx)/;
const fileName = (s: string) => s.replace(/\.(docx|xlsx)（.*$/, ".$1");
const expand = (s: string): string[] => {
  const m = /^(.*)（([^（）]+?) \/ ([^（）]+?)）(\.(?:docx|xlsx))$/.exec(fileName(s));
  return m ? [`${m[1]}（${m[2]}）${m[4]}`, `${m[1]}（${m[3]}）${m[4]}`] : [fileName(s)];
};
const stem = (s: string) => s.replace(/\.(docx|xlsx).*$/, "").replace(/（[^（）]*）$/, "");
const optional = (s: string) => /可选/.test(s) || !FILE.test(s);

/** 卡片侧已知的不一致（卡 id + 问题），由改卡片的同事改 scenarios.ts 后删除。值是建议的改法。 */
const KNOWN_CARD_GAPS: Record<string, string> = {
  // 第 55 批：首轮查出的 8 张卡（庭审提纲、交割清单、交易法规研究、企业法务合同审核、两张函件卡、回稿重审、非诉访谈）都已改成与方法一致；
  // 以后新出现的不一致先在这里登记原因，再改卡片。
};

const cards = SCENARIOS.filter((c): c is ScenarioCard & { skill: string } => !!c.skill);

test("① 卡片会作为方法参数传出的字段键、固定参数、按材料补的参数，都在方法 arguments 里声明；项数不超过 8", () => {
  const bad: string[] = [];
  for (const c of cards) {
    const declared = argumentsOf(c.skill);
    const fieldKeys = c.fields.filter((f) => !(f as { goalOnly?: boolean }).goalOnly && ARG_KEY.test(f.key)).map((f) => f.key);
    const docKeys = Object.keys({ ...docArgsFor(c, ["a.docx", "b.docx"]), ...docArgsFor(c, ["a.docx"]) });
    const keys = [...new Set([...Object.keys(c.args ?? {}), ...fieldKeys, ...docKeys])];
    for (const k of keys) if (!declared.includes(k)) bad.push(`${c.id}：${k} 不在 ${c.skill} 的 arguments（${declared.join("、")}）里`);
    if (keys.length > 8) bad.push(`${c.id}：可能传出的方法参数 ${keys.length} 项，超过内核上限 8 项（长文本请标 goalOnly）`);
  }
  assert.deepEqual(bad, []);
});

test("① 本轮开始面板新加的管辖依据、财产保全已在起诉状方法声明；仲裁申请书声明财产保全", () => {
  assert.deepEqual(argumentsOf("pleading-draft"), ["court", "forum_basis", "preserve"]);
  assert.ok(argumentsOf("arbitration-application").includes("preserve"));
  // 第 56 批：正文写“方法参数 `k`”（上游会把 `$k` 按 Skill 工具 args 替换，没传就成空串；见 packages/kernel/test/b56-skill-params.test.ts）
  for (const k of ["court", "forum_basis", "preserve"]) assert.match(skillText("pleading-draft"), new RegExp(`方法参数 \`${k}\``), `正文引用方法参数 ${k}`);
});

function cardGaps(): string[] {
  const out: string[] = [];
  const bySkill = new Map<string, (ScenarioCard & { skill: string })[]>();
  for (const c of cards) bySkill.set(c.skill, [...(bySkill.get(c.skill) ?? []), c]);
  for (const c of cards) {
    const outs = outputsOf(c.skill);
    const outFiles = outs.filter((o) => FILE.test(o)).map(fileName);
    const gets = (c.gets ?? []).map(String);
    const getFiles = gets.filter((g) => FILE.test(g)).flatMap(expand);
    const getStems = gets.filter((g) => !FILE.test(g)).map(stem);
    const onCard = (o: string) => (FILE.test(o) ? getFiles.includes(fileName(o)) || getStems.includes(stem(o)) : getStems.includes(stem(o)));
    // b. 主交付物
    const primaries = [c.primary ?? outs[0]!, ...Object.values(c.primaryBy?.map ?? {})];
    for (const p of new Set(primaries)) if (!onCard(p)) out.push(`${c.id}｜主交付物不在卡上：${fileName(p)}`);
    // c. 卡上写的文件名
    for (const g of getFiles) if (!outFiles.includes(g)) out.push(`${c.id}｜卡上的文件不在方法交付物里：${g}`);
    // d. 像文件的说明条目
    for (const g of gets.filter((x) => !FILE.test(x) && /(表|清单|目录)$/.test(stem(x)))) {
      if (!outs.some((o) => stem(o) === stem(g))) out.push(`${c.id}｜卡上像文件的条目对不上方法交付物：${g}`);
    }
    // e. 单一用法的方法：非可选的文件交付物都要在卡上
    const siblings = bySkill.get(c.skill)!;
    const singleUse = siblings.every((s) => !s.primaryBy && !s.args && (s.primary ?? outs[0]) === (c.primary ?? outs[0]));
    if (singleUse) for (const o of outs) if (!optional(o) && !onCard(o) && !primaries.includes(o)) out.push(`${c.id}｜方法交付物卡上没写：${fileName(o)}`);
  }
  return out;
}

test("② 卡片“你得到什么”与方法 outputs 对得上（主交付物一致，规则见文件头注释）", () => {
  const gaps = cardGaps();
  const unexpected = gaps.filter((g) => !(g in KNOWN_CARD_GAPS));
  assert.deepEqual(unexpected, [], "新出现的卡片与方法交付物不一致");
  const stale = Object.keys(KNOWN_CARD_GAPS).filter((k) => !gaps.includes(k));
  assert.deepEqual(stale, [], "卡片已改好，请删掉 KNOWN_CARD_GAPS 里对应的豁免");
});

test("② 判定规则自检：括注、斜杠展开、词干比较与可选项", () => {
  assert.equal(fileName("证据目录.xlsx（附件）"), "证据目录.xlsx");
  assert.deepEqual(expand("修订说明（致客户 / 致对方）.docx"), ["修订说明（致客户）.docx", "修订说明（致对方）.docx"]);
  assert.equal(stem("提交前核对清单（答辩期、管辖异议、反诉）"), "提交前核对清单");
  assert.equal(stem("提交前核对清单.xlsx（附件）"), "提交前核对清单");
  assert.ok(optional("争点与风险表.xlsx（可选）") && optional("风险卡（审查工作台）") && !optional("举证质证顺序表.xlsx"));
});

test("方法正文：文书类方法把开始前已知的不再问、取舍并进论点确认；空事项先一次问清；律师口述的案情说明不进证据目录", () => {
  const agents = readFileSync(`${SKILLS}AGENTS.md`, "utf8");
  assert.match(agents, /【开工前已知】一节写明的事项，照写明的处理，不再问；开始时已填的优先于方法里的缺省口径/);
  assert.match(agents, /一次任务里打断律师以一次为宜/);
  assert.match(agents, /名为“案情说明（律师口述）”的材料是律师的陈述[^。]*不列进对外的证据目录，也不在对外文书里作为证据援引/);
  for (const id of ["pleading-draft", "arbitration-application", "defense-draft", "appeal-draft", "enforcement-application", "preservation-application", "agency-statement"]) {
    const t = skillText(id);
    assert.match(t, /开始时已填的不问，其余并进论点确认那一次/, id);
    assert.match(t, /不在提纲之前单独提问/, id);
    assert.doesNotMatch(t, /用提问工具\*\*一次问清，不超过 3 问\*\*（已知的不问）/, `${id}：不再在提纲之前单独“一次问清”`);
    // 守住的质量线：论点确认、条文核验、Word 交付的步骤还在
    assert.match(t, /outline\.submit/, id);
    assert.match(t, /citations\.verify/, id);
    assert.match(t, /docx\.render_report/, id);
    assert.match(t, /律师口述的案情说明/, id);
  }
  const p = skillText("pleading-draft");
  assert.match(p, /\*\*空事项\*\*：没有勾选材料、事项里没有事实、任务说明中也没有案情的，第一步就用提问工具一次问清/);
  assert.match(p, /不凭事项名称猜案由/);
  assert.match(p, /诉讼请求\*\*：任务说明中律师列了的，项目、顺序与互斥取舍照律师的写/);
  assert.match(p, /标“待测算”的按第 2 项算出暂计金额/);
  assert.match(p, /先判断专属管辖/, "专属管辖的判断没有因为少问而删掉");
  assert.match(p, /知识产权案件管辖权/);
  assert.match(p, /不要求律师提供真名或证件号/);
  const d = skillText("demand-letter");
  assert.match(d, /本方法没有论点确认步骤，这一次就是全部提问/);
  // 参考表与正文、内核口径一致（审计 A 的 P1-3）
  const ref = readFileSync(`${SKILLS}pleading-draft/references/civil-complaint-fields.md`, "utf8");
  assert.doesNotMatch(ref, /仅限律师确认的事实|【待确认】 \|/);
  assert.match(ref, /材料原文载明但未确认的事实（照写/);
});

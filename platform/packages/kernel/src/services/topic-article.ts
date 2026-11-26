/**
 * 条号与主题对照（第 65 批，V39，D-283；外部第二轮评估 R1、R4）。
 *
 * 引用核验只核“这部法有没有这一条、版本对不对”，不核这一条讲的是不是文书说的那件事。两类常见错误因此假通过（与 D-261 同类）：
 * 1. **司法解释正文里嵌着母法的旧条号**：财产保全规定第五条写“依照民事诉讼法第一百条规定责令申请保全人提供担保”——
 *    那是 2012 年修正本的条号，现行民事诉讼法第一百条是调解书，保全是第一百零三条。助手照抄进保全申请书，引用核验判“条文存在”。
 * 2. **修订后改号的法律凭记忆写旧号**：反不正当竞争法 2025 年修订后商业贿赂是第八条、商业秘密是第十条（原第七、九条，现第七条是混淆行为）；
 *    公司法 2023 年修订后出资证明书第五十五条、股东名册第五十六条、查阅权第五十七条、股权转让第八十四条、忠实勤勉第一百八十条。
 * 这里只收“同一句里出现主题词 + 该主题的旧条号”的组合，条文逐条对照法规库原文（见各条注释）；句子里写明了是旧版本或现行条号的不报。
 * 纯函数。
 */
import { cnToInt } from "../tools/tools/cn-numerals.ts";

interface TopicRule {
  /** 法名的写法（不含“解释”“规定”等司法解释名称） */
  law: RegExp;
  lawLabel: string;
  wrong: readonly number[];
  topic: RegExp;
  right: string;
  /** 是实体法修订（行为时可能适用旧法）：句子或段落写了旧版本、行为时的不报，提示语写明版本括注的写法 */
  substantive?: { amendedOn: string; oldVersion: string };
}

// 民事诉讼法：程序法适用程序进行时的现行本（2023 年修正，2024-01-01 施行）；条文均对照法规库 lsv_civil_procedure_2023
const CPL = /(?:中华人民共和国)?(?:民事诉讼法|民诉法)》?(?!\s*(?:的)?(?:司法)?解释)/;
const AUCL = /(?:中华人民共和国)?反不正当竞争法》?/;
const COMPANY = /(?:中华人民共和国)?公司法》?(?!\s*(?:的)?(?:司法)?解释|[（(]?[三四五]|若干)/;

const RULES: readonly TopicRule[] = [
  // 第一百零三条：诉讼中财产保全与担保；第一百零四条：诉前保全（第一百条是调解书、第一百零一条是可以不制作调解书的情形）
  { law: CPL, lawLabel: "民事诉讼法", wrong: [100, 101], topic: /保全/, right: "第一百零三条（诉讼中保全及担保）、第一百零四条（诉前保全）" },
  // 第二百三十六条：执行行为异议（财产保全规定第二十、二十六条仍写第二百二十五条）
  { law: CPL, lawLabel: "民事诉讼法", wrong: [225], topic: /执行行为|执行异议(?!之诉)|书面异议/, right: "第二百三十六条（执行行为异议）" },
  // 第二百三十八条：案外人异议（财产保全规定第二十七条仍写第二百二十七条）
  { law: CPL, lawLabel: "民事诉讼法", wrong: [227], topic: /案外人/, right: "第二百三十八条（案外人异议）" },
  // 第二百六十四条：迟延履行加倍支付债务利息（迟延履行利息解释第一条仍写第二百五十三条）
  { law: CPL, lawLabel: "民事诉讼法", wrong: [253], topic: /迟延履行/, right: "第二百六十四条（迟延履行期间的债务利息）" },
  // 第一百七十一条：上诉期；第一百二十八条：答辩期；第一百三十条：管辖权异议（2012 年修正本为第一百六十四、一百二十五、一百二十七条）
  { law: CPL, lawLabel: "民事诉讼法", wrong: [164], topic: /上诉/, right: "第一百七十一条（上诉期）" },
  { law: CPL, lawLabel: "民事诉讼法", wrong: [125], topic: /答辩/, right: "第一百二十八条（答辩期）" },
  { law: CPL, lawLabel: "民事诉讼法", wrong: [127], topic: /管辖/, right: "第一百三十条（管辖权异议与应诉管辖）" },
  // 反不正当竞争法（2025 年修订，2025-10-15 施行；lsv_anti_unfair_competition_law_2025）：第八条商业贿赂、第十条商业秘密；第七条是混淆行为
  { law: AUCL, lawLabel: "反不正当竞争法", wrong: [7], topic: /贿赂/, right: "第八条（商业贿赂）", substantive: { amendedOn: "2025-10-15", oldVersion: "2019年修正" } },
  { law: AUCL, lawLabel: "反不正当竞争法", wrong: [9], topic: /商业秘密/, right: "第十条（侵犯商业秘密）", substantive: { amendedOn: "2025-10-15", oldVersion: "2019年修正" } },
  // 公司法（2023 年修订，2024-07-01 施行；lsv_company_2023）：公司法解释（三）第十三、二十三条仍写旧条号
  { law: COMPANY, lawLabel: "公司法", wrong: [31], topic: /出资证明书/, right: "第五十五条（出资证明书）", substantive: { amendedOn: "2024-07-01", oldVersion: "2018年修正" } },
  { law: COMPANY, lawLabel: "公司法", wrong: [32], topic: /股东名册/, right: "第五十六条（股东名册）", substantive: { amendedOn: "2024-07-01", oldVersion: "2018年修正" } },
  { law: COMPANY, lawLabel: "公司法", wrong: [33], topic: /查阅|知情权/, right: "第五十七条（股东查阅、复制）", substantive: { amendedOn: "2024-07-01", oldVersion: "2018年修正" } },
  { law: COMPANY, lawLabel: "公司法", wrong: [71], topic: /股权转让|优先购买/, right: "第八十四条（股权转让与优先购买）", substantive: { amendedOn: "2024-07-01", oldVersion: "2018年修正" } },
  { law: COMPANY, lawLabel: "公司法", wrong: [147], topic: /忠实|勤勉/, right: "第一百八十条（忠实义务与勤勉义务）", substantive: { amendedOn: "2024-07-01", oldVersion: "2018年修正" } },
];

/** 句子里写明了是旧版本、现行条号或在转述司法解释原文的，不报 */
const EXPLAINED_RE = /现行|现为|即现|修正前|修订前|原第|原《|（原|\(原|2012年|2017年|2018年|2019年|行为时|时间效力|旧法/;

const NUM = "([一二三四五六七八九十百零〇两\\d]{1,8})";

export interface TopicArticleIssue {
  text: string;
  fix: string;
}

export function topicArticleIssues(text: string): TopicArticleIssue[] {
  const out: TopicArticleIssue[] = [];
  for (const sentence of text.split(/(?<=[。；;！？\n])/)) {
    if (EXPLAINED_RE.test(sentence)) continue;
    for (const r of RULES) {
      if (!r.topic.test(sentence)) continue;
      const re = new RegExp(`${r.law.source}\\s*第${NUM}条`, "g");
      for (const m of sentence.matchAll(re)) {
        const n = cnToInt(m[1]!);
        if (n === null || !r.wrong.includes(n)) continue;
        const fix = r.substantive
          ? `${r.lawLabel}已修订（${r.substantive.amendedOn} 施行），这句话讲的是“${sentence.match(r.topic)![0]}”，现行条号是${r.right}；所引是修订前的条号。适用的确是修订前的旧法（行为发生在 ${r.substantive.amendedOn} 之前）的，在条号后写明版本“（${r.substantive.oldVersion}）”，否则改为现行条号`
          : `现行${r.lawLabel}（2023 年修正）里，这句话讲的“${sentence.match(r.topic)![0]}”是${r.right}；所引第${m[1]}条是 2012 年修正本的条号（多见于照抄司法解释原文，如财产保全规定、迟延履行利息解释），现行第${m[1]}条讲的是别的事：改为现行条号`;
        out.push({ text: m[0].slice(0, 60), fix });
      }
    }
  }
  return out;
}

/**
 * 法规库里司法解释正文嵌着的母法旧条号（外部第二轮评估 R1，逐条对照库内原文）：law.get_article 取到这些条文时附注，
 * 助手照抄条文写进文书前就知道该写现行条号。键：law_id 与条号。
 */
const EMBEDDED: Record<string, string> = {
  "jud_property_preservation:5": "本条所称“民事诉讼法第一百条”是 2012 年修正本的条号，现行民事诉讼法（2023 年修正）对应的是第一百零三条（保全与担保）",
  "jud_property_preservation:20": "本条所称“民事诉讼法第二百二十五条”是 2012 年修正本的条号，现行对应第二百三十六条（执行行为异议）",
  "jud_property_preservation:26": "本条所称“民事诉讼法第二百二十五条”是 2012 年修正本的条号，现行对应第二百三十六条（执行行为异议）",
  "jud_property_preservation:27": "本条所称“民事诉讼法第二百二十七条”是 2012 年修正本的条号，现行对应第二百三十八条（案外人异议）",
  "jud_delayed_performance_interest:1": "本条所称“民事诉讼法第二百五十三条”是 2012 年修正本的条号，现行对应第二百六十四条（迟延履行期间的债务利息）",
  "jud_company_interp3:13": "本条所称“公司法第一百四十七条”是 2018 年修正本的条号，现行公司法（2023 年修订）对应第一百八十条（忠实义务与勤勉义务）",
  "jud_company_interp3:23": "本条所称“公司法第三十一条、第三十二条”是 2018 年修正本的条号，现行公司法（2023 年修订）对应第五十五条（出资证明书）、第五十六条（股东名册）",
};

export function embeddedRefNote(lawId: string, article: number | null | undefined): string | null {
  if (article === null || article === undefined) return null;
  return EMBEDDED[`${lawId}:${article}`] ?? null;
}

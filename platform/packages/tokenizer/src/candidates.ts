/**
 * 发送前二次检测：疑似未替换的自然人姓名（v9.2 R7；调研 Y5 §4.3 ②③，P1-11）。
 *
 * 对象是**已令牌化**的出站文字：规则识别（names.ts）漏掉的姓名在这里按上下文再找一遍，只提名、不替换。
 * 只报中、高两档（低档噪声太大，不打扰律师）；识别依据是规则识别**没有用到**的上下文：
 * - 高：表头写法——姓名后紧跟“，男/女”“（男/女”或身份证号说明（“王明，男，汉族”“王明（身份证号……）”）；
 * - 高：姓名后隔着标点与说明词直接是证件号、电话、账号或地址的代号（“王明，电话〔电话·…〕”）；
 * - 中：与已替换的自然人代号并列（“〔自然人·…〕与王明”“王明、〔自然人·…〕”）；
 * - 中：后接言语动词、前面紧跟单字动词（“经查王明表示”；规则识别要求前面是句首、标点或功能字，这种写法不认）；
 * 中档候选还须“像名字”（名里至少一个常见名字用字），名词并列与技术文字里的“姓氏字 + 普通字”由此排除。
 * 结果只在本机使用：闸门的去向记录只存计数；具体值只回给本机界面供律师核对（加入当事人词典后，后续发送即被替换）。
 * 召回与误报在独立评测集上报告（S8），不在此宣称。
 */
import { NAME_RULES, readName } from "./names.ts";
import { surnameAt } from "./surnames.ts";

export type SuspectConfidence = "high" | "medium";
export type SuspectCue = "gender_header" | "id_header" | "contact_token" | "beside_person_token" | "paired_names" | "speech_verb";

export interface SuspectedName {
  value: string;
  confidence: SuspectConfidence;
  cue: SuspectCue;
  /** 第一次出现的位置（出站文字内）。 */
  index: number;
}

const { STOP, COMMON_WORDS, FUNCTION_BEFORE, ORG_AFTER, CJK } = NAME_RULES;
const PERSON_TOKEN = /〔自然人·[0-9A-HJKMNP-TV-Z]{6,10}〕/g;
const ANY_TOKEN = /〔[^〔〕]{1,8}·[0-9A-HJKMNP-TV-Z]{6,10}〕/g;
const CONTACT_TOKEN_AFTER = /^[\s，,：:（(]{0,2}(?:电话|手机|联系电话|手机号|身份证号?|公民身份号码|证件号码?|账号|账户|卡号|住址|地址|住所)?[\s：:，,]{0,2}〔(?:证件号|电话|账号|地址)·/;
const GENDER_AFTER = /^(?:[，,]\s?[男女](?:[，,。；;、]|$)|[（(][男女][，,、）)])/;
const ID_AFTER = /^[，,（(]\s?(?:身份证号?|公民身份号码|身份证件号码)/;
const CONJ_BEFORE = /(?:与|和|及|同|、|，|,)\s?$/;
/** 常直接接人名的单字动词（规则识别的功能字表之外）。 */
const VERB_PREFIX = new Set([..."查问告令派约陪带送催称知"]);
/** 言语动词（只取“说了什么”一类；签署、确认、收到、要求等常接名词，不作依据）。 */
const SPEAK = ["辩称", "诉称", "述称", "声称", "表示", "回忆", "陈述", "证实", "承认", "否认", "认为", "主张", "反映", "介绍", "告知", "称", "说"];
/**
 * 常见名字用字（中档依据须至少含一个）：列举、名词并列与技术文字里“姓氏字 + 普通字”的组合（成果、解析、边界）由此排除。
 * 只影响提名的置信度、不影响替换；用字罕见的姓名在高档依据（表头、证件与联系方式代号）下仍会被报出。
 */
const GIVEN_CHARS = new Set([
  ..."伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉萍红鹏辉玲建国文斌宇浩凯健俊帆帅旭宁龙林欢阳佳晨婷雪琳晶颖倩蕾",
  ..."梅琴兰凤莉燕丹荣慧峰波亮飞彬鑫毅彤蓉薇菲璐瑶怡欣悦妍婕媛嫣娇嘉琪琦瑾瑜璇琼珊珍珠贞淑贤惠洁澜涵润泽",
  ..."海江河川山岩松柏桐楠榕梓杨柳枫桦森炎焱煜烨灿炜晖曦昊旻晟晓昕暄春夏秋冬晴虹霖霏露霜雯震雷云星辰",
  ..."东南正义仁礼智信忠孝德诚志远航腾达功胜福禄寿喜贵富康泰祥瑞吉庆乐怀思恩爱诗琴",
  ..."彪豪雄伦博学士元亨昌盛兴旺隆顺玮琛璋琰琨瑛璟珺珂玥瑗钰铭锦锋钧鸿鹤鹰麟骏驰骁",
  ..."永长青新晗笛竹筠菁芝芸芷茜茹荷莎莹萌蔚蓓蕊艺苒若萱紫翠碧",
  ..."娥婉婧婵姗姝姣姿威妮妤娅娴雅美俏可如意宏洪弘鸿童潼瞳",
  ..."立力利励俐礼亮良凌灵铃岭",
]);
const CONJ_AFTER = /^\s?(?:与|和|及|同|、)\s?〔自然人·/;
const BOUND = /[\s，。；：、“”"‘’（）()！？!?,.;:]/;
/** 并列姓名之后常见的字词（“……在餐厅见面”“……共同签署”“……于某日”）。 */
const PAIR_AFTER = /^(?:在|于|共同|一起|双方|二人|两人|均|都|分别|签|见|到|约|是|为|系|已|曾|向|对|将|把|被|作|出)/;

/** 在 k 处结束的姓名（姓氏 + 1–2 字，复姓各加 1）；不像姓名返回 null。 */
function nameEndingAt(text: string, k: number): { start: number; value: string } | null {
  for (const len of [4, 3, 2]) {
    const j = k - len;
    if (j < 0) continue;
    const s = surnameAt(text, j);
    if (s === 0 || len - s < 1 || len - s > 2) continue;
    // 较长候选的“姓氏”其实是前一个词的功能字或动词（“和王明”“经查王明”的“查”）：放弃较长候选
    if (s === 1 && (FUNCTION_BEFORE.has(text[j]!) || VERB_PREFIX.has(text[j]!)) && surnameAt(text, j + 1) > 0) continue;
    const given = text.slice(j + s, k);
    if (![...given].every((c) => CJK.test(c) && !STOP.has(c))) continue;
    if (COMMON_WORDS.has(text.slice(j, j + 2)) || COMMON_WORDS.has(text.slice(j + s, j + s + 2))) continue;
    return { start: j, value: text.slice(j, k) };
  }
  return null;
}

/** 代号所占的区间（候选不得与之重叠）。 */
function tokenSpans(text: string): [number, number][] {
  const out: [number, number][] = [];
  ANY_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(ANY_TOKEN)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** 中档候选须像名字：名（去掉姓氏）至少含一个常见名字用字。 */
function nameLike(value: string): boolean {
  const s = surnameAt(value, 0);
  return [...value.slice(s)].some((c) => GIVEN_CHARS.has(c));
}

export function suspectedNames(text: string): SuspectedName[] {
  if (!text || !/[一-龥]/.test(text)) return [];
  const spans = tokenSpans(text);
  const inToken = (a: number, b: number) => spans.some(([s, e]) => a < e && b > s);
  const found = new Map<string, SuspectedName>();
  const add = (start: number, value: string, confidence: SuspectConfidence, cue: SuspectCue) => {
    const end = start + value.length;
    if (inToken(start, end)) return;
    if (ORG_AFTER.test(text.slice(end))) return;
    if (confidence === "medium" && !nameLike(value)) return;
    const prev = found.get(value);
    if (!prev || (prev.confidence === "medium" && confidence === "high")) found.set(value, { value, confidence, cue, index: prev ? Math.min(prev.index, start) : start });
  };

  // 高：表头写法（姓名后紧跟性别或身份证号说明）——在每个“，男/（女/，身份证”之前找姓名
  for (const re of [/[，,（(]\s?[男女](?=[，,。；;、）)]|$)/g, /[，,（(]\s?(?:身份证号?|公民身份号码|身份证件号码)/g]) {
    for (const m of text.matchAll(re)) {
      const n = nameEndingAt(text, m.index!);
      if (!n) continue;
      const after = text.slice(m.index!);
      if (GENDER_AFTER.test(after)) add(n.start, n.value, "high", "gender_header");
      else if (ID_AFTER.test(after)) add(n.start, n.value, "high", "id_header");
    }
  }

  // 高：姓名后直接是证件号、电话、账号、地址的代号
  for (const m of text.matchAll(/〔(?:证件号|电话|账号|地址)·/g)) {
    // 往前退过说明词与标点，找到姓名的结尾
    const head = text.slice(Math.max(0, m.index! - 16), m.index!);
    const stripped = head.replace(/[\s，,：:（(]{0,2}(?:电话|手机|联系电话|手机号|身份证号?|公民身份号码|证件号码?|账号|账户|卡号|住址|地址|住所)?[\s：:，,]{0,2}$/, "");
    // 姓名与代号之间可以什么都没有（“王明〔电话·…〕”）
    const k = m.index! - (head.length - stripped.length);
    const n = nameEndingAt(text, k);
    if (n && CONTACT_TOKEN_AFTER.test(text.slice(k))) add(n.start, n.value, "high", "contact_token");
  }

  // 中：与已替换的自然人代号并列
  PERSON_TOKEN.lastIndex = 0;
  for (const m of text.matchAll(PERSON_TOKEN)) {
    const end = m.index! + m[0].length;
    const tail = /^\s?(?:与|和|及|同|、)\s?/.exec(text.slice(end));
    if (tail) {
      const j = end + tail[0].length;
      const v = surnameAt(text, j) > 0 && !COMMON_WORDS.has(text.slice(j, j + 2)) ? readName(text, j) : null;
      if (v) add(j, v, "medium", "beside_person_token");
    }
    const k = m.index!;
    const before = text.slice(Math.max(0, k - 3), k);
    const conj = CONJ_BEFORE.exec(before);
    if (conj) {
      const n = nameEndingAt(text, k - conj[0].length);
      if (n && CONJ_AFTER.test(text.slice(n.start + n.value.length))) add(n.start, n.value, "medium", "beside_person_token");
    }
  }

  // 中：两个像名字的词并列，且前后都是边界或常见后接词（“尚文琳和汪英波在餐厅见面”——规则识别的已知盲区）
  for (const m of text.matchAll(/(?:与|和|及|同|、)/g)) {
    const left = nameEndingAt(text, m.index!);
    const j = m.index! + m[0].length;
    if (!left || surnameAt(text, j) === 0) continue;
    const before = left.start === 0 ? "" : text[left.start - 1]!;
    if (before !== "" && !BOUND.test(before) && !FUNCTION_BEFORE.has(before)) continue;
    const right = readName(text, j);
    if (!right) continue;
    const after = text.slice(j + right.length, j + right.length + 2);
    if (after !== "" && !BOUND.test(after[0]!) && !PAIR_AFTER.test(after)) continue;
    if (!nameLike(left.value) || !nameLike(right)) continue;
    add(left.start, left.value, "medium", "paired_names");
    add(j, right, "medium", "paired_names");
  }

  // 中：言语动词之前、紧跟在单字动词之后（“经查王明表示”“据告李华称”）——规则识别要求前面是句首、标点或功能字，这种写法不认
  for (const m of text.matchAll(new RegExp(SPEAK.join("|"), "g"))) {
    const n = nameEndingAt(text, m.index!);
    if (!n || n.start === 0 || !VERB_PREFIX.has(text[n.start - 1]!)) continue;
    add(n.start, n.value, "medium", "speech_verb");
  }

  return [...found.values()].sort((a, b) => a.index - b.index);
}

/** 只要计数（闸门的去向记录用）。 */
export function suspectCounts(text: string): { high: number; medium: number } {
  const out = { high: 0, medium: 0 };
  for (const s of suspectedNames(text)) out[s.confidence] += 1;
  return out;
}

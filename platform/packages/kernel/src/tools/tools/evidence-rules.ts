/**
 * 证据形式规则核对（第 61 批，D-264；外部评估 R2 evidence-evaluation 一节：外部技能的证明力排序沿用 2001 年旧规则、六处与现行法不符，
 * 这里只收“证据形式 → 法定后果”这类可以按属性确定判定的规则，条文 2026-11-24 逐条对照法规库《最高人民法院关于民事诉讼证据的若干规定》（2019 修正）原文）。
 *
 * 用途：起诉状、答辩状的证据目录，争点—证据矩阵，质证意见——按每份证据的种类、原件与否、载体、形成地、语言、证人是否出庭、由谁控制，
 * 给出举证时要补的手续或质证时可抓的点，附条号。只给规则提示，不评价证明力高低、不判断真伪。纯函数。
 */
import { DomainError } from "@zr-legal/domain";

const LAW = "最高人民法院关于民事诉讼证据的若干规定";

export type EvidenceKind = "书证" | "物证" | "视听资料" | "电子数据" | "证人证言" | "当事人陈述" | "鉴定意见" | "勘验笔录";
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ["书证", "物证", "视听资料", "电子数据", "证人证言", "当事人陈述", "鉴定意见", "勘验笔录"];

export interface EvidenceRow {
  name: string;
  kind: EvidenceKind;
  /** 原件、原物 / 复制件（能与原件核对）/ 复制件（无法与原件核对）。 */
  original?: "原件" | "复制件可核对" | "复制件无原件";
  /** 视听资料、电子数据的载体：原始载体 / 打印件或截图 / 公证保全 / 第三方平台出具或确认。 */
  carrier?: "原始载体" | "打印件或截图" | "公证保全" | "第三方平台";
  formed?: "境内" | "境外" | "港澳台";
  /** 是公文书证（境外形成时影响证明手续）。 */
  official_document?: boolean;
  /** 涉及身份关系（境外形成时须公证并认证）。 */
  identity_relation?: boolean;
  foreign_language?: boolean;
  /** 证人与一方当事人或其代理人有利害关系。 */
  witness_interested?: boolean;
  /** 证人会出庭作证（不出庭又无正当理由的书面证言不得采用）。 */
  witness_will_appear?: boolean;
  /** 书证由谁控制：对方控制的可申请书证提出命令。 */
  held_by?: "我方" | "对方" | "第三方";
}

export interface EvidenceHint {
  rule: string;
  law: string;
  article: string;
  /** 举证方（提交这份证据的一方）该做什么。 */
  for_offering: string;
  /** 质证方（对这份证据发表意见的一方）可抓什么。 */
  for_challenging: string;
}

export interface EvidenceRulesResult {
  rows: { name: string; kind: EvidenceKind; hints: EvidenceHint[] }[];
  note: string;
}

const h = (rule: string, article: string, forOffering: string, forChallenging: string): EvidenceHint => ({ rule, law: LAW, article, for_offering: forOffering, for_challenging: forChallenging });

export function evidenceRulesCheck(p: { rows?: unknown }): EvidenceRulesResult {
  const rows = Array.isArray(p?.rows) ? (p.rows as EvidenceRow[]) : [];
  if (rows.length === 0) throw new DomainError("validation", "rows 不能为空：逐份列出证据名称与种类", 422);
  if (rows.length > 80) throw new DomainError("validation", "rows 一次最多 80 份", 422);
  const out = rows.map((r, i) => {
    const name = typeof r?.name === "string" ? r.name.trim().slice(0, 120) : "";
    if (!name) throw new DomainError("validation", `第 ${i + 1} 份证据缺少 name`, 422);
    if (!EVIDENCE_KINDS.includes(r.kind)) throw new DomainError("validation", `第 ${i + 1} 份证据的 kind 须为 ${EVIDENCE_KINDS.join(" / ")}`, 422);
    const hints: EvidenceHint[] = [];
    if ((r.kind === "书证" || r.kind === "物证") && r.original === "复制件无原件") {
      hints.push(h("应当提供原件或原物；无法与原件、原物核对的复制件不能单独作为认定事实的根据", "第十一条；第九十条第（五）项", "找原件或原物；找不到的，准备能印证其内容的其他证据（往来函件、付款记录、对方自认）", "不认可真实性，要求出示原件；指出它不能单独作为认定事实的根据"));
    }
    if (r.kind === "视听资料" && r.carrier !== "原始载体") {
      hints.push(h("以视听资料作为证据的，应当提供存储该视听资料的原始载体", "第十五条第一款", "庭前备好原始载体（录音设备、手机）当庭出示；必要时公证保全", "要求出示原始载体；无原始载体的，对完整性与真实性提出异议"));
    }
    if (r.kind === "电子数据") {
      if (r.carrier === "打印件或截图") {
        hints.push(h("电子数据应当提供原件；直接来源于电子数据的打印件或其他输出介质视为原件，但真实性要结合系统环境、完整性等因素判断", "第十五条第二款；第九十三条", "当庭出示原始设备或账号（聊天记录登录原账号逐条展示），或者事先公证保全、由平台出具；写明来源、提取时间与方式", "要求当庭展示原始载体；就生成、存储、传输环境与完整性提出异议；存疑的电子数据不能单独作为认定事实的根据（第九十条第（四）项）"));
      } else if (r.carrier === "公证保全" || r.carrier === "第三方平台") {
        hints.push(h("经公证或由中立第三方平台提供、确认的电子数据，法院可以确认真实性，有足以反驳的相反证据的除外", "第九十四条", "附公证书或平台出具的说明", "只能用足以反驳的相反证据推翻：没有的，不要空泛否认真实性，转向关联性与证明目的"));
      } else {
        hints.push(h("电子数据的真实性结合系统环境、完整性、正常业务活动中形成等因素判断", "第十五条第二款；第九十三条；第九十四条", "写明载体与提取方式；能公证保全的公证保全", "就来源、完整性与是否被修改提出具体疑点，避免笼统否认"));
      }
    }
    if (r.formed === "境外" && r.official_document && !r.identity_relation) {
      hints.push(h("境外形成的公文书证，应当经所在国公证机关证明，或者履行条约规定的证明手续", "第十六条第一款", "办理所在国公证（或条约规定的证明手续，如适用附加证明书）", "未履行证明手续的，对形式真实性提出异议"));
    }
    if (r.formed === "境外" && r.identity_relation) {
      hints.push(h("境外形成的涉及身份关系的证据，应当经所在国公证机关证明并经我国驻该国使领馆认证，或者履行条约规定的证明手续", "第十六条第二款", "办理公证并认证（或条约规定的手续）", "未经公证认证的，对真实性提出异议"));
    }
    if (r.formed === "港澳台") {
      hints.push(h("在香港、澳门、台湾地区形成的证据，应当履行相关的证明手续", "第十六条第三款", "按该地区的证明手续办理（如委托公证人公证并转递）", "未履行证明手续的，对形式真实性提出异议"));
    }
    if (r.foreign_language) {
      hints.push(h("外文书证或外文说明资料应当附有中文译本", "第十七条", "附中文译本（宜由有资质的翻译机构出具并盖章）", "未附译本或译文有误的，提出异议并说明哪处译错"));
    }
    if (r.kind === "证人证言") {
      if (r.witness_will_appear === false) {
        hints.push(h("证人应当出庭作证；无正当理由未出庭的证人以书面方式提供的证言，不得作为认定案件事实的根据；申请证人出庭应在举证期限届满前提交申请书", "第六十八条第一款、第三款；第六十九条第一款", "在举证期限届满前申请证人出庭（申请书写明姓名、职业、住所、联系方式、作证主要内容与关联性、出庭必要性）", "证人无正当理由不出庭的，主张书面证言不得作为认定根据"));
      }
      if (r.witness_interested) {
        hints.push(h("与一方当事人或者其代理人有利害关系的证人陈述的证言，不能单独作为认定案件事实的根据", "第九十条第（三）项", "准备书证、电子数据等其他证据与之印证", "指出利害关系（员工、亲属、合作方），主张不能单独作为认定根据"));
      }
    }
    if (r.kind === "当事人陈述") {
      hints.push(h("当事人的陈述不能单独作为认定案件事实的根据", "第九十条第（一）项", "找能印证的其他证据；对方在诉讼中的自认另按自认规则处理", "指出没有其他证据印证"));
    }
    if (r.kind === "书证" && r.held_by === "对方") {
      hints.push(h("书证在对方控制之下的，可以申请法院责令对方提交（书证提出命令）；对方曾引用过的、为我方利益制作的、我方依法有权查阅的、账簿与记账原始凭证，对方应当提交；无正当理由拒不提交的，法院可以认定我方主张的书证内容为真实", "第四十五条第一款；第四十七条第一款；第四十八条第一款", "在举证期限届满前申请书证提出命令：写明书证名称或内容、要证明的事实及其重要性、对方控制的根据与应当提交的理由", "（对方申请时）核对是否属于应当提交的情形、是否涉及商业秘密或隐私（提交后不公开质证）"));
    }
    return { name, kind: r.kind, hints };
  });
  return {
    rows: out,
    note: "以上是证据形式规则与法定后果（条文出自民事证据规定 2019 修正），不是证明力高低或真伪的判断。举证一方用 for_offering 补手续、补强；质证一方用 for_challenging 写意见。写进交付件时只写规则与条号，不写本工具名称。",
  };
}

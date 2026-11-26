/**
 * 开场与交付用的“纸”：合同、法条、判决、纪要、证据目录、往来函件。
 * - 法条原文取自产品随包法规库（content/lawdb/sources/laws.json，官方公布文本；法律条文不受著作权保护）。
 * - 合同条款与片中真实任务所审的《股权转让协议》（scripts/capture/seed.mjs）逐字一致。
 * - 判决、纪要、函件为虚构示例，当事人用甲乙丙丁代称。
 * 主纸（HeroContract）按固定行高排版，镜头焦点可以按行号精确落到某一行上。
 */
import type { CSSProperties, ReactNode } from "react";
import { staticFile } from "remotion";
import { FONT_SERIF, FONT_TITLE, useGlyphs } from "../fonts";

export const PAPER_W = 760;
export const PAPER_H = Math.round(760 * 1.414);

export interface PaperDoc {
  kind: string;
  title: string;
  paras: string[];
  table?: string[][];
}

export const PAPERS: PaperDoc[] = [
  {
    kind: "法规",
    title: "中华人民共和国民法典",
    paras: [
      "第五百八十五条　当事人可以约定一方违约时应当根据违约情况向对方支付一定数额的违约金，也可以约定因违约产生的损失赔偿额的计算方法。",
      "约定的违约金低于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以增加；约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。",
      "当事人就迟延履行约定违约金的，违约方支付违约金后，还应当履行债务。",
      "第五百七十七条　当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。",
    ],
  },
  {
    kind: "法规",
    title: "中华人民共和国公司法",
    paras: [
      "第八十四条　有限责任公司的股东之间可以相互转让其全部或者部分股权。",
      "股东向股东以外的人转让股权的，应当将股权转让的数量、价格、支付方式和期限等事项书面通知其他股东，其他股东在同等条件下有优先购买权。股东自接到书面通知之日起三十日内未答复的，视为放弃优先购买权。",
      "公司章程对股权转让另有规定的，从其规定。",
    ],
  },
  {
    kind: "判决",
    title: "民事判决书",
    paras: [
      "原告乙公司与被告甲公司股权转让纠纷一案，本院立案后，依法适用普通程序，公开开庭进行了审理。",
      "本院认为，本案的争议焦点为：一、被告是否已履行协助办理股权变更登记的义务；二、原告逾期付款是否构成根本违约；三、约定的违约金是否过分高于造成的损失。",
      "关于第三项争议焦点，原告主张约定的违约金过分高于造成的损失，请求予以适当减少……",
    ],
  },
  {
    kind: "纪要",
    title: "项目会议纪要",
    paras: ["一、交易结构：乙投资拟受让丙数据 60% 股权，价款壹仟万元。", "二、待确认：其他股东是否放弃优先购买权；目标公司对外担保情况。", "三、下一步：本周内完成协议审查，下周与转让方谈判。"],
  },
  {
    kind: "证据",
    title: "证据目录",
    paras: [],
    table: [
      ["序号", "证据名称", "证明目的"],
      ["1", "建设工程施工合同", "双方合同关系及付款约定"],
      ["2", "竣工验收记录", "工程已于 2026 年 3 月 18 日验收合格"],
      ["3", "工程结算确认单", "结算总价 34,800,000 元"],
      ["4", "催款函及签收记录", "已催告付款"],
    ],
  },
  {
    kind: "函件",
    title: "催款函",
    paras: ["致：戊置业有限公司", "贵司科创园二期 3# 楼工程已于 2026 年 3 月 18 日竣工验收合格，结算总价 34,800,000 元，贵司已付 21,000,000 元。依合同第 5.2 条，贵司应于验收合格后六十日内支付至结算价的 95%。", "请于收函后十日内付清。"],
  },
  {
    kind: "法规",
    title: "中华人民共和国民法典",
    paras: [
      "第五百六十三条　有下列情形之一的，当事人可以解除合同：",
      "（一）因不可抗力致使不能实现合同目的；",
      "（二）在履行期限届满前，当事人一方明确表示或者以自己的行为表明不履行主要债务；",
      "（三）当事人一方迟延履行主要债务，经催告后在合理期限内仍未履行；",
      "（四）当事人一方迟延履行债务或者有其他违约行为致使不能实现合同目的；",
      "（五）法律规定的其他情形。",
    ],
  },
  {
    kind: "清单",
    title: "尽职调查清单",
    paras: ["一、目标公司基本情况：营业执照、章程及历次修正案、股东名册。", "二、股权结构：出资凭证、股权质押与冻结情况。", "三、重大合同：对外担保、借款合同、关联交易。", "四、诉讼仲裁：未决案件清单及代理律师意见。"],
  },
];

/** 纸面质感：暖白纸 + 极细纤维噪声 + 顶光渐变。 */
function paperStyle(w: number, light: number): CSSProperties {
  return {
    position: "relative",
    width: w,
    height: Math.round(w * 1.414),
    borderRadius: 3,
    backgroundColor: "#f6f2ea",
    backgroundImage: `linear-gradient(170deg, rgba(255,255,255,${0.55 * light}) 0%, rgba(255,255,255,0) 46%, rgba(120,100,70,0.06) 100%), url(${staticFile("textures/paper.png")})`,
    backgroundSize: "100% 100%, 512px 512px",
    boxShadow: "0 40px 90px -24px rgba(0,0,0,0.62), 0 10px 24px -8px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.05)",
    overflow: "hidden",
    color: "#25221d",
  };
}

/** 一张纸（流式排版）：背景纸堆用。 */
export function Paper({ doc, w = PAPER_W, style, light = 1 }: { doc: PaperDoc; w?: number; style?: CSSProperties; light?: number }) {
  useGlyphs(doc.kind + doc.title + doc.paras.join("") + (doc.table?.flat().join("") ?? ""));
  const k = w / PAPER_W;
  return (
    <div style={{ ...paperStyle(w, light), padding: `${92 * k}px ${86 * k}px`, ...style }}>
      <div style={{ fontFamily: FONT_TITLE, fontSize: 13 * k, letterSpacing: 4 * k, color: "#9d968a", marginBottom: 26 * k }}>{doc.kind}</div>
      <div style={{ fontFamily: FONT_SERIF, fontSize: 30 * k, fontWeight: 700, textAlign: "center", marginBottom: 44 * k, letterSpacing: 2 * k }}>{doc.title}</div>
      {doc.paras.map((l, i) => (
        <p key={i} style={{ fontFamily: FONT_SERIF, fontSize: 17 * k, lineHeight: 2.05, margin: `0 0 ${10 * k}px`, textIndent: /^(第|致|（|[一二三四五]、)/.test(l) ? 0 : "2em", textAlign: "justify" }}>
          {l}
        </p>
      ))}
      {doc.table && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: FONT_SERIF, fontSize: 15.5 * k }}>
          <tbody>
            {doc.table.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} style={{ border: "1px solid #cbc3b5", padding: `${10 * k}px ${12 * k}px`, fontWeight: i === 0 ? 700 : 400, width: j === 0 ? "12%" : undefined }}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ───────── 主纸：《股权转让协议》（固定行高，可按行定位） ───────── */

export const HERO_PAD_X = 86;
export const HERO_TOP = 80;
export const ROW_H = 34; // 正文行高
export interface Row {
  t: string;
  kind: "kind" | "title" | "head" | "body" | "gap";
  id?: string;
}
/** 主纸逐行内容（每行不超过约 33 个汉字宽，保证不再折行）。 */
export const HERO_ROWS: Row[] = [
  { t: "合同", kind: "kind" },
  { t: "股权转让协议", kind: "title" },
  { t: "第一条　当事人", kind: "head" },
  { t: "转让方：甲科技有限公司（法定代表人：张伟，", kind: "body", id: "p1" },
  { t: "　　　　身份证号 110101198203154517）", kind: "body", id: "p1b" },
  { t: "受让方：乙投资有限公司（经办人：李娜，", kind: "body", id: "p2" },
  { t: "　　　　电话 13910246688）", kind: "body", id: "p2b" },
  { t: "目标公司：丙数据服务有限公司", kind: "body" },
  { t: "第二条　转让标的", kind: "head" },
  { t: "2.1　转让方同意将其持有的目标公司 60% 股权（对应注册资本", kind: "body" },
  { t: "　　 人民币陆佰万元）转让给受让方。", kind: "body" },
  { t: "第三条　转让价款与支付", kind: "head" },
  { t: "3.1　目标股权的转让价款为人民币壹仟万元（¥10,000,000）。", kind: "body" },
  { t: "3.2　受让方应于本协议签署后五个工作日内一次性支付全部转让价款。", kind: "body", id: "c32" },
  { t: "第四条　股权交割", kind: "head" },
  { t: "4.1　转让方应于收到全部转让价款后三十日内配合目标公司", kind: "body" },
  { t: "　　 办理股权变更登记。", kind: "body" },
  { t: "第五条　陈述与保证", kind: "head" },
  { t: "5.1　转让方保证目标公司不存在未向受让方披露的债务或担保。", kind: "body" },
  { t: "第六条　过渡期安排", kind: "head" },
  { t: "6.1　自本协议签署之日起至股权变更登记完成之日止，转让方应", kind: "body" },
  { t: "　　 促使目标公司正常经营，不得对外提供担保。", kind: "body" },
  { t: "第七条　违约责任", kind: "head" },
  { t: "7.1　受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", kind: "body", id: "c71" },
  { t: "7.2　转让方违反陈述与保证的，应赔偿受让方因此遭受的直接损失。", kind: "body" },
];

/** 每行的 y（纸内坐标，行的顶边）与高度。 */
export const HERO_LAYOUT = (() => {
  let y = HERO_TOP;
  return HERO_ROWS.map((r) => {
    const h = r.kind === "kind" ? 40 : r.kind === "title" ? 80 : r.kind === "head" ? 44 : ROW_H;
    const o = { y, h };
    y += h;
    return o;
  });
})();
export const rowIndex = (id: string) => HERO_ROWS.findIndex((r) => r.id === id);
export const rowCenter = (id: string) => {
  const i = rowIndex(id);
  return HERO_LAYOUT[i].y + HERO_LAYOUT[i].h / 2;
};

/** 主纸：render(row, i) 可替换某一行的内容（代号替换、高亮等）。 */
export function HeroContract({ light = 1, style, render, rowStyle }: { light?: number; style?: CSSProperties; render?: (r: Row, i: number) => ReactNode; rowStyle?: (r: Row, i: number) => CSSProperties | undefined }) {
  useGlyphs(HERO_ROWS.map((r) => r.t).join("") + "〔自然人·〕证件号电话代号");
  return (
    <div style={{ ...paperStyle(PAPER_W, light), ...style }}>
      {HERO_ROWS.map((r, i) => {
        const { y, h } = HERO_LAYOUT[i];
        const base: CSSProperties = { position: "absolute", left: HERO_PAD_X, right: HERO_PAD_X, top: y, height: h, display: "flex", alignItems: "center", whiteSpace: "nowrap" };
        const st: CSSProperties =
          r.kind === "kind"
            ? { fontFamily: FONT_TITLE, fontSize: 13, letterSpacing: 4, color: "#9d968a", alignItems: "flex-start" }
            : r.kind === "title"
              ? { fontFamily: FONT_SERIF, fontSize: 30, fontWeight: 700, letterSpacing: 2, justifyContent: "center" }
              : r.kind === "head"
                ? { fontFamily: FONT_SERIF, fontSize: 18, fontWeight: 700, paddingTop: 10 }
                : { fontFamily: FONT_SERIF, fontSize: 17, letterSpacing: 0.2 };
        return (
          <div key={i} style={{ ...base, ...st, ...rowStyle?.(r, i) }}>
            {render ? render(r, i) : r.t}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 开场用的“纸”：合同、法条、判决、纪要、证据目录、往来函件。
 * 文本为虚构示例；法条引自《中华人民共和国民法典》公开文本（法律条文不受著作权保护）。
 */
import type { CSSProperties } from "react";
import { FONT_DOC, FONT_UI } from "./film";

export interface PaperDoc {
  kind: string;
  title: string;
  lines: string[];
  table?: string[][];
}

export const PAPERS: PaperDoc[] = [
  {
    kind: "合同",
    title: "股权转让协议",
    lines: [
      "第二条　转让价款与支付",
      "2.1　目标股权的转让价款为人民币壹仟万元。",
      "2.2　受让方应于协议签署后五日内一次性支付全部价款。",
      "第五条　陈述与保证",
      "5.1　转让方保证目标公司不存在未向受让方披露的债务或担保。",
      "第七条　违约责任",
      "7.1　受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。",
    ],
  },
  {
    kind: "法规",
    title: "中华人民共和国民法典",
    lines: [
      "第五百八十五条　当事人可以约定一方违约时应当根据违约情况向对方支付一定数额的违约金，也可以约定因违约产生的损失赔偿额的计算方法。",
      "约定的违约金低于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以增加；约定的违约金过分高于造成的损失的，人民法院或者仲裁机构可以根据当事人的请求予以适当减少。",
    ],
  },
  {
    kind: "判例",
    title: "民事判决书（示例）",
    lines: [
      "本院认为，本案争议焦点在于转让方是否已履行办理股权变更登记的协助义务，以及受让方逾期付款是否构成根本违约。",
      "根据双方提交的证据及庭审陈述，本院对相关事实认定如下……",
    ],
  },
  {
    kind: "纪要",
    title: "项目会议纪要",
    lines: ["一、交易结构：拟以股权转让方式收购目标公司 60% 股权。", "二、待确认事项：目标公司对外担保情况；核心员工竞业限制安排。", "三、下一步：一周内完成法律尽职调查清单。"],
  },
  {
    kind: "证据",
    title: "证据目录",
    lines: [],
    table: [
      ["序号", "证据名称", "证明目的"],
      ["1", "股权转让协议", "双方权利义务"],
      ["2", "付款凭证", "已付价款金额"],
      ["3", "往来函件", "催告履行事实"],
      ["4", "工商登记信息", "股权尚未变更"],
    ],
  },
  {
    kind: "函件",
    title: "关于履行协议的函",
    lines: ["致：甲科技有限公司", "贵司与我司于 2026 年 3 月签订的《股权转让协议》约定……请贵司于收函后七日内协助办理股权变更登记手续。"],
  },
];

/** 一张纸：暖白纸面 + 宋体正文 + 顶光渐变。 */
export function Paper({ doc, w = 560, style, light = 1 }: { doc: PaperDoc; w?: number; style?: CSSProperties; light?: number }) {
  const h = w * 1.36;
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 4,
        background: `linear-gradient(165deg, rgba(255,253,248,${light}) 0%, #f2eee6 100%)`,
        boxShadow: "0 30px 80px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
        padding: `${w * 0.1}px ${w * 0.1}px`,
        overflow: "hidden",
        fontFamily: FONT_DOC,
        color: "#24211c",
        ...style,
      }}
    >
      <div style={{ fontFamily: FONT_UI, fontSize: w * 0.022, letterSpacing: 2, color: "#9a9389", marginBottom: w * 0.03 }}>{doc.kind}</div>
      <div style={{ fontSize: w * 0.048, fontWeight: 600, textAlign: "center", marginBottom: w * 0.06, letterSpacing: 1 }}>{doc.title}</div>
      {doc.lines.map((l, i) => (
        <p key={i} style={{ fontSize: w * 0.029, lineHeight: 1.95, margin: `0 0 ${w * 0.018}px`, textIndent: l.startsWith("第") || /^\d/.test(l) || l.startsWith("致") ? 0 : "2em" }}>
          {l}
        </p>
      ))}
      {doc.table && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: w * 0.028 }}>
          <tbody>
            {doc.table.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} style={{ border: "1px solid #cfc8bc", padding: `${w * 0.012}px ${w * 0.016}px`, fontWeight: i === 0 ? 600 : 400 }}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* 正文下方的“更多页”灰线，暗示篇幅 */}
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} style={{ height: w * 0.012, margin: `${w * 0.028}px 0`, background: "#ddd6ca", borderRadius: 2, width: `${70 + ((i * 37) % 30)}%`, opacity: 0.7 }} />
      ))}
    </div>
  );
}

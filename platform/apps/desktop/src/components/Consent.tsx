/**
 * “客户是否同意本案使用 AI 辅助？”——四项依据的律师语言入口（UIUX 评审 P0-1）。
 * 内核仍分别记录四项（第 02 篇 §8.1 语义不变）：选“已取得同意”即把委托/保密授权、个人信息处理依据、转委托与次处理者记为已确认，
 * 并在选项下方写明记录了什么；敏感事项的“敏感信息特别条件”不随一键确认，须逐项确认。“逐项调整”展开原四项编辑器。
 */
import { useState } from "react";
import type { MatterBasis } from "../api.ts";
import { BasisEditor } from "./MatterHeader.tsx";

export type ConsentAnswer = "consented" | "not_yet" | "refused";

export function basisForConsent(answer: ConsentAnswer, sensitiveMatter: boolean): MatterBasis {
  if (answer === "consented") return { engagement: "confirmed", personal_info: "confirmed", sensitive: sensitiveMatter ? "pending" : "not_applicable", subprocessor: "confirmed" };
  return { engagement: "pending", personal_info: "pending", sensitive: sensitiveMatter ? "pending" : "not_applicable", subprocessor: "pending" };
}

export function consentOf(b: MatterBasis): ConsentAnswer {
  return b.engagement === "confirmed" && b.personal_info !== "pending" && b.subprocessor !== "pending" ? "consented" : "not_yet";
}

export function ConsentQuestion({
  answer,
  onAnswer,
  basis,
  onBasis,
  endpoint,
  sensitiveMatter,
  allowRefuse = true,
}: {
  answer: ConsentAnswer;
  onAnswer: (a: ConsentAnswer) => void;
  basis: MatterBasis;
  onBasis: (b: MatterBasis) => void;
  endpoint: string;
  sensitiveMatter: boolean;
  allowRefuse?: boolean;
}) {
  const [detail, setDetail] = useState(false);
  const pick = (a: ConsentAnswer) => {
    onAnswer(a);
    onBasis(basisForConsent(a, sensitiveMatter));
  };
  return (
    <div className="consent">
      <div className="consent-q">客户是否同意本案使用 AI 辅助？</div>
      <label className="consent-opt">
        <input type="radio" checked={answer === "consented"} onChange={() => pick("consented")} />
        <span>已取得同意<small>委托合同中有约定，或客户书面确认</small></span>
      </label>
      <label className="consent-opt">
        <input type="radio" checked={answer === "not_yet"} onChange={() => pick("not_yet")} />
        <span>还没有，先只用本机功能<small>读文件、比对、脱敏、核对法条，不会把内容发给 AI 或上网</small></span>
      </label>
      {allowRefuse && (
        <label className="consent-opt">
          <input type="radio" checked={answer === "refused"} onChange={() => pick("refused")} />
          <span>客户明确不同意使用云端 AI<small>本事项只在这台电脑上处理，不使用云端模型与联网检索</small></span>
        </label>
      )}
      {answer === "consented" && (
        <p className="consent-note muted">
          将记录：委托与保密授权已确认；转委托与次处理者（中软、月之暗面）已告知；个人信息处理依据已确认（委托处理）。
          {sensitiveMatter ? "本事项为敏感事项，“敏感信息特别条件”还需逐项确认。" : ""}
        </p>
      )}
      <button type="button" className="btn-link" onClick={() => setDetail((v) => !v)}>{detail ? "收起逐项调整" : "逐项调整"}</button>
      {detail && <BasisEditor basis={basis} endpoint={endpoint} onChange={onBasis} />}
    </div>
  );
}

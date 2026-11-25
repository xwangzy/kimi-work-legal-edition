import type { ReactNode } from "react";
import { Icon } from "./Icons.tsx";
import type { ScenarioCard } from "../lib/scenarios.ts";

/** 场景胶囊的图标：按场景名里的动作挑一个（Kimi 能力胶囊每个都带线性图标）。 */
export function scenarioIcon(c: Pick<ScenarioCard, "title">): ReactNode {
  const t = c.title;
  if (/函|催告/.test(t)) return Icon.mail();
  if (/测算|计算/.test(t)) return Icon.calc();
  if (/审|核|比对|体检/.test(t)) return Icon.fileCheck();
  if (/起草|申请|决议|董事会|代理词|对外版|文件/.test(t)) return Icon.pen();
  if (/争点|分析|策略|评估|风险|质证|庭审/.test(t)) return Icon.scale();
  if (/研究|问答|答复|检索|法规/.test(t)) return Icon.book();
  if (/尽调|调查/.test(t)) return Icon.search();
  if (/清单|纪要|案卷|整理/.test(t)) return Icon.folder();
  if (/汇报|报告/.test(t)) return Icon.board();
  return Icon.compass();
}

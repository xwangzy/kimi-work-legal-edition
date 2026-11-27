// 宣传片 V4 采集：灌入虚构、脱敏的演示案例（三条业务线各一件事项、合同与证据材料、期限提醒）。经开发桥 /invoke，与界面同一入口。
// 用法：node video-v4/scripts/capture/seed.mjs  → 打印事项编号 JSON（shoot 脚本的参数）
// 案例全部虚构：公司名用甲乙丙丁戊己，人名、证件号、电话均为编造。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const M = (process.env.FILM_PLATFORM ?? join(REPO, ".claude/worktrees/film-v4-capture/platform")) + "/";
const WEB = process.env.FILM_WEB_PORT ?? "5261";
const BRIDGE = process.env.FILM_BRIDGE_PORT ?? "7861";
const T = readFileSync(`${M}apps/desktop/dev/.bridge-token`, "utf8").trim();
export const inv = async (method, params = {}) => {
  const r = await (await fetch(`http://127.0.0.1:${BRIDGE}/invoke`, { method: "POST", headers: { origin: `http://127.0.0.1:${WEB}`, "x-kwl-token": T, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })).json();
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const { createDocx } = await import(`${M}packages/docx-engine/src/index.ts`);
const docx = (title, sections) => Buffer.from(createDocx(title, sections)).toString("base64");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const txt = (s) => Buffer.from(s, "utf8").toString("base64");

// ── 诉讼：建设工程款（起诉状 + 证据梳理） ──
const { matter: lit } = await inv("matters.create", { title: "丁建设诉戊置业建设工程款纠纷", client_name: "丁建设工程有限公司", counterparty: "戊置业有限公司", stance: "原告" });
await inv("materials.import", { matter_id: lit.matter_id, filename: "建设工程施工合同.docx", mime: DOCX, data_base64: docx("建设工程施工合同", [
  { heading: "第一条　工程概况", paragraphs: ["发包人：戊置业有限公司（法定代表人：赵明远）", "承包人：丁建设工程有限公司（法定代表人：周立群）", "工程名称：戊置业科创园二期 3# 楼", "工程地点：江州市高新区创新大道 88 号"] },
  { heading: "第三条　合同价款", paragraphs: ["3.1　本工程采用固定单价合同，暂定合同总价人民币叁仟陆佰万元（¥36,000,000）。", "3.2　最终结算价以双方签字确认的结算书为准。"] },
  { heading: "第五条　工程款支付", paragraphs: ["5.1　工程进度款按月支付至当月完成产值的 70%。", "5.2　工程竣工验收合格后六十日内，发包人支付至结算价的 95%。", "5.3　剩余 5% 作为质量保证金，缺陷责任期（两年）届满后十四日内无息返还。"] },
  { heading: "第九条　违约责任", paragraphs: ["9.1　发包人逾期支付工程款的，应按中国人民银行发布的同期同类贷款利率（自 2019 年 8 月 20 日起为全国银行间同业拆借中心公布的贷款市场报价利率）向承包人支付逾期付款利息。"] },
  { heading: "第十二条　争议解决", paragraphs: ["12.1　因本合同发生的争议，双方协商不成的，向工程所在地人民法院提起诉讼。"] },
]) });
await inv("materials.import", { matter_id: lit.matter_id, filename: "竣工验收记录.txt", mime: "text/plain", data_base64: txt("工程竣工验收记录\n工程名称：戊置业科创园二期 3# 楼\n验收日期：2026 年 3 月 18 日\n验收结论：工程质量符合设计及规范要求，验收合格。\n建设单位：戊置业有限公司（盖章）　施工单位：丁建设工程有限公司（盖章）　监理单位：江州恒正工程监理有限公司（盖章）") });
await inv("materials.import", { matter_id: lit.matter_id, filename: "工程结算确认单.txt", mime: "text/plain", data_base64: txt("工程结算确认单\n工程名称：戊置业科创园二期 3# 楼\n经双方核对，本工程结算总价为人民币叁仟肆佰捌拾万元（¥34,800,000）。\n截至本确认单签署日，发包人已付工程款人民币贰仟壹佰万元（¥21,000,000）。\n发包人：戊置业有限公司（盖章）　承包人：丁建设工程有限公司（盖章）\n日期：2026 年 4 月 30 日") });
await inv("materials.import", { matter_id: lit.matter_id, filename: "催款函及签收记录.txt", mime: "text/plain", data_base64: txt("催款函\n致：戊置业有限公司\n贵司科创园二期 3# 楼工程已于 2026 年 3 月 18 日竣工验收合格，结算总价 34,800,000 元，贵司已付 21,000,000 元。依合同第 5.2 条，贵司应于验收合格后六十日内支付至结算价的 95%，即 33,060,000 元，尚欠 12,060,000 元。请于收函后十日内付清。\n丁建设工程有限公司\n2026 年 6 月 2 日\n\n快递签收记录：运单号 SF1029384756，2026 年 6 月 3 日由戊置业有限公司前台签收。") });
// ── 企业法务：供应商合同 ──
const { matter: corp } = await inv("matters.create", { title: "己集团 2027 年度供应商合同审查", client_name: "己集团有限公司", counterparty: "各供应商", stance: "采购方" });
await inv("materials.import", { matter_id: corp.matter_id, filename: "采购框架协议（范本）.docx", mime: DOCX, data_base64: docx("采购框架协议", [{ heading: "第五条　付款", paragraphs: ["买方应于验收合格后九十日内支付货款。"] }, { heading: "第八条　质量保证", paragraphs: ["卖方保证货物符合国家标准及双方约定的技术规格。"] }]) });
// ── 非诉：股权转让（片中主线） ──
const { matter } = await inv("matters.create", { title: "乙投资受让丙数据 60% 股权", client_name: "乙投资有限公司", counterparty: "甲科技有限公司", stance: "受让方" });
const contract = docx("股权转让协议", [
  { heading: "第一条　当事人", paragraphs: ["转让方：甲科技有限公司（法定代表人：张伟，身份证号 110101198203154517）", "受让方：乙投资有限公司（经办人：李娜，电话 13910246688）", "目标公司：丙数据服务有限公司"] },
  { heading: "第二条　转让标的", paragraphs: ["2.1　转让方同意将其持有的目标公司 60% 股权（对应注册资本人民币陆佰万元）转让给受让方。"] },
  { heading: "第三条　转让价款与支付", paragraphs: ["3.1　目标股权的转让价款为人民币壹仟万元（¥10,000,000）。", "3.2　受让方应于本协议签署后五个工作日内一次性支付全部转让价款。"] },
  { heading: "第四条　股权交割", paragraphs: ["4.1　转让方应于收到全部转让价款后三十日内配合目标公司办理股权变更登记。"] },
  { heading: "第五条　陈述与保证", paragraphs: ["5.1　转让方保证目标公司不存在未向受让方披露的债务或担保。"] },
  { heading: "第六条　过渡期安排", paragraphs: ["6.1　自本协议签署之日起至股权变更登记完成之日止，转让方应促使目标公司正常经营，不得对外提供担保。"] },
  { heading: "第七条　违约责任", paragraphs: ["7.1　受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", "7.2　转让方违反陈述与保证的，应赔偿受让方因此遭受的直接损失。"] },
  { heading: "第八条　保密", paragraphs: ["8.1　双方对本次交易的条件及因本协议知悉的对方商业秘密负有保密义务。"] },
  { heading: "第九条　争议解决", paragraphs: ["9.1　因本协议引起的任何争议，提交转让方所在地人民法院诉讼解决。"] },
  { heading: "第十条　其他", paragraphs: ["10.1　本协议自双方签字盖章之日起生效，一式四份，各方各执两份。"] },
]);
const d = await inv("materials.import", { matter_id: matter.matter_id, filename: "股权转让协议.docx", mime: DOCX, data_base64: contract });
await inv("materials.import", { matter_id: matter.matter_id, filename: "项目会议纪要.txt", mime: "text/plain", data_base64: txt("一、交易结构：乙投资拟受让丙数据 60% 股权，价款壹仟万元。\n二、待确认：其他股东是否放弃优先购买权；目标公司对外担保情况。\n三、下一步：本周内完成协议审查，下周与转让方谈判。") });
for (const r of [
  { matter_id: lit.matter_id, kind: "evidence", due_date: "2026-12-04", days_before: 3, note: "举证期限届满" },
  { matter_id: lit.matter_id, kind: "hearing", due_date: "2026-12-16", days_before: 5, note: "第一次开庭" },
  { matter_id: matter.matter_id, kind: "contract", due_date: "2026-11-30", days_before: 2, note: "签约前完成审查" },
]) await inv("reminders.create", r);
console.log(JSON.stringify({ nonlit: matter.matter_id, doc: d.document_version_id, lit: lit.matter_id, corp: corp.matter_id }));

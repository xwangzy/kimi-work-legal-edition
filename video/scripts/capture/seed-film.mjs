import { readFileSync } from "node:fs";
const M = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/platform";
const T = readFileSync(`${M}/apps/desktop/dev/.bridge-token`, "utf8").trim();
const inv = async (method, params = {}) => {
  const r = await (await fetch("http://127.0.0.1:7800/invoke", { method: "POST", headers: { origin: "http://localhost:5220", "x-kwl-token": T, "content-type": "application/json" }, body: JSON.stringify({ method, params }) })).json();
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const { createDocx } = await import(`${M}/packages/docx-engine/src/index.ts`);
const { matter } = await inv("matters.create", { title: "乙投资受让丙数据股权（受让方）", client_name: "乙投资有限公司", counterparty: "甲科技有限公司", stance: "受让方", consent_status: "agreed", matter_kind: "non_litigation" });
const docx = createDocx("股权转让协议", [
  { heading: "第一条　当事人", paragraphs: ["转让方：甲科技有限公司（法定代表人：张伟，身份证号 110101198203154517）", "受让方：乙投资有限公司（经办人：李娜，电话 13910246688）", "目标公司：丙数据服务有限公司"] },
  { heading: "第二条　转让价款与支付", paragraphs: ["2.1　目标股权的转让价款为人民币壹仟万元。", "2.2　受让方应于本协议签署后五个工作日内一次性支付全部转让价款。"] },
  { heading: "第五条　陈述与保证", paragraphs: ["5.1　转让方保证目标公司不存在未向受让方披露的债务或担保。"] },
  { heading: "第七条　违约责任", paragraphs: ["7.1　受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", "7.2　转让方违反陈述与保证的，应赔偿受让方因此遭受的直接损失。"] },
  { heading: "第九条　争议解决", paragraphs: ["9.1　因本协议引起的任何争议，提交转让方所在地人民法院诉讼解决。"] },
]);
const d = await inv("materials.import", { matter_id: matter.matter_id, filename: "股权转让协议.docx", data_base64: Buffer.from(docx).toString("base64"), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
const memo = await inv("materials.import", { matter_id: matter.matter_id, filename: "项目会议纪要.txt", data_base64: Buffer.from("一、交易结构：乙投资拟受让丙数据 60% 股权，价款壹仟万元。\n二、待确认：目标公司对外担保情况；核心员工竞业限制安排。\n三、下一步：一周内完成尽职调查清单。").toString("base64"), mime: "text/plain" });
const { matter: lit } = await inv("matters.create", { title: "丁建设工程款纠纷（原告）", client_name: "丁建设工程有限公司", counterparty: "戊置业有限公司", stance: "原告", consent_status: "agreed" });
const s = await inv("materials.import", { matter_id: lit.matter_id, filename: "签收单.txt", data_base64: Buffer.from("签收单：买方于 2026 年 3 月 1 日签收全部货物，签收人张三。").toString("base64"), mime: "text/plain" });
await inv("reminders.create", { matter_id: lit.matter_id, kind: "evidence", due_date: "2026-11-02", days_before: 3, note: "举证期限届满" });
await inv("reminders.create", { matter_id: lit.matter_id, kind: "hearing", due_date: "2026-11-18", days_before: 5, note: "第一次开庭" });
await inv("reminders.create", { matter_id: matter.matter_id, kind: "contract", due_date: "2026-10-31", days_before: 2, note: "签约前完成审查" });
console.log(JSON.stringify({ nonlit: matter.matter_id, doc: d.document_version_id, lit: lit.matter_id }));

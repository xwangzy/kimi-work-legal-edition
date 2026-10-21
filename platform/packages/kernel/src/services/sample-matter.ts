/**
 * 示例事项（v9.2 §4.4；调研 Y4 §5 D-6、清单 #24）：一件**虚构**的“甲公司股权转让（受让方）”——合成的 DOCX 协议与三张示例风险卡，
 * 全部在本机生成、不调用模型、不联网；律师可以在审查工作台逐张决定并生成修订稿，熟悉流程。
 * 每台设备只自动放入一次（移除后不再放入）；名称、条款与当事人均为虚构。
 */
import { createDocx } from "@zr-legal/docx-engine";

export const SAMPLE_TITLE = "示例 · 甲公司股权转让（受让方）";
export const SAMPLE_FILENAME = "示例-股权转让协议.docx";

export function sampleContract(): Buffer {
  return createDocx("股权转让协议（示例，内容虚构）", [
    { heading: "第一条 当事人", paragraphs: ["转让方：甲科技有限公司（示例）", "受让方：乙投资有限公司（示例）", "目标公司：丙数据服务有限公司（示例）"] },
    { heading: "第二条 转让价款与支付", paragraphs: ["2.1 目标股权的转让价款为人民币壹仟万元。", "2.2 受让方应于协议签署后五日内一次性支付全部价款。"] },
    { heading: "第五条 陈述与保证", paragraphs: ["5.1 转让方保证目标公司不存在未向受让方披露的债务或担保。"] },
    { heading: "第七条 违约责任", paragraphs: ["7.1 受让方逾期付款的，每日按应付未付金额的千分之五支付违约金。", "7.2 转让方违反陈述与保证的，应赔偿受让方因此遭受的直接损失。"] },
    { heading: "第九条 争议解决", paragraphs: ["9.1 本协议项下的任何争议，提交转让方所在地人民法院诉讼解决。"] },
    // 示例合同不是律所出具的文件：不带本产品标记，下载它的修订稿时不套函头（B-4）
  ], { mark: false });
}

/** 三张示例风险卡（受让方立场；锚点为协议逐字原文）。 */
export const SAMPLE_CARDS = [
  {
    clause_ref: "2.2",
    anchor_text: "受让方应于协议签署后五日内一次性支付全部价款",
    severity: "high",
    category: "both",
    issue: "价款在股权变更登记之前一次性付清：若之后无法完成变更登记，受让方要先付款再追讨，风险全部在受让方。",
    nature: "should",
    suggestion: "受让方应于目标股权变更登记完成后五个工作日内支付全部价款",
    fallback: "协议签署后支付百分之三十，变更登记完成后支付其余百分之七十",
    bottom_line: "协议签署后支付不超过百分之五十，且转让方提供等额担保",
  },
  {
    clause_ref: "7.1",
    anchor_text: "每日按应付未付金额的千分之五支付违约金",
    severity: "mid",
    category: "legal",
    issue: "逾期付款违约金按日千分之五计，明显偏高，且与转让方违约时只赔“直接损失”不对等。",
    nature: "should",
    suggestion: "每日按应付未付金额的万分之三支付违约金，累计不超过应付未付金额的百分之十",
    fallback: "每日按应付未付金额的万分之五支付违约金，累计不超过应付未付金额的百分之二十",
  },
  {
    clause_ref: "9.1",
    anchor_text: "提交转让方所在地人民法院诉讼解决",
    severity: "low",
    category: "commercial",
    issue: "管辖法院约定在转让方所在地，受让方诉讼成本较高。是否争取需由客户决定。",
    nature: "negotiable",
    suggestion: "提交受让方所在地人民法院诉讼解决",
    fallback: "提交被告所在地人民法院诉讼解决",
    bottom_line: "接受转让方所在地法院管辖，但约定双方的送达地址与电子送达方式",
    needs_client_decision: true,
  },
] as const;

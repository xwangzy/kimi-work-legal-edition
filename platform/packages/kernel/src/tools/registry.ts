/**
 * 工具注册表：内核内模块（方案 v5.0 §15：tool-gateway 从独立服务改为内核内模块；
 * MCP 端点保留供 Agent 使用；确定性工作流进程内直接调用）。
 * “平台对工具 schema 校验严格”（§4.1）——inputSchema 一律 additionalProperties:false。
 * 外发、签发、删除类工具根本不在注册表内（§6.2）。
 */
import { calcAnnualLeave, calcLabor } from "./tools/labor.ts";
import { calcOvertime } from "./tools/labor-overtime.ts";
import { calcCourtFee } from "./tools/court-fee.ts";
import type { CapabilityClaims } from "@zr-legal/service-auth";
import { DomainError } from "@zr-legal/domain";
import { ManifestRegistry, type SideEffect, type ToolManifest, type ToolResource } from "@zr-legal/host-policy";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignedToolLock, registryFromLock, verifyToolsAgainstLock, type ToolLock } from "./manifest-lock.ts";
import type { Lawdb } from "@zr-legal/lawdb";
import type { KernelDb } from "../db.ts";
import type { BlobStore } from "../blobs.ts";
import { lawGetArticle, lawGetVersion, lawSearch } from "./tools/law.ts";
import { citationsVerify } from "./tools/citations.ts";
import { calcInterest } from "./tools/calc.ts";
import { calcLedgerTool } from "./tools/ledger-table.ts";
import { calcDeadline } from "./tools/deadline.ts";
import { redactScan } from "./tools/redact.ts";
import { materialsReadExcerpt } from "./tools/materials.ts";
import { docxApplyRevisions, docxCompare, docxRenderReport, docxSanitize, redactApply } from "./tools/docx.ts";
import { docxRevise } from "./tools/revise.ts";
import { docxEditDraft, sectionsOfDocx } from "./tools/edit-draft.ts";
import { assertMaterialInScope, factsList, factsSubmit, materialsList, outlineGet, outlineSubmit, registerToolArtifact, rulesPropose, riskcardsList, riskcardsSubmit, tableFill, tableGet, xlsxEditCells, xlsxRenderTable } from "./tools/review.ts";
import { assertOutlineSettled } from "../services/argument-outlines.ts";
import { checkDeliverable, factRefNos, isInternalDocument, qualityScrubNote, scrubQualitySections, type DeliverableCheck, type DeliverableSection } from "../services/deliverable-check.ts";
import { FACT_SHEET_NAME, factSection, factTableRows, unknownFactNote } from "../services/fact-refs.ts";
import { sectionChars, shrinkCheck } from "../services/version-shrink.ts";
import { localToday } from "../services/local-date.ts";
import type { MatterTokenStore } from "../egress/matter-tokens.ts";
import { errFields, slog } from "@zr-legal/safe-log";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 副作用类别（v9 第 04 篇 §9 F3：授权依据之一；非 read 的调用走 outbox 与幂等键，F6）。 */
  sideEffect: SideEffect;
  /** 作用资源（事项绑定检查）。 */
  resource: ToolResource;
  /** 工具版本（语义变化即升版本；schema hash 由清单自动计算）。 */
  version: string;
  invoke: (params: any, ctx: InvokeCtx) => Promise<unknown> | unknown;
}

/** 锁文件生成时的默认用途（--regenerate 草稿用；正式用途以评审后的锁文件为准）。 */
export const LEGAL_TOOL_PURPOSES = ["legal_analysis"] as const;

export interface InvokeCtx {
  claims: CapabilityClaims;
  db: KernelDb;
  blobs: BlobStore;
  lawdb: Lawdb;
  /** 事项令牌存储（结构化产出核对锚点用；结果令牌化在本机端点统一做）。 */
  tokens?: MatterTokenStore;
  /** 激活记录里的律所名称（V14 第 39 批：对外修订稿的署名在没设修订署名时用它，10-23 拍板）；开发形态为 null。 */
  firmName?: string | null;
}

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
/** calc.ledger 的利率口径（顶层与各笔债务共用）。 */
const LEDGER_RATE_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind", "per_10k"], properties: { kind: { const: "daily" }, per_10k: { type: "number", exclusiveMinimum: 0, maximum: 100 } } },
    { type: "object", additionalProperties: false, required: ["kind", "annual_pct"], properties: { kind: { const: "fixed" }, annual_pct: { type: "number", exclusiveMinimum: 0, maximum: 100 } } },
    { type: "object", additionalProperties: false, required: ["kind", "plus_bp"], properties: { kind: { const: "lpr_plus" }, lpr_term: { const: "1Y" }, plus_bp: { type: "number" } } },
    { type: "object", additionalProperties: false, required: ["kind", "multiple"], properties: { kind: { const: "lpr_times" }, lpr_term: { const: "1Y" }, multiple: { type: "number", exclusiveMinimum: 0, maximum: 4 } } },
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "none" } } },
  ],
};
/** calc.labor 加班费的一个月（第 58 批）：小时照考勤原样逐月抄，基数由调用方声明。 */
const OVERTIME_MONTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["month", "base_yuan"],
  properties: {
    month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
    workday_hours: { type: "number", minimum: 0, maximum: 400 },
    restday_hours: { type: "number", minimum: 0, maximum: 400 },
    holiday_hours: { type: "number", minimum: 0, maximum: 400 },
    base_yuan: { type: "number", exclusiveMinimum: 0 },
    paid_yuan: { type: "number", minimum: 0 },
    note: { type: "string" },
  },
};
/** calc.ledger 的待核日期区间（第 58 批）：只知道最早、最晚的付款日或起算日。 */
const LEDGER_DATE_RANGE_SCHEMA = { type: "object", additionalProperties: false, required: ["earliest", "latest"], properties: { earliest: dateSchema, latest: dateSchema, note: { type: "string" } } };
/** docx.revise 的一条修改（patches 与补交 amend 里同一结构）。 */
const REVISE_PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["anchor", "proposed_text"],
  properties: {
    anchor: { type: "string" },
    proposed_text: { type: "string" },
    occurrence: { type: "integer", minimum: 0 },
    paragraph_hint: { type: "string" },
    comment: { type: "string" },
    insert_after: { type: "boolean" },
    insert_after_table: { type: "boolean" },
    insert_row_after: { type: "boolean" },
    delete_row: { type: "boolean" },
  },
};

export const TOOLS: readonly ToolDef[] = [
  {
    name: "law.get_version",
    title: "法规版本查询",
    description: "按法名与适用时点返回适用版本（现行与历史适用分开）；注册库没有的法源如实返回 found=false，不伪造。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["law", "as_of"],
      properties: { law: { type: "string" }, as_of: dateSchema, topic: { type: "string" } },
    },
    invoke: (p, ctx) => lawGetVersion(ctx.lawdb, p),
  },
  {
    name: "law.search",
    title: "法规检索（注册库内）",
    description: "在本所法规库内检索：按法名或简称找法规版本（results），并按关键词在已收录的条文里找相关的条（articles：法名、条号、片段；如“竞业限制”“违法解除 赔偿金”“劳动合同法 严重违反规章制度”）。要引用的条再用 law.get_article 取原文。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    invoke: (p, ctx) => lawSearch(ctx.lawdb, p),
  },
  {
    name: "law.get_article",
    title: "取条文原文",
    description:
      "按法名（或简称）、条号与适用时点取法规库内该条原文，版本选择与 law.get_version 一致。article 可写 585 或“第五百八十五条”。库外法源、该时点无适用版本、条号不存在或正文未采集时返回 found=false，不提供任何文本——不得凭记忆补写条文。reliability=demo_seed 为演示数据，不得作为正式引用。本工具只给原文，不判断是否支持结论。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["law", "article"],
      properties: {
        law: { type: "string" },
        article: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string" }] },
        as_of: dateSchema,
      },
    },
    invoke: (p, ctx) => lawGetArticle(ctx.lawdb, p),
  },
  {
    name: "citations.verify",
    title: "引用核验",
    description: "抽取文本中的法条引用并做四态核验（来源已核/版本已核/支持待判；无法核实则拦截并可见），支持改引建议。",
    sideEffect: "read",
    resource: "lawdb",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["as_of"],
      properties: {
        text: { type: "string" },
        citations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["law", "article"],
            properties: { law: { type: "string" }, article: { type: "integer" } },
          },
        },
        as_of: dateSchema,
        topic_hint: { type: "string" },
      },
    },
    // 给助手的口径说明（第 35 批真实走查 R3：助手把“支持待判”读成“核验未通过”，劳动争议意见书准备把结论全部降为“初步”）
    invoke: (p, ctx) => {
      const r = citationsVerify(ctx.lawdb, p);
      return {
        ...r,
        note: "support_pending（支持待判）是正常结果：条文存在、适用版本现行有效，来源与版本已核；是否支持你的论点由你读 law.get_article 的原文判断后写明，不是核验失败。intercepted（拦截）表示没有核过：reasons 以 unknown_source: 开头的是法规库未收录这部法规（不是条文不存在，写“法规库未收录”，须律师查官方文本）；其余（条号超出、已改号、该时点无有效版本）不得照引，renumbered 时按 suggestion 改引；unverified_offline 是案号等无法离线核验的引用",
      };
    },
  },
  {
    name: "calc.interest",
    title: "利息计算（LPR 分段）",
    description:
      "确定性利息计算：分段保存起止日、日数、利率、年日数与舍入假设。rate 三种：fixed 固定年利率；lpr_plus 一年期 LPR 加基点；lpr_times 一年期 LPR 的倍数（如逾期付款违约金按 LPR 上浮 30%～50% 写 1.3～1.5，民间借贷保护上限四倍写 4）。warnings 非空时须原样告知律师。",
    sideEffect: "read",
    resource: "pure",
    version: "2",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["principal_yuan", "start_date", "end_date", "rate"],
      properties: {
        principal_yuan: { type: "number", minimum: 0 },
        start_date: dateSchema,
        end_date: dateSchema,
        year_days: { type: "integer", enum: [360, 365] },
        rate: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "annual_pct"],
              properties: { kind: { const: "fixed" }, annual_pct: { type: "number" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "lpr_term", "plus_bp"],
              properties: { kind: { const: "lpr_plus" }, lpr_term: { const: "1Y" }, plus_bp: { type: "number" } },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["kind", "lpr_term", "multiple"],
              properties: { kind: { const: "lpr_times" }, lpr_term: { const: "1Y" }, multiple: { type: "number", exclusiveMinimum: 0, maximum: 4 } },
            },
          ],
        },
      },
    },
    invoke: (p) => calcInterest(p),
  },
  {
    // 第 57 批（D-228）：第 56 批十三卡真实验收里的金额错误都出在“段与段之间”——抵充、余额、各口径合计由模型心算后手敲进表格
    name: "calc.ledger",
    title: "债权台账（分段计息、还款抵充、汇总）",
    description:
      "一次算完一笔或几笔欠款到某日为止的全部金额：本金随每笔付款变动自动分段计息或计违约金，每笔付款按抵充顺序逐笔冲抵，给出本金余额、已冲与未付的利息、违约金、费用和未清偿合计；你只给事实与口径，不做任何加减乘除，也不用自己分段（每笔款项只在自己的基数或利率变化时分段）。每个口径的 premise 写这个口径成立的前提（一句话），表里汇总页会单列一行“口径前提”——表是工具算出来的，之后不能逐格改，前提要在调用时写全。" +
      "scenarios 里每个口径独立计算（最多 4 个，有争议的口径各写一个并列）：as_of 暂计截止日（含当日，不要自己加一天）；debts 每笔款项写 label、amount_yuan，起算写 due_date（最后履行日，系统自次日起算）或 accrue_from（起算日，含当日）二选一，计到某日为止的写 accrue_to（含当日，如逾期交货计到实际交付的前一日）。" +
      "kind：principal（缺省，本金；按 rate 计得的是利息还是违约金用 accrual 写明——逾期付款违约金写 accrual: penalty，借款利息、资金占用费写 interest，可在口径上统一写）；penalty 是违约金的计算基数（如逾期交付货物的价款、迟延履行部分的价款），amount_yuan 填实际基数，基数本身不计入欠款合计、不参与抵充，只计出违约金；" +
      "penalty_fixed 是数额已经确定的违约金；interest 是数额已经确定的利息；cost 是实现债权的费用或应由对方负担的诉讼费。cap_yuan 写在口径上是利息或违约金的总上限，写在某一笔上是这一笔的上限（各部分分别适用上限时逐笔写）。" +
      "payments 逐笔写 date、amount_yuan；付款日或起算日只知道区间的，改写 date_range / due_date_range / accrue_from_range { earliest, latest }，系统按最早、最晚各算一个口径并列，并标出哪几段依赖待核日期——不要因为一个日期不明就放弃其他确定的期间。" +
      "rate 写 daily（per_10k：日万分之五写 5）、fixed（annual_pct）、lpr_plus（plus_bp）或 lpr_times（multiple）。" +
      "allocation 抵充顺序：cost_interest_principal（缺省，费用 → 利息 → 本金，没有约定时民法典第五百六十一条的顺序）、principal_only（付款只冲本金，利息、违约金另行全额计——双方对账确认了本金余额或约定付款即还本时用）、principal_first。" +
      "违约金不当然适用第五百六十一条的“利息”顺序：缺省 penalty_order: after_principal（违约金排在本金之后、另行主张）；律师明确选择“违约金按利息顺序先冲”时写 as_interest（有争议的口径，答复里写明）。payment_day 缺省 not_counted（付款当日不计）。" +
      "有违约金的口径可写 penalty_check：律师给出或材料载明的损失数额写 loss_yuan，或损失的计算标准写 loss_rate（如资金占用损失按一年期 LPR），系统按合同编通则解释第六十五条给出“损失 × 130%”的参照比较；都没有的只返回需要的证据，不要自己编损失数额。" +
      "申请执行算迟延履行期间的加倍部分债务利息：加 doubled { due_date: 履行期间最后一日 }（系统自次日起按日万分之一点七五计，基数随清偿减少，清偿时排在判决确定的金钱债务之后）；哪几笔计入基数用各笔的 in_doubled_base 标注（缺省本金、费用、已确定的违约金计入，利息不计入）。" +
      "给了 title 就把结果直接生成 Excel 计算表并登记为本任务成果（汇总、分段计算、付款与抵扣、参数与假设；数字由系统写入并带公式，日期是日期格）：notes 逐行写参数的出处与确认状态（item、value、source、status），extra_sheets 可附加你自己写的表（如诉讼费预估）。" +
      "返回各口径的 summary（一句话结论，可照抄进文书）、totals、segments、payments、penalty_check、pending_dates；文书和答复里用到的金额逐字照抄返回值。warnings 用自己的话向律师说明它影响哪个数。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["scenarios"],
      properties: {
        title: { type: "string" },
        scenarios: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["as_of", "debts"],
            properties: {
              name: { type: "string" },
              // 第 58 批：这个口径成立的前提，写进汇总表“口径前提”一行
              premise: { type: "string", maxLength: 300 },
              as_of: dateSchema,
              debts: {
                type: "array",
                minItems: 1,
                maxItems: 60,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["label", "amount_yuan"],
                  properties: {
                    label: { type: "string" },
                    amount_yuan: { type: "number", minimum: 0 },
                    kind: { type: "string", enum: ["principal", "cost", "interest", "penalty", "penalty_fixed"] },
                    due_date: dateSchema,
                    accrue_from: dateSchema,
                    due_date_range: LEDGER_DATE_RANGE_SCHEMA,
                    accrue_from_range: LEDGER_DATE_RANGE_SCHEMA,
                    accrue_to: dateSchema,
                    accrual: { type: "string", enum: ["interest", "penalty"] },
                    rate: LEDGER_RATE_SCHEMA,
                    in_doubled_base: { type: "boolean" },
                    cap_yuan: { type: "number", minimum: 0 },
                  },
                },
              },
              payments: {
                type: "array",
                maxItems: 200,
                items: { type: "object", additionalProperties: false, required: ["amount_yuan"], properties: { date: dateSchema, date_range: LEDGER_DATE_RANGE_SCHEMA, amount_yuan: { type: "number", exclusiveMinimum: 0 }, note: { type: "string" } } },
              },
              rate: LEDGER_RATE_SCHEMA,
              year_days: { type: "integer", enum: [360, 365] },
              payment_day: { type: "string", enum: ["not_counted", "counted"] },
              allocation: { type: "string", enum: ["cost_interest_principal", "principal_only", "principal_first"] },
              accrual: { type: "string", enum: ["interest", "penalty"] },
              penalty_order: { type: "string", enum: ["after_principal", "as_interest"] },
              cap_yuan: { type: "number", minimum: 0 },
              penalty_check: { type: "object", additionalProperties: false, properties: { loss_yuan: { type: "number", minimum: 0 }, loss_rate: LEDGER_RATE_SCHEMA, loss_basis: { type: "string" } } },
              doubled:{ type: "object", additionalProperties: false, properties: { due_date: dateSchema, accrue_from: dateSchema, per_10k: { type: "number", exclusiveMinimum: 0, maximum: 100 } } },
            },
          },
        },
        notes: {
          type: "array",
          maxItems: 200,
          items: { type: "object", additionalProperties: false, required: ["item"], properties: { scenario: { type: "string" }, item: { type: "string" }, value: {}, source: { type: "string" }, status: { type: "string" } } },
        },
        extra_sheets: {
          type: "array",
          maxItems: 3,
          items: { type: "object", additionalProperties: false, required: ["name", "columns", "rows"], properties: { name: { type: "string" }, columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: {} } } } },
        },
      },
    },
    invoke: (p, ctx) => calcLedgerTool(ctx, p),
  },
  {
    name: "calc.deadline",
    title: "期间计算（法定期间与工作日）",
    description:
      "确定性计算期间届满日并给出逐步过程、所用法条与节假日数据来源。start 为起算事实发生日（YYYY-MM-DD；只知道月份时写 YYYY-MM，只返回区间、deadline 为 null）。rule=civil：民法典第二百至二百零四条（开始当日不计入；按月、年以到期月对应日为末日，无对应日取月末；末日为周末或法定节假日顺延，调休上班日不顺延），period.unit 用 day / month / year；rule=workday：法律明确规定按工作日计算的期间（如行政处罚法第八十五条），period.unit 用 workday。不处理中止、中断与在途时间；warnings 非空时须原样告知律师。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start", "period", "rule"],
      properties: {
        start: { type: "string", pattern: "^\\d{4}-\\d{2}(-\\d{2})?$" },
        period: {
          type: "object",
          additionalProperties: false,
          required: ["unit", "n"],
          properties: {
            unit: { type: "string", enum: ["day", "month", "year", "workday"] },
            n: { type: "integer", minimum: 1 },
          },
        },
        rule: { type: "string", enum: ["civil", "workday"] },
      },
    },
    invoke: (p) => calcDeadline(p),
  },
  {
    name: "calc.labor",
    title: "劳动经济补偿与赔偿金",
    description:
      "确定性计算解除或终止劳动合同的经济补偿 N（kind=compensation，劳动合同法第四十七条）或违法解除赔偿金 2N（kind=unlawful，第八十七条、实施条例第二十五条），逐步写出年限、基数、三倍封顶与代通知金。start_date 写入职日（用工之日），end_date 写劳动关系的最后一日（含当日）。" +
      "月工资三种给法（只给一种）：①有工资台账的写 wage_table——months 把台账逐月各项目原样抄一次（month 如 2026-08，items 写“项目名: 金额”，扣款写负数），include 写本口径计入月工资的项目名；工资构成有争议（加班费、年终奖计不计入，扣款加不加回）时每个口径调用一次、只改 include，不要自己把数剔除或加回后再传；②只有逐月合计数的写 monthly_wages_yuan；③只有一个平均数的写 avg_monthly_wage_yuan。当地上年度职工月平均工资、最低工资由律师或材料给出，不要凭记忆填；没给时结果带 warnings。2008 年以前的工作年限按当时规定另算，不在结果里。" +
      "未休年休假工资报酬用 kind=annual_leave：给月工资（剔除加班工资后的月平均，同上两种给法）与 unused_days（应休未休天数），leave_multiple 缺省 2（正常工资已发，另付 200%）、全额 300% 写 3；这一类不需要 start_date、end_date。是否应当支付由律师判断，本工具只算数额；warnings 用自己的话向律师说明。" +
      "加班费与加班费差额用 kind=overtime（第 58 批）：months 逐月写 month（YYYY-MM）、base_yuan（当月加班费计算基数，口径在 base_basis 写明）、workday_hours（工作日延长工作时间）、restday_hours（休息日加班又不能安排补休的；已安排补休的不填）、holiday_hours（法定休假日）、paid_yuan（当月已付加班费）——小时数照考勤或台账原样逐月抄，不要自己合计；" +
      "divisor_days 缺省 21.75、hours_per_day 缺省 8，倍数缺省 150% / 200% / 300%（劳动法第四十四条，multiples 可改）。工具逐月算小时工资、各类加班费、应付、差额（已付超过应付的该月按 0 计）与合计。要成表的，把同一组参数放进 xlsx.render_table 的 computed（tool 写 calc.labor），表由内核写入并带公式，不要自己抄数。",
    sideEffect: "read",
    resource: "pure",
    version: "3",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        start_date: dateSchema,
        end_date: dateSchema,
        kind: { type: "string", enum: ["compensation", "unlawful", "annual_leave", "overtime"] },
        months: { type: "array", minItems: 1, maxItems: 60, items: OVERTIME_MONTH_SCHEMA },
        divisor_days: { type: "number", exclusiveMinimum: 0, maximum: 31 },
        hours_per_day: { type: "number", exclusiveMinimum: 0, maximum: 24 },
        multiples: { type: "object", additionalProperties: false, properties: { workday: { type: "number", exclusiveMinimum: 0, maximum: 10 }, restday: { type: "number", exclusiveMinimum: 0, maximum: 10 }, holiday: { type: "number", exclusiveMinimum: 0, maximum: 10 } } },
        base_basis: { type: "string" },
        avg_monthly_wage_yuan: { type: "number", minimum: 0 },
        monthly_wages_yuan: { type: "array", minItems: 1, maxItems: 12, items: { type: "number", minimum: 0 } },
        wage_table: {
          type: "object",
          additionalProperties: false,
          required: ["months", "include"],
          properties: {
            months: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["month", "items"], properties: { month: { type: "string" }, items: { type: "object", additionalProperties: { type: "number" } } } } },
            include: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } },
          },
        },
        unused_days: { type: "number", exclusiveMinimum: 0, maximum: 60 },
        leave_multiple: { type: "integer", enum: [2, 3] },
        local_avg_monthly_wage_yuan: { type: "number", minimum: 0 },
        local_min_wage_yuan: { type: "number", minimum: 0 },
        notice_in_lieu: { type: "boolean" },
        last_month_wage_yuan: { type: "number", minimum: 0 },
      },
    },
    invoke: (p) => (p?.kind === "annual_leave" ? calcAnnualLeave(p) : p?.kind === "overtime" ? calcOvertime(p) : calcLabor(p)),
  },
  {
    name: "calc.court_fee",
    title: "诉讼费用",
    description:
      "确定性计算诉讼费用（《诉讼费用交纳办法》）：kind=case_property 财产案件受理费（分段累计，第十三条；上诉按不服一审判决部分的上诉请求数额）、enforcement 申请执行费、preservation 保全申请费（按实际保全的财产数额，最多 5000 元）、payment_order 支付令申请费（受理费标准的 1/3）、labor 劳动争议案件（每件 10 元）。" +
      "reductions 写减半情形（mediation_or_withdrawal 调解或撤诉、simple_procedure 简易程序、counterclaim 反诉或第三人请求合并审理），只减半一次。逐段写出过程；结果是预估，以法院交费通知为准；warnings 非空时须原样告知律师。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: ["case_property", "enforcement", "preservation", "payment_order", "labor"] },
        amount_yuan: { type: "number", minimum: 0 },
        reductions: { type: "array", maxItems: 3, items: { type: "string", enum: ["mediation_or_withdrawal", "simple_procedure", "counterclaim"] } },
      },
    },
    invoke: (p) => calcCourtFee(p),
  },
  {
    name: "redact.scan",
    title: "直接标识符扫描",
    description: "确定性扫描身份证/手机号/银行卡/统一社会信用代码/邮箱/车牌；未覆盖类别如实列出。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string" } },
    },
    invoke: (p) => redactScan(p),
  },
  {
    name: "materials.read_excerpt",
    title: "读取材料片段",
    description: "按解析版本与字符区间/锚点读取材料文本；令牌须绑定对应事项。律师发起时勾选了材料的，只能读勾选的那几份。",
    sideEffect: "read",
    resource: "matter_materials",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["parse_version_id"],
      properties: {
        parse_version_id: { type: "string" },
        char_start: { type: "integer", minimum: 0 },
        char_end: { type: "integer", minimum: 0 },
        anchor_id: { type: "string" },
      },
    },
    invoke: async (p, ctx) => materialsReadExcerpt(ctx.db, ctx.claims.mid, p, (id) => assertMaterialInScope(ctx, id)),
  },
  {
    name: "docx.apply_revisions",
    title: "写入原生修订",
    description: "在 DOCX 上按锚点写入 w:ins/w:del 与批注；基线或原文 hash 不符即整体停止，不覆盖原件。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id", "baseline_hash", "ops"],
      properties: {
        document_version_id: { type: "string" },
        baseline_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        ops: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["opId", "anchor", "originalHash", "newText", "author"],
            properties: {
              opId: { type: "string" },
              anchor: {
                type: "object",
                additionalProperties: false,
                required: ["originalText"],
                properties: {
                  originalText: { type: "string" },
                  occurrence: { type: "integer", minimum: 0 },
                  paragraphHint: { type: "string" },
                },
              },
              originalHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
              newText: { type: "string" },
              comment: { type: "string" },
              ruleId: { type: "string" },
              riskLevel: { type: "string", enum: ["high", "mid", "low"] },
              author: { type: "string" },
            },
          },
        },
      },
    },
    invoke: async (p, ctx) => (assertMaterialInScope(ctx, p?.document_version_id), docxApplyRevisions(ctx.db, ctx.blobs, ctx.claims.mid, p)),
  },
  {
    name: "docx.compare",
    title: "整稿比对（含静默改动检出）",
    description: "基线与回稿段落级比对；未被修订标记覆盖的改动判为静默改动。",
    sideEffect: "read",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseline_document_version_id", "current_document_version_id"],
      properties: {
        baseline_document_version_id: { type: "string" },
        current_document_version_id: { type: "string" },
      },
    },
    invoke: async (p, ctx) => (assertMaterialInScope(ctx, p?.baseline_document_version_id), assertMaterialInScope(ctx, p?.current_document_version_id), docxCompare(ctx.db, ctx.blobs, ctx.claims.mid, p, ctx.tokens && ctx.claims.mid ? (s: string) => ctx.tokens!.restore(ctx.claims.mid!, s) : undefined)),
  },
  {
    name: "docx.sanitize",
    title: "受众净化",
    description: "接受修订、清除批注与作者属性，产出对外版本；保留生成标识。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: { document_version_id: { type: "string" } },
    },
    invoke: async (p, ctx) => (assertMaterialInScope(ctx, p?.document_version_id), docxSanitize(ctx.db, ctx.blobs, ctx.claims.mid, p)),
  },
  {
    name: "docx.render_report",
    title: "生成文书（DOCX）",
    description:
      "按标题与段落结构生成 Word 文书（备忘录、意见书、函件、合同、诉状），登记为本任务的草稿成果交律师审阅；导出时按事项令牌表还原代号。" +
      "文书正文里要成表的内容（合同价款表、设备清单、付款节点、证据目录、当事人或股权结构表）用该节的 table 画成 Word 表格：columns 为表头，rows 每行格数与表头相同，画在本节段落之后；表后还有正文的，另起一节、heading 写空字符串。每节至多一张表、每表 1–10 列、最多 300 行；格内写文字，数量、序号可写整数；金额按文书写法写成文字（如“1,200,000.00”），不要传带小数的数字。" +
      "格数不符或超限时整份不生成并逐条说明，改正后重交。分析用的大表（争点矩阵、尽调清单等）仍用 xlsx.render_table 作附件。" +
      "每节可写 level 表示节标题层级（缺省 1）：按中文法律文书惯例，大节用 1（“一、”），大节下的小节用 2（“（一）”），再下一层用 3（“1.”）；小标题写成单独一节并标对层级，不要都写成 1 级。" +
      "返回的 quality_check 是交付前检查（工具用语或内部编号外露、正文夹杂英文、Markdown 符号、条款编号不连续、互引指向不存在的条款、大小写金额不一致、错误条号）：issues 不为空时用 docx.edit_draft 在这份文书上逐处改正（几秒完成），不要整份重新生成；确实不需要改的在最终答复里说明理由。" +
      "生成前先在心里把全文写完、自查一遍再一次提交；生成后的局部修改一律用 docx.edit_draft。" +
      "律师要求“一页纸”的汇报用 layout: one_page（宋体五号、单倍行距），同时控制字数；" +
      "本任务有待律师确认的论点提纲（outline.submit）时拒绝生成，先等律师确认。",
    sideEffect: "write_draft",
    resource: "matter_work",
    // V18 首轮 B11：节标题层级 level（v5）
    version: "6",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sections"],
      properties: {
        title: { type: "string" },
        // 第 58 批：one_page 为“一页纸”汇报的紧凑版式（宋体五号、单倍行距）
        layout: { type: "string", enum: ["standard", "one_page"] },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: {
              heading: { type: "string" },
              // V18 首轮 B11：节标题层级（1 大节“一、”，2 小节“（一）”，3 再下一层“1.”）；缺省 1
              level: { type: "integer", minimum: 1, maximum: 3 },
              paragraphs: { type: "array", items: { type: "string" } },
              // 第 32 批：节内表格（v4）；格子接受文字或整数，内核再逐行核对格数与小数
              table: {
                type: "object",
                additionalProperties: false,
                required: ["columns", "rows"],
                properties: {
                  columns: { type: "array", items: { type: "string" } },
                  rows: { type: "array", items: { type: "array", items: {} } },
                },
              },
            },
          },
        },
      },
    },
    invoke: async (p, ctx) => {
      // 起草前的论点与依据还在等律师确认时不出文书（v9.4 第 19 批 C-04）
      assertOutlineSettled(ctx.db, typeof ctx.claims.rid === "string" ? ctx.claims.rid : null);
      // 事实对照（V16 第 41 批）：内部文书正文引用了“事实 N”的，文末自动加一节对照表；对外文书不加，由交付前检查报出改成证据名称
      // 质量说明（第 42 批）：“通用辅助 · 未经本所质量验收”“草稿 · 待律师复核”不进任何交付文件——独立成段的由内核直接删掉，不靠助手自觉
      const scrubbed = Array.isArray(p.sections) ? scrubQualitySections(p.sections as DeliverableSection[]) : { sections: p.sections, removed: 0 };
      if (scrubbed.removed > 0) p = { ...p, sections: scrubbed.sections };
      const facts = ctx.claims.rid && ctx.claims.mid ? factSectionFor(ctx, p) : null;
      if (facts?.section) p = { ...p, sections: [...p.sections, facts.section] };
      const r = docxRenderReport(ctx.blobs, p, ctx.claims.mid);
      const auto_cleaned = qualityScrubNote(scrubbed.removed);
      // 交付前检查（第 35 批）：工具用语与内部编号外露、夹杂英文、条款编号与互引、大小写金额、错误条号——随结果交回助手当场改正
      const quality_check = deliverableQualityFor(ctx, p, r.storage_uri);
      // 任务内调用（Agent 经本机端点）：登记为草稿成果，律师在执行态与交付件页可见
      if (!ctx.claims.rid) return { ...r, ...(quality_check ? { quality_check } : {}), ...(auto_cleaned ? { auto_cleaned } : {}) };
      const title = String(p.title ?? "文书").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 60) || "文书";
      const textChars = sectionChars(p.sections);
      const reg = registerToolArtifact(ctx, { kind: "agent_report", filename: `${title}.docx`, sha256: r.sha256, storage_uri: r.storage_uri, manifest: { tool: "docx.render_report", sections: Array.isArray(p.sections) ? p.sections.length : 0, tables: Array.isArray(p.sections) ? p.sections.filter((s: any) => s?.table).length : 0, text_chars: textChars, ...(facts?.section ? { fact_section: "auto" } : {}) } });
      // 版本缩水检查（第 35 批）：同一任务里重出的同名文书比上一版明显变短，提示助手核对是否漏了内容
      const shrink = reg.reused ? null : shrinkCheck(ctx.db, ctx.claims.rid, "agent_report", reg.filename, reg.artifact_version_id, textChars);
      return { ...r, ...reg, ...(quality_check ? { quality_check } : {}), ...(auto_cleaned ? { auto_cleaned } : {}), ...(shrink ? { shrink } : {}), ...(facts?.note ? { fact_table: facts.note } : {}) };
    },
  },
  {
    name: "docx.revise",
    title: "在原件上修订（修订稿 + 清洁稿）",
    description:
      "按律师意见修改已上传的 Word 原件：每处给出要改的原文（anchor，逐字照抄材料原文、同一段落之内）与新文字（proposed_text，空串为删除；insert_after=true 为在该段之后插入新段落），" +
      "表格相关：insert_after_table=true 把新段落插在整张表格之后（“在第 6.1 款及其后表格之后新增一款”：anchor 写表格前紧挨着的那一段、或表格里任一格的原文，新款沿用表格前那一段的格式与自动编号）；insert_row_after=true 在 anchor 所在的表格行之后新增一行（proposed_text 各格用“｜”分隔，纵向合并的格子留空或不写；整行以修订痕迹显示）；delete_row=true 删除 anchor 所在的整行（proposed_text 为空串）。这四种落位一条修改只用一种。" +
      "表格里的格子：anchor 只写这一格的原文，paragraph_hint 写“行名｜列名”（如“定金｜比例”），行名、列名照原件写。" +
      "在原件副本上生成带修订痕迹的修订稿（保留原版式、编号、表格）与接受全部修订后的清洁稿，并由系统按实际写入的修改生成《修改对照表》（逐段修改前、修改后与理由），登记为本任务草稿成果；原件不变。" +
      "直接正式提交：写入后返回 changes（每个改到的段落改前与改后的整段文字），逐段读一遍。任一处找不到或有歧义时整体不写，逐条返回原因（index 是第几条，从 1 起）。" +
      "补交：内核记着本任务对这份原件上一次提交的完整清单（试写、被退回、已写入都算），更正时不要重发全部修改，只写 amend——replace 按 index 换掉几条、remove 去掉几条、add 在末尾加几条（amend: {} 即照上一次清单原样提交）；给了 amend 就不给 patches。内核合成新的完整清单后从原件重新生成，已写入过的生成新版本、旧版本保留。" +
      "dry_run=true 只试写、不生成文件（清单特别大或律师要先看预览时用），试写后正式写入用 amend: {}。" +
      "页眉、页脚里的文字（材料正文里看不到，试写结果的 header_footer_text 会列出）也能改：该条 paragraph_hint 写“页眉”或“页脚”，anchor 照抄 header_footer_text 里的原文；页眉页脚不加批注，修改理由写在最终答复里。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: {
        document_version_id: { type: "string" },
        dry_run: { type: "boolean" },
        patches: { type: "array", items: REVISE_PATCH_SCHEMA },
        amend: {
          type: "object",
          additionalProperties: false,
          properties: {
            replace: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: ["index", "patch"], properties: { index: { type: "integer", minimum: 1 }, patch: REVISE_PATCH_SCHEMA } },
            },
            remove: { type: "array", items: { type: "integer", minimum: 1 } },
            add: { type: "array", items: REVISE_PATCH_SCHEMA },
          },
        },
      },
    },
    invoke: async (p, ctx) => (assertMaterialInScope(ctx, p?.document_version_id), docxRevise(ctx, p)),
  },
  {
    // 第 35 批真实走查 N1：自查改两个词要整份重出约 1 万字的协议（一次 2～6 分钟），5 次重出用完工作时限
    name: "docx.edit_draft",
    title: "修改本任务的文书草稿",
    description:
      "在本任务里你已用 docx.render_report 生成的 Word 文书上逐处修改（交付前检查报出的问题、自查发现的措辞、条号、金额、遗漏的款项等），几秒完成，登记为同名文书的新版本（旧版本保留）：" +
      "artifact_version_id 写 docx.render_report（或上一次本工具）返回的编号；每处给出要改的原文（anchor，逐字照抄这份文书里的文字、同一段落之内）与新文字（proposed_text，空串为删除；insert_after=true 为在该段之后插入新段落，按换行分段；新段落的样式用 style 写：body 正文，heading1/heading2/heading3 为第一行作一、二、三级标题、其余各行正文——不写时插在标题之后的按正文，插在正文之后的沿用锚点段落；新增一节或一个问题的，锚点选它在文中应在位置的前一段（按条号、问题序号排好），不要都插到文末）。" +
      "只改要改的地方，不要为改几处整份重新生成；整体结构要变（增删多条、重排章节）才用 docx.render_report 重出。律师上传的材料不能用本工具，用 docx.revise。" +
      "同一段文字在文书里出现几处（如同一金额既在某一格、又在另一格的算式里）：occurrence 写全文第几处（按先后，含表格格子，从 1 起），或 paragraph_hint 写位置（正文写条款号或该段独有的文字，表格格子写“行名｜列名”）；给了位置提示的，即使全文只有一处也要与提示相符才写。" +
      "能定位的各处先写入（status=partial），找不到或有歧义的逐条退回：conflicts 每条的 patch_no 是你提交的 patches 中的第几处（从 1 起，按提交顺序），anchor 是那一处的原文，有歧义的列出各处的位置与上下文（matches）；applied_patch_nos 是已写入的几处。改正后用新编号只重交退回的几处；dry_run=true 试写返回同样的逐条明细。改好后返回新版本的交付前检查 quality_check。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "3",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifact_version_id", "patches"],
      properties: {
        artifact_version_id: { type: "string" },
        dry_run: { type: "boolean" },
        patches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["anchor", "proposed_text"],
            properties: {
              anchor: { type: "string" },
              proposed_text: { type: "string" },
              // 下限留 0：写 0 的由工具退回并说明“从 1 起、按全文先后”，比参数校验报“小于下限”更能让模型改对
              occurrence: { type: "integer", minimum: 0 },
              paragraph_hint: { type: "string" },
              insert_after: { type: "boolean" },
              // 第 58 批（D-242）：插入的新段落用什么样式；不给时插在标题之后按正文、插在正文之后沿用锚点段落
              style: { type: "string", enum: ["body", "heading1", "heading2", "heading3"] },
            },
          },
        },
      },
    },
    invoke: async (p, ctx) => {
      const r = docxEditDraft(ctx, p);
      if (r.status !== "applied") return r;
      // 改后对新版本重做交付前检查（节结构按文书引擎的标题样式还原）
      const row = ctx.db.get<{ storage_uri: string }>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [r.artifact_version_id]);
      const quality_check = row ? deliverableQualityFor(ctx, sectionsOfDocx(ctx.blobs.read(row.storage_uri)), row.storage_uri) : null;
      return { ...r, ...(quality_check ? { quality_check } : {}) };
    },
  },
  {
    name: "redact.apply",
    title: "生成脱敏件与脱敏报告",
    description: "按确定性扫描结果遮盖直接标识符，产出脱敏件（不留修订痕迹）与替换统计；未覆盖类别如实声明。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id"],
      properties: { document_version_id: { type: "string" } },
    },
    invoke: async (p, ctx) => (assertMaterialInScope(ctx, p?.document_version_id), redactApply(ctx.db, ctx.blobs, ctx.claims.mid, p)),
  },
  {
    name: "materials.list",
    title: "材料目录",
    description:
      "列出本任务的材料：快照序号、解析版本、字数、页数与识别质量（partial/unreadable 表示有页未能识别，须在结论中写明哪几页没有读到，全部读到的不必说明）；律师发起时勾选了材料的，本事项里没勾的只列文件名（not_provided），不能读取；" +
      "另带系统按规则比出的金额不一致：amount_conflicts（这份材料里大写与小写金额对不上）、cross_material_conflicts（不同材料对同一天的付款写了不同金额），有的要列进交付件的矛盾或缺口、请律师核对原件。" +
      "这些是系统内部字段，交付件里用“序号”“能否读清”等律师的说法，不照抄字段名和取值。",
    sideEffect: "read",
    resource: "matter_materials",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    invoke: (_p, ctx) => materialsList(ctx),
  },
  {
    name: "riskcards.submit",
    title: "提交风险卡",
    description:
      "把合同审查发现的问题作为结构化风险卡提交到律师的审查工作台（不要只写在正文里）。anchor_text 必须逐字摘自合同原文（与材料快照一致，含代号），便于定位与生成原生修订；basis 列法律依据（法名 + 条号，内核离线核验）。" +
      "nature 标明建议的性质：must 必须修改（法律硬伤、律所红线）/ should 建议修改 / negotiable 可谈判（商业条件）。谈判梯度三级：suggestion 首选（替换 anchor_text 的建议条款全文，不改则省略）→ fallback 可退让 → bottom_line 建议底线（供律师与客户商定的参考，最终由客户决定；不写“可签 / 不可签”结论）；商业条件尽量给全三级。" +
      "kind 分四类：risk 条款写了但不利（缺省）/ missing 该有的条款没有 / deviation 偏离本所或客户的审查规则 / consistency 定义、金额、日期、交叉引用前后不一致。" +
      "missing 卡：不写 anchor_text，改写 insert_after（逐字摘自建议插入位置之前那一段的原文，可省略）、suggestion（要补的条款全文），并在 searched_terms 列出查过的说法、searched_docs 列出查过的文件——内核会在材料里逐个复查，找得到的会标“可能误报”。" +
      "deviation 卡必须写 rule_ref（规则编号与要点）。rule_source 标明判断依据：law 法律强制 / firm_rule 本所或客户规则 / general 通用建议（没有规则时的意见，须律师判断）——不要把商业偏好写成法律强制。" +
      "跨文件审查：同一事项有补充协议、附件、附函的，先读全，按各文件合起来的有效约定判断；卡片挂在本合同的条款上，related 附另一份文件的逐字原文（document_version_id、quote，relation：amends 变更或补充了本条 / conflicts 与本条不一致 / refers 本条援引的内容），内核在那份文件里定位。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "4",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cards"],
      properties: {
        document_version_id: { type: "string" },
        cards: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["severity", "issue"],
            properties: {
              kind: { type: "string", enum: ["risk", "missing", "deviation", "consistency"] },
              clause_ref: { type: "string" },
              anchor_text: { type: "string" },
              insert_after: { type: "string" },
              rule_source: { type: "string", enum: ["law", "firm_rule", "general"] },
              rule_ref: { type: "string" },
              searched_terms: { type: "array", maxItems: 30, items: { type: "string" } },
              searched_docs: { type: "array", maxItems: 30, items: { type: "string" } },
              severity: { type: "string", enum: ["high", "mid", "low"] },
              category: { type: "string", enum: ["legal", "commercial", "both"] },
              issue: { type: "string" },
              basis: {
                type: "array",
                items: { type: "object", additionalProperties: false, required: ["law"], properties: { law: { type: "string" }, article: { type: "integer", minimum: 1 }, note: { type: "string" } } },
              },
              nature: { type: "string", enum: ["must", "should", "negotiable"] },
              suggestion: { type: "string" },
              fallback: { type: "string" },
              bottom_line: { type: "string" },
              needs_client_decision: { type: "boolean" },
              assumptions: { type: "string" },
              related: {
                type: "array",
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["document_version_id", "quote"],
                  properties: { document_version_id: { type: "string" }, quote: { type: "string" }, relation: { type: "string", enum: ["amends", "conflicts", "refers"] } },
                },
              },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => riskcardsSubmit(ctx, p),
  },
  {
    name: "riskcards.list",
    title: "读取风险卡",
    description: "读取本事项的风险卡及律师的处理结果（lawyer_status：proposed 待处理 / accepted 接受 / modified 修改后接受（lawyer_text 为律师改写的条款）/ rejected 不采纳）。写修订稿时只采用 accepted 与 modified；accepted 的卡按 chosen_level 用首选或可退让（adopted_text 即律师选用的文本）。",
    sideEffect: "read",
    resource: "matter_work",
    version: "2",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        document_version_id: { type: "string" },
        status: { type: "array", items: { type: "string", enum: ["proposed", "accepted", "modified", "rejected"] } },
        this_task_only: { type: "boolean" },
      },
    },
    invoke: (p, ctx) => riskcardsList(ctx, p),
  },
  {
    name: "table.get",
    title: "读取审阅表",
    description: "读取律师建的审阅表（表格审阅）：列（column 编号、列名、格式、填写说明）、材料（document_version_id）、每格状态。locked=true 的格子律师已核或已改，不要重填；unreadable 的材料读不出文字，不填。",
    sideEffect: "read",
    resource: "matter_work",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, required: ["table_id"], properties: { table_id: { type: "string" } } },
    invoke: (p, ctx) => tableGet(ctx, p),
  },
  {
    name: "table.fill",
    title: "填写审阅表",
    description:
      "逐格填写审阅表：每格写 document_version_id、column、value（按列格式：日期 YYYY-MM-DD 或 YYYY-MM，是否填“是 / 否”，选项列只填给定选项）与 quote（逐字摘自该材料，含代号原样，律师据此回原文核对）。" +
      "文件里确实没有的写 status=not_found（不写值）；同一份材料两处说法不一的写 status=conflict 并在 note 写明两处。律师已核、已改的格子不会被覆盖（回报 locked）；格式不对或没有引文的格子不收（回报 rejected）。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["table_id", "cells"],
      properties: {
        table_id: { type: "string" },
        cells: {
          type: "array",
          maxItems: 400,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["document_version_id", "column"],
            properties: {
              document_version_id: { type: "string" },
              column: { type: "string" },
              status: { type: "string", enum: ["found", "not_found", "conflict"] },
              value: { type: "string" },
              quote: { type: "string" },
              note: { type: "string" },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => tableFill(ctx, p),
  },
  {
    name: "outline.submit",
    title: "提交论点与依据（起草前确认）",
    description:
      "文书类任务（起诉状、答辩状、代理词、上诉状、法律研究备忘录等）在起草之前调用：逐条列出拟写的论点，每条附依据（法名 + 条号 + note 写这条怎么支持该论点）与所用事实（优先引用 facts.list 里的 fact_id）；counter 写对方最可能提出的反驳或抗辩（律师据此判断论点撑不撑得住），不写我方的处理口径、待核事项或给律师的说明。" +
      "内核离线核验每条依据并附上法规库里的条文原文，交律师在任务页逐条确认（留 / 删 / 改写、去掉不用的依据）。确认之前本任务不能生成文书；确认后用 outline.get 读取确认版，只按确认版起草。再次提交会取代前一份待确认的提纲。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["doc_kind", "arguments"],
      properties: {
        doc_kind: { type: "string" },
        title: { type: "string" },
        arguments: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim"],
            properties: {
              claim: { type: "string" },
              basis: {
                type: "array",
                maxItems: 8,
                items: { type: "object", additionalProperties: false, required: ["law"], properties: { law: { type: "string" }, article: { type: "integer", minimum: 1 }, note: { type: "string" } } },
              },
              facts: {
                type: "array",
                maxItems: 12,
                items: { type: "object", additionalProperties: false, properties: { fact_id: { type: "string" }, statement: { type: "string" } } },
              },
              counter: { type: "string" },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => outlineSubmit(ctx, p),
  },
  {
    name: "rules.propose",
    title: "起草本事项的审查要点（草稿）",
    description:
      "从本所或客户的范本（标准合同、采购标准、往来定稿）整理审查要点：每条写条款（topic）、我方标准（standard）、可退让（fallback，可省略）、不可谈（red_line，可省略），按范本原文概括，不添加范本里没有的立场。" +
      "写 red_line 的条目必须同时给 red_line_quote：范本里写明这条底线的原句，逐字照抄（含“不得 / 必须 / 不接受 / 红线”这类字眼）；给不出原句的不要写 red_line——系统会逐字核对，核对不上的不可谈不写入。" +
      "只存为草稿交律师在事项概览“审查要点”里审定；律师启用之前，任何任务都不会按它审查。同一任务再次提交取代本任务上一份草稿。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "rules"],
      properties: {
        title: { type: "string" },
        rules: {
          type: "array",
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["topic", "standard"],
            properties: { topic: { type: "string" }, standard: { type: "string" }, fallback: { type: "string" }, red_line: { type: "string" }, red_line_quote: { type: "string" } },
          },
        },
      },
    },
    invoke: (p, ctx) => rulesPropose(ctx, p),
  },
  {
    name: "outline.get",
    title: "读取律师确认的论点与依据",
    description:
      "读取本任务最新的论点提纲：status=proposed 表示律师还没确认（此时不要起草）；status=confirmed 时 confirmed_arguments 是确认版——只按它起草：律师删掉的论点不写，lawyer_edited=true 的论点按律师的写法，只引用留下的依据；lawyer_note 是律师的补充要求。",
    sideEffect: "read",
    resource: "matter_work",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    invoke: (_p, ctx) => outlineGet(ctx),
  },
  {
    name: "facts.submit",
    title: "提交事实",
    description:
      "把从材料中整理出的事实逐条提交到事实时间线（kind：claimed 材料声称 / inferred 推论 / to_confirm 待确认；不能标为已确认——由律师确认）。quote 逐字摘自 document_version_id 对应材料，occurred_on 为 YYYY-MM-DD（可只到年或月），amount_yuan 为金额（元）。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["facts"],
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["statement"],
            properties: {
              statement: { type: "string" },
              kind: { type: "string", enum: ["claimed", "inferred", "to_confirm"] },
              occurred_on: { type: "string" },
              amount_yuan: { type: "number" },
              party: { type: "string" },
              document_version_id: { type: "string" },
              quote: { type: "string" },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => factsSubmit(ctx, p),
  },
  {
    name: "facts.list",
    title: "读取事实",
    description: "读取本事项的事实时间线及律师确认状态；起草文书与汇报时只把 lawyer_status=confirmed 的事实写成确定陈述。",
    sideEffect: "read",
    resource: "matter_work",
    version: "1",
    inputSchema: { type: "object", additionalProperties: false, properties: { confirmed_only: { type: "boolean" } } },
    invoke: (p, ctx) => factsList(ctx, p),
  },
  {
    name: "xlsx.render_table",
    title: "生成表格（XLSX）",
    description:
      "按列生成 Excel 表格（证据目录、时间线、问题清单、计算明细等），登记为本任务的草稿成果交律师审阅；每个表 1–40 列、最多 5,000 行；单元格为文字或数字。生成后的局部修改（含交付前检查 quality_check 报出的问题）用 xlsx.edit_cells，不要整份重新生成。" +
      "computed（第 58 批）：加班费计算表不要自己抄数——写 { tool: \"calc.labor\", name: 工作表名, params: 与调用 calc.labor kind=overtime 相同的参数 }，内核按同一算法算出并写成带公式的工作表，排在 sheets 之后（只有计算表时 sheets 写空数组）。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "2",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sheets"],
      properties: {
        title: { type: "string" },
        computed: {
          type: "array",
          maxItems: 4,
          items: { type: "object", additionalProperties: false, required: ["tool", "params"], properties: { tool: { type: "string", enum: ["calc.labor"] }, name: { type: "string" }, params: { type: "object" } } },
        },
        sheets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "columns", "rows"],
            properties: {
              name: { type: "string" },
              columns: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: {} } },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => xlsxRenderTable(ctx, p),
  },
  {
    // V16 第 41 批真实走查（争点与证据分析）：5 张工作表、97 行的表格为改几处用语整份重出 4 次（每次 4～5 分钟），撞上 40 分钟时限
    name: "xlsx.edit_cells",
    title: "修改本任务的表格",
    description:
      "在本任务里你已用 xlsx.render_table 生成的表格上逐格修改（交付前检查 quality_check 报出的用语、内部编号，自查发现的金额、日期、遗漏的行等），几秒完成，登记为同名表格的新版本（旧版本保留）：" +
      "artifact_version_id 写 xlsx.render_table（或上一次本工具）返回的编号。edits 逐格改：sheet 工作表名、row 数据行号（从 1 起、不含表头，与 quality_check 里“××表格第 N 行”一致）、column 列名（逐字照抄表头）、value 新值（文字、数字，null 为清空）；" +
      "replace 把文字格子里的 find 逐字替换为 with（不含表头，find 至少 2 个字，可用 sheet 限定一张表，返回替换了几处）——同一个说法在许多格子里出现时用它一次改完；" +
      "delete_rows 删除行、append_rows 在表末追加行（每行按表头的列依次给值）；行号一律按这次修改前的表格。" +
      "只改要改的格子，不要为改几处整份重新生成；整体结构要变（增删列、重排工作表）才用 xlsx.render_table 重出。律师上传的 Excel 材料不能用本工具。" +
      "能定位的先写入（status=partial），定位不到的逐条退回原因，改正后用新编号只重交这几处；改好后返回新版本的 quality_check，检查通过后不要为润色再整份重出。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["artifact_version_id"],
      properties: {
        artifact_version_id: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sheet", "row", "column", "value"],
            properties: {
              sheet: { type: "string" },
              row: { type: "integer" },
              column: { type: "string" },
              value: {},
            },
          },
        },
        replace: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["find", "with"],
            properties: {
              find: { type: "string" },
              with: { type: "string" },
              sheet: { type: "string" },
            },
          },
        },
        append_rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sheet", "rows"],
            properties: {
              sheet: { type: "string" },
              rows: { type: "array", items: { type: "array", items: {} } },
            },
          },
        },
        delete_rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sheet", "rows"],
            properties: {
              sheet: { type: "string" },
              rows: { type: "array", items: { type: "integer" } },
            },
          },
        },
      },
    },
    invoke: (p, ctx) => xlsxEditCells(ctx, p),
  },
];

/** 内部文书引用了“事实 N”时文末要加的那一节（助手已写了同名节的不加）；对外文书与没有引用的返回 null。 */
function factSectionFor(ctx: InvokeCtx, p: { title?: unknown; sections?: unknown }): { section: ReturnType<typeof factSection> | null; note: string } | null {
  try {
    const sections = Array.isArray(p.sections) ? (p.sections as { heading?: unknown; paragraphs?: unknown; table?: { columns?: unknown[]; rows?: unknown[][] } }[]) : [];
    const text = sections
      .map((s) => [String(s?.heading ?? ""), ...(Array.isArray(s?.paragraphs) ? s.paragraphs.map(String) : []), ...(Array.isArray(s?.table?.rows) ? s.table!.rows!.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")).join("｜") : "")) : [])].join("\n"))
      .join("\n");
    const nos = factRefNos(text);
    if (nos.length === 0 || !isInternalDocument(String(p.title ?? ""))) return null;
    if (sections.some((s) => String(s?.heading ?? "").trim() === FACT_SHEET_NAME)) return { section: null, note: `文书里已有你写的“${FACT_SHEET_NAME}”一节，系统没有另加；请核对它列全了正文引用的 ${nos.length} 个事实序号` };
    const t = factTableRows({ db: ctx.db, tokens: ctx.tokens }, ctx.claims.mid!, nos);
    // 引用的序号在事实清单里一个都对不上：不附空的对照，只告诉助手改正引用
    if (t.rows.length === 0) return { section: null, note: unknownFactNote(t.unknown) };
    return { section: factSection(t.rows, t.omitted), note: `正文引用了 ${nos.length} 个事实序号，系统已在文末自动加了一节“${FACT_SHEET_NAME}”（序号、事实陈述、发生日期、来源材料、是否已确认），读者离开产品也能对上——不要再手工写一节；之后用 docx.edit_draft 改文书时这一节会随引用自动更新${t.unknown.length > 0 ? `。${unknownFactNote(t.unknown)}` : ""}` };
  } catch {
    return null;
  }
}

/**
 * 文书的交付前检查（第 35 批）：法条按事项的分析截止日（缺省今天）离线核验；检查本身出错不影响文书生成（返回 null）。
 */
function deliverableQualityFor(ctx: InvokeCtx, p: { title?: unknown; sections?: unknown }, storageUri: string): DeliverableCheck | null {
  try {
    const kd = ctx.claims.mid ? ctx.db.get<{ key_dates: string | null }>(`SELECT key_dates FROM matters WHERE matter_id = ?`, [ctx.claims.mid])?.key_dates : null;
    let asOf = localToday();
    try {
      const v = kd ? JSON.parse(kd)?.analysis_as_of : null;
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) asOf = v;
    } catch {}
    const sections = Array.isArray(p.sections) ? (p.sections as any[]) : [];
    // V32：律师作为材料导入了官方文本的规范，库外也照常写条号（交付前检查不报“库外不写条号”）
    const materialTitles = ctx.claims.mid ? ctx.db.all<{ filename: string }>(`SELECT filename FROM document_versions WHERE matter_id = ? AND quarantined_at IS NULL`, [ctx.claims.mid]).map((r) => r.filename) : [];
    return checkDeliverable(String(p.title ?? ""), sections, { lawdb: ctx.lawdb, asOf, docx: ctx.blobs.read(storageUri), materialTitles });
  } catch {
    return null;
  }
}

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** 法律工具清单（MCP 服务名 legal；引擎看到的名字为 mcp__legal__<name>）。 */
export const LEGAL_MCP_SERVER = "legal";

let lockState: { lock: ToolLock | null; registry: ManifestRegistry; problems: Map<string, string>; error: string | null } | null = null;

/**
 * 设定（或重设）验签后的工具清单锁文件（内核启动时以配置路径与内容签名公钥调用）。
 * 锁文件不可用时清单为空：任何法律工具都不暴露、不可调用（失败关闭）。
 */
export function setLegalToolLock(file: string | null, signerPub: string): void {
  let lock: ToolLock | null = null;
  let error: string | null = null;
  try {
    if (!file) throw new Error("未配置工具清单锁文件");
    lock = loadSignedToolLock(file, signerPub);
  } catch (e) {
    error = (e as Error).message;
    slog.event("TOOLS_LOCK_UNAVAILABLE", errFields(e));
  }
  const problems = verifyToolsAgainstLock(lock, TOOLS);
  for (const [name] of problems) if (lock) slog.event("TOOLS_TOOL_HIDDEN", { tool: /^[a-z][a-z0-9_.-]{0,47}$/.test(name) ? name : "unnamed" });
  lockState = { lock, registry: lock ? registryFromLock(lock) : new ManifestRegistry([]), problems, error };
}

/** 开发与测试默认：仓库内签名产物 + 开发内容签名公钥（生产由内核以配置路径显式设定）。 */
function defaultLockState(): NonNullable<typeof lockState> {
  if (!lockState) {
    let here: string | null = null;
    try {
      here = dirname(fileURLToPath(import.meta.url));
    } catch {
      here = typeof __dirname !== "undefined" ? __dirname : null;
    }
    const candidates = [
      process.env.ZR_TOOL_MANIFEST_FILE,
      here ? join(here, "..", "..", "..", "..", "content", "tool-manifest", "dist", "tool-manifest.lock.json") : undefined,
      here ? join(here, "tool-manifest", "tool-manifest.lock.json") : undefined,
    ].filter((p): p is string => !!p);
    const file = candidates.find((p) => existsSync(p)) ?? null;
    let pub = process.env.ZR_LAWDB_SIGNER_PUB ?? "";
    if (!pub && here) {
      const pubFile = [join(here, "..", "..", "..", "..", "content", "keys", "content-signing-dev.pub.json"), join(here, "lawdb", "content-signing.pub.json")].find((p) => existsSync(p));
      if (pubFile) pub = (JSON.parse(readFileSync(pubFile, "utf8")) as { publicKeyPem?: string }).publicKeyPem ?? "";
    }
    setLegalToolLock(file, pub);
  }
  return lockState!;
}

/** 工具清单注册表（来自验签后的锁文件；与实现不一致的工具已剔除）。 */
export function legalToolManifests(): ManifestRegistry {
  const st = defaultLockState();
  return new ManifestRegistry(st.registry.list().filter((m) => !st.problems.has(m.name)));
}

/** 不得暴露的工具（实现与锁文件不一致、锁文件未登记、锁文件不可用）。 */
export function legalToolLockProblems(): ReadonlyMap<string, string> {
  return defaultLockState().problems;
}

export function manifestFor(name: string): ToolManifest | undefined {
  return legalToolManifests().list().find((m) => m.name === name);
}

/** 进程内直接调用（确定性工作流）；MCP 端点见 ../local-server.ts。 */
export async function invokeTool(name: string, params: unknown, ctx: InvokeCtx): Promise<unknown> {
  const tool = findTool(name);
  if (!tool) throw new DomainError("not_found", `工具 ${name} 不存在`, 404);
  validateParams(tool.inputSchema, params ?? {});
  const out = await tool.invoke(params, ctx);
  rememberCalcResult(name, ctx, out);
  return out;
}

/**
 * 确定性计算工具的结果（第 58 批，复核 C4）：整单金额勾稽只认最新计算表与材料里的数，诉讼费、单段利息、劳动补偿这几个工具不出表，
 * 文书里引用它们算出的数被当成“找不到出处”（V31 案情分析一单 6 个正确金额被标必须改）。工具结果按任务记在本进程内存里，
 * 勾稽时并入出处；只记数字结构，进程重启后丢失（只影响误报，不影响漏报）。
 */
const CALC_RESULT_TOOLS = new Set(["calc.court_fee", "calc.interest", "calc.labor", "calc.ledger"]);
const CALC_RESULTS = new Map<string, string[]>();
function rememberCalcResult(name: string, ctx: InvokeCtx, out: unknown): void {
  const rid = typeof ctx.claims?.rid === "string" ? ctx.claims.rid : null;
  if (!rid || !CALC_RESULT_TOOLS.has(name)) return;
  try {
    const list = CALC_RESULTS.get(rid) ?? [];
    if (list.length < 60) list.push(JSON.stringify(out).slice(0, 40_000));
    CALC_RESULTS.set(rid, list);
    if (CALC_RESULTS.size > 200) CALC_RESULTS.delete(CALC_RESULTS.keys().next().value!);
  } catch {
    // 结果序列化失败不影响工具本身
  }
}
/** 本任务调用确定性计算工具得到的结果（JSON 文字，供金额勾稽当出处）。 */
export function calcResultTexts(runIds: readonly string[]): string[] {
  return runIds.flatMap((r) => CALC_RESULTS.get(r) ?? []);
}

/** 简易 JSON Schema 校验（v0：type/required/properties/additionalProperties/enum/const/minimum/pattern）。 */
export function validateParams(schema: Record<string, any>, params: any, path = "params"): void {
  if (schema.type === "object") {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new DomainError("validation", `${path} 须为对象`, 422);
    }
    for (const req of schema.required ?? []) {
      if (!(req in params)) throw new DomainError("validation", `${path}.${req} 缺失`, 422);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(params)) {
        if (!allowed.has(k)) throw new DomainError("validation", `${path}.${k} 不在 schema 允许范围`, 422);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in params) validateParams(sub as Record<string, any>, params[k], `${path}.${k}`);
    }
    return;
  }
  if (schema.oneOf) {
    const errors: string[] = [];
    for (const sub of schema.oneOf) {
      try {
        validateParams(sub, params, path);
        return;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    throw new DomainError("validation", `${path} 不匹配任一允许形态: ${errors.join("; ")}`, 422);
  }
  if (schema.const !== undefined && params !== schema.const) {
    throw new DomainError("validation", `${path} 须为常量 ${JSON.stringify(schema.const)}`, 422);
  }
  if (schema.enum && !schema.enum.includes(params)) {
    throw new DomainError("validation", `${path} 须为 ${schema.enum.join("/")}`, 422);
  }
  switch (schema.type) {
    case "string":
      if (typeof params !== "string") throw new DomainError("validation", `${path} 须为字符串`, 422);
      if (schema.pattern && !new RegExp(schema.pattern).test(params)) throw new DomainError("validation", `${path} 格式不符`, 422);
      break;
    case "integer":
      if (!Number.isInteger(params)) throw new DomainError("validation", `${path} 须为整数`, 422);
      if (schema.minimum !== undefined && params < schema.minimum) throw new DomainError("validation", `${path} 小于下限`, 422);
      break;
    case "number":
      if (typeof params !== "number" || !Number.isFinite(params)) throw new DomainError("validation", `${path} 须为数字`, 422);
      if (schema.minimum !== undefined && params < schema.minimum) throw new DomainError("validation", `${path} 小于下限`, 422);
      break;
    case "array":
      if (!Array.isArray(params)) throw new DomainError("validation", `${path} 须为数组`, 422);
      if (schema.items) for (let i = 0; i < params.length; i++) validateParams(schema.items, params[i], `${path}[${i}]`);
      break;
    default:
      break;
  }
}

/**
 * 工具注册表：内核内模块（方案 v5.0 §15：tool-gateway 从独立服务改为内核内模块；
 * MCP 端点保留供 Agent 使用；确定性工作流进程内直接调用）。
 * “平台对工具 schema 校验严格”（§4.1）——inputSchema 一律 additionalProperties:false。
 * 外发、签发、删除类工具根本不在注册表内（§6.2）。
 */
import { calcLabor } from "./tools/labor.ts";
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
import { calcDeadline } from "./tools/deadline.ts";
import { redactScan } from "./tools/redact.ts";
import { materialsReadExcerpt } from "./tools/materials.ts";
import { docxApplyRevisions, docxCompare, docxRenderReport, docxSanitize, redactApply } from "./tools/docx.ts";
import { docxRevise } from "./tools/revise.ts";
import { factsList, factsSubmit, materialsList, outlineGet, outlineSubmit, registerToolArtifact, rulesPropose, riskcardsList, riskcardsSubmit, tableFill, tableGet, xlsxRenderTable } from "./tools/review.ts";
import { assertOutlineSettled } from "../services/argument-outlines.ts";
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
}

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

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
    description: "在 Source Registry 种子内按名称检索法源版本。",
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
    invoke: (p, ctx) => citationsVerify(ctx.lawdb, p),
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
      "月工资写解除前十二个月平均工资；当地上年度职工月平均工资、最低工资由律师或材料给出，不要凭记忆填；没给时结果带 warnings。2008 年以前的工作年限按当时规定另算，不在结果里。是否应当支付由律师判断，本工具只算数额；warnings 非空时须原样告知律师。",
    sideEffect: "read",
    resource: "pure",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["start_date", "end_date", "kind", "avg_monthly_wage_yuan"],
      properties: {
        start_date: dateSchema,
        end_date: dateSchema,
        kind: { type: "string", enum: ["compensation", "unlawful"] },
        avg_monthly_wage_yuan: { type: "number", minimum: 0 },
        local_avg_monthly_wage_yuan: { type: "number", minimum: 0 },
        local_min_wage_yuan: { type: "number", minimum: 0 },
        notice_in_lieu: { type: "boolean" },
        last_month_wage_yuan: { type: "number", minimum: 0 },
      },
    },
    invoke: (p) => calcLabor(p),
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
    description: "按解析版本与字符区间/锚点读取材料文本；令牌须绑定对应事项。",
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
    invoke: async (p, ctx) => materialsReadExcerpt(ctx.db, ctx.claims.mid, p),
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
    invoke: async (p, ctx) => docxApplyRevisions(ctx.db, ctx.blobs, ctx.claims.mid, p),
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
    invoke: async (p, ctx) => docxCompare(ctx.db, ctx.blobs, ctx.claims.mid, p),
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
    invoke: async (p, ctx) => docxSanitize(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "docx.render_report",
    title: "生成文书（DOCX）",
    description:
      "按标题与段落结构生成 Word 文书（备忘录、意见书、函件、合同、诉状），登记为本任务的草稿成果交律师审阅；导出时按事项令牌表还原代号。" +
      "文书正文里要成表的内容（合同价款表、设备清单、付款节点、证据目录、当事人或股权结构表）用该节的 table 画成 Word 表格：columns 为表头，rows 每行格数与表头相同，画在本节段落之后；表后还有正文的，另起一节、heading 写空字符串。每节至多一张表、每表 1–10 列、最多 300 行；格内写文字（金额按文书写法，如“1,200,000.00”）。" +
      "格数不符或超限时整份不生成并逐条说明，改正后重交。分析用的大表（争点矩阵、尽调清单等）仍用 xlsx.render_table 作附件。" +
      "本任务有待律师确认的论点提纲（outline.submit）时拒绝生成，先等律师确认。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "4",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sections"],
      properties: {
        title: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "paragraphs"],
            properties: {
              heading: { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
              // 第 32 批：节内表格（v4）；格子接受文字或数字，内核再逐行核对格数
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
      const r = docxRenderReport(ctx.blobs, p, ctx.claims.mid);
      // 任务内调用（Agent 经本机端点）：登记为草稿成果，律师在执行态与交付件页可见
      if (!ctx.claims.rid) return r;
      const title = String(p.title ?? "文书").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "").trim().slice(0, 60) || "文书";
      return { ...r, ...registerToolArtifact(ctx, { kind: "agent_report", filename: `${title}.docx`, sha256: r.sha256, storage_uri: r.storage_uri, manifest: { tool: "docx.render_report", sections: Array.isArray(p.sections) ? p.sections.length : 0, tables: Array.isArray(p.sections) ? p.sections.filter((s: any) => s?.table).length : 0 } }) };
    },
  },
  {
    name: "docx.revise",
    title: "在原件上修订（修订稿 + 清洁稿）",
    description:
      "按律师意见修改已上传的 Word 原件：每处给出要改的原文（anchor，逐字照抄材料原文、同一段落之内）与新文字（proposed_text，空串为删除；insert_after=true 为在该段之后插入新段落），在原件副本上生成带修订痕迹的修订稿（保留原版式、编号、表格）与接受全部修订后的清洁稿，登记为本任务草稿成果；原件不变。dry_run=true 只试写：返回每个改到的段落改前与改后的整段文字，不生成文件，先读一遍再正式提交。任一处找不到或有歧义时整体不写，逐条返回原因，改正后重新提交。",
    sideEffect: "write_draft",
    resource: "matter_documents",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["document_version_id", "patches"],
      properties: {
        document_version_id: { type: "string" },
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
              occurrence: { type: "integer", minimum: 0 },
              paragraph_hint: { type: "string" },
              comment: { type: "string" },
              insert_after: { type: "boolean" },
            },
          },
        },
      },
    },
    invoke: async (p, ctx) => docxRevise(ctx, p),
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
    invoke: async (p, ctx) => redactApply(ctx.db, ctx.blobs, ctx.claims.mid, p),
  },
  {
    name: "materials.list",
    title: "材料目录",
    description: "列出本事项的材料：本任务提供的快照序号、解析版本、字数、页数与识别质量（partial/unreadable 表示有页未能识别，须在结论中说明未读取范围）。",
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
      "文书类任务（起诉状、答辩状、代理词、上诉状、法律研究备忘录等）在起草之前调用：逐条列出拟写的论点，每条附依据（法名 + 条号 + note 写这条怎么支持该论点）与所用事实（优先引用 facts.list 里的 fact_id）。" +
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
            properties: { topic: { type: "string" }, standard: { type: "string" }, fallback: { type: "string" }, red_line: { type: "string" } },
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
    description: "按列生成 Excel 表格（证据目录、时间线、问题清单、计算明细等），登记为本任务的草稿成果交律师审阅；每个表 1–40 列、最多 5,000 行；单元格为文字或数字。",
    sideEffect: "write_draft",
    resource: "matter_work",
    version: "1",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "sheets"],
      properties: {
        title: { type: "string" },
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
];

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
  return tool.invoke(params, ctx);
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

/**
 * 场景开始面板（UIUX P0-2 ScenarioStartSheet；历史 Demo 融合方案 §4.3 四步表单 → 两段式；第 55 批改为三段）：
 *  1. “案情与材料”：拖放或选择文件（任何任务都有上传入口）、勾选材料；可以直接写案情的卡多一栏案情——没有材料时必须写，
 *     写下的内容存成本事项的一份材料，助手按“律师陈述、待确认”对待；
 *  2. “这次要定的事”：本方法开工前就该定的（逐项请求、期限起算日、立场与取舍），不常用的收进“更多选项”；最后是补充要求；
 *  3. “你得到什么”：交付件 + 预计用量与内容去向。
 * 原来第一段只有材料勾选 + ≤ 3 个字段：起草起诉状只收“拟受理法院”，没有材料的事项连“添加文件”都不显示，
 * 助手要把空事项读一遍再回头问（第 55 批真实基线：2 分 10 秒后拿合同违约的条文去套著作权侵权案）。
 * “这个方法会怎么做”默认折叠。主按钮写动词（开始审查 / 开始整理…），按下即发起；依据未齐等需要处理的情况转到发起确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, MATERIAL_ACCEPT, pickMaterials, type Matter, type MaterialFile, type RuleSet, type RunPolicyView } from "../api.ts";
import { matterFactHints, RULES_SKILLS, type HintField } from "../lib/matter-hints.ts";
import { eventDateProblem, STAGE_LABELS, stagesFor } from "../lib/matter-stage.ts";
import { notifyDataChanged } from "../lib/events.ts";
import { nav } from "../App.tsx";
import type { ScenarioCard } from "../lib/scenarios.ts";
import type { ScenarioField } from "../lib/scenarios.ts";
import { briefFilename, briefGoalLine, buildGoal, canStartPartial, caseGap, materialScopeText, preselectDocs, docArgsFor, fieldRedirect, getsPlain, guessContractType, LINE_LABELS, lineMismatchText, missingMaterialsText, primaryOutputOf, sideOptionFor, skillArgsOf, splitIssues, startPanelBrief, startPanelInitial, wordDocGap } from "../lib/scenarios.ts";
import { localDay } from "../lib/recovery-reminder.ts";
import { PARTIES_PREFIX, partiesShort, withPartiesDoc } from "../lib/parties.ts";
import { PartiesDialog, usePartiesInfo } from "./PartiesInfo.tsx";
import { Icon } from "./Icons.tsx";
import { Modal } from "./Modal.tsx";
import { scenarioChoice } from "./ModeSelector.tsx";
import { launchRun, prepareStart, RunSheet, type PendingStart } from "./RunSheet.tsx";
import { StartHintBanner } from "./StartHint.tsx";
import { BusyLabel, ListSkeleton } from "./Loading.tsx";
import { startHintOf, type StartHint } from "../lib/start-block.ts";
import { SendSummary } from "./SendSummary.tsx";
import { SendPoints } from "./SendPoints.tsx";
import { stanceLabel } from "../lib/labels.ts";
import { RolePills, Select, type MaterialRole } from "./Select.tsx";
import "../styles-start.css";

interface Props {
  card: ScenarioCard;
  /** 面板里选中的事项；null = 还没有合适的事项（默认“新建事项”，Z3 评审 #1）。 */
  matter: Matter | null;
  /** 可切换的事项（与输入框的事项菜单同一份）。 */
  matters: Matter[];
  onMatterChange: (id: string) => void;
  onNewMatter: () => void;
  /** documents 属于哪个事项（切换事项后，新事项的材料到达前不重置勾选）。 */
  documentsFor: string | null;
  documents: { document_version_id: string; filename: string; role?: MaterialRole | null; supersedes?: string | null; quarantined_at?: string | null; created_at?: string }[];
  /** 材料变了（面板里填了当事人信息，D-224）：请上层重读本事项材料。 */
  onDocsChanged?: () => void;
  policy: RunPolicyView | null;
  /** 从输入框带来的任务描述（作为补充要求）。 */
  initialExtra?: string;
  onImport: (files: FileList | MaterialFile[]) => Promise<void> | void;
  onClose: () => void;
}


export function ScenarioStart({ card, matter, matters, onMatterChange, onNewMatter, documentsFor, documents: allDocs, policy, initialExtra, onImport, onClose, onDocsChanged }: Props) {
  // 只用属于当前所选事项的材料（切换事项后旧事项的材料不显示、不勾选）
  const docsReady = !!matter && documentsFor === matter.matter_id;
  // 当事人信息的旧版本不列出（D-224：事项里只有一份当前有效；案卷文件夹里同一位置的旧版本照旧列出，回稿对比要用）
  const documents = useMemo(() => {
    if (!docsReady) return [];
    const old = new Set(allDocs.map((d) => d.supersedes).filter((x): x is string => !!x));
    return allDocs.filter((d) => !(old.has(d.document_version_id) && d.filename.startsWith(PARTIES_PREFIX)));
  }, [docsReady, allDocs]);
  const [matterMenu, setMatterMenu] = useState(false);
  // 律师在输入框写的是问题时预填进“问题”栏（第 35 批）
  const [values, setValues] = useState<Record<string, string | string[]>>(() => startPanelInitial(card, initialExtra).values);
  const [extra, setExtra] = useState(() => startPanelInitial(card, initialExtra).extra);
  // 案情（第 55 批）：律师在输入框里写的长段话预填进来；开始时存成本事项的一份材料
  const [brief, setBrief] = useState(() => startPanelBrief(card, initialExtra));
  const day = useMemo(() => localDay(), []);
  /** 已经存过的案情（同一段文字不重复存：点了“下一步：确认”又返回时）。 */
  const savedBrief = useRef<{ matter: string; text: string; id: string } | null>(null);
  // 当事人信息（D-224）：要写身份首部的卡显示本事项已填 / 未填；发起时自动计入可读材料
  const parties = usePartiesInfo(card.needsParties && docsReady ? documents : null);
  const [partiesOpen, setPartiesOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const [docIds, setDocIds] = useState<string[]>(() => preselectDocs(card, documents));
  /** 本面板里刚改过的用途（未刷新事项材料前先按这里显示；保存失败即撤回）。 */
  const [roles, setRoles] = useState<Record<string, MaterialRole | null>>({});
  const [how, setHow] = useState(false);
  const [estimate, setEstimate] = useState<PendingStart | null>(null);
  /** 这份估价是按哪一组输入算的（事项、任务说明与材料、方法参数）。 */
  const estimateFor = useRef<readonly unknown[] | null>(null);
  const [estErr, setEstErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [errHint, setErrHint] = useState<StartHint | null>(null);
  const [confirm, setConfirm] = useState<PendingStart | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const known = useRef(new Set(documents.map((d) => d.document_version_id)));
  const knownFor = useRef<string | null>(docsReady ? documentsFor : null);

  // 新导入的材料自动勾选；换了事项则按新事项的材料重新预选（Z3 评审 #1：切换事项后刷新材料列表）
  useEffect(() => {
    if (!docsReady) return;
    if (knownFor.current !== documentsFor) {
      knownFor.current = documentsFor;
      known.current = new Set(documents.map((d) => d.document_version_id));
      setDocIds(preselectDocs(card, documents));
      return;
    }
    const fresh = documents.filter((d) => !known.current.has(d.document_version_id)).map((d) => d.document_version_id);
    for (const d of documents) known.current.add(d.document_version_id);
    if (fresh.length > 0) setDocIds((ids) => [...ids, ...fresh.filter((x) => !ids.includes(x))]);
  }, [documents, docsReady, documentsFor, card]);

  // 材料不齐也可先开始（UIUX 增量评审 S-4 / 历史 Demo D-5）：只限卡片声明允许的 Agent 场景（Z3 评审 #4：审合同没有合同不能先开始）；确定性流程仍须选够材料
  const [partial, setPartial] = useState(false);
  const goal = useMemo(() => {
    if (card.scenario !== "a1.agent_task") return extra.trim();
    const g = [buildGoal(card, values, extra), briefGoalLine(card, brief, day)].filter(Boolean).join("\n");
    // 只在材料确实还不齐时追加（复核 S6B-04：补齐材料后不能再让模型按“不齐”处理）
    return partial && card.minMaterials > docIds.length && g ? `${g}\n（材料还不齐：先按已有材料做，缺少的材料列为“待补充”，无法核实的内容标注“待补充”，不要推测。）` : g;
  }, [card, values, extra, partial, docIds.length, brief, day]);
  const missing = card.fields.filter((f) => f.required && !(Array.isArray(values[f.key]) ? (values[f.key] as string[]).length : String(values[f.key] ?? "").trim()));
  const needDocs = Math.max(0, card.minMaterials - docIds.length);
  const canPartial = canStartPartial(card) && needDocs > 0;
  // 示例事项不能存审查要点（复核 Q5-03）：从范本整理的任务在示例上不开始，免得跑完才在最后一步失败
  const sampleBlocked = !!matter?.is_sample && card.skill === "review-rules-draft";
  // 修改文书只认 Word 原件（V16 A4）：没有勾上 .docx 时不能开始，并写明原因
  const wordGap = docsReady ? wordDocGap(card, documents, docIds) : null;
  // 本事项已有的事实（第 55 批：原来只为“争点与证据分析”查确认数；现在 AI 任务都查——开工前就告诉律师助手手里有什么，
  // 也据此判断“没有材料、没有事实、也没写案情”这种只能靠猜的情形）。读不到不拦。
  const [factCounts, setFactCounts] = useState<{ confirmed: number; proposed: number } | null>(null);
  useEffect(() => {
    setFactCounts(null);
    if (card.scenario !== "a1.agent_task" || !matter) return;
    let live = true;
    void api
      .facts(matter.matter_id)
      .then((r) => live && setFactCounts({ confirmed: r.facts.filter((f) => f.status === "confirmed").length, proposed: r.facts.filter((f) => f.status === "proposed").length }))
      .catch(() => live && setFactCounts(null));
    return () => {
      live = false;
    };
  }, [card.scenario, matter?.matter_id]);
  // “争点与证据分析”只用确认过的事实（复核 R15B-01）：事项里还没有确认过的，开始前就说清楚
  const confirmedFacts = card.skill === "issue-evidence-matrix" && factCounts ? factCounts.confirmed : null;
  // 没有材料、没有事实、也没写案情：不开始（助手只能凭事项名称猜案由）
  const noCase = docsReady && caseGap(card, { matterDocs: documents.length, facts: factCounts ? factCounts.confirmed + factCounts.proposed : null, brief });
  const ready = !!matter && !sampleBlocked && docsReady && !wordGap && !noCase && missing.length === 0 && (needDocs === 0 || (canPartial && partial)) && (card.scenario !== "a1.agent_task" || goal.length > 0);
  // 整理案卷（确定性流程）的“已知争点”直接交给争点矩阵框架（B-5）
  const issues = useMemo(() => (card.scenario === "s2.case_file" ? splitIssues(String(values.issues ?? "")) : []), [card.scenario, values]);
  // V18 第 43 批：场景卡缺省直接开始（步骤与字段已在本面板给律师看过）；想先看计划的勾一下，仍走计划确认
  const [planFirst, setPlanFirst] = useState(false);
  const value = useMemo(() => ({ goal, scenario: card.scenario, documentIds: docIds, choice: { ...scenarioChoice(policy), planFirst }, ...(issues.length > 0 ? { issues } : {}) }), [goal, card.scenario, docIds, policy, issues, planFirst]);
  // 本事项审查要点（v9.4 第 22 批，C1 #21）：审合同、回稿重审、起草合同缺省按在用的那一版；律师可本次不用
  const [rules, setRules] = useState<RuleSet | null>(null);
  const [useRules, setUseRules] = useState(true);
  useEffect(() => {
    setRules(null);
    // 换了事项回到缺省“按要点审”（复核 Q4 建议 2）
    setUseRules(true);
    if (!matter || !card.skill || !RULES_SKILLS.includes(card.skill)) return;
    let live = true;
    void api
      .reviewRules(matter.matter_id)
      .then((r) => live && setRules(r.active))
      .catch(() => live && setRules(null));
    return () => {
      live = false;
    };
  }, [matter?.matter_id, card.skill]);
  // 我的写作偏好（C1 #29）：设了的话 AI 任务都按它写，这里说一句
  const [hasPrefs, setHasPrefs] = useState(false);
  useEffect(() => {
    if (card.scenario !== "a1.agent_task") return;
    void api
      .writingPrefs()
      .then((p) => setHasPrefs(!!(p.signature || p.citation || p.notes)))
      .catch(() => setHasPrefs(false));
  }, [card.scenario]);
  // 补全提示（C1 #24）：这个方法用得到、事项还没填的事件时点 / 地域 / 阶段；不拦着开始
  const [filled, setFilled] = useState<Partial<Record<HintField, string>>>({});
  const hints = matterFactHints(card.skill, matter ? { ...matter, ...filled } : null);
  // 勾选材料的文件名按勾选顺序（回稿重审的上一稿 / 回稿、文稿体检的那一份，第 31 批）；用字符串作依赖，材料未载入时的空数组每次都是新对象
  const pickedNames = docIds.map((id) => documents.find((d) => d.document_version_id === id)?.filename ?? "").filter(Boolean).join("\n");
  const opts = useMemo(() => ({ ...(card.skill ? { skill: card.skill } : {}), label: card.title, ...(card.skill ? { skillArgs: { ...skillArgsOf(card, values), ...docArgsFor(card, pickedNames ? pickedNames.split("\n") : []) } } : {}), ...(rules && !useRules ? { reviewRules: false } : {}), ...primaryOpt(primaryOutputOf(card, values)) }), [card, values, rules, useRules, pickedNames]);

  // 疑似姓名核对之后重新估价
  const [reestimateTick, setReestimateTick] = useState(0);
  // 预计花费与内容去向：材料或说明变化后重新估价（去抖）
  useEffect(() => {
    if (!ready || !matter) {
      setEstimate(null);
      return;
    }
    const t = setTimeout(() => {
      prepareStart(matter, value, opts)
        .then((p) => {
          estimateFor.current = [matter, value, opts];
          setEstimate(p);
          setEstErr("");
        })
        .catch((e) => {
          setEstimate(null);
          setEstErr((e as Error).message);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [ready, matter, value, opts, reestimateTick]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setErr("");
    setErrHint(null);
    try {
      if (!matter) return;
      // 估价是去抖后才算的：刚改完选项就点开始，手里的估价还是改之前那组输入（第 29 批真实走查：刚选的“我方地位”没进任务说明）——不是按当前输入算的就重算
      const f = estimateFor.current;
      // 案情存成本事项的一份材料（第 55 批）：同一段文字只存一次。勾了别的材料时把它一并勾上；一份都没勾 = 助手可读全部材料，它已在其中，不必单独勾
      // （单独勾上反而把范围缩成只有这一份）。
      let v = value;
      const text = card.brief ? brief.trim() : "";
      if (text) {
        let id = savedBrief.current && savedBrief.current.matter === matter.matter_id && savedBrief.current.text === text ? savedBrief.current.id : null;
        if (!id) {
          const r = await api.importMaterialText(matter.matter_id, briefFilename(day), text);
          id = r.document_version_id;
          // 材料列表刷新后不把它自动勾上（“新导入的自动勾选”只针对律师自己添加的文件）
          known.current.add(id);
          savedBrief.current = { matter: matter.matter_id, text, id };
          void api.setMaterialRole(id, "ours").catch(() => {});
        }
        if (docIds.length > 0 && !docIds.includes(id)) v = { ...value, documentIds: [...docIds, id] };
      }
      // 当事人信息（D-224）：与案情说明同一口径——勾了别的材料时一并勾上；一份都没勾时它已在全部材料里
      const withParties = withPartiesDoc(v.documentIds, parties.doc?.document_version_id ?? null, !!card.needsParties);
      if (withParties.length !== v.documentIds.length) v = { ...v, documentIds: withParties };
      const fresh = v === value && estimate && f && f[0] === matter && f[1] === value && f[2] === opts ? estimate : null;
      const p = fresh ?? (await prepareStart(matter, v, opts));
      // 依据未齐、去向有提醒：转到发起确认（在那里原地记录客户同意）
      if (p.estimate.data_where?.start_blocked || p.estimate.data_where?.warning) {
        setConfirm(p);
        return;
      }
      await launchRun(p);
      onClose();
    } catch (e) {
      // 第 46 批：发起时按登录、额度拦下的，显示成可操作的提示
      const h = startHintOf(e);
      setErrHint(h);
      setErr(h ? "" : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setField = (k: string, v: string | string[]) => {
    setGuessed(null);
    setValues((cur) => ({ ...cur, [k]: v }));
  };
  // 合同类型按文件名预选（第 26 批）：律师没选过时，按所选合同的文件名与事项名猜；猜到了在下拉框下写“按文件名预选，可改”
  const [guessed, setGuessed] = useState<string | null>(null);
  const typeField = card.fields.find((f) => f.key === "type" && f.kind === "select" && f.options?.includes("其他（通用辅助）"));
  useEffect(() => {
    if (!typeField || !docsReady || values[typeField.key]) return;
    const names = documents.filter((d) => docIds.includes(d.document_version_id)).map((d) => d.filename);
    const g = guessContractType(names, matter?.title ?? "", extra);
    if (g && typeField.options!.includes(g)) {
      setValues((cur) => (cur[typeField.key] ? cur : { ...cur, [typeField.key]: g }));
      setGuessed(g);
    }
  }, [typeField, docsReady, documents, docIds, matter?.title, values, extra]);
  // 面板里换了事项：上一个事项按文件名猜的合同类型作废，按新事项的材料重猜（V10 走查：换到增资事项后仍是“技术开发”）；律师亲手选的不动
  const guessedFor = useRef<string | null>(matter?.matter_id ?? null);
  useEffect(() => {
    const id = matter?.matter_id ?? null;
    if (guessedFor.current === id) return;
    guessedFor.current = id;
    if (typeField && guessed && values[typeField.key] === guessed) {
      setValues((cur) => {
        const { [typeField.key]: _drop, ...rest } = cur;
        return rest;
      });
      setGuessed(null);
    }
  }, [matter?.matter_id, typeField, guessed, values]);
  // “我方是”按事项立场预选（第 31 批）：律师没选过、事项立场对得上某个选项时才填，下拉框下写“按事项立场预选，可改”
  const sideField = card.fields.find((f) => f.key === "side" && f.kind === "select");
  const [sideGuessed, setSideGuessed] = useState<string | null>(null);
  useEffect(() => {
    if (!sideField || values[sideField.key]) return;
    const g = sideOptionFor(sideField.options, matter?.stance);
    if (g) {
      setValues((cur) => (cur[sideField.key] ? cur : { ...cur, [sideField.key]: g }));
      setSideGuessed(g);
    }
  }, [sideField, matter?.stance, values]);
  const order = (id: string) => docIds.indexOf(id) + 1;
  // 面板里添加文件：显示“正在添加…”，完成后由“新导入的自动勾选”勾上
  const addFiles = async (files: FileList | MaterialFile[]) => {
    setAdding(true);
    try {
      await onImport(files);
    } finally {
      setAdding(false);
    }
  };
  // 字段分两组（第 55 批）：每次都要定的直接显示；不常用的收进“更多选项”，填过的自动展开
  const mainFields = card.fields.filter((f) => !f.more);
  const moreFields = card.fields.filter((f) => f.more);
  const fieldFilled = (f: ScenarioField) => (Array.isArray(values[f.key]) ? (values[f.key] as string[]).some((x) => x.trim()) : String(values[f.key] ?? "").trim().length > 0);
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const moreShown = moreOpen ?? moreFields.some(fieldFilled);
  const listRows = (k: string): string[] => {
    const v = values[k];
    return Array.isArray(v) && v.length > 0 ? v : [""];
  };
  const renderField = (f: ScenarioField) => (
    <div key={f.key} className={`ss-field${f.kind === "long" || f.kind === "list" ? " ss-field-long" : ""}`}>
      <span className="ss-label">
        {f.label}
        {f.required ? <span className="ss-req" aria-label="必填">*</span> : null}
      </span>
      <span className="ss-control">
        {f.kind === "select" ? (
          <span className="ss-select">
            <Select aria-label={f.label} value={String(values[f.key] ?? "")} onChange={(v) => setField(f.key, v)} options={f.options!.map((o) => ({ value: o, label: o }))} />
            {guessed && f === typeField && values[f.key] === guessed && <span className="ss-guess muted">按文件名预选，可改</span>}
            {sideGuessed && f === sideField && values[f.key] === sideGuessed && <span className="ss-guess muted">按事项立场预选，可改</span>}
          </span>
        ) : f.kind === "multi" ? (
          <span className="ss-multi">
            {f.options!.map((o) => {
              const cur = (values[f.key] as string[] | undefined) ?? [];
              const on = cur.includes(o);
              return (
                <button key={o} type="button" className={`chip${on ? " active" : ""}`} aria-pressed={on} onClick={() => setField(f.key, on ? cur.filter((x) => x !== o) : [...cur, o])}>
                  {o}
                </button>
              );
            })}
          </span>
        ) : f.kind === "list" ? (
          // 逐项填写（诉讼请求、仲裁请求）：一项一行、自动编号；回车加一项；粘贴多行自动拆开
          <span className="ss-list">
            {listRows(f.key).map((row, i, rows) => (
              <span key={i} className="ss-list-row">
                <span className="ss-list-n" aria-hidden="true">{i + 1}</span>
                <input
                  aria-label={`${f.label}第 ${i + 1} 项`}
                  type="text"
                  value={row}
                  placeholder={i === 0 ? (f.placeholder ?? "") : ""}
                  onChange={(e) => setField(f.key, rows.map((x, j) => (j === i ? e.target.value : x)))}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    if (row.trim()) setField(f.key, [...rows.slice(0, i + 1), "", ...rows.slice(i + 1)]);
                  }}
                  onPaste={(e) => {
                    const lines = e.clipboardData.getData("text").split(/\r?\n/).map((x) => x.replace(/^\s*(\d+[.、)）]|[（(]\d+[)）]|[一二三四五六七八九十]+[、.])\s*/, "").trim()).filter(Boolean);
                    if (lines.length < 2) return;
                    e.preventDefault();
                    setField(f.key, [...rows.slice(0, i), ...(row.trim() ? [row] : []), ...lines, ...rows.slice(i + 1)]);
                  }}
                  autoFocus={i > 0 && i === rows.length - 1 && row === ""}
                />
                {rows.length > 1 && (
                  <button type="button" className="icon-btn ss-list-x" aria-label={`删除第 ${i + 1} 项`} onClick={() => setField(f.key, rows.filter((_, j) => j !== i))}>
                    <Icon.x />
                  </button>
                )}
              </span>
            ))}
            <button type="button" className="btn-link ss-add" onClick={() => setField(f.key, [...listRows(f.key), ""])}>＋ 加一项</button>
          </span>
        ) : f.kind === "long" ? (
          <textarea aria-label={f.label} rows={4} placeholder={f.placeholder ?? ""} value={String(values[f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value)} />
        ) : (
          <input aria-label={f.label} type={f.kind === "date" ? "date" : "text"} placeholder={f.placeholder ?? ""} value={String(values[f.key] ?? "")} onChange={(e) => setField(f.key, e.target.value)} />
        )}
        {f.help && <span className="ss-field-help muted">{f.help}</span>}
      </span>
    </div>
  );

  // 转到发起确认：放在全部 hook 之后（第 29 批真实走查：早退在第 26 批新增的 useState/useEffect 之前，点“下一步：确认”整页报错）
  if (confirm) return <RunSheet pending={confirm} onClose={() => setConfirm(null)} />;

  return (
    <Modal title={card.title} onClose={onClose} wide>
      <div className="ss">
        <div className="ss-matter">
          <span className="ss-label">事项</span>
          <span className="ss-matter-pick">
            <button type="button" className="chip" aria-haspopup="listbox" aria-expanded={matterMenu} onClick={() => setMatterMenu((v) => !v)} title={matter?.title ?? "新建事项"}>
              <Icon.folder /> <span className="ss-matter-name">{matter ? matter.title : "新建事项"}</span> <Icon.down />
            </button>
            {matterMenu && (
              <div className="popover composer-menu ss-matter-menu" role="listbox" aria-label="选择事项">
                {matters.map((m) => (
                  <button
                    key={m.matter_id}
                    role="option"
                    aria-selected={m.matter_id === matter?.matter_id}
                    className={`menu-item${m.matter_id === matter?.matter_id ? " selected" : ""}`}
                    onClick={() => {
                      onMatterChange(m.matter_id);
                      setMatterMenu(false);
                    }}
                  >
                    <span className="menu-label">{m.title}</span>
                    <span className="menu-desc">我方：{stanceLabel(m.stance)}</span>
                  </button>
                ))}
                <button
                  className="menu-item menu-new"
                  onClick={() => {
                    setMatterMenu(false);
                    onNewMatter();
                  }}
                >
                  <span className="menu-label"><Icon.plus /> 新建事项</span>
                </button>
              </div>
            )}
          </span>
          {matter && <span className="muted">我方：{stanceLabel(matter.stance)}</span>}
        </div>
        {matter && lineMismatchText(card, matter) && <div className="muted ss-mismatch">{lineMismatchText(card, matter)}</div>}
        {matter && hints.length > 0 && <FactHints matter={matter} hints={hints} onSaved={(f, v) => setFilled((cur) => ({ ...cur, [f]: v }))} />}
        {!matter && (
          <div className="ss-need">
            还没有{LINE_LABELS[card.line]}事项。先新建一个事项（写明客户和我方立场），再开始{card.title}。{" "}
            <button className="btn-link" onClick={onNewMatter}>新建事项</button>
          </div>
        )}
        <section className="ss-sec">
          <div className="ss-h">{card.brief ? "案情与材料" : "材料"}</div>
          <div className="ss-hint">{card.gives}</div>
          {matter ? (
            <div className="ss-docs" role="group" aria-label="选择材料">
              {!docsReady && <ListSkeleton rows={3} label="正在载入这个事项的材料" />}
              {documents.map((d) => {
                const on = docIds.includes(d.document_version_id);
                return (
                  <div key={d.document_version_id} className="ss-doc-row">
                  <label className={`ss-doc${on ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label={d.filename}
                      checked={on}
                      onChange={() => setDocIds((ids) => (on ? ids.filter((x) => x !== d.document_version_id) : [...ids, d.document_version_id]))}
                    />
                    <span className="ss-doc-name">{d.filename}</span>
                    {card.scenario === "s1b.draft_compare" && on && <span className="tag tag-gray">{order(d.document_version_id) === 1 ? "基线稿" : "对方回稿"}</span>}
                  </label>
                  {/* 勾选材料时顺手标用途（Z3 #15、D-4 余项），与材料表同一份数据 */}
                  <RolePills
                    name={d.filename}
                    value={d.document_version_id in roles ? roles[d.document_version_id] : d.role}
                    onChange={(v) => {
                      setRoles((r) => ({ ...r, [d.document_version_id]: v }));
                      void api.setMaterialRole(d.document_version_id, v).catch(() => setRoles((r) => {
                        const { [d.document_version_id]: _, ...rest } = r;
                        return rest;
                      }));
                    }}
                  />
                  </div>
                );
              })}
              {/* V18 第 43 批：勾选就是边界——助手只读勾选的材料；一份都没勾时才可读本事项全部材料。把这条规则写在勾选框下面 */}
              {card.scenario === "a1.agent_task" && docsReady && documents.length > 0 && <div className="ss-scope muted">{materialScopeText(docIds.length, documents.length)}</div>}
              {/* 第 55 批：上传入口任何时候都在（原来没有材料、又不强制材料的卡连“添加文件”都不显示）；可以拖放 */}
              {docsReady && (
                <div
                  className={`ss-drop${dragOver ? " over" : ""}${documents.length === 0 ? " ss-drop-empty" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
                  }}
                >
                  <span className="ss-drop-icon" aria-hidden="true"><Icon.attach /></span>
                  {adding ? (
                    <span role="status"><BusyLabel busy>正在添加…</BusyLabel></span>
                  ) : (
                    <span>
                      {documents.length === 0 ? "本事项还没有材料。把文件拖到这里，或" : "还有材料？拖到这里，或"}
                      <button type="button" className="btn-link ss-add" onClick={() => void pickMaterials(fileRef.current, addFiles)}>选择文件</button>
                    </span>
                  )}
                </div>
              )}
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept={MATERIAL_ACCEPT}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {wordGap && <div className="ss-need">{wordGap}</div>}
              {!wordGap && needDocs > 0 && !(canPartial && partial) && (
                <div className="ss-need">
                  {missingMaterialsText(card, needDocs)}
                  {canPartial && (
                    <button className="btn-link" onClick={() => setPartial(true)}>
                      先开始，缺的稍后补
                    </button>
                  )}
                </div>
              )}
              {canPartial && partial && (
                <div className="muted">
                  材料还不齐：会先按已有材料做，缺的列为“待补充”，无法核实的内容不会推测。{" "}
                  <button className="btn-link" onClick={() => setPartial(false)}>
                    改回等材料齐了再开始
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {/* 案情（第 55 批）：没有材料时先把情况写在这里；有材料时写材料里没有的情况 */}
          {matter && card.brief && (
            <label className="ss-brief">
              <span className="ss-brief-head">
                <span className="ss-label">
                  {card.brief.label}
                  {noCase ? <span className="ss-req" aria-label="必填">*</span> : null}
                </span>
                <span className="ss-brief-tip muted">{docsReady && documents.length === 0 && (factCounts ? factCounts.confirmed + factCounts.proposed === 0 : true) ? "没有材料时，先把情况写在这里" : "材料里没有的情况写在这里（可选）"}</span>
              </span>
              <textarea aria-label={card.brief.label} rows={documents.length > 0 ? 3 : 5} placeholder={card.brief.placeholder} value={brief} onChange={(e) => setBrief(e.target.value)} />
              <span className="ss-field-help muted">会存成本事项的一份材料《{briefFilename(day).replace(/\.txt$/, "")}》，后面的任务接着用；助手把它当作你的陈述，其中的事实列为待你确认。</span>
            </label>
          )}
          {/* 当事人信息（D-224）：事项里存一次，文书首部按它写；不强制 */}
          {matter && card.needsParties && docsReady && (
            <div className="ss-parties">
              <span className="ss-parties-k">当事人信息</span>
              <span className={parties.doc ? "" : "muted"}>
                {!parties.doc ? "未填，文书首部会留【待填】" : parties.loading ? "载入中…" : parties.parties && partiesShort(parties.parties) ? `已填（${partiesShort(parties.parties)}）` : "已填"}
              </span>
              {(matter.lifecycle ?? "active") === "active" && !matter.is_sample && (
                <button type="button" className="btn-link" disabled={parties.loading} onClick={() => setPartiesOpen(true)}>
                  {parties.doc ? "修改" : "现在填"}
                </button>
              )}
            </div>
          )}
          {partiesOpen && matter && (
            <PartiesDialog
              matter={matter}
              info={parties}
              onClose={() => setPartiesOpen(false)}
              onSaved={({ id, replaced }) => {
                setPartiesOpen(false);
                // 新版本不按“新导入的自动勾选”勾上（一份都没勾时勾上反而把范围缩成只有它）；勾过旧版的换成新版
                known.current.add(id);
                setDocIds((ids) => (replaced && ids.includes(replaced) ? ids.map((x) => (x === replaced ? id : x)) : ids));
                onDocsChanged?.();
              }}
            />
          )}
          {/* 本事项已有的事实：开工前就说助手手里有什么 */}
          {card.scenario === "a1.agent_task" && factCounts && factCounts.confirmed + factCounts.proposed > 0 && (
            <div className="ss-facts muted">
              <span className="ss-facts-dot" aria-hidden="true" />
              {factCounts.confirmed > 0
                ? `本事项已有 ${factCounts.confirmed} 条你确认过的事实${factCounts.proposed > 0 ? `、${factCounts.proposed} 条待确认` : ""}：确认过的直接采用${factCounts.proposed > 0 ? "，待确认的写得保守并列进核对清单" : ""}。`
                : `本事项有 ${factCounts.proposed} 条事实还没确认：文书里会写得保守并列进核对清单；先到事项页“事实”里确认，写出来更扎实。`}
            </div>
          )}
        </section>
        <section className="ss-sec">
          {(mainFields.length > 0 || moreFields.length > 0) && <div className="ss-h">这次要定的事</div>}
          {mainFields.map(renderField)}
          {rules && (
            <label className="ss-rules">
              <input type="checkbox" checked={useRules} onChange={(e) => setUseRules(e.target.checked)} />
              按本事项审查要点「{rules.title}」第 {rules.version} 版（{rules.rules.length} 条）{card.skill === "contract-draft" ? "起草" : "审查"}
            </label>
          )}
          {moreFields.length > 0 && (
            <>
              <button type="button" className={`btn-link ss-more${moreShown ? " open" : ""}`} aria-expanded={moreShown} onClick={() => setMoreOpen(!moreShown)}>
                <Icon.chevron /> 更多选项<span className="muted">（{moreFields.map((f) => f.label).join("、")}）</span>
              </button>
              {moreShown && moreFields.map(renderField)}
            </>
          )}
          <label className="ss-field ss-field-long">
            <span className="ss-label">补充要求（可选）</span>
            {/* V13 第 38 批真实走查 W3：审合同这类没有主要请求栏的卡，律师的具体指示（要哪几份文件、谈判优先级）都写在这里（346 字），单行框只看得到末尾 */}
            <textarea aria-label="补充要求" rows={2} value={extra} placeholder="例如：重点看交割前提条件" onChange={(e) => setExtra(e.target.value)} />
          </label>
        </section>
        <section className="ss-sec">
          <div className="ss-h">你得到什么</div>
          <ul className="ss-gets">
            {getsPlain(card).map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <button className="btn-link ss-how" aria-expanded={how} onClick={() => setHow((v) => !v)}>
            这个方法会怎么做 {how ? "▾" : "▸"}
          </button>
          {how && (
            <ol className="ss-steps">
              {card.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          <div className="ss-est" aria-live="polite">
            {estimate ? (
              <>
                {estimate.estimate.points_display}
                {/* 第 46 批：要重新登录、额度暂停时，开始前就说清原因与入口（不用等点了开始才知道） */}
                {startHintOf(estimate.estimate.data_where?.start_hint) && <StartHintBanner hint={startHintOf(estimate.estimate.data_where?.start_hint)!} onAction={onClose} />}
              </>
            ) : estErr ? (
              <span className="ss-need">{estErr}</span>
            ) : ready ? (
              <span className="muted" role="status">
                <BusyLabel busy>正在估算…</BusyLabel>
              </span>
            ) : (
              <span className="muted">{missing.length > 0 ? `请先填写：${missing.map((f) => f.label).join("、")}` : wordGap ? "请先选择要修改的 Word 文书" : needDocs > 0 ? "请先选择材料" : noCase ? `请先写${card.brief!.label}，或添加材料` : ""}</span>
            )}
          </div>
          {/* 发送什么、发给谁：与开始前确认同一块（第 27 批，评审 U3-01：卡片路径原来只有一段折叠长句，风险句埋在括号里）。
              发送摘要不放在 aria-live 区域里（复核 S5B-06：发送视图与核对表不应被整段朗读） */}
          {matter && estimate && (
            <SendPoints dataWhere={estimate.estimate.data_where}>
              {estimate.estimate.data_where?.send_summary && (
                <SendSummary
                  matterId={matter.matter_id}
                  summary={estimate.estimate.data_where.send_summary}
                  documentIds={docIds}
                  goal={goal}
                  mustReview={estimate.estimate.data_where.block_kind === "suspects"}
                  onReviewed={() => setReestimateTick((n) => n + 1)}
                />
              )}
            </SendPoints>
          )}
          {confirmedFacts === 0 && (
            <p className="banner banner-orange">这个事项还没有确认过的事实：AI 会先用材料载明的事实做矩阵（标【未确认】，评估写“初步判断”）。到事项页“事实”里逐条确认后再做，结论更可靠。</p>
          )}
          {hasPrefs && <p className="ss-note muted">按你的写作偏好写（设置 · 文书与写作里可改）。</p>}
          <p className="ss-note muted">结果都是草稿，需要你复核后使用。{card.scenario === "a1.agent_task" ? "处理中需要联网或用到当事人信息时，会先问你。" : ""}</p>
        </section>
        {/* 选项指向别的卡（第 26 批，评审 S2-03）：例如“收到的是劳动仲裁申请书”改用“劳动仲裁应对” */}
        {fieldRedirect(card, values) && (
          <div className="banner banner-orange">
            {fieldRedirect(card, values)!.text}
            <div className="banner-actions">
              <button className="btn-ghost btn-sm" onClick={() => nav(`/start/${fieldRedirect(card, values)!.card.id}${matter ? `/${matter.matter_id}` : ""}`)}>
                改用“{fieldRedirect(card, values)!.card.title}”
              </button>
            </div>
          </div>
        )}
        {sampleBlocked && <div className="banner banner-gray">示例事项只用来看效果，不能存审查要点：请在你自己的事项里整理。</div>}
        {errHint && <StartHintBanner hint={errHint} onAction={onClose} />}
        {err && <div className="banner banner-red">{err}</div>}
        {/* 底部按钮贴底（第 26 批走查：1280×720 下“开始审查”在首屏之外，要先滚到底才看得到）；还不能开始时左边写缺什么 */}
        <div className="modal-actions modal-actions-sticky">
          {!ready && !busy && (missing.length > 0 || needDocs > 0 || !!wordGap || noCase) && <span className="muted ss-foot-why">{missing.length > 0 ? `先填写：${missing.map((f) => f.label).join("、")}` : wordGap ? "先添加或勾选要修改的 Word 文书（.docx）" : needDocs > 0 ? "先选择材料" : `先写${card.brief!.label}，或添加材料`}</span>}
          {card.scenario === "a1.agent_task" && (
            <label className="ss-plan-first" title="勾选后，助手先把打算怎么做写给你，你同意了才开始；不勾就直接按这张卡的步骤做。">
              <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} />
              开始前先给我看计划
            </label>
          )}
          <button className="btn-ghost" onClick={onClose}>取消</button>
          {/* 还不能开始时（例如疑似姓名待核对）不占主按钮：同屏的主动作是待办那一步（复核 S7B-01） */}
          <button className={ready ? "btn-primary" : "btn-ghost"} disabled={busy || !ready} aria-busy={busy} onClick={() => void start()}>
            {/* 第 27 批（评审 U3-49）：点了还要再确认的（依据未齐、去向有提醒）写“下一步”，直接开始的写动词；
                第 51 批：点下后按钮内显示圆环与“正在开始…”，看得出点上了 */}
            <BusyLabel busy={busy} busyText={estimate && (estimate.estimate.data_where?.start_blocked || estimate.estimate.data_where?.warning) ? "正在准备确认…" : "正在开始…"}>
              {estimate && (estimate.estimate.data_where?.start_blocked || estimate.estimate.data_where?.warning) ? "下一步：确认" : card.verb}
            </BusyLabel>
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 补全提示（v9.4 第 22 批，C1 #24）：一行说缺什么、为什么；点“填写”就地补上（写进事项，与概览阶段条同一份）。 */
function FactHints({ matter, hints, onSaved }: { matter: Matter; hints: ReturnType<typeof matterFactHints>; onSaved: (f: HintField, v: string) => void }) {
  const [open, setOpen] = useState<HintField | null>(null);
  const [v, setV] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (f: HintField, value: string) => {
    const val = value.trim();
    if (!val) return;
    if (f === "event_date" && eventDateProblem(val)) return setErr(eventDateProblem(val)!);
    setBusy(true);
    setErr("");
    try {
      await api.updateMatter(matter.matter_id, { [f]: val });
      notifyDataChanged();
      onSaved(f, val);
      setOpen(null);
      setV("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const readOnly = (matter.lifecycle ?? "active") !== "active" || !!matter.is_sample;
  return (
    <div className="ss-hints muted">
      {hints.map((h) => (
        <div key={h.field} className="ss-hint-row">
          这个事项还没填{h.label}：{h.why}。
          {!readOnly && open !== h.field && (
            <button className="btn-link" onClick={() => { setOpen(h.field); setV(""); setErr(""); }}>
              填写
            </button>
          )}
          {open === h.field && (
            <span className="ss-hint-edit">
              {h.field === "stage" ? (
                <Select aria-label={h.label} value={v} placeholder="选一个阶段" onChange={(x) => void save("stage", x)} options={stagesFor(matter.stance).map((st) => ({ value: st, label: STAGE_LABELS[st] }))} />
              ) : (
                <>
                  <input aria-label={h.label} value={v} onChange={(e) => setV(e.target.value)} placeholder={h.field === "event_date" ? "2023-05 或 2023-05-06" : "如 上海市"} maxLength={h.field === "region" ? 20 : 10} size={14} />
                  <button className="btn-ghost btn-sm" disabled={busy || !v.trim()} aria-busy={busy} onClick={() => void save(h.field, v)}>
                    <BusyLabel busy={busy} busyText="正在保存…">保存</BusyLabel>
                  </button>
                </>
              )}
              <button className="btn-link" onClick={() => setOpen(null)}>取消</button>
            </span>
          )}
        </div>
      ))}
      {err && <div className="ss-need">{err}</div>}
    </div>
  );
}

/** 主交付物有值才带上（第 31 批：可能随律师选的字段变） */
function primaryOpt(p: string | undefined): { primaryOutput?: string } {
  return p ? { primaryOutput: p } : {};
}

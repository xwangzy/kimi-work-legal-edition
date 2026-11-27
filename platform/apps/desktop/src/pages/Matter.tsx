/**
 * 事项页（第 03 篇 §4.4 事项头常显；材料、任务、看板、当事人词典、数据去向）。
 * 第 73 批（D-308、D-310）：团队共享事项——事项头“团队共享 · n 人”胶囊、“⋯ → 事项成员”页；个人事项的负责人在团队空间里有“⋯ → 和同事一起办…”。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, matterMembers, teamMatters, type MatterMembersView, type AiAuthorization, type EgressRecord, type Matter, type MaterialFile, type MaterialImportResult, type MaterialTriage, type MaterialUsage, type MatterBasis, type RunPolicyView } from "../api.ts";
import { triageSuggestion, triageText } from "../lib/material-triage.ts";
import { nav } from "../App.tsx";
import { Composer, type ComposerValue } from "../components/Composer.tsx";
import { BasisEditor, basisComplete, MatterHeader } from "../components/MatterHeader.tsx";
import { AuthorizationRecord } from "../components/Consent.tsx";
import { BASIS_REF_MAX, basisAfterConfirm, confirmNeeds, detailReady, detailSource, initialRecord, recordReady, type AuthRecord } from "../lib/authorization.ts";
import { Modal } from "../components/Modal.tsx";
import { WaitBlock } from "../components/Loading.tsx";
import { countProgress } from "../lib/waiting.ts";
import { defaultChoice } from "../components/ModeSelector.tsx";
import { PartiesPanel } from "../components/Parties.tsx";
import { prepareStart, RunSheet, type PendingStart } from "../components/RunSheet.tsx";
import { TableReview } from "../components/TableReview.tsx";
import type { TableView } from "../lib/table-review.ts";
import { reasonLabel } from "../components/DataFlow.tsx";
import { DEST_LABELS, fmtTime, fmtWhen, jurisdictionLabel, materialStateLabel, MODE_LABELS, parseFlagsText, RUN_STATUS_LABELS, SCENARIO_LABELS, stanceLabel } from "../lib/labels.ts";
import { FactsPanel } from "../components/FactsPanel.tsx";
import { decideMatterTab } from "../lib/matter-tab.ts";
import { peekMatterFocus } from "../lib/search.ts";
import { sampleBannerText } from "../lib/scenarios.ts";
import { MatterBoard } from "./Boards.tsx";
import { MatterDeliverables } from "./Deliverables.tsx";
import { MatterLifecyclePanel } from "../components/MatterLifecycle.tsx";
import { ReviewWorkbench } from "../components/ReviewWorkbench.tsx";
import { notifyDataChanged } from "../lib/events.ts";
import { RolePills } from "../components/Select.tsx";
import { Breadcrumb } from "../components/Breadcrumb.tsx";
import { importFailText } from "../lib/errors.ts";
import { MaterialFolderBar } from "../components/MaterialFolderBar.tsx";
import { MaterialSearch } from "../components/MaterialSearch.tsx";
import { filterDocsByName, importResultText, MATERIAL_ORIGIN_LABELS, materialOrigin, relDir, supersededIds, visibleMaterials } from "../lib/material-folder.ts";
import { MaterialPicker } from "../components/MaterialPicker.tsx";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { SafePreview } from "../components/SafePreview.tsx";
import { AddColleaguesDialog, MatterMembersPanel, useRoster, useTeamKind } from "../components/TeamMatter.tsx";
import { canOfferShare, isTeamShared, needsShareRefresh, reconfirmReason, REMOVED_ME_TEXT, removeLocalCopyLines, sharedMaterialNote, teamFaultText } from "../lib/team-matters.ts";
import "../styles-materials.css";
import "../styles-matter.css";

type Tab = "materials" | "facts" | "runs" | "board" | "deliverables" | "parties" | "egress" | "lifecycle" | "members";
/** “⋯”里的几页（第 73 批：团队共享事项多“事项成员”）。 */
const MORE_TAB_LABEL: Partial<Record<Tab, string>> = { parties: "当事人名单", egress: "数据去向记录", lifecycle: "结案与删除" };

export function MatterPage({ matterId }: { matterId: string }) {
  const [matter, setMatter] = useState<Matter | null>(null);
  const [docs, setDocs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [policy, setPolicy] = useState<RunPolicyView | null>(null);
  // 事项页标签（Z3 评审 IA-4、#10）：打开事项默认停在“概览”；还没有材料的新事项停在“材料”；律师点过标签后不再自动切换
  const [tab, setTabRaw] = useState<Tab>("materials");
  const [moreOpen, setMoreOpen] = useState(false);
  // “⋯”菜单：点外面或按 Esc 关闭（复核 Q1-20）
  const moreRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);
  // 复核 B13-U04：只在每个事项首次拿到材料列表时定一次，之后材料数变化（如拖入第一份材料）不再自动跳走
  const tabTouched = useRef(false);
  const tabDecidedFor = useRef<string | null>(null);
  const setTab = (t: Tab) => {
    tabTouched.current = true;
    setTabRaw(t);
  };
  useEffect(() => {
    const next = decideMatterTab(tabDecidedFor.current, matter?.matter_id ?? null, docs.length, tabTouched.current);
    tabDecidedFor.current = next.decidedFor;
    if (next.tab) setTabRaw(next.tab);
  }, [matter?.matter_id, docs.length]);
  // 从全局搜索点中一份材料进来（第 49 批）：切到“材料”列表；文件名由材料搜索框挂载时取走并筛出这份
  useEffect(() => {
    if (!matter?.matter_id || peekMatterFocus(matter.matter_id) === null) return;
    setTab("materials");
    setMatView("list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matter?.matter_id]);
  const [value, setValue] = useState<ComposerValue>({ goal: "", scenario: "a1.agent_task", documentIds: [], choice: defaultChoice(null) });
  const [sheet, setSheet] = useState<PendingStart | null>(null);
  // 输入框不常驻（v9.4 第 20 批 G-09：1280×720 下标签内容起点 ≤ 260px）：标题行“发起任务”展开；写了字的不收起
  const [composerOpen, setComposerOpen] = useState(false);
  // 材料标签：列表 / 表格审阅（v9.4 第 19 批 C-01：不加导航，只加视图）
  const [matView, setMatView] = useState<"list" | "table">("list");
  const [tableFocus, setTableFocus] = useState<string | null>(null);
  const [basisOpen, setBasisOpen] = useState(false);
  const [msg, setMsg] = useState("");
  // 导入没成功的文件单列、红色（第 27 批，评审 U3-04：原来与成功的混在一段灰字里，英文报错直接上屏）
  const [failMsg, setFailMsg] = useState("");
  const [busy, setBusy] = useState(false);
  /** 每份材料的审查意见（复核 B3-B20：事项页的工作台入口，跨任务汇总）；null 键 = 未关联合同的意见。 */
  const [review, setReview] = useState<Map<string | null, { total: number; open: number }>>(new Map());
  const [workbench, setWorkbench] = useState<{ doc: string | null } | null>(null);
  /** 材料初判（v9.4 第 22 批，C1 #28）：本机按规则认出的文书类型与篇幅，只做建议。 */
  const [triage, setTriage] = useState<Map<string, MaterialTriage>>(new Map());
  /** 材料和任务的对应（第 66 批 K2/D4）：每份材料被哪些任务勾选过；展开的是哪一份；预览哪一份；旧版本与已移除的是否展开。 */
  const [usage, setUsage] = useState<Map<string, MaterialUsage["documents"][number]>>(new Map());
  const [usageOpen, setUsageOpen] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ filename: string; text: string | null; error?: string } | null>(null);
  const [showOld, setShowOld] = useState(false);
  // 第 73 批：事项成员（团队共享事项才取）；个人事项“和同事一起办…”弹窗；改为一起办之后的一句结果
  // 类型不知道（刚切到的团队档案）时按名单推断：“和同事一起办…”照常给，由内核判断并如实显示原因
  const { ws, kind: teamKind } = useTeamKind();
  const [members, setMembers] = useState<MatterMembersView | null>(null);
  const [membersErr, setMembersErr] = useState<string | null>(null);
  const [membersTick, setMembersTick] = useState(0);
  const [sharing, setSharing] = useState(false);
  // 第二轮复评 T13（42）：被负责人移出后“从我的电脑移除…”（内核 matters.remove_local_copy）
  const [removingLocal, setRemovingLocal] = useState(false);
  const [shareMsg, setShareMsg] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);

  const reload = useCallback(() => {
    api
      .getMatter(matterId)
      .then((r) => {
        setMatter(r.matter);
        setDocs(r.documents);
        setRuns(r.runs ?? []);
        setPolicy(r.run_policy ?? null);
        setValue((v) => ({ ...v, choice: v.goal || v.documentIds.length ? v.choice : defaultChoice(r.run_policy) }));
      })
      .catch((e) => setMsg(e.message));
    api
      .materialTriage(matterId)
      .then((r) => setTriage(new Map(r.items.map((t) => [t.document_version_id, t]))))
      .catch(() => setTriage(new Map()));
    api
      .materialUsage(matterId)
      .then((r) => setUsage(new Map(r.documents.map((d) => [d.document_version_id, d]))))
      .catch(() => setUsage(new Map()));
    api
      .riskCards(matterId)
      .then((r) => {
        const m = new Map<string | null, { total: number; open: number }>();
        for (const c of r.cards) {
          const k = c.document_version_id ?? null;
          const cur = m.get(k) ?? { total: 0, open: 0 };
          cur.total++;
          if (c.status === "proposed") cur.open++;
          m.set(k, cur);
        }
        setReview(m);
      })
      .catch(() => setReview(new Map()));
  }, [matterId]);
  useEffect(reload, [reload]);
  const teamShared = isTeamShared(matter, ws.kind);
  // “和同事一起办…”：能给时才取一次同事名单（60 秒内共用）；云端还没有同事名单能力（not_supported，如线上 1.6 / 1.7）时不出现。名单没回来前照常给，由内核判断
  const offerBase = !!matter && !teamShared && canOfferShare(teamKind, matter);
  const offerRoster = useRoster(offerBase);
  const offerShare = offerBase && canOfferShare(teamKind, matter!, offerRoster);
  useEffect(() => {
    if (!teamShared) {
      setMembers(null);
      return;
    }
    let live = true;
    setMembersErr(null);
    matterMembers
      .list(matterId)
      .then((r) => live && setMembers(r))
      .catch((e) => live && setMembersErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [matterId, teamShared, membersTick]);
  // 第 73 批（实拍补）：事项成员页上方是“所内还没开通 / 不知道”时问一次内核（带 matter_id，每次打开这个事项至多一次，不轮询；内核另有 60 秒节流）；
  // 规则刚放开就把那句换掉
  const shareAsked = useRef<string | null>(null);
  useEffect(() => {
    if (tab !== "members" || !members || members.matter_id !== matterId || shareAsked.current === matterId || !needsShareRefresh(members.sync)) return;
    shareAsked.current = matterId;
    void teamMatters.refreshShareState(matterId).then((r) => {
      if (r && r.sync !== members.sync) setMembers((v) => (v && v.matter_id === matterId ? { ...v, sync: r.sync } : v));
    });
  }, [tab, matterId, members]);

  const patch = async (p: Record<string, unknown>, note: string) => {
    try {
      const r = await api.updateMatter(matterId, p);
      setMatter(r.matter);
      setMsg(note);
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  /** 正在添加第几份（第 51 批：逐份解析加密，扫描件要识别文字，可能要几十秒——给真实的 n/m、文件名与已用时间）。 */
  const [adding, setAdding] = useState<{ i: number; total: number; name: string; since: number } | null>(null);
  // select：导入后自动勾进输入框（第 66 批 D4：与首页一致；同内容已在本事项的也勾上那一份）
  const upload = async (files: FileList | MaterialFile[] | null, mode: "import" | "mount", select = false) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setMsg("");
    // 逐个处理：一份失败（例如带密级标志被拒）不影响其余文件，结果逐条告诉律师
    const lines: string[] = [];
    const fails: string[] = [];
    setFailMsg("");
    try {
      const list = Array.from(files);
      const since = Date.now();
      for (const [i, f] of list.entries()) {
        setAdding({ i: i + 1, total: list.length, name: f.name, since });
        try {
          const r = (mode === "import" ? await api.importMaterial(matterId, f) : await api.mountMaterial(matterId, f)) as MaterialImportResult;
          const how = mode === "import" ? "已添加（加密保存一份副本，原文件不改动）" : "已关联（只读引用原文件，不复制）";
          if (r.duplicate) lines.push(`${f.name}：${importResultText(f.name, r)}`);
          else lines.push(`${f.name} ${how}，${Number(r.chars ?? 0).toLocaleString()} 字${r.marking_notice ? `。${r.marking_notice}` : ""}`);
          if (select && r.document_version_id) setValue((v) => (v.documentIds.includes(r.document_version_id) ? v : { ...v, documentIds: [...v.documentIds, r.document_version_id] }));
        } catch (e) {
          fails.push(importFailText(f.name, (e as Error).message));
        }
      }
      setMsg(lines.join("\n"));
      setFailMsg(fails.join("\n"));
      reload();
      if (lines.length > 0) notifyDataChanged();
    } finally {
      setAdding(null);
      setBusy(false);
    }
  };

  /** 预览原文（第 66 批 D4）：本机解析出的文字，不联网、不发给 AI。 */
  const openPreview = (d: { document_version_id: string; filename: string }) => {
    setPreview({ filename: d.filename, text: null });
    api
      .materialText(d.document_version_id)
      .then((r) => setPreview({ filename: d.filename, text: r.paragraphs.join("\n") }))
      .catch((e) => setPreview({ filename: d.filename, text: "", error: (e as Error).message }));
  };

  /** 移除误放的材料（第 66 批 K3/D4）：删本产品保存的副本与解析文字，原文件不动，留审计；进行中的任务在用时内核拒绝并说明。 */
  const removeDoc = async (d: { document_version_id: string; filename: string }) => {
    setMsg("");
    setFailMsg("");
    try {
      const r = await api.removeMaterial(d.document_version_id);
      setMsg(`《${d.filename}》${r.note ? `：${r.note}` : "已移除"}`);
      setValue((v) => ({ ...v, documentIds: v.documentIds.filter((x) => x !== d.document_version_id) }));
      reload();
      notifyDataChanged();
    } catch (e) {
      setFailMsg(`《${d.filename}》没有移除：${(e as Error).message}`);
    }
  };

  // 让助手填审阅表：表格审阅方法，表编号作方法参数，材料为表里的材料（照常先估价、确认）
  const fillTable = async (t: TableView) => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      setSheet(
        await prepareStart(
          matter,
          { goal: `按审阅表《${t.title}》逐份材料、逐列填写，每格附原文；已核的格子不改`, scenario: "a1.agent_task", documentIds: t.document_version_ids, choice: value.choice },
          { skill: "tabular-review", label: "表格审阅", skillArgs: { table_id: t.table_id } },
        ),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 问这张表（v9.4 第 21 批，C1 §3.3 跨表对话）：同一方法的问表模式，只依据表里的格子回答，不改表
  const askTable = async (t: TableView, question: string) => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      setSheet(
        await prepareStart(
          matter,
          { goal: `只依据审阅表《${t.title}》里的格子回答：${question}（每个结论写明材料与列，没核的格子标待核；不改表）`, scenario: "a1.agent_task", documentIds: t.document_version_ids, choice: value.choice },
          { skill: "tabular-review", label: "问这张表", skillArgs: { table_id: t.table_id, mode: "问表" } },
        ),
      );
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!matter) return;
    setBusy(true);
    setMsg("");
    try {
      // 没勾材料 = 用本事项的全部材料（第 48 批：不含被同一位置新版本取代的旧版本）
      const old = supersededIds(docs);
      const v = value.documentIds.length === 0 && value.scenario !== "a1.agent_task" ? { ...value, documentIds: docs.filter((d) => !d.quarantined_at && !old.has(d.document_version_id)).map((d) => d.document_version_id) } : value;
      setSheet(await prepareStart(matter, v, { docNames: docs.filter((d) => v.documentIds.includes(d.document_version_id)).map((d) => d.filename) }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!matter) {
    return (
      <main className="main">
        <div className="main-wide">{msg ? <div className="banner banner-red">{msg}</div> : <p className="muted">载入中…</p>}</div>
      </main>
    );
  }
  if (workbench) {
    return (
      <ReviewWorkbench
        matterId={matterId}
        documentVersionId={workbench.doc}
        agreement={{ stance: matter?.stance ? stanceLabel(matter.stance) : null, jurisdiction: matter?.jurisdiction ? jurisdictionLabel(matter.jurisdiction) : null }}
        readOnly={matter?.lifecycle !== undefined && matter.lifecycle !== "active"}
        backLabel="← 返回事项"
        onClose={() => {
          setWorkbench(null);
          reload();
        }}
      />
    );
  }
  // 已删除的事项：只显示删除回执（名称已替换为占位，内容已删除）
  if (matter.lifecycle === "purged") {
    return (
      <main className="main">
        <div className="main-wide">
          <h1 className="page-title">{matter.title}</h1>
          <MatterLifecyclePanel matter={matter} onChanged={reload} />
        </div>
      </main>
    );
  }
  const closed = matter.lifecycle === "closed";
  // 第 73 批（端到端验收 P3-3）：“只看”的事项成员——加材料、发起任务、关联案卷文件夹、改材料用途与授权一律收起，并说明一句（内核 matters.get.can_write；旧内核按 my_role）
  // 第 73 批（验收 P2-2）：负责人已把我移出这个事项（内核 removed_me / 成员视图 sync = removed）——一条说明、不再写“团队共享 · n 人”、写入口收起
  const removedMe = !!matter.removed_me || members?.removed_me === true || members?.sync === "removed";
  const viewOnly = !removedMe && (matter.can_write === false || (matter.can_write === undefined && matter.my_role === "viewer"));
  const locked = closed || viewOnly || removedMe;
  const basis: MatterBasis = matter.basis ?? {
    engagement: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
    personal_info: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
    sensitive: "not_applicable",
    subprocessor: matter.consent_status === "agreed" || matter.consent_status === "not_required" ? "confirmed" : "pending",
  };
  return (
    <main className="main">
      <div className="main-wide">
        <Breadcrumb items={[{ label: "事项", href: "/matters" }, { label: matter.title }]} />
        <div className="page-head">
          <h1 className="page-title">{matter.title}</h1>
          <div className="page-head-actions">
            {!locked && (
              <button className="btn-ghost" aria-expanded={composerOpen || !!value.goal.trim()} onClick={() => setComposerOpen((v) => !v || !!value.goal.trim())}>
                发起任务
              </button>
            )}
            {!closed && !matter.is_sample && (
              <button className="btn-ghost" onClick={() => nav(`/reminders/new/${encodeURIComponent(matterId)}`)}>
                设提醒
              </button>
            )}
          </div>
        </div>
        {matter.is_sample && (
          <div className="banner banner-gray banner-inline">
            {sampleBannerText(
              matter,
              (() => {
                // 诉讼示例按本机“整理案卷”任务的状态说明（余项续复核 RC-B-13）
                const cf = runs.find((r) => r.scenario === "s2.case_file");
                return !cf ? null : cf.status === "succeeded" || cf.status === "partial" ? "done" : ["failed", "cancelled"].includes(cf.status) ? "failed" : "running";
              })(),
            )}
            <div className="banner-actions">
              <button
                className="btn-ghost btn-sm"
                onClick={() =>
                  void api
                    .removeSample(matterId)
                    .then(() => nav("/matters"))
                    .catch((e) => setMsg((e as Error).message))
                }
              >
                移除示例
              </button>
            </div>
          </div>
        )}
        {/* 结案后只读（复核 C-B11）：事项头的修改入口不再出现，内核同样拒绝 */}
        <MatterHeader
          matter={matter}
          policy={policy}
          onParties={() => setTab("parties")}
          team={teamShared && !removedMe ? { view: members, error: membersErr } : null}
          onMembers={() => setTab("members")}
          {...(locked
            ? {}
            : {
                onEditBasis: () => setBasisOpen(true),
                onToggleFullPseudonym: (on: boolean) => void patch({ full_pseudonym: on }, on ? "已开启全部化名：机构名称也替换为代号（留痕）" : "已关闭全部化名（留痕）"),
                onClearRefusal: () => void patch({ consent_status: "pending" }, "已清除“当事人拒绝云端处理”的记录（留痕）：请按回执核实四项依据"),
                onConsentNotice: () =>
                  void api
                    .consentNotice(matterId)
                    .then((r) => {
                      setMsg(`${r.filename}：${r.note}（见“成果 · 草稿”）`);
                      notifyDataChanged();
                    })
                    .catch((e) => setMsg((e as Error).message)),
              })}
        />
        {closed && (
          <div className="banner banner-orange matter-closed-banner">
            <span>本事项已结案（只读），保留至 {String(matter.retention_until ?? "").slice(0, 10)}{matter.legal_hold ? `；法律保全：${matter.legal_hold_reason ?? ""}` : ""}。</span>
            <button className="btn-link" onClick={() => setTab("lifecycle")}>结案与删除</button>
          </div>
        )}
        {removedMe && (
          <div className="banner banner-gray banner-inline removed-me-note" role="note">
            <span>{REMOVED_ME_TEXT}</span>
            <button type="button" className="btn-link" onClick={() => setRemovingLocal(true)}>
              从我的电脑移除…
            </button>
          </div>
        )}
        {viewOnly && !closed && (
          <div className="banner banner-gray banner-inline view-only-note" role="note">
            你在这个事项里是“只看”：可以看材料、AI 记录和成果，不能加材料、发起任务或改动。要改动，请找负责人把你改为“一起办”。
          </div>
        )}
        {!locked && (composerOpen || !!value.goal.trim()) && <div className="matter-composer has-text">
          <Composer
            autoFocus
            matterId={matterId}
            stance={matter?.stance}
            documents={visibleMaterials(docs)}
            policy={policy}
            value={value}
            onChange={setValue}
            onImport={(f) => void upload(f, "import", true)}
            onSubmit={() => void submit()}
            busy={busy}
            onPickScenario={(c) => nav(`/start/${c.id}/${matterId}`)}
            placeholder="在本事项内发起任务，例如：核验起诉状引用的法条是否现行有效"
          />
        </div>}
        {adding && (
          <WaitBlock
            title={adding.total > 1 ? `正在添加第 ${countProgress(adding.i, adding.total)!.text} 份…` : "正在添加材料…"}
            hint={adding.name}
            longHint="扫描件和图片要先识别文字，页数多时会慢一些；识别在这台电脑上进行，不联网。"
            since={adding.since}
          />
        )}
        {msg && <p className="muted" role="status" style={{ whiteSpace: "pre-line" }}>{msg}</p>}
        {failMsg && <div className="banner banner-red" role="alert" style={{ whiteSpace: "pre-line" }}>{failMsg}</div>}
        {/* 事项页标签（v9.4 U1 #9）：日常五个；当事人名单、数据去向记录、结案与删除收进“⋯” */}
        <div className="tabs tabs-line" role="tablist" aria-label="事项">
          {(
            [
              ["board", "概览"],
              ["materials", `材料（${docs.filter((d) => !d.quarantined_at).length}）`],
              ["facts", "事实"],
              // “任务”改名“AI 记录”（C1 §3.2）：它是 AI 运行流水，待办在概览里
              ["runs", `AI 记录（${runs.length}）`],
              ["deliverables", "成果"],
              // 第 73 批（设计评分第一轮 T5 / 跨页 10）：团队共享事项“事项成员”常驻为一个标签（不再进去后才出现、也不在“⋯”里重复）
              ...(teamShared && !removedMe ? ([["members", "事项成员"]] as [Tab, string][]) : []),
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTab(k)}>{l}</button>
          ))}
          {MORE_TAB_LABEL[tab] && (
            <button role="tab" aria-selected className="tab active">{MORE_TAB_LABEL[tab]}</button>
          )}
          <span className="spacer" />
          <span className="tab-more-wrap" ref={moreRef}>
            <button className="tab tab-more" aria-haspopup="menu" aria-expanded={moreOpen} aria-label={`更多：${[offerShare ? "改为团队共享" : "", removedMe ? "从我的电脑移除" : "", "当事人名单", "数据去向记录", removedMe ? "" : "结案与删除"].filter(Boolean).join("、")}`} onClick={() => setMoreOpen((v) => !v)}>
              ⋯
            </button>
            {moreOpen && (
              <div className="popover tab-more-menu" role="menu">
                {/* 第 73 批：个人事项的负责人（团队空间、进行中）有“和同事一起办…”；团队共享事项的“事项成员”是常驻标签 */}
                {offerShare && (
                  <button role="menuitem" className="menu-item" onClick={() => { setSharing(true); setMoreOpen(false); }}>
                    <span className="menu-label">改为团队共享…</span>
                  </button>
                )}
                {/* 被移出的成员：只删这台电脑上的副本（负责人与同事那边不受影响）；“结案与删除”是负责人的事，不给 */}
                {removedMe && (
                  <button role="menuitem" className="menu-item" onClick={() => { setRemovingLocal(true); setMoreOpen(false); }}>
                    <span className="menu-label">从我的电脑移除…</span>
                  </button>
                )}
                {(
                  [
                    ["parties", "当事人名单"],
                    ["egress", "数据去向记录"],
                    ...(removedMe ? [] : [["lifecycle", "结案与删除"]]),
                  ] as [Tab, string][]
                ).map(([k, l]) => (
                  <button key={k} role="menuitem" className="menu-item" onClick={() => { setTab(k); setMoreOpen(false); }}>
                    <span className="menu-label">{l}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
        </div>
        {tab === "materials" && (
          <section>
            {/* 第 55 批：显示方式与案卷文件夹并成一行工具栏（原来显示方式、拖放区、文件夹、搜索四行叠在表格上面） */}
            <div className="mat-toolbar">
              {docs.length > 0 && (
                <div className="wb-doc-view mat-view" role="group" aria-label="材料显示方式">
                  <button aria-pressed={matView === "list"} className={`wb-view-btn${matView === "list" ? " active" : ""}`} onClick={() => setMatView("list")}>列表</button>
                  <button aria-pressed={matView === "table"} className={`wb-view-btn${matView === "table" ? " active" : ""}`} onClick={() => setMatView("table")}>表格审阅</button>
                </div>
              )}
              {/* 案卷文件夹（第 48 批）：关联本机的一个文件夹，手动同步新增、改过的文件；位置只在这台电脑上 */}
              {matView === "list" && <MaterialFolderBar matterId={matter.matter_id} folder={matter.folder ?? null} readOnly={locked} disabled={busy} onChanged={reload} sharedNote={sharedMaterialNote(teamShared)} />}
            </div>
            {matView === "table" && docs.length > 0 && <TableReview matterId={matter.matter_id} docs={docs} readOnly={locked} initialTable={tableFocus} onFill={(t) => void fillTable(t)} onAsk={(t, q) => void askTable(t, q)} onExported={() => void reload()} />}
            {/* 第 66 批 D1：添加材料与首页、开始面板、追问同一个组件（拖放、选择文件、逐份结果；同内容已在本事项的不重复保存） */}
            {matView === "list" && !locked && (
              <MaterialPicker
                matterTitle={matter.title}
                sharedNote={sharedMaterialNote(teamShared)}
                documents={docs}
                showList={false}
                disabled={busy}
                onImport={(f) => api.importMaterial(matterId, f) as Promise<MaterialImportResult>}
                onMount={(f) => api.mountMaterial(matterId, f) as Promise<MaterialImportResult>}
                onImported={(out) => {
                  reload();
                  if (out.some((o) => o.ok)) notifyDataChanged();
                }}
              />
            )}
            {matView === "list" && docs.length > 0 && (
              // 材料内搜索（第 48 批）：输入即按文件名筛选下面的表；回车或停顿片刻再到材料的文字里找
              <MaterialSearch matterId={matter.matter_id}>
                {(q) => {
                  const shown = filterDocsByName(docs, q);
                  const old = supersededIds(docs);
                  return shown.length === 0 ? (
                    <p className="ms-empty">没有文件名含“{q.trim()}”的材料</p>
                  ) : (
              // 固定列宽（第 27 批，评审 U3-05）：1280 宽下“我方 / 对方 / 参考”曾逐字竖排折行；只有文件名列可以两行
              <table className="data mat-table">
                <colgroup><col /><col className="c-role" /><col className="c-triage" /><col className="c-read" /><col className="c-review" /><col className="c-time" /></colgroup>
                <thead><tr><th>文件</th><th>用途</th><th>初判</th><th>读取</th><th>审查意见</th><th>时间</th></tr></thead>
                <tbody>
                  {(() => {
                    // 第 66 批 D4：旧版本与已移除（或已隔离）的材料默认折叠在最后
                    const folded = shown.filter((d) => d.quarantined_at || old.has(d.document_version_id));
                    const current = shown.filter((d) => !folded.includes(d));
                    const row = (d: any) => (
                    <Fragment key={d.document_version_id}>
                    <tr>
                      <td className="mat-name" title={`${d.rel_path ?? d.filename}${d.storage_mode === "mount" ? "（只引用原文件，未复制）" : "（已加密保存副本）"}`}>
                        <span className="mat-name-text">{d.filename}</span>
                        {/* 来源（第 66 批 D7，按规则推断）：案卷文件夹 / 引用原文件 / 律师填写 / 由成果转入；普通上传不标 */}
                        {materialOrigin(d) !== "upload" && <span className="tag tag-gray">{MATERIAL_ORIGIN_LABELS[materialOrigin(d)]}</span>}
                        {old.has(d.document_version_id) && <span className="tag tag-gray mat-old" title="同一位置（或同一份当事人信息）已有新版本，这是之前的版本">旧版本</span>}
                        {/* 文件夹里的位置（目录部分）作第二行 */}
                        {relDir(d.rel_path) && <span className="mat-dir">{relDir(d.rel_path)}</span>}
                        {/* 第 66 批 D4：预览原文、用于哪些任务、移除误放的材料 */}
                        {!d.quarantined_at && (
                          <span className="mat-acts">
                            <button className="btn-link" onClick={() => openPreview(d)}>预览</button>
                            {(usage.get(d.document_version_id)?.used_by.length ?? 0) > 0 ? (
                              <button className="btn-link" aria-expanded={usageOpen === d.document_version_id} onClick={() => setUsageOpen((x) => (x === d.document_version_id ? null : d.document_version_id))}>
                                用于 {usage.get(d.document_version_id)!.used_by.length} 次任务 {usageOpen === d.document_version_id ? "▴" : "▾"}
                              </button>
                            ) : (
                              <span className="mat-unused">{(usage.get(d.document_version_id)?.readable_by_unrestricted ?? 0) > 0 ? `${usage.get(d.document_version_id)!.readable_by_unrestricted} 次任务可读全部材料（含它）` : "还没有任务用过"}</span>
                            )}
                            {!locked && !matter.is_sample && (
                              <ConfirmButton
                                label="移除"
                                className="btn-link mat-remove"
                                confirmLabel="移除"
                                question={
                                  d.storage_mode === "mount"
                                    ? `解除对《${d.filename}》的引用：删除本产品保存的解析文字及据此提取的事实和审查意见，原文件不动，留审计记录。用过它的成果会标出待核对。`
                                    : `从本事项移除《${d.filename}》：删除本产品保存的副本与解析文字及据此提取的事实和审查意见，原文件不动，留审计记录。用过它的成果会标出待核对。`
                                }
                                onConfirm={() => removeDoc(d)}
                              />
                            )}
                          </span>
                        )}
                      </td>
                      <td>
                        {/* 材料用途（Y4 §5 D-4）：我方 / 对方 / 参考，写进任务的材料清单 */}
                        <RolePills
                          name={d.filename}
                          value={d.role}
                          disabled={locked}
                          onChange={(v) => {
                            void api
                              .setMaterialRole(d.document_version_id, v)
                              .then(reload)
                              .catch((err) => setMsg((err as Error).message));
                          }}
                        />
                      </td>
                      <td title={`${(Number(d.size_bytes ?? 0) / 1024).toFixed(1)} KB · 本机按文件名与开头文字判断，仅供参考`}>
                        {triage.get(d.document_version_id) ? (
                          <>
                            {triageText(triage.get(d.document_version_id)!)}
                            {!locked && !matter.is_sample && triageSuggestion(triage.get(d.document_version_id)!, matter) && (
                              <button className="btn-link mat-suggest" onClick={() => nav(`/start/${triageSuggestion(triage.get(d.document_version_id)!, matter)!.id}/${matterId}`)}>
                                {triageSuggestion(triage.get(d.document_version_id)!, matter)!.title}
                              </button>
                            )}
                          </>
                        ) : (
                          `${(Number(d.size_bytes ?? 0) / 1024).toFixed(1)} KB`
                        )}
                      </td>
                      <td>{d.quarantined_at ? <span className="tag tag-warn">{materialStateLabel(d)}</span> : parseFlagsText(d.quality_flags ?? [])}</td>
                      <td>
                        {review.get(d.document_version_id) ? (
                          <button className="btn-link" onClick={() => setWorkbench({ doc: d.document_version_id })}>
                            {review.get(d.document_version_id)!.total} 项
                            {/* 待处理数单独一行（V18 A10：曾整串不换行压到“时间”列上） */}
                            {review.get(d.document_version_id)!.open > 0 && <span className="mat-review-open">待处理 {review.get(d.document_version_id)!.open}</span>}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="nowrap" title={fmtTime(d.created_at)}>{fmtWhen(d.created_at)}</td>
                    </tr>
                    {usageOpen === d.document_version_id && usage.get(d.document_version_id) && (
                      <tr className="mat-usage-row">
                        <td colSpan={6}>
                          <ul className="mat-usage">
                            {usage.get(d.document_version_id)!.used_by.map((r) => (
                              <li key={r.run_id}>
                                <button className="btn-link" onClick={() => nav(`/run/${r.run_id}/${matterId}`)}>
                                  {r.title ? r.title : `${SCENARIO_LABELS[r.scenario] ?? r.scenario}${r.goal ? ` · ${String(r.goal).slice(0, 40)}` : ""}`}
                                </button>
                                <span className="muted"> · {RUN_STATUS_LABELS[r.status] ?? r.status} · {fmtWhen(r.created_at)}{r.artifact_count > 0 ? ` · 成果 ${r.artifact_count} 份` : ""}</span>
                              </li>
                            ))}
                          </ul>
                          {usage.get(d.document_version_id)!.readable_by_unrestricted > 0 && (
                            <p className="muted mat-usage-note">另有 {usage.get(d.document_version_id)!.readable_by_unrestricted} 次任务没有限定材料，也可以读到它。</p>
                          )}
                        </td>
                      </tr>
                    )}
                    </Fragment>
                    );
                    return (
                      <>
                        {current.map(row)}
                        {folded.length > 0 && (
                          <tr className="mat-fold-row">
                            <td colSpan={6}>
                              <button className="btn-link" aria-expanded={showOld} onClick={() => setShowOld((v) => !v)}>
                                旧版本与已移除的材料（{folded.length}）{showOld ? "▴" : "▾"}
                              </button>
                            </td>
                          </tr>
                        )}
                        {showOld && folded.map(row)}
                      </>
                    );
                  })()}
                </tbody>
              </table>
                  );
                }}
              </MaterialSearch>
            )}
            {matView === "list" && review.get(null) && (
              <p className="muted">
                另有 {review.get(null)!.total} 项审查意见未关联到具体合同：
                <button className="btn-link" onClick={() => setWorkbench({ doc: null })}>逐项处理</button>
              </p>
            )}
          </section>
        )}
        {tab === "runs" && (
          <section>
            {runs.length === 0 && <p className="muted">还没有 AI 记录。</p>}
            {runs.length > 0 && (
              <table className="data">
                <thead><tr><th>任务</th><th>状态</th><th>模式</th><th>发起</th></tr></thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.run_id} className="row-link" onClick={() => nav(`/run/${r.run_id}/${matterId}`)}>
                      <td>{r.title ? r.title : `${SCENARIO_LABELS[r.scenario] ?? r.scenario}${r.goal ? ` · ${String(r.goal).slice(0, 40)}` : ""}`}</td>
                      <td>{RUN_STATUS_LABELS[r.status] ?? r.status}</td>
                      <td>{r.mode ? (MODE_LABELS[r.mode as keyof typeof MODE_LABELS] ?? r.mode) : "—"}</td>
                      <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
        {tab === "board" && (
          <MatterBoard
            matter={matter}
            runs={runs}
            docs={docs}
            onChanged={reload}
            onGo={(t) => {
              // 待核清单的去处（v9.4 第 21 批）：事实标签、材料的表格审阅、审查工作台
              if ("tab" in t && t.tab === "facts") setTab("facts");
              else if ("tab" in t && t.tab === "materials") {
                setTab("materials");
                setMatView("table");
                setTableFocus(t.table_id);
              } else if ("workbench" in t) setWorkbench({ doc: t.workbench });
            }}
          />
        )}
        {tab === "deliverables" && <MatterDeliverables matterId={matterId} />}
        {tab === "facts" && <FactsPanel matterId={matterId} docs={docs} readOnly={locked} />}
        {tab === "parties" && <PartiesPanel matterId={matterId} onChanged={reload} readOnly={locked} />}
        {tab === "egress" && <MatterEgress matterId={matterId} />}
        {tab === "lifecycle" && <MatterLifecyclePanel matter={matter} onChanged={reload} />}
        {tab === "members" && (teamShared ? (
          <MatterMembersPanel key={shareMsg?.text ?? "members"} matter={matter} view={members} error={membersErr} onReload={() => setMembersTick((t) => t + 1)} canEnable={ws.features.teamAdmin} initialMsg={shareMsg} />
        ) : (
          <p className="muted">这个事项只有你：要和同事共享，点右上角“⋯ → 改为团队共享…”。</p>
        ))}
        {removingLocal && (
          <RemoveLocalCopyDialog
            matter={matter}
            onClose={() => setRemovingLocal(false)}
            onDone={() => {
              setRemovingLocal(false);
              notifyDataChanged();
              // 删除后 matters.get 为 purged：本页换成删除回执（mode = local_copy，写明负责人与同事那边保留）
              reload();
            }}
          />
        )}
        {sharing && (
          <AddColleaguesDialog
            mode="share"
            matter={matter}
            onClose={() => setSharing(false)}
            onDone={(text, tone) => {
              setSharing(false);
              // 第三轮实拍：改为团队共享后授权要重新确认——页上之前的“已记录客户授权：可以用 AI…”不再成立，清掉
              setMsg("");
              setShareMsg({ text, tone });
              setTab("members");
              reload();
              notifyDataChanged();
            }}
          />
        )}
      </div>
      {basisOpen && (
        <BasisDialog
          matter={matter}
          basis={basis}
          endpoint={matter.model_endpoint}
          onClose={() => setBasisOpen(false)}
          onSave={(b, rec) => {
            setBasisOpen(false);
            // 同意状态由内核按四项派生（不由界面直接改写——复核 S5-A09）；按依据记录时带上类型与出处（第 51 批），逐项编辑记为逐项
            void patch({ basis: b, basis_source: rec.kind, basis_ref: rec.ref.trim() },basisComplete(b) ? "已记录客户授权：可以用 AI 和联网查询" : "还有授权待确认（已记录）：本事项暂时只能用不联网的本机功能");
          }}
        />
      )}
      {sheet && <RunSheet pending={sheet} onClose={() => setSheet(null)} />}
      {/* 预览材料原文（第 66 批 D4）：本机解析出的文字，不联网、不发给 AI */}
      {preview && (
        <Modal title={preview.filename} subtitle="本机解析出的文字（只读预览，不发给 AI）" onClose={() => setPreview(null)} wide>
          {preview.error ? (
            <p className="banner banner-red" role="alert">{preview.error}</p>
          ) : preview.text === null ? (
            <WaitBlock title="正在读取…" />
          ) : preview.text.trim() ? (
            <div className="mat-preview">
              <SafePreview filename="预览.txt" text={preview.text} />
            </div>
          ) : (
            <p className="muted">这份材料没有可显示的文字（扫描件可能还没识别文字）。</p>
          )}
        </Modal>
      )}
    </main>
  );
}

/**
 * 记录客户授权（第 48 批；第 51 批与“开始前确认”同一个记录表单：依据类型 + 出处，敏感事项另勾单独同意，四项收在“逐项记录”）；
 * 已齐备时“调整”直接给四项编辑（撤回某一项、改成不适用等）。改动都有记录。
 */
function BasisDialog({ matter, basis, endpoint, onClose, onSave }: { matter: Matter; basis: MatterBasis; endpoint: string; onClose: () => void; onSave: (b: MatterBasis, rec: { kind: string; ref: string }) => void }) {
  // 第二轮复评 T12（41b）：待重新确认 / 待补记出处时，事项头“去重新确认 →”打开的是与开始前确认同一张记录卡（按事项范围列出数据去向），不是四项编辑
  const again = matter.basis_state === "reconfirm" || matter.basis_state === "needs_ref";
  const complete = basisComplete(basis) && !again;
  const [b, setB] = useState(basis);
  const [defaults, setDefaults] = useState<AiAuthorization | null>(null);
  const [record, setRecord] = useState<AuthRecord>(() => initialRecord(null, matter));
  const [touched, setTouched] = useState(false);
  // 已有出处时沿用（调整四项也要带上出处，D-225）；没有出处时按常用条款预填，律师看到并点确认
  const [adjustRef, setAdjustRef] = useState(matter.basis_ref ?? "");
  useEffect(() => {
    api
      .aiAuthorization(matter.matter_id)
      .then((a) => {
        setDefaults(a);
        if (!touched) setRecord(initialRecord(a, matter));
        if (!matter.basis_ref && a.engagement_terms && a.default_ref) setAdjustRef((v) => v || a.default_ref || "");
      })
      .catch(() => setDefaults(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [detail, setDetail] = useState<MatterBasis | null>(complete ? basis : null);
  const need = confirmNeeds(basis);
  // D-225：逐项记录、调整四项都须写出处
  const ready = complete ? detailReady(adjustRef) : detail ? detailReady(record.ref) : recordReady(record, need.sensitive);
  const scopeVersion = matter.subprocessors?.version ?? defaults?.subprocessors?.version;
  return (
    <Modal title={complete ? "客户授权" : again ? "重新确认客户授权" : "记录客户授权"} onClose={onClose} wide>
      {complete ? (
        <>
          <p className="muted">
            四项分别记录；任一项改为“待确认”后，本事项只能用不需要联网的本机功能。改动都有记录。
            {matter.basis_state === "needs_ref" ? " 这是早期记录，缺少出处，请补记一次。" : ""}
          </p>
          <BasisEditor basis={b} endpoint={endpoint} onChange={setB} />
          <label className="authz-ref">
            <span>出处</span>
            <input value={adjustRef} maxLength={BASIS_REF_MAX} placeholder="委托合同名称或编号、条款号；或客户书面同意的日期与方式" onChange={(e) => setAdjustRef(e.target.value)} aria-label="授权依据的出处" />
          </label>
        </>
      ) : (
        <AuthorizationRecord
          matterTitle={matter.title}
          clientName={matter.client_name}
          value={record}
          onChange={(v) => {
            setTouched(true);
            setRecord(v);
          }}
          sensitive={need.sensitive}
          reconfirm={matter.basis_state === "reconfirm"}
          reconfirmWhy={reconfirmReason(matter, scopeVersion)}
          needsRef={matter.basis_state === "needs_ref"}
          processors={matter.subprocessors ?? defaults?.subprocessors ?? null}
          dataFlows={matter.data_flows ?? defaults?.data_flows ?? null}
          team={matter.collab_scope === "team"}
          detail={detail}
          onDetail={setDetail}
          endpoint={endpoint}
          basis={basis}
        />
      )}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>取消</button>
        <button
          className="btn-primary"
          disabled={!ready}
          onClick={() =>
            complete
              ? onSave(b, { kind: detailSource(record, matter), ref: adjustRef })
              : detail
                ? onSave(detail, { kind: detailSource(record, matter), ref: record.ref })
                : onSave(basisAfterConfirm(basis, { general: true, sensitive: record.sensitive }), { kind: record.kind!, ref: record.ref })
          }
        >
          {complete ? "保存" : again ? "重新确认" : "记录授权"}
        </button>
      </div>
    </Modal>
  );
}

/** 被负责人移出的团队共享事项：只删这台电脑上的副本（第二轮复评 T13，内核 matters.remove_local_copy）。后果三条 + 输入事项名称确认。 */
function RemoveLocalCopyDialog({ matter, onClose, onDone }: { matter: Matter; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    setBusy(true);
    setErr("");
    try {
      await api.removeLocalCopy(matter.matter_id, title);
      onDone();
    } catch (e) {
      setErr(teamFaultText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`从我的电脑移除「${matter.title}」`} onClose={() => !busy && onClose()}>
      <ul className="relay-lines">
        {removeLocalCopyLines().map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <label className="field">
        <span>输入事项名称“{matter.title}”以确认</span>
        <input aria-label="输入事项名称以确认移除" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      </label>
      {err && (
        <div className="banner banner-red" role="alert">
          {err}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn-ghost" disabled={busy} autoFocus onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-danger-solid" disabled={busy || title !== matter.title} onClick={() => void go()}>
          {busy ? "正在移除…" : "从我的电脑移除"}
        </button>
      </div>
    </Modal>
  );
}

function MatterEgress({ matterId }: { matterId: string }) {
  const [records, setRecords] = useState<EgressRecord[] | null>(null);
  const [unresolved, setUnresolved] = useState<any[]>([]);
  useEffect(() => {
    api.egressRecords({ matterId }).then((r) => setRecords(r.records)).catch(() => setRecords([]));
    api.egressUnresolved(matterId).then((r) => setUnresolved(r.records)).catch(() => {});
  }, [matterId]);
  if (!records) return <p className="muted">载入中…</p>;
  return (
    <section>
      {unresolved.length > 0 && <div className="banner banner-orange">有 {unresolved.length} 条记录不确定是否已经发出（发送途中软件中断），请在下面逐条核实。</div>}
      {records.length === 0 && <p className="muted">本事项还没有发出过任何内容：原件与成果都在这台电脑上。</p>}
      {records.length > 0 && (
        <table className="data">
          <thead><tr><th>时间</th><th>去向</th><th>结果</th><th>字数</th><th>代号</th><th>说明</th></tr></thead>
          <tbody>
            {records.map((r) => {
              let note: any = {};
              try {
                note = JSON.parse(r.note ?? "{}");
              } catch {
                note = {};
              }
              return (
                <tr key={r.record_id}>
                  <td className="nowrap" title={fmtTime(r.created_at)}>{fmtWhen(r.created_at)}</td>
                  <td>{DEST_LABELS[r.destination_kind] ?? r.destination_kind}</td>
                  <td>{r.outcome === "blocked" ? "已拦截" : r.outcome === "failed" ? "失败" : r.outcome === "unknown" ? "结果不明" : "已发出"}</td>
                  <td>{r.chars.toLocaleString()}</td>
                  <td>{Object.values(r.pseudonym_counts ?? {}).reduce((a: number, b: any) => a + Number(b), 0)}</td>
                  <td>{note.reason ? reasonLabel(note.reason) : note.purpose === "search" ? "检索" : note.purpose === "fetch" ? "抓取" : note.purpose === "model" ? "推理" : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

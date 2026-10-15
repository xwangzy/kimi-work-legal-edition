/**
 * 任务输入框（第 03 篇 §4.1：输入框显示“当前事项 · 执行位置 · 运行模式”；`/` 法律方法、`@` 事项材料、`+` 导入）。
 */
import { useEffect, useRef, useState } from "react";
import { MATERIAL_ACCEPT, pickMaterials, type Matter, type MaterialFile, type RunPolicyView } from "../api.ts";
import { Icon } from "./Icons.tsx";
import { ModeSelector, type ModeChoice } from "./ModeSelector.tsx";
import { stanceLabel } from "../lib/labels.ts";

export interface MethodDef {
  scenario: string;
  label: string;
  desc: string;
  tier: "演示" | "Beta";
  needs?: string;
}

/** 方法库中已接入本机内核的方法（首页与方法库共用）。 */
export const METHODS: MethodDef[] = [
  { scenario: "a1.agent_task", label: "通用任务", desc: "开放任务：读写材料、数据处理与计算、子任务、联网检索（经出站闸门）；产物为草稿", tier: "Beta" },
  { scenario: "s1.contract_review", label: "审合同", desc: "DOCX 进，原生修订稿与审查意见书出；按立场与 Playbook", tier: "演示", needs: "一份 DOCX 合同" },
  { scenario: "s1b.draft_compare", label: "回稿比对", desc: "对方回稿只重审改动，标出静默改动", tier: "演示", needs: "基线稿与回稿各一份" },
  { scenario: "s2.case_file", label: "整理材料", desc: "证据目录、事实时间轴、争点—证据矩阵", tier: "演示", needs: "案卷材料" },
  { scenario: "s6.redaction", label: "对外脱敏", desc: "脱敏件与脱敏报告，全流程化名", tier: "演示", needs: "待脱敏文件" },
];

export interface ComposerValue {
  goal: string;
  scenario: string;
  documentIds: string[];
  choice: ModeChoice;
}

export function Composer(props: {
  matters?: Matter[];
  matterId: string | null;
  onMatterChange?: (id: string | null) => void;
  onNewMatter?: () => void;
  documents: { document_version_id: string; filename: string }[];
  policy: RunPolicyView | null | undefined;
  value: ComposerValue;
  onChange: (v: ComposerValue) => void;
  onImport: (files: FileList | MaterialFile[]) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
  /** 意图建议（UIUX P0-2）：根据描述建议一个业务场景，不自动切换。 */
  suggestion?: { title: string; gets: string; onUse: () => void; onDismiss: () => void } | null;
}) {
  const { value, onChange } = props;
  const [menu, setMenu] = useState<"method" | "material" | "matter" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const method = METHODS.find((m) => m.scenario === value.scenario) ?? METHODS[0]!;
  const matter = props.matters?.find((m) => m.matter_id === props.matterId) ?? null;
  const canSend = !props.busy && !!props.matterId && (value.goal.trim().length > 0 || value.scenario !== "a1.agent_task");
  return (
    <div className="composer" ref={boxRef}>
      <textarea
        placeholder={props.placeholder ?? "描述要处理的法律工作，例如：审查这份股权转让协议，我方为受让方"}
        value={value.goal}
        onChange={(e) => {
          const goal = e.target.value;
          onChange({ ...value, goal });
          if (goal.endsWith("/")) setMenu("method");
          else if (goal.endsWith("@")) setMenu("material");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) props.onSubmit();
        }}
      />
      {props.suggestion && (
        <div className="suggest-bar" role="status">
          <span className="suggest-text">
            这看起来是<b>「{props.suggestion.title}」</b>：会得到{props.suggestion.gets}。
          </span>
          <button className="btn-primary btn-sm" onClick={props.suggestion.onUse}>使用{props.suggestion.title}</button>
          <button className="btn-link" onClick={props.suggestion.onDismiss}>仍按我的描述处理</button>
        </div>
      )}
      {(value.scenario !== "a1.agent_task" || value.documentIds.length > 0) && (
        <div className="composer-chips">
          {value.scenario !== "a1.agent_task" && (
            <span className="chip chip-soft">
              方法：{method.label}
              <button className="chip-x" aria-label="移除方法" onClick={() => onChange({ ...value, scenario: "a1.agent_task" })}><Icon.x /></button>
            </span>
          )}
          {value.documentIds.length > 0 && (
            <span className="chip chip-soft">
              材料 {value.documentIds.length} 份
              <button className="chip-x" aria-label="清除材料" onClick={() => onChange({ ...value, documentIds: [] })}><Icon.x /></button>
            </span>
          )}
        </div>
      )}
      <div className="composer-bar">
        <button className="tool" title="法律方法" onClick={() => setMenu(menu === "method" ? null : "method")}><Icon.slash /> <span className="tool-label">方法</span></button>
        <button className="tool" title="事项材料" disabled={!props.matterId} onClick={() => setMenu(menu === "material" ? null : "material")}><Icon.at /> <span className="tool-label">材料</span></button>
        <button className="tool" title="导入文件" disabled={!props.matterId} onClick={() => void pickMaterials(fileRef.current, props.onImport)}><Icon.attach /> <span className="tool-label">导入</span></button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={MATERIAL_ACCEPT}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) props.onImport(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="spacer" />
        {props.matters ? (
          <button className="chip" onClick={() => setMenu(menu === "matter" ? null : "matter")} title="当前事项">
            <Icon.folder /> {matter ? matter.title : "选择事项"} <Icon.down />
          </button>
        ) : (
          <span className="chip chip-static" title="当前事项"><Icon.folder /> {props.matterId ? "本事项" : "未选择事项"}</span>
        )}
        {value.scenario === "a1.agent_task" ? (
          <ModeSelector policy={props.policy} value={value.choice} onChange={(choice) => onChange({ ...value, choice })} />
        ) : (
          // 确定性工作流按固定步骤运行，不适用运行模式（复核 S5-A07）
          <span className="chip chip-static" title="确定性工作流按固定步骤运行，不适用运行模式">确定性工作流</span>
        )}
        <button className="send" disabled={!canSend} onClick={props.onSubmit} aria-label="发送">
          <Icon.send />
        </button>
      </div>

      {menu === "method" && (
        <div className="popover composer-menu">
          <div className="menu-title">法律方法</div>
          {METHODS.map((m) => (
            <button
              key={m.scenario}
              className={`menu-item${m.scenario === value.scenario ? " selected" : ""}`}
              onClick={() => {
                onChange({ ...value, scenario: m.scenario, goal: value.goal.replace(/\/$/, "") });
                setMenu(null);
              }}
            >
              <span className="menu-label">
                {m.label} <span className={`tag ${m.tier === "Beta" ? "tag-beta" : "tag-demo"}`}>{m.tier}</span>
              </span>
              <span className="menu-desc">{m.desc}{m.needs ? `（需要：${m.needs}）` : ""}</span>
            </button>
          ))}
        </div>
      )}
      {menu === "material" && (
        <div className="popover composer-menu">
          <div className="menu-title">事项材料（原件只读；助手看到的是已替换代号的版本）</div>
          {props.documents.length === 0 && <div className="menu-empty">本事项还没有材料，先“导入”。</div>}
          {props.documents.map((d) => {
            const on = value.documentIds.includes(d.document_version_id);
            return (
              <button
                key={d.document_version_id}
                className={`menu-item${on ? " selected" : ""}`}
                onClick={() =>
                  onChange({
                    ...value,
                    goal: value.goal.replace(/@$/, ""),
                    documentIds: on ? value.documentIds.filter((x) => x !== d.document_version_id) : [...value.documentIds, d.document_version_id],
                  })
                }
              >
                <span className="menu-label">{on ? "✓ " : ""}{d.filename}</span>
              </button>
            );
          })}
        </div>
      )}
      {menu === "matter" && props.matters && (
        <div className="popover composer-menu">
          <div className="menu-title">事项</div>
          {props.matters.map((m) => (
            <button
              key={m.matter_id}
              className={`menu-item${m.matter_id === props.matterId ? " selected" : ""}`}
              onClick={() => {
                props.onMatterChange?.(m.matter_id);
                setMenu(null);
              }}
            >
              <span className="menu-label">{m.title}</span>
              <span className="menu-desc">{[m.client_name, m.counterparty].filter(Boolean).join(" / ") || stanceLabel(m.stance)}</span>
            </button>
          ))}
          <button
            className="menu-item menu-new"
            onClick={() => {
              props.onNewMatter?.();
              setMenu(null);
            }}
          >
            <span className="menu-label"><Icon.plus /> 新建事项</span>
          </button>
        </div>
      )}
    </div>
  );
}

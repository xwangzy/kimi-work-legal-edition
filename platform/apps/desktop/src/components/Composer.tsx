/**
 * 任务输入框（第 03 篇 §4.1：输入框显示“当前事项 · 执行位置 · 运行模式”；`/` 法律方法、`@` 事项材料、`+` 导入）。
 */
import { useEffect, useRef, useState } from "react";
import { MATERIAL_ACCEPT, pickMaterials, type Matter, type MaterialFile, type RunPolicyView } from "../api.ts";
import { Icon } from "./Icons.tsx";
import { ModeSelector, type ModeChoice } from "./ModeSelector.tsx";
import { clipTitle, SCENARIO_LABELS, stanceLabel } from "../lib/labels.ts";
import { LINE_LABELS, SCENARIOS, type BusinessLine, type ScenarioCard } from "../lib/scenarios.ts";

/** 发送快捷键的写法：macOS 写 ⌘ + Enter，其余写 Ctrl + Enter。 */
const SEND_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘ + Enter" : "Ctrl + Enter";

export interface ComposerValue {
  goal: string;
  scenario: string;
  documentIds: string[];
  choice: ModeChoice;
  /** 整理案卷的“已知争点”（B-5）：交给争点矩阵框架。 */
  issues?: string[];
}

export function Composer(props: {
  matters?: Matter[];
  matterId: string | null;
  onMatterChange?: (id: string | null) => void;
  /** 事项页内的输入框（没有 matters）：顶部行显示“本事项”与我方立场。 */
  stance?: string | null;
  onNewMatter?: () => void;
  documents: { document_version_id: string; filename: string }[];
  policy: RunPolicyView | null | undefined;
  value: ComposerValue;
  onChange: (v: ComposerValue) => void;
  onImport: (files: FileList | MaterialFile[]) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
  /**
   * “/ 方法”菜单选中一个业务场景（Z3 评审 IA-2、#8：菜单与首页场景卡同一份名单 lib/scenarios.ts）：
   * 打开该场景的开始面板。未提供时菜单只有“自由描述”。
   */
  onPickScenario?: (card: ScenarioCard) => void;
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
  const matter = props.matters?.find((m) => m.matter_id === props.matterId) ?? null;
  const canSend = !props.busy && !!props.matterId && (value.goal.trim().length > 0 || value.scenario !== "a1.agent_task");
  const blockedReason = props.busy ? "正在发起…" : !props.matterId ? "先选事项" : "先写任务目标";
  return (
    <div className="composer" ref={boxRef}>
      {/* 事项上下文行（Z3 #12、M-4）：发起前一眼看到在哪个事项下工作；底栏不再放事项胶囊 */}
      <div className="composer-context">
        {props.matters ? (
          <button className="ctx-matter" onClick={() => setMenu(menu === "matter" ? null : "matter")} title={matter ? matter.title : "选择事项"} aria-haspopup="listbox" aria-expanded={menu === "matter"}>
            <Icon.folder /> 事项：<span className="ctx-title">{matter ? clipTitle(matter.title) : "选择事项"}</span> <Icon.down />
          </button>
        ) : (
          <span className="ctx-matter ctx-static"><Icon.folder /> 事项：{props.matterId ? "本事项" : "未选择事项"}</span>
        )}
        <span className="spacer" />
        {(matter?.stance ?? props.stance) ? <span className="ctx-stance muted">我方：{stanceLabel(matter?.stance ?? props.stance)}</span> : null}
      </div>
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
              方法：{SCENARIO_LABELS[value.scenario] ?? "自由描述"}
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
        {/* 固定步骤的流程不适用运行模式（复核 S5-A07）；也不再显示研发用语胶囊（Z3 评审 3.1） */}
        {value.scenario === "a1.agent_task" && <ModeSelector policy={props.policy} value={value.choice} onChange={(choice) => onChange({ ...value, choice })} />}
        {/* 可以发送时提示快捷键（Z3 §8.2 #32）；不能发送时写原因（余项续复核 RC-B-15） */}
        <span className="send-hint muted" aria-live="polite">{canSend ? `${SEND_KEY} 发送` : blockedReason}</span>
        <button className="send" disabled={!canSend} onClick={props.onSubmit} aria-label={canSend ? "发送" : `发送（${blockedReason}）`} title={canSend ? `发送（${SEND_KEY}）` : blockedReason}>
          <Icon.send />
        </button>
      </div>

      {menu === "method" && (
        <div className="popover composer-menu">
          <div className="menu-title">法律方法（都在试用阶段，结果是草稿）</div>
          <button
            className={`menu-item${value.scenario === "a1.agent_task" ? " selected" : ""}`}
            onClick={() => {
              onChange({ ...value, scenario: "a1.agent_task", goal: value.goal.replace(/\/$/, "") });
              setMenu(null);
            }}
          >
            <span className="menu-label">自由描述</span>
            <span className="menu-desc">按你的描述读材料、计算、联网查资料；结果是草稿</span>
          </button>
          {props.onPickScenario &&
            (Object.keys(LINE_LABELS) as BusinessLine[]).map((l) => (
              <div key={l} role="group" aria-label={LINE_LABELS[l]}>
                <div className="menu-group">{LINE_LABELS[l]}</div>
                {SCENARIOS.filter((c) => c.line === l).map((c) => (
                  <button
                    key={c.id}
                    className="menu-item"
                    onClick={() => {
                      onChange({ ...value, goal: value.goal.replace(/\/$/, "") });
                      setMenu(null);
                      props.onPickScenario?.(c);
                    }}
                  >
                    <span className="menu-label">{c.title}</span>
                    <span className="menu-desc">给：{c.gives}　得：{c.gets.join("、")}</span>
                  </button>
                ))}
              </div>
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
        <div className="popover composer-menu composer-menu-top">
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

/**
 * 运行模式选择器（第 03 篇 §8.1、第 02 篇 §9.3）：手动 / 默认 / 自动 + “先出计划”；问答（只读）在模式切换处。
 * 只显示上层策略允许的档位（被禁止的不出现）；切到“自动”时显示本任务预算上限与将自动通过的跨边界动作。
 * 选择只是请求：实际模式由宿主按律所策略与渠道上限钳制（界面送来的模式参数不能越过上限）。
 */
import { useEffect, useRef, useState } from "react";
import type { Preauthorization, RunMode, RunPolicyView } from "../api.ts";
import { MODE_HINTS, MODE_LABELS, PREAUTH_LABELS } from "../lib/labels.ts";
import { Icon } from "./Icons.tsx";

export interface ModeChoice {
  mode: RunMode;
  planFirst: boolean;
  preauth: Preauthorization[];
}

export function defaultChoice(policy: RunPolicyView | null | undefined): ModeChoice {
  const allowed = policy?.allowed_modes ?? ["manual", "default"];
  const mode = policy && allowed.includes(policy.default_mode) ? policy.default_mode : allowed.includes("default") ? "default" : allowed[0] ?? "manual";
  return { mode, planFirst: policy?.plan_first_default ?? true, preauth: [] };
}

export function ModeSelector({ policy, value, onChange, allowChat = true }: { policy: RunPolicyView | null | undefined; value: ModeChoice; onChange: (v: ModeChoice) => void; allowChat?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const allowed = (policy?.allowed_modes ?? ["manual", "default"]).filter((m) => allowChat || m !== "chat");
  const order: RunMode[] = ["chat", "manual", "default", "auto"];
  return (
    <div className="mode-selector" ref={ref}>
      <button className="chip" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {MODE_LABELS[value.mode]}
        {value.mode !== "chat" && value.planFirst ? " · 先出计划" : ""}
        <Icon.down />
      </button>
      {open && (
        <div className="popover mode-popover" role="listbox">
          {order
            .filter((m) => allowed.includes(m))
            .map((m) => (
              <button
                key={m}
                role="option"
                aria-selected={value.mode === m}
                className={`mode-option${value.mode === m ? " selected" : ""}`}
                onClick={() => onChange({ ...value, mode: m, preauth: m === "auto" ? value.preauth : [] })}
              >
                <span className="mode-name">{MODE_LABELS[m]}</span>
                <span className="mode-hint">{MODE_HINTS[m]}</span>
              </button>
            ))}
          {value.mode !== "chat" && (
            <label className="mode-toggle">
              <input type="checkbox" checked={value.planFirst} onChange={(e) => onChange({ ...value, planFirst: e.target.checked })} />
              先出计划（计划经你确认后再执行）
            </label>
          )}
          {value.mode === "auto" && policy && (
            <div className="mode-auto">
              <div className="mode-auto-title">自动档：本任务预算上限</div>
              <div className="muted">工具调用 ≤ {policy.budget.max_tool_calls} 次 · 子任务 ≤ {policy.budget.max_subagents} 个；超出即停止（不询问）。产物只为草稿。</div>
              <div className="mode-auto-title">开始时预授权、将自动通过的跨边界动作</div>
              {policy.preauthorizations.length === 0 && <div className="muted">本事项的策略不允许预授权：跨边界动作仍逐项确认。</div>}
              {policy.preauthorizations.map((p) => (
                <label key={p} className="mode-toggle">
                  <input
                    type="checkbox"
                    checked={value.preauth.includes(p)}
                    onChange={(e) => onChange({ ...value, preauth: e.target.checked ? [...value.preauth, p] : value.preauth.filter((x) => x !== p) })}
                  />
                  {PREAUTH_LABELS[p] ?? p}
                </label>
              ))}
              <div className="muted">白名单站点抓取在默认档与自动档都自动放行；其余跨边界动作（新域名抓取、图像原样送模型、未预授权的含当事人检索等）仍会请你确认。</div>
            </div>
          )}
          <div className="mode-foot muted">没有“完全访问”档：执行域与出站闸门在任何档位都生效。</div>
        </div>
      )}
    </div>
  );
}

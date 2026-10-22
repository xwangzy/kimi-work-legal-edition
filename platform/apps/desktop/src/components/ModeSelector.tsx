/**
 * 运行模式选择器（第 03 篇 §8.1、第 02 篇 §9.3）：手动 / 默认 / 自动 + “先出计划”；问答（只读）在模式切换处。
 * 只显示上层策略允许的档位（被禁止的不出现）；切到“自动”时显示本任务预算上限与将自动通过的跨边界动作。
 * 选择只是请求：实际模式由宿主按律所策略与渠道上限钳制（界面送来的模式参数不能越过上限）。
 */
import { useEffect, useRef, useState } from "react";
import type { Preauthorization, RunMode, RunPolicyView } from "../api.ts";
import { PREAUTH_LABELS } from "../lib/labels.ts";
import { isOn, modeChipLabel, modeOptions } from "../lib/mode-options.ts";
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
        {modeChipLabel(value)}
        <Icon.down />
      </button>
      {open && (
        <div className="popover mode-popover" role="listbox">
          {modeOptions(order.filter((m) => allowed.includes(m))).map((o) => (
            <button
              key={o.key}
              role="option"
              aria-selected={isOn(o, value)}
              className={`mode-option${isOn(o, value) ? " selected" : ""}`}
              onClick={() => onChange({ ...value, mode: o.mode, planFirst: o.planFirst, preauth: o.mode === "auto" ? value.preauth : [] })}
            >
              <span className="mode-name">{o.label}</span>
              <span className="mode-hint">{o.hint}</span>
            </button>
          ))}
          {value.mode === "auto" && policy && (
            <div className="mode-auto">
              <div className="mode-auto-title">放手做：本任务的用量上限</div>
              <div className="muted">最多 {policy.budget.max_tool_calls} 步操作、{policy.budget.max_subagents} 个子任务；用完就停下（不再问你）。结果是草稿。</div>
              <div className="mode-auto-title">开始时就同意、之后不再逐条问的操作</div>
              {policy.preauthorizations.length === 0 && <div className="muted">本事项不能提前同意：联网和用到当事人信息的操作仍逐条问你。</div>}
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
              <div className="muted">打开官方网站不用问；打开其他网站、把图片原样发给 AI、带当事人名称检索，仍会先问你。</div>
            </div>
          )}
          <div className="mode-foot muted">任何档位下，AI 联网都要经过本应用的检查（该问你的一定会先问你），也不能读本事项以外的文件。</div>
        </div>
      )}
    </div>
  );
}

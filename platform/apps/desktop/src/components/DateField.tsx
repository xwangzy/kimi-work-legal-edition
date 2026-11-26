/**
 * 中文日期栏（第 71 批，区域 6）：文字框写“年-月-日”，失焦时规整为 YYYY-MM-DD；右侧日历按钮调系统日历（隐藏的原生日期框，
 * 只当选择器用，不显示它的“mm/dd/yyyy”）。写错时就地提示，不清空律师写的字。
 */
import { useEffect, useRef, useState } from "react";
import { cnDateLabel, DATE_PLACEHOLDER, normalizeDateInput } from "../lib/date-input.ts";
import { Icon } from "./Icons.tsx";

export function DateField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText(value);
    setBad(false);
  }, [value]);
  const commit = (raw: string) => {
    const v = normalizeDateInput(raw);
    if (v === null) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(v);
    if (v !== value) onChange(v);
  };
  const shown = !bad && value ? cnDateLabel(value) : null;
  return (
    <span className="date-field">
      <span className="date-field-row">
        <input
          aria-label={label}
          type="text"
          inputMode="numeric"
          className={bad ? "is-invalid" : undefined}
          placeholder={placeholder && !/mm\/dd/i.test(placeholder) ? placeholder : DATE_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
          }}
        />
        <button
          type="button"
          className="icon-btn date-field-pick"
          aria-label={`用日历选${label}`}
          title="用日历选"
          onClick={() => {
            const el = picker.current as (HTMLInputElement & { showPicker?: () => void }) | null;
            if (!el) return;
            try {
              el.showPicker ? el.showPicker() : el.click();
            } catch {
              el.click();
            }
          }}
        >
          <Icon.calendar />
        </button>
        <input ref={picker} className="date-field-native" type="date" tabIndex={-1} aria-hidden="true" value={/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""} onChange={(e) => e.target.value && commit(e.target.value)} />
      </span>
      {bad && <span className="date-field-err">写成“年-月-日”，例如 2026-12-15</span>}
      {shown && <span className="date-field-cn muted">{shown}</span>}
    </span>
  );
}

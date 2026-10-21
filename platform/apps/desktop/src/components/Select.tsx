/**
 * 统一下拉框（Z3 #15、V-c）：替代浏览器原生下拉框——Electron 下原生下拉框的样式和 16px 圆角、黑白体系不一致。
 * 36px 高、8px 圆角、令牌边框；键盘可用（↑↓ Home End 回车 空格 Esc Tab、键入首字跳转），带 aria-expanded 与 listbox 语义。
 * 弹出层用 fixed 定位，放在表格或可滚动容器里也不会被裁掉；滚动或改窗口大小时收起。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icons.tsx";
import { displayLabel, initialActive, moveActive, typeahead, type SelectOption } from "../lib/select-nav.ts";

export type { SelectOption };

export function Select(p: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** 没有选中项时显示的文字（缺省“请选择”）。 */
  placeholder?: string;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const show = () => {
    if (p.disabled) return;
    setActive(initialActive(p.options, p.value));
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const pick = (i: number) => {
    const o = p.options[i];
    if (!o || o.disabled) return;
    close(true);
    if (o.value !== p.value) p.onChange(o.value);
  };

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    setPos({ left: r.left, top: room < 240 && r.top > room ? r.top - 4 : r.bottom + 4, width: r.width, up: room < 240 && r.top > room });
    list.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !trigger.current?.contains(t)) close(false);
    };
    const away = (e: Event) => {
      if (e.target instanceof Node && list.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive((a) => moveActive(p.options, a, e.key as "ArrowDown"));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key.length === 1) {
      setActive((a) => typeahead(p.options, a, e.key));
    }
  };

  const label = displayLabel(p.options, p.value, p.placeholder);
  const empty = !p.options.some((o) => o.value === p.value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`select-trigger${empty ? " is-placeholder" : ""}${p.className ? ` ${p.className}` : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={p["aria-label"] ? `${p["aria-label"]}：${label}` : undefined}
        title={p.title ?? label}
        disabled={p.disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        <span className="select-value">{label}</span>
        <Icon.down />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={p["aria-label"]}
          aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
          className={`select-list${pos?.up ? " up" : ""}`}
          style={pos ? { left: pos.left, top: pos.top, minWidth: pos.width } : { visibility: "hidden" }}
          onKeyDown={onListKey}
        >
          {p.options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-o${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === p.value}
              aria-disabled={o.disabled || undefined}
              className={`select-option${i === active ? " active" : ""}${o.value === p.value ? " selected" : ""}${o.disabled ? " disabled" : ""}`}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span>{o.label}</span>
              {o.hint ? <span className="select-hint">{o.hint}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 材料用途三枚胶囊（Z3 #15、D-4）：我方 / 对方 / 参考，点一下标上，再点一下取消；未标时三枚都是灰色。 */
export const MATERIAL_ROLES = [
  { value: "ours", label: "我方" },
  { value: "theirs", label: "对方" },
  { value: "reference", label: "参考" },
] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number]["value"];

export function RolePills(p: { value: MaterialRole | null | undefined; onChange: (v: MaterialRole | null) => void; disabled?: boolean; name: string }) {
  return (
    <span className="role-pills" role="radiogroup" aria-label={`${p.name} 的用途`}>
      {MATERIAL_ROLES.map((r) => {
        const on = p.value === r.value;
        return (
          <button
            key={r.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={r.label}
            className={`role-pill role-${r.value}${on ? " on" : ""}`}
            disabled={p.disabled}
            title={on ? `再点一下取消“${r.label}”` : `标为${r.label}材料`}
            onClick={() => p.onChange(on ? null : r.value)}
          >
            {r.label}
          </button>
        );
      })}
    </span>
  );
}

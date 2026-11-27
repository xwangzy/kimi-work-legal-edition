/**
 * 模型选择器（第 66 批 V40 P0-4）：首页任务输入框与问答共用。选项来自云端模型目录（内核 models.list：按套餐与路由算出的
 * 可用 / 不可用及原因），客户端不写死模型名；不可用的置灰并写原因，不能选。具体上游型号与密钥不下发、不显示。
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.tsx";
import { api, onKernelEvent, type ModelCatalogView, type ModelScope } from "../api.ts";

export interface ModelChoice {
  id: string;
  label: string;
  description?: string | null;
  available: boolean;
  /** 不可用的原因（律师语言）。 */
  reasonText?: string | null;
  isDefault?: boolean;
}

export function ModelPicker({ choices, value, onChange, title = "选择模型", foot, disabled }: {
  choices: ModelChoice[];
  value: string | null;
  onChange: (id: string) => void;
  title?: string;
  foot?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (choices.length === 0) return null;
  const cur = choices.find((c) => c.id === value && c.available) ?? choices.find((c) => c.isDefault && c.available) ?? choices.find((c) => c.available) ?? choices[0]!;
  // 只有一个可选项时只显示名称，不做假的下拉
  if (choices.length === 1) return <span className="model-label" title={cur.description ?? undefined}>{cur.label}</span>;
  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-label model-label-btn" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title={title}>
        {cur.label}
        <Icon.down />
      </button>
      {open && (
        <div className="popover model-popover mdl-pop" role="listbox" aria-label={title}>
          <div className="mdl-title">{title}</div>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === cur.id}
              aria-disabled={!c.available}
              disabled={!c.available}
              className={`mdl-option${c.id === cur.id ? " selected" : ""}${c.available ? "" : " off"}`}
              onClick={() => {
                onChange(c.id);
                setOpen(false);
              }}
            >
              <span className="mdl-main">
                <span className="mdl-name">
                  {c.label}
                  {c.isDefault && <span className="mdl-default">默认</span>}
                </span>
                {c.description && <span className="mdl-desc">{c.description}</span>}
                {!c.available && c.reasonText && <span className="mdl-off">{c.reasonText}</span>}
              </span>
              {c.id === cur.id && <span className="mdl-check" aria-hidden="true"><Icon.check /></span>}
            </button>
          ))}
          {foot && <div className="mdl-foot">{foot}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * 读模型目录（第 66 批）：先读内核手里的（可能是登录前的内置兜底），不是云端版本时马上要求刷新一次；
 * 窗口重新获得焦点时要求刷新（云端增改启停模型后，客户端不重新封装、不重启即可看到）。
 */
export function useModelCatalog(scope: ModelScope, enabled = true): [ModelCatalogView | null, (f: (v: ModelCatalogView | null) => ModelCatalogView | null) => void] {
  const [view, setView] = useState<ModelCatalogView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = (refresh: boolean) =>
      api
        .modelsList(scope, refresh ? { refresh: true } : {})
        .then((v) => {
          if (!live) return;
          setView(v);
          if (!refresh && v.source !== "cloud") void load(true);
        })
        .catch(() => live && !refresh && setView(null));
    void load(false);
    // 第 72 批（D-299 第 6 条）：窗口重新获得焦点时真刷新（向云端取，内核按 5 秒节流），云端改了模型目录客户端不重启也能看到
    const onFocus = () => void load(true);
    window.addEventListener("focus", onFocus);
    // 第 72 批（F5）：云端同步恢复后重读目录（内核同时已向云端重取）
    const offSync = onKernelEvent((m) => (m?.type === "cloud.synced" ? onFocus() : undefined));
    return () => {
      live = false;
      window.removeEventListener("focus", onFocus);
      offSync();
    };
  }, [scope, enabled]);
  return [view, setView];
}

/**
 * “放进哪个事项？”（第 72 批，D-301 / A2 §2.4 方案 A）：首页没选事项时按发送，在托盘的事项芯片处弹出。
 * - 上面列近期事项，点一个即归属并接着发起这条任务；
 * - 下面“新建事项「<按描述预填的名称>」”，展开是精简表单（名称、我方立场、处理方式三项），“建好并发起”；“更多设置”进完整弹窗；
 * - 零事项的新用户直接展开新建表单；
 * - Esc、点外面或“取消”关闭：任务描述原样留在输入框里，不发起。
 * 任务仍必须归属事项（材料、授权、处理方式、成果都挂在事项下，D-203 / D-216）——这里只是把“发送前的拦截提示”变成“发送时的一步确认”。
 */
import { useEffect, useState } from "react";
import type { Matter } from "../api.ts";
import { Icon } from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { LEVELS, quickCreateMatter, STANCE_GROUPS, STANCE_OPTIONS } from "./NewMatter.tsx";
import { stanceLabel } from "../lib/labels.ts";
import { suggestMatterTitle, suggestStance } from "../lib/matter-place.ts";

const STANCES = STANCE_GROUPS.flatMap(([, list]) => list);
const RECENT_LIMIT = 6;

export function MatterPlace({ matters, goal, onPlace, onMore, onCancel }: {
  matters: Matter[];
  goal: string;
  /** 选了已有事项或建好了新事项：归属并接着发起。 */
  onPlace: (m: Matter, created: boolean) => void;
  /** “更多设置”：带着已填的三项打开完整的新建事项弹窗（建好后同样接着发起）。 */
  onMore: (initial: { title: string; stance: string; confidentiality: string }) => void;
  onCancel: () => void;
}) {
  const [creating, setCreating] = useState(matters.length === 0);
  const [title, setTitle] = useState(() => suggestMatterTitle(goal, STANCES));
  const [stance, setStance] = useState(() => suggestStance(goal, STANCES) ?? "");
  const [level, setLevel] = useState("normal");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onCancel]);
  const create = async () => {
    if (!title.trim()) return setErr("请填写事项名称");
    if (!stance) return setErr("请选择我方立场");
    setBusy(true);
    setErr("");
    try {
      onPlace(await quickCreateMatter({ title, stance, confidentiality: level }), true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const levelHint = LEVELS.find((l) => l.v === level)?.hint;
  return (
    <div className="popover composer-menu place-pop" role="dialog" aria-label="放进哪个事项" data-place={creating ? "create" : "pick"}>
      <div className="place-head">
        <div className="place-title">{creating && matters.length === 0 ? "先建一个事项，再发起" : "放进哪个事项？"}</div>
        <div className="place-sub">材料、客户授权与成果都放在事项里{creating ? "；建好就接着发起这条任务" : "；选好就接着发起"}</div>
      </div>
      {!creating ? (
        <>
          <div className="place-list">
            {matters.slice(0, RECENT_LIMIT).map((m) => (
              <button key={m.matter_id} type="button" className="menu-item" onClick={() => onPlace(m, false)}>
                <span className="menu-label"><Icon.folder /> {m.title}</span>
                <span className="menu-desc">{[m.client_name, m.counterparty].filter(Boolean).join(" / ") || `我方：${stanceLabel(m.stance)}`}</span>
              </button>
            ))}
          </div>
          <button type="button" className="menu-item menu-new place-new" onClick={() => setCreating(true)}>
            <span className="menu-label"><Icon.plus /> 新建事项{title ? <span className="place-new-name">「{title}」</span> : null}</span>
          </button>
        </>
      ) : (
        <form
          className="place-form"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label className="place-field">
            <span className="place-k">事项名称</span>
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：股权转让协议审查（受让方）" maxLength={80} />
          </label>
          <div className="place-field">
            <span className="place-k">我方立场</span>
            <Select aria-label="我方立场" value={stance} placeholder="选择我方立场" onChange={setStance} options={STANCE_OPTIONS} />
          </div>
          <div className="place-field" role="group" aria-label="怎么处理">
            <span className="place-k">怎么处理</span>
            <div className="seg place-seg" role="radiogroup" aria-label="怎么处理">
              {LEVELS.map((l) => (
                <button key={l.v} type="button" role="radio" aria-checked={level === l.v} className={`seg-btn${level === l.v ? " on" : ""}`} onClick={() => setLevel(l.v)}>
                  {l.label}
                </button>
              ))}
            </div>
            {levelHint && <span className="place-hint">{levelHint}</span>}
          </div>
          {err && <div className="banner banner-red place-err" role="alert">{err}</div>}
          <div className="place-actions">
            <button type="button" className="btn-link" onClick={() => onMore({ title, stance, confidentiality: level })}>更多设置</button>
            <span className="spacer" />
            <button type="button" className="btn-ghost btn-sm" onClick={() => (matters.length > 0 ? setCreating(false) : onCancel())}>{matters.length > 0 ? "返回" : "取消"}</button>
            <button type="submit" className="btn-primary btn-sm" disabled={busy || !title.trim() || !stance}>{busy ? "正在建…" : "建好并发起"}</button>
          </div>
        </form>
      )}
    </div>
  );
}

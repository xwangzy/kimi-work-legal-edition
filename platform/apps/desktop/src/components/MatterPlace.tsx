/**
 * “放进哪个事项？”（第 72 批，D-301 / A2 §2.4 方案 A）：首页没选事项时按发送，在托盘的事项芯片处弹出。
 * - 上面列近期事项，点一个即归属并接着发起这条任务；
 * - 下面“新建事项「<按描述预填的名称>」”，展开是精简表单（名称、我方立场、处理方式三项），“建好并发起”；“更多设置”进完整弹窗；
 * - 零事项的新用户直接展开新建表单；
 * - Esc、点外面或“取消”关闭：任务描述原样留在输入框里，不发起。
 * 任务仍必须归属事项（材料、授权、处理方式、成果都挂在事项下，D-203 / D-216）——这里只是把“发送前的拦截提示”变成“发送时的一步确认”。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Matter } from "../api.ts";
import { Icon } from "./Icons.tsx";
import { Select } from "./Select.tsx";
import { LEVELS, quickCreateMatter, STANCE_GROUPS, STANCE_OPTIONS } from "./NewMatter.tsx";
import { stanceLabel } from "../lib/labels.ts";
import { suggestMatterTitle, suggestStance } from "../lib/matter-place.ts";

const STANCES = STANCE_GROUPS.flatMap(([, list]) => list);
const RECENT_LIMIT = 6;

/**
 * 第 72 批第二轮（设计评分 C2 必改 1、5）：浮层固定定位、永远完整落在视口里——事项芯片下方放得下就放下方，放不下翻到上方，
 * 上下都放不下（如 1440×900 且上手清单展开、页面已滚动）改为窗口居中；表单区限高内滚，底部“取消 / 建好并发起”吸底常驻；
 * 背后一层淡遮罩（点遮罩 = 取消），不露半截字。
 */
function usePlacement(anchor: HTMLElement | null | undefined, deps: unknown[]): [RefObject<HTMLDivElement | null>, CSSProperties] {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const m = 16;
      const w = Math.min(440, vw - 2 * m);
      const h = Math.min(el.scrollHeight, vh - 2 * m);
      const r = anchor?.getBoundingClientRect() ?? null;
      let left = r ? Math.min(Math.max(m, r.left), vw - w - m) : (vw - w) / 2;
      let top: number;
      if (r && vh - r.bottom - 8 - m >= h) top = r.bottom + 8;
      else if (r && r.top - 8 - m >= h) top = r.top - 8 - h;
      else {
        top = Math.max(m, (vh - h) / 2);
        left = (vw - w) / 2;
      }
      setPos({ top: Math.round(top), left: Math.round(left), width: w, maxHeight: vh - 2 * m });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, ...deps]);
  return [ref, pos];
}

export function MatterPlace({ matters, goal, onPlace, onMore, onCancel, anchor, suggestion }: {
  matters: Matter[];
  goal: string;
  /** 事项芯片（浮层锚点）。 */
  anchor?: HTMLElement | null;
  /** 输入框上方的方法建议（浮层打开时建议条收起，并进浮层里一行文字链接，同屏只留一个黑色主按钮）。 */
  suggestion?: { title: string; onUse: () => void } | null;
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
  const [ref, pos] = usePlacement(anchor, [creating, !!err]);
  return (
    <>
      <div className="place-mask" aria-hidden="true" onMouseDown={() => !busy && onCancel()} />
      <div ref={ref} style={pos} className="popover composer-menu place-pop" role="dialog" aria-modal="true" aria-label="放进哪个事项" data-place={creating ? "create" : "pick"}>
        <div className="place-head">
          <div className="place-title">{creating && matters.length === 0 ? "先建一个事项，再发起" : "放进哪个事项？"}</div>
          <div className="place-sub">材料、客户授权与成果都放在事项里{creating ? "；建好就接着发起这条任务" : "；选好就接着发起"}</div>
          {suggestion && (
            <div className="place-suggest">
              将按你的描述发起 ·{" "}
              <button type="button" className="btn-link" onClick={suggestion.onUse}>
                改用「{suggestion.title}」
              </button>
            </div>
          )}
        </div>
        {!creating ? (
          <>
            <div className="place-scroll place-list">
              {matters.slice(0, RECENT_LIMIT).map((m) => (
                <button key={m.matter_id} type="button" className="menu-item" onClick={() => onPlace(m, false)}>
                  <span className="menu-label"><Icon.folder /> {m.title}</span>
                  <span className="menu-desc">{[m.client_name, m.counterparty].filter(Boolean).join(" / ") || `我方：${stanceLabel(m.stance)}`}</span>
                </button>
              ))}
            </div>
            <div className="place-foot">
              <button type="button" className="menu-item menu-new place-new" onClick={() => setCreating(true)}>
                <span className="menu-label"><Icon.plus /> 新建事项{title ? <span className="place-new-name">「{title}」</span> : null}</span>
              </button>
            </div>
          </>
        ) : (
          <form
            className="place-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="place-scroll place-fields">
              <label className="place-field">
                <span className="place-k">事项名称</span>
                <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：股权转让协议审查（受让方）" maxLength={80} />
              </label>
              <div className="place-field">
                <span className="place-k">
                  我方立场<span className="place-req">必填</span>
                </span>
                <Select aria-label="我方立场（必填）" value={stance} placeholder="选择我方立场" onChange={setStance} options={STANCE_OPTIONS} />
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
            </div>
            <div className="place-actions">
              <button type="button" className="btn-link" onClick={() => onMore({ title, stance, confidentiality: level })}>更多设置</button>
              <span className="spacer" />
              {/* 第三轮：主按钮为什么不能点，就在按钮旁说一句 */}
              {!stance && !busy && <span className="place-need">选好我方立场后可发起</span>}
              <button type="button" className="btn-ghost btn-sm" onClick={() => (matters.length > 0 ? setCreating(false) : onCancel())}>{matters.length > 0 ? "返回" : "取消"}</button>
              <button type="submit" className="btn-primary btn-sm" disabled={busy || !title.trim() || !stance}>{busy ? "正在建…" : "建好并发起"}</button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}

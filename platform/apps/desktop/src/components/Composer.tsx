/**
 * 任务输入框（第 03 篇 §4.1：输入框显示“当前事项 · 执行位置 · 运行模式”；`/` 法律方法、`@` 事项材料、`+` 导入）。
 * 2026-11 对照 Kimi 首页重做版式：白色大圆角输入框（左下“+”导入、右下运行模式与圆形发送键）+ 下方灰色托盘（事项、方法、材料、我方立场，
 * 对应 Kimi 的“选择项目 / 插件”托盘）+ 可选的上方提示条（对应 Kimi 的额度提示条：首页放额度提示与“等你处理”）。
 * 第 47 批：运行模式移到“+”右边、右下显示模型（只读）、托盘没选事项时写“选择事项”。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, MATERIAL_ACCEPT, pickMaterials, type Matter, type MaterialFile, type MaterialImportResult, type RunPolicyView } from "../api.ts";
import { MaterialPicker } from "./MaterialPicker.tsx";
import { RolePills, type MaterialRole } from "./Select.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { Icon } from "./Icons.tsx";
import { ModeSelector, type ModeChoice } from "./ModeSelector.tsx";
import { clipTitle, SCENARIO_LABELS, stanceLabel } from "../lib/labels.ts";
import { getsPlain, LINE_LABELS, SCENARIOS, type BusinessLine, type ScenarioCard } from "../lib/scenarios.ts";
import "../styles-composer.css";

import { ComposerFrame, SendButton, sendOnEnter } from "./ComposerFrame.tsx";
import { MatterPlace } from "./MatterPlace.tsx";
import { MatterMarkBadge } from "./TeamMatter.tsx";
import { useWorkspace } from "./WorkspaceSwitch.tsx";
import { markPrefix, matterMark } from "../lib/team-matters.ts";

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
  /** 新建事项（完整弹窗）。第 72 批：从“放进哪个事项”的“更多设置”进来时带 thenSubmit 与已填的三项，建好后接着发起。 */
  onNewMatter?: (opts?: { thenSubmit?: boolean; initial?: { title: string; stance: string; confidentiality: string; scope?: "personal" | "team"; members?: string[] } }) => void;
  /**
   * 第 72 批（D-301）：没选事项也能按发送——在事项芯片处问“放进哪个事项？”，选了已有事项或建好新事项即调用它（归属并接着发起）。
   * 不传时（事项页）沿用原来的“必须已有事项”。
   */
  onPlace?: (m: Matter, created: boolean) => void;
  documents: { document_version_id: string; filename: string }[];
  policy: RunPolicyView | null | undefined;
  value: ComposerValue;
  onChange: (v: ComposerValue) => void;
  onImport: (files: FileList | MaterialFile[] | File[]) => void;
  /** 第 66 批：弹层里逐份导入（与开始面板、事项页、追问同一个 MaterialPicker），返回 materials.import 的结果。 */
  importOne?: (file: MaterialFile) => Promise<MaterialImportResult>;
  /** 一批导入完：刷新材料列表。 */
  onImported?: () => void;
  /** 勾选 / 取消一份材料（函数式更新，批量导入时逐份自动勾上不丢）。 */
  onToggleDoc?: (documentVersionId: string, on: boolean) => void;
  /** 第 66 批：任务模型（来自云端模型目录；不传时只显示“K3”）。 */
  models?: ModelChoice[];
  model?: string | null;
  onModelChange?: (id: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  /** 忙时“不能发送”的原因（第 51 批）：导入材料时写“正在导入材料…”，不再一律写“正在发起…”。 */
  busyText?: string;
  placeholder?: string;
  /** 打开时把光标放进输入框（事项页点“发起任务”后展开）。 */
  autoFocus?: boolean;
  /**
   * “/ 方法”菜单选中一个业务场景（Z3 评审 IA-2、#8：菜单与首页场景卡同一份名单 lib/scenarios.ts）：
   * 打开该场景的开始面板。未提供时菜单只有“自由描述”。
   */
  onPickScenario?: (card: ScenarioCard) => void;
  /** 意图建议（UIUX P0-2）：根据描述建议一个业务场景，不自动切换。 */
  suggestion?: { title: string; gets: string; onUse: () => void; onDismiss: () => void } | null;
  /** 输入框上方的提示条（Kimi 首页同款：贴在输入框顶边的灰色条）；没有要提示的事时不传。 */
  notice?: ReactNode;
}) {
  const { value, onChange } = props;
  const [menu, setMenu] = useState<"method" | "material" | "matter" | "add" | "place" | null>(null);
  /** 材料弹层标题栏的“上传文件”：打开弹层里 MaterialPicker 的选择文件（进度与结果在弹层里显示）。 */
  const pickInPop = useRef<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 第 66 批（V40 P0-4）：拖到输入框上的文件；没选事项时先暂存，选好事项再存进去
  const [dragOver, setDragOver] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[] | null>(null);
  /** 弹层里刚改过的用途（保存失败即撤回）。 */
  const [roles, setRoles] = useState<Record<string, MaterialRole | null>>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  /** 托盘的事项芯片：“放进哪个事项”浮层的锚点。 */
  const chipRef = useRef<HTMLButtonElement>(null);
  // ⌘ / Ctrl + K（新建任务）：把光标放进输入框
  useEffect(() => {
    const focus = () => textRef.current?.focus();
    window.addEventListener("kwl:focus-composer", focus);
    return () => window.removeEventListener("kwl:focus-composer", focus);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const matter = props.matters?.find((m) => m.matter_id === props.matterId) ?? null;
  // 第 73 批（D-310）：团队共享事项在芯片与事项菜单里带同一个灰色记号（个人空间不出现）
  const wsKind = useWorkspace().kind;
  useEffect(() => {
    if (!props.matterId || !pendingFiles) return;
    props.onImport(pendingFiles);
    setPendingFiles(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.matterId, pendingFiles]);
  const pickFiles = () => void pickMaterials(fileRef.current, props.onImport);
  const takeDrop = (files: FileList) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    if (props.matterId) props.onImport(list);
    else {
      setPendingFiles(list);
      setMenu("material");
    }
  };
  // 第 72 批（D-301）：不再因为没选事项而禁用发送、也不在发送键旁写“先选事项”——首页按发送时在事项芯片处问一次归属
  const canPlace = !!props.onPlace && !!props.matters;
  const canSend = !props.busy && (!!props.matterId || canPlace) && (value.goal.trim().length > 0 || value.scenario !== "a1.agent_task");
  const blockedReason = props.busy ? (props.busyText ?? "正在发起…") : !props.matterId && !canPlace ? "先选事项" : "先写任务目标";
  const send = () => {
    if (!canSend) return;
    if (!props.matterId && canPlace) return setMenu("place");
    props.onSubmit();
  };
  return (
    <div
      className={`composer-shell${dragOver ? " drag-over" : ""}`}
      ref={boxRef}
      data-tour="composer"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        // 弹层里的材料组件已经接住了（它会 preventDefault）：外层不再导入一次
        if (e.defaultPrevented || !e.dataTransfer.files.length) return;
        e.preventDefault();
        takeDrop(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="composer-drop" aria-hidden="true">
          <Icon.attach /> {matter ? <>松手即存入「{clipTitle(matter.title)}」</> : "松手后选择要放进的事项"}
        </div>
      )}
      {props.notice && <div className="composer-notice">{props.notice}</div>}
      <ComposerFrame
        left={
          <>
            {/* Kimi 同款左下“+”：导入材料（Word、PDF、图片……）；方法与事项材料在下方托盘 */}
            {/* 第 67 批第四轮（独立评审 R3：“+ › 选用已有材料”与“@ 材料”是同一功能的两个入口）：一个材料面板、两种进入方式——
                “+”= 往本事项加文件：打开材料面板并直接弹出选择文件，进度与逐份结果就在面板里（看得到存进了哪个事项）；
                “@ 材料”= 选这次读哪些。没选事项时“+”先让律师选放进哪个事项 */}
            <button
              className={`tool tool-plus${menu === "material" ? " open" : ""}`}
              title={props.matterId ? `添加材料到「${matter?.title ?? "本事项"}」` : "添加材料（先选放进哪个事项）"}
              aria-label="添加材料"
              aria-haspopup="dialog"
              aria-expanded={menu === "material"}
              onClick={() => {
                setMenu("material");
                // 面板挂上、材料组件登记好打开方法之后再弹选择文件（仍在这次点击的用户激活时限内）
                if (props.matterId && props.importOne) setTimeout(() => pickInPop.current?.(), 60);
                else if (props.matterId) pickFiles();
              }}
            >
              <Icon.plus />
            </button>
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
            {/* 运行模式放在“+”右边（第 47 批，Kimi Work 输入框左下“默认”权限档位同位）；固定步骤的流程不适用运行模式（复核 S5-A07） */}
            {value.scenario === "a1.agent_task" && <ModeSelector policy={props.policy} value={value.choice} onChange={(choice) => onChange({ ...value, choice })} />}
          </>
        }
        right={
          <>
            {/* 模型（Kimi 输入框右下同位）：任务固定用 K3（子步骤用 K2.6），具体型号由律所的云端路由决定——只显示、不做假的下拉 */}
            {props.models && props.models.length > 0 && props.onModelChange ? (
              <ModelPicker title="任务模型" choices={props.models} value={props.model ?? null} onChange={props.onModelChange} foot="任务的主要步骤用所选模型，辅助步骤用 K2.6；按实际用量计入你的额度。" />
            ) : (
              <span className="model-label" title="任务由 Kimi K3 处理（辅助步骤用 K2.6）">K3</span>
            )}
          </>
        }
        // 发送键旁不再写字（第 72 批）：快捷键在悬停提示里；不能发送的原因写在读屏标签与悬停提示里
        send={<SendButton disabled={!canSend || menu === "place"} onSend={send} blockedReason={blockedReason} />}
      >
      <textarea
        ref={textRef}
        autoFocus={props.autoFocus}
        placeholder={props.placeholder ?? "描述要处理的法律工作，例如：审查这份股权转让协议，我方为受让方"}
        value={value.goal}
        onChange={(e) => {
          const goal = e.target.value;
          onChange({ ...value, goal });
          if (goal.endsWith("/")) setMenu("method");
          else if (goal.endsWith("@")) setMenu("material");
        }}
        // 回车发送、Shift + 回车换行（拍板第 23 项，与 Chat 统一）；中文输入法组字时回车不发送
        onKeyDown={sendOnEnter(send)}
      />
      {/* 第 72 批第二轮（C2 必改 3）：“放进哪个事项”打开时建议条收起（并进浮层一行文字链接），同屏只留一个黑色主按钮 */}
      {props.suggestion && menu !== "place" && (
        <div className="suggest-bar" role="status">
          <span className="suggest-text">
            这看起来是<b>「{props.suggestion.title}」</b>：会得到{props.suggestion.gets}。
          </span>
          <button className="btn-ghost btn-sm" onClick={props.suggestion.onUse}>使用{props.suggestion.title}</button>
          {/* 第 27 批走查：点完焦点回到输入框，回车照常能发起（原来焦点停在这个按钮上，快捷键失效） */}
          <button
            className="btn-link"
            onClick={() => {
              props.suggestion?.onDismiss();
              textRef.current?.focus();
            }}
          >
            仍按我的描述处理
          </button>
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
      </ComposerFrame>
      {/* 事项上下文（Z3 #12、M-4：发起前一眼看到在哪个事项下工作）放在输入框下方托盘（Kimi“选择项目”同位）；底栏不放事项胶囊 */}
      <div className="composer-context">
        {props.matters ? (
          <button ref={chipRef} className={`ctx-matter${matter ? "" : " ctx-empty"}`} onClick={() => setMenu(menu === "matter" || menu === "place" ? null : "matter")} title={matter ? matter.title : "选择事项"} aria-haspopup="listbox" aria-expanded={menu === "matter"}>
            {/* Kimi“选择项目”同位：没选时就写“选择事项”，选了写事项名 */}
            <Icon.folder /> {matter ? <span className="ctx-title">{clipTitle(matter.title)}</span> : "选择事项"}
            <MatterMarkBadge mark={matterMark(matter, wsKind)} /> <Icon.down />
          </button>
        ) : (
          <span className="ctx-matter ctx-static"><Icon.folder /> 事项：{props.matterId ? "本事项" : "未选择事项"}</span>
        )}
        <button className="tray-btn" title="法律方法（也可以在输入框里打 /）" onClick={() => setMenu(menu === "method" ? null : "method")} aria-haspopup="listbox" aria-expanded={menu === "method"}>
          <Icon.plug /> 方法
        </button>
        <button className={`tray-btn${value.documentIds.length > 0 ? " on" : ""}`} title="选用或添加本事项的材料（也可以在输入框里打 @）" onClick={() => setMenu(menu === "material" ? null : "material")} aria-haspopup="dialog" aria-expanded={menu === "material"}>
          <Icon.at /> 材料{props.matterId && props.documents.length > 0 ? <span className="tray-count">{value.documentIds.length > 0 ? `${value.documentIds.length}/${props.documents.length}` : props.documents.length}</span> : null}
        </button>
        <span className="spacer" />
        {(matter?.stance ?? props.stance) ? <span className="ctx-stance">我方：{stanceLabel(matter?.stance ?? props.stance)}</span> : null}
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
                    <span className="menu-desc">给：{c.gives}　得：{getsPlain(c).join("、")}</span>
                  </button>
                ))}
              </div>
            ))}
        </div>
      )}
      {menu === "material" && (
        <div className="popover composer-menu mat-pop" role="dialog" aria-label="事项材料">
          {!props.matterId ? (
            // 没选事项：先定放进哪个事项（文件必须有归属，D-203 事项即保密边界）
            <>
              <div className="mat-pop-head">
                <div className="mat-pop-title">{pendingFiles ? `${pendingFiles.length} 份文件放进哪个事项？` : "先选择要放进的事项"}</div>
                <div className="mat-pop-sub">材料按事项保存与处理，代号替换与客户授权都跟着事项走</div>
              </div>
              <div className="mat-pop-list">
                {(props.matters ?? []).map((m) => (
                  <button key={m.matter_id} className="menu-item" onClick={() => props.onMatterChange?.(m.matter_id)}>
                    <span className="menu-label"><Icon.folder /> {m.title}</span>
                    <span className="menu-desc">我方：{stanceLabel(m.stance)}</span>
                  </button>
                ))}
              </div>
              <button
                className="menu-item menu-new"
                onClick={() => {
                  props.onNewMatter?.();
                  setMenu(null);
                }}
              >
                <span className="menu-label"><Icon.plus /> {pendingFiles ? "用这些文件新建事项" : "新建事项"}</span>
              </button>
            </>
          ) : (
            <>
              <div className="mat-pop-head">
                <div className="mat-pop-title">
                  <span className="mat-pop-name"><Icon.folder /> <span className="mat-pop-name-text">{clipTitle(matter?.title ?? "本事项")}</span></span>
                  {props.importOne && (
                    <button type="button" className="btn-ghost btn-sm mat-pop-upload" onClick={() => pickInPop.current?.()}>
                      <Icon.upload /> 上传文件
                    </button>
                  )}
                </div>
                {/* 第 67 批：一行说清这次 AI 读哪些（读取范围），隐私说明放在底栏 */}
                <div className="mat-pop-sub">
                  {props.documents.length === 0 ? "还没有材料" : value.documentIds.length > 0 ? <>只读勾选的 <b>{value.documentIds.length}</b> 份（共 {props.documents.length} 份）</> : <>不勾选时，AI 可读全部 <b>{props.documents.length}</b> 份；勾选后只读勾选的</>}
                </div>
              </div>
              <div className="mat-pop-body">
                <MaterialPicker
                  matterTitle={matter?.title ?? "本事项"}
                  documents={props.documents}
                  selected={value.documentIds}
                  onToggle={(id, on) =>
                    props.onToggleDoc
                      ? props.onToggleDoc(id, on)
                      : onChange({ ...value, goal: value.goal.replace(/@$/, ""), documentIds: on ? [...value.documentIds, id] : value.documentIds.filter((x) => x !== id) })
                  }
                  {...(props.importOne ? { onImport: props.importOne } : {})}
                  {...(props.onImported ? { onImported: () => props.onImported?.() } : {})}
                  // 用途（我方 / 对方 / 参考）在这里也能直接改，与开始面板、事项页同一份数据
                  rowExtra={(d) => (
                    <RolePills
                      name={d.filename}
                      value={d.document_version_id in roles ? roles[d.document_version_id] : ((d as { role?: MaterialRole | null }).role ?? null)}
                      onChange={(v) => {
                        setRoles((r) => ({ ...r, [d.document_version_id]: v }));
                        void api.setMaterialRole(d.document_version_id, v).catch(() =>
                          setRoles((r) => {
                            const { [d.document_version_id]: _drop, ...rest } = r;
                            return rest;
                          }),
                        );
                      }}
                    />
                  )}
                  compact
                  dropZone="root"
                  openRef={pickInPop}
                />
              </div>
              <div className="mat-pop-foot">
                <span className="mat-pop-privacy"><Icon.lock /> 原件只读；发给 AI 前，姓名、证件号等先换成代号</span>
                {value.documentIds.length > 0 && (
                  <button className="btn-link" onClick={() => onChange({ ...value, documentIds: [] })}>改为可读全部</button>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {menu === "place" && props.matters && props.onPlace && (
        <MatterPlace
          matters={props.matters}
          goal={value.goal}
          anchor={chipRef.current}
          suggestion={
            props.suggestion
              ? {
                  title: props.suggestion.title,
                  onUse: () => {
                    setMenu(null);
                    props.suggestion?.onUse();
                  },
                }
              : null
          }
          onPlace={(m, created) => {
            setMenu(null);
            props.onPlace?.(m, created);
          }}
          onMore={(initial) => {
            setMenu(null);
            props.onNewMatter?.({ thenSubmit: true, initial });
          }}
          onCancel={() => {
            setMenu(null);
            textRef.current?.focus();
          }}
        />
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
              <span className="menu-desc">{markPrefix([m.client_name, m.counterparty].filter(Boolean).join(" / ") || stanceLabel(m.stance), matterMark(m, wsKind))}</span>
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

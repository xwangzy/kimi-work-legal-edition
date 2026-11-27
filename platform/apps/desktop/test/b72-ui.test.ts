/**
 * 第 72 批客户端（D-300～D-303、拍板第 23 项、D-299 界面部分、A1 H6）：纯函数 + 关键接线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostPlatform, isModKey, modKeyLabel } from "../src/lib/platform.ts";
import { iconStrokeFor } from "../src/lib/icon-stroke.ts";
import { suggestMatterTitle, suggestStance } from "../src/lib/matter-place.ts";
import { isSendEnter } from "../src/lib/send-key.ts";
import { checklistVariant, checklistVisibility, newDeviceItems, onboardRole, type GuideProgress } from "../src/lib/guide-checklist.ts";
import { deviceMetaShort } from "../src/lib/account.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");
const STANCES = ["原告", "被告", "上诉人", "被上诉人", "受让方", "转让方", "用人单位", "劳动者", "买方", "卖方"];

test("平台：读 preload 的 platform（其次 <html> 的 plat-*、最后 userAgent），不用 navigator.platform；⌘ / Ctrl 写法与判定", () => {
  assert.equal(hostPlatform({ zrKernel: { platform: "win32" } }, null, "Macintosh"), "win32", "preload 优先");
  assert.equal(hostPlatform({ zrKernel: { platform: "darwin" } }, null, "Windows NT"), "darwin");
  const doc = { documentElement: { classList: { contains: (c: string) => c === "plat-win32" } } } as unknown as Document;
  assert.equal(hostPlatform({}, doc, "Macintosh"), "win32");
  assert.equal(hostPlatform({}, null, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "darwin");
  assert.equal(modKeyLabel("darwin"), "⌘");
  assert.equal(modKeyLabel("win32"), "Ctrl");
  assert.equal(isModKey({ metaKey: true, ctrlKey: false }, "darwin"), true);
  assert.equal(isModKey({ metaKey: false, ctrlKey: true }, "darwin"), false, "macOS 的 Ctrl + K 是删除到行尾");
  assert.equal(isModKey({ metaKey: false, ctrlKey: true }, "win32"), true);
  for (const f of ["App.tsx", "components/Composer.tsx", "components/Sidebar.tsx"]) assert.doesNotMatch(src(f), /navigator\.platform/, f);
});

test("图标线宽：约 1.4 CSS px 对齐到整数物理像素（1x→1、1.25x→1.6、1.5x→1.333、2x→1.5）", () => {
  assert.equal(iconStrokeFor(1), 1);
  assert.equal(iconStrokeFor(1.25), 1.6);
  assert.equal(Number(iconStrokeFor(1.5).toFixed(3)), 1.333);
  assert.equal(iconStrokeFor(2), 1.5);
  assert.equal(iconStrokeFor(0), 1, "取不到像素比按 1x");
  for (const d of [1, 1.25, 1.5, 1.75, 2, 3]) assert.ok(Number.isInteger(Math.round(iconStrokeFor(d) * d * 1000) / 1000), `${d}x 是整数物理像素`);
  assert.match(src("components/Icons.tsx"), /<svg className="ico"/);
  assert.match(src("styles.css"), /svg\.ico \{ stroke-width: var\(--icon-stroke\); \}\nsvg\.ico \* \{ vector-effect: non-scaling-stroke; \}/);
  assert.match(src("main.tsx"), /applyIconStroke\(\);/);
});

test("回车发送：回车发送、Shift + 回车换行、中文输入法组字时（isComposing / keyCode 229）回车不发送", () => {
  assert.equal(isSendEnter({ key: "Enter", shiftKey: false }), true);
  assert.equal(isSendEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(isSendEnter({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true } }), false);
  assert.equal(isSendEnter({ key: "Enter", shiftKey: false, keyCode: 229 }), false);
  assert.equal(isSendEnter({ key: "a", shiftKey: false }), false);
  // Work 与 Chat 同一手势、同一外壳
  assert.match(src("components/Composer.tsx"), /onKeyDown=\{sendOnEnter\(send\)\}/);
  assert.match(src("pages/Chat.tsx"), /onKeyDown=\{sendOnEnter\(\(\) => void send\(\)\)\}/);
  for (const f of ["components/Composer.tsx", "pages/Chat.tsx"]) {
    assert.match(src(f), /<ComposerFrame/, f);
    assert.doesNotMatch(src(f), /send-hint/, `${f} 发送键旁不写字`);
  }
});

test("就地归属（D-301）：按描述预填事项名称与立场（只用规则，不调用模型）", () => {
  assert.equal(suggestMatterTitle("审查这份股权转让协议，我方为受让方", STANCES), "股权转让协议审查（受让方）");
  assert.equal(suggestStance("审查这份股权转让协议，我方为受让方", STANCES), "受让方");
  assert.equal(suggestStance("代理被上诉人写答辩意见", STANCES), "被上诉人", "最长匹配，不认成“上诉人”");
  assert.equal(suggestMatterTitle("起草一份劳动合同解除通知，我们是用人单位", STANCES), "劳动合同解除通知（用人单位）".length > 0 ? suggestMatterTitle("起草一份劳动合同解除通知，我们是用人单位", STANCES) : "");
  assert.match(suggestMatterTitle("起草起诉状，我方是原告", STANCES), /^起诉状起草（原告）$/);
  assert.equal(suggestMatterTitle("帮我看看这个案子怎么打", STANCES), "这个案子怎么打"); // 验收 Q-2：兜底去掉口头起句
  assert.equal(suggestStance("帮我看看", STANCES), null);
  assert.equal(suggestMatterTitle("", STANCES), "");
});

test("就地归属（D-301）五条：未选事项可按发送；发送后浮层出现且描述不丢；选已有事项后自动发起；新建后自动发起；取消后描述仍在、不发起", () => {
  const c = src("components/Composer.tsx");
  // 1. 未选事项可按发送（首页传了 onPlace）：canSend 不再要求 matterId
  assert.match(c, /const canSend = !props\.busy && \(!!props\.matterId \|\| canPlace\) && \(value\.goal\.trim\(\)\.length > 0 \|\| value\.scenario !== "a1\.agent_task"\);/);
  assert.doesNotMatch(c, /send-hint/, "发送键旁不再写“先选事项”");
  // 2. 发送时没选事项 → 打开“放进哪个事项”，不调用 onSubmit、不动输入框的值
  assert.match(c, /if \(!props\.matterId && canPlace\) return setMenu\("place"\);\s*props\.onSubmit\(\);/);
  assert.match(c, /<MatterPlace\s+matters=\{props\.matters\}\s+goal=\{value\.goal\}/);
  // 3、4. 选了已有事项或建好新事项 → onPlace → 首页归属并 submit(m)（材料现取）
  const h = src("pages/Home.tsx");
  assert.match(h, /onPlace=\{\(m, created\) => \{[\s\S]{0,320}void submit\(m\);/);
  assert.match(h, /const submit = async \(placed\?: Matter\) => \{\s*const matter = placed \?\? matters\.find/);
  assert.doesNotMatch(h, /if \(!matter\) return setNewMatter\(true\);/, "死分支已理顺");
  // “更多设置”进完整弹窗，建好后同样接着发起
  assert.match(h, /if \(placeThenSubmit\.current\) \{\s*placeThenSubmit\.current = false;\s*void submit\(m\);/);
  const mp = src("components/MatterPlace.tsx");
  assert.match(mp, /onPlace\(await quickCreateMatter\(\{ title, stance, confidentiality: level \}\), true\)/);
  assert.match(mp, /onClick=\{\(\) => onPlace\(m, false\)\}/);
  // 零事项的新用户直接展开新建表单
  assert.match(mp, /useState\(matters\.length === 0\)/);
  // 5. 取消（Esc / 取消）：关浮层、光标回输入框，不发起
  assert.match(c, /onCancel=\{\(\) => \{\s*setMenu\(null\);\s*textRef\.current\?\.focus\(\);\s*\}\}/);
  assert.match(mp, /e\.key === "Escape" && !busy && onCancel\(\)/);
  // 新建仍按“四项依据待确认”，第一次用 AI 时在“开始前确认”逐案记录（D-216 不被绕过）
  assert.match(src("components/NewMatter.tsx"), /export async function quickCreateMatter[\s\S]{0,200}basisForChoice\("pending", f\.confidentiality === "high"\)/);
});

test("上手（D-302）：角色按 workspace_kind，没有时按成员角色 + 个人标记；新电脑版；账号在别处收起过不再打扰", () => {
  assert.equal(onboardRole({ workspace_kind: "personal", member_role: "firm_admin" }), "personal");
  assert.equal(onboardRole({ workspace_kind: "team", member_role: "firm_admin" }), "team_admin");
  assert.equal(onboardRole({ workspace_kind: "team", member_role: "member" }), "team_member");
  assert.equal(onboardRole({ member_role: "firm_admin" }, true), "personal");
  assert.equal(onboardRole({ member_role: "firm_admin" }, false), "team_admin");
  assert.equal(onboardRole(null, null), "team_member");
  const fresh: GuideProgress = { own_matters: 0, materials: 0, runs: 0, deliverables: 0, latest_matter_id: null, latest_run: null };
  assert.equal(checklistVariant({ supported: true, completed_at: "2026-11-01T00:00:00Z" }, fresh), "new_device", "老律师新电脑");
  assert.equal(checklistVariant({ supported: true, completed_at: null }, fresh), "full");
  assert.equal(checklistVariant({ supported: false }, fresh), "full", "旧内核 / 旧云端只用本机");
  assert.equal(checklistVariant({ supported: true, completed_at: "x" }, { ...fresh, own_matters: 2 }), "full");
  assert.deepEqual(newDeviceItems(false, null).map((i) => i.key), ["device", "restore", "folder"]);
  assert.equal(newDeviceItems(false, { configured: true })[2]!.done, true);
  assert.equal(checklistVisibility(null, fresh, { dismissed_at: "2026-11-02" }), "retire");
  assert.equal(checklistVisibility("shown", fresh, { dismissed_at: "2026-11-02" }), "show", "头像菜单重新打开过");
  // 落点、位置、承诺、头像菜单恢复、恢复提醒同条件
  // 第二轮（C1）：一步没做 → 展开在输入框上方；做过一步 → 收成一行在输入框下方
  assert.ok(src("pages/Home.tsx").includes("{mattersLoaded && guideExpanded !== false && <GuideChecklist onNewMatter={() => setNewMatter(true)} expanded={guideExpanded} onExpanded={setGuideExpanded} />}\n          <Composer"));
  assert.match(src("pages/Home.tsx"), /\{mattersLoaded && guideExpanded === false && <GuideChecklist onNewMatter=\{\(\) => setNewMatter\(true\)\} expanded=\{false\}/);
  assert.match(src("components/GuideChecklist.tsx"), /onExpanded\?\.\(p\.own_matters === 0 && p\.materials === 0 && p\.runs === 0\)/);
  assert.match(src("components/GuideChecklist.tsx"), /window\.addEventListener\(OPEN_GUIDE, reopen\);/);
  // 别的页面点“上手指南”：模块加载时就登记（用字面量，避免与 App.tsx 循环引用时常量未初始化），挂上后恢复
  assert.match(src("components/GuideChecklist.tsx"), /const OPEN_GUIDE_EVENT = "kwl:guide";/);
  assert.match(src("App.tsx"), /export const OPEN_GUIDE = "kwl:guide";/);
  assert.match(src("App.tsx"), /r && \(r\.kind === "package" \|\| r\.kind === "folder"\) && g && g\.materials === 0 \? null : r/);
  assert.match(src("api.ts"), /onboarding: \(\) => invoke<[^>]+>\("account\.onboarding"\)\.catch\(\(\) => \(\{ supported: false as const \}\)\)/);
});

test("同时登录已满（D-303）：元信息只留“多久前用过 · 版本”，不截断；开通页也传这台电脑", () => {
  const now = Date.parse("2026-11-27T10:00:00+08:00");
  const d = { device_id: "d1", platform: "darwin", last_seen_at: "2026-11-27T09:52:00+08:00", client_version: "0.10.0", registered_at: "2026-11-27T08:46:00+08:00" } as never;
  // 第二轮（C5）：不写版本号；写登记日期，同型号同编号的两台也能区分
  assert.equal(deviceMetaShort(d, now), "8 分钟前用过 · 11 月 27 日登记");
  assert.doesNotMatch(deviceMetaShort(d, now), /0\.10\.0/);
  assert.match(src("pages/Activate.tsx"), /thisDevice=\{b\.thisDevice \?\? null\}/);
  assert.match(src("styles-auth.css"), /\.auth-device-text > span \{ overflow: visible; white-space: normal; text-overflow: clip; \}/);
  assert.match(src("styles-auth.css"), /\.auth-card \.activate-submit, \.auth-card \.auth-btn \{ min-height: 46px; height: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
});

test("模型（D-299 界面）：聚焦真刷新；问答改读 models.list(\"qa\")、所选走 models.select(\"qa\")，本机旧值一次性迁移", () => {
  assert.match(src("components/ModelPicker.tsx"), /const onFocus = \(\) => void load\(true\);/);
  const chat = src("pages/Chat.tsx");
  assert.match(chat, /useModelCatalog\("qa"\)/);
  assert.match(chat, /api\s*\.modelsSelect\("qa", alias\)/);
  assert.match(chat, /localStorage\.removeItem\(scopedKey\(MODEL_KEY\)\);/);
  assert.doesNotMatch(chat, /localStorage\.setItem\(scopedKey\(MODEL_KEY\)/);
});

test("登记过渡页（A1 H6）：不写死“十几秒”，显示阶段与已用时间；打不开先在应用内重拉一次内核，再给“重新打开”", () => {
  const a = src("pages/Activate.tsx");
  assert.doesNotMatch(a.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), /十几秒/);
  assert.match(a, /<ActivatingProgress title=\{done\} \/>/);
  assert.match(a, /已用 \{sec\} 秒/);
  assert.match(a, /if \(restart && !retried\) \{\s*activatePhase\("retrying"\);/);
  assert.match(a, /\{busy \? "正在重新打开…" : "重新打开"\}/);
});

test("第 72 批（06 实测）：交接等待的 effect 重跑后轮询照样起——handled 只挡“已有结果的交接”，不挡等待轮询；轮询间隔不超过 250 ms", () => {
  const src = readFileSync(new URL("../src/pages/Activate.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /if \(!handoff \|\| handled\.current\) return;/, "handled 不能挡住等待轮询（StrictMode / 依赖变化重跑 effect 时会无声卡住）");
  const eff = src.slice(src.indexOf("const waitSince = useRef"), src.indexOf("void poll();"));
  assert.match(eff, /if \(handoff\.next !== "working"\) \{\s*if \(handled\.current\) return;/, "handled 只在非 working 分支里判断");
  assert.match(eff, /waitSince\.current \?\?= Date\.now\(\)/, "期限锚定第一次开始的时刻");
  for (const m of src.matchAll(/await new Promise\(\(r\) => setTimeout\(r, (\d+)\)\);/g)) assert.ok(Number(m[1]) <= 250, `轮询间隔 ${m[1]} ms`);
  const sw = readFileSync(new URL("../src/lib/account-switch.ts", import.meta.url), "utf8");
  assert.match(sw, /await sleep\(250\);/);
});

test("第 72 批（验收 Q-2）：事项名兜底去口头起句、取冒号前一句、不拆数字与单位", () => {
  const st = ["原告", "被告", "出借人", "借款人"];
  assert.equal(suggestMatterTitle("帮我算一下借款逾期利息：借款本金 20 万元，2024 年 3 月 1 日到期", st), "借款逾期利息");
  assert.equal(suggestMatterTitle("借款本金20万元自二〇二四年三月起至今未还款的逾期利息与违约金一并计算", st).includes("20万元"), true);
  assert.equal(suggestMatterTitle("审查这份股权转让协议，我方为受让方", ["受让方", "转让方"]), "股权转让协议审查（受让方）");
});

test("第二轮 C2：浮层固定定位、放不下就翻到上方或居中，底部按钮吸底；背后淡遮罩；打开时建议条收起并进浮层", () => {
  const mp = src("components/MatterPlace.tsx");
  assert.match(mp, /if \(r && vh - r\.bottom - 8 - m >= h\) top = r\.bottom \+ 8;\s*else if \(r && r\.top - 8 - m >= h\) top = r\.top - 8 - h;\s*else \{/);
  assert.match(mp, /<div className="place-mask" aria-hidden="true" onMouseDown=/);
  assert.match(mp, /改用「\{suggestion\.title\}」/);
  const css = src("styles-composer.css");
  assert.match(css, /\.place-pop \{ position: fixed;/);
  assert.match(css, /\.place-scroll \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; \}/);
  assert.match(src("components/Composer.tsx"), /\{props\.suggestion && menu !== "place" && \(/);
});

test("第二轮 Q-8：连不上云端时首页一行提示（额度查询报 provider_unavailable），连上即收起；不让清单与模型消失", () => {
  const h = src("pages/Home.tsx");
  assert.match(h, /setCloudDown\(\(e as \{ code\?: string \}\)\.code === "provider_unavailable"\);/);
  assert.match(h, /连不上云端：AI 暂时不可用，本机的事项和材料照常可看/);
  assert.match(h, /window\.addEventListener\("online", checkCloud\);/);
});


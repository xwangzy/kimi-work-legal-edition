// 第 48 批：问答等待体验。推理型模型“深度思考”时先静默 1～3 分钟才出字：默认快速回答；深度思考时把阶段、已用时间、还在动说清楚。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chatWaitView, deepToggleTitle, fmtChars, fmtElapsed } from "../src/lib/chat-wait.ts";

const src = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("fmtElapsed / fmtChars", () => {
  assert.equal(fmtElapsed(0), "0 秒");
  assert.equal(fmtElapsed(999), "0 秒");
  assert.equal(fmtElapsed(8_400), "8 秒");
  assert.equal(fmtElapsed(60_000), "1 分钟");
  assert.equal(fmtElapsed(72_000), "1 分 12 秒");
  assert.equal(fmtElapsed(194_000), "3 分 14 秒");
  assert.equal(fmtElapsed(-5), "0 秒", "负数（时钟回拨）按 0");
  assert.equal(fmtChars(3200.9), "3,200 字");
  assert.equal(fmtChars(-1), "0 字");
});

test("快速回答：只说正在回答；超过 25 秒才补一句“比平时慢”；有进度条", () => {
  const a = chatWaitView({ deep: false, phase: "waiting", elapsedMs: 3_000, thoughtChars: 0 });
  assert.equal(a.title, "正在回答…");
  assert.equal(a.hint, null);
  assert.equal(a.bar, true);
  const b = chatWaitView({ deep: false, phase: "waiting", elapsedMs: 30_000, thoughtChars: 0 });
  assert.match(b.hint ?? "", /比平时慢/);
});

test("深度思考：先说通常要 1～3 分钟；之后说已思考多久（带思考量），超过 3 分钟说想得比较久；都不泄露思考内容", () => {
  const a = chatWaitView({ deep: true, phase: "thinking", elapsedMs: 4_000, thoughtChars: 0 });
  assert.equal(a.title, "正在深度思考…");
  assert.match(a.hint ?? "", /通常需要 1～3 分钟/);
  const b = chatWaitView({ deep: true, phase: "thinking", elapsedMs: 72_000, thoughtChars: 3_200 });
  assert.match(b.hint ?? "", /已思考 1 分 12 秒（思考量约 3,200 字）/);
  assert.match(b.hint ?? "", /快速回答/);
  const c = chatWaitView({ deep: true, phase: "thinking", elapsedMs: 200_000, thoughtChars: 15_900 });
  assert.match(c.hint ?? "", /想得比较久，已思考 3 分 20 秒/);
  // 没收到思考字数（旧内核或还没有进度）：不写思考量
  const d = chatWaitView({ deep: true, phase: "waiting", elapsedMs: 40_000, thoughtChars: 0 });
  assert.doesNotMatch(d.hint ?? "", /思考量/);
  assert.equal(d.bar, true);
});

test("开始撰写：只留一行“正在撰写回答…”，不放进度条与补充说明（不挡正文）", () => {
  for (const deep of [true, false]) {
    const v = chatWaitView({ deep, phase: "writing", elapsedMs: 150_000, thoughtChars: 6_000 });
    assert.equal(v.title, "正在撰写回答…");
    assert.equal(v.hint, null);
    assert.equal(v.bar, false);
  }
});

test("开关提示文字：写明两种模式与耗时", () => {
  assert.match(deepToggleTitle(false), /快速回答.*深度思考/);
  assert.match(deepToggleTitle(true), /深度思考.*1～3 分钟.*快速回答/);
  // 第 49 批：按模型如实说开关控制什么——K3 始终思考、快速只是推理强度 low；K2.6 快速是不思考
  assert.match(deepToggleTitle(false, "effort", "K3"), /K3 始终会先思考.*low/);
  assert.match(deepToggleTitle(true, "effort", "K3"), /K3.*max/);
  assert.match(deepToggleTitle(false, "toggle", "K2.6"), /K2\.6 不思考、直接回答/);
  assert.match(deepToggleTitle(true, "toggle", "K2.6"), /K2\.6 先思考再回答/);
  // 快速档收到思考进度（K3 low）时如实显示“简短思考中”
  assert.equal(chatWaitView({ deep: false, phase: "thinking", elapsedMs: 2000, thoughtChars: 50 }).title, "简短思考中…");
  assert.equal(chatWaitView({ deep: false, phase: "waiting", elapsedMs: 500, thoughtChars: 0 }).title, "正在回答…");
});

test("界面接线：Chat 页订阅 chat.progress、发送带 deep、开关记在本机；主进程与开发桥只转发阶段与字数", () => {
  const chat = src("../src/pages/Chat.tsx");
  assert.match(chat, /m\?\.type === "chat\.progress"/);
  assert.match(chat, /chatSendWithModel\([\s\S]{0,300}\bdeep \}\)/, "发送时带上 deep");
  assert.match(chat, /<ChatWait pending=\{pending\} now=\{now\} \/>/);
  assert.match(chat, /aria-pressed=\{deep\}/);
  assert.match(chat, /kwl\.chat\.deep/);
  // 等回答时不再只是一行静态“正在回答…”
  assert.doesNotMatch(chat, /<div className="msg-pending muted">正在回答…<\/div>/);
  for (const f of ["../electron/main.cjs", "../dev/bridge.ts"]) {
    const s = src(f);
    const i = s.indexOf('"chat.progress"');
    assert.ok(i > 0, `${f} 转发 chat.progress`);
    const near = s.slice(i, i + 900);
    assert.match(near, /thinking/);
    assert.match(near, /writing/);
    assert.match(near, /thought_chars/);
    assert.doesNotMatch(near, /\.text\b/, "不转发任何文字内容");
  }
  const css = src("../src/styles.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^}]*\.chat-wait-dots/s, "系统要求减少动效时动画静止");
});

/**
 * 配乐与音效合成器（零依赖，纯 Node）：读取 src/timeline.ts 与 src/cues.ts，生成与画面逐帧对齐的
 * public/audio/score.wav（48 kHz / 16-bit / 立体声）。
 *
 * 这是“节拍对齐的临时配乐（temp score）”：结构、速度（112.5 BPM，1 拍 = 16 帧）与切点已定，
 * 正式发布前可由作曲按同一节拍网格替换为授权音乐，音效可保留。
 *
 * 调性：D 小调 → F 大调。段落：
 *   0–3.5 小节   引子（低垫 + 稀疏电钢）          · 文字的分量
 *   3.5–6.5     分散（八分音符脉冲 + 十六分沙锤）   · 工具间切换
 *   6.5–8       汇聚（上行噪声 + 反向铺底 + 换气）
 *   8           落点（低频冲击 + F 大九和弦）       · 产品登场
 *   10–33       律动（Dm9–B♭maj9–Fmaj9–Cadd9）     · 产品演示，24 小节起抬升
 *   33–36       回落（只留铺底与电钢）              · 可信
 *   36–39       推进（上行）→ 39 主落点             · 主题 → 产品名
 *   41          次落点 → 尾声淡出                   · 联袂打造
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAR, BEAT, DURATION, FPS } from "../src/timeline.ts";
import { GLOBAL_CUES } from "../src/cues.ts";

const SR = 48000;
const LEN = Math.ceil((DURATION / FPS) * SR);
const here = dirname(fileURLToPath(import.meta.url));

// ── 总线 ──
const mk = () => [new Float32Array(LEN), new Float32Array(LEN)];
const DRY = mk(); // 鼓、贝斯、音效（不被压）
const DUCK = mk(); // 铺底、琶音（随底鼓轻微下压）
const SEND = mk(); // 混响发送

const sec = (frames) => frames / FPS;
const barT = (b) => sec(b * BAR);
const beatT = (b) => sec(b * BEAT);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 确定性噪声
let seed = 1234567;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

/** 写入：fn(t, i) 返回单声道样本；pan -1..1；send 为混响发送量。 */
function write(bus, start, dur, fn, { pan = 0, send = 0 } = {}) {
  const s0 = Math.max(0, Math.floor(start * SR));
  const s1 = Math.min(LEN, Math.floor((start + dur) * SR));
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = s0; i < s1; i++) {
    const v = fn((i - s0) / SR, i - s0);
    bus[0][i] += v * gl;
    bus[1][i] += v * gr;
    if (send) {
      SEND[0][i] += v * gl * send;
      SEND[1][i] += v * gr * send;
    }
  }
}

function env(t, dur, att, rel) {
  if (t < att) return t / att;
  if (t > dur - rel) return Math.max(0, (dur - t) / rel);
  return 1;
}

// ── 乐器 ──

/** 铺底：两组微失谐的加法合成（8 个泛音，亮度控制泛音衰减），慢速颤音。 */
function pad(notes, start, dur, amp, { att = 1.2, rel = 1.6, bright = 0.45, octave = 0, pan = 0 } = {}) {
  notes.forEach((n, vi) => {
    const f = mtof(n + octave * 12);
    const p = (vi / Math.max(1, notes.length - 1) - 0.5) * 0.7 + pan;
    const ph = new Float64Array(16);
    write(
      DUCK,
      start,
      dur + rel,
      (t) => {
        let s = 0;
        const vib = 1 + 0.0018 * Math.sin(2 * Math.PI * (0.23 + vi * 0.07) * t);
        for (let k = 1; k <= 8; k++) {
          const a = Math.pow(bright, k - 1) / k;
          for (let d = 0; d < 2; d++) {
            const det = d === 0 ? 0.9978 : 1.0022;
            const idx = (k - 1) * 2 + d;
            ph[idx] += (2 * Math.PI * f * k * det * vib) / SR;
            s += Math.sin(ph[idx]) * a;
          }
        }
        return s * 0.5 * amp * env(t, dur + rel, att, rel) / notes.length;
      },
      { pan: p, send: 0.55 },
    );
  });
}

/** 拨弦（Karplus-Strong）。 */
function pluck(note, start, amp, { pan = 0, decay = 0.996, dur = 1.4, send = 0.35 } = {}) {
  const f = mtof(note);
  const N = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) {
    lp = lp * 0.5 + noise() * 0.5;
    buf[i] = lp;
  }
  let idx = 0;
  write(
    DUCK,
    start,
    dur,
    (t) => {
      const a = buf[idx];
      const b = buf[(idx + 1) % N];
      buf[idx] = (a + b) * 0.5 * decay;
      idx = (idx + 1) % N;
      return a * amp * Math.min(1, t / 0.002);
    },
    { pan, send },
  );
}

/** 电钢：基频 + 少量泛音，指数衰减，带短促的“音叉”亮音。 */
function epiano(note, start, amp, { dur = 2.6, pan = 0, send = 0.5 } = {}) {
  const f = mtof(note);
  write(
    DUCK,
    start,
    dur,
    (t) => {
      const e = Math.exp(-t / 0.9) * Math.min(1, t / 0.004);
      const tine = Math.sin(2 * Math.PI * f * 7.1 * t) * Math.exp(-t / 0.05) * 0.18;
      return (Math.sin(2 * Math.PI * f * t) + 0.28 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t / 0.4) + tine) * e * amp;
    },
    { pan, send },
  );
}

const kicks = [];
/** 软底鼓：正弦下扫 + 轻微击头。 */
function kick(start, amp) {
  kicks.push(start);
  let ph = 0;
  write(DRY, start, 0.5, (t) => {
    const f = 46 + 78 * Math.exp(-t * 30);
    ph += (2 * Math.PI * f) / SR;
    const click = t < 0.004 ? noise() * 0.25 * (1 - t / 0.004) : 0;
    return (Math.sin(ph) * Math.exp(-t * 7.5) + click) * amp;
  });
}

/** 掌声 / 军鼓边击：带通噪声，三次微爆。 */
function clap(start, amp, pan = 0) {
  let l1 = 0, l2 = 0;
  write(
    DRY,
    start,
    0.3,
    (t) => {
      const n = noise();
      l1 += 0.35 * (n - l1);
      l2 += 0.06 * (l1 - l2);
      const bp = l1 - l2;
      const bursts = (t < 0.01 ? 1 : 0) + (t > 0.012 && t < 0.02 ? 0.8 : 0);
      return bp * amp * (Math.exp(-t * 22) + bursts * 0.6);
    },
    { pan, send: 0.3 },
  );
}

/** 沙锤 / 闭镲：高通噪声。 */
function hat(start, amp, { len = 0.05, pan = 0.25 } = {}) {
  let lp = 0;
  write(
    DRY,
    start,
    len + 0.02,
    (t) => {
      const n = noise();
      lp += 0.25 * (n - lp);
      return (n - lp) * amp * Math.exp(-t / (len * 0.35));
    },
    { pan, send: 0.08 },
  );
}

/** 贝斯：正弦 + 二次泛音，轻饱和。 */
function bass(note, start, dur, amp) {
  const f = mtof(note);
  write(DRY, start, dur, (t) => {
    const e = env(t, dur, 0.006, 0.05) * (0.75 + 0.25 * Math.exp(-t * 8));
    const s = Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t);
    return Math.tanh(s * 1.3) * e * amp;
  });
}

/** 状态变量滤波器（Chamberlin）。 */
function svf() {
  let low = 0, band = 0;
  return (x, fc, q = 0.7) => {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR);
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    return { low, band, high };
  };
}

/** 上行：噪声带通由低到高 + 正弦上滑，音量平方上升。 */
function riser(start, dur, amp) {
  const fl = svf();
  write(
    DRY,
    start,
    dur,
    (t) => {
      const p = t / dur;
      const { band } = fl(noise(), 300 + 7000 * p * p, 0.5);
      const tone = Math.sin(2 * Math.PI * (180 + 900 * p * p) * t) * 0.15;
      return (band * 0.8 + tone) * amp * p * p;
    },
    { send: 0.6 },
  );
}

/** 冲击：低频衰减正弦 + 低通噪声 + 次低频。 */
function impact(start, amp) {
  let ph = 0;
  const fl = svf();
  write(
    DRY,
    start,
    3.2,
    (t) => {
      const f = 38 + 34 * Math.exp(-t * 6);
      ph += (2 * Math.PI * f) / SR;
      const boom = Math.sin(ph) * Math.exp(-t * 1.4);
      const { low } = fl(noise(), 900 * Math.exp(-t * 3) + 120, 0.8);
      return (boom * 0.9 + low * 0.5 * Math.exp(-t * 2.5)) * amp;
    },
    { send: 0.5 },
  );
}

/** 反向铺底：指数上扬，在落点处干脆切断。 */
function reverseSwell(notes, start, dur, amp) {
  notes.forEach((n, vi) => {
    const f = mtof(n + 12);
    write(
      DUCK,
      start,
      dur,
      (t) => {
        const p = t / dur;
        const e = Math.pow(p, 3) * (p > 0.985 ? (1 - p) / 0.015 : 1);
        return (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.001 * t) + 0.15 * Math.sin(2 * Math.PI * f * 3 * t)) * e * amp / notes.length;
      },
      { pan: (vi / (notes.length - 1) - 0.5) * 0.8, send: 0.7 },
    );
  });
}

// ── 音效 ──
function whoosh(start, amp) {
  const fl = svf();
  const dur = 0.75;
  for (const side of [-1, 1]) {
    write(
      DRY,
      start - dur * 0.6,
      dur,
      (t) => {
        const p = t / dur;
        const { band } = fl(noise(), 400 + 5000 * Math.sin(Math.PI * p), 0.6);
        return band * amp * Math.pow(Math.sin(Math.PI * p), 2) * 0.5;
      },
      { pan: side * 0.6, send: 0.3 },
    );
  }
}
function click(start, amp = 0.22) {
  write(DRY, start, 0.03, (t) => (Math.sin(2 * Math.PI * 2300 * t) * 0.6 + noise() * 0.4) * Math.exp(-t * 260) * amp, { pan: 0.1, send: 0.12 });
}
function typeTick(start, i) {
  const pan = Math.sin(i * 1.7) * 0.25;
  let lp = 0;
  write(DRY, start, 0.025, (t) => {
    const n = noise();
    lp += 0.4 * (n - lp);
    return (n - lp) * Math.exp(-t * 400) * 0.07;
  }, { pan });
}
function bell(note, start, amp, pan = 0) {
  const f = mtof(note);
  write(DUCK, start, 1.6, (t) => (Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * t) * Math.exp(-t * 6)) * Math.exp(-t * 3.2) * Math.min(1, t / 0.002) * amp, { pan, send: 0.55 });
}
function woodTick(start, amp) {
  write(DRY, start, 0.06, (t) => Math.sin(2 * Math.PI * 1250 * t) * Math.exp(-t * 90) * amp, { pan: noise() * 0.6, send: 0.25 });
}

// ── 和声 ──
const CH = {
  Dm9: { n: [50, 53, 57, 60, 64], b: 38 },
  Bb9: { n: [46, 50, 53, 57, 60], b: 34 },
  F9: { n: [53, 57, 60, 64, 67], b: 41 },
  C9: { n: [48, 55, 60, 62, 64], b: 36 },
};
const CYCLE = ["Dm9", "Dm9", "Bb9", "Bb9", "F9", "F9", "C9", "C9"];
const chordAt = (bar) => CH[CYCLE[(((bar - 10) % 8) + 8) % 8]];

// ── 编曲 ──

// A 引子（0–3.5）
pad(CH.Dm9.n, 0, barT(3.5), 0.11, { att: 3, rel: 1.5, bright: 0.32, octave: -1 });
pad([38], 0, barT(6.5), 0.08, { att: 4, rel: 0.6, bright: 0.2 });
[[0.5, 69], [1.5, 65], [2.25, 64], [2.75, 62], [3.25, 57]].forEach(([b, n]) => epiano(n, barT(b), 0.16, { pan: (n - 63) / 20 }));

// B 分散（3.5–6.5）
pad(CH.Dm9.n, barT(3.5), barT(1.5), 0.09, { att: 0.8, rel: 0.8, bright: 0.4 });
pad(CH.Bb9.n, barT(5), barT(1.5), 0.1, { att: 0.6, rel: 0.6, bright: 0.45 });
for (let k = 0; k < 6 * 8 - 4; k++) {
  const t = barT(3.5) + (k * beatT(1)) / 2;
  if (t >= sec(488)) break;
  const p = k / 44;
  bass(k % 8 === 0 ? 38 : 38, t, beatT(0.45), 0.08 + 0.12 * p);
}
for (let k = 0; k < 12 * 4; k++) {
  const t = barT(3.5) + (k * beatT(1)) / 4;
  if (t >= sec(488)) break;
  hat(t, (0.018 + 0.05 * (k / 48)) * (k % 2 === 0 ? 1 : 0.6));
}
for (let k = 0; k < 12 * 4; k++) {
  const t = barT(3.5) + (k * beatT(1)) / 4;
  if (t >= sec(480)) break;
  const notes = (k < 24 ? CH.Dm9 : CH.Bb9).n;
  pluck(notes[Math.floor(Math.abs(noise()) * notes.length)] + 12, t, 0.04 + 0.05 * (k / 48), { pan: noise() * 0.7, dur: 0.8, decay: 0.993 });
}

// C 汇聚（6.5–8）
riser(sec(416), sec(96), 0.32);
reverseSwell(CH.F9.n, sec(452), sec(60), 0.18);

// D 落点（8）
impact(barT(8), 0.9);
pad(CH.F9.n, barT(8), barT(2), 0.12, { att: 0.04, rel: 1.4, bright: 0.5 });
pad(CH.F9.n, barT(8), barT(2), 0.04, { att: 0.5, rel: 1.4, bright: 0.3, octave: 1 });
[[8, 77], [8.5, 81], [9, 84], [9.5, 88]].forEach(([b, n], i) => bell(n, barT(b), 0.07, (i - 1.5) * 0.3));

// E 律动（10–33）
for (let b = 10; b < 33; b++) {
  const ch = chordAt(b);
  const lift = b >= 24 ? 1 : 0;
  if ((b - 10) % 2 === 0) {
    pad(ch.n, barT(b), barT(2), 0.075 + 0.02 * lift, { att: 0.25, rel: 0.5, bright: 0.42 });
    if (lift) pad(ch.n, barT(b), barT(2), 0.035, { att: 0.4, rel: 0.5, bright: 0.25, octave: 1 });
  }
  for (let q = 0; q < 4; q++) {
    const t = barT(b) + beatT(q);
    const four = b >= 17;
    if (b === 32 && q === 3) continue;
    if (q % 2 === 0 || four) kick(t, four ? 0.52 : 0.5);
    if (b >= 12 && q % 2 === 1) clap(t, 0.2 + 0.05 * lift);
  }
  for (let e = 0; e < 8; e++) {
    const t = barT(b) + (e * beatT(1)) / 2;
    hat(t, e % 2 === 1 ? 0.04 : 0.02);
    if (lift) hat(t + beatT(0.25), 0.015, { len: 0.03, pan: -0.25 });
    bass(e % 4 === 3 ? ch.b + 12 : ch.b, t, beatT(0.42), 0.17);
  }
  const pat = [0, 2, 4, 1, 3, 2, 4, 3];
  for (let s = 0; s < 16; s++) {
    const t = barT(b) + (s * beatT(1)) / 4;
    const n = ch.n[pat[s % 8] % ch.n.length] + 12;
    const a = b < 17 ? 0.045 : b < 24 ? 0.065 : 0.08;
    pluck(n, t, a * (s % 4 === 0 ? 1.2 : 0.85), { pan: Math.sin(s * 0.9) * 0.5, dur: 0.6, decay: 0.992 });
  }
}
riser(barT(23), barT(1), 0.18);
riser(barT(28.5), barT(0.5), 0.14);
riser(barT(32), barT(1), 0.2);

// F 回落（33–36）
pad(CH.Bb9.n, barT(33), barT(1.5), 0.085, { att: 0.3, rel: 0.8, bright: 0.35 });
pad(CH.F9.n, barT(34.5), barT(1.5), 0.085, { att: 0.5, rel: 0.8, bright: 0.35 });
[[33, CH.Bb9], [34, CH.Bb9], [35, CH.F9]].forEach(([b, ch]) => ch.n.forEach((n, i) => epiano(n + 12, barT(b) + i * 0.06, 0.06, { pan: (i - 2) * 0.2 })));
for (let e = 0; e < 3 * 8; e++) hat(barT(33) + (e * beatT(1)) / 2, e % 2 ? 0.018 : 0.008);

// G 推进（36–39）
pad(CH.Dm9.n, barT(36), barT(1.5), 0.09, { att: 0.6, rel: 0.5, bright: 0.4 });
pad(CH.Bb9.n, barT(37.5), barT(1.5), 0.11, { att: 0.8, rel: 0.2, bright: 0.5 });
[36, 37, 38].forEach((b) => kick(barT(b), 0.45));
[37, 37.5, 38, 38.25, 38.5, 38.75].forEach((b) => kick(barT(b), 0.3));
riser(sec(2400), sec(88), 0.3);

// H 主落点（39）
impact(barT(39), 1.0);
pad(CH.F9.n, barT(39), barT(2), 0.13, { att: 0.03, rel: 1.2, bright: 0.52 });
pad(CH.F9.n, barT(39), barT(2), 0.045, { att: 0.6, rel: 1.2, bright: 0.3, octave: 1 });
[[39, 84], [39.5, 81], [40, 77], [40.5, 79]].forEach(([b, n], i) => bell(n, barT(b), 0.08, (i - 1.5) * 0.25));

// I 联袂打造（41–45）
impact(barT(41), 0.55);
pad(CH.F9.n, barT(41), barT(2.6), 0.11, { att: 0.05, rel: 3.0, bright: 0.45 });
pad([41], barT(41), barT(2.6), 0.1, { att: 0.05, rel: 3.0, bright: 0.2 });
[[41, 72], [41.5, 77], [42, 81], [42.75, 84]].forEach(([b, n]) => epiano(n, barT(b), 0.12, { dur: 3.5 }));

// ── 音效 ──
let typeIdx = 0;
for (const c of GLOBAL_CUES) {
  const t = sec(c.f);
  if (c.type === "type") typeTick(t, typeIdx++);
  else if (c.type === "click") click(t);
  else if (c.type === "whoosh") whoosh(t, c.v ?? 0.5);
  else if (c.type === "pop") bell([81, 84, 88, 93][(c.v ?? 0) % 4], t, 0.09, 0.2);
  else if (c.type === "blip") bell([74, 77, 81][(c.v ?? 0) % 3], t, 0.06, -0.2);
  else if (c.type === "warn") { bell(58, t, 0.1); bell(57, t + 0.12, 0.08); }
  else if (c.type === "tick") woodTick(t, 0.06 * (c.v ?? 0.5));
}

// ── 侧链：铺底与琶音随底鼓轻压 ──
const duck = new Float32Array(LEN).fill(1);
for (const k of kicks) {
  const s0 = Math.floor(k * SR);
  for (let i = 0; i < SR * 0.35 && s0 + i < LEN; i++) duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.32 * Math.exp(-i / (SR * 0.09)));
}

// ── 混响（Freeverb 简化版：4 梳状 + 2 全通，左右错开） ──
function reverb(input, spread) {
  const out = new Float32Array(LEN);
  const combs = [1557, 1617, 1491, 1422].map((d) => Math.round(((d + spread) * SR) / 44100));
  const aps = [556, 441].map((d) => Math.round(((d + spread) * SR) / 44100));
  const cb = combs.map((n) => ({ buf: new Float32Array(n), i: 0, lp: 0 }));
  const ab = aps.map((n) => ({ buf: new Float32Array(n), i: 0 }));
  const fb = 0.86, damp = 0.25;
  for (let s = 0; s < LEN; s++) {
    const x = input[s] * 0.25;
    let y = 0;
    for (const c of cb) {
      const o = c.buf[c.i];
      c.lp = o * (1 - damp) + c.lp * damp;
      c.buf[c.i] = x + c.lp * fb;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of ab) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = o - y * 0.5;
    }
    out[s] = y;
  }
  return out;
}
const wetL = reverb(SEND[0], 0);
const wetR = reverb(SEND[1], 23);

// ── 总线混合 + 软限幅 + 归一化 ──
const mix = [new Float32Array(LEN), new Float32Array(LEN)];
let peak = 0;
for (let i = 0; i < LEN; i++) {
  for (let c = 0; c < 2; c++) {
    const v = DRY[c][i] + DUCK[c][i] * duck[i] + (c ? wetR[i] : wetL[i]) * 0.42;
    mix[c][i] = Math.tanh(v * 1.1);
    peak = Math.max(peak, Math.abs(mix[c][i]));
  }
}
const gain = 0.89 / peak;
// 首尾 20 ms 防爆音
const fade = Math.floor(SR * 0.02);

const data = Buffer.alloc(LEN * 4);
for (let i = 0; i < LEN; i++) {
  const g = gain * Math.min(1, i / fade, (LEN - 1 - i) / fade);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[0][i] * g)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mix[1][i] * g)) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
const out = join(here, "..", "public", "audio", "score.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`score.wav ${(LEN / SR).toFixed(2)} s · peak ${peak.toFixed(3)} · gain ${gain.toFixed(2)} · ${GLOBAL_CUES.length} 个音效提示点`);

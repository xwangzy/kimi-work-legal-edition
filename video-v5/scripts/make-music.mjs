/**
 * V5 配乐与音效合成器（零依赖、纯 Node；全部由程序合成，无采样、无第三方音乐素材，版权归片方）。
 * 读取 src/timeline.ts 与 src/beats.ts，生成与画面逐帧对齐的 public/audio/score.wav（48 kHz / 24-bit / 立体声）。
 * 72 BPM（1 拍 = 0.833 秒，1 小节 = 3.333 秒）。D 大调 / B 小调。
 *
 * 情绪曲线（与六幕一致）：
 *  时代    低频持续音 + 空气声 + 稀疏毛毡钢琴；后拉时弦乐铺底；蓝点出现时三音动机（A–D–E）；问句转 B 小调，反向渐强潜入
 *  痛点    钟摆般的低音脉冲（时间在走）→ 碎片窗口处加密、轻微不协和 → 骤停：寂静，只剩一个低音
 *  三问    文字流的细碎声；三个问题各一记低音钢琴（B、G、E 下行）；“？”的点变蓝时一声清亮的铃；渐强 → D 大调和弦绽开 + 动机
 *  一件事  八分音符钢琴琶音 + 轻柔心跳底鼓 + 低音弦，按 D–Bm–G–A 行进，逐站加一层；界面音效
 *  回答    收回到钢琴与铺底，脉冲保留；代号替换四声闪光，签发一声落定
 *  升华    台灯熄灭（开关声）→ 弦乐上扬 → 三个动词三个音 → 主题句全编制落点 → 品牌声音标识（A–D–E–A）→ 余音
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DURATION, FPS, SCENES } from "../src/timeline.ts";
import { CORPUS, NIGHT, TURN, HOMEB, ONETAKE, ANSWERS, DAWN, FINALE, TASK } from "../src/beats.ts";
import { CUT30, CUT30_STARTS, CUT30_DURATION } from "../src/cut30.ts";
const MODE = process.env.SCORE ?? "film";

const SR = 48000;
const LEN_S = (MODE === "cut30" ? CUT30_DURATION : DURATION) / FPS + 0.5;
const LEN = Math.ceil(LEN_S * SR);
const here = dirname(fileURLToPath(import.meta.url));
const mk = () => [new Float32Array(LEN), new Float32Array(LEN)];
const MUSIC = mk(); // 乐器（干）
const SFX = mk(); // 音效（干）
const SEND = mk(); // 混响发送
const BEAT = 60 / 72;
const BAR = BEAT * 4;
/** 场景内帧 → 秒。 */
const at = (k, local) => (SCENES[k].from + local) / FPS;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

let seed = 20261127;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};

function write(bus, start, dur, fn, { pan = 0, send = 0 } = {}) {
  const s0 = Math.max(0, Math.floor(start * SR));
  const s1 = Math.min(LEN, Math.floor((start + dur) * SR));
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = s0; i < s1; i++) {
    const v = fn((i - Math.floor(start * SR)) / SR, i);
    if (v === 0) continue;
    bus[0][i] += v * gl;
    bus[1][i] += v * gr;
    if (send) {
      SEND[0][i] += v * gl * send;
      SEND[1][i] += v * gr * send;
    }
  }
}
const env = (t, dur, a, r) => (t < a ? t / a : t > dur - r ? Math.max(0, (dur - t) / r) : 1);
/** 一阶低通（返回闭包）。 */
const lp1 = (fc) => {
  const a = Math.exp((-2 * Math.PI * fc) / SR);
  let y = 0;
  return (x) => (y = (1 - a) * x + a * y);
};
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

/* ───────── 乐器 ───────── */

/**
 * 毛毡钢琴：三根弦微失谐 + 非谐泛音（B 系数）+ 每个泛音独立衰减（高泛音更快）+ 两段衰减 + 毛毡低通 + 琴槌闷响。
 * vel 0..1：力度影响亮度与音量。
 */
function piano(note, start, vel = 0.5, { dur = 5, pan = 0, send = 0.5, felt = 0.55 } = {}) {
  const f0 = mtof(note);
  const B = 0.00008 * Math.pow(2, (note - 60) / 24);
  const P = Math.max(4, Math.min(16, Math.floor(9000 / f0)));
  const parts = [];
  for (let k = 1; k <= P; k++) {
    const fk = f0 * k * Math.sqrt(1 + B * k * k);
    if (fk > 12000) break;
    const bright = 0.35 + 0.65 * vel * (1 - felt * 0.6);
    const a = Math.pow(bright, k - 1) / Math.pow(k, 0.9);
    const d1 = (1.4 + 9 * Math.exp(-note / 30)) / (1 + 0.35 * (k - 1)); // 主衰减
    parts.push({ fk, a, d1, ph: [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28] });
  }
  const det = [0.9994, 1, 1.0007];
  const amp = 0.16 * (0.35 + 0.65 * vel) * Math.pow(220 / Math.max(110, f0), 0.18);
  const hammer = lp1(700 + 1500 * vel);
  const total = dur + 0.4;
  write(
    MUSIC,
    start,
    total,
    (t) => {
      let s = 0;
      const atk = Math.min(1, t / (0.004 + 0.006 * felt));
      for (const p of parts) {
        const e = Math.exp(-t / p.d1) * 0.82 + Math.exp(-t / (p.d1 * 3.2)) * 0.18;
        if (e < 1e-4) continue;
        for (let u = 0; u < 3; u++) s += Math.sin(2 * Math.PI * p.fk * det[u] * t + p.ph[u]) * p.a * e;
      }
      s /= 3;
      // 制音：dur 后 0.35 秒内收掉
      const rel = t > dur ? Math.max(0, 1 - (t - dur) / 0.35) : 1;
      const thump = t < 0.05 ? hammer(noise()) * (1 - t / 0.05) * 0.9 : 0;
      return (s * atk * rel + thump * 0.25) * amp;
    },
    { pan, send },
  );
}

/** 弦乐合奏：每个音 5 个声部（锯齿波加法近似，12 次泛音）失谐 + 颤音；亮度控制泛音；慢起慢收。 */
function strings(notes, start, dur, amp, { att = 2.2, rel = 2.4, bright = 0.6, pan = 0, swell = 0 } = {}) {
  notes.forEach((n, vi) => {
    const f = mtof(n);
    const p = (vi / Math.max(1, notes.length - 1) - 0.5) * 0.9 + pan;
    const voices = [-9, -4, 0, 5, 10].map((c, j) => ({ r: Math.pow(2, c / 1200), ph: new Float64Array(12).map(() => Math.random() * 6.28), vr: 4.6 + j * 0.37, vp: Math.random() * 6.28 }));
    const total = dur + rel;
    const P = Math.max(3, Math.min(12, Math.floor(7000 / f)));
    write(
      MUSIC,
      start,
      total,
      (t) => {
        let s = 0;
        const sw = swell ? 0.55 + 0.45 * Math.min(1, t / dur) : 1;
        for (const v of voices) {
          const vib = 1 + 0.0035 * Math.sin(2 * Math.PI * v.vr * t + v.vp) * Math.min(1, t / 1.2);
          for (let k = 1; k <= P; k++) {
            v.ph[k - 1] += (2 * Math.PI * f * k * v.r * vib) / SR;
            s += (Math.sin(v.ph[k - 1]) * Math.pow(bright, k - 1)) / k;
          }
        }
        return (s / voices.length) * amp * env(t, total, att, rel) * sw / notes.length;
      },
      { pan: p, send: 0.75 },
    );
  });
}

/** 低频持续音（正弦 + 极少泛音，缓慢起伏）。 */
function drone(notes, start, dur, amp, { att = 3, rel = 3 } = {}) {
  notes.forEach((n, vi) => {
    const f = mtof(n);
    write(
      MUSIC,
      start,
      dur,
      (t) => {
        const w = 1 + 0.08 * Math.sin(2 * Math.PI * (0.07 + vi * 0.03) * t);
        return (Math.sin(2 * Math.PI * f * t) + 0.12 * Math.sin(2 * Math.PI * f * 2 * t) + 0.04 * Math.sin(2 * Math.PI * f * 3 * t)) * amp * w * env(t, dur, att, rel) / notes.length;
      },
      { pan: vi % 2 ? 0.2 : -0.2, send: 0.35 },
    );
  });
}

/** 铃（清亮的金属泛音，衰减长）。 */
function bell(note, start, amp, pan = 0) {
  const f = mtof(note);
  const ratios = [1, 2.0, 2.76, 4.07, 5.4];
  const amps = [1, 0.4, 0.28, 0.14, 0.06];
  write(
    MUSIC,
    start,
    5,
    (t) => {
      let s = 0;
      for (let i = 0; i < ratios.length; i++) s += Math.sin(2 * Math.PI * f * ratios[i] * t) * amps[i] * Math.exp(-t * (0.9 + i * 0.9));
      return s * amp * Math.min(1, t / 0.002);
    },
    { pan, send: 0.8 },
  );
}

/** 心跳般的软底鼓。 */
function kick(start, amp) {
  let ph = 0;
  write(MUSIC, start, 0.6, (t) => {
    const f = 44 + 52 * Math.exp(-t * 28);
    ph += (2 * Math.PI * f) / SR;
    return Math.sin(ph) * Math.exp(-t * 6) * amp;
  });
}

/** 低音（正弦，轻饱和）。 */
function bass(note, start, dur, amp) {
  const f = mtof(note);
  write(MUSIC, start, dur, (t) => Math.tanh((Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(4 * Math.PI * f * t)) * 1.2) * amp * env(t, dur, 0.02, 0.4), { send: 0.1 });
}

/** 反向渐强（落点处切断）。 */
function reverseSwell(notes, start, dur, amp) {
  notes.forEach((n, vi) => {
    const f = mtof(n);
    write(
      MUSIC,
      start,
      dur,
      (t) => {
        const p = t / dur;
        const e = Math.pow(p, 2.6) * (p > 0.985 ? (1 - p) / 0.015 : 1);
        return (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t) + 0.12 * Math.sin(6 * Math.PI * f * t)) * e * amp / notes.length;
      },
      { pan: (vi / Math.max(1, notes.length - 1) - 0.5) * 0.8, send: 0.6 },
    );
  });
}

/* ───────── 音效 ───────── */

function air(start, dur, amp, { fc = 1400 } = {}) {
  const l = lp1(fc);
  const l2 = lp1(fc * 0.5);
  write(SFX, start, dur, (t) => (l(noise()) - l2(noise()) * 0.3) * amp * env(t, dur, 2, 2), { send: 0.05 });
}
function riser(start, dur, amp) {
  const fl = svf();
  write(SFX, start, dur, (t) => {
    const p = t / dur;
    const { band } = fl(noise(), 200 + 5000 * p * p, 0.6);
    return band * amp * p * p * (p > 0.98 ? (1 - p) / 0.02 : 1);
  }, { send: 0.6 });
}
function whoosh(start, amp, dur = 0.9) {
  const fl = svf();
  write(SFX, start, dur, (t) => {
    const p = t / dur;
    const { band } = fl(noise(), 300 + 2200 * Math.sin(Math.PI * p), 0.8);
    return band * amp * Math.sin(Math.PI * p) ** 2;
  }, { send: 0.4 });
}
function thump(start, amp) {
  let ph = 0;
  const l = lp1(300);
  write(SFX, start, 1.6, (t) => {
    const f = 40 + 30 * Math.exp(-t * 9);
    ph += (2 * Math.PI * f) / SR;
    return (Math.sin(ph) * Math.exp(-t * 2.6) + l(noise()) * 0.6 * Math.exp(-t * 12)) * amp;
  }, { send: 0.35 });
}
function click(start, amp = 0.2, pan = 0.1) {
  const l = lp1(4000);
  write(SFX, start, 0.05, (t) => (l(noise()) * Math.exp(-t * 260) + Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 400) * 0.4) * amp, { pan, send: 0.05 });
}
function keyTick(start, amp = 0.07) {
  const l = lp1(2600 + Math.random() * 1800);
  write(SFX, start, 0.04, (t) => l(noise()) * Math.exp(-t * 180) * amp, { pan: (Math.random() - 0.5) * 0.3, send: 0.03 });
}
function pop(start, amp = 0.12, f = 1100) {
  write(SFX, start, 0.18, (t) => Math.sin(2 * Math.PI * f * (1 + 0.4 * Math.exp(-t * 40)) * t) * Math.exp(-t * 26) * amp, { pan: (Math.random() - 0.5) * 0.6, send: 0.25 });
}
function glint(start, amp = 0.1, f = 2600) {
  write(SFX, start, 1.2, (t) => (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t)) * Math.exp(-t * 4.5) * amp * Math.min(1, t / 0.003), { pan: 0.15, send: 0.7 });
}
function paper(start, amp = 0.16) {
  const fl = svf();
  const dur = 0.55;
  write(SFX, start, dur, (t) => {
    const p = t / dur;
    const { band } = fl(noise(), 1800 + 2600 * p, 1.3);
    return band * amp * Math.sin(Math.PI * Math.min(1, p * 1.4)) ** 1.5;
  }, { pan: (Math.random() - 0.5) * 0.8, send: 0.2 });
}
function marker(start, amp = 0.08, dur = 0.55) {
  const fl = svf();
  write(SFX, start, dur, (t) => {
    const { band } = fl(noise(), 3200 + 400 * Math.sin(t * 30), 2);
    return band * amp * env(t, dur, 0.03, 0.08) * (0.7 + 0.3 * Math.sin(t * 47));
  }, { pan: 0.25, send: 0.1 });
}
function lampSwitch(start, amp = 0.3) {
  click(start, amp, -0.2);
  const l = lp1(900);
  write(SFX, start + 0.012, 0.12, (t) => l(noise()) * Math.exp(-t * 60) * amp * 0.6, { pan: -0.2, send: 0.2 });
}
function stamp(start, amp = 0.5) {
  thump(start, amp);
  const l = lp1(1800);
  write(SFX, start, 0.25, (t) => l(noise()) * Math.exp(-t * 30) * amp * 0.35, { send: 0.3 });
}

/* ───────── 和弦与动机 ───────── */
const CH = {
  D: [38, 50, 57, 62, 66, 69], // D2 D3 A3 D4 F#4 A4
  Dadd9: [38, 50, 57, 64, 66, 69],
  Bm: [35, 47, 54, 62, 66, 71],
  G: [31, 43, 50, 59, 62, 67],
  A: [33, 45, 52, 61, 64, 69],
  Em: [28, 40, 52, 59, 64, 67],
  Fs: [30, 42, 49, 58, 61, 66], // F#（A#）
  DFs: [30, 42, 50, 57, 62, 66], // D/F#
};
const MOTIF = [69, 74, 76]; // A4 D5 E5

/* ───────── 30 秒版：同一套乐器，按剪辑点单独编配 ───────── */
function scoreCut30() {
  const segT = (i, local) => (CUT30_STARTS[i] + (local - CUT30[i].a)) / FPS;
  const end = CUT30_DURATION / FPS;
  air(0, end, 0.02, { fc: 1000 });
  // 段一：光波与问句（B 小调）
  drone([38, 45], 0, segT(2, TURN.DOT_BLUE) + 0.3, 0.1, { att: 1.2, rel: 0.6 });
  strings([47, 54, 62, 66], 0.1, segT(1, CUT30[1].a) - 0.1, 0.2, { att: 1.2, rel: 0.4, bright: 0.55, swell: 1 });
  piano(71, segT(0, CORPUS.C4) + 0.05, 0.34, { dur: 3 });
  piano(69, segT(0, CORPUS.C4) + BEAT * 2, 0.28, { dur: 3 });
  piano(35, segT(0, CORPUS.C4) + 0.05, 0.3, { dur: 3, pan: -0.3 });
  // 段二：三问
  for (const [f, nt] of [[TURN.Q2, 31], [TURN.Q3, 28]]) {
    const t = segT(1, f);
    if (t < segT(1, CUT30[1].a) - 0.01) continue;
    piano(nt, t, 0.55, { dur: 2.2, felt: 0.5, pan: -0.15 });
    piano(nt + 12, t + 0.01, 0.4, { dur: 2.2, felt: 0.5, pan: 0.1 });
  }
  // 段三：蓝点 → 绽开 + 动机
  bell(93, segT(2, TURN.DOT_BLUE), 0.07, 0.15);
  const tm = segT(2, TURN.MARK);
  riser(segT(2, TURN.DOT_MOVE), tm - segT(2, TURN.DOT_MOVE), 0.06);
  reverseSwell([62, 66, 69, 74], segT(2, TURN.DOT_MOVE), tm - segT(2, TURN.DOT_MOVE), 0.14);
  strings(CH.Dadd9, tm, segT(4, CUT30[4].a) - tm + 0.8, 0.34, { att: 0.5, rel: 1.5, bright: 0.6 });
  [50, 57, 62, 66].forEach((nt, i) => piano(nt, tm + i * 0.012, 0.5, { dur: 3, pan: -0.3 + i * 0.2 }));
  MOTIF.forEach((nt, i) => piano(nt + 12, tm + BEAT * (i * 0.5), 0.4, { dur: 2.5, pan: 0.15 }));
  // 段四至七：一镜到底的律动
  const g0 = segT(4, CUT30[4].a);
  const g1 = segT(8, DAWN.THEME);
  const chords = [CH.D, CH.Bm, CH.G, CH.A];
  const pattern = [0, 2, 3, 4, 3, 5, 4, 3];
  for (let b = 0; g0 + b * BAR < g1; b++) {
    const c = chords[b % 4];
    const t = g0 + b * BAR;
    for (let k = 0; k < 8; k++) {
      const tt = t + k * (BAR / 8);
      if (tt >= g1 - 0.05) break;
      piano(c[pattern[k]] + 12, tt, 0.24 * (k % 2 ? 0.75 : 1), { dur: BAR / 3, pan: (k % 4) * 0.12 - 0.18, send: 0.45 });
    }
    strings(c.slice(1, 5), t, Math.min(BAR, g1 - t), 0.18 + b * 0.03, { att: 0.5, rel: 0.8, bright: 0.52 });
    bass(c[0] + 12, t, Math.min(BAR, g1 - t) * 0.95, 0.1);
    for (let k = 0; k < 4; k += 2) if (t + k * BEAT < g1 - 0.1) kick(t + k * BEAT, 0.22 + b * 0.02);
  }
  pop(segT(4, ONETAKE.T_HINT), 0.08, 1320);
  click(segT(4, ONETAKE.T_CLICK));
  click(segT(5, ONETAKE.C_PICK));
  click(segT(5, ONETAKE.C_OK));
  bell(86, segT(6, ONETAKE.T_LAND), 0.04, 0.1);
  glint(segT(6, ONETAKE.T_LAND) + 0.01, 0.035, 2900);
  piano(43, segT(7, ONETAKE.T_REJ) + 0.5, 0.42, { dur: 2, felt: 0.7, pan: -0.2 });
  // 段八：主题落点
  reverseSwell([62, 66, 69, 74], g1 - 1.2, 1.2, 0.12);
  strings(CH.Dadd9, g1, end - g1 + 0.5, 0.38, { att: 0.4, rel: 2, bright: 0.6 });
  drone([38], g1, end - g1 + 0.5, 0.14, { att: 0.5, rel: 1.5 });
  [38, 50, 57, 62, 66, 69].forEach((n, i) => piano(n, g1 + i * 0.015, 0.55, { dur: 5, pan: -0.4 + i * 0.16 }));
  [69, 74, 76, 81].forEach((n, i) => piano(n, g1 + BEAT * (1 + i), 0.42, { dur: 3.5, pan: 0.2 }));
  // 段九：落印与品牌声音标识
  const tS = segT(9, FINALE.STAMP);
  stamp(tS, 0.3);
  [38, 50, 57, 64, 66].forEach((n, i) => piano(n, tS + i * 0.012, 0.42, { dur: 5, pan: -0.3 + i * 0.15 }));
  MOTIF.forEach((n, i) => piano(n + 12, tS + BEAT * (1 + i * 0.75), 0.36, { dur: 3.5, pan: 0.15 }));
}

if (MODE === "cut30") scoreCut30();
else {
/* ───────── 第一幕 时代 ───────── */
{
  const t0 = at("corpus", 0);
  const t1 = at("night", 0);
  air(t0, t1 - t0 + 1, 0.028, { fc: 1100 });
  drone([38, 45], t0 + 0.2, at("corpus", CORPUS.DIVE_AT) - t0 + 1.5, 0.1, { att: 5, rel: 2.5 });
  piano(78, t0 + 1.2, 0.28, { dur: 5, pan: 0.2 });
  piano(74, at("corpus", CORPUS.C1) + 0.05, 0.3, { dur: 5, pan: -0.1 });
  piano(69, at("corpus", CORPUS.C1) + BEAT, 0.24, { dur: 5, pan: 0.1 });
  piano(76, t0 + 6.6, 0.26, { dur: 5 });
  // 后拉：弦乐铺底 Dmaj9
  strings([50, 57, 64, 66], at("corpus", CORPUS.MACRO_END), 9, 0.22, { att: 4, rel: 3, bright: 0.5, swell: 1 });
  piano(50, at("corpus", CORPUS.MACRO_END + 30), 0.3, { dur: 6, pan: -0.3 });
  piano(57, at("corpus", CORPUS.MACRO_END + 30) + 0.02, 0.26, { dur: 6, pan: -0.15 });
  piano(71, at("corpus", CORPUS.C2) + 0.1, 0.24, { dur: 4, pan: 0.2 });
  // 蓝点：铃 + 三音动机
  bell(86, at("corpus", CORPUS.DOT_AT), 0.05, 0.25);
  MOTIF.forEach((n, i) => piano(n + 12, at("corpus", CORPUS.DOT_AT) + 0.4 + i * BEAT, 0.34, { dur: 4, pan: 0.1 * i }));
  strings([43, 50, 59, 66], at("corpus", CORPUS.DOT_AT), 5.5, 0.2, { att: 2.5, rel: 2.5, bright: 0.55 });
  // 问句：B 小调，未解决
  strings([47, 54, 62, 66], at("corpus", CORPUS.C4), at("corpus", CORPUS.DIVE_AT + CORPUS.DIVE_DUR) - at("corpus", CORPUS.C4), 0.24, { att: 2, rel: 0.3, bright: 0.55, swell: 1 });
  piano(71, at("corpus", CORPUS.C4) + 0.05, 0.34, { dur: 4 });
  piano(69, at("corpus", CORPUS.C4) + BEAT * 2, 0.28, { dur: 4 });
  piano(35, at("corpus", CORPUS.C4) + 0.05, 0.3, { dur: 5, pan: -0.3 });
  // 潜入：反向渐强，在切点切断
  const dive = at("corpus", CORPUS.DIVE_AT);
  const cut = at("night", 0);
  reverseSwell([47, 54, 59, 62], dive - 0.4, cut - dive + 0.4, 0.2);
  riser(dive, cut - dive, 0.07);
  thump(cut, 0.38);
}

/* ───────── 第二幕 痛点 ───────── */
{
  const t0 = at("night", 0);
  const tE = at("night", NIGHT.E_AT);
  const tF = at("night", NIGHT.F_AT);
  air(t0, at("turn", 0) - t0 + 13, 0.032, { fc: 900 });
  // 钟摆：每拍一个低音，碎片段加密为八分
  for (let t = t0 + BEAT * 0.5, i = 0; t < tF - 0.02; i++) {
    const dense = t >= tE;
    piano(i % 2 ? 42 : 35, t, dense ? 0.3 : 0.24, { dur: 0.7, felt: 0.9, send: 0.25 });
    keyTick(t + 0.002, dense ? 0.05 : 0.035);
    t += dense ? BEAT / 2 : BEAT;
  }
  // 和声：Bm → G → Em → F#（台灯段），碎片段加入 C 的不协和
  const prog1 = [CH.Bm, CH.G, CH.Em, CH.Fs];
  prog1.forEach((c, i) => strings(c.slice(1, 5), t0 + i * BAR * 0.65, BAR * 0.8, 0.13, { att: 1.5, rel: 1.5, bright: 0.45 }));
  [59, 62, 66, 62].forEach((n, i) => piano(n, t0 + 1.2 + i * BEAT * 2, 0.26, { dur: 3, pan: 0.2 }));
  [55, 59, 62].forEach((n, i) => piano(n, t0 + 1.2 + (4 + i) * BEAT * 2, 0.24, { dur: 3, pan: 0.2 }));
  strings([47, 54, 60, 62, 66], tE, tF - tE, 0.17, { att: 1.5, rel: 0.05, bright: 0.62, swell: 1 });
  riser(tE + 1, tF - tE - 1, 0.04);
  // 纸、荧光笔、窗口、点击
  for (let i = 0; i < 6; i++) paper(at("night", NIGHT.PAPERS_AT + i * 34 + 10), 0.11);
  [120, 175, 230, 270, 310].forEach((f) => marker(at("night", f), 0.06));
  for (let i = 0; i < 10; i++) pop(at("night", NIGHT.E_AT + i * 20 + 4), 0.07, 900 + i * 60);
  for (let j = 0; j < 10; j++) click(at("night", NIGHT.E_JUMP + j * NIGHT.E_STEP), 0.12, (j % 2 ? 0.2 : -0.2));
  // 寂静：一个低音，一缕极轻的高泛音
  piano(35, tF + 0.35, 0.3, { dur: 6, felt: 0.8, pan: -0.2 });
  drone([78], at("night", NIGHT.B3), 7, 0.018, { att: 2.5, rel: 2.5 });
}

/* ───────── 三问 → 登场 ───────── */
{
  const n = Array.from("经审查，第七条约定的违约金标准可能过高。根据相关法律规定，约定的违约金过分高于造成的损失的，当事人可以请求予以适当减少。建议双方协商调整违约金比例，并完善付款条件等相关约定，以降低交易风险。").length;
  for (let i = 0; i < n; i += 1) keyTick(at("turn", TURN.STREAM) + i / TURN.CPS, 0.03);
  marker(at("turn", TURN.UNDERLINE), 0.05, 0.4);
  const qs = [[TURN.Q1, 35], [TURN.Q2, 31], [TURN.Q3, 28]];
  for (const [f, nt] of qs) {
    const t = at("turn", f);
    reverseSwell([nt + 24, nt + 31], t - 1.0, 1.0, 0.08);
    piano(nt, t, 0.55, { dur: 2.4, felt: 0.5, pan: -0.15 });
    piano(nt + 12, t + 0.01, 0.4, { dur: 2.4, felt: 0.5, pan: 0.1 });
  }
  // “？”的点变蓝：清亮一声（之前屏息约一秒，见混响母线的回避）
  bell(93, at("turn", TURN.DOT_BLUE), 0.07, 0.15);
  glint(at("turn", TURN.DOT_BLUE) + 0.02, 0.04, 3300);
  // 铺开：渐强 → D 大调绽开 + 动机
  const tm = at("turn", TURN.MARK);
  riser(at("turn", TURN.BLOOM), tm - at("turn", TURN.BLOOM), 0.07);
  reverseSwell([62, 66, 69, 74], at("turn", TURN.BLOOM), tm - at("turn", TURN.BLOOM), 0.16);
  strings(CH.Dadd9, tm, BAR * 3.2, 0.36, { att: 0.6, rel: 3.5, bright: 0.62 });
  drone([38, 50], tm, BAR * 3.5, 0.2, { att: 0.4, rel: 3 });
  [50, 57, 62, 66].forEach((nt, i) => piano(nt, tm + i * 0.012, 0.5, { dur: 6, pan: -0.3 + i * 0.2 }));
  MOTIF.forEach((nt, i) => piano(nt + 12, tm + BEAT * (i + 1), 0.42, { dur: 4.5, pan: 0.15 }));
  bell(81, tm + BEAT * 4, 0.035, 0.2);
}

/* ───────── 首页 + 一件事 ───────── */
{
  const tH = at("home", HOMEB.MATCH);
  whoosh(tH - 0.1, 0.05);
  const t0 = at("onetake", 0);
  const tEnd = at("answers", 0);
  // 琶音（八分）：首页 D、Bm，一镜到底按 D–Bm–G–A–D/F#–G–Bm–A–G–A 每小节一个和弦
  const arpStart = tH + BEAT;
  const chordsHome = [CH.D, CH.Bm];
  const chordsTake = [CH.D, CH.Bm, CH.G, CH.A, CH.DFs, CH.G, CH.Bm, CH.A, CH.G, CH.A];
  const pattern = [0, 2, 3, 4, 3, 5, 4, 3]; // 和弦内音的索引
  const stationAt = [ONETAKE.ST2, ONETAKE.ST3, ONETAKE.ST4].map((f) => at("onetake", f));
  const dimAt = at("onetake", ONETAKE.T_DIM);
  const arp = (c, start, bars, vel) => {
    for (let b = 0; b < bars; b++)
      for (let k = 0; k < 8; k++) {
        const t = start + b * BAR + k * (BAR / 8);
        if (t >= dimAt + 1.2 && t >= t0) return;
        const n = c[pattern[k]] + 12;
        piano(n, t, vel * (k % 2 ? 0.75 : 1) * (t > dimAt ? Math.max(0.15, 1 - (t - dimAt) / 2) : 1), { dur: BAR / 3, pan: (k % 4) * 0.12 - 0.18, send: 0.45 });
      }
  };
  chordsHome.forEach((c, i) => {
    arp(c, arpStart + i * BAR, 1, 0.2);
    strings(c.slice(1, 5), arpStart + i * BAR, BAR, 0.16, { att: 0.8, rel: 1.4, bright: 0.5 });
  });
  chordsTake.forEach((c, i) => {
    const t = t0 + i * BAR;
    if (t >= dimAt + 0.5) return;
    // 逐站加层：首页只有琶音；停下来问你 + 低音与心跳；工作台 + 高音弦；成果 + 铃
    const layer = stationAt.filter((s) => t >= s - 0.3).length;
    arp(c, t, 1, 0.19 + layer * 0.045);
    strings(c.slice(1, 5), t, BAR, 0.11 + layer * 0.055, { att: 0.6, rel: 1.2, bright: 0.48 + layer * 0.05 });
    if (layer >= 1 && t < dimAt) bass(c[0] + 12, t, BAR * 0.95, 0.08 + layer * 0.02);
    if (layer >= 2) strings([c[3] + 12, c[4] + 12, c[5] + 12], t, BAR, 0.05 + 0.03 * (layer - 2), { att: 1, rel: 1.4, bright: 0.56 });
    for (let b = 0; b < 4; b += 2) {
      const tk = t + b * BEAT;
      if (layer >= 1 && tk < dimAt) kick(tk, 0.16 + layer * 0.05);
    }
    if (layer >= 3 && t < dimAt) bell(c[4] + 24, t + BEAT * 2, 0.014, 0.3);
  });
  // 律师的判断：接受（暖色一声）与不采纳（低沉的一声），各自一记
  piano(74, at("onetake", ONETAKE.C_ACCEPT) + 0.03, 0.42, { dur: 2.5, pan: 0.2 });
  piano(43, at("onetake", ONETAKE.T_REJ) + 0.5, 0.42, { dur: 2.5, felt: 0.7, pan: -0.2 });
  strings([50, 57, 62, 66], dimAt, tEnd - dimAt + 1.5, 0.14, { att: 0.8, rel: 2, bright: 0.45 });
  // 界面音效
  const typed = Array.from(TASK).length;
  for (let i = 0; i < typed; i++) keyTick(at("onetake", ONETAKE.T_TYPE) + i / ONETAKE.CPS + (Math.random() - 0.5) * 0.02, 0.06);
  pop(at("onetake", ONETAKE.T_HINT), 0.08, 1320);
  click(at("onetake", ONETAKE.T_CLICK));
  [ONETAKE.ST2 - 70, ONETAKE.ST3 - 70, ONETAKE.ST4 - 60].forEach((f) => whoosh(at("onetake", f), 0.045, 1.4));
  click(at("onetake", ONETAKE.C_PICK));
  click(at("onetake", ONETAKE.C_OK));
  bell(86, at("onetake", ONETAKE.T_LAND), 0.04, 0.1);
  glint(at("onetake", ONETAKE.T_LAND) + 0.01, 0.035, 2900);
  click(at("onetake", ONETAKE.C_ACCEPT), 0.22);
  glint(at("onetake", ONETAKE.T_RED), 0.03, 2200);
  glint(at("onetake", ONETAKE.T_RED) + 0.12, 0.025, 2750);
}

/* ───────── 回答 ───────── */
{
  const t0 = at("answers", 0);
  const qs = [ANSWERS.A1, ANSWERS.A2, ANSWERS.A3].map((f) => at("answers", f));
  const chords = [CH.Bm, CH.G, CH.A];
  air(t0, at("dawn", 0) - t0 + 1, 0.026, { fc: 900 });
  qs.forEach((t, i) => {
    strings(chords[i].slice(1, 5), t, (ANSWERS.A2 / 60) + 0.3, 0.17, { att: 1.2, rel: 1.8, bright: 0.5 });
    piano(chords[i][0] + 12, t + 0.05, 0.42, { dur: 4, felt: 0.6, pan: -0.2 });
    [chords[i][3] + 12, chords[i][4] + 12, chords[i][5] + 12].forEach((n, k) => piano(n, t + BEAT * (2 + k), 0.24, { dur: 3, pan: 0.2 }));
    for (let b = 0; b < 4; b++) kick(t + b * BAR / 2 + BEAT, 0.12);
  });
  glint(at("answers", 226), 0.03, 2600);
  for (let k = 0; k < 4; k++) glint(at("answers", ANSWERS.A2 + [70, 92, 114, 136][k]), 0.035, 2300 + k * 260);
  whoosh(at("answers", ANSWERS.A2 + ANSWERS.FLOW - 10), 0.04, 1.2);
  click(at("answers", ANSWERS.A3 + 60), 0.18);
  click(at("answers", ANSWERS.A3 + ANSWERS.C_SIGN), 0.22);
  stamp(at("answers", ANSWERS.A3 + ANSWERS.C_SIGN) + 0.05, 0.22);
  piano(62, at("answers", ANSWERS.A3 + ANSWERS.C_SIGN) + 0.05, 0.4, { dur: 5 });
  bell(86, at("answers", ANSWERS.A3 + ANSWERS.SIGNER), 0.025, 0.2);
  piano(69, at("answers", ANSWERS.A3 + ANSWERS.C_SIGN) + 0.06, 0.32, { dur: 5 });
}

/* ───────── 升华与落版 ───────── */
{
  const t0 = at("dawn", 0);
  lampSwitch(at("dawn", DAWN.LAMP_OFF), 0.22);
  // 台灯下的房间底噪（约 −50 LUFS），避免熄灯前接近数字静音
  air(t0, at("dawn", DAWN.DAY) - t0 + 3, 0.02, { fc: 800 });
  drone([50], t0, at("dawn", DAWN.LAMP_OFF) - t0 + 0.6, 0.03, { att: 0.8, rel: 0.5 });
  // 晨光：弦乐从 D 慢慢上扬
  strings([50, 57, 62, 66], at("dawn", DAWN.DAY), 5.5, 0.2, { att: 3, rel: 2.5, bright: 0.52, swell: 1 });
  drone([38], at("dawn", DAWN.DAY), DURATION / FPS - at("dawn", DAWN.DAY) - 0.1, 0.14, { att: 4, rel: 4 });
  piano(74, at("dawn", DAWN.F1) + 0.1, 0.3, { dur: 4 });
  piano(69, at("dawn", DAWN.F1) + BEAT * 2, 0.26, { dur: 4 });
  // 三个动词：G、A、Bm → 三个上行音
  const verbs = [DAWN.F2 + 40, DAWN.F2 + 40 + DAWN.VERB, DAWN.F2 + 40 + DAWN.VERB * 2].map((f) => at("dawn", f));
  const vc = [CH.G, CH.A, CH.Bm];
  const vm = [74, 76, 78];
  verbs.forEach((t, i) => {
    piano(vm[i], t, 0.46, { dur: 4, pan: 0.1 });
    piano(vc[i][0] + 12, t, 0.3, { dur: 3, pan: -0.25 });
    strings(vc[i].slice(1, 5), t, BEAT * 2.2, 0.18 + i * 0.03, { att: 0.4, rel: 1.6, bright: 0.55 });
  });
  // 主题：全编制落点（克制）
  const tT = at("dawn", DAWN.THEME);
  reverseSwell([62, 66, 69, 74], tT - 1.4, 1.4, 0.12);
  strings(CH.Dadd9, tT, at("finale", FINALE.STAMP) - tT + 0.6, 0.4, { att: 0.5, rel: 2.5, bright: 0.6 });
  strings([74, 78, 81], tT, 6, 0.1, { att: 1.5, rel: 3, bright: 0.55 });
  [38, 50, 57, 62, 66, 69].forEach((n, i) => piano(n, tT + i * 0.015, 0.55, { dur: 7, pan: -0.4 + i * 0.16 }));
  [69, 74, 76, 81].forEach((n, i) => piano(n, tT + BEAT * (2 + i), 0.42, { dur: 5, pan: 0.2 }));
  // 落版：蓝点一声铃，品牌动机，落印一声，主和弦余音
  bell(81, at("finale", FINALE.DOT), 0.05, 0.1);
  MOTIF.forEach((n, i) => piano(n + 12, at("finale", FINALE.MARK) + i * BEAT * 0.75, 0.42, { dur: 5, pan: 0.15 }));
  bell(88, at("finale", FINALE.MARK) + BEAT * 2.25, 0.03, 0.2);
  whoosh(at("finale", FINALE.NAME_OUT + 8), 0.035, 1.2);
  stamp(at("finale", FINALE.STAMP), 0.3);
  const tS = at("finale", FINALE.STAMP);
  const tEnd = DURATION / FPS;
  strings([50, 57, 64, 66, 69], tS, at("finale", FINALE.FADE) - tS, 0.26, { att: 0.3, rel: tEnd - at("finale", FINALE.FADE) - 0.2, bright: 0.55 });
  [38, 50, 57, 64, 66].forEach((n, i) => piano(n, tS + i * 0.012, 0.42, { dur: 9, pan: -0.3 + i * 0.15 }));
  piano(81, tS + BEAT * 2, 0.32, { dur: 6, pan: 0.2 });
  void t0;
}

}

/* ───────── 混响（Freeverb 结构）与母线 ───────── */
function freeverb(input, { room = 0.86, damp = 0.32, width = 1 } = {}) {
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const scale = SR / 44100;
  const out = [new Float32Array(LEN), new Float32Array(LEN)];
  for (let ch = 0; ch < 2; ch++) {
    const spread = ch ? 23 : 0;
    const combs = combT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * scale)), i: 0, f: 0 }));
    const aps = apT.map((t) => ({ buf: new Float32Array(Math.round((t + spread) * scale)), i: 0 }));
    const x = input[ch];
    const y = out[ch];
    for (let n = 0; n < LEN; n++) {
      const inp = x[n] * 0.015;
      let s = 0;
      for (const c of combs) {
        const o = c.buf[c.i];
        c.f = o * (1 - damp) + c.f * damp;
        c.buf[c.i] = inp + c.f * room;
        if (++c.i >= c.buf.length) c.i = 0;
        s += o;
      }
      for (const a of aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = s + b * 0.5;
        if (++a.i >= a.buf.length) a.i = 0;
        s = b - s;
      }
      y[n] = s;
    }
  }
  if (width < 1) for (let n = 0; n < LEN; n++) { const m = (out[0][n] + out[1][n]) / 2; out[0][n] = m + (out[0][n] - m) * width; out[1][n] = m + (out[1][n] - m) * width; }
  return out;
}

const rv = freeverb(SEND, { room: 0.88, damp: 0.3 });
// 骤停：第二幕“寂静”那一刻，混响回声一起收掉（否则尾音拖着，停不下来），随后慢慢回来
if (MODE === "film") {
  // 屏息：“？”变蓝前约一秒，混响回声收掉，只剩空气声
  const tB = at("turn", TURN.BLOOM);
  for (let ch = 0; ch < 2; ch++) for (let n = Math.floor((tB - 1.1) * SR); n < Math.floor((tB + 0.4) * SR); n++) {
    const t = n / SR - (tB - 1.1);
    const g = t < 0.25 ? 1 - 0.95 * (t / 0.25) : t < 1.1 ? 0.05 : 0.05 + 0.95 * ((t - 1.1) / 0.4);
    rv[ch][n] *= g;
  }
  const tF = at("night", NIGHT.F_AT);
  for (let ch = 0; ch < 2; ch++) for (let n = Math.floor((tF - 0.02) * SR); n < Math.min(LEN, Math.floor((tF + 4) * SR)); n++) {
    const t = n / SR - tF;
    const g = t < 0 ? 1 - (t + 0.02) / 0.02 * 0 : t < 0.12 ? 1 - (t / 0.12) * 0.96 : t < 1.2 ? 0.04 : 0.04 + 0.96 * Math.min(1, (t - 1.2) / 2.8);
    rv[ch][n] *= g;
  }
}
const mix = [new Float32Array(LEN), new Float32Array(LEN)];
const hp = [svf(), svf()];
for (let ch = 0; ch < 2; ch++) for (let n = 0; n < LEN; n++) {
  let v = MUSIC[ch][n] * 0.9 + SFX[ch][n] + rv[ch][n] * 3.2;
  v = hp[ch](v, 28, 0.7).high; // 去掉 28 Hz 以下
  mix[ch][n] = v;
}
// 母线包络：片尾 3 秒衰减到无声（最后 0.3 秒低于 −60 dBFS）；正片揭幕前约 1 秒真正的屏息
{
  const endT = LEN_S - 0.5;
  const fadeA = endT - 3.0;
  const tB = MODE === "film" ? at("turn", TURN.BLOOM) + 0.03 : -1; // 屏息落在蓝点独处黑场的那一秒（铺开之前）
  for (let n = 0; n < LEN; n++) {
    const t = n / SR;
    let g = 1;
    if (t > fadeA) g = t >= endT - 0.3 ? 0 : 0.5 * (1 + Math.cos((Math.PI * (t - fadeA)) / (endT - 0.3 - fadeA)));
    if (tB > 0 && t > tB - 1.0 && t < tB) {
      const u = t - (tB - 1.0);
      g *= u < 0.2 ? 1 - 0.99 * (u / 0.2) : u > 0.97 ? 0.01 + 0.99 * ((u - 0.97) / 0.03) : 0.01;
    }
    if (g !== 1) { mix[0][n] *= g; mix[1][n] *= g; }
  }
}
// 峰值归一（-3 dBFS），软削波保护
let peak = 0;
for (let ch = 0; ch < 2; ch++) for (let n = 0; n < LEN; n++) peak = Math.max(peak, Math.abs(mix[ch][n]));
const g = 0.708 / (peak || 1);
const buf = Buffer.alloc(44 + LEN * 2 * 3);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + LEN * 6, 4);
buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 6, 28);
buf.writeUInt16LE(6, 32);
buf.writeUInt16LE(24, 34);
buf.write("data", 36);
buf.writeUInt32LE(LEN * 6, 40);
let o = 44;
for (let n = 0; n < LEN; n++) for (let ch = 0; ch < 2; ch++) {
  const v = Math.max(-1, Math.min(1, Math.tanh(mix[ch][n] * g * 1.05) / Math.tanh(1.05)));
  const iv = Math.round(v * 8388607);
  buf.writeIntLE(iv, o, 3);
  o += 3;
}
const outPath = join(here, "..", "public", "audio", process.env.SCORE_OUT ?? (MODE === "cut30" ? "score-cut30.wav" : "score.wav"));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buf);
console.log(`wrote ${outPath} (${(LEN / SR).toFixed(1)} s, peak gain ${g.toFixed(3)})`);

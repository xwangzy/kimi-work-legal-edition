/**
 * V4 配乐与音效合成器（零依赖，纯 Node；全部由程序合成，无第三方音乐素材，版权归片方）：
 * 读取 src/timeline.ts 与 src/cues.ts，生成与画面逐帧对齐的 public/audio/score.wav（48 kHz / 16-bit / 立体声）。
 * 速度 100 BPM（1 拍 = 36 帧 @ 60 fps，1 小节 = 2.4 秒）。调性 D 小调 → F 大调。
 * 母题：三个音的“蓝点动机”（A–C–F，上行），蓝点出现、标识成形、落版时各出现一次。
 * 段落（与 src/timeline.ts 的小节一致）：
 *   0–6      序幕：低频持续音 + 纸张空气声 + 稀疏钢琴；4.4 起命题的弦乐式铺底；5 蓝点铃声；上行进 6
 *   6        轻落点：F 大九和弦 + 蓝点动机（标识成形）
 *   8.5–28   律动：8.5 起拨弦与轻镲，10 起底鼓与贝斯，14 起四拍，17.5 加满，24.5 抬升
 *   28       换气：修订稿从屏幕里抬起——鼓组停一小节，只留铺底与钢琴
 *   29–36.5  律动再起，32.5 起高潮（一个工作空间）
 *   36.5–39.5 夜色：铺底 + 钢琴 + 心跳般的低频脉冲（保密）
 *   39.5–41.5 价值：钢琴动机 + 弦乐铺底上扬
 *   41.5–44  主题：推进，底鼓加密 + 上行
 *   44       主落点：冲击 + 和弦 + 动机（产品名）
 *   46–50.5  联袂打造：次落点 + 长持续和弦 + 品牌声音标识，尾音自然消失
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BAR, BEAT, DURATION, FPS, SCENE_BAR as B } from "../src/timeline.ts";
import { GLOBAL_CUES } from "../src/cues.ts";
import { CUT30_CUES, CUT30_DURATION } from "../src/cut30.ts";
const MODE = process.env.SCORE ?? "film"; // film | cut30

const OUT_NAME = process.env.SCORE_OUT ?? (MODE === "cut30" ? "score-cut30.wav" : "score.wav");
const SR = 48000;
const LEN = Math.ceil(((MODE === "cut30" ? CUT30_DURATION : DURATION) / FPS) * SR);
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

/** 钢琴：两根微失谐的弦 + 非谐泛音 + 槌击噪声，双段衰减。 */
function piano(note, start, amp, { dur = 4.5, pan = 0, send = 0.55 } = {}) {
  const f = mtof(note);
  const B = 0.00018 * Math.pow(2, (note - 60) / 24); // 非谐系数
  const parts = [1, 2, 3, 4, 5, 6].map((k) => ({ k, fk: f * k * Math.sqrt(1 + B * k * k), a: [1, 0.42, 0.22, 0.12, 0.07, 0.04][k - 1] }));
  let lp = 0;
  write(
    DUCK,
    start,
    dur,
    (t) => {
      let v = 0;
      for (const p of parts) {
        const dec = Math.exp(-t * (0.55 + p.k * 0.35)) * 0.75 + Math.exp(-t * (3 + p.k)) * 0.25;
        v += p.a * dec * (Math.sin(2 * Math.PI * p.fk * t) + Math.sin(2 * Math.PI * p.fk * 1.0007 * t)) * 0.5;
      }
      const n = noise();
      lp += 0.3 * (n - lp);
      const hammer = lp * Math.exp(-t * 90) * 0.18;
      return (v + hammer) * amp * Math.min(1, t / 0.003) * env(t, dur, 0.001, 0.4);
    },
    { pan, send },
  );
}
/** 弦乐式铺底：锯齿近似（16 次谐波，1/k）+ 慢起，低通随时间打开。 */
function strings(notes, start, dur, amp, { att = 2, rel = 2, open = 0.5, pan = 0 } = {}) {
  notes.forEach((n, vi) => {
    const f = mtof(n);
    const fl = svf();
    const ph = new Float64Array(3);
    write(
      DUCK,
      start,
      dur + rel,
      (t) => {
        let saw = 0;
        for (let d = 0; d < 3; d++) {
          ph[d] += (2 * Math.PI * f * (1 + (d - 1) * 0.0035) * (1 + 0.002 * Math.sin(2 * Math.PI * 5.2 * t + vi))) / SR;
          let x = 0;
          for (let k = 1; k <= 12; k++) x += Math.sin(ph[d] * k) / k;
          saw += x;
        }
        const p = Math.min(1, t / (dur + rel));
        const { low } = fl(saw / 3, 500 + 2600 * open * (0.4 + 0.6 * p), 0.6);
        return low * amp * env(t, dur + rel, att, rel) / notes.length;
      },
      { pan: (vi / Math.max(1, notes.length - 1) - 0.5) * 0.9 + pan, send: 0.7 },
    );
  });
}
/** 纸张空气声：极轻的带通噪声，慢速起伏。 */
function air(start, dur, amp) {
  const fl = svf();
  for (const side of [-1, 1]) {
    write(DRY, start, dur, (t) => {
      const { band } = fl(noise(), 1800 + 900 * Math.sin(t * 0.37 + side), 0.9);
      return band * amp * env(t, dur, 2.5, 2.5) * (0.7 + 0.3 * Math.sin(t * 0.8 + side * 2));
    }, { pan: side * 0.7, send: 0.4 });
  }
}
/** 纸张掠过：短促的带通噪声扫频。 */
function paperSwish(start, amp, pan = 0) {
  const fl = svf();
  const dur = 0.45;
  write(DRY, start, dur, (t) => {
    const p = t / dur;
    const { band } = fl(noise(), 2500 + 4000 * p, 0.5);
    return band * amp * Math.sin(Math.PI * p) ** 2;
  }, { pan, send: 0.35 });
}
/** 低频脉冲（心跳）。 */
function pulse(start, amp) {
  write(DRY, start, 0.6, (t) => Math.sin(2 * Math.PI * (52 + 20 * Math.exp(-t * 18)) * t) * Math.exp(-t * 6) * amp);
}
/** 蓝点动机：A–C–F 上行（可整体移调）。 */
function motif(start, amp, { up = 0, gap = 0.3, inst = "bell" } = {}) {
  [69, 72, 77].forEach((n, i) => {
    const t = start + i * gap;
    if (inst === "bell") bell(n + 12 + up, t, amp * (i === 2 ? 1.15 : 1), (i - 1) * 0.3);
    else piano(n + up, t, amp * (i === 2 ? 1.1 : 0.95), { pan: (i - 1) * 0.25, dur: 5 });
  });
}

// ── 和声 ──
const CH = {
  Dm9: { n: [50, 53, 57, 60, 64], b: 38 },
  Bb9: { n: [46, 50, 53, 57, 60], b: 34 },
  F9: { n: [53, 57, 60, 64, 67], b: 41 },
  C9: { n: [48, 55, 60, 62, 64], b: 36 },
};
const CYCLE = ["Dm9", "Dm9", "Bb9", "Bb9", "F9", "F9", "C9", "C9"];

// ── 编曲 ──
const chordAt = (bar) => CH[CYCLE[(((Math.floor(bar - 8.5)) % 8) + 8) % 8]];
const RESTS = []; // [起, 止]（秒）：鼓与拨弦让出一拍
const barsFrom = (a, b) => { const r = []; for (let x = a; x < b - 0.01; x += 1) r.push(x); return r; };

function groove(b0, b1, level) {
  for (let b = b0; b < b1; b++) {
    const ch = chordAt(b);
    const L = level(b);
    if (Math.round((b - 8.5) * 2) % 4 === 0) {
      pad(ch.n, barT(b), barT(2), 0.065 + 0.02 * L.lift, { att: 0.25, rel: 0.5, bright: 0.42 });
      if (L.lift) strings(ch.n.map((n) => n + 12), barT(b), barT(2), 0.03, { att: 0.5, rel: 0.6, open: 0.7 });
    }
    for (let q = 0; q < 4; q++) {
      const t = barT(b) + beatT(q);
      if (L.kick === 2 || (L.kick === 1 && q % 2 === 0)) kick(t, L.kick === 2 ? 0.5 : 0.44);
      if (L.clap && q % 2 === 1) clap(t, 0.16 + 0.05 * L.lift);
    }
    for (let e = 0; e < 8; e++) {
      const t = barT(b) + (e * beatT(1)) / 2;
      hat(t, (e % 2 === 1 ? 0.035 : 0.018) * L.hat);
      if (L.lift) hat(t + beatT(0.25), 0.012, { len: 0.03, pan: -0.25 });
      if (L.bass) bass(e % 4 === 3 ? ch.b + 12 : ch.b, t, beatT(0.42), 0.15);
    }
    const pat = [0, 2, 4, 1, 3, 2, 4, 3];
    for (let s = 0; s < 16; s++) {
      const t = barT(b) + (s * beatT(1)) / 4;
      const n = ch.n[pat[s % 8] % ch.n.length] + 12;
      pluck(n, t, L.pluck * (s % 4 === 0 ? 1.2 : 0.85), { pan: Math.sin(s * 0.9) * 0.5, dur: 0.6, decay: 0.992 });
    }
  }
}

// ── 30 秒社媒版编曲（小节：0 纸 · 2 登场 · 3.5–9.25 律动 · 9.25 主题 · 10.25 联袂打造） ──
function cut30() {
  // 段落起点（帧）：与 src/cut30.ts 的剪辑表一致
  const fr = (n) => n / FPS;
  const T = { reveal: fr(204), home: fr(348), consent: fr(590), proof: fr(798), decide: fr(918), sign: fr(1208), theme: fr(1288), partner: fr(1498) };
  // 钩子：命题 + 蓝点
  strings([46, 53, 58, 62, 65], 0, T.reveal, 0.075, { att: 0.5, rel: 0.2, open: 0.6 });
  pad(CH.Bb9.n, 0, T.reveal, 0.06, { att: 0.6, rel: 0.2, bright: 0.3 });
  piano(62, 0.1, 0.12); piano(65, 1.2, 0.11);
  motif(T.reveal - 1.2, 0.05, { gap: 0.3 });
  reverseSwell(CH.F9.n, T.reveal - 0.6, 0.6, 0.14);
  // 登场
  impact(T.reveal, 0.5);
  pad(CH.F9.n, T.reveal, T.home - T.reveal + 0.4, 0.1, { att: 0.05, rel: 0.6, bright: 0.46 });
  motif(T.reveal + 0.6, 0.07, { gap: 0.26 });
  // 律动
  const bar0 = T.home / sec(BAR), barE = T.theme / sec(BAR);
  for (let b = bar0; b < barE - 0.01; b += 1) {
    const e = Math.min(b + 1, barE);
    groove(b, e, () => ({ kick: b < T.consent / sec(BAR) ? 1 : 2, clap: b >= T.consent / sec(BAR), hat: 1, bass: true, lift: b >= T.decide / sec(BAR) ? 1 : 0, pluck: b >= T.decide / sec(BAR) ? 0.075 : 0.06 }));
  }
  impact(T.proof, 0.3);
  strings([53, 60, 65, 69, 72], T.decide + 1.8, 3.5, 0.06, { att: 0.5, rel: 1, open: 1 });
  // 主题：推进
  pad(CH.Bb9.n, T.theme, T.partner - T.theme, 0.09, { att: 0.3, rel: 0.1, bright: 0.45 });
  strings([46, 53, 58, 62, 65, 70], T.theme, T.partner - T.theme, 0.07, { att: 0.4, rel: 0.1, open: 1 });
  riser(T.theme, T.partner - fr(50) - T.theme, 0.24);
  reverseSwell(CH.F9.n, T.partner - fr(50) - 0.6, 0.6, 0.16);
  // 展开 + 联袂打造（展开在 partner 前 50 帧）
  impact(T.partner - fr(50), 0.75);
  pad(CH.F9.n, T.partner, 30 - T.partner, 0.11, { att: 0.03, rel: 1.2, bright: 0.5 });
  strings([41, 53, 60, 65, 69, 72], T.partner, 30 - T.partner - 0.6, 0.07, { att: 0.1, rel: 1.2, open: 1 });
  motif(T.partner + fr(98), 0.1, { inst: "piano", gap: 0.38 });
  motif(T.partner + fr(98), 0.04, { gap: 0.38, up: 12 });
}
if (MODE === "cut30") cut30();
else {
// A 序幕（paper：0–6）
pad([26, 38], 0, barT(B.reveal), 0.11, { att: 4, rel: 0.4, bright: 0.18 });
air(0, barT(B.reveal + 0.2), 0.018);
[[0.6, 62], [1.6, 65], [2.35, 69], [3.1, 64], [3.6, 62]].forEach(([b, n]) => piano(n, barT(b), 0.13, { pan: (n - 64) / 16 }));
strings([50, 57, 62, 65], barT(2.6), barT(1.8), 0.05, { att: 2.5, rel: 1.2, open: 0.3 });
strings([46, 53, 58, 62, 65], barT(4.3), barT(1.5), 0.075, { att: 1.2, rel: 0.3, open: 0.6 });
pad(CH.Bb9.n, barT(4.3), barT(1.6), 0.05, { att: 1.4, rel: 0.3, bright: 0.3 });
motif(barT(4.95), 0.05, { gap: 0.32 });
riser(barT(B.reveal - 0.8), barT(0.8), 0.18);
reverseSwell(CH.F9.n, barT(B.reveal - 0.7), barT(0.7), 0.15);

// B 登场（reveal）
impact(barT(B.reveal), 0.5);
pad(CH.F9.n, barT(B.reveal), barT(2.5), 0.1, { att: 0.05, rel: 1.6, bright: 0.46 });
strings([53, 60, 65, 69, 72], barT(B.reveal), barT(2.2), 0.06, { att: 0.4, rel: 1.4, open: 0.8 });
motif(barT(B.reveal + 0.66), 0.075, { gap: 0.28 });

// 乐章一 · 交代（home → run）：钢琴与轻拨弦，几乎不用鼓
for (let b = B.home; b < B.run - 0.01; b += 1) {
  const ch = chordAt(b);
  if (Math.round((b - B.home) * 2) % 4 === 0) pad(ch.n, barT(b), barT(2), 0.08, { att: 0.5, rel: 0.6, bright: 0.4 });
  ch.n.slice(0, 4).forEach((n, i) => piano(n + 12, barT(b) + beatT(i * 0.5 + (i > 1 ? 1 : 0)), 0.08, { pan: (i - 1.5) * 0.25, dur: 3 }));
  for (let s16 = 0; s16 < 16; s16 += 2) pluck(ch.n[[0, 2, 4, 1, 3, 2, 4, 3][(s16 / 2) % 8] % ch.n.length] + 12, barT(b) + (s16 * beatT(1)) / 4, 0.042, { pan: Math.sin(s16) * 0.5, dur: 0.6 });
  for (let e = 0; e < 8; e++) hat(barT(b) + (e * beatT(1)) / 2, e % 2 ? 0.026 : 0.01);
  bass(ch.b, barT(b), beatT(1.6), 0.07);
  if (b >= B.home + 1) { kick(barT(b), 0.3); kick(barT(b) + beatT(2), 0.26); }
  if (b >= B.consent) bass(ch.b, barT(b) + beatT(2), beatT(1.2), 0.08);
}
riser(barT(B.run - 0.75), barT(0.75), 0.12);

// 乐章二 · 过程（run → decide）：律动建立，低音与弦乐进入
for (const b of barsFrom(B.run, B.decide)) groove(b, Math.min(b + 1, B.decide), () => ({
  kick: b < B.risk ? 1 : 2,
  clap: b >= B.proof,
  hat: 1,
  bass: true,
  lift: 0,
  pluck: b < B.risk ? 0.05 : 0.062,
}));
strings([50, 57, 62, 65], barT(B.risk), barT(B.decide - B.risk), 0.035, { att: 2, rel: 0.6, open: 0.6 });
bell(88, barT(B.risk) + sec(74), 0.07, -0.2); // 蓝点落在第 7.1 条
motif(barT(B.risk) + sec(80), 0.045, { gap: 0.22, up: 12 });
impact(barT(B.proof), 0.35); // 证据镜头
riser(barT(B.decide - 1), barT(1), 0.16);

// 乐章三 · 判断（decide → breadth）：全编制；点击前留一拍空
{
  const click = barT(B.decide) + sec(104);
  for (const b of barsFrom(B.decide, B.signoff)) groove(b, Math.min(b + 1, B.signoff), () => ({ kick: 2, clap: true, hat: 1, bass: true, lift: 1, pluck: 0.074 }));
  // 空拍：点击前一拍内把鼓与拨弦压到 0（在混音前处理，见下方 rests）
  RESTS.push([click - beatT(1), click]);
  strings([53, 60, 65, 69, 72], barT(B.decide) + sec(150), barT(2.2), 0.06, { att: 0.6, rel: 1.2, open: 1 }); // 纸上写出修订
  for (const b of barsFrom(B.signoff, B.deliver)) groove(b, Math.min(b + 1, B.deliver), () => ({ kick: 2, clap: true, hat: 1, bass: true, lift: 1, pluck: 0.07 }));
}
// 换气（deliver：签发后的修订稿抬起）
reverseSwell(CH.F9.n, barT(B.deliver) + sec(40) - 0.6, 0.6, 0.12);
pad(CH.F9.n, barT(B.deliver), barT(B.breadth - B.deliver), 0.1, { att: 0.05, rel: 0.8, bright: 0.42 });
strings([53, 60, 65, 69], barT(B.deliver) + sec(36), barT(2), 0.07, { att: 0.3, rel: 0.6, open: 0.9 });
[[0, 77], [0.25, 81], [0.5, 84]].forEach(([d, n]) => piano(n, barT(B.deliver) + sec(40) + barT(d), 0.11));
for (const b of barsFrom(B.deliver, B.breadth)) groove(b, b + 1, () => ({ kick: 1, clap: false, hat: 0.6, bass: true, lift: 0, pluck: 0.045 }));
riser(barT(B.breadth - 0.75), barT(0.75), 0.07);

// 高潮 · 一个工作空间（breadth）

for (const b of barsFrom(B.breadth, B.trust)) groove(b, Math.min(b + 1, B.trust), () => ({ kick: 1, clap: true, hat: 0.7, bass: true, lift: 0, pluck: 0.058 }));
reverseSwell(CH.Bb9.n, barT(B.trust) - 0.9, 0.9, 0.12); // 光收拢成蓝点

// 夜色 · 保密（trust）
pad(CH.Bb9.n, barT(B.trust), barT(1.5), 0.085, { att: 0.4, rel: 0.8, bright: 0.3 });
pad(CH.F9.n, barT(B.trust + 1.5), barT(1.5), 0.085, { att: 0.6, rel: 0.8, bright: 0.3 });
pad([34], barT(B.trust), barT(3), 0.07, { att: 0.8, rel: 0.8, bright: 0.2 });
[[0.3, 74], [1, 72], [1.5, 69], [2, 77], [2.5, 72]].forEach(([b, n]) => piano(n, barT(B.trust + b), 0.09, { pan: (n - 72) / 16 }));
for (let q = 0; q < 12; q++) pulse(barT(B.trust) + beatT(q), q % 4 === 0 ? 0.2 : 0.1);

// 价值（value，夜色里的那页纸）
strings([50, 57, 62, 65, 69], barT(B.value), barT(2), 0.08, { att: 1.2, rel: 0.5, open: 0.7 });
pad(CH.Dm9.n, barT(B.value), barT(2), 0.06, { att: 0.8, rel: 0.4, bright: 0.35 });
motif(barT(B.value + 0.15), 0.11, { inst: "piano", gap: 0.45 });
[[1, 74], [1.4, 76], [1.7, 77]].forEach(([b, n]) => piano(n, barT(B.value + b), 0.08));

// 主题（theme）：推进
pad(CH.Bb9.n, barT(B.theme), barT(1.25), 0.09, { att: 0.5, rel: 0.3, bright: 0.42 });
pad(CH.C9.n, barT(B.theme + 1.25), barT(1.25), 0.1, { att: 0.5, rel: 0.1, bright: 0.48 });
strings([46, 53, 58, 62, 65, 70], barT(B.theme), barT(2.5), 0.07, { att: 1.5, rel: 0.1, open: 1 });
[0, 0.5, 1, 1.5, 1.75, 2, 2.25].forEach((b, i) => kick(barT(B.theme + b), 0.26 + i * 0.03));
[2, 2.125, 2.25, 2.375].forEach((b) => kick(barT(B.theme + b), 0.22));
riser(barT(B.lockup - 1.5), barT(1.5), 0.3);
reverseSwell(CH.F9.n, barT(B.lockup - 0.7), barT(0.7), 0.18);

// 主落点（lockup）：与暖白从蓝点展开同一帧
impact(barT(B.lockup), 1.0);
pad(CH.F9.n, barT(B.lockup), barT(2), 0.12, { att: 0.03, rel: 1.4, bright: 0.52 });
strings([41, 53, 60, 65, 69, 72], barT(B.lockup), barT(2), 0.08, { att: 0.1, rel: 1.4, open: 1 });
motif(barT(B.lockup + 0.2), 0.085, { gap: 0.26 });

// 联袂打造（partner）：落印 + 品牌声音标识，尾音随画面淡出收住
impact(barT(B.partner), 0.4);
pad(CH.F9.n, barT(B.partner), barT(2.6), 0.1, { att: 0.08, rel: 1.6, bright: 0.45 });
pad([29, 41], barT(B.partner), barT(2.6), 0.1, { att: 0.05, rel: 1.6, bright: 0.2 });
strings([53, 60, 65, 69, 72, 77], barT(B.partner + 0.2), barT(2.4), 0.05, { att: 1.2, rel: 1.6, open: 0.8 });
motif(barT(B.partner) + sec(98), 0.11, { inst: "piano", gap: 0.4 });
motif(barT(B.partner) + sec(98), 0.045, { gap: 0.4, up: 12 });
}

// ── 音效 ──
let typeIdx = 0;
for (const c of MODE === "cut30" ? CUT30_CUES : GLOBAL_CUES) {
  const t = sec(c.f);
  if (c.type === "type") typeTick(t, typeIdx++);
  else if (c.type === "click") click(t);
  else if (c.type === "whoosh") whoosh(t, c.v ?? 0.5);
  else if (c.type === "pop") bell([81, 84, 88, 93][(c.v ?? 0) % 4], t, 0.07, 0.2);
  else if (c.type === "blip") bell([74, 77, 81][(c.v ?? 0) % 3], t, 0.05, -0.2);
  else if (c.type === "tick") woodTick(t, 0.06 * (c.v ?? 0.5));
  else if (c.type === "swap") { woodTick(t, 0.04); bell([86, 88, 91, 93][(c.v ?? 0) % 4], t + 0.02, 0.04, 0.3); }
  else if (c.type === "paper") paperSwish(t, 0.14 * (c.v ?? 1), 0);
  else if (c.type === "stamp") { pulse(t, 0.38); woodTick(t + 0.005, 0.05); paperSwish(t - 0.08, 0.08, -0.1); }
}

// ── 侧链：铺底与琶音随底鼓轻压 ──
for (const [r0, r1] of RESTS) {
  const i0 = Math.floor(r0 * SR), i1 = Math.min(LEN, Math.floor(r1 * SR));
  for (let i = i0; i < i1; i++) {
    const g = Math.min(1, (i - i0) / (SR * 0.03), (i1 - i) / (SR * 0.03));
    const k = 1 - 0.92 * g;
    DRY[0][i] *= k; DRY[1][i] *= k;
  }
}
const duck = new Float32Array(LEN).fill(1);
for (const k of kicks) {
  const s0 = Math.floor(k * SR);
  for (let i = 0; i < SR * 0.35 && s0 + i < LEN; i++) duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.32 * Math.exp(-i / (SR * 0.09)));
}

// ── 混响（Freeverb 简化版：4 梳状 + 2 全通，左右错开） ──
function reverb(input, spread) {
  const out = new Float32Array(LEN);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => Math.round(((d * 1.45 + spread) * SR) / 44100));
  const aps = [556, 441].map((d) => Math.round(((d + spread) * SR) / 44100));
  const cb = combs.map((n) => ({ buf: new Float32Array(n), i: 0, lp: 0 }));
  const ab = aps.map((n) => ({ buf: new Float32Array(n), i: 0 }));
  const fb = 0.875, damp = 0.32;
  for (let s = 0; s < LEN; s++) {
    const x = input[s] * 0.2;
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
const out = join(here, "..", "public", "audio", OUT_NAME);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`score.wav ${(LEN / SR).toFixed(2)} s · peak ${peak.toFixed(3)} · gain ${gain.toFixed(2)} · ${(MODE === "cut30" ? CUT30_CUES : GLOBAL_CUES).length} 个音效提示点`);

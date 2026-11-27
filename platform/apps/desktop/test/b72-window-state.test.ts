/**
 * 第 72 批（D-300 第 1 条）：窗口尺寸按工作区算、最小尺寸不超过工作区、记忆的矩形与某屏相交不足一半回到居中、默认窗口化。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const ws = require("../electron/window-state.cjs");

const WA = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test("初始尺寸：工作区 82%×86%，夹在 960～1440 × 640～900，且不超过工作区；居中", () => {
  // 1080p / 150%（逻辑工作区约 1280×672）：原来固定 1440×900、最小 1080×700，都比工作区大 → 被系统压成“铺满”
  const b150 = ws.initialBounds(WA(0, 0, 1280, 672));
  assert.deepEqual([b150.width, b150.height], [1050, 640]);
  assert.ok(b150.width <= 1280 && b150.height <= 672);
  assert.deepEqual([b150.x, b150.y], [115, 16], "居中");
  // 1080p / 125%（约 1536×816）
  assert.deepEqual([ws.initialBounds(WA(0, 0, 1536, 816)).width, ws.initialBounds(WA(0, 0, 1536, 816)).height], [1260, 702]);
  // 大屏：封顶 1440×900
  const big = ws.initialBounds(WA(0, 25, 2560, 1415));
  assert.deepEqual([big.width, big.height], [1440, 900]);
  assert.equal(big.y, 25 + Math.round((1415 - 900) / 2));
  // 很小的工作区：不超过工作区（下限 960×640 也让位）
  const tiny = ws.initialBounds(WA(0, 0, 900, 560));
  assert.deepEqual([tiny.width, tiny.height], [900, 560]);
});

test("最小尺寸：960×600，且不超过工作区", () => {
  assert.deepEqual(ws.minSize(WA(0, 0, 1280, 672)), { minWidth: 960, minHeight: 600 });
  assert.deepEqual(ws.minSize(WA(0, 0, 900, 560)), { minWidth: 900, minHeight: 560 });
});

test("相交判定与恢复：与某屏工作区相交 ≥ 一半才用保存的矩形（尺寸再夹回那块屏）；否则在鼠标所在屏居中；只在上次最大化时恢复最大化", () => {
  const main = WA(0, 0, 1440, 875);
  const ext = WA(1440, 0, 1920, 1055);
  assert.equal(ws.overlapRatio(WA(100, 100, 1000, 700), main), 1);
  assert.equal(ws.overlapRatio(WA(1000, 0, 880, 800), main), 0.5);
  assert.equal(ws.overlapRatio(WA(5000, 0, 800, 600), main), 0);
  // 外接屏上保存的窗口，外接屏还在 → 原样恢复
  const onExt = ws.restoreBounds({ x: 1600, y: 80, width: 1300, height: 820, maximized: false }, [main, ext], main);
  assert.deepEqual(onExt.bounds, { x: 1600, y: 80, width: 1300, height: 820 });
  // 外接屏拔掉 → 相交为 0，回到主屏居中，不跑到屏幕外
  const gone = ws.restoreBounds({ x: 1600, y: 80, width: 1300, height: 820, maximized: false }, [main], main);
  assert.deepEqual(gone.bounds, ws.initialBounds(main));
  // 一半以上在屏内但尺寸比屏大 → 不夹成满屏，回到按比例的初始尺寸居中
  const big = ws.restoreBounds({ x: 0, y: 0, width: 2000, height: 1200 }, [main], main);
  assert.deepEqual(big.bounds, ws.initialBounds(main));
  // 第 72 批 Windows 实机：100% 下记住 1440×888（240,72），换到 150%（逻辑工作区 1280×688）→ 不铺满，按比例 1050×640 居中
  const hi = { ...WA(0, 0, 1280, 688), scaleFactor: 1.5 };
  const at150 = ws.restoreBounds({ x: 240, y: 72, width: 1440, height: 888, maximized: false, scale: 1 }, [hi], hi);
  assert.deepEqual(at150.bounds, ws.initialBounds(hi));
  assert.deepEqual(at150.bounds, { x: 115, y: 24, width: 1050, height: 640 });
  assert.notDeepEqual(at150.bounds, { x: 0, y: 0, width: 1280, height: 688 });
  // 150% 下记住 1050×640（115,24），回到 100%（1920×1032）→ 尺寸保留、重新居中（不停在左上角）
  const lo = { ...WA(0, 0, 1920, 1032), scaleFactor: 1 };
  const back = ws.restoreBounds({ x: 115, y: 24, width: 1050, height: 640, maximized: false, scale: 1.5 }, [lo], lo);
  assert.deepEqual(back.bounds, { x: 435, y: 196, width: 1050, height: 640 });
  // 同一缩放比例：按记住的位置恢复（不重新居中）
  const same = ws.restoreBounds({ x: 100, y: 50, width: 1200, height: 800, scale: 1 }, [lo], lo);
  assert.deepEqual(same.bounds, { x: 100, y: 50, width: 1200, height: 800 });
  // 最大化：只有上次是最大化才恢复；坏数据、没有文件 → 默认窗口化居中
  assert.equal(ws.restoreBounds({ x: 10, y: 10, width: 1200, height: 800, maximized: true }, [main], main).maximized, true);
  assert.equal(ws.restoreBounds(null, [main], main).maximized, false);
  assert.deepEqual(ws.restoreBounds({ x: "a" }, [main], main).bounds, ws.initialBounds(main));
});

test("记忆：resize / move / maximize 防抖写 window-state.json；最大化时保留还原尺寸；关窗立即写", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ws-"));
  const file = join(dir, "window-state.json");
  const win = Object.assign(new EventEmitter(), {
    b: { x: 10, y: 20, width: 1200, height: 800 },
    max: false,
    isDestroyed: () => false,
    isMaximized() {
      return this.max;
    },
    isMinimized: () => false,
    isFullScreen: () => false,
    getBounds() {
      return { ...this.b };
    },
    getNormalBounds() {
      return { ...this.b };
    },
  });
  ws.attachWindowState(win, file, 20, () => 1.25);
  win.b = { x: 30, y: 40, width: 1100, height: 700 };
  win.emit("resize");
  win.emit("move");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x: 30, y: 40, width: 1100, height: 700, maximized: false, scale: 1.25 });
  // 最大化：记标记，不把满屏尺寸当成还原尺寸
  win.max = true;
  win.b = { x: 0, y: 0, width: 1440, height: 875 };
  win.emit("close");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x: 30, y: 40, width: 1100, height: 700, maximized: true, scale: 1.25 });
  assert.deepEqual(ws.readState(join(dir, "nope.json")), null);
});

test("主进程窗口创建段接入：按 window-state 算尺寸、show:false + ready-to-show（3 秒兜底）、记忆；不主动最大化", () => {
  const main = readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
  assert.match(main, /const \{ windowOptions, attachWindowState, scaleOfWindow \} = require\("\.\/window-state\.cjs"\);/);
  assert.match(main, /const sized = windowOptions\(require\("electron"\)\.screen, stateFile\);/);
  assert.match(main, /minWidth: sized\.minWidth,\s*minHeight: sized\.minHeight,/);
  assert.match(main, /show: false,/);
  assert.match(main, /win\.once\("ready-to-show", reveal\);\s*setTimeout\(reveal, 3000\);\s*attachWindowState\(win, stateFile, 500, \(\) => scaleOfWindow\(require\("electron"\)\.screen, win\)\);/);
  assert.match(main, /if \(sized\.maximized\) win\.maximize\(\);/);
  assert.doesNotMatch(main, /width: 1440,\s*height: 900,\s*minWidth: 1080/);
});

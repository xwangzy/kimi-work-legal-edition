/**
 * 窗口尺寸与位置（第 72 批，D-300 第 1 条）：按所在屏幕的工作区算初始尺寸、记住上次的位置 / 尺寸 / 最大化。
 *
 * - 初始：工作区约 82% × 86%，宽夹在 960～1440、高夹在 640～900，再与工作区取小；居中。
 *   1080p / 150% 缩放（逻辑工作区约 1280×672）→ 1050×578 → 夹到 1050×640（不超过 672），不再“铺满全屏”；
 * - 最小：960×600，且不超过工作区（小屏或高缩放时最小尺寸本身不能把窗口撑出屏幕）；
 * - 记忆：resize / move / maximize / unmaximize 防抖写 userData/window-state.json（逻辑像素）；
 *   启动时保存的矩形与某个显示器工作区相交不足一半就不用（外接屏拔掉后窗口不会跑到屏幕外），回到居中；
 * - 默认窗口化：只有上次关闭时是最大化才恢复最大化。
 *
 * 纯函数（initialBounds / minSize / overlapRatio / restoreBounds）不依赖 Electron，用例直接调；
 * attachWindowState 只接 BrowserWindow 的事件与 fs，主进程窗口创建段调用。
 */
const fs = require("node:fs");
const path = require("node:path");

const LIMITS = Object.freeze({ minW: 960, maxW: 1440, minH: 640, maxH: 900, floorW: 960, floorH: 600, ratioW: 0.82, ratioH: 0.86 });

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isRect = (r) => !!r && [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n)) && r.width > 0 && r.height > 0;

/** 最小尺寸：960×600，且不超过工作区。 */
function minSize(wa) {
  return { minWidth: Math.min(LIMITS.floorW, Math.floor(wa.width)), minHeight: Math.min(LIMITS.floorH, Math.floor(wa.height)) };
}

/** 初始矩形：工作区 82%×86%，夹到 960～1440 × 640～900，再不超过工作区；在工作区内居中。 */
function initialBounds(wa) {
  const width = Math.min(clamp(Math.round(wa.width * LIMITS.ratioW), LIMITS.minW, LIMITS.maxW), Math.floor(wa.width));
  const height = Math.min(clamp(Math.round(wa.height * LIMITS.ratioH), LIMITS.minH, LIMITS.maxH), Math.floor(wa.height));
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

/** rect 落在 area 里的面积占 rect 自身面积的比例（0～1）。 */
function overlapRatio(rect, area) {
  if (!isRect(rect) || !isRect(area)) return 0;
  const w = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const h = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (rect.width * rect.height);
}

/**
 * 启动时的窗口矩形：保存的矩形与某个显示器工作区相交 ≥ 一半 → 用它（尺寸再夹到那块工作区与最小尺寸之间）；
 * 否则在 fallback 工作区（鼠标所在屏）按 initialBounds 居中。返回 { bounds, maximized, workArea }。
 */
function restoreBounds(saved, workAreas, fallback) {
  const s = saved && typeof saved === "object" ? saved : null;
  if (s && isRect(s)) {
    let best = null;
    let bestRatio = 0;
    for (const wa of workAreas || []) {
      const r = overlapRatio(s, wa);
      if (r > bestRatio) {
        bestRatio = r;
        best = wa;
      }
    }
    if (best && bestRatio >= 0.5) {
      const m = minSize(best);
      const width = clamp(Math.round(s.width), m.minWidth, Math.floor(best.width));
      const height = clamp(Math.round(s.height), m.minHeight, Math.floor(best.height));
      const x = clamp(Math.round(s.x), best.x, best.x + best.width - width);
      const y = clamp(Math.round(s.y), best.y, best.y + best.height - height);
      return { bounds: { x, y, width, height }, maximized: s.maximized === true, workArea: best };
    }
  }
  return { bounds: initialBounds(fallback), maximized: !!s && s.maximized === true, workArea: fallback };
}

function readState(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  } catch {
    // 写不进（磁盘满、权限）：下次启动按缺省居中，不影响使用
  }
}

/**
 * 窗口创建前调用：读 userData/window-state.json，按当前显示器算出 BrowserWindow 的尺寸选项。
 * screen 是 Electron 的 screen 模块（ready 之后才能用）。
 */
function windowOptions(screen, file) {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const fallback = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const r = restoreBounds(readState(file), displays, fallback);
  return { ...r.bounds, ...minSize(r.workArea), maximized: r.maximized };
}

/** 窗口创建后调用：防抖记下位置 / 尺寸 / 最大化；最大化时只改标记、保留还原尺寸。 */
function attachWindowState(win, file, delayMs = 500) {
  let timer = null;
  let normal = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
  const flush = () => {
    timer = null;
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    if (!maximized && !win.isMinimized() && !win.isFullScreen()) normal = win.getBounds();
    writeState(file, { ...normal, maximized });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, schedule);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    flush();
  });
}

module.exports = { LIMITS, minSize, initialBounds, overlapRatio, restoreBounds, windowOptions, attachWindowState, readState, writeState };

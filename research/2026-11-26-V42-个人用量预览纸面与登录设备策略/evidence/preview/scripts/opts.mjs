// 预览纸面方案原型：frame(dark, name) 返回追加进隔离框架 <head> 末尾的样式；parent 为父页面（Markdown 草稿）样式
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .32 0 0 0 0 .28 0 0 0 0 .22 .11 0 0 0 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";
const dots = (c, s = 20) => `background-image:radial-gradient(circle,${c} 1px,transparent 1.3px);background-size:${s}px ${s}px;background-position:${s / 2}px ${s / 2}px;`;
const darkRoot = "html{color-scheme:dark;}.kwl-paper{color-scheme:light;}";
const sheetMd = (canvas, sheet, extra = "") => `
.dlp .sp-md{padding:28px 24px 48px;background:${canvas};}
.dlp .sp-md>.md{box-sizing:border-box;max-width:760px;margin:0 auto;padding:40px 48px;background:${sheet};${extra}}`;

function mk({ canvasL, canvasD, paperL = "", paperD = "", sheetL = "", sheetD = "", mdL, mdD }) {
  return {
    frame(dark, name) {
      const canvas = dark ? canvasD : canvasL;
      if (name === "xlsx") return `html,body{${canvas}}` + (dark ? "html{color-scheme:dark;}" : "");
      return `html,body{${canvas}}.kwl-paper{${dark ? paperD : paperL}}` + (dark ? darkRoot : "");
    },
    parent: mdL + `\n:root[data-theme="dark"] ${mdD.trim().replace(/\n\.dlp/g, "\n:root[data-theme=\"dark\"] .dlp")}`,
  };
}

// A 纸张噪点肌理：暖灰画布，纸面 feTurbulence 细颗粒（data:image/svg+xml，img-src data: 允许）
export const A = mk({
  canvasL: "background:#ebe8e4;",
  canvasD: "background:#141312;",
  paperL: `background:#ffffff ${NOISE};border:1px solid #e3dfda;box-shadow:0 1px 6px rgba(14,18,25,.06);`,
  paperD: `background:#ffffff ${NOISE};border:0;box-shadow:0 0 0 1px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.45);`,
  mdL: sheetMd("#ebe8e4", `#ffffff ${NOISE}`, "border:1px solid #e3dfda;"),
  mdD: sheetMd("#141312", `#211f1e`, "border:1px solid #302e2b;"),
});

// B 画布细点阵 + 纯净白纸：点阵只在画布，纸面纯白
export const B = mk({
  canvasL: "background-color:#f4f3f2;" + dots("rgba(14,18,25,.16)", 16),
  canvasD: "background-color:#161514;" + dots("rgba(255,255,255,.08)", 16),
  paperL: "border:1px solid #e3dfda;box-shadow:0 1px 6px rgba(14,18,25,.06);",
  paperD: "border:0;box-shadow:0 0 0 1px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.45);",
  mdL: sheetMd(`#f4f3f2;${dots("rgba(14,18,25,.16)", 16)}`, "#ffffff", "border:1px solid #e3dfda;box-shadow:0 1px 6px rgba(14,18,25,.06);"),
  mdD: sheetMd(`#161514;${dots("rgba(255,255,255,.08)", 16)}`, "#211f1e", "border:1px solid #302e2b;"),
});

// C 纸面极浅横线 + 页边线（信笺/草稿纸）
const RULE_L = "background:#ffffff repeating-linear-gradient(to bottom,transparent 0,transparent 27px,rgba(10,102,209,.09) 27px,rgba(10,102,209,.09) 28px);background-position:0 72px;box-shadow:inset 56px 0 0 -55px rgba(180,35,24,.22),0 1px 6px rgba(14,18,25,.06);border:1px solid #e3dfda;";
export const C = mk({
  canvasL: "background:#ebe8e4;",
  canvasD: "background:#141312;",
  paperL: RULE_L,
  paperD: RULE_L.replace("border:1px solid #e3dfda;", "border:0;"),
  mdL: sheetMd("#ebe8e4", "#ffffff repeating-linear-gradient(to bottom,transparent 0,transparent 27px,rgba(10,102,209,.09) 27px,rgba(10,102,209,.09) 28px)", "border:1px solid #e3dfda;"),
  mdD: sheetMd("#141312", "#211f1e", "border:1px solid #302e2b;"),
});

// D 暖灰画布 + 纸张分层投影（无描边）与纸边
const LIFT_L = "border:0;box-shadow:0 0 0 1px rgba(14,18,25,.05),0 1px 2px rgba(14,18,25,.06),0 6px 20px -6px rgba(14,18,25,.14);";
const LIFT_D = "border:0;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 2px 4px rgba(0,0,0,.35),0 14px 36px -8px rgba(0,0,0,.6);";
export const D = mk({
  canvasL: "background:#ebe8e4;",
  canvasD: "background:#141312;",
  paperL: LIFT_L,
  paperD: LIFT_D,
  mdL: sheetMd("#ebe8e4", "#ffffff", LIFT_L),
  mdD: sheetMd("#141312", "#211f1e", "border:0;box-shadow:0 0 0 1px rgba(255,255,255,.06),0 10px 30px -8px rgba(0,0,0,.6);"),
});

// E 组合：D 的分层投影 + 画布极淡点阵（20px、更轻），纸面纯白
export const E = mk({
  canvasL: "background-color:#efedea;" + dots("rgba(14,18,25,.12)", 20),
  canvasD: "background-color:#161514;" + dots("rgba(255,255,255,.07)", 20),
  paperL: LIFT_L,
  paperD: LIFT_D,
  mdL: sheetMd(`#efedea;${dots("rgba(14,18,25,.12)", 20)}`, "#ffffff", LIFT_L),
  mdD: sheetMd(`#161514;${dots("rgba(255,255,255,.07)", 20)}`, "#211f1e", "border:0;box-shadow:0 0 0 1px rgba(255,255,255,.06),0 10px 30px -8px rgba(0,0,0,.6);"),
});

/**
 * 最小 XLSX 写入器（inline string，免 sharedStrings）：合同台账/差异表/矩阵的交付格式。
 * Word/WPS/Excel/Numbers 均可打开；公式以字符串形式写入（= 开头）。
 * 第 34 批（独立律师验收：交付的 Excel 全是“裸表”，长文字挤在默认列宽里要手工调）：首行作表头（加粗、底色、换行、冻结），
 * 正文换行、细边框、顶端对齐，金额千分位；列宽按前 500 行的文字宽度估（中文按两个字宽）。
 */
import { readZipEntries, writeZip } from "./zip.ts";
import { escapeXml, unescapeXml } from "./textmap.ts";

export interface SheetSpec {
  name: string;
  rows: (string | number | null)[][];
}

const CT = (sheetCount: number) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/** 样式：0 默认；1 表头；2 正文文字；3 整数（千分位）；4 小数（千分位两位）；5 小整数（序号、日数、年份，不加千分位）。 */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="10.5"/><name val="等线"/><family val="2"/><charset val="134"/></font><font><b/><sz val="10.5"/><name val="等线"/><family val="2"/><charset val="134"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** 数字的样式：带小数的两位千分位；一万以上的整数千分位；小整数（序号、日数、年份）原样。 */
const numStyle = (n: number) => (!Number.isInteger(n) ? 4 : Math.abs(n) >= 10000 ? 3 : 5);

/** 文字显示宽度（中文与全角按 2）。 */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\uFFFF]/.test(ch) && !/[\uFF61-\uFF9F]/.test(ch) ? 2 : 1;
  return w;
}

/** 列宽：每列取前 500 行里最宽一行（多行文字取最长一行），加边距，限制在 6～60 之间；长文字靠换行。 */
function colsXml(rows: SheetSpec["rows"]): string {
  const widths: number[] = [];
  for (const row of rows.slice(0, 500)) {
    row.forEach((cell, ci) => {
      if (cell === null || cell === undefined || cell === "") return;
      // 按单元格实际显示估宽：小整数不加千分位（与 numStyle 一致）
      const text = typeof cell === "number" ? (numStyle(cell) === 5 ? String(cell) : cell.toLocaleString("en-US", { minimumFractionDigits: numStyle(cell) === 4 ? 2 : 0, maximumFractionDigits: 2 })) : String(cell);
      const w = Math.max(...text.split(/\r?\n/).map(textWidth));
      widths[ci] = Math.max(widths[ci] ?? 0, w);
    });
  }
  if (widths.length === 0) return "";
  return `<cols>${Array.from(widths, (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(6, (w ?? 0) + 2))}" customWidth="1"/>`).join("")}</cols>`;
}

function colName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 逐行编码成字节再拼接（十几万行的时间轴不再先拼成一个几十 MB 的字符串，峰值内存降一个量级）。 */
/** 表的范围（首行表头 + 数据）：列数取最宽的一行；空表返回 null。 */
function sheetRange(spec: SheetSpec): { cols: number; rows: number } | null {
  const cols = spec.rows.reduce((n, r) => Math.max(n, r.length), 0);
  return cols > 0 && spec.rows.length > 0 ? { cols, rows: spec.rows.length } : null;
}

/** 宽表横向打印（第 35 批，文档工程审查 E-01）：多于 5 列，或估算总列宽超过 A4 纵向可印宽度。 */
function totalWidth(spec: SheetSpec): number {
  return [...colsXml(spec.rows).matchAll(/width="([\d.]+)"/g)].reduce((n, m) => n + Number(m[1]), 0);
}

function landscape(spec: SheetSpec): boolean {
  const r = sheetRange(spec);
  if (!r) return false;
  return r.cols > 5 || totalWidth(spec) > 95;
}

/**
 * 打印几页宽（V10 第 36 批；V9.6 R6 律师评分：起草说明表横向缩到一页宽，打印出来字太小看不清）：A4 横向 100% 约容 145 个列宽单位，
 * 缩放不低于约七成即一页最多约 207 个单位——在此以内缩到一页宽，更宽的按每页约 207 个单位分几页宽打印（每页重复表头行与首列）。
 */
export const PRINT_WIDTH_PER_PAGE = 207;
export function printPagesWide(spec: SheetSpec): number {
  return Math.max(1, Math.ceil(totalWidth(spec) / PRINT_WIDTH_PER_PAGE));
}

function sheetXml(spec: SheetSpec): Buffer {
  // 首行是表头时冻结（多于一行才冻结，单行表不冻）
  const freeze = spec.rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  // 打印（第 35 批，文档工程审查 E-01：证据目录、问题清单打出来表头不重复、宽表被拆到几页）：缩到一页宽、高度不限
  const parts: Buffer[] = [Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${freeze}${colsXml(spec.rows)}<sheetData>`, "utf8")];
  spec.rows.forEach((row, ri) => {
    let cells = "";
    row.forEach((cell, ci) => {
      if (cell === null || cell === undefined || cell === "") return;
      const ref = `${colName(ci)}${ri + 1}`;
      const s = ri === 0 ? 1 : typeof cell === "number" ? numStyle(cell) : 2;
      cells += typeof cell === "number" ? `<c r="${ref}" s="${s}"><v>${cell}</v></c>` : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`;
    });
    parts.push(Buffer.from(`<row r="${ri + 1}">${cells}</row>`, "utf8"));
  });
  // 表头筛选、页边距、纸张方向与页脚页码（元素顺序按 CT_Worksheet：autoFilter → pageMargins → pageSetup → headerFooter）
  const r = sheetRange(spec);
  const filter = r && r.rows > 1 ? `<autoFilter ref="A1:${colName(r.cols - 1)}${r.rows}"/>` : "";
  const print = `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="${landscape(spec) ? "landscape" : "portrait"}" fitToWidth="${printPagesWide(spec)}" fitToHeight="0"/><headerFooter><oddFooter>&amp;C第 &amp;P 页，共 &amp;N 页</oddFooter></headerFooter>`;
  parts.push(Buffer.from(`</sheetData>${filter}${print}</worksheet>`, "utf8"));
  return Buffer.concat(parts);
}

/** 工作簿里的打印标题与筛选范围（每张表：打印时每页重复首行；有筛选的登记筛选范围）。 */
function definedNamesXml(sheets: SheetSpec[]): string {
  const names: string[] = [];
  sheets.forEach((s, i) => {
    const r = sheetRange(s);
    if (!r || r.rows < 2) return;
    const q = `'${s.name.slice(0, 31).replace(/'/g, "''")}'`;
    names.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${escapeXml(`${q}!$A$1:$${colName(r.cols - 1)}$${r.rows}`)}</definedName>`);
    // 分几页宽打印时每页同时重复首列（行名），否则后几页只剩数字看不出是哪一行
    names.push(`<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${escapeXml(printPagesWide(s) > 1 ? `${q}!$A:$A,${q}!$1:$1` : `${q}!$1:$1`)}</definedName>`);
  });
  return names.length > 0 ? `<definedNames>${names.join("")}</definedNames>` : "";
}

export function createXlsx(sheets: SheetSpec[]): Buffer {
  if (sheets.length === 0) throw new Error("至少一个 sheet");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets>${definedNamesXml(sheets)}</workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CT(sheets.length), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES, "utf8") },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

/** 列字母转序号（A→0，Z→25，AA→26）。 */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 读回本文件 createXlsx 写出的工作簿（V16 第 41 批：xlsx.edit_cells 在已生成的表格上逐格修改，不再整份重出）。
 * 只认本写入器的写法：文字为 t="inlineStr"，数字为 <v>；按 r="B3" 的列字母定位，中间的空格补 null；表名从 xl/workbook.xml 读。
 * 不是本写入器写的（有 sharedStrings、公式、别的单元格类型、行号或格子位置对不上）一律返回 null——律师上传的 Excel 不在此列。
 * 首行（表头）在 rows[0]；空串与 null 都读成 null（写入时两者都不写格子）。
 */
export function readCreatedXlsx(buf: Buffer): SheetSpec[] | null {
  let entries: Map<string, Buffer>;
  try {
    entries = readZipEntries(buf);
  } catch {
    return null;
  }
  if (entries.has("xl/sharedStrings.xml")) return null;
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8");
  if (!workbook) return null;
  const names = [...workbook.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)" r:id="rId(\d+)"\/>/g)];
  if (names.length === 0) return null;
  const out: SheetSpec[] = [];
  for (let i = 0; i < names.length; i++) {
    const m = names[i]!;
    if (Number(m[2]) !== i + 1 || Number(m[3]) !== i + 1) return null;
    const xml = entries.get(`xl/worksheets/sheet${i + 1}.xml`)?.toString("utf8");
    if (!xml) return null;
    const data = /<sheetData>([\s\S]*)<\/sheetData>/.exec(xml)?.[1];
    if (data === undefined || /<f[\s>]/.test(data)) return null;
    const rows: (string | number | null)[][] = [];
    // 每行按 <row r="n">…</row> 读；行号必须从 1 起连续（本写入器每行都写，空行写成空 <row>）
    const rowRe = /<row r="(\d+)">([\s\S]*?)<\/row>/g;
    let consumed = "";
    for (const rm of data.matchAll(rowRe)) {
      consumed += rm[0];
      if (Number(rm[1]) !== rows.length + 1) return null;
      const row: (string | number | null)[] = [];
      let rest = rm[2]!;
      const cellRe = /^<c r="([A-Z]+)(\d+)" s="\d+"( t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t xml:space="preserve">([^<]*)<\/t><\/is>)<\/c>/;
      while (rest.length > 0) {
        const cm = cellRe.exec(rest);
        if (!cm || Number(cm[2]) !== rows.length + 1) return null;
        const ci = colIndex(cm[1]!);
        if (ci < row.length) return null;
        while (row.length < ci) row.push(null);
        if (cm[3]) {
          if (cm[5] === undefined) return null;
          const t = unescapeXml(cm[5]);
          row.push(t === "" ? null : t);
        } else {
          if (cm[4] === undefined) return null;
          const n = Number(cm[4]);
          if (!Number.isFinite(n)) return null;
          row.push(n);
        }
        rest = rest.slice(cm[0].length);
      }
      rows.push(row);
    }
    if (consumed !== data) return null;
    out.push({ name: unescapeXml(m[1]!), rows });
  }
  return out;
}

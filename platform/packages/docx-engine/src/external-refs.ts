/**
 * Office 打开零外部请求（v9 第 04 篇 §1.2 第 3 条“渲染与 Office 打开 Agent 产物零外部请求”、§5.1 ④“交 Office 前剥离”、§11 P5）。
 *
 * 本产品写出的每个 OOXML 包（DOCX/XLSX，经 writeZip）在写出前去除“打开时会自动发起外部请求”的引用：
 * - 外部关系（TargetMode="External"，或目标是 URL / UNC / file: / 盘符路径）：附加模板、链接图片、OLE 链接、子文档、框架、
 *   外部工作簿、邮件合并数据源等——**超链接保留**（只有律师点击才访问）；引用被删关系的元素或属性一并去除；
 * - 域：INCLUDEPICTURE / INCLUDETEXT / INCLUDE / LINK / DDE / DDEAUTO / IMPORT（简单域解包为结果文本、按嵌套逐层处理；复杂域清空域代码）；
 * - 任意元素上值为外部地址的 href / src 属性（VML 的 o:href、src 等）；
 * - 文档设置：打开时更新域（updateFields）、随模板更新样式（linkStyles）、附加模板、邮件合并；
 * - XLSX：外部工作簿链接（externalReferences）与数据连接（connections；查询表只报告）。
 * 匹配不依赖命名空间前缀与部件名大小写（复核 S5-B13：XML 前缀可任意绑定、OPC 部件名不区分大小写）。
 * 修订稿、清洁稿等由原件派生的文件同样经过（原件里的这类引用不随成果带出）；原件本身不改动。
 */

export interface ExternalRefFinding {
  part: string;
  kind: string;
  target?: string;
}

const REL_PART = /(^|\/)_rels\/([^/]*)\.rels$/i;
const HYPERLINK_TYPE = /\/hyperlink$/i;
const URLISH = /^\s*(?:[a-z][a-z0-9+.-]*:|\\\\|\/\/)/i;
/** 打开或刷新时会取外部内容的域（大小写不敏感，域名后须为空白、引号或结束）。 */
const FETCHING_FIELD = /^\s*(?:INCLUDEPICTURE|INCLUDETEXT|INCLUDE|LINK|DDEAUTO|DDE|IMPORT)(?=[\s"\\]|$)/i;
/** 任意命名空间前缀（含无前缀）。 */
const P = "(?:[A-Za-z_][\\w.-]*:)?";

const HREF_SRC_ATTR = new RegExp(`\\s${P}(?:href|src)\\s*=\\s*("([^"]*)"|'([^']*)')`, "g");

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 取属性值（按本地名，前缀任意；单双引号均可）。 */
function attr(tag: string, local: string): string | null {
  const m = new RegExp(`\\s${P}${escapeRe(local)}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** 关系文件对应的源部件：word/_rels/document.xml.rels → word/document.xml；_rels/.rels → 包本身（null）。 */
function sourcePartOf(relsName: string): string | null {
  const m = REL_PART.exec(relsName);
  if (!m || m[2] === "") return null;
  return `${relsName.slice(0, m.index + m[1]!.length)}${m[2]}`;
}

function isExternalRel(tag: string): boolean {
  const mode = attr(tag, "TargetMode");
  const target = decodeXml(attr(tag, "Target") ?? "");
  return (mode !== null && /^\s*external\s*$/i.test(mode)) || URLISH.test(target);
}

function isXmlPart(name: string): boolean {
  return /\.(xml|rels|vml)$/i.test(name);
}

/** 按名称不区分大小写查找部件（OPC 部件名不区分大小写）。 */
function findPart(files: Map<string, Buffer>, name: string): string | undefined {
  if (files.has(name)) return name;
  const lower = name.toLowerCase();
  for (const k of files.keys()) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** 只检查、不修改：列出包内所有“打开时会外取”的引用（测试与登记前复核用）。 */
export function findExternalRefs(files: ReadonlyMap<string, Buffer>): ExternalRefFinding[] {
  return scan(new Map(files), false);
}

/** 原地去除（files 被修改）；返回被去除的引用清单。 */
export function stripExternalRefs(files: Map<string, Buffer>): ExternalRefFinding[] {
  return scan(files, true);
}

function scan(files: Map<string, Buffer>, strip: boolean): ExternalRefFinding[] {
  const found: ExternalRefFinding[] = [];
  const text = (n: string) => files.get(n)?.toString("utf8");
  const put = (n: string, s: string) => {
    if (strip) files.set(n, Buffer.from(s, "utf8"));
  };

  // 1) 关系：去除外部关系（超链接除外），记下源部件中被删的关系 ID
  const removedIds = new Map<string, Set<string>>();
  for (const name of [...files.keys()]) {
    if (!REL_PART.test(name)) continue;
    const xml = text(name)!;
    let changed = false;
    const out = xml.replace(new RegExp(`<(${P})Relationship\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/\\1Relationship>)`, "g"), (tag) => {
      if (!isExternalRel(tag)) return tag;
      const type = attr(tag, "Type") ?? "";
      if (HYPERLINK_TYPE.test(type)) return tag;
      const srcName = sourcePartOf(name);
      const src = srcName ? (findPart(files, srcName) ?? srcName) : null;
      found.push({ part: src ?? name, kind: `relationship:${type.split("/").pop() ?? type}`, target: decodeXml(attr(tag, "Target") ?? "") });
      const id = attr(tag, "Id");
      if (id && src) {
        if (!removedIds.has(src)) removedIds.set(src, new Set());
        removedIds.get(src)!.add(id);
      }
      changed = true;
      return "";
    });
    if (changed) put(name, out);
  }

  // 2) 引用被删关系的元素与属性
  for (const [part, ids] of removedIds) {
    let xml = text(part);
    if (xml === undefined) continue;
    const idAlt = [...ids].map(escapeRe).join("|");
    const ref = `\\s${P}(?:id|link|href|pict|embed)\\s*=\\s*(?:"(?:${idAlt})"|'(?:${idAlt})')`;
    // 整体去除：附加模板、子文档、框架源、OLE 链接对象、外部 altChunk、邮件合并数据源
    for (const el of ["attachedTemplate", "subDoc", "sourceFileName", "altChunk", "OLEObject", "dataSource", "headerSource", "recipientData"]) {
      const re = new RegExp(`<(${P})${el}\\b[^>]*${ref}[^>]*?(?:\\/>|>[\\s\\S]*?<\\/\\1${el}>)`, "g");
      xml = xml.replace(re, "");
    }
    // 其余引用：去除属性（链接图片 a:blip r:link、VML r:id/r:href 等；嵌入的 r:embed 不受影响，因为被删的只有外部关系）
    xml = xml.replace(new RegExp(ref, "g"), "");
    put(part, xml);
  }

  for (const name of [...files.keys()]) {
    if (!isXmlPart(name) || REL_PART.test(name)) continue;
    const orig = text(name)!;
    let xml = orig;

    // 3) 值为外部地址的 href / src 属性（VML 的 o:href、src 等；任意元素、任意前缀）
    // 大表格（十几万行的时间轴）逐标签扫描：正则只建一次；不含 href / src 的标签原样返回（属性名区分大小写，与正则同一口径）
    if (xml.includes("href") || xml.includes("src")) xml = xml.replace(/<[A-Za-z_][\w.:-]*\b[^>]*>/g, (tag) =>
      !tag.includes("href") && !tag.includes("src") ? tag : tag.replace(HREF_SRC_ATTR, (m, _q, a, b) => {
        const v = decodeXml(a ?? b ?? "");
        if (!URLISH.test(v)) return m;
        found.push({ part: name, kind: "vml_href", target: v });
        return "";
      }),
    );

    // 4) 域
    if (/^word\//i.test(name)) {
      xml = unwrapFetchingSimpleFields(xml, (code) => found.push({ part: name, kind: "field", target: code.trim().slice(0, 200) }));
      xml = blankFetchingComplexFields(xml, (code) => found.push({ part: name, kind: "field", target: code.trim().slice(0, 200) }));
    }

    // 5) 文档设置
    if (/^word\/settings\.xml$/i.test(name)) {
      for (const [re, kind] of [
        [new RegExp(`<${P}updateFields\\b[^>]*\\/>`, "g"), "settings:updateFields"],
        [new RegExp(`<${P}linkStyles\\b[^>]*\\/>`, "g"), "settings:linkStyles"],
        [new RegExp(`<${P}attachedTemplate\\b[^>]*\\/>`, "g"), "settings:attachedTemplate"],
        [new RegExp(`<(${P})mailMerge\\b[\\s\\S]*?<\\/\\1mailMerge>`, "g"), "settings:mailMerge"],
      ] as const) {
        xml = xml.replace(re, (m) => {
          // updateFields val="false" 不会触发更新
          if (kind === "settings:updateFields" && new RegExp(`${P}val\\s*=\\s*["'](?:false|0|off)["']`).test(m)) return m;
          found.push({ part: name, kind });
          return "";
        });
      }
    }
    if (xml !== orig) put(name, xml);
  }

  // 6) XLSX：外部工作簿链接与数据连接
  if (findPart(files, "xl/workbook.xml") !== undefined) xlsxExternal(files, found, strip);

  return found;
}

/**
 * 简单域（fldSimple，可嵌套）：按开闭标签配对后逐个判断，外取类的解包为结果文本（内层照常判断；复核 S5-B13）。
 */
function unwrapFetchingSimpleFields(xml: string, onFound: (code: string) => void): string {
  const tokenRe = new RegExp(`<(${P})fldSimple\\b([^>]*?)(\\/?)>|<\\/(${P})fldSimple>`, "g");
  interface Open {
    start: number;
    end: number;
    instr: string;
  }
  const stack: Open[] = [];
  const cuts: { start: number; end: number }[] = [];
  for (let m = tokenRe.exec(xml); m; m = tokenRe.exec(xml)) {
    if (m[0].startsWith("</")) {
      const open = stack.pop();
      if (open && FETCHING_FIELD.test(open.instr)) {
        onFound(open.instr);
        cuts.push({ start: open.start, end: open.end }, { start: m.index, end: m.index + m[0].length });
      }
      continue;
    }
    const instr = decodeXml(attr(`<x${m[2] ?? ""}>`, "instr") ?? "");
    if (m[3] === "/") {
      // 自闭合：没有结果文本，整个去除
      if (FETCHING_FIELD.test(instr)) {
        onFound(instr);
        cuts.push({ start: m.index, end: m.index + m[0].length });
      }
      continue;
    }
    stack.push({ start: m.index, end: m.index + m[0].length, instr });
  }
  if (cuts.length === 0) return xml;
  cuts.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const c of cuts) out = out.slice(0, c.start) + out.slice(c.end);
  return out;
}

/**
 * 复杂域（fldChar begin … separate … end，可嵌套、域代码可分在多个 instrText 中）：
 * 域代码以外取域名开头的，清空该域自身的 instrText（结果文本保留；嵌套的子域按各自的代码判断）。
 */
function blankFetchingComplexFields(xml: string, onFound: (code: string) => void): string {
  // 自闭合的 instrText 须先于带内容的写法匹配（否则会吞到下一个结束标签）
  const tokenRe = new RegExp(
    `<${P}fldChar\\b[^>]*?${P}fldCharType\\s*=\\s*["'](begin|separate|end)["'][^>]*>|<${P}instrText\\b[^>]*\\/>|<(${P}instrText)\\b([^>]*)>([\\s\\S]*?)<\\/${P}instrText>`,
    "g",
  );
  interface Field {
    code: string;
    instr: { start: number; end: number; tag: string; attrs: string }[];
    inCode: boolean;
  }
  const stack: Field[] = [];
  const blank: { start: number; end: number; tag: string; attrs: string }[] = [];
  const settle = (f: Field) => {
    if (FETCHING_FIELD.test(decodeXml(f.code))) {
      onFound(decodeXml(f.code));
      blank.push(...f.instr);
    }
  };
  for (let m = tokenRe.exec(xml); m; m = tokenRe.exec(xml)) {
    const kind = m[1];
    if (kind === "begin") stack.push({ code: "", instr: [], inCode: true });
    else if (kind === "separate") {
      const top = stack[stack.length - 1];
      if (top && top.inCode) {
        top.inCode = false;
        settle(top);
      }
    } else if (kind === "end") {
      const top = stack.pop();
      if (top && top.inCode) settle(top);
    } else if (m[4] !== undefined) {
      const top = stack[stack.length - 1];
      if (top && top.inCode) {
        top.code += m[4];
        top.instr.push({ start: m.index, end: m.index + m[0].length, tag: m[2] ?? "w:instrText", attrs: m[3] ?? "" });
      }
    }
  }
  // 未闭合的域：按已收集的代码判断
  for (const f of stack) if (f.inCode) settle(f);
  if (blank.length === 0) return xml;
  blank.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const b of blank) out = `${out.slice(0, b.start)}<${b.tag}${b.attrs}></${b.tag}>${out.slice(b.end)}`;
  return out;
}

function xlsxExternal(files: Map<string, Buffer>, found: ExternalRefFinding[], strip: boolean): void {
  const drop = new Set<string>();
  for (const name of files.keys()) {
    if (/^xl\/externalLinks\/[^/]+\.xml$/i.test(name)) {
      found.push({ part: name, kind: "xlsx:externalLink" });
      drop.add(name);
    }
    if (/^xl\/connections\.xml$/i.test(name)) {
      found.push({ part: name, kind: "xlsx:connections" });
      drop.add(name);
    }
    // 查询表依赖数据连接：连接去除后不能刷新（不外取），部件保留、只报告
    if (/^xl\/queryTables\/[^/]+\.xml$/i.test(name)) found.push({ part: name, kind: "xlsx:queryTable" });
  }
  if (!strip || drop.size === 0) return;
  const dropLower = new Set([...drop].map((d) => d.toLowerCase()));
  for (const name of [...files.keys()]) {
    const lower = name.toLowerCase();
    if (dropLower.has(lower)) files.delete(name);
    // 被删部件自身的关系文件
    const m = REL_PART.exec(name);
    if (m && m[2] && dropLower.has(`${name.slice(0, m.index + m[1]!.length)}${m[2]}`.toLowerCase())) files.delete(name);
  }
  // 引用这些部件的关系（工作簿与工作表的 rels）与内容类型
  const targetsDropped = (target: string, relsName: string) => {
    const m = REL_PART.exec(relsName);
    const base = m ? relsName.slice(0, m.index + m[1]!.length) : "";
    const resolved = target.startsWith("/") ? target.slice(1) : normalize(`${base}${target}`);
    return dropLower.has(resolved.toLowerCase());
  };
  for (const name of [...files.keys()]) {
    if (!REL_PART.test(name)) continue;
    const xml = files.get(name)!.toString("utf8");
    const removed: string[] = [];
    const out = xml.replace(new RegExp(`<${P}Relationship\\b[^>]*?\\/>`, "g"), (tag) => {
      const target = decodeXml(attr(tag, "Target") ?? "");
      if (!targetsDropped(target, name)) return tag;
      const id = attr(tag, "Id");
      if (id) removed.push(id);
      return "";
    });
    if (out !== xml) {
      files.set(name, Buffer.from(out, "utf8"));
      const srcName = sourcePartOf(name);
      const src = srcName ? findPart(files, srcName) : undefined;
      const srcXml = src ? files.get(src)?.toString("utf8") : undefined;
      if (src && srcXml !== undefined && removed.length) {
        const idAlt = removed.map(escapeRe).join("|");
        let s = srcXml.replace(new RegExp(`<${P}externalReference\\b[^>]*${P}id\\s*=\\s*["'](?:${idAlt})["'][^>]*\\/>`, "g"), "");
        s = s.replace(new RegExp(`<(${P})externalReferences\\b[^>]*>\\s*<\\/\\1externalReferences>`, "g"), "").replace(new RegExp(`<${P}externalReferences\\b[^>]*\\/>`, "g"), "");
        files.set(src, Buffer.from(s, "utf8"));
      }
    }
  }
  const ctName = findPart(files, "[Content_Types].xml");
  const ct = ctName ? files.get(ctName)?.toString("utf8") : undefined;
  if (ctName && ct !== undefined) {
    const out = ct.replace(new RegExp(`<${P}Override\\b[^>]*PartName\\s*=\\s*["']\\/([^"']+)["'][^>]*\\/>`, "g"), (tag, part: string) => (dropLower.has(part.toLowerCase()) ? "" : tag));
    files.set(ctName, Buffer.from(out, "utf8"));
  }
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

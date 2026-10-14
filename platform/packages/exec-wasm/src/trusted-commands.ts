/**
 * W-core 可信命令（v9 第 04 篇 §4.1：`kwl-*` → 可信命令；DOCX 读写走 kwl-docx，python-docx 依赖 lxml 不在 W-core 内）。
 *
 * 在 W worker 内运行（同一 Node 权限限制：无网、无子进程），经 just-bash 命令上下文读写虚拟文件系统——写入与模型自己的
 * 命令一样留在内存层，结束后经文件 broker 校验提交。实现复用文书引擎（@zr-legal/docx-engine：ZIP 读取有压缩炸弹与路径穿越防护）。
 *
 * G0 范围：kwl-docx（text / create / compare）、kwl-xlsx（create / from-csv）。修订稿生成、法规条文查询（须经宿主转内核端点）、
 * 金额与期限计算器（须律所确认口径）随后续阶段。
 */
import { compareDocx, createDocx, createXlsx, extractParagraphs, type ReportSection } from "@zr-legal/docx-engine";

interface Ctx {
  fs: {
    resolvePath(base: string, path: string): string;
    readFileBuffer(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array | string): Promise<void>;
  };
  cwd: string;
  stdin: string;
}

interface Out {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Define = (name: string, execute: (args: string[], ctx: Ctx) => Promise<Out>) => unknown;

const ok = (stdout: string): Out => ({ stdout, stderr: "", exitCode: 0 });
const fail = (msg: string, code = 1): Out => ({ stdout: "", stderr: `${msg}\n`, exitCode: code });

/** just-bash 的 stdin 是 latin1 字节串：按 UTF-8 解码。 */
const stdinText = (ctx: Ctx): string => Buffer.from(ctx.stdin ?? "", "latin1").toString("utf8");

const DOCX_HELP = `用法：
  kwl-docx text <文件.docx>                 输出段落文本（每段一行）
  kwl-docx create <输出.docx> [标题] < 文本   由标准输入生成 DOCX："## " 开头的行为小节标题，其余非空行为段落
  kwl-docx compare <原.docx> <新.docx>       段落级比对（新增/删除/修改；标出未留修订痕迹的改动）
`;

const XLSX_HELP = `用法：
  kwl-xlsx create <输出.xlsx> [工作表名] < CSV   由标准输入的 CSV 生成 XLSX（数值列写为数字）
  kwl-xlsx from-csv <输入.csv> <输出.xlsx> [工作表名]
`;

/** 最小 CSV 解析（RFC 4180：引号、转义引号、引号内换行）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const NUMERIC = /^-?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/;

function csvToXlsx(csv: string, sheet: string): Buffer {
  const rows = parseCsv(csv).map((r) => r.map((v) => (NUMERIC.test(v.trim()) ? Number(v.trim().replaceAll(",", "")) : v)));
  return createXlsx([{ name: sheet, rows }]);
}

async function readBytes(ctx: Ctx, p: string): Promise<Buffer> {
  return Buffer.from(await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, p)));
}

async function writeBytes(ctx: Ctx, p: string, data: Buffer): Promise<void> {
  await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, p), new Uint8Array(data));
}

export function trustedCommands(define: Define): unknown[] {
  const docx = define("kwl-docx", async (args, ctx) => {
    const [sub, a, b] = args;
    try {
      if (!sub || sub === "--help" || sub === "-h") return ok(DOCX_HELP);
      if (sub === "text") {
        if (!a) return fail("kwl-docx text：需要 DOCX 文件", 2);
        return ok(`${extractParagraphs(await readBytes(ctx, a)).map((p) => p.text).join("\n")}\n`);
      }
      if (sub === "create") {
        if (!a) return fail("kwl-docx create：需要输出文件名", 2);
        const sections: ReportSection[] = [];
        let cur: ReportSection = { heading: "", paragraphs: [] };
        for (const line of stdinText(ctx).split(/\r?\n/)) {
          if (line.startsWith("## ")) {
            if (cur.heading || cur.paragraphs.length > 0) sections.push(cur);
            cur = { heading: line.slice(3).trim(), paragraphs: [] };
          } else if (line.trim() !== "") cur.paragraphs.push(line);
        }
        if (cur.heading || cur.paragraphs.length > 0) sections.push(cur);
        await writeBytes(ctx, a, createDocx(b ?? "", sections));
        return ok("");
      }
      if (sub === "compare") {
        if (!a || !b) return fail("kwl-docx compare：需要两个 DOCX 文件", 2);
        const r = compareDocx(await readBytes(ctx, a), await readBytes(ctx, b));
        const lines = [`新增 ${r.stats.added}，删除 ${r.stats.deleted}，修改 ${r.stats.modified}，其中未留修订痕迹 ${r.stats.silent}`];
        for (const c of r.changes) {
          const tag = c.type === "added" ? "+" : c.type === "deleted" ? "-" : "~";
          lines.push(`${tag}${c.silent ? "（无修订痕迹）" : ""} ${c.type === "added" ? c.curText : c.type === "deleted" ? c.baseText : `${c.baseText} → ${c.curText}`}`);
        }
        return ok(`${lines.join("\n")}\n`);
      }
      return fail(`kwl-docx：未知子命令 ${sub}\n${DOCX_HELP}`, 2);
    } catch (e) {
      return fail(`kwl-docx：${(e as Error).message}`);
    }
  });
  const xlsx = define("kwl-xlsx", async (args, ctx) => {
    const [sub, a, b, c] = args;
    try {
      if (!sub || sub === "--help" || sub === "-h") return ok(XLSX_HELP);
      if (sub === "create") {
        if (!a) return fail("kwl-xlsx create：需要输出文件名", 2);
        await writeBytes(ctx, a, csvToXlsx(stdinText(ctx), b ?? "Sheet1"));
        return ok("");
      }
      if (sub === "from-csv") {
        if (!a || !b) return fail("kwl-xlsx from-csv：需要输入 CSV 与输出 XLSX", 2);
        await writeBytes(ctx, b, csvToXlsx((await readBytes(ctx, a)).toString("utf8"), c ?? "Sheet1"));
        return ok("");
      }
      return fail(`kwl-xlsx：未知子命令 ${sub}\n${XLSX_HELP}`, 2);
    } catch (e) {
      return fail(`kwl-xlsx：${(e as Error).message}`);
    }
  });
  return [docx, xlsx];
}

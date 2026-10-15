/**
 * 日志面静态门禁（调研 Y5 §5.2“CI 静态规则”①②③）：
 * ① 律师电脑各进程的生产源码不得用 console.*，也不得直接写 process.stdout/stderr（登记的协议通道除外）；
 * ② slog.event 的第一个参数必须是登记表里的字面量事件码；
 * ③ 字段不得是模板字符串、异常 message 或字符串拼接——只放枚举、计数与 errFields(e)。
 * 另：登记表里的每个事件码都至少有一处使用（不留“备用”的宽口子）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENTS } from "../src/index.ts";
import { balancedArgs, productionSources, stripComments } from "../../../scripts/lib/source-scan.mjs";

/** 不在律师电脑 Agent 链路上的目录（如实列出）。 */
const OUT_OF_SCOPE = [
  "apps/firm-node/", // 所内节点：无界面服务，日志进律所服务器的服务日志（另行规定）
  "packages/im-connectors/", // 所内节点 IM 连接器
];

/** 允许直接写标准输出/错误的位置 → 理由。 */
const STDIO_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "packages/safe-log/src/index.ts": "子进程日志通道：只写核验通过的事件 JSON 行（stderrSink）",
  "packages/parse-ocr/src/parse-worker.ts": "解析进程与内核之间的结果协议（stdout JSON 行，只含解析结果，内核读后不落日志）",
  "apps/agent-host/src/host.ts": "旧 SDK 宿主（开发对照，安装包不含，K9-1 待退役）与内核之间的事件协议（stdout JSON 行）",
});

// 任何对 console 的引用都算（复核 S5A-06：`log = console` 这类别名能绕过只查调用的写法）
const CONSOLE = /(?<![\w$.])console\b/;
const STDIO = /\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(/;

test("日志面①：生产源码没有 console.*；直接写标准输出/错误只在登记的协议通道", () => {
  const srcs = productionSources({ outOfScope: OUT_OF_SCOPE });
  assert.ok(srcs.length > 100, "扫描到的源码文件过少，扫描范围可能出错");
  const consoleHits = srcs.filter((f) => CONSOLE.test(f.text)).map((f) => f.rel);
  assert.deepEqual(consoleHits, [], `生产源码出现 console.*（改用 slog.event）：${consoleHits.join("、")}`);
  const stdioHits = srcs.filter((f) => STDIO.test(f.text)).map((f) => f.rel);
  const unexpected = stdioHits.filter((h) => !(h in STDIO_ALLOWED));
  assert.deepEqual(unexpected, [], `未登记的标准输出/错误写入：${unexpected.join("、")}`);
  const stale = Object.keys(STDIO_ALLOWED).filter((k) => !stdioHits.includes(k));
  assert.deepEqual(stale, [], `清单里的位置已没有这类写入（请同步清单）：${stale.join("、")}`);
});

interface Call {
  rel: string;
  args: string;
}

function eventCalls(): Call[] {
  const out: Call[] = [];
  for (const f of productionSources({ outOfScope: OUT_OF_SCOPE })) {
    const re = /\bslog\s*\.\s*event\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.text))) {
      const args = balancedArgs(f.text, m.index + m[0].length - 1);
      out.push({ rel: f.rel, args: args ?? "<无法解析>" });
    }
  }
  return out;
}

export function lintEventCall(args: string): string | null {
  const m = /^\s*(["'])([A-Z][A-Z0-9_]*)\1\s*(?:,|$)/.exec(args);
  if (!m) return "第一个参数不是字面量事件码";
  if (!Object.hasOwn(EVENTS, m[2]!)) return `事件码 ${m[2]} 未登记`;
  const rest = args.slice(m[0].length);
  if (rest.includes("`")) return "字段含模板字符串";
  if (/\.\s*(?:message|stack)\b/.test(rest)) return "字段取了异常 message/stack（改用 errFields）";
  if (/["']\s*\+|\+\s*["']/.test(rest)) return "字段含字符串拼接";
  if (/\bString\s*\(|\.toString\s*\(|JSON\s*\.\s*stringify/.test(rest)) return "字段把任意值转成字符串";
  return null;
}

test("日志面②③：slog.event 只用登记的字面量事件码；字段无模板字符串、异常 message、字符串拼接与任意值转字符串", () => {
  const calls = eventCalls();
  assert.ok(calls.length >= 20, `slog.event 调用过少（${calls.length}），扫描可能出错`);
  const bad = calls.map((c) => [c.rel, lintEventCall(c.args)] as const).filter(([, why]) => why);
  assert.deepEqual(bad, [], bad.map(([r, w]) => `${r}：${w}`).join("；"));
});

test("登记表：每个事件码至少有一处使用（不留备用口子）", () => {
  const used = new Set(eventCalls().map((c) => /^\s*["']([A-Z0-9_]+)["']/.exec(c.args)?.[1]));
  // 日志器自身与转交路径产生的事件（不经字面量调用）
  for (const internal of ["SAFE_LOG_REJECTED", "SAFE_LOG_LEVEL_CHANGED", "CHILD_STDERR_UNSTRUCTURED"]) used.add(internal);
  const unused = Object.keys(EVENTS).filter((c) => !used.has(c));
  assert.deepEqual(unused, [], `登记了但没有使用的事件码：${unused.join("、")}`);
});

test("日志面扫描自身：能识别 console、自由文本字段与未登记事件码；注释里的不计", () => {
  assert.ok(CONSOLE.test(stripComments(`if (x) console.warn("a");`)));
  assert.ok(!CONSOLE.test(stripComments(`// console.warn("a")`)));
  assert.ok(CONSOLE.test(stripComments(`function f({ log = console }) {}`)), "别名也算");
  assert.ok(!CONSOLE.test(stripComments(`const myconsole = 1; x.console = 2;`)));
  assert.ok(STDIO.test(`process.stderr.write("x")`));
  assert.equal(lintEventCall(`"KERNEL_CLOSED", {}`), null);
  assert.equal(lintEventCall(`"QUEUE_WORKFLOW_ERROR", { run: runId, ...errFields(err) }`), null);
  assert.match(lintEventCall(`code, {}`)!, /字面量/);
  assert.match(lintEventCall(`"NOPE_X", {}`)!, /未登记/);
  assert.match(lintEventCall("\"TOOLS_TOOL_HIDDEN\", { tool: `${name}` }")!, /模板/);
  assert.match(lintEventCall(`"KERNEL_CHECKPOINT_FAILED", { err_code: e.message }`)!, /message/);
  assert.match(lintEventCall(`"TOOLS_TOOL_HIDDEN", { tool: "x" + name }`)!, /拼接/);
  assert.match(lintEventCall(`"TOOLS_TOOL_HIDDEN", { tool: String(v) }`)!, /转成字符串/);
});

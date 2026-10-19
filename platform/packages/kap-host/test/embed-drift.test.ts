/**
 * 引擎漂移报警（Kimi Code 增量核查 K9-2；复核 B4-B09/B4-B10 扩充）：kap-server 无端口嵌入（ZP-19 `embed.ts`）复刻了上游 `start.ts` 的启动种子段，
 * 宿主的过程快照、事件映射与预算计数依赖上游协议里若干事件的字段与若干工具的入参。上游升级或 rebase 后这些地方静默变化，
 * 会让嵌入形态漏掉种子、让过程信息悄悄消失，或让子任务成员数被低估（不安全方向）。
 *
 * - `start.ts` 的 `bootstrap(...)` 段规范化后摘要锁定；变化即失败，提示对照 embed.ts 同步或登记为有意省略；
 * - `start.ts` 里 `args` 的每个键要么出现在 embed.ts 的 `bootstrap(...)` 段，要么登记在 INTENTIONALLY_OMITTED（附原因）；
 * - 宿主依赖的事件（events-zod.ts）字段仍在；任务信息、任务状态枚举、压缩结果、用量四字段、压缩触发方式一并锁定；
 * - 宿主策略与过程快照读取的工具入参（agent-core-v2 工具 schema）顶层键集合精确锁定：新增键即失败（例如集群按模板展开的 `count`
 *   会让成员数被低估），提示复核预算与快照映射后更新登记表。
 *
 * 跳过语义（复核 B4-B09）：只在 fork 目录本身（third_party/kimi-code，嵌套仓库，不入库）不在时跳过；目录在而任一文件缺失即失败——
 * 上游移动或改名文件正是本报警要防的场景，不得显示为“跳过”。截取与解析函数另有内嵌样例自测，不依赖 fork、CI 可跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FORK = fileURLToPath(new URL("../../../third_party/kimi-code/", import.meta.url));
const forkPresent = existsSync(FORK);
const KS = "packages/kap-server/src/";
const AC = "packages/agent-core-v2/src/";

/** fork 在时读取上游文件；文件不在即失败（不跳过）。 */
function upstream(rel: string): string {
  const p = `${FORK}${rel}`;
  assert.ok(existsSync(p), `third_party/kimi-code 在，但 ${rel} 不在：上游可能移动或改名了该文件——请定位新位置、核对宿主依赖后更新本测试（报警不得静默跳过）`);
  return readFileSync(p, "utf8");
}

/** 2.2.0（472192c34）+ ZP 补丁下 start.ts 的 bootstrap(...) 段（规范化空白）摘要。2.2.0 新增 `uiCapabilities: [NOTIFY_USER_UI_CAPABILITY]`，embed.ts 自第 5 批已有（字面量 update_panel）。 */
const START_BOOTSTRAP_SHA256 = "8da4992bdff5d1f89384c44c5a45572e25c7fe8ddf8ba3d4e80ea913647f32a2";
/** start.ts 的 args 中、嵌入形态有意不传的键（原因）。 */
const INTENTIONALLY_OMITTED: Record<string, string> = {};

// ─── 词法与截取（复核 B4-B10：跳过注释、字符串与模板字面量；按括号深度取键；识别简写属性） ───

interface Tok {
  k: "id" | "str" | "num" | "p" | "tpl";
  v: string;
  at: number;
  end: number;
}

/**
 * 词法切分：跳过 `//` 与 `/* *\/` 注释；字符串（含转义）为一个记号；模板字面量的文字段为记号、`${…}` 内照常切分（可嵌套）。
 * 不识别正则字面量（zod schema 与启动段里不出现；出现时多半让截取失败——安全方向）。
 */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const tpl: number[] = []; // 每层 `${` 内的花括号深度
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out.push({ k: "str", v: src.slice(i + 1, j), at: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (c === "`" || (c === "}" && tpl.length > 0 && tpl[tpl.length - 1] === 0)) {
      if (c === "}") tpl.pop();
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "`") {
          j++;
          break;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          tpl.push(0);
          j += 2;
          break;
        }
        j++;
      }
      out.push({ k: "tpl", v: src.slice(i, j), at: i, end: j });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      out.push({ k: "id", v: src.slice(i, j), at: i, end: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!)) j++;
      out.push({ k: "num", v: src.slice(i, j), at: i, end: j });
      i = j;
      continue;
    }
    if (src.startsWith("...", i)) {
      out.push({ k: "p", v: "...", at: i, end: i + 3 });
      i += 3;
      continue;
    }
    if (tpl.length > 0 && (c === "{" || c === "}")) tpl[tpl.length - 1]! += c === "{" ? 1 : -1;
    out.push({ k: "p", v: c, at: i, end: i + 1 });
    i++;
  }
  return out;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** 与 toks[open] 配对的右括号下标（三种括号一起计深度）。 */
function matchClose(toks: Tok[], open: number): number {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "p") continue;
    if (OPEN.has(t.v)) depth++;
    else if (CLOSE.has(t.v) && --depth === 0) return i;
  }
  throw new Error("括号不配对");
}

/** 从 from 起第一次出现记号序列 seq（按值比较；字符串记号比较其内容）的下标；to 为上限（不含）。 */
function findSeq(toks: Tok[], seq: string[], from = 0, to = toks.length): number {
  for (let i = from; i + seq.length <= to; i++) if (seq.every((v, k) => toks[i + k]!.v === v)) return i;
  return -1;
}

/** 截取 `name(` 起到配对右括号为止的段落（代码中的调用，不认注释与字符串里的同名文字）。 */
function callSection(src: string, name: string): string {
  const toks = tokenize(src);
  const at = toks.findIndex((t, i) => t.k === "id" && t.v === name && toks[i + 1]?.v === "(");
  assert.ok(at >= 0, `找不到 ${name}(`);
  return src.slice(toks[at]!.at, toks[matchClose(toks, at + 1)]!.end);
}

/** 对象字面量（toks[open] 为 `{`）的顶层键：`k: v`、简写 `k`、方法 `k(`、`'k': v`；展开记为 `...名`；嵌套对象的键不计。 */
function objectKeys(toks: Tok[], open: number): string[] {
  assert.equal(toks[open]?.v, "{", "objectKeys 需要从 { 开始");
  const keys: string[] = [];
  const close = matchClose(toks, open);
  let depth = 0;
  let expectKey = false;
  for (let i = open; i < close; i++) {
    const t = toks[i]!;
    if (t.k === "p" && OPEN.has(t.v)) {
      depth++;
      if (depth === 1) expectKey = true;
      continue;
    }
    if (t.k === "p" && CLOSE.has(t.v)) {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (t.k === "p" && t.v === ",") {
      expectKey = true;
      continue;
    }
    if (!expectKey) continue;
    expectKey = false;
    if (t.k === "p" && t.v === "...") keys.push(`...${toks[i + 1]?.v ?? ""}`);
    else if (t.k === "id" && (t.v === "async" || t.v === "get" || t.v === "set") && toks[i + 1]?.k === "id") keys.push(toks[i + 1]!.v);
    else if (t.k === "id" || t.k === "str" || t.k === "num") keys.push(t.v);
  }
  return keys;
}

/** `bootstrap(...)` 段里 `args: {...}` 的顶层键。 */
function argsKeys(section: string): string[] {
  const toks = tokenize(section);
  const at = findSeq(toks, ["args", ":", "{"]);
  assert.ok(at >= 0, "bootstrap 段里没有 args");
  return objectKeys(toks, at + 2);
}

/** `const <name> [: 类型] = …;` 声明：返回 `=` 之后的首个记号下标与声明末尾（深度 0 的 `;`）。 */
function declRange(toks: Tok[], name: string): { start: number; end: number } {
  const at = toks.findIndex((t, i) => t.k === "id" && t.v === name && toks[i - 1]?.v === "const");
  assert.ok(at >= 0, `上游源码里找不到 const ${name}`);
  let eq = at + 1;
  while (eq < toks.length && toks[eq]!.v !== "=") eq++;
  let depth = 0;
  for (let i = eq + 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === "p" && OPEN.has(t.v)) depth++;
    else if (t.k === "p" && CLOSE.has(t.v)) depth--;
    else if (depth === 0 && t.v === ";") return { start: eq + 1, end: i };
  }
  return { start: eq + 1, end: toks.length };
}

/** zod schema 的字段名：`z.object({...})`（可在 `z.preprocess(fn, …)`、`.strict()` 等链中）或 `<基础>.extend({...})`（并入基础 schema 的字段）。 */
function schemaKeys(src: string, name: string, toks = tokenize(src)): string[] {
  const { start, end } = declRange(toks, name);
  const first = toks[start]!;
  let keys: string[] = [];
  if (first.k === "id" && first.v !== "z" && toks[start + 1]?.v === "." && toks[start + 2]?.v === "extend" && toks[start + 3]?.v === "(") {
    keys = [...schemaKeys(src, first.v, toks), ...objectKeys(toks, start + 4)];
  } else {
    const at = findSeq(toks, ["z", ".", "object", "(", "{"], start, end);
    assert.ok(at >= 0, `${name} 不是 z.object / .extend 形式（上游改了写法：请核对后更新本测试）`);
    keys = objectKeys(toks, at + 4);
  }
  return [...new Set(keys)].sort();
}

/** `z.enum([...])` 的取值；field 给出时取该声明中 `field: z.enum([...])`。 */
function enumValues(src: string, name: string, field?: string, toks = tokenize(src)): string[] {
  const { start, end } = declRange(toks, name);
  const at = findSeq(toks, [...(field ? [field, ":"] : []), "z", ".", "enum", "(", "["], start, end);
  assert.ok(at >= 0, `${name}${field ? `.${field}` : ""} 不是 z.enum([...])`);
  const open = at + (field ? 6 : 4);
  return toks
    .slice(open + 1, matchClose(toks, open))
    .filter((t) => t.k === "str")
    .map((t) => t.v)
    .sort();
}

/** `z.discriminatedUnion('<键>', [A, B, …])` 各成员 schema 的 `<键>: z.literal('…')` 取值。 */
function unionLiterals(src: string, name: string, toks = tokenize(src)): string[] {
  const { start, end } = declRange(toks, name);
  const at = findSeq(toks, ["z", ".", "discriminatedUnion", "("], start, end);
  assert.ok(at >= 0, `${name} 不是 z.discriminatedUnion`);
  const key = toks[at + 4]!.v;
  const open = findSeq(toks, ["["], at, end);
  const members = toks.slice(open + 1, matchClose(toks, open)).filter((t) => t.k === "id").map((t) => t.v);
  return members
    .map((m) => {
      const r = declRange(toks, m);
      const lit = findSeq(toks, [key, ":", "z", ".", "literal", "("], r.start, r.end);
      assert.ok(lit >= 0, `${m} 没有 ${key}: z.literal(...)`);
      return toks[lit + 6]!.v;
    })
    .sort();
}

/** events-zod.ts 中 `type: z.literal('<type>')` 所在 schema 的字段名（含 `.extend` 基础 schema 的字段）。 */
function eventFields(src: string, type: string, toks = tokenize(src)): string[] {
  const at = toks.findIndex((t, i) => t.k === "str" && t.v === type && i >= 6 && findSeq(toks, ["type", ":", "z", ".", "literal", "("], i - 6, i) === i - 6);
  assert.ok(at >= 0, `上游协议里找不到事件 ${type}`);
  let d = at;
  while (d > 0 && !(toks[d - 1]!.v === "const" && toks[d]!.k === "id")) d--;
  assert.ok(d > 0, `事件 ${type} 不在 const 声明里`);
  return schemaKeys(src, toks[d]!.v, toks);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

// ─── 登记表 ───

/** 宿主过程快照（progress.ts）与事件映射（runtime.ts）读取的事件字段——上游改名或删除即失败。 */
const CONSUMED: Record<string, string[]> = {
  "tool.call.started": ["agentId", "args", "description", "name", "toolCallId", "turnId"],
  "tool.result": ["agentId", "isError", "output", "toolCallId"],
  "subagent.spawned": ["description", "runInBackground", "subagentId", "subagentName", "swarmIndex"],
  "subagent.completed": ["resultSummary", "subagentId", "usage"],
  "subagent.failed": ["error", "subagentId"],
  "subagent.cancelled": ["subagentId"],
  "subagent.suspended": ["subagentId"],
  "compaction.started": ["agentId", "trigger"],
  "compaction.completed": ["agentId", "result"],
  "compaction.blocked": ["agentId"],
  "compaction.cancelled": ["agentId"],
  "task.started": ["info"],
  "task.terminated": ["info"],
  "background.task.started": ["info"],
  "background.task.terminated": ["info"],
  "turn.started": ["agentId", "turnId"],
  "turn.ended": ["agentId", "error", "reason", "turnId"],
  "turn.step.completed": ["agentId", "finishReason", "providerFinishReason"],
  "turn.step.retrying": ["agentId", "maxAttempts", "nextAttempt", "statusCode"],
  "assistant.delta": ["agentId", "delta"],
  error: ["code", "message", "retryable"],
};

/**
 * 宿主读取的工具入参（顶层键集合精确锁定）。reads 说明宿主读哪些键、用于什么——上游新增键时据此复核预算计数、拒绝规则与快照映射。
 */
const TOOL_INPUTS: { tool: string; file: string; schema: string; keys: string[]; reads: string }[] = [
  {
    tool: "AgentSwarm",
    file: "features/swarm/tools/agent-swarm/agent-swarm.ts",
    schema: "AgentSwarmToolInputSchema",
    keys: ["description", "fork", "items", "model", "prompt_template", "resume_agent_ids", "subagent_type"],
    reads: "policy.ts：成员数 = items + resume_agent_ids；fork、model 宿主拒绝",
  },
  {
    tool: "Agent",
    file: "agent/tools/agent/agent.ts",
    schema: "SubagentToolInputSchema",
    keys: ["description", "fork", "model", "prompt", "resume", "run_in_background", "subagent_type"],
    reads: "policy.ts：计 1 个成员；fork、model 宿主拒绝",
  },
  { tool: "TodoList", file: "features/todo/tools/todo-list/todo-list.ts", schema: "TodoListInputSchema", keys: ["todos"], reads: "progress.ts：工作清单" },
  { tool: "TodoList 清单项", file: "features/todo/tools/todo-list/todo-list.ts", schema: "TodoItemSchema", keys: ["status", "title"], reads: "progress.ts：todos[].title / status" },
  { tool: "NotifyUser", file: "features/notify/tools/notify-user/notify-user.ts", schema: "NotifyUserInputSchema", keys: ["message", "title"], reads: "progress.ts：进展通知（2.2.0 新增可选 title：截到 noteTitle 后与正文合成一条）" },
  { tool: "Skill", file: "features/skill/tools/skill.ts", schema: "SkillToolInputSchema", keys: ["args", "skill"], reads: "progress.ts：方法模板名" },
  { tool: "WebSearch", file: "agent/tools/web-search/web-search.ts", schema: "WebSearchInputSchema", keys: ["query"], reads: "policy.ts：检索式预筛与出站摘要" },
  { tool: "FetchURL", file: "agent/tools/fetch-url/fetch-url.ts", schema: "FetchURLInputSchema", keys: ["url"], reads: "policy.ts：域名白名单与出站摘要" },
  {
    tool: "Bash",
    file: "agent/tools/os/bash/bash.ts",
    schema: "BashInputSchema",
    keys: ["command", "cwd", "description", "disable_timeout", "run_in_background", "timeout"],
    reads: "policy.ts：cwd 路径区域、后台超时上限、禁止 disable_timeout",
  },
];

// ─── 自测（不依赖 fork） ───

test("K9-2 漂移报警的截取与解析自测（复核 B4-B10）：注释里的撇号与括号、嵌套对象、简写属性、模板字面量、.extend、z.preprocess、枚举与可辨识联合", () => {
  const start = `
    // don't be fooled by this comment's apostrophe (or this paren
    /* nor by this block ) comment's quote " */
    const { app } = bootstrap(
      {
        homeDir,
        args: {
          requestHeaders: createKimiDefaultHeaders({ homeDir, ...opts.hostIdentity }),
          skillDirs: opts.skillDirs, // isn't a key: (nested)
          nested: { inner: 1, deeper: { x: 2 } },
          label: \`a \${fmt({ y: ")" })} b\`,
          shorthand,
          ...spread,
          'quoted-key': "v)",
        },
      },
      [...seeds],
    );
    after(1);`;
  const sec = callSection(start, "bootstrap");
  assert.ok(sec.startsWith("bootstrap(") && sec.endsWith(")") && sec.includes("[...seeds]") && !sec.includes("after(1)"), sec);
  assert.deepEqual(argsKeys(sec), ["requestHeaders", "skillDirs", "nested", "label", "shorthand", "...spread", "quoted-key"]);
  const zod = `
    export const baseSchema = z.object({ taskId: z.string(), status: statusSchema, nested: z.object({ notTop: z.string() }) });
    export const statusSchema = z.enum(['running', 'completed']);
    const pSchema = baseSchema.extend({ kind: z.literal('process'), pid: z.number() });
    const qSchema = baseSchema.extend({ kind: z.literal('question') });
    export const unionSchema = z.discriminatedUnion('kind', [pSchema, qSchema]);
    export const evSchema = z.object({
      type: z.literal('thing.happened'),
      agentId: z.string(), // the agent's id
      trigger: z.enum(['manual', 'auto']),
      info: unionSchema,
    }) satisfies z.ZodType<X>;
    export const errEvent = errBase.extend({ type: z.literal('error'), agentId: z.string() });
    const errBase = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() });
    export const Pre = z.preprocess((input) => { const r = { ...input }; return r; }, z.object({ prompt: z.string(), fork: z.boolean().optional() }));
    export const Strict = z
      .object({ items: z.array(z.string()).max(128).optional(), desc: z.string().describe(\`x \${String(N)} y\`) })
      .strict();`;
  assert.deepEqual(schemaKeys(zod, "pSchema"), ["kind", "nested", "pid", "status", "taskId"]);
  assert.deepEqual(enumValues(zod, "statusSchema"), ["completed", "running"]);
  assert.deepEqual(enumValues(zod, "evSchema", "trigger"), ["auto", "manual"]);
  assert.deepEqual(unionLiterals(zod, "unionSchema"), ["process", "question"]);
  assert.deepEqual(eventFields(zod, "thing.happened"), ["agentId", "info", "trigger", "type"]);
  assert.deepEqual(eventFields(zod, "error"), ["agentId", "code", "message", "retryable", "type"]);
  assert.deepEqual(schemaKeys(zod, "Pre"), ["fork", "prompt"]);
  assert.deepEqual(schemaKeys(zod, "Strict"), ["desc", "items"]);
  assert.throws(() => eventFields(zod, "never.defined"), /找不到事件/);
});

// ─── 对照锁版上游（fork 目录不在时跳过；在而文件缺失即失败） ───

const SKIP = forkPresent ? false : "third_party/kimi-code 不在（嵌套仓库不入库）：报警在引擎升级的机器上起作用";

// CI 的 engine-drift 作业按台账重建 fork 后设 KWL_REQUIRE_FORK=1（复核 B13-C02）：此时 fork 不在即失败，不静默跳过
test("CI：要求 fork 在场", { skip: process.env.KWL_REQUIRE_FORK !== "1" && "只在 CI 的 engine-drift 作业里检查" }, () => {
  assert.ok(forkPresent, "KWL_REQUIRE_FORK=1 但 third_party/kimi-code 不在：重建步骤失败或路径不对");
});

test("K9-2 引擎漂移报警：start.ts 启动种子段锁定、args 键与 embed.ts 一致（或登记有意省略）、宿主依赖的事件字段仍在", { skip: SKIP }, () => {
  const start = upstream(`${KS}start.ts`);
  const embed = upstream(`${KS}embed.ts`);
  const s = callSection(start, "bootstrap");
  const e = callSection(embed, "bootstrap");
  const digest = createHash("sha256").update(norm(s)).digest("hex");
  assert.equal(digest, START_BOOTSTRAP_SHA256, "上游 start.ts 的 bootstrap 种子段已变化：请对照 embed.ts（ZP-19）同步或登记为有意省略，然后更新本常量");
  const embedKeys = new Set(argsKeys(e));
  for (const k of argsKeys(s)) assert.ok(embedKeys.has(k) || INTENTIONALLY_OMITTED[k], `start.ts 的 args.${k} 未在 embed.ts 传入，也未登记为有意省略`);
  const ev = upstream(`${KS}protocol/events-zod.ts`);
  const toks = tokenize(ev);
  for (const [type, fields] of Object.entries(CONSUMED)) {
    const have = new Set(eventFields(ev, type, toks));
    for (const f of fields) assert.ok(have.has(f), `上游事件 ${type} 不再有字段 ${f}（宿主过程快照与事件映射依赖它）`);
  }
});

test("复核 B4-B09 引擎漂移报警（嵌套结构）：任务信息字段与种类、任务状态枚举、压缩结果、用量四字段、压缩触发方式锁定", { skip: SKIP }, () => {
  const ev = upstream(`${KS}protocol/events-zod.ts`);
  const toks = tokenize(ev);
  const base = new Set(schemaKeys(ev, "taskInfoBaseSchema", toks));
  for (const f of ["taskId", "description", "status"]) assert.ok(base.has(f), `taskInfoBaseSchema 不再有 ${f}（progress.ts 后台任务）`);
  assert.deepEqual(unionLiterals(ev, "taskInfoSchema", toks), ["agent", "process", "question"], "任务种类变化：复核 progress.ts 的 kind 映射（process→本机计算、question 不算后台任务）");
  assert.deepEqual(enumValues(ev, "taskLifecycleStatusSchema", undefined, toks), ["completed", "failed", "killed", "lost", "running", "timed_out"], "任务状态枚举变化：复核 progress.ts 的状态映射");
  const cr = new Set(schemaKeys(ev, "compactionResultSchema", toks));
  for (const f of ["tokensBefore", "tokensAfter", "droppedCount"]) assert.ok(cr.has(f), `compactionResultSchema 不再有 ${f}`);
  assert.deepEqual(schemaKeys(ev, "tokenUsageSchema", toks), ["inputCacheCreation", "inputCacheRead", "inputOther", "output"], "用量字段变化：子任务用量合计会少算，复核 progress.ts");
  assert.deepEqual(enumValues(ev, "compactionStartedEventSchema", "trigger", toks), ["auto", "manual"], "压缩触发方式变化：复核 progress.ts 与内核里程碑白名单");
});

test("复核 B4-B09 引擎漂移报警（工具入参）：宿主策略与过程快照读取的工具 schema 顶层键精确锁定——新增键即失败（复核预算计数与快照映射）", { skip: SKIP }, () => {
  for (const t of TOOL_INPUTS) {
    const src = upstream(`${AC}${t.file}`);
    assert.deepEqual(schemaKeys(src, t.schema), [...t.keys].sort(), `${t.tool}（${t.schema}）的入参键变化：宿主读取 ${t.reads}——复核后更新登记表`);
  }
  const todo = upstream(`${AC}features/todo/tools/todo-list/todo-list.ts`);
  assert.deepEqual(enumValues(todo, "TodoItemSchema", "status"), ["done", "in_progress", "pending"], "清单状态枚举变化：复核 progress.ts 与内核白名单");
});

test("复核 S5B-14 引擎漂移报警（NotifyUser）：界面能力名、开关编号与环境变量名锁定，嵌入声明与宿主开关一致——上游改名时工具不会静默消失", { skip: SKIP }, async () => {
  const avail = upstream("packages/agent-core-v2/src/features/notify/notifyUserAvailability.ts");
  assert.match(avail, /NOTIFY_USER_UI_CAPABILITY[^=]*=\s*'update_panel'/, "界面能力名不再是 update_panel：同步 embed.ts（ZP-19）");
  assert.match(avail, /bootstrap\.args\.uiCapabilities/, "可用性判断不再读 bootstrap.args.uiCapabilities");
  const flag = upstream("packages/agent-core-v2/src/features/notify/flag.ts");
  assert.match(flag, /NOTIFY_USER_FLAG_ID\s*=\s*'notify_user'/);
  assert.match(flag, /NOTIFY_USER_FLAG_ENV\s*=\s*'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER'/);
  assert.match(upstream(`${KS}embed.ts`), /uiCapabilities:\s*\['update_panel'\]/, "embed.ts 未声明 update_panel");
  const { EXPERIMENTAL_LOCK } = await import("../src/engine-config.ts");
  assert.equal(EXPERIMENTAL_LOCK.notify_user, true);
  const cfg = (await import("../src/engine-config.ts")).buildEngineConfig({ matterId: "m", execDomainAvailable: false, legalMcpTools: [], searchConfigured: false, fetchConfigured: false });
  assert.equal(cfg.env.KIMI_CODE_EXPERIMENTAL_NOTIFY_USER, "1");
});

test("复核 S5B-15：测试专用上下文窗口只接受 4096–262143，缺省与越界一律 262144（安装包形态由内核与宿主两层不传、忽略）", async () => {
  const { buildEngineConfig } = await import("../src/engine-config.ts");
  const ctx = (n?: number) => (buildEngineConfig({ matterId: "m", execDomainAvailable: false, legalMcpTools: [], searchConfigured: false, fetchConfigured: false, testMaxContextSize: n }).config.models as any)["legal/k3"].max_context_size;
  assert.equal(ctx(), 262144);
  assert.equal(ctx(16384), 16384);
  assert.equal(ctx(100), 262144);
  assert.equal(ctx(10_000_000), 262144);
  assert.equal(ctx(16384.5), 262144);
});

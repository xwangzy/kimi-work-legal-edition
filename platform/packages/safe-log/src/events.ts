/**
 * 事件码登记表（调研 Y5 §5.2）：每个事件码声明级别与字段类型；`slog.event` 只接受这里登记的事件码与字段。
 * 变更须隐私负责人审阅（新增字段类型尤其要谨慎）。字段类型一律是封闭集合，不存在“任意字符串”：
 *
 * - `int` 有界整数；`ms` 非负时长（毫秒）；`bool`；`status` HTTP 状态码；
 * - `ver` 版本号（数字与点，可带短后缀）；
 * - `errname` 异常的构造器名（如 TypeError）；`errcode` Node 错误码（ENOENT、ERR_…）或本产品的 snake_case 错误码——异常的 message 一律不记；
 * - `signal` 进程信号名；
 * - `ident` 本产品代码里的机器标识（小写 ASCII，如工具名、步骤名）——不能承载中文、空格、路径分隔符；
 * - `id` 本机记录编号（事项、任务、尝试）：写盘前按本机随机盐 HMAC 取 12 位，日志与诊断包里不能与账本对应；
 * - 字符串数组 = 封闭枚举。
 */

export type FieldKind = "int" | "ms" | "bool" | "status" | "ver" | "errname" | "errcode" | "signal" | "ident" | "id" | readonly string[];
export type Level = "error" | "warn" | "info" | "debug";

export interface EventSpec {
  level: Level;
  /** 字段 → 类型；带 `?` 后缀的键可省略。 */
  fields: Readonly<Record<string, FieldKind>>;
}

/** 写日志的进程（由接收方标注，不信任子进程自报）。 */
export const PROCS = ["kernel", "main", "gate", "kap_host", "w", "parse"] as const;
export type Proc = (typeof PROCS)[number];

const ERR = { "err_name?": "errname", "err_code?": "errcode" } as const;

export const EVENTS = {
  // —— 日志器自身 ——
  SAFE_LOG_REJECTED: { level: "warn", fields: { cause: ["unknown_code", "bad_field", "missing_field", "bad_value", "malformed", "too_long"], "source?": PROCS } },
  SAFE_LOG_LEVEL_CHANGED: { level: "info", fields: { level: ["error", "warn", "info", "debug"], "expires_in_ms?": "ms" } },
  CHILD_EXIT: { level: "info", fields: { proc: PROCS, "code?": "int", "signal?": "signal" } },
  CHILD_STDERR_UNSTRUCTURED: { level: "debug", fields: { proc: PROCS, lines: "int" } },

  // —— 内核 ——
  KERNEL_INDEX_EXCLUDE: { level: "info", fields: { outcome: ["done", "failed", "not_applicable"] } },
  KERNEL_STARTED: { level: "info", fields: { engine: ["kap", "sdk"], at_rest: ["required", "on", "off"], control_plane: ["dev", "configured"] } },
  KERNEL_CLOSED: { level: "info", fields: {} },
  KERNEL_SKILLS_UNAVAILABLE: { level: "warn", fields: {} },
  KERNEL_RECOVERY_REJECTED: { level: "warn", fields: {} },
  KERNEL_EXIT_MODE_LIFTED: { level: "info", fields: { resumed: "int" } },
  KERNEL_RUNS_RECOVERED: { level: "warn", fields: { count: "int", parked: "bool" } },
  KERNEL_CHECKPOINT_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_SYNC_TIMER_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_REMINDER_TICK_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_RELAY_PUSH_FAILED: { level: "warn", fields: { ...ERR } },
  /** 云端送来、核对不通过而丢弃的提醒条数（解不开、签名不符、发出设备已吊销等；第 10 批 S9）。 */
  REMINDER_REJECTED: { level: "warn", fields: { count: "int" } },
  KERNEL_NODE_ENQUEUE_EXPORT_FAILED: { level: "warn", fields: { ...ERR } },
  SERVICE_AUTH_DEV_SECRET: { level: "warn", fields: {} },
  EXECUTOR_PROVIDER_RETRY: { level: "warn", fields: { step: "ident", attempt: "int", delay_ms: "ms" } },
  EXECUTOR_MARK_TERMINAL_FAILED: { level: "error", fields: { run: "id", ...ERR } },
  EXECUTOR_MARK_RECONCILING_FAILED: { level: "error", fields: { run: "id", ...ERR } },
  EXECUTOR_LEASE_LOST: { level: "warn", fields: { attempt: "id", status: "ident", ...ERR } },
  QUEUE_WORKFLOW_ERROR: { level: "error", fields: { run: "id", ...ERR } },
  TOOLS_LOCK_UNAVAILABLE: { level: "error", fields: { ...ERR } },
  TOOLS_TOOL_HIDDEN: { level: "error", fields: { tool: "ident" } },
  GATE_RECORD_WRITE_FAILED: { level: "error", fields: { ...ERR } },
  GATE_TOKEN_WRITE_FAILED: { level: "error", fields: { ...ERR } },
  METER_INSERT_FAILED: { level: "error", fields: { ...ERR } },

  // —— Agent 宿主（子进程，经 stderr 交内核） ——
  KAP_SEALED_LOG_QUARANTINED: { level: "warn", fields: {} },
  KAP_TEST_CONTEXT_IGNORED: { level: "warn", fields: {} },

  // —— Electron 主进程（经内核消息交内核） ——
  MAIN_DBKEY_DEV_PLAINTEXT: { level: "warn", fields: {} },
  MAIN_RELEASE_CONFIG_PROBLEM: { level: "error", fields: { count: "int" } },
  MAIN_KERNEL_READY: { level: "info", fields: {} },
  MAIN_KERNEL_FATAL: { level: "error", fields: {} },
  MAIN_KERNEL_EXITED: { level: "warn", fields: { "code?": "int" } },
  MAIN_NOTIFY_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_CRASH_DIR_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_RUNTIME_PROBLEM: { level: "error", fields: { count: "int", stage: ["startup", "background"] } },
  MAIN_SMOKE_FAILED: { level: "error", fields: { reason: "ident" } },
  MAIN_SAVE_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_UPDATE_WARN: { level: "warn", fields: {} },
  MAIN_UPDATE_FAILED: { level: "error", fields: {} },
} as const satisfies Record<string, EventSpec>;

export type EventCode = keyof typeof EVENTS;

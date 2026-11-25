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
  /** 正式安装包里的开发内容签名公钥（复核 A-14 余项）：随包公钥是开发公钥即拒载；content_keys 里的开发公钥剔除并记把数。 */
  KERNEL_CONTENT_KEY_DEV_REFUSED: { level: "error", fields: {} },
  KERNEL_CONTENT_KEYS_DEV_DROPPED: { level: "warn", fields: { n: "int" } },
  /** 开通与成员入组（第 13 批）：只记发生了什么，不记码、律所或成员。 */
  KERNEL_ONBOARDING_REDEEM_FAILED: { level: "warn", fields: {} },
  KERNEL_ONBOARDING_ACTIVATED: { level: "info", fields: {} },
  KERNEL_ONBOARDING_JOIN_REQUESTED: { level: "info", fields: {} },
  KERNEL_ONBOARDING_JOINED: { level: "info", fields: {} },
  KERNEL_ONBOARDING_CERT_REJECTED: { level: "warn", fields: {} },
  // 第 66 批（V40，D-292）：个人账号新电脑自动登记（成功 / 失败原因码）
  KERNEL_ONBOARDING_AUTO_ENROLLED: { level: "info", fields: {} },
  KERNEL_ONBOARDING_AUTO_ENROLL_FAILED: { level: "warn", fields: { reason: "ident" } },
  KERNEL_JOIN_STAGED_REJECTED: { level: "warn", fields: {} },
  // 第 54 批：激活后删不掉待激活占位工作区（Windows 上有文件仍被占用）——不再让内核启动失败，下次启动再删
  KERNEL_PENDING_WORKSPACE_LEFT: { level: "warn", fields: { reason: ["busy", "perm", "other"] } },
  /** 我方账号（第 44 批）：只记原因代码，不记邮箱、密码与令牌。 */
  KERNEL_ACCOUNT_CALL_FAILED: { level: "warn", fields: { reason: "ident" } },
  KERNEL_ACCOUNT_LOGIN_REQUIRED: { level: "warn", fields: { reason: "ident" } },
  // 第 64 批：“要重新登录”写进本机记录失败（只影响重启后的表现）
  KERNEL_ACCOUNT_MARK_FAILED: { level: "warn", fields: { ...ERR } },
  // 第 64 批：注册 / 登录策略取到了没有、用了多久（登录页首屏的证据；outcome：ok = 新云端策略，legacy = 旧云端，unavailable = 取不到）
  KERNEL_REGISTRATION_META: { level: "info", fields: { outcome: ["ok", "legacy", "unavailable"], ms: "ms", "reason?": "ident" } },
  /** 恢复与备份（第 14 批）：只记文件数，不记路径与内容。 */
  KERNEL_RESTORED_FROM_BACKUP: { level: "info", fields: { files: "int" } },
  KERNEL_BACKUP_DONE: { level: "info", fields: { files: "int", copied: "int" } },
  KERNEL_BACKUP_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_EXIT_MODE_LIFTED: { level: "info", fields: { resumed: "int" } },
  // 第 66 批：云端模型目录没取成或没采用（取不到、验签或格式不过、比本机旧、缓存写不进）；trigger = 登录、定时、网关拒绝等触发原因
  KERNEL_MODEL_CATALOG: { level: "warn", fields: { outcome: ["fetch_failed", "invalid", "stale", "cache_failed"], trigger: "ident" } },
  KERNEL_RUNS_RECOVERED: { level: "warn", fields: { count: "int", parked: "bool" } },
  KERNEL_CHECKPOINT_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_SYNC_TIMER_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_REMINDER_TICK_FAILED: { level: "warn", fields: { ...ERR } },
  KERNEL_RELAY_PUSH_FAILED: { level: "warn", fields: { ...ERR } },
  /** 成员链自动处置（锚定、补轮换、补包裹、吊销标记）失败的事项数（第 12 批第三轮复核 S12B-40）。 */
  KERNEL_MEMBER_LOG_MAINTAIN_FAILED: { level: "warn", fields: { count: "int" } },
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
  // 文书与表格修改工具的结果分布（V13 第 38 批；V16 第 41 批加表格逐格修改）：只记写入几处、各类定位失败几处，不记任何文字——用于查“改了很多次只写进几次”的原因
  TOOLS_DOCX_EDIT_OUTCOME: { level: "info", fields: { tool: ["docx_edit_draft", "docx_revise", "xlsx_edit_cells"], status: ["applied", "partial", "not_applied", "preview"], patches: "int", applied: "int", not_found: "int", ambiguous: "int", unknown_token: "int", other: "int" } },
  GATE_RECORD_WRITE_FAILED: { level: "error", fields: { ...ERR } },
  // 闸门拉不起来（第 50 批）：只记封闭枚举的原因码；调用方照旧报 gate_unavailable
  // 第 64 批：闸门拉起（ms = 本次启动耗时，含等待运行时核对与进程拉起；since_boot_ms = 内核进程启动以来）
  KERNEL_GATE_STARTED: { level: "info", fields: { ms: "ms", since_boot_ms: "ms" } },
  KERNEL_GATE_START_FAILED: { level: "error", fields: { reason: ["closed", "runtime_digest", "runtime_missing", "spawn_denied", "start_timeout", "exited_early", "listen_failed", "tls_relaxed", "other"], ...ERR } },
  // 第 52 批：随包子进程自检（安装冒烟逐个真拉起闸门、解析进程、Agent 宿主、W 执行域；值为 ok 或原因码）
  KERNEL_CHILD_SELFTEST: { level: "info", fields: { gate: "ident", parse: "ident", kap: "ident", w: "ident" } },
  GATE_TOKEN_WRITE_FAILED: { level: "error", fields: { ...ERR } },
  METER_INSERT_FAILED: { level: "error", fields: { ...ERR } },

  // —— Agent 宿主（子进程，经 stderr 交内核） ——
  KAP_SEALED_LOG_QUARANTINED: { level: "warn", fields: {} },
  KAP_TEST_CONTEXT_IGNORED: { level: "warn", fields: {} },

  // —— Electron 主进程（经内核消息交内核） ——
  MAIN_DBKEY_DEV_PLAINTEXT: { level: "warn", fields: {} },
  MAIN_RELEASE_CONFIG_PROBLEM: { level: "error", fields: { count: "int" } },
  // 签名的云端地址配置（偏离 D-213）：验不过即沿用随包地址；生效时只记序号
  MAIN_ENDPOINT_PROFILE_PROBLEM: { level: "error", fields: { count: "int" } },
  // 第 52 批（D-217 防回滚）：source = file（本次放进来的配置）/ applied（拒绝了更早或被改动的配置，继续用已生效的那份）
  MAIN_ENDPOINT_PROFILE_APPLIED: { level: "info", fields: { seq: "int", source: ["file", "applied"] } },
  // Windows 试用构建（a9165e4，偏离 D-160）：主进程用了这四个事件码却没登记，运行时被日志器拒收（V13 第 38 批补登记，失败原因收成封闭枚举）
  MAIN_TRIAL_CONFIG_PROBLEM: { level: "error", fields: { count: "int" } },
  MAIN_TRIAL_GATEWAY_READY: { level: "info", fields: {} },
  MAIN_TRIAL_GATEWAY_FAILED: { level: "error", fields: { code: ["unseal", "timeout", "port_in_use", "start_failed", "other"] } },
  MAIN_TRIAL_GATEWAY_EXIT: { level: "warn", fields: { recent: "int" } },
  MAIN_KERNEL_READY: { level: "info", fields: {} },
  MAIN_KERNEL_FATAL: { level: "error", fields: {} },
  MAIN_KERNEL_EXITED: { level: "warn", fields: { "code?": "int" } },
  /** 开通或入组完成：主进程按 activation.json 有序重启内核（第 13 批）。 */
  MAIN_KERNEL_IDENTITY_RESTART: { level: "info", fields: {} },
  MAIN_KERNEL_IDENTITY_RESTART_FAILED: { level: "error", fields: {} },
  /** 从备份恢复时采用旧电脑的数据库主密钥（第 14 批）：只记结果。 */
  MAIN_ADOPT_KEY_DONE: { level: "info", fields: {} },
  MAIN_ADOPT_KEY_REJECTED: { level: "warn", fields: { reason: ["not_onboarding", "key_invalid", "unavailable", "write_failed"] } },
  /** 主密钥解封失败后律师选了“用恢复包恢复”：打不开的数据改名到 .unreadable-<时刻>/（v9.3 主文 §9 第 7 项）；只记结果与移动项数。 */
  MAIN_DATA_SET_ASIDE: { level: "warn", fields: { code: ["ok"], moved: "int" } },
  MAIN_DATA_SET_ASIDE_FAILED: { level: "error", fields: { code: ["exists", "cross_device", "move_failed"], moved: "int" } },
  MAIN_NOTIFY_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_CRASH_DIR_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_RUNTIME_PROBLEM: { level: "error", fields: { count: "int", stage: ["startup", "background"] } },
  // 第 64 批：随包运行时摘要核对完成（scope：gate = 出站闸门闭包先核完即放行闸门；all = 全部文件）；ms 自主进程开始核对算起
  MAIN_RUNTIME_VERIFIED: { level: "info", fields: { scope: ["gate", "all"], files: "int", ms: "ms" } },
  MAIN_SMOKE_FAILED: { level: "error", fields: { reason: "ident" } },
  MAIN_SAVE_FAILED: { level: "warn", fields: { ...ERR } },
  // v9.4 第 21 批：用系统默认程序打开刚保存的成果失败
  MAIN_OPEN_SAVED_FAILED: { level: "warn", fields: { ...ERR } },
  /** 导出 PDF 失败（第 29 批，主进程打印 Word 成果）：只记错误类别。 */
  MAIN_EXPORT_PDF_FAILED: { level: "warn", fields: { ...ERR } },
  MAIN_UPDATE_WARN: { level: "warn", fields: {} },
  MAIN_UPDATE_FAILED: { level: "error", fields: {} },
} as const satisfies Record<string, EventSpec>;

export type EventCode = keyof typeof EVENTS;

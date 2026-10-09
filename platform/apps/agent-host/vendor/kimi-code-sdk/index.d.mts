import type { ContentPart as ContentPart_2 } from '#human/llm/message';
import { Dispatcher } from 'undici';
import type { Draft } from 'immer';
import type { FinishReason } from '#human/llm/finish-reason';
import type { ImageUploadInput } from '#human/llm/media/upload';
import { ImageURLPart as ImageURLPart_2 } from '#human/llm/message';
import type { LlmCredentialProvider } from '#human/llm/requester/requester';
import { OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Readable } from 'node:stream';
import type { ResponseFormat } from '#human/llm/response-format';
import type { Role as Role_2 } from '#human/llm/message';
import { StreamedMessagePart } from '#human/llm/message';
import type { ThinkingEffort as ThinkingEffort_2 } from '#human/llm/thinking';
import { TokenUsage as TokenUsage_2 } from '#human/llm/usage';
import type { ToolCall as ToolCall_2 } from '#human/llm/message';
import type { ToolDescription } from '#human/llm/message';
import type { VideoUploadInput } from '#human/llm/media/upload';
import { VideoURLPart as VideoURLPart_2 } from '#human/llm/message';
import type { Writable } from 'node:stream';
import { z } from 'zod';

declare interface ActivatePluginCommandRpcInput extends SessionIdRpcInput {
    readonly pluginId: string;
    readonly commandName: string;
    readonly args?: string | undefined;
}

declare interface ActivateSkillRpcInput extends SessionIdRpcInput {
    readonly name: string;
    readonly args?: string | undefined;
}

export declare interface AddAdditionalDirInput {
    readonly id: string;
    readonly path: string;
    readonly persist: boolean;
}

export declare interface AddAdditionalDirOptions {
    /** When true, share the directory through workspace local config. When false,
     * keep it scoped to this session while still restoring it on session resume. */
    readonly persist: boolean;
}

export declare interface AddAdditionalDirResult {
    readonly additionalDirs: readonly string[];
    readonly projectRoot: string;
    readonly configPath: string;
    readonly persisted: boolean;
}

export declare type AgentBackgroundTaskInfo = SubagentTaskInfo;

export declare interface AgentCommandInfo {
    readonly name: string;
    readonly description?: string;
    readonly source: string;
}

declare type AgentCommandInfo_2 = Awaited<ReturnType<IAgentCommandService['list']>>[number];

declare interface AgentConfigData {
    cwd: string;
    provider?: ProviderConfig_2;
    modelAlias?: string;
    modelCapabilities: ModelCapability;
    profileName?: string;
    subagentNames?: readonly string[];
    thinkingEffort: string;
    systemPrompt: string;
}

declare interface AgentConfigData_2 {
    modelAlias?: string;
    modelCapabilities: ModelCapability_2;
    profileName?: string;
    thinkingLevel: string;
    systemPrompt: string;
}

declare type AgentConfigUpdateData = Partial<{
    cwd: string;
    modelAlias: string;
    profileName: string;
    subagentNames: readonly string[];
    thinkingEffort: string;
    systemPrompt: string;
}>;

declare interface AgentContext {
    readonly agentId: string;
    readonly generation: number;
    readonly space: AgentSpace;
}

declare interface AgentContextData {
    history: readonly ContextMessage[];
    tokenCount: number;
}

declare type AgentContextData_2 = {
    history: ReturnType<IAgentContextMemoryService['get']>;
    tokenCount: ReturnType<ISessionTokenCountingService['statusSize']>;
};

declare type AgentEvent = ErrorEvent | WarningEvent | AgentStatusUpdatedEvent | SessionMetaUpdatedEvent | SessionCreatedEvent | WorkspaceCreatedEvent | WorkspaceUpdatedEvent | WorkspaceDeletedEvent | SessionWorkChangedEvent | SessionStatusChangedEvent | ConfigChangedEvent | ConfigWarningEvent | ModelCatalogChangedEvent | PluginChangedEvent | CapabilityChangedEvent | GoalUpdatedEvent | SkillActivatedEvent | PluginCommandActivatedEvent | TurnStartedEvent | TurnEndedEvent | TurnStepStartedEvent | TurnStepCompletedEvent | TurnStepRetryingEvent | TurnStepInterruptedEvent | AssistantDeltaEvent | HookResultEvent | ThinkingDeltaEvent | ToolCallDeltaEvent | ToolCallStartedEvent | ToolProgressEvent | ShellOutputEvent | ShellStartedEvent | ShellCompletedEvent | ToolResultEvent | ToolListUpdatedEvent | McpServerStatusEvent | SubagentSpawnedEvent | SubagentStartedEvent | SubagentSuspendedEvent | SubagentCompletedEvent | SubagentFailedEvent | SubagentCancelledEvent | CompactionStartedEvent | CompactionBlockedEvent | CompactionCancelledEvent | CompactionCompletedEvent | TaskStartedEvent | TaskTerminatedEvent | BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent | CronFiredEvent | PromptSubmittedEvent | PromptCompletedEvent | PromptAbortedEvent | PromptSteeredEvent;

/** Public event name → payload type. Keys must stay in sync with `agentEvents`. */
declare interface AgentEventPayloads {
    'turn.started': z.infer<typeof turnStartedEventSchema>;
    'turn.ended': z.infer<typeof turnEndedEventSchema>;
    'assistant.delta': z.infer<typeof assistantDeltaEventSchema>;
    'thinking.delta': z.infer<typeof thinkingDeltaEventSchema>;
    'tool.call.started': z.infer<typeof toolCallStartedEventSchema>;
    'tool.call.delta': z.infer<typeof toolCallDeltaEventSchema>;
    'tool.progress': z.infer<typeof toolProgressEventSchema>;
    'tool.result': z.infer<typeof toolResultEventSchema>;
    'prompt.completed': z.infer<typeof promptCompletedEventSchema>;
    'prompt.aborted': z.infer<typeof promptAbortedEventSchema>;
    'compaction.started': z.infer<typeof compactionStartedEventSchema>;
    'compaction.blocked': z.infer<typeof compactionBlockedEventSchema>;
    'compaction.cancelled': z.infer<typeof compactionCancelledEventSchema>;
    'compaction.completed': z.infer<typeof compactionCompletedEventSchema>;
    'permission.approval.requested': z.infer<typeof permissionApprovalRequestedEventSchema>;
    'permission.approval.resolved': z.infer<typeof permissionApprovalResolvedEventSchema>;
    error: z.infer<typeof errorEventSchema>;
    warning: z.infer<typeof warningEventSchema>;
    'agent.status.updated': z.infer<typeof agentStatusUpdatedEventSchema>;
}

declare interface AgentFacade {
    prompt(input: {
        input: readonly ContentPart_3[];
        promptId?: string;
    }): Promise<PromptLaunchResult>;
    /**
     * Submit one prompt with one or more skill activations bundled into the
     * same user message: the skills are validated up front (an unknown name or
     * an empty list rejects the whole submission), rendered ahead of the
     * caller's parts in the same turn, and the bundle undoes as a single
     * anchor. Resolves with the submitted bundle's queue identity (`prompt_id`
     * / `created_at` / `state`), plus `turn_id` once launched — `state` is
     * `queued` when the submission queued behind a running turn.
     */
    promptWithSkills(input: PromptWithSkillsInput): Promise<PromptWithSkillsResult_2>;
    steer(input: {
        input: readonly ContentPart_3[];
    }): Promise<PromptLaunchResult>;
    /**
     * Activate a skill as a user-slash activation: the engine renders the skill
     * prompt and drives it as a normal turn (same settlement/event flow as
     * `prompt`). Resolves with the launched turn id; rejects when the skill is
     * unknown or the agent is busy.
     */
    activateSkill(input: {
        name: string;
        args?: string;
    }): Promise<PromptLaunchResult>;
    cancel(input?: {
        turnId?: number;
    }): Promise<void>;
    runShellCommand(input: {
        command: string;
        commandId?: string;
    }): Promise<ShellCommandResult>;
    cancelShellCommand(input: {
        commandId: string;
    }): Promise<void>;
    getModel(): Promise<string>;
    setModel(model: string): Promise<SetModelResult>;
    getThinking(): Promise<ThinkingLevel>;
    setThinking(level: string): Promise<void>;
    setPermission(mode: PermissionMode_2): Promise<void>;
    getUsage(): Promise<UsageStatus_2>;
    getContext(): Promise<AgentContextData_2>;
    listCommands(): Promise<readonly AgentCommandInfo_2[]>;
    runCommand(input: {
        name: string;
        args?: string;
    }): Promise<void>;
    getRuntime(): Promise<RuntimeBinding>;
    switchRuntime(runtimeId: string): Promise<RuntimeBinding>;
    getPlan(): Promise<PlanData_2>;
    enterPlan(): Promise<void>;
    clearPlan(): Promise<void>;
    cancelPlan(input?: {
        id?: string;
    }): Promise<void>;
    getTasks(input?: {
        activeOnly?: boolean;
        limit?: number;
    }): Promise<readonly AgentTaskInfo[]>;
    stopTask(input: {
        taskId: string;
        reason?: string;
    }): Promise<void>;
    getTaskOutput(input: {
        taskId: string;
        tail?: number;
    }): Promise<string>;
    /**
     * Session-merged MCP server entries (workspace set + ephemeral session
     * overlay). This is a live snapshot, so entries may still be pending while
     * the initial connection attempt runs.
     */
    getMcpServers(): Promise<readonly McpServerEntry[]>;
    /**
     * Trigger a manual full compaction. Async: `true` means the compaction was
     * started (it runs in the background); `false` means one is already running.
     * Throws when there is nothing to compact or a turn is active.
     */
    compact(input?: {
        instruction?: string;
    }): Promise<boolean>;
}

declare interface AgentFileDefinition {
    readonly name: string;
    readonly description: string;
    readonly whenToUse?: string;
    readonly override: boolean;
    readonly tools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly subagents?: readonly string[];
    readonly prompt: string;
    readonly path: string;
    readonly source: AgentFileSource;
}

declare type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

declare interface AgentHandle extends AgentFacade {
    readonly events: KlientEvents<AgentEventPayloads>;
}

declare type AgentLLMRequestLogFields = Readonly<LogContext_2>;

declare type AgentLLMRequestSource = {
    readonly type: 'turn';
    readonly turnId: number;
    readonly step?: number;
    readonly logFields?: AgentLLMRequestLogFields;
} | {
    readonly type: 'operation';
    readonly turnId?: number;
    readonly requestKind?: string;
    readonly logFields?: AgentLLMRequestLogFields;
};

declare interface AgentMeta {
    readonly homedir?: string;
    readonly type: AgentType;
    readonly parentAgentId?: string | null;
    readonly swarmItem?: string;
    readonly profileName?: string;
    readonly sessionInit?: string;
}

declare interface AgentMeta_2 {
    readonly homedir?: string;
    readonly type?: 'main' | 'sub' | 'independent';
    readonly parentAgentId?: string | null;
    readonly forkedFrom?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly swarmItem?: string;
}

declare abstract class AgentModel<S> implements DomainResourceRuntime {
    private committedState;
    private window;
    private readonly appliers;
    private sealed;
    readonly agent: AgentContext;
    private readonly bridge;
    constructor(context: AgentModelContext);
    protected get state(): Draft<S>;
    protected set state(value: S);
    protected on<P, E extends Event2<P>>(cls: Event2Class<P, E>, applier: (event: E) => void): void;
    protected emit(event: Event2<any>): Promise<void>;
    protected readLegacy<T>(key: StateKey<T>): T;
    onUndo?(count: number): void;
    dispose(): void | Promise<void>;
    _seal(): void;
    _appliersTable(): ReadonlyMap<Event2Class<any, any>, (event: any) => void>;
    _state(): S;
    _commitState(next: S): void;
    _enterWindow(draft: S, ctx: FoldContext): void;
    _exitWindow(): {
        readonly replaced: boolean;
        readonly replacement: unknown;
    };
}

declare interface AgentModelBridge {
    dispatch(event: Event2<any>): Promise<void>;
    readLegacy(key: StateKey<any>): unknown;
    initialState(): unknown;
}

declare interface AgentModelContext {
    readonly agent: AgentContext;
    readonly bridge: AgentModelBridge;
}

declare interface AgentModelDefinition<S = any, M extends AgentModel<S> = AgentModel<S>> {
    readonly id: string;
    readonly model: new (context: AgentModelContext) => M;
    readonly state: AgentModelStateSpec<S>;
    readonly events: readonly Event2Class<any, any>[];
    readonly undoable: boolean;
}

declare type AgentModelInstanceOf<D> = D extends AgentModelDefinition<any, infer M> ? M : never;

declare interface AgentModelStateSpec<S> {
    readonly initial: () => S;
    readonly schema: z.ZodType<S>;
}

declare type AgentPhase = {
    readonly kind: 'idle';
} | {
    readonly kind: 'running';
    readonly turnId: number;
    readonly step: number;
    readonly stepId: string;
    readonly since: number;
} | {
    readonly kind: 'tool_call';
    readonly turnId: number;
    readonly step: number;
    readonly toolCallId: string;
    readonly name: string;
    readonly since: number;
} | {
    readonly kind: 'retrying';
    readonly turnId: number;
    readonly step: number;
    readonly stepId: string;
    readonly failedAttempt: number;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly errorName?: string;
    readonly statusCode?: number;
    readonly since: number;
} | {
    readonly kind: 'awaiting_approval';
    readonly turnId: number;
    readonly step?: number;
    readonly approval?: unknown;
    readonly since: number;
} | {
    readonly kind: 'interrupted';
    readonly turnId: number;
    readonly step?: number;
    readonly reason: 'aborted' | 'max_steps' | 'error';
    readonly message?: string;
    readonly at: number;
} | {
    readonly kind: 'ended';
    readonly turnId: number;
    readonly reason: TurnEndReason;
    readonly durationMs?: number;
    readonly at: number;
};

declare interface AgentProfile {
    readonly name: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly override?: boolean;
    readonly tools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly subagents?: readonly string[];
    readonly systemPrompt: (context: AgentProfileContext) => string;
    readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
    readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
}

declare interface AgentProfileContext {
    readonly cwd?: string;
    readonly cwdListing?: string;
    readonly agentsMd?: string;
    readonly additionalDirsInfo?: string;
    readonly osKind?: string;
    readonly shellName?: string;
    readonly shellPath?: string;
    readonly skills?: string;
    readonly skillActive?: boolean;
    readonly pluginSections?: string;
    readonly productName?: string;
    readonly replyStyleGuide?: string;
    readonly notifyUserActive?: boolean;
    readonly [key: string]: unknown;
}

declare interface AgentProfilePromptPrefixContext {
    readonly cwd: string;
    readonly process: IHostProcessService;
    readonly log?: ILogger;
}

export declare type AgentReplayRecord = {
    readonly time: number;
} & AgentReplayRecordPayload;

declare type AgentReplayRecordPayload = {
    type: 'message';
    message: ContextMessage;
} | {
    type: 'compaction';
    result?: CompactionResult | 'cancelled';
    instruction?: string;
} | {
    type: 'goal_updated';
    snapshot: GoalSnapshot;
    change: GoalChange | {
        readonly kind: 'created';
    };
} | {
    type: 'plan_updated';
    enabled: boolean;
} | {
    type: 'config_updated';
    config: AgentConfigUpdateData;
} | {
    type: 'permission_updated';
    mode: PermissionMode;
} | {
    type: 'approval_result';
    record: PermissionApprovalResultRecord;
};

export declare interface AgentRuntimeBinding {
    readonly workspaceId: string;
    readonly runtimeId: string;
}

declare interface AgentSpace {
    use<D extends AgentModelDefinition<any, any>, R>(definition: D, run: (model: AgentModelInstanceOf<D>) => R): R;
}

export declare interface AgentStatusUpdatedEvent {
    readonly type: 'agent.status.updated';
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly contextTokens?: number;
    readonly maxContextTokens?: number;
    readonly contextUsage?: number;
    readonly planMode?: boolean;
    readonly swarmMode?: boolean;
    readonly towerMode?: boolean;
    readonly permission?: PermissionMode_2;
    readonly usage?: UsageStatus;
    readonly phase?: AgentPhase;
}

/** `agent.status.updated` carries a wide optional status bag; kept loose. */
declare const agentStatusUpdatedEventSchema: z.ZodObject<{
    time: z.ZodOptional<z.ZodNumber>;
    phase: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;

declare interface AgentTask {
    readonly idPrefix: string;
    readonly kind: AgentTaskKind;
    readonly description: string;
    readonly timeoutMs?: number;
    start(sink: AgentTaskSink): void | Promise<void>;
    onDetach?(): void;
    forceStop?(): Promise<void>;
    toInfo(base: AgentTaskInfoBase): AgentTaskInfo_2;
}

declare type AgentTaskInfo = Awaited<ReturnType<IAgentTaskService['list']>>[number];

declare type AgentTaskInfo_2 = AgentTaskInfoByKind[AgentTaskKind];

declare interface AgentTaskInfoBase {
    readonly taskId: string;
    readonly description: string;
    readonly status: AgentTaskStatus;
    readonly detached?: boolean;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly stopReason?: string;
    readonly terminalNotificationSuppressed?: boolean;
    readonly resumeReminded?: boolean;
    readonly timeoutMs?: number;
}

declare type AgentTaskKind = Extract<keyof AgentTaskInfoByKind, string>;

declare interface AgentTaskOutputSnapshot {
    readonly outputPath?: string;
    readonly outputSizeBytes: number;
    readonly previewBytes: number;
    readonly truncated: boolean;
    readonly fullOutputAvailable: boolean;
    readonly preview: string;
}

declare interface AgentTaskSettlement {
    readonly status: AgentTaskSettlementStatus;
    readonly stopReason?: string;
}

declare type AgentTaskSettlementStatus = 'completed' | 'failed' | 'timed_out' | 'killed';

declare interface AgentTaskSink {
    readonly signal: AbortSignal;
    appendOutput(chunk: string): void;
    settle(settlement: AgentTaskSettlement): Promise<boolean>;
}

declare type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';

declare interface AgentTaskTrackOptions {
    readonly idPrefix?: string;
    readonly description: string;
    readonly detached?: boolean;
    readonly timeoutMs?: number;
    readonly detachTimeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly forceStop?: () => Promise<void>;
    readonly onDetach?: () => void;
    readonly toInfo: (base: AgentTaskInfoBase) => AgentTaskInfo_2;
}

declare interface AgentTaskWaitDelivery {
    readonly taskId: string;
    readonly status: AgentTaskStatus;
}

declare type AgentType = 'main' | 'sub' | 'independent';

/**
 * Anonymous (single-model) provider input — all connectivity details inline.
 * Passed as a single object to `kosong.addProvider(config)`.
 */
declare interface AnonymousProviderInput {
    /** Used as the model identifier in the model registry. */
    id: string;
    /** Wire model name sent to the provider. */
    model: string;
    /** Protocol identifier (`'openai'`, `'anthropic'`, …). */
    protocol: string;
    baseUrl: string;
    auth: ProviderAuth;
    displayName?: string;
    maxContextSize?: number;
    capabilities?: Record<string, boolean>;
}

declare interface Anthropic {}

declare interface AnthropicOptions {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    model: string;
    defaultMaxTokens?: number | undefined;
    betaFeatures?: string[] | undefined;
    defaultHeaders?: Record<string, string>;
    metadata?: Record<string, string> | undefined;
    /** Use streaming API. Defaults to true. Set to false for non-streaming (test/fallback). */
    stream?: boolean | undefined;
    /**
     * Explicitly declare whether the model supports adaptive thinking
     * (`thinking: { type: 'adaptive' }`), overriding the model-name version
     * inference. Useful for custom-named endpoints whose model name does not
     * encode a parseable Claude version. Leave undefined to infer from the name.
     */
    adaptiveThinking?: boolean | undefined;
    /**
     * Concrete thinking efforts declared by the model catalog. When omitted,
     * the provider infers a Claude profile from the model name and falls back to
     * the latest Opus profile for unrecognized Anthropic-compatible models.
     */
    supportEfforts?: readonly string[] | undefined;
    kimiThinking?: boolean | undefined;
    /**
     * Use the Anthropic **beta** Messages API (`client.beta.messages.create`,
     * `POST /v1/messages?beta=true`) instead of the standard Messages API.
     *
     * Beta features (`betaFeatures`) are then sent via the request `betas`
     * field rather than the `anthropic-beta` header. Defaults to false, which
     * keeps the standard endpoint + header behavior.
     */
    betaApi?: boolean | undefined;
    clientFactory?: (auth: ProviderRequestAuth) => Anthropic;
    /**
     * Vendor error classification, consulted by `convertAnthropicError` with
     * each raw SDK failure exactly once (after the abort guard and the
     * already-converted pass-through) before the base rules run. `undefined`
     * keeps the base classification. A Kimi provider routed over this
     * transport passes `classifyKimiQuotaError` here so a quota-exhausted 429
     * fails fast instead of burning the retry budget.
     */
    convertError?: (error: unknown) => ChatProviderError | undefined;
}

/**
 * Writes a catalog-selected provider and its model aliases into `config` and
 * marks it the default. Model metadata (context, output limit, capabilities)
 * comes from the catalog, so the user does not hand-write it. Returns the
 * default model key.
 *
 * NOTE: the same-provider cleanup below mutates the passed-in `config` only.
 * It clears stale aliases on disk solely when the caller overwrites the whole
 * config. Callers persisting via `setConfig` — a deep-merge patch that cannot
 * delete keys — must call `removeProvider` first, or removed aliases reappear
 * after the merge.
 */
export declare function applyCatalogProvider(config: KimiConfig, options: ApplyCatalogProviderOptions): {
    defaultModel: string;
};

export declare interface ApplyCatalogProviderOptions {
    readonly providerId: string;
    readonly wire: ProviderType_2;
    readonly baseUrl?: string;
    readonly apiKey: string;
    readonly models: readonly CatalogModel[];
    readonly selectedModelId: string;
    readonly thinking: boolean;
}

declare interface ApplyProfileOptions {
    readonly additionalDirs?: readonly string[];
}

export declare type AppMcpServerAuthState = McpServerAuthState;

export declare type AppMcpServerConfig = McpServerConfigView;

export declare type AppMcpServerDescriptor = McpServerDescriptor;

export declare type AppMcpServerInspection = McpServerInspection;

export declare type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export declare type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export declare interface ApprovalRequest {
    readonly turnId?: number | undefined;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly action: string;
    readonly display: ToolInputDisplay;
}

declare interface ApprovalRequest_2 {
    readonly id?: string;
    readonly sessionId?: string;
    readonly agentId?: string;
    readonly turnId?: number;
    readonly toolCallId?: string;
    readonly toolName: string;
    readonly action: string;
    readonly display: ToolInputDisplay;
}

export declare interface ApprovalResponse {
    readonly decision: ApprovalDecision;
    readonly scope?: 'session';
    readonly feedback?: string;
    readonly selectedLabel?: string;
}

export declare type ApprovalScope = 'session';

export declare interface AssistantDeltaEvent extends Omit<AssistantDeltaPayload, 'agentId'> {
    readonly type: 'assistant.delta';
}

declare const assistantDeltaEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"assistant.delta">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    delta: z.ZodString;
}, z.core.$strip>;

declare interface AssistantDeltaPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly delta: string;
}

declare interface AudioURLPart {
    type: 'audio_url';
    audioUrl: {
        url: string;
        id?: string;
    };
}

declare interface AudioURLPart_2 {
    type: 'audio_url';
    audioUrl: {
        url: string;
        id?: string;
    };
}

export declare interface AuthenticateMcpServerOptions {
    readonly onAuthorizationUrl: (url: string) => void | boolean | PromiseLike<void | boolean>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly cwd?: string;
}

declare type AuthManagedUsageResult = {
    readonly kind: 'ok';
    readonly quota: ManagedQuota;
} | FetchManagedUsageError;

declare type AuthManagedUserInfoResult = ManagedUserInfoResult;

declare type AuthorizedRequest = <T>(request: (auth: ProviderRequestAuth) => Promise<T>) => Promise<T>;

declare interface AuthProviderStatus {
    readonly providerName: string;
    readonly hasToken: boolean;
}

declare interface AuthStatus {
    readonly providers: readonly AuthProviderStatus[];
}

declare interface AuthStatus_2 {
    readonly loggedIn: boolean;
    readonly provider?: string;
}

export declare type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

declare const BackgroundConfigSchema: z.ZodObject<{
    maxRunningTasks: z.ZodOptional<z.ZodNumber>;
    keepAliveOnExit: z.ZodOptional<z.ZodBoolean>;
    bashAutoBackgroundOnTimeout: z.ZodOptional<z.ZodBoolean>;
    bashTaskTimeoutS: z.ZodOptional<z.ZodNumber>;
    killGracePeriodMs: z.ZodOptional<z.ZodNumber>;
    printWaitCeilingS: z.ZodOptional<z.ZodNumber>;
    printBackgroundMode: z.ZodOptional<z.ZodEnum<{
        steer: "steer";
        exit: "exit";
        drain: "drain";
    }>>;
    printMaxTurns: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

export declare type BackgroundTaskInfo = ProcessBackgroundTaskInfo | AgentBackgroundTaskInfo | QuestionBackgroundTaskInfo;

declare interface BackgroundTaskOrigin {
    readonly kind: 'background_task';
    readonly taskId: string;
    readonly status: BackgroundTaskStatus;
    readonly notificationId: string;
}

export declare interface BackgroundTaskStartedEvent {
    readonly type: 'background.task.started';
    readonly info: TaskInfo;
}

export declare type BackgroundTaskStatus = AgentTaskStatus;

export declare interface BackgroundTaskTerminatedEvent {
    readonly type: 'background.task.terminated';
    readonly info: TaskInfo;
}

declare interface BearerTokenProvider {
    getAccessToken(options?: {
        readonly force?: boolean | undefined;
    }): Promise<string>;
}

declare interface BeginAuthorizationOptions {
    readonly clientLabel?: string;
}

declare interface BeginAuthorizationResult {
    readonly authorizationUrl: URL;
    complete(opts?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<void>;
    cancel(): Promise<void>;
}

declare type BeginGlobalMcpServerAuthResult = McpServerAuthBeginResult;

declare interface BindAgentInput {
    readonly profile: string;
    readonly model?: string;
    readonly thinking?: string;
    readonly strictThinking?: boolean;
}

export declare function buildDaemonFileUrl(fileId: string): string;

export declare function buildImageCompressionCaption(input: ImageCompressionCaptionInput): string;

export declare function buildMediaPathTag(kind: MediaKind, path: string): string;

export declare function buildUnsupportedImageNotice(mimeType: string, name?: string, providerType?: string): string;

declare interface BundledSkillActivation {
    readonly activationId: string;
    readonly skillName: string;
    readonly skillArgs?: string;
    readonly skillType?: string;
    readonly skillPath?: string;
    readonly skillSource?: SkillSource_3;
}

declare interface CapabilityChangedEvent {
    readonly type: 'event.capability.changed';
    readonly capability_id: string;
    readonly install: CapabilityInstallProgress;
}

declare type CapabilityId = 'kimi-cu' | 'kimi-webbridge';

declare interface CapabilityInstallProgress {
    readonly running: boolean;
    readonly step?: string;
    readonly percent?: number;
    readonly error?: string;
    readonly note?: string;
}

declare type CapabilityReadiness = 'not_installed' | 'partial' | 'ready' | 'unsupported';

export declare interface CapabilityStatus {
    readonly id: CapabilityId;
    readonly pluginId?: string;
    readonly displayName: string;
    readonly description: string;
    readonly supported: boolean;
    readonly state: CapabilityReadiness;
    readonly version?: string;
    readonly steps: readonly CapabilityStep[];
    readonly install: CapabilityInstallProgress;
}

declare interface CapabilityStep {
    readonly id: string;
    readonly state: CapabilityStepState;
    readonly detail?: string;
    readonly optional?: boolean;
}

declare type CapabilityStepState = 'ok' | 'missing' | 'failed';

/** Top-level catalog: `{ [providerId]: ProviderEntry }` (e.g. models.dev/api.json). */
export declare type Catalog = Record<string, CatalogProviderEntry>;

/**
 * Resolves the base URL to store for a catalog provider, adapting the catalog's
 * `api` to the wire's SDK convention.
 *
 * models.dev `api` URLs are written for the SDK named in `npm` (e.g.
 * `@ai-sdk/anthropic`), whose base already includes the `/v1` version segment.
 * We route the `anthropic` wire through the official `@anthropic-ai/sdk`, which
 * appends `/v1/messages` itself — so a catalog `api` ending in `/v1` would POST
 * to `/v1/v1/messages` (404). Strip the trailing `/v1` for anthropic. OpenAI
 * family SDKs append `/chat/completions` to a `/v1` base, so those pass through.
 * URLs containing `${VAR}` are SDK-side env interpolations the config cannot
 * express; they resolve to `undefined` so callers can ask for a URL instead.
 */
export declare function catalogBaseUrl(entry: CatalogProviderEntry, wire: ProviderType_2): string | undefined;

/** Payload of `event.model_catalog.changed` — same shape as an OAuth refresh result. */
declare type CatalogChangedPayload = Awaited<ReturnType<IOAuthService['refreshOAuthProviderModels']>>;

export declare class CatalogFetchError extends Error {
    readonly status: number;
    constructor(message: string, status: number);
}

/** Why a catalog import cannot proceed at all. */
export declare type CatalogImportInvalidReason = 
/** `type` is present but names a protocol this client version does not know. */
'unknown-explicit-type'
/** SDK known to be non-OpenAI proprietary (Amazon Bedrock, Cohere). */
| 'proprietary-sdk'
/** A base URL was supplied but is blank. */
| 'empty-base-url'
/** The endpoint contains an env placeholder (`${VAR}`) the config cannot express. */
| 'placeholder-base-url';

/**
 * The outcome of resolving a catalog provider for import — the single
 * decision point for "which wire, which endpoint, or exactly why not".
 * Pattern-match on {@link CatalogImportResolution.kind}:
 *  - `ok`: persist `wire` (and `baseUrl` when present — absent means the
 *    wire's official-SDK default endpoint applies); surface `guessed` so the
 *    user knows the protocol came from the OpenAI-compatible fallback.
 *  - `needs-base-url`: the catalog supplies no usable endpoint and the
 *    wire's default would point at the wrong host — ask the user for one
 *    (`--base-url` on the CLI, a prompt in the TUI), then re-resolve with it.
 *  - `invalid`: refuse with the reason.
 */
export declare type CatalogImportResolution = {
    readonly kind: 'ok';
    readonly wire: ProviderType_2;
    readonly guessed: boolean;
    readonly baseUrl?: string;
} | {
    readonly kind: 'needs-base-url';
    readonly wire: ProviderType_2;
    readonly guessed: boolean;
} | {
    readonly kind: 'invalid';
    readonly reason: CatalogImportInvalidReason;
};

/** A normalized catalog model: identity plus its {@link ModelCapability}. */
export declare interface CatalogModel {
    readonly id: string;
    readonly name?: string;
    readonly maxOutputSize?: number;
    readonly reasoningKey?: string;
    /** Declared thinking effort levels from `reasoning_options`, when present. */
    readonly supportEfforts?: readonly string[];
    /**
     * The effort value that encodes "thinking off" for this model (models.dev
     * declares it as the `'none'` entry in `reasoning_options`). Undefined when
     * the model has no such value — then `off` simply sends no effort field.
     */
    readonly offEffort?: string;
    /**
     * True when the model declares effort levels without any way to disable
     * thinking (no `toggle` entry and no `'none'` value) — it always reasons at
     * some level, so the UI must not offer an off option.
     */
    readonly alwaysThinking?: boolean;
    /**
     * Per-model protocol override from the catalog entry's `provider` field
     * (gateway providers serving this model over the Anthropic protocol).
     */
    readonly protocol?: 'anthropic';
    /** Endpoint paired with {@link protocol}, adapted to the wire's SDK convention. */
    readonly baseUrl?: string;
    readonly capability: ModelCapability;
}

/**
 * models.dev-style catalog: a public map of provider/model metadata. Callers
 * consume a snapshot of this shape to populate provider + model configuration
 * without hand-writing context windows or capabilities.
 */
declare interface CatalogModelEntry {
    readonly id?: string;
    readonly name?: string;
    readonly family?: string;
    readonly limit?: {
        readonly context?: number;
        readonly input?: number;
        readonly output?: number;
    };
    readonly tool_call?: boolean;
    readonly reasoning?: boolean;
    /**
     * models.dev reasoning declaration: `[{ type: 'toggle' }, ...]` entries.
     * Only `{ type: 'effort', values: [...] }` maps onto concrete thinking
     * effort levels; `toggle` is the boolean form and `budget_tokens` a token
     * budget — neither yields an effort list.
     */
    readonly reasoning_options?: readonly CatalogReasoningOption[];
    /** Lifecycle marker: `'deprecated'` models are dropped at import. */
    readonly status?: string;
    /**
     * Per-model serving override on gateway providers (zenmux, opencode, …):
     * the model speaks a different protocol (`npm`) and/or lives on a different
     * endpoint (`api`) than the provider default.
     */
    readonly provider?: CatalogModelProviderOverride;
    /** Accepts message-level tool declarations (`messages[].tools`). Defaults to false. */
    readonly dynamically_loaded_tools?: boolean;
    readonly interleaved?: boolean | {
        readonly field?: string;
    };
    readonly modalities?: {
        readonly input?: readonly string[];
        readonly output?: readonly string[];
    };
}

declare interface CatalogModelProviderOverride {
    readonly npm?: string;
    readonly api?: string;
}

/** Builds a kimi-code model alias from a normalized catalog model. */
export declare function catalogModelToAlias(providerId: string, model: CatalogModel): ModelAlias;

export declare interface CatalogProviderEntry {
    readonly id?: string;
    readonly name?: string;
    /** Base URL for the provider; may be empty (some SDKs hardcode it). */
    readonly api?: string;
    /** Env var names carrying credentials — surfaced as a hint by callers. */
    readonly env?: readonly string[];
    /** models.dev SDK package id; used to infer the wire type when `type` is absent. */
    readonly npm?: string;
    /** Explicit wire type extension; inferred from `npm`/`id` when absent. */
    readonly type?: string;
    readonly models?: Record<string, CatalogModelEntry>;
}

/** Extracts the valid, normalized models from a catalog provider entry. */
export declare function catalogProviderModels(entry: CatalogProviderEntry): CatalogModel[];

declare interface CatalogReasoningOption {
    readonly type?: string;
    readonly values?: unknown;
}

/**
 * Base error for all chat provider errors.
 */
declare class ChatProviderError extends Error {
    constructor(message: string);
}

export declare interface CompactionBlockedEvent extends Omit<CompactionBlockedPayload, 'agentId'> {
    readonly type: 'compaction.blocked';
}

declare const compactionBlockedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"compaction.blocked">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

declare interface CompactionBlockedPayload {
    readonly agentId: string;
    readonly turnId?: number;
}

export declare interface CompactionCancelledEvent {
    readonly type: 'compaction.cancelled';
}

declare const compactionCancelledEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"compaction.cancelled">;
    time: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

export declare interface CompactionCompletedEvent extends Omit<CompactionCompletedPayload, 'agentId'> {
    readonly type: 'compaction.completed';
}

/**
 * Protocol `CompactionResult` — mirrored field-for-field. The engine's
 * internal result additionally carries `contextSummary`, but the service
 * strips it before publishing (`fullCompactionService.ts`), so it never
 * reaches the wire.
 */
declare const compactionCompletedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"compaction.completed">;
    time: z.ZodOptional<z.ZodNumber>;
    result: z.ZodObject<{
        summary: z.ZodString;
        compactedCount: z.ZodNumber;
        tokensBefore: z.ZodNumber;
        tokensAfter: z.ZodNumber;
        keptUserMessageCount: z.ZodOptional<z.ZodNumber>;
        keptHeadUserMessageCount: z.ZodOptional<z.ZodNumber>;
        droppedCount: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>;
}, z.core.$strip>;

declare interface CompactionCompletedPayload {
    readonly agentId: string;
    readonly result: CompactionResult;
}

export declare interface CompactionResult {
    summary: string;
    contextSummary?: string;
    compactedCount: number;
    tokensBefore: number;
    tokensAfter: number;
    keptUserMessageCount?: number;
    keptHeadUserMessageCount?: number;
    droppedCount?: number;
}

declare type CompactionSource = 'manual' | 'auto';

export declare interface CompactionStartedEvent extends Omit<CompactionStartedPayload, 'agentId'> {
    readonly type: 'compaction.started';
}

declare const compactionStartedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"compaction.started">;
    time: z.ZodOptional<z.ZodNumber>;
    trigger: z.ZodEnum<{
        manual: "manual";
        auto: "auto";
    }>;
    instruction: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface CompactionStartedPayload {
    readonly agentId: string;
    readonly trigger: CompactionSource;
    readonly instruction?: string;
}

declare interface CompactionSummaryOrigin {
    readonly kind: 'compaction_summary';
}

declare interface CompactionSummaryOrigin_2 {
    readonly kind: 'compaction_summary';
}

export declare interface CompactOptions {
    readonly instruction?: string | undefined;
}

export declare function compressBase64ForModel(base64: string, mimeType: string, options?: CompressImageOptions): Promise<CompressBase64Result>;

export declare interface CompressBase64Result {
    readonly base64: string;
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly originalWidth: number;
    readonly originalHeight: number;
    readonly changed: boolean;
    readonly originalByteLength: number;
    readonly finalByteLength: number;
}

export declare function compressImageForModel(bytes: Uint8Array, mimeType: string, options?: CompressImageOptions): Promise<CompressImageResult>;

export declare interface CompressImageOptions {
    readonly maxEdge?: number;
    readonly byteBudget?: number;
    readonly maxDecodeBytes?: number;
    readonly telemetry?: ImageCompressionTelemetry;
}

export declare interface CompressImageResult {
    readonly data: Uint8Array;
    readonly mimeType: string;
    readonly width: number;
    readonly height: number;
    readonly originalWidth: number;
    readonly originalHeight: number;
    readonly changed: boolean;
    readonly originalByteLength: number;
    readonly finalByteLength: number;
}

declare interface ConfigChangedEvent {
    readonly type: 'event.config.changed';
    readonly changedFields: string[];
    readonly config: ConfigResponse;
}

declare interface ConfigChangedEvent_2 {
    readonly domain: string;
    readonly source: ConfigChangeSource;
    readonly value: unknown;
    readonly previousValue: unknown;
}

declare type ConfigChangeSource = 'load' | 'reload' | 'set';

declare interface ConfigDiagnostic {
    readonly domain?: string;
    readonly severity: 'warning' | 'error';
    readonly message: string;
}

export declare interface ConfigDiagnostics {
    readonly warnings: readonly string[];
}

declare interface ConfigInspectValue<T = unknown> {
    readonly value: T | undefined;
    readonly defaultValue: T | undefined;
    readonly userValue: T | undefined;
    readonly memoryValue: T | undefined;
}

declare interface ConfigResponse {
    providers: Record<string, ProviderConfigResponse>;
    default_provider?: string;
    default_model?: string;
    models?: Record<string, unknown>;
    thinking?: unknown;
    plan_mode?: boolean;
    yolo?: boolean;
    default_permission_mode?: string;
    default_plan_mode?: boolean;
    permission?: unknown;
    hooks?: unknown[];
    services?: unknown;
    merge_all_available_skills?: boolean;
    extra_skill_dirs?: string[];
    loop_control?: unknown;
    background?: unknown;
    experimental?: Record<string, boolean>;
    telemetry?: boolean;
    raw?: Record<string, unknown>;
    [key: string]: unknown;
}

declare enum ConfigTarget {
    User = "user",
    Memory = "memory"
}

/** String-literal form of the engine's `ConfigTarget` enum, so consumers never import the enum value. */
declare type ConfigTargetLiteral = `${ConfigTarget}`;

declare interface ConfigWarningEvent {
    readonly type: 'event.config.warning';
    readonly warnings: readonly ConfigWarningItem[];
}

declare interface ConfigWarningItem {
    readonly domain?: string;
    readonly message: string;
}

/**
 * A single piece of content within a {@link Message}.
 *
 * The union covers text, model reasoning ("think"), images, audio, and video.
 * Providers convert these to their native content-block format during
 * {@link ChatProvider.generate}.
 */
export declare type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

declare type ContentPart_3 = TextPart_2 | ThinkPart_2 | ImageURLPart_3 | AudioURLPart_2 | VideoURLPart_3;

declare interface ContextCompactionInput {
    readonly summary: string;
    readonly contextSummary?: string;
    readonly compactedCount: number;
    readonly tokensBefore: number;
    readonly tokensAfter?: number;
    readonly summaryOutputTokens?: number;
    readonly requestOverheadTokens?: number;
    readonly keptUserMessageCount?: number;
    readonly keptHeadUserMessageCount?: number;
    readonly droppedCount?: number;
    readonly wireLines?: WireLineRange;
}

declare interface ContextCompactionResult {
    summary: string;
    contextSummary: string;
    compactedCount: number;
    tokensBefore: number;
    tokensAfter: number;
    keptUserMessageCount: number;
    keptHeadUserMessageCount?: number;
    droppedCount?: number;
}

export declare type ContextMessage = Message & {
    readonly origin?: PromptOrigin | undefined;
    readonly isError?: boolean;
    toolCallDisplays?: Record<string, ToolInputDisplay>;
    readonly note?: string;
};

declare type ContextMessage_2 = Message_2 & {
    readonly id?: string;
    readonly providerMessageId?: string;
    readonly origin?: PromptOrigin_2 | undefined;
    readonly isError?: boolean;
    toolCallDisplays?: Record<string, ToolInputDisplay>;
    readonly note?: string;
    readonly usage?: TokenUsage_2;
    readonly llmTiming?: ContextMessageTiming;
    readonly durationMs?: number;
};

declare interface ContextMessageTiming {
    readonly llmFirstTokenLatencyMs?: number;
    readonly llmStreamDurationMs?: number;
}

declare interface ContextSize {
    readonly size: number;
    readonly measured: number;
    readonly estimated: number;
}

export declare interface CreateGoalInput {
    readonly objective: string;
    readonly replace?: boolean;
}

export declare function createKimiConfigRpc(): KimiConfigRpc;

export declare function createKimiHarness(options: KimiHarnessOptions): KimiHarness;

export declare interface CreateSessionOptions {
    readonly id?: string | undefined;
    readonly workDir: string;
    readonly model?: string | undefined;
    readonly thinking?: string | undefined;
    readonly permission?: PermissionMode | undefined;
    readonly planMode?: boolean;
    readonly metadata?: JsonObject | undefined;
    readonly kaos?: Kaos | undefined;
    readonly persistenceKaos?: Kaos | undefined;
    readonly additionalDirs?: readonly string[];
    /**
     * Main-agent profile name (`--agent`): a builtin profile or one defined by
     * an agentfile discovered from the user/project agent directories.
     */
    readonly agentProfile?: string;
    /**
     * Explicit agentfiles (`--agent-file`) loaded for this session with the
     * highest precedence; an invalid file fails session creation.
     */
    readonly agentFiles?: readonly string[];
    readonly sessionStartedProperties?: TelemetryProperties;
    /**
     * Print-mode (`kimi -p`) only: when the main agent ends a turn while
     * background subagents (`kind === 'agent'`) are still running, hold the turn
     * open and idle-wait until they all finish, flushing their completions into
     * the turn so the model can react before the run exits. Ignored by
     * interactive / SDK sessions.
     */
    readonly drainAgentTasksOnStop?: boolean;
}

export declare interface CronFiredEvent extends CronFiredPayload {
    readonly type: 'cron.fired';
}

declare interface CronFiredPayload {
    readonly origin: CronJobOrigin_2;
    readonly prompt: string;
}

declare interface CronJobOrigin {
    readonly kind: 'cron_job';
    readonly jobId: string;
    readonly cron: string;
    readonly recurring: boolean;
    readonly coalescedCount: number;
    readonly stale: boolean;
}

declare interface CronJobOrigin_2 {
    readonly kind: 'cron_job';
    readonly jobId: string;
    readonly cron: string;
    readonly recurring: boolean;
    readonly coalescedCount: number;
    readonly stale: boolean;
}

declare interface CronMissedOrigin {
    readonly kind: 'cron_missed';
    readonly count: number;
}

declare interface CronMissedOrigin_2 {
    readonly kind: 'cron_missed';
    readonly count: number;
}

export declare interface CronTaskSnapshot {
    readonly id: string;
    readonly cron: string;
    readonly recurring: boolean;
    readonly createdAt: number;
    readonly lastFiredAt: number | undefined;
    readonly nextFireAt: number | null;
}

export declare interface DaemonFileRef {
    readonly fileId: string;
}

export declare const DEFAULT_CATALOG_URL = "https://models.dev/api.json";

/** RFC 8628 §3.2 device authorization response. */
declare interface DeviceAuthorization {
    readonly userCode: string;
    readonly deviceCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string;
    /** Seconds until device_code expires (server-reported). May be null. */
    readonly expiresIn: number | null;
    /** Polling interval in seconds. */
    readonly interval: number;
}

declare class DisposableStore implements IDisposable_2 {
    private readonly _ledger;
    private readonly _entries;
    private _isDisposed;
    constructor();
    get ledger(): Ledger;
    add<T extends IDisposable_2>(d: T): T;
    delete<T extends IDisposable_2>(d: T): void;
    deleteAndLeak<T extends IDisposable_2>(d: T): void;
    clear(): void;
    dispose(): void;
    get isDisposed(): boolean;
    assertNotDisposed(): void;
}

declare type Disposer = (reason: TeardownReason) => void | Promise<void>;

declare interface DomainResourceRuntime {
    dispose(): void | Promise<void>;
    abort?(reason?: unknown): void;
}

declare type EffectBody = () => EffectResult;

export declare function effectiveModelAlias(alias: ModelAlias, providerType?: ProviderType): ModelAlias;

declare type EffectResult = void | Disposer | Promise<Disposer | void> | Iterable<Disposer | void> | AsyncIterable<Disposer | void>;

declare type Env = Readonly<Record<string, string | undefined>>;

declare type Env_2 = Readonly<Record<string, string | undefined>>;

declare interface Environment {
    readonly osKind: OsKind;
    readonly osArch: string;
    readonly osVersion: string;
    readonly shellName: ShellName;
    readonly shellPath: string;
}

declare interface EnvironmentDisclosureSnapshot {
    readonly cwd: string;
}

declare class Error2 extends Error {
    readonly code: ErrorCode;
    readonly details?: Readonly<Record<string, unknown>>;
    constructor(code: ErrorCode, message: string, options?: Error2Options);
}

declare interface Error2Options {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly cause?: unknown;
    readonly name?: string;
}

declare type ErrorCode = (typeof ErrorCodes_2)[keyof typeof ErrorCodes_2];

export declare const ErrorCodes: {
    readonly CONFIG_INVALID: "config.invalid";
    readonly SESSION_NOT_FOUND: "session.not_found";
    readonly SESSION_ALREADY_EXISTS: "session.already_exists";
    readonly SESSION_ID_INVALID: "session.id_invalid";
    readonly SESSION_ID_REQUIRED: "session.id_required";
    readonly SESSION_ID_EMPTY: "session.id_empty";
    readonly SESSION_TITLE_EMPTY: "session.title_empty";
    readonly SESSION_STATE_NOT_FOUND: "session.state_not_found";
    readonly SESSION_STATE_INVALID: "session.state_invalid";
    readonly SESSION_FORK_ACTIVE_TURN: "session.fork_active_turn";
    readonly SESSION_EXPORT_NOT_FOUND: "session.export_not_found";
    readonly SESSION_EXPORT_MISSING_VERSION: "session.export_missing_version";
    readonly SESSION_CLOSED: "session.closed";
    readonly SESSION_PERMISSION_MODE_INVALID: "session.permission_mode_invalid";
    readonly SESSION_THINKING_EMPTY: "session.thinking_empty";
    readonly SESSION_MODEL_EMPTY: "session.model_empty";
    readonly SESSION_PLAN_MODE_INVALID: "session.plan_mode_invalid";
    readonly SESSION_APPROVAL_HANDLER_ERROR: "session.approval_handler_error";
    readonly SESSION_QUESTION_HANDLER_ERROR: "session.question_handler_error";
    readonly SESSION_INIT_FAILED: "session.init_failed";
    readonly AGENT_NOT_FOUND: "agent.not_found";
    readonly TURN_AGENT_BUSY: "turn.agent_busy";
    readonly GOAL_ALREADY_EXISTS: "goal.already_exists";
    readonly GOAL_NOT_FOUND: "goal.not_found";
    readonly GOAL_OBJECTIVE_EMPTY: "goal.objective_empty";
    readonly GOAL_OBJECTIVE_TOO_LONG: "goal.objective_too_long";
    readonly GOAL_STATUS_INVALID: "goal.status_invalid";
    readonly GOAL_METADATA_RESERVED: "goal.metadata_reserved";
    readonly GOAL_NOT_RESUMABLE: "goal.not_resumable";
    readonly MODEL_NOT_CONFIGURED: "model.not_configured";
    readonly MODEL_CONFIG_INVALID: "model.config_invalid";
    readonly AUTH_LOGIN_REQUIRED: "auth.login_required";
    readonly CONTEXT_OVERFLOW: "context.overflow";
    readonly LOOP_MAX_STEPS_EXCEEDED: "loop.max_steps_exceeded";
    readonly PROVIDER_API_ERROR: "provider.api_error";
    readonly PROVIDER_FILTERED: "provider.filtered";
    readonly PROVIDER_RATE_LIMIT: "provider.rate_limit";
    readonly PROVIDER_AUTH_ERROR: "provider.auth_error";
    readonly PROVIDER_CONNECTION_ERROR: "provider.connection_error";
    readonly SKILL_NOT_FOUND: "skill.not_found";
    readonly SKILL_TYPE_UNSUPPORTED: "skill.type_unsupported";
    readonly SKILL_NAME_EMPTY: "skill.name_empty";
    readonly RECORDS_WRITE_FAILED: "records.write_failed";
    readonly COMPACTION_FAILED: "compaction.failed";
    readonly COMPACTION_UNABLE: "compaction.unable";
    readonly BACKGROUND_TASK_ID_EMPTY: "task.task_id_empty";
    readonly MCP_SERVER_NOT_FOUND: "mcp.server_not_found";
    readonly MCP_SERVER_DISABLED: "mcp.server_disabled";
    readonly MCP_STARTUP_FAILED: "mcp.startup_failed";
    readonly MCP_TOOL_NAME_COLLISION: "mcp.tool_name_collision";
    readonly MCP_OAUTH_FAILED: "mcp.oauth_failed";
    readonly PLUGIN_NOT_FOUND: "plugin.not_found";
    readonly PLUGIN_LOAD_FAILED: "plugin.load_failed";
    readonly REQUEST_INVALID: "request.invalid";
    readonly REQUEST_WORK_DIR_REQUIRED: "request.work_dir_required";
    readonly REQUEST_PROMPT_INPUT_EMPTY: "request.prompt_input_empty";
    readonly SHELL_GIT_BASH_NOT_FOUND: "shell.git_bash_not_found";
    readonly NOT_IMPLEMENTED: "not_implemented";
    readonly INTERNAL: "internal";
};

declare const ErrorCodes_2: {
    readonly STATE_DUPLICATE_FOLD: "state.duplicate_fold";
    readonly STATE_DURABILITY_MISMATCH: "state.durability_mismatch";
    readonly STATE_CYCLE: "state.cycle";
    readonly EVENT_DUPLICATE_EVENT: "event.duplicate_event";
    readonly EVENT_SCHEMA_MISSING: "event.schema_missing";
    readonly WORKSPACE_NOT_FOUND: "workspace.not_found";
    readonly WIRE_UNKNOWN_RECORD: "wire.unknown_record";
    readonly WIRE_MIGRATION_MISSING: "wire.migration_missing";
    readonly RECORDS_WRITE_FAILED: "records.write_failed";
    readonly WEB_INVALID_URL: "web.invalid_url";
    readonly WEB_PRIVATE_ADDRESS: "web.private_address";
    readonly WEB_FETCH_FAILED: "web.fetch_failed";
    readonly TURN_ID_CONFLICT: "usage.turn_id_conflict";
    readonly TERMINAL_NOT_FOUND: "terminal.not_found";
    readonly STORAGE_NOT_FOUND: "storage.not_found";
    readonly STORAGE_DECODE_FAILED: "storage.decode_failed";
    readonly STORAGE_CORRUPTED: "storage.corrupted";
    readonly STORAGE_IO_FAILED: "storage.io_failed";
    readonly STORAGE_LOCKED: "storage.locked";
    readonly STORAGE_PERMISSION_DENIED: "storage.permission_denied";
    readonly STORAGE_DISK_FULL: "storage.disk_full";
    readonly SKILL_NOT_FOUND: "skill.not_found";
    readonly SKILL_TYPE_UNSUPPORTED: "skill.type_unsupported";
    readonly SKILL_NAME_EMPTY: "skill.name_empty";
    readonly SKILL_PARSE_FAILED: "skill.parse_failed";
    readonly SKILL_NESTED_TOO_DEEP: "skill.nested_too_deep";
    readonly SESSION_NOT_FOUND: "session.not_found";
    readonly SESSION_ALREADY_EXISTS: "session.already_exists";
    readonly SESSION_ID_INVALID: "session.id_invalid";
    readonly SESSION_CLOSED: "session.closed";
    readonly SESSION_FORK_ACTIVE_TURN: "session.fork_active_turn";
    readonly SESSION_UNDO_UNAVAILABLE: "session.undo_unavailable";
    readonly SESSION_INIT_FAILED: "session.init_failed";
    readonly SESSION_PLAN_MODE_INVALID: "session.plan_mode_invalid";
    readonly SESSION_TOWER_MODE_INVALID: "session.tower_mode_invalid";
    readonly SESSION_EXPORT_NOT_FOUND: "session.export_not_found";
    readonly SESSION_EXPORT_MISSING_VERSION: "session.export_missing_version";
    readonly SESSION_EXPORT_OUTPUT_CONFLICT: "session.export_output_conflict";
    readonly SESSION_EXPORT_TOO_LARGE: "session.export_too_large";
    readonly CATALOG_UNAVAILABLE: "modelsDev.catalog_unavailable";
    readonly CATALOG_ENTRY_NOT_FOUND: "modelsDev.catalog_entry_not_found";
    readonly CATALOG_IMPORT_INVALID: "modelsDev.import_invalid";
    readonly REGISTRY_IMPORT_INVALID: "modelsDev.registry_import_invalid";
    readonly PROVIDER_OAUTH_MANAGED: "provider.oauth_managed";
    readonly REQUEST_INVALID: "request.invalid";
    readonly REQUEST_WORK_DIR_REQUIRED: "request.work_dir_required";
    readonly REQUEST_PROMPT_INPUT_EMPTY: "request.prompt_input_empty";
    readonly PROMPT_ID_CONFLICT: "prompt.id_conflict";
    readonly PROMPT_NOT_FOUND: "prompt.not_found";
    readonly SESSION_BUSY: "session.busy";
    readonly MODEL_NOT_CONFIGURED: "model.not_configured";
    readonly MODEL_CONFIG_INVALID: "model.config_invalid";
    readonly THINKING_ALIAS_CONFLICT: "profile.thinking_alias_conflict";
    readonly PROFILE_UNKNOWN: "profile.unknown";
    readonly PROFILE_ALREADY_BOUND: "profile.already_bound";
    readonly PROFILE_NOT_BOUND: "profile.not_bound";
    readonly PLUGIN_NOT_FOUND: "plugin.not_found";
    readonly PLUGIN_LOAD_FAILED: "plugin.load_failed";
    readonly OS_PROCESS_SPAWN_FAILED: "os.process.spawn_failed";
    readonly OS_PROCESS_KILL_FAILED: "os.process.kill_failed";
    readonly SHELL_GIT_BASH_NOT_FOUND: "shell.git_bash_not_found";
    readonly OS_FS_NOT_FOUND: "os.fs.not_found";
    readonly OS_FS_IS_DIRECTORY: "os.fs.is_directory";
    readonly OS_FS_NOT_DIRECTORY: "os.fs.not_directory";
    readonly OS_FS_ALREADY_EXISTS: "os.fs.already_exists";
    readonly OS_FS_PERMISSION_DENIED: "os.fs.permission_denied";
    readonly OS_FS_NOT_EMPTY: "os.fs.not_empty";
    readonly OS_FS_UNAVAILABLE: "os.fs.unavailable";
    readonly OS_FS_UNKNOWN: "os.fs.unknown";
    readonly PROVIDER_NOT_FOUND: "provider.not_found";
    readonly MODEL_NOT_FOUND: "model.not_found";
    readonly MCP_SERVER_NOT_FOUND: "mcp.server_not_found";
    readonly MCP_SERVER_DISABLED: "mcp.server_disabled";
    readonly MCP_STARTUP_FAILED: "mcp.startup_failed";
    readonly MCP_TOOL_NAME_COLLISION: "mcp.tool_name_collision";
    readonly MCP_OAUTH_FAILED: "mcp.oauth_failed";
    readonly LOOP_MAX_STEPS_EXCEEDED: "loop.max_steps_exceeded";
    readonly TURN_AGENT_BUSY: "turn.agent_busy";
    readonly GOAL_ALREADY_EXISTS: "goal.already_exists";
    readonly GOAL_NOT_FOUND: "goal.not_found";
    readonly GOAL_OBJECTIVE_EMPTY: "goal.objective_empty";
    readonly GOAL_OBJECTIVE_TOO_LONG: "goal.objective_too_long";
    readonly GOAL_STATUS_INVALID: "goal.status_invalid";
    readonly GOAL_METADATA_RESERVED: "goal.metadata_reserved";
    readonly GOAL_NOT_RESUMABLE: "goal.not_resumable";
    readonly GOAL_UNSUPPORTED_AGENT: "goal.unsupported_agent";
    readonly COMPACTION_FAILED: "compaction.failed";
    readonly COMPACTION_UNABLE: "compaction.unable";
    readonly FS_PATH_NOT_FOUND: "fs.path_not_found";
    readonly FS_PERMISSION_DENIED: "fs.permission_denied";
    readonly FS_PATH_ESCAPES: "fs.path_escapes";
    readonly FS_IS_DIRECTORY: "fs.is_directory";
    readonly FS_IS_BINARY: "fs.is_binary";
    readonly FS_TOO_LARGE: "fs.too_large";
    readonly FS_ALREADY_EXISTS: "fs.already_exists";
    readonly FS_TOO_MANY_RESULTS: "fs.too_many_results";
    readonly FS_GREP_TIMEOUT: "fs.grep_timeout";
    readonly FS_GIT_UNAVAILABLE: "fs.git_unavailable";
    readonly FILE_NOT_FOUND: "file.not_found";
    readonly DEBUG_SCOPE_NOT_FOUND: "debug.scope_not_found";
    readonly DEBUG_TOKEN_NOT_FOUND: "debug.token_not_found";
    readonly CRON_EXPRESSION_INVALID: "cron.expression_invalid";
    readonly CAPABILITY_NOT_FOUND: "capability.not_found";
    readonly CAPABILITY_UNSUPPORTED: "capability.unsupported";
    readonly CAPABILITY_INSTALL_IN_PROGRESS: "capability.install_in_progress";
    readonly CONFIG_INVALID: "config.invalid";
    readonly CONFIG_PERSIST_BLOCKED: "config.persist_blocked";
    readonly PROVIDER_API_ERROR: "provider.api_error";
    readonly PROVIDER_FILTERED: "provider.filtered";
    readonly PROVIDER_RATE_LIMIT: "provider.rate_limit";
    readonly PROVIDER_AUTH_ERROR: "provider.auth_error";
    readonly PROVIDER_CONNECTION_ERROR: "provider.connection_error";
    readonly PROVIDER_OVERLOADED: "provider.overloaded";
    readonly CONTEXT_OVERFLOW: "context.overflow";
    readonly TASK_ID_EMPTY: "task.task_id_empty";
    readonly TASK_LIMIT_EXCEEDED: "task.limit_exceeded";
    readonly AUTH_LOGIN_REQUIRED: "auth.login_required";
    readonly AUTH_PROVISIONING_REQUIRED: "auth.provisioning_required";
    readonly AUTH_TOKEN_MISSING: "auth.token_missing";
    readonly AUTH_TOKEN_UNAUTHORIZED: "auth.token_unauthorized";
    readonly AUTH_MODEL_NOT_RESOLVED: "auth.model_not_resolved";
    readonly AGENT_NOT_FOUND: "agent.not_found";
    readonly AGENT_ALREADY_EXISTS: "agent.already_exists";
    readonly AGENT_ALREADY_RUNNING: "agent.already_running";
    readonly AGENT_NOT_A_SUBAGENT: "agent.not_a_subagent";
    readonly AGENT_NOT_OWNED: "agent.not_owned";
    readonly AGENT_TYPE_NOT_ALLOWED: "agent.type_not_allowed";
    readonly AGENT_MAX_TOKENS_EXCEEDED: "agent.max_tokens_exceeded";
    readonly AGENT_NO_FINAL_MESSAGE: "agent.no_final_message";
    readonly INTERNAL: "internal";
    readonly NOT_IMPLEMENTED: "not_implemented";
    readonly VALIDATION_FAILED: "validation.failed";
};

export declare interface ErrorEvent {
    readonly type: 'error';
    readonly code: KimiErrorCode_2;
    readonly message: string;
    readonly name?: string;
    readonly details?: Record<string, unknown>;
    readonly retryable: boolean;
    readonly cause?: KimiErrorPayload_2;
}

/** `error` payloads carry the full `KimiErrorPayload`; kept loose. */
declare const errorEventSchema: z.ZodObject<{
    time: z.ZodOptional<z.ZodNumber>;
    message: z.ZodString;
}, z.core.$loose>;

declare interface ErrorPayload {
    readonly code: ErrorCode;
    readonly message: string;
    readonly name?: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryable: boolean;
    readonly cause?: ErrorPayload;
}

declare abstract class Event2<P = Record<string, unknown>> {
    static readonly type: string;
    static readonly durable: boolean;
    static readonly observable: boolean;
    static readonly agentDomain: boolean;
    static readonly schema: z.ZodType<any> | undefined;
    readonly type: string;
    readonly time: number;
    constructor(payload: P, time?: number);
    serialize(): SerializedEvent2;
}

declare interface Event2Class<P = any, E extends Event2<P> = Event2<P>> {
    new (payload: P, time?: number): E;
    readonly type: string;
    readonly durable: boolean;
    readonly observable: boolean;
    readonly agentDomain: boolean;
    readonly schema: z.ZodType<P> | undefined;
}

declare type Event_2 = AgentEvent & {
    agentId: string;
    sessionId: string;
};
export { Event_2 as Event }

declare interface Event_3<T> {
    (listener: (e: T) => unknown, thisArg?: unknown, disposables?: IDisposable_2[] | DisposableStore): IDisposable_2;
}

declare namespace Event_3 {
    const None: Event_3<unknown>;
    function once<T>(event: Event_3<T>): Event_3<T>;
    function map<I, O>(event: Event_3<I>, map: (i: I) => O): Event_3<O>;
    function filter<T>(event: Event_3<T>, filter: (e: T) => boolean): Event_3<T>;
    function any<T>(...events: Event_3<T>[]): Event_3<T>;
}

export declare interface ExperimentalFeatureState {
    readonly id: FlagId;
    readonly title: string;
    readonly description: string;
    readonly surface: FlagSurface;
    readonly env: string;
    readonly defaultEnabled: boolean;
    readonly enabled: boolean;
    readonly source: ExperimentalFlagSource;
    readonly configValue?: boolean;
}

declare type ExperimentalFlagConfig = Partial<Record<FlagId, boolean>>;

export declare type ExperimentalFlagMap = Record<string, boolean>;

export declare type ExperimentalFlagSource = 'master-env' | 'env' | 'config' | 'default';

export declare interface ExportSessionInput {
    readonly id: string;
    readonly outputPath?: string | undefined;
    readonly includeGlobalLog?: boolean | undefined;
    /** Host version to record in the export manifest. */
    readonly version: string;
    /** How the CLI was installed (e.g. 'npm-global', 'native'). */
    readonly installSource?: string | undefined;
    readonly shellEnv?: ShellEnvironment | undefined;
}

export declare interface ExportSessionManifest {
    readonly sessionId: string;
    readonly exportedAt: string;
    readonly kimiCodeVersion: string;
    readonly wireProtocolVersion: string;
    readonly os: string;
    readonly nodejsVersion: string;
    readonly sessionFirstActivity?: string | undefined;
    readonly sessionLastActivity?: string | undefined;
    readonly title?: string | undefined;
    readonly workspaceDir?: string | undefined;
    readonly sessionLogPath?: string | undefined;
    readonly globalLogPath?: string | undefined;
    readonly desktopLogPath?: string;
    readonly webLogPath?: string;
    readonly desktopVersion?: string;
    readonly installSource?: string | undefined;
    readonly shellEnv?: ShellEnvironment | undefined;
}

export declare interface ExportSessionResult {
    readonly zipPath: string;
    readonly entries: readonly string[];
    readonly sessionDir: string;
    readonly manifest: ExportSessionManifest;
}

declare interface ExtraBody {
    thinking?: ThinkingConfig_2;
    [key: string]: unknown;
}

/**
 * Fetches a models.dev-style catalog. Public endpoint, no credentials needed.
 * `userAgent` identifies the host product (e.g. `kimi-code-cli/1.2.3`); when
 * omitted the request falls back to the runtime default (`User-Agent: node`).
 */
export declare function fetchCatalog(url: string, options?: FetchCatalogOptions): Promise<Catalog>;

export declare interface FetchCatalogOptions {
    readonly signal?: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    readonly userAgent?: string;
}

declare interface FetchCompleteFeedbackUploadOk {
    readonly kind: 'ok';
}

declare type FetchCompleteFeedbackUploadResult = FetchCompleteFeedbackUploadOk | FetchFeedbackUploadError;

declare interface FetchFeedbackUploadError {
    readonly kind: 'error';
    readonly status?: number;
    readonly message: string;
}

declare interface FetchManagedUsageError {
    readonly kind: 'error';
    readonly status?: number;
    readonly message: string;
}

declare interface FetchSubmitFeedbackError {
    readonly kind: 'error';
    readonly status?: number;
    readonly message: string;
}

declare interface FetchSubmitFeedbackOk {
    readonly kind: 'ok';
    readonly feedbackId: number;
}

declare type FetchSubmitFeedbackResult = FetchSubmitFeedbackOk | FetchSubmitFeedbackError;

declare interface FileContent {
    type: 'file';
    file_id?: string;
    path?: string;
    name?: string;
    media_type?: string;
    size?: number;
}

/** One downloaded upload: its metadata plus the buffered bytes. */
declare interface FileDownload {
    readonly meta: FileMeta;
    readonly data: Uint8Array;
}

export declare type FileMeta = z.infer<typeof fileMetaSchema>;

declare const fileMetaSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    media_type: z.ZodString;
    size: z.ZodNumber;
    created_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    expires_at: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
}, z.core.$strip>;

export declare type FlagDefinition = FlagDefinitionInput & {
    readonly id: FlagId;
};

export declare interface FlagDefinitionInput {
    readonly id: FlagId;
    readonly title: string;
    readonly description: string;
    readonly env: string;
    readonly default: boolean;
    readonly surface: FlagSurface;
    readonly isExposed?: (flags: IFlagService) => boolean;
}

export declare type FlagId = string;

export declare type FlagSurface = 'core' | 'tui' | 'both';

export declare function flushDiagnosticLogs(): Promise<boolean>;

export declare function flushDiagnosticLogsSync(): void;

declare interface FoldContext {
    readonly silent: boolean;
    checkpoint(): void;
    clearCheckpoints(): void;
    undoToCheckpoint(count: number): void;
    emit(event: Event2): void;
}

declare type ForegroundTaskReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

export declare interface ForkSessionInput {
    readonly id: string;
    readonly forkId?: string;
    readonly title?: string;
    readonly metadata?: JsonObject;
    /**
     * Zero-based index of the user-visible turn to retain through. Omit it to
     * preserve the existing full-session fork behavior.
     */
    readonly turnIndex?: number;
}

export declare function fromKimiErrorPayload(payload: KimiErrorPayload): KimiError;

declare type FsBrowseResponse = z.infer<typeof fsBrowseResponseSchema>;

declare const fsBrowseResponseSchema: z.ZodObject<{
    path: z.ZodString;
    parent: z.ZodNullable<z.ZodString>;
    entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        path: z.ZodString;
        is_dir: z.ZodLiteral<true>;
    }, z.core.$strip>>;
}, z.core.$strip>;

declare type FsHomeResponse = z.infer<typeof fsHomeResponseSchema>;

declare const fsHomeResponseSchema: z.ZodObject<{
    home: z.ZodString;
    recent_roots: z.ZodArray<z.ZodString>;
}, z.core.$strip>;

export declare function gateImageFormatParts(parts: readonly ContentPart_2[], providerType?: string): ContentPart_2[];

declare type GenerateEvent = {
    readonly type: 'part';
    readonly part: StreamedMessagePart_2;
} | {
    readonly type: 'usage';
    readonly usage: TokenUsage_3;
    readonly model?: string;
} | {
    readonly type: 'finish';
    readonly message: Message_2;
    readonly finishReason?: string;
    readonly id?: string;
} | {
    readonly type: 'timing';
    readonly firstTokenLatencyMs: number;
    readonly streamDurationMs: number;
    readonly [key: string]: unknown;
};

declare interface GenerateInput {
    readonly systemPrompt: string;
    readonly messages: readonly Message_2[];
    readonly tools?: readonly ToolDescription_2[];
    readonly responseFormat?: ResponseFormat_2;
}

declare interface GenerateParams {
    readonly cacheKey?: string;
    readonly temperature?: number;
    readonly topP?: number;
    readonly thinkingEffort?: string;
    readonly maxCompletionTokens?: number;
}

export declare interface GenerateSessionTitleInput {
    readonly id: string;
    /** Regenerate even when the session already has a generated/custom title. */
    readonly force?: boolean;
    /** Conversation excerpt to generate from (default `user_prompts`). */
    readonly source?: 'user_prompts' | 'first_turn' | 'digest';
}

declare interface GenerationKwargs {
    /**
     * Legacy completion-budget alias. The Moonshot Kimi API still accepts
     * `max_tokens`, but for reasoning models it shares the budget with
     * `reasoning_content` and a small value can cause a 200 response with no
     * `content`. Prefer `max_completion_tokens`. When both are set
     * `max_completion_tokens` wins; this provider normalizes by sending only
     * `max_completion_tokens` on the wire.
     */
    max_tokens?: number | undefined;
    max_completion_tokens?: number | undefined;
    temperature?: number | undefined;
    top_p?: number | undefined;
    n?: number | undefined;
    presence_penalty?: number | undefined;
    frequency_penalty?: number | undefined;
    stop?: string | string[] | undefined;
    prompt_cache_key?: string | undefined;
    extra_body?: ExtraBody;
}

export declare interface GetConfigOptions {
    readonly reload?: boolean | undefined;
}

export declare interface GetCronTasksResult {
    readonly tasks: readonly CronTaskSnapshot[];
}

declare interface GlobalAuthFacade {
    status(provider?: string): Promise<AuthStatus_2>;
    summarize(): Promise<readonly AuthStatus_2[]>;
    /**
     * The engine's own auth-readiness probe for a model (the default model when
     * omitted): resolves config-file apiKey / provider env-bag credentials or an
     * OAuth token, throwing a typed auth error when nothing resolves. Actual
     * model usage does not depend on the OAuth-only {@link summarize} view.
     */
    ensureReady(modelOverride?: string): Promise<void>;
    startLogin(provider?: string, options?: OAuthLoginOptions): Promise<OAuthFlowStart_2>;
    flow(provider?: string): Promise<OAuthFlowSnapshot_2 | undefined>;
    cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse_2>;
    logout(provider?: string): Promise<OAuthLogoutResponse_2>;
    /**
     * @deprecated Use `kosong.refreshProviders({ scope: 'oauth' })` — the
     * kosong facade owns provider-model refresh; this alias remains for one
     * release cycle.
     */
    refreshProviderModels(): Promise<RefreshProviderModelsResponse_2>;
}

declare interface GlobalCapabilitiesFacade {
    list(): Promise<readonly CapabilityStatus[]>;
    get(id: string): Promise<CapabilityStatus>;
    install(id: string): Promise<CapabilityStatus>;
}

declare interface GlobalConfigFacade {
    get<T = unknown>(domain: string): Promise<T>;
    getAll(): Promise<Record<string, unknown>>;
    inspect<T = unknown>(domain: string): Promise<ConfigInspectValue<T>>;
    set(input: {
        domain: string;
        patch: unknown;
        target?: ConfigTargetLiteral;
    }): Promise<void>;
    replace(input: {
        domain: string;
        value: unknown;
        target?: ConfigTargetLiteral;
    }): Promise<void>;
    /**
     * Replace several domains in ONE atomic write (the engine's
     * `IConfigService.replaceSections`): a domain mapped to `undefined` is
     * cleared, domains absent from `sections` are left untouched.
     */
    replaceSections(input: {
        sections: Record<string, unknown>;
        target?: ConfigTargetLiteral;
    }): Promise<void>;
    reload(): Promise<void>;
    diagnostics(): Promise<readonly ConfigDiagnostic[]>;
}

declare interface GlobalFacade {
    readonly sessions: GlobalSessionsFacade;
    readonly workspaces: GlobalWorkspacesFacade;
    readonly config: GlobalConfigFacade;
    readonly kosong: GlobalKosongFacade;
    readonly auth: GlobalAuthFacade;
    readonly flags: GlobalFlagsFacade;
    readonly plugins: GlobalPluginsFacade;
    readonly capabilities: GlobalCapabilitiesFacade;
    readonly hostFs: GlobalHostFsFacade;
    readonly files: GlobalFilesFacade;
    readonly mcp: GlobalMcpFacade;
    env(): Promise<KlientEnvInfo>;
}

declare interface GlobalFilesFacade {
    /**
     * Upload buffered bytes to the daemon's file store. Bytes cross the wire
     * base64-encoded (JSON cannot carry them), so very large uploads pay one
     * encode here and one decode in the dispatcher.
     */
    save(input: {
        data: Uint8Array;
        filename: string;
        name?: string;
        mimeType?: string;
        expiresInSec?: number;
    }): Promise<FileMeta>;
    /** Download one upload back into memory. */
    get(fileId: string): Promise<FileDownload>;
    delete(fileId: string): Promise<void>;
}

declare interface GlobalFlagsFacade {
    list(): Promise<readonly ExperimentalFeatureState[]>;
    enabled(id: string): Promise<boolean>;
    enabledIds(): Promise<readonly string[]>;
    explain(id: string): Promise<ExperimentalFeatureState | undefined>;
    snapshot(): Promise<Record<string, boolean>>;
}

declare interface GlobalHostFsFacade {
    browse(absPath?: string): Promise<FsBrowseResponse>;
    home(): Promise<FsHomeResponse>;
}

declare interface GlobalKosongFacade {
    listProviders(): Promise<readonly ProviderCatalogItem_2[]>;
    getProvider(id: string): Promise<ProviderCatalogItem_2>;
    /** Add a named provider (string id + config) or an anonymous single-model provider (object). */
    addProvider(id: string, config: ProviderInput): Promise<void>;
    addProvider(config: AnonymousProviderInput): Promise<void>;
    removeProvider(id: string): Promise<void>;
    refreshProviders(opts?: RefreshProviderModelsOptions): Promise<RefreshProviderModelsResponse_2>;
    importCustomRegistry(options: ImportCustomRegistryOptions): Promise<ImportCustomRegistryResult>;
    listModels(): Promise<readonly ModelCatalogItem_2[]>;
    setDefaultModel(id: string): Promise<SetDefaultModelResponse_2>;
    generate(modelId: string, input: GenerateInput, params?: GenerateParams): AsyncIterable<GenerateEvent>;
}

/**
 * The unified MCP management plane (engine `IMcpManagementService`, App
 * scope): CRUD on the user-level `mcp.json`, a connection test probe, the
 * locator-addressed inspection catalog, the auth-status surface, and the
 * locator-addressed OAuth flow operations.
 */
declare interface GlobalMcpFacade {
    list(input?: {
        cwd?: string;
    }): Promise<readonly McpManagedServer[]>;
    get(input: {
        name: string;
        cwd?: string;
    }): Promise<McpManagedServer>;
    /** Add a user-level entry; a same-named read-only entry rejects. Returns the refreshed list. */
    add(input: {
        server: GlobalMcpServerConfig;
        cwd?: string;
    }): Promise<readonly McpManagedServer[]>;
    /** Replace a user-level entry; read-only entries reject. Returns the refreshed list. */
    update(input: {
        server: GlobalMcpServerConfig;
        cwd?: string;
    }): Promise<readonly McpManagedServer[]>;
    /** Remove a user-level entry; read-only entries reject. Returns the refreshed list. */
    remove(input: {
        name: string;
        cwd?: string;
    }): Promise<readonly McpManagedServer[]>;
    /** Probe a real connection: a registry `name`, or an inline `server` config as-is. */
    test(input: McpServerTestTarget): Promise<McpServerTestResult>;
    /** The locator-addressed catalog plus a batched real-connection probe of OAuth candidates. */
    inspect(input?: {
        targets?: readonly McpServerLocator[];
        cwd?: string;
    }): Promise<readonly McpServerInspection[]>;
    /** Per-server OAuth state; omitted `verify` detects implicit OAuth, `false` stays offline. */
    authStatuses(input?: {
        cwd?: string;
        verify?: boolean;
    }): Promise<readonly McpServerAuthStatus[]>;
    /** Resolve a legacy name-only auth target to its unambiguous locator. */
    resolveByName(input: {
        name: string;
        cwd?: string;
    }): Promise<McpServerLocator>;
    beginAuth(input: {
        locator: McpServerLocator;
        cwd?: string;
    }): Promise<McpServerAuthBeginResult>;
    completeAuth(input: {
        flowId: string;
        timeoutMs?: number;
    }): Promise<void>;
    cancelAuth(input: {
        flowId: string;
    }): Promise<void>;
    resetAuth(input: {
        locator: McpServerLocator;
        cwd?: string;
    }): Promise<void>;
}

export declare type GlobalMcpServerAuthState = Exclude<AppMcpServerAuthState, 'unavailable'>;

export declare interface GlobalMcpServerAuthStatus {
    readonly name: string;
    readonly authStatus: GlobalMcpServerAuthState;
}

declare type GlobalMcpServerConfig = McpServerConfig_2 & {
    readonly name: string;
};

declare interface GlobalPluginsFacade {
    list(): Promise<readonly PluginSummary[]>;
    info(id: string): Promise<PluginInfo>;
    install(source: string): Promise<PluginSummary>;
    setEnabled(input: {
        id: string;
        enabled: boolean;
    }): Promise<void>;
    setMcpServerEnabled(input: {
        id: string;
        server: string;
        enabled: boolean;
    }): Promise<void>;
    remove(id: string): Promise<void>;
    reload(): Promise<ReloadSummary>;
    checkUpdates(): Promise<readonly PluginUpdateStatus[]>;
    listCommands(): Promise<readonly PluginCommandDef[]>;
}

declare interface GlobalSessionsFacade {
    list(query: SessionListQuery): Promise<Page<SessionSummary_2>>;
    get(id: string): Promise<SessionSummary_2 | undefined>;
    countActive(workspaceIds: readonly string[]): Promise<number>;
    /**
     * Create a session rooted at `workDir` (the workspace is registered
     * implicitly), optionally titled. Returns the persisted metadata. No agent
     * is created — `session(id).agent('main')` materializes it on first use.
     * `mcpServers` injects ephemeral per-session MCP servers: connected only
     * for this session, never persisted.
     */
    create(input: {
        workDir: string;
        additionalDirs?: readonly string[];
        title?: string;
        mcpServers?: Readonly<Record<string, McpServerConfig_3>>;
    }): Promise<SessionMeta_2>;
}

declare interface GlobalWorkspacesFacade {
    list(): Promise<readonly Workspace_2[]>;
    get(id: string): Promise<Workspace_2 | undefined>;
    createOrTouch(input: {
        root: string;
        name?: string;
    }): Promise<Workspace_2>;
    update(input: {
        id: string;
        patch: WorkspaceUpdate;
    }): Promise<Workspace_2 | undefined>;
    delete(id: string): Promise<void>;
}

declare type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export declare interface GoalBudgetLimits {
    readonly tokenBudget?: number;
    readonly turnBudget?: number;
    readonly wallClockBudgetMs?: number;
}

export declare interface GoalBudgetReport {
    readonly tokenBudget: number | null;
    readonly turnBudget: number | null;
    readonly wallClockBudgetMs: number | null;
    readonly remainingTokens: number | null;
    readonly remainingTurns: number | null;
    readonly remainingWallClockMs: number | null;
    readonly tokenBudgetReached: boolean;
    readonly turnBudgetReached: boolean;
    readonly wallClockBudgetReached: boolean;
    readonly overBudget: boolean;
}

export declare interface GoalChange {
    readonly kind: GoalChangeKind;
    readonly status?: GoalStatus;
    readonly reason?: string;
    readonly stats?: GoalChangeStats;
    readonly actor?: GoalActor;
}

declare type GoalChangeKind = 'lifecycle' | 'completion';

export declare interface GoalChangeStats {
    readonly turnsUsed: number;
    readonly tokensUsed: number;
    readonly wallClockMs: number;
}

export declare interface GoalSnapshot {
    readonly goalId: string;
    readonly objective: string;
    readonly completionCriterion?: string;
    readonly status: GoalStatus;
    readonly turnsUsed: number;
    readonly tokensUsed: number;
    readonly wallClockMs: number;
    readonly budget: GoalBudgetReport;
    readonly terminalReason?: string;
}

export declare type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

export declare interface GoalToolResult {
    readonly goal: GoalSnapshot | null;
}

export declare interface GoalUpdatedEvent {
    readonly type: 'goal.updated';
    readonly snapshot: GoalSnapshot | null;
    readonly change?: GoalChange;
}

declare interface GoogleGenAI {}

declare interface GoogleGenAIOptions {
    apiKey?: string | undefined;
    model: string;
    /**
     * Override the endpoint the SDK talks to (forwarded as
     * `httpOptions.baseUrl`). When unset, the SDK falls back to its default
     * (`generativelanguage.googleapis.com` for Gemini, the regional
     * `*-aiplatform.googleapis.com` for Vertex). Set this to route through a
     * Gemini-compatible proxy/gateway.
     */
    baseUrl?: string | undefined;
    vertexai?: boolean | undefined;
    project?: string | undefined;
    location?: string | undefined;
    stream?: boolean | undefined;
    defaultHeaders?: Record<string, string>;
    clientFactory?: (auth: ProviderRequestAuth) => GoogleGenAI;
}

declare type HookDefConfig = z.infer<typeof HookDefSchema>;

declare const HookDefSchema: z.ZodObject<{
    event: z.ZodEnum<{
        PreToolUse: "PreToolUse";
        PostToolUse: "PostToolUse";
        PostToolUseFailure: "PostToolUseFailure";
        PermissionRequest: "PermissionRequest";
        PermissionResult: "PermissionResult";
        UserPromptSubmit: "UserPromptSubmit";
        Stop: "Stop";
        StopFailure: "StopFailure";
        Interrupt: "Interrupt";
        SessionStart: "SessionStart";
        SessionEnd: "SessionEnd";
        SubagentStart: "SubagentStart";
        SubagentStop: "SubagentStop";
        PreCompact: "PreCompact";
        PostCompact: "PostCompact";
        Notification: "Notification";
        UserPromptQueued: "UserPromptQueued";
        TurnStarted: "TurnStarted";
        SessionHeartbeat: "SessionHeartbeat";
        TaskStarted: "TaskStarted";
    }>;
    matcher: z.ZodOptional<z.ZodString>;
    command: z.ZodString;
    timeout: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;

export declare interface HookResultEvent extends Omit<HookResultPayload, 'agentId'> {
    readonly type: 'hook.result';
}

declare interface HookResultOrigin {
    readonly kind: 'hook_result';
    readonly event: string;
    readonly blocked?: boolean;
}

declare interface HookResultOrigin_2 {
    readonly kind: 'hook_result';
    readonly event: string;
    readonly blocked?: boolean;
}

declare interface HookResultPayload {
    readonly agentId: string;
    readonly turnId?: number;
    readonly hookEvent: string;
    readonly content: string;
    readonly blocked?: boolean;
}

declare interface HostDirEntry {
    readonly name: string;
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink?: boolean;
}

declare interface HostFileStat {
    readonly isFile: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink?: boolean;
    readonly size: number;
    readonly mtimeMs?: number;
    readonly ino?: number;
}

export declare class HostProcessError extends Error2 {
    constructor(code: HostProcessErrorCode, message: string, options?: Error2Options);
}

declare const HostProcessErrorCode: {
    readonly SpawnFailed: "os.process.spawn_failed";
    readonly KillFailed: "os.process.kill_failed";
    readonly ShellGitBashNotFound: "shell.git_bash_not_found";
};

declare type HostProcessErrorCode = (typeof HostProcessErrorCode)[keyof typeof HostProcessErrorCode];

export declare interface HostProcessOptions {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly shell?: boolean | string;
    readonly detached?: boolean;
    readonly windowsHide?: boolean;
    readonly mergeStderr?: boolean;
    readonly timeout?: number;
}

export declare type HostUiCapability = 'update_panel';

declare interface IAgentCommandService {
    readonly _serviceBrand: undefined;
    readonly onDidChange: Event_3<void>;
    list(): readonly AgentCommandInfo[];
    run(name: string, args?: string): Promise<void>;
}

declare const IAgentCommandService: ServiceIdentifier<IAgentCommandService>;

declare interface IAgentContextMemoryService {
    readonly _serviceBrand: undefined;
    get(): readonly ContextMessage_2[];
    append(...messages: readonly ContextMessage_2[]): void;
    appendLoopEvent(event: LoopRecordedEvent): void;
    publishTrailingRemoval(previous: readonly ContextMessage_2[]): boolean;
    clear(): void;
    applyCompaction(input: ContextCompactionInput): ContextCompactionResult;
}

declare const IAgentContextMemoryService: ServiceIdentifier<IAgentContextMemoryService>;

declare interface IAgentMcpService {
    readonly _serviceBrand: undefined;
    readonly oauthService: McpOAuthService | undefined;
    waitForInitialLoad(signal?: AbortSignal): Promise<void>;
    initialLoadDurationMs(): number;
    list(): readonly McpServerEntry_2[];
    resolved(name: string): McpResolvedServer | undefined;
    getRemoteServerUrl(name: string): string | undefined;
    reconnect(name: string, signal?: AbortSignal): Promise<void>;
    onStatusChange(listener: (entry: McpServerEntry_2) => void): IDisposable_2;
}

declare const IAgentMcpService: ServiceIdentifier<IAgentMcpService>;

declare interface IAgentPlanService {
    readonly _serviceBrand: undefined;
    enter(id?: string, createFile?: boolean): Promise<void>;
    cancel(id?: string): void;
    clear(): Promise<void>;
    exit(id?: string): void;
    recordRevision(): Promise<void>;
    status(): Promise<PlanData>;
}

declare const IAgentPlanService: ServiceIdentifier<IAgentPlanService>;

declare interface IAgentProfileService {
    readonly _serviceBrand: undefined;
    configure(options: ProfileServiceOptions): void;
    update(changed: ProfileUpdateData): void;
    applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void;
    bind(input: BindAgentInput): Promise<void>;
    setModel(model: string): Promise<ProfileSetModelResult>;
    setThinking(level: string): void;
    republishStatus(): void;
    getModel(): string;
    useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
    applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
    getAgentsMdWarning(): string | undefined;
    data(): ProfileData;
    getEffectiveThinkingLevel(): ThinkingEffort_2;
    resolveModelContext(): ProfileModelContext;
    resolveRequestParams(): ModelRequestParams;
    getModelCapabilities(): ModelCapability_2;
    getModelProviderType(alias?: string): string | undefined;
    getMaxOutputSize(): number | undefined;
    hasModel(): boolean;
    isRunnable(): boolean;
    hasProvider(): boolean;
    getSystemPrompt(): string;
    getActiveToolNames(): readonly string[] | undefined;
    addActiveTool(name: string): void;
    removeActiveTool(name: string): void;
}

declare const IAgentProfileService: ServiceIdentifier<IAgentProfileService>;

declare interface IAgentRuntimeBindingService {
    readonly _serviceBrand: undefined;
    readonly current: RuntimeBinding_2;
    readonly onDidChange: Event_3<RuntimeBinding_2>;
    get(): RuntimeBinding_2;
    set(binding: RuntimeBinding_2): RuntimeBinding_2;
    switch(runtimeId: string): RuntimeBinding_2;
}

declare const IAgentRuntimeBindingService: ServiceIdentifier<IAgentRuntimeBindingService>;

declare interface IAgentShellCommandService {
    readonly _serviceBrand: undefined;
    run(input: RunShellCommandInput): Promise<RunShellCommandResult>;
    cancel(commandId: string): void;
}

declare const IAgentShellCommandService: ServiceIdentifier<IAgentShellCommandService>;

declare interface IAgentSkillService {
    readonly _serviceBrand: undefined;
    activate(input: SkillActivationInput): Promise<PromptLaunchResult_2>;
    promptWithSkills(input: PromptWithSkillsInput_2): Promise<PromptWithSkillsResult>;
    recordModelToolActivation(origin: SkillActivationOrigin_2): void;
}

declare const IAgentSkillService: ServiceIdentifier<IAgentSkillService>;

declare interface IAgentTaskEntry {
    readonly taskId: string;
    readonly onDidDetach: Promise<ForegroundTaskReleaseReason>;
}

declare interface IAgentTaskService {
    readonly _serviceBrand: undefined;
    track(handle: ITaskHandle, options: AgentTaskTrackOptions): IAgentTaskEntry;
    registerTask(task: AgentTask, options?: RegisterAgentTaskOptions): string;
    getTask(taskId: string): AgentTaskInfo_2 | undefined;
    list(activeOnly?: boolean, limit?: number): readonly AgentTaskInfo_2[];
    persistOutput(taskId: string): void;
    getOutputSnapshot(taskId: string, maxPreviewBytes: number): Promise<AgentTaskOutputSnapshot>;
    readOutput(taskId: string, tail?: number): Promise<string>;
    suppressTerminalNotification(taskId: string): Promise<void>;
    suppressAllTerminalNotifications(): Promise<void>;
    markTasksDeliveredViaWait(tasks: readonly AgentTaskWaitDelivery[]): void;
    detach(taskId: string): AgentTaskInfo_2 | undefined;
    stop(taskId: string, reason?: string): Promise<AgentTaskInfo_2 | undefined>;
    stopByUser(taskId: string): Promise<AgentTaskInfo_2 | undefined>;
    stopAll(reason?: string): Promise<readonly AgentTaskInfo_2[]>;
    stopAllOnExit(reason: string): Promise<readonly AgentTaskInfo_2[]>;
    wait(taskId: string, timeoutMs?: number, signal?: AbortSignal): Promise<AgentTaskInfo_2 | undefined>;
    waitForForegroundRelease(taskId: string): Promise<ForegroundTaskReleaseReason | undefined>;
}

declare const IAgentTaskService: ServiceIdentifier<IAgentTaskService>;

/**
 * Transport SPI — the single abstraction every klient transport implements.
 *
 * A `KlientChannel` carries service calls and event subscriptions for one
 * scope triple. The facade above it never knows which transport is underneath
 * (http, ipc, or in-memory); transports never know which facade method
 * triggered a frame. `ScopeRef` already carries session/agent coordinates so
 * future session/agent facades plug in without changing this interface.
 */
declare interface IDisposable {
    dispose(): void;
}

declare interface IDisposable_2 {
    dispose(): void;
}

declare interface IFlagRegistry {
    readonly _serviceBrand: undefined;
    register(definition: FlagDefinitionInput): IDisposable_2;
    get(id: FlagId): FlagDefinitionInput | undefined;
    list(): readonly FlagDefinitionInput[];
}

declare const IFlagRegistry: ServiceIdentifier<IFlagRegistry>;

declare interface IFlagService {
    readonly _serviceBrand: undefined;
    readonly registry: IFlagRegistry;
    enabled(id: FlagId): boolean;
    snapshot(): ExperimentalFlagMap;
    enabledIds(): readonly FlagId[];
    exposedIds(): readonly FlagId[];
    explain(id: FlagId): ExperimentalFeatureState | undefined;
    explainAll(): readonly ExperimentalFeatureState[];
    setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void;
}

declare const IFlagService: ServiceIdentifier<IFlagService>;

declare interface IHostFileSystem {
    readonly _serviceBrand: undefined;
    readText(path: string, options?: {
        encoding?: BufferEncoding;
        errors?: TextDecodeErrors;
    }): Promise<string>;
    writeText(path: string, data: string): Promise<void>;
    appendText(path: string, data: string): Promise<void>;
    readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array>;
    writeBytes(path: string, data: Uint8Array): Promise<void>;
    readLines(path: string, options?: {
        encoding?: BufferEncoding;
        errors?: TextDecodeErrors;
    }): AsyncGenerator<string>;
    createExclusive(path: string, data: Uint8Array): Promise<boolean>;
    stat(path: string): Promise<HostFileStat>;
    lstat(path: string): Promise<HostFileStat>;
    readdir(path: string): Promise<readonly HostDirEntry[]>;
    mkdir(path: string, options?: {
        readonly recursive?: boolean;
    }): Promise<void>;
    remove(path: string): Promise<void>;
    realpath(path: string): Promise<string>;
}

declare const IHostFileSystem: ServiceIdentifier<IHostFileSystem>;
export { IHostFileSystem }
export { IHostFileSystem as IHostFileSystemShape }

export declare interface IHostProcess {
    readonly _serviceBrand: undefined;
    readonly pid: number;
    readonly exitCode: number | null;
    readonly stdin: Writable;
    readonly stdout: Readable;
    readonly stderr: Readable;
    wait(): Promise<number>;
    kill(signal?: NodeJS.Signals): Promise<void>;
    dispose(): void | Promise<void>;
}

declare interface IHostProcessService {
    readonly _serviceBrand: undefined;
    spawn(command: string, args?: readonly string[], options?: HostProcessOptions): Promise<IHostProcess>;
}

declare const IHostProcessService: ServiceIdentifier<IHostProcessService>;
export { IHostProcessService }
export { IHostProcessService as IHostProcessServiceShape }

declare interface ILogger {
    error(message: string, payload?: LogPayload_2): void;
    warn(message: string, payload?: LogPayload_2): void;
    info(message: string, payload?: LogPayload_2): void;
    debug(message: string, payload?: LogPayload_2): void;
    child(ctx: LogContext_2): ILogger;
}

export declare const IMAGE_BYTE_BUDGET: number;

export declare interface ImageCompressionCaptionInput {
    readonly original: ImageVariantDescription;
    readonly final: ImageVariantDescription;
    readonly originalPath?: string | null;
}

export declare interface ImageCompressionTelemetry {
    readonly client: TelemetryClient;
    readonly source: string;
}

declare type ImageConfig = z.infer<typeof ImageConfigSchema>;

declare const ImageConfigSchema: z.ZodObject<{
    maxEdgePx: z.ZodOptional<z.ZodNumber>;
    readByteBudget: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

declare interface ImageContent {
    type: 'image';
    source: ImageSource;
    name?: string;
}

export declare class ImageLimits {
    private readonly env;
    private config;
    constructor(env?: Readonly<Record<string, string | undefined>>, config?: ImageConfig | undefined);
    setConfig(config: ImageConfig | undefined): void;
    maxEdgePx(): number;
    readByteBudget(): number;
}

declare type ImageSource = {
    kind: 'url';
    url: string;
    id?: string;
} | {
    kind: 'base64';
    media_type: string;
    data: string;
} | {
    kind: 'file';
    file_id: string;
} | {
    kind: 'session_media';
    file_id: string;
} | {
    kind: 'path';
    path: string;
};

declare interface ImageURLPart {
    type: 'image_url';
    imageUrl: {
        url: string;
        id?: string;
        name?: string;
    };
}

declare interface ImageURLPart_3 {
    type: 'image_url';
    imageUrl: {
        url: string;
        id?: string;
        name?: string;
    };
}

declare interface ImageVariantDescription {
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly mimeType: string;
}

declare interface IModelCatalog {
    readonly _serviceBrand: undefined;
    get(id: string): Model;
    getRequester(id: string): ModelRequester;
    generate(id: string, input: ModelRequestInput, signal?: AbortSignal, params?: ModelRequestParams): AsyncIterable<ModelRequestEvent>;
    ping(id: string): Promise<ModelPingResult>;
    findByName(name: string): readonly string[];
    listModels(): Promise<readonly ModelCatalogItem[]>;
    listProviders(): Promise<readonly ProviderCatalogItem[]>;
    getProvider(providerId: string): Promise<ProviderCatalogItem>;
    setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

declare const IModelCatalog: ServiceIdentifier<IModelCatalog>;

declare interface IModelsDevImportService {
    readonly _serviceBrand: undefined;
    listModelsDevProviders(): Promise<ModelsDevProviderItem[]>;
    getModelsDevProvider(catalogId: string): Promise<ModelsDevProviderItem>;
    importModelsDevProvider(options: ImportModelsDevProviderOptions): Promise<ImportModelsDevProviderResult>;
    importCustomRegistry(options: ImportCustomRegistryOptions_2): Promise<ImportCustomRegistryResult_2>;
}

declare const IModelsDevImportService: ServiceIdentifier<IModelsDevImportService>;

declare interface ImportContextRpcInput extends SessionIdRpcInput {
    readonly content: string;
    readonly source: string;
}

export declare type ImportCustomRegistryOptions = Parameters<IModelsDevImportService['importCustomRegistry']>[0];

declare interface ImportCustomRegistryOptions_2 {
    readonly url: string;
    readonly apiKey?: string;
    readonly setDefaultWhenUnset?: boolean;
}

export declare type ImportCustomRegistryResult = Awaited<ReturnType<IModelsDevImportService['importCustomRegistry']>>;

declare interface ImportCustomRegistryResult_2 {
    readonly providers: readonly ProviderCatalogItem[];
    readonly modelsImported: number;
    readonly credentialEnv: Readonly<Record<string, string>>;
}

declare interface ImportModelsDevProviderOptions {
    readonly catalogId: string;
    readonly id?: string;
    readonly apiKey?: string;
    readonly baseUrl?: string;
}

declare interface ImportModelsDevProviderResult {
    readonly provider: ProviderCatalogItem;
    readonly modelsImported: number;
}

/**
 * @deprecated Use {@link resolveCatalogImport}. This compatibility wrapper
 * answers only the wire (`undefined` when the entry is not importable) and
 * is kept until the next major release for downstream consumers of the
 * previous public API.
 */
export declare function inferWireType(entry: CatalogProviderEntry): ProviderType_2 | undefined;

declare interface InjectionOrigin {
    readonly kind: 'injection';
    readonly variant: string;
}

declare interface InjectionOrigin_2 {
    readonly kind: 'injection';
    readonly variant: string;
    readonly ownerPromptId?: string;
    readonly disclosure?: unknown;
}

export declare function installGlobalProxyDispatcher(env?: Env, deps?: InstallProxyDeps): boolean;

declare interface InstallProxyDeps {
    readonly setGlobalDispatcher: (dispatcher: Dispatcher) => void;
    readonly createProxyDispatcher: (env: Env_2) => Dispatcher | undefined;
}

declare interface Interaction<TPayload = unknown> {
    readonly id: string;
    readonly kind: InteractionKind;
    readonly payload: TPayload;
    readonly tags: InteractionTags;
    readonly createdAt: number;
}

declare type InteractionKind = 'approval' | 'question' | 'user_tool';

declare interface InteractionResolution {
    readonly id: string;
    readonly response: unknown;
}

declare type InteractionTags = Record<string, InteractionTagValue>;

declare type InteractionTagValue = string | number;

declare interface IOAuthService {
    readonly _serviceBrand: undefined;
    startLogin(provider?: string, options?: OAuthLoginOptions): Promise<OAuthFlowStart>;
    getFlow(provider?: string): OAuthFlowSnapshot | undefined;
    cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
    logout(provider?: string): Promise<OAuthLogoutResponse>;
    status(provider?: string): Promise<AuthStatus_2>;
    refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
    getManagedUsage(provider?: string): Promise<AuthManagedUsageResult>;
    getManagedUserInfo(provider?: string): Promise<AuthManagedUserInfoResult>;
    resolveTokenProvider(provider: string, oauthRef?: OAuthRef_2): BearerTokenProvider | undefined;
    getCachedAccessToken(provider: string, oauthRef?: OAuthRef_2): Promise<string | undefined>;
    getRegion(): KimiRegion;
}

declare const IOAuthService: ServiceIdentifier<IOAuthService>;

declare interface IProviderDiscoveryService {
    readonly _serviceBrand: undefined;
    refreshProviderModels(options?: RefreshProviderModelsOptions_2): Promise<RefreshProviderModelsResponse>;
}

declare const IProviderDiscoveryService: ServiceIdentifier<IProviderDiscoveryService>;

export declare function isDaemonFileUrl(url: string): boolean;

declare interface ISessionTokenCountingService {
    readonly _serviceBrand: undefined;
    readonly strategy: TokenCountingStrategy;
    get(agent: AgentContext, start?: number, end?: number): ContextSize;
    measured(agent: AgentContext, input: readonly Message_2[], output: readonly Message_2[], usage: TokenUsage_2): void;
    latestMeasured(agent: AgentContext): number;
    statusSize(agent: AgentContext): number;
    recordTruncation(agent: AgentContext, cutIndex: number): void;
    rebase(agent: AgentContext, input: TokenCountingRebaseInput): void;
    requestSize(request: TokenCountingRequest): number;
    estimateText(text: string): number;
    estimateMessage(message: Message_2): number;
    estimateMessages(messages: readonly Message_2[]): number;
    estimateTools(tools: readonly ToolDescription[]): number;
}

declare const ISessionTokenCountingService: ServiceIdentifier<ISessionTokenCountingService>;

declare interface ISessionUsageService {
    readonly _serviceBrand: undefined;
    record(agent: AgentContext, model: string, usage: TokenUsage_2, source?: AgentLLMRequestSource): Promise<void>;
    status(agent: AgentContext): UsageStatus;
    readonly onDidRecord: Event_3<UsageRecordedContext>;
}

declare const ISessionUsageService: ServiceIdentifier<ISessionUsageService>;

export declare function isKimiError(error: unknown): error is KimiError;

export declare function isModelAcceptedImageMime(mimeType: string, providerType?: string): boolean;

declare interface ITaskHandle<T = unknown> extends IDisposable_2 {
    readonly id: string;
    readonly state: TaskState;
    readonly result: Promise<T>;
    readonly onDidChangeState: Event_3<TaskState>;
    readonly onDidOutput: Event_3<string>;
    cancel(): void;
}

export declare type JsonObject = {
    readonly [key: string]: JsonValue;
};

declare interface JsonObjectResponseFormat {
    readonly type: 'json_object';
}

export declare type JsonPrimitive = string | number | boolean | null;

declare type JsonSchemaObject = Record<string, unknown>;

declare interface JsonSchemaResponseFormat {
    readonly type: 'json_schema';
    readonly jsonSchema: {
        readonly name: string;
        readonly schema: JsonSchemaObject;
        readonly strict?: boolean;
        readonly description?: string;
    };
}

export declare type JsonValue = JsonPrimitive | JsonValue[] | {
    readonly [key: string]: JsonValue;
};

/**
 * Kimi Agent Operating System (KAOS) interface.
 *
 * This is the core abstraction that allows the agent to interact with
 * different execution environments (local, SSH, containers, etc.)
 * through a unified API.
 */
declare interface Kaos {
    /** Human-readable name for this environment (e.g. `"local"`, `"ssh:host"`). */
    readonly name: string;
    /**
     * OS / shell probe describing the target environment. Populated by the
     * concrete Kaos implementation (e.g. `detectEnvironmentFromNode()` for
     * `LocalKaos`, a remote probe for `SSHKaos`).
     */
    readonly osEnv: Environment;
    /** Return the path style used by this environment. */
    pathClass(): 'posix' | 'win32';
    /** Normalize the given path string (resolve `.` / `..` segments). */
    normpath(path: string): string;
    /** Return the home directory of the current user. */
    gethome(): string;
    /** Return the current working directory. */
    getcwd(): string;
    /** Change the working directory to `path`. */
    chdir(path: string): Promise<void>;
    /** Return a new Kaos with the given `cwd`. */
    withCwd(cwd: string): Kaos;
    /**
     * Return a new Kaos that overlays `env` onto every spawned process.
     *
     * The provided record is read when a process is spawned, so callers may
     * mutate a stable record to update future executions.
     */
    withEnv(env: Record<string, string>): Kaos;
    /** Return stat metadata for `path`. */
    stat(path: string, options?: {
        followSymlinks?: boolean;
    }): Promise<StatResult>;
    /** Yield entry names in the directory at `path`. */
    iterdir(path: string): AsyncGenerator<string>;
    /** Yield paths matching `pattern` under `path`. */
    glob(path: string, pattern: string, options?: {
        caseSensitive?: boolean;
    }): AsyncGenerator<string>;
    /** Read up to `n` bytes from `path` (all bytes if `n` is omitted). */
    readBytes(path: string, n?: number): Promise<Buffer>;
    /**
     * Read the file at `path` as a string.
     *
     * `errors` controls how decode errors are handled — mirrors Python's
     * `open(..., errors=)` parameter:
     * - `'strict'` (default): throw on any invalid byte for the encoding
     * - `'replace'`: substitute each invalid byte with U+FFFD (REPLACEMENT CHARACTER)
     * - `'ignore'`: drop invalid bytes silently
     */
    readText(path: string, options?: {
        encoding?: BufferEncoding;
        errors?: 'strict' | 'replace' | 'ignore';
    }): Promise<string>;
    /** Yield lines from the file at `path` one by one. */
    readLines(path: string, options?: {
        encoding?: BufferEncoding;
        errors?: 'strict' | 'replace' | 'ignore';
    }): AsyncGenerator<string>;
    /** Write raw bytes to `path`, returning the number of bytes written. */
    writeBytes(path: string, data: Buffer): Promise<number>;
    /** Write text to `path`, returning the number of characters written. */
    writeText(path: string, data: string, options?: {
        mode?: 'w' | 'a';
        encoding?: BufferEncoding;
    }): Promise<number>;
    /** Create a directory at `path`. */
    mkdir(path: string, options?: {
        parents?: boolean;
        existOk?: boolean;
    }): Promise<void>;
    /** Spawn a process with the given arguments. */
    exec(...args: string[]): Promise<KaosProcess>;
    /** Spawn a process with explicit environment variables. */
    execWithEnv(args: string[], env?: Record<string, string>): Promise<KaosProcess>;
}

/**
 * A running process spawned by a {@link Kaos} environment.
 *
 * Provides access to standard I/O streams, the process ID, and lifecycle
 * management (wait / kill). The interface is intentionally minimal so it
 * can be backed by local child processes, SSH sessions, or container runtimes.
 */
declare interface KaosProcess {
    /** Writable stream connected to the process's standard input. */
    readonly stdin: Writable;
    /** Readable stream for the process's standard output. */
    readonly stdout: Readable;
    /** Readable stream for the process's standard error. */
    readonly stderr: Readable;
    /** Operating-system process ID. */
    readonly pid: number;
    /** Exit code if the process has already terminated, otherwise `null`. */
    readonly exitCode: number | null;
    /** Wait for the process to exit and return its exit code. */
    wait(): Promise<number>;
    /** Send a signal to the process (defaults to `SIGTERM`). */
    kill(signal?: NodeJS.Signals): Promise<void>;
    /** Release stdin/stdout/stderr resources owned by this process wrapper. */
    dispose(): Promise<void> | void;
}

export declare const KIMI_ERROR_INFO: {
    readonly 'config.invalid': {
        readonly title: "Invalid configuration";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Check config.toml and provider/model settings.";
    };
    readonly 'session.not_found': {
        readonly title: "Session not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Check the session id or list available sessions.";
    };
    readonly 'session.already_exists': {
        readonly title: "Session already exists";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Use a different session id or remove the existing session first.";
    };
    readonly 'session.id_invalid': {
        readonly title: "Invalid session id";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Use a session id without path-traversal characters.";
    };
    readonly 'session.id_required': {
        readonly title: "Session id required";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a session id when calling this method.";
    };
    readonly 'session.id_empty': {
        readonly title: "Session id is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty session id.";
    };
    readonly 'session.title_empty': {
        readonly title: "Session title is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty session title.";
    };
    readonly 'session.state_not_found': {
        readonly title: "Session state missing";
        readonly retryable: false;
        readonly public: true;
        readonly action: "The session directory is corrupted or missing state.json.";
    };
    readonly 'session.state_invalid': {
        readonly title: "Session state invalid";
        readonly retryable: false;
        readonly public: true;
        readonly action: "The session state.json is corrupted; remove the session or repair the file.";
    };
    readonly 'session.fork_active_turn': {
        readonly title: "Cannot fork session during active turn";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Wait for the active turn to complete before forking.";
    };
    readonly 'session.export_not_found': {
        readonly title: "Session export directory missing";
        readonly retryable: false;
        readonly public: true;
        readonly action: "The session has not been persisted to disk yet.";
    };
    readonly 'session.export_missing_version': {
        readonly title: "Export version is missing";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a version when exporting the session.";
    };
    readonly 'session.closed': {
        readonly title: "Session is closed";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Create a new session.";
    };
    readonly 'session.permission_mode_invalid': {
        readonly title: "Invalid permission mode";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Use one of: yolo / manual / auto.";
    };
    readonly 'session.thinking_empty': {
        readonly title: "Thinking value is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty thinking option.";
    };
    readonly 'session.model_empty': {
        readonly title: "Model is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty model identifier.";
    };
    readonly 'session.plan_mode_invalid': {
        readonly title: "Invalid plan mode";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a boolean plan mode.";
    };
    readonly 'session.approval_handler_error': {
        readonly title: "Approval handler threw";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Inspect the SDK approval handler for an unhandled exception.";
    };
    readonly 'session.question_handler_error': {
        readonly title: "Question handler threw";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Inspect the SDK question handler for an unhandled exception.";
    };
    readonly 'session.init_failed': {
        readonly title: "Session init failed";
        readonly retryable: false;
        readonly public: false;
        readonly action: "Review the init failure details and try again.";
    };
    readonly 'agent.not_found': {
        readonly title: "Agent not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Check the agent id or list available agents.";
    };
    readonly 'turn.agent_busy': {
        readonly title: "Agent is busy";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Wait for the current turn to finish or steer it.";
    };
    readonly 'goal.already_exists': {
        readonly title: "A goal is already active";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Use `/goal replace <objective>` to replace the current goal.";
    };
    readonly 'goal.not_found': {
        readonly title: "No goal found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Start a goal with `/goal <objective>` first.";
    };
    readonly 'goal.objective_empty': {
        readonly title: "Goal objective is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty objective.";
    };
    readonly 'goal.objective_too_long': {
        readonly title: "Goal objective is too long";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Keep the objective under 4000 characters; reference long details by file path.";
    };
    readonly 'goal.status_invalid': {
        readonly title: "Invalid goal status transition";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Use a status allowed for this actor (complete, blocked, or impossible).";
    };
    readonly 'goal.metadata_reserved': {
        readonly title: "Goal metadata is reserved";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Do not write metadata.custom.goal directly; use the goal lifecycle methods.";
    };
    readonly 'goal.not_resumable': {
        readonly title: "Goal is not resumable";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Only paused goals can be resumed.";
    };
    readonly 'model.not_configured': {
        readonly title: "No model configured";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Set a default model in config.toml or via setModel.";
    };
    readonly 'model.config_invalid': {
        readonly title: "Invalid model configuration";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Check the model and provider entries in config.toml.";
    };
    readonly 'auth.login_required': {
        readonly title: "Login required";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Run the login flow for the provider before retrying.";
    };
    readonly 'context.overflow': {
        readonly title: "Context window overflow";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Compact the conversation or start a new session.";
    };
    readonly 'loop.max_steps_exceeded': {
        readonly title: "Turn exceeded max steps";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Increase loop_control.max_steps_per_turn in config.toml or split the task.";
    };
    readonly 'provider.api_error': {
        readonly title: "Provider API error";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Inspect details.statusCode / details.requestId; check provider status.";
    };
    readonly 'provider.filtered': {
        readonly title: "Provider filtered response";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Revise the prompt or model configuration to avoid provider safety filtering.";
    };
    readonly 'provider.rate_limit': {
        readonly title: "Provider rate limit";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Retry after a delay or reduce request frequency.";
    };
    readonly 'provider.auth_error': {
        readonly title: "Provider authentication error";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Re-authenticate with the provider.";
    };
    readonly 'provider.connection_error': {
        readonly title: "Provider connection error";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Check network connectivity and retry.";
    };
    readonly 'skill.not_found': {
        readonly title: "Skill not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "List available skills via the skill registry.";
    };
    readonly 'skill.type_unsupported': {
        readonly title: "Skill type not supported";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Only inline skills can be activated by the user.";
    };
    readonly 'skill.name_empty': {
        readonly title: "Skill name is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty skill name.";
    };
    readonly 'records.write_failed': {
        readonly title: "Failed to write records";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Check disk space and permissions on the session directory.";
    };
    readonly 'compaction.failed': {
        readonly title: "Compaction failed";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Inspect logs and consider increasing compaction limits.";
    };
    readonly 'compaction.unable': {
        readonly title: "Unable to compact";
        readonly retryable: false;
        readonly public: true;
        readonly action: "The current history has no prefix that can be compacted (e.g. only a pending user message). Start a new turn or session instead.";
    };
    readonly 'task.task_id_empty': {
        readonly title: "Background task id is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide a non-empty task id.";
    };
    readonly 'mcp.server_not_found': {
        readonly title: "MCP server not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "List configured MCP servers and check the requested name.";
    };
    readonly 'mcp.server_disabled': {
        readonly title: "MCP server is disabled";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Enable the MCP server entry in config before reconnecting.";
    };
    readonly 'mcp.startup_failed': {
        readonly title: "MCP server startup failed";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Inspect the MCP server log or call reconnect once the server is healthy.";
    };
    readonly 'mcp.tool_name_collision': {
        readonly title: "MCP tool name collision";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Rename one of the colliding MCP tools or servers so their qualified names are unique.";
    };
    readonly 'mcp.oauth_failed': {
        readonly title: "MCP OAuth authorization failed";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Begin the authorization flow again; inspect the error details if it keeps failing.";
    };
    readonly 'plugin.not_found': {
        readonly title: "Plugin not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "List installed plugins via /plugins and check the requested id.";
    };
    readonly 'plugin.load_failed': {
        readonly title: "Plugin state failed to load";
        readonly retryable: true;
        readonly public: true;
        readonly action: "Fix the installed.json file under $KIMI_CODE_HOME/plugins/ and run /plugins reload.";
    };
    readonly 'request.invalid': {
        readonly title: "Invalid request";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Check the input shape matches the API contract.";
    };
    readonly 'request.work_dir_required': {
        readonly title: "workDir is required";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide workDir in the request payload.";
    };
    readonly 'request.prompt_input_empty': {
        readonly title: "Prompt input is empty";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Provide non-empty prompt input.";
    };
    readonly 'shell.git_bash_not_found': {
        readonly title: "Git Bash not found";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe.";
    };
    readonly not_implemented: {
        readonly title: "Not implemented";
        readonly retryable: false;
        readonly public: true;
        readonly action: "This feature is not implemented yet.";
    };
    readonly internal: {
        readonly title: "Internal error";
        readonly retryable: false;
        readonly public: true;
        readonly action: "Inspect logs or report the issue with diagnostics.";
    };
};

export declare interface KimiAuthCompleteFeedbackUploadInput {
    readonly uploadId: number;
    readonly parts: readonly KimiAuthCompleteFeedbackUploadPart[];
}

export declare interface KimiAuthCompleteFeedbackUploadPart {
    readonly partNumber: number;
    readonly etag: string;
}

export declare interface KimiAuthCreateFeedbackUploadUrlInput {
    readonly feedbackId: number;
    readonly filename: string;
    readonly size: number;
    readonly sha256: string;
}

export declare interface KimiAuthCreateFeedbackUploadUrlOk {
    readonly kind: 'ok';
    readonly uploadId: number;
    readonly parts: readonly KimiAuthFeedbackUploadPart[];
}

export declare type KimiAuthCreateFeedbackUploadUrlResult = KimiAuthCreateFeedbackUploadUrlOk | FetchFeedbackUploadError;

export declare class KimiAuthFacade {
    private readonly options;
    private readonly toolkit;
    constructor(options: KimiAuthFacadeOptions);
    status(providerName?: string | undefined): Promise<AuthStatus>;
    login(providerName?: string | undefined, options?: KimiAuthLoginOptions): Promise<KimiAuthLoginResult>;
    logout(providerName?: string | undefined): Promise<KimiAuthLogoutResult>;
    getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult>;
    submitFeedback(input: KimiAuthSubmitFeedbackInput, providerName?: string | undefined): Promise<FetchSubmitFeedbackResult>;
    createFeedbackUploadUrl(input: KimiAuthCreateFeedbackUploadUrlInput, providerName?: string | undefined): Promise<KimiAuthCreateFeedbackUploadUrlResult>;
    completeFeedbackUpload(input: KimiAuthCompleteFeedbackUploadInput, providerName?: string | undefined): Promise<FetchCompleteFeedbackUploadResult>;
    getCachedAccessToken(providerName?: string, oauthRef?: OAuthRef | undefined): Promise<string | undefined>;
    readonly resolveOAuthTokenProvider: (providerName: string, oauthRef?: OAuthRef | undefined) => BearerTokenProvider;
    private resolveManagedAuth;
    private resolveRuntimeManagedAuth;
    private runtimeOAuthRef;
}

declare interface KimiAuthFacadeOptions {
    readonly homeDir: string;
    readonly configPath: string;
    readonly identity?: KimiHostIdentity | undefined;
    readonly onConfigUpdated?: ((config: KimiConfig) => void) | undefined;
    readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

export declare interface KimiAuthFeedbackUploadPart {
    readonly partNumber: number;
    readonly url: string;
    readonly method: string;
    readonly size: number;
}

declare type KimiAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'> & {
    /**
     * Explicit region choice from the login UI ('mainland-cn' / 'global'). Maps
     * to the region profile's OAuth/API hosts — including for 'mainland-cn', so
     * switching back overrides a persisted global login. Yields to
     * `KIMI_CODE_OAUTH_HOST` / `KIMI_CODE_BASE_URL` env overrides and to
     * explicit `oauthHost` / `baseUrl` options.
     */
    readonly region?: KimiRegion;
};

export declare interface KimiAuthLoginResult {
    readonly providerName: string;
    readonly ok: true;
    readonly defaultModel: string;
    readonly defaultThinking: boolean;
    readonly configPath?: string | undefined;
}

export declare interface KimiAuthLogoutResult {
    readonly providerName: string;
    readonly ok: true;
}

export declare interface KimiAuthSubmitFeedbackInput {
    readonly content: string;
    readonly sessionId: string;
    readonly version: string;
    readonly os: string;
    readonly model: string | null;
    readonly contact?: string;
    readonly info?: Record<string, unknown>;
}

export declare type KimiConfig = z.infer<typeof KimiConfigSchema>;

export declare type KimiConfigPatch = z.infer<typeof KimiConfigPatchSchema>;

declare const KimiConfigPatchSchema: z.ZodObject<{
    providers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<{
            anthropic: "anthropic";
            vertexai: "vertexai";
            kimi: "kimi";
            openai: "openai";
            "google-genai": "google-genai";
            openai_responses: "openai_responses";
        }>>;
        apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        apiKeyEnv: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        defaultModel: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        oauth: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            storage: z.ZodEnum<{
                file: "file";
                keyring: "keyring";
            }>;
            key: z.ZodString;
            oauthHost: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        env: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        customHeaders: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        source: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    }, z.core.$strip>>>;
    defaultProvider: z.ZodOptional<z.ZodString>;
    defaultModel: z.ZodOptional<z.ZodString>;
    models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodOptional<z.ZodString>;
        model: z.ZodOptional<z.ZodString>;
        maxContextSize: z.ZodOptional<z.ZodNumber>;
        maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        capabilities: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        protocol: z.ZodOptional<z.ZodOptional<z.ZodEnum<{
            anthropic: "anthropic";
            openai_responses: "openai_responses";
        }>>>;
        adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        offEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        betaApi: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        overrides: z.ZodOptional<z.ZodOptional<z.ZodObject<{
            reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            offEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            maxContextSize: z.ZodOptional<z.ZodNumber>;
            maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            capabilities: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
            defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>>;
    thinking: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        effort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        keep: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$strip>>;
    planMode: z.ZodOptional<z.ZodBoolean>;
    yolo: z.ZodOptional<z.ZodBoolean>;
    defaultPermissionMode: z.ZodOptional<z.ZodEnum<{
        manual: "manual";
        yolo: "yolo";
        auto: "auto";
    }>>;
    defaultPlanMode: z.ZodOptional<z.ZodBoolean>;
    autoSessionTitle: z.ZodOptional<z.ZodBoolean>;
    permission: z.ZodOptional<z.ZodObject<{
        rules: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
            decision: z.ZodEnum<{
                allow: "allow";
                deny: "deny";
                ask: "ask";
            }>;
            scope: z.ZodDefault<z.ZodEnum<{
                user: "user";
                "turn-override": "turn-override";
                "session-runtime": "session-runtime";
                project: "project";
            }>>;
            pattern: z.ZodString;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>>;
    }, z.core.$strip>>;
    hooks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        event: z.ZodEnum<{
            PreToolUse: "PreToolUse";
            PostToolUse: "PostToolUse";
            PostToolUseFailure: "PostToolUseFailure";
            PermissionRequest: "PermissionRequest";
            PermissionResult: "PermissionResult";
            UserPromptSubmit: "UserPromptSubmit";
            Stop: "Stop";
            StopFailure: "StopFailure";
            Interrupt: "Interrupt";
            SessionStart: "SessionStart";
            SessionEnd: "SessionEnd";
            SubagentStart: "SubagentStart";
            SubagentStop: "SubagentStop";
            PreCompact: "PreCompact";
            PostCompact: "PostCompact";
            Notification: "Notification";
        }>;
        matcher: z.ZodOptional<z.ZodString>;
        command: z.ZodString;
        timeout: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    services: z.ZodOptional<z.ZodObject<{
        moonshotSearch: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            oauth: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                storage: z.ZodEnum<{
                    file: "file";
                    keyring: "keyring";
                }>;
                key: z.ZodString;
                oauthHost: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            customHeaders: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        }, z.core.$strip>>;
        moonshotFetch: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            apiKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            oauth: z.ZodOptional<z.ZodOptional<z.ZodObject<{
                storage: z.ZodEnum<{
                    file: "file";
                    keyring: "keyring";
                }>;
                key: z.ZodString;
                oauthHost: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>>;
            customHeaders: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    mergeAllAvailableSkills: z.ZodOptional<z.ZodBoolean>;
    extraSkillDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    extraAgentDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    loopControl: z.ZodOptional<z.ZodObject<{
        maxStepsPerTurn: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxRetriesPerStep: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxRalphIterations: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        reservedContextSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        compactionTriggerRatio: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        compactionMaxAttempts: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    background: z.ZodOptional<z.ZodObject<{
        maxRunningTasks: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        keepAliveOnExit: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        bashAutoBackgroundOnTimeout: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        bashTaskTimeoutS: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        killGracePeriodMs: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        printWaitCeilingS: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        printBackgroundMode: z.ZodOptional<z.ZodOptional<z.ZodEnum<{
            steer: "steer";
            exit: "exit";
            drain: "drain";
        }>>>;
        printMaxTurns: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    subagent: z.ZodOptional<z.ZodObject<{
        timeoutMs: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    secondaryModel: z.ZodOptional<z.ZodObject<{
        reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodString>>>;
        supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>>;
        offEffort: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodString>>>;
        maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodNumber>>>;
        maxContextSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodNumber>>>;
        capabilities: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>>;
        displayName: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodString>>>;
        adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodBoolean>>>;
        defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodOptional<z.ZodString>>>;
        model: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        defaultModel: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        models: z.ZodOptional<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>>;
        force: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
    }, z.core.$strip>>;
    mcp: z.ZodOptional<z.ZodObject<{
        startupTimeoutMs: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        toolTimeoutMs: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    image: z.ZodOptional<z.ZodObject<{
        maxEdgePx: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        readByteBudget: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
    }, z.core.$strip>>;
    modelCatalog: z.ZodOptional<z.ZodObject<{
        refreshIntervalMs: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        refreshOnStart: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
    }, z.core.$strip>>;
    experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    telemetry: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;

export declare interface KimiConfigRpc {
    resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
    validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

export declare class KimiConfigRpcClient implements KimiConfigRpc {
    resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
    validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

declare const KimiConfigSchema: z.ZodObject<{
    providers: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        type: z.ZodEnum<{
            anthropic: "anthropic";
            vertexai: "vertexai";
            kimi: "kimi";
            openai: "openai";
            "google-genai": "google-genai";
            openai_responses: "openai_responses";
        }>;
        apiKey: z.ZodOptional<z.ZodString>;
        apiKeyEnv: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        defaultModel: z.ZodOptional<z.ZodString>;
        oauth: z.ZodOptional<z.ZodObject<{
            storage: z.ZodEnum<{
                file: "file";
                keyring: "keyring";
            }>;
            key: z.ZodString;
            oauthHost: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        source: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>>;
    defaultProvider: z.ZodOptional<z.ZodString>;
    defaultModel: z.ZodOptional<z.ZodString>;
    models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        maxContextSize: z.ZodNumber;
        maxInputSize: z.ZodOptional<z.ZodNumber>;
        maxOutputSize: z.ZodOptional<z.ZodNumber>;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        displayName: z.ZodOptional<z.ZodString>;
        reasoningKey: z.ZodOptional<z.ZodString>;
        protocol: z.ZodOptional<z.ZodEnum<{
            anthropic: "anthropic";
            openai_responses: "openai_responses";
        }>>;
        adaptiveThinking: z.ZodOptional<z.ZodBoolean>;
        supportEfforts: z.ZodOptional<z.ZodArray<z.ZodString>>;
        defaultEffort: z.ZodOptional<z.ZodString>;
        offEffort: z.ZodOptional<z.ZodString>;
        betaApi: z.ZodOptional<z.ZodBoolean>;
        baseUrl: z.ZodOptional<z.ZodString>;
        overrides: z.ZodOptional<z.ZodObject<{
            reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            offEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            maxContextSize: z.ZodOptional<z.ZodNumber>;
            maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
            capabilities: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
            adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
            defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>>;
    thinking: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        effort: z.ZodOptional<z.ZodString>;
        keep: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    planMode: z.ZodOptional<z.ZodBoolean>;
    yolo: z.ZodOptional<z.ZodBoolean>;
    defaultPermissionMode: z.ZodOptional<z.ZodEnum<{
        manual: "manual";
        yolo: "yolo";
        auto: "auto";
    }>>;
    defaultPlanMode: z.ZodOptional<z.ZodBoolean>;
    autoSessionTitle: z.ZodOptional<z.ZodBoolean>;
    permission: z.ZodOptional<z.ZodObject<{
        rules: z.ZodOptional<z.ZodArray<z.ZodObject<{
            decision: z.ZodEnum<{
                allow: "allow";
                deny: "deny";
                ask: "ask";
            }>;
            scope: z.ZodDefault<z.ZodEnum<{
                user: "user";
                "turn-override": "turn-override";
                "session-runtime": "session-runtime";
                project: "project";
            }>>;
            pattern: z.ZodString;
            reason: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    hooks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        event: z.ZodEnum<{
            PreToolUse: "PreToolUse";
            PostToolUse: "PostToolUse";
            PostToolUseFailure: "PostToolUseFailure";
            PermissionRequest: "PermissionRequest";
            PermissionResult: "PermissionResult";
            UserPromptSubmit: "UserPromptSubmit";
            Stop: "Stop";
            StopFailure: "StopFailure";
            Interrupt: "Interrupt";
            SessionStart: "SessionStart";
            SessionEnd: "SessionEnd";
            SubagentStart: "SubagentStart";
            SubagentStop: "SubagentStop";
            PreCompact: "PreCompact";
            PostCompact: "PostCompact";
            Notification: "Notification";
        }>;
        matcher: z.ZodOptional<z.ZodString>;
        command: z.ZodString;
        timeout: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    services: z.ZodOptional<z.ZodObject<{
        moonshotSearch: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodString>;
            apiKey: z.ZodOptional<z.ZodString>;
            oauth: z.ZodOptional<z.ZodObject<{
                storage: z.ZodEnum<{
                    file: "file";
                    keyring: "keyring";
                }>;
                key: z.ZodString;
                oauthHost: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strip>>;
        moonshotFetch: z.ZodOptional<z.ZodObject<{
            baseUrl: z.ZodOptional<z.ZodString>;
            apiKey: z.ZodOptional<z.ZodString>;
            oauth: z.ZodOptional<z.ZodObject<{
                storage: z.ZodEnum<{
                    file: "file";
                    keyring: "keyring";
                }>;
                key: z.ZodString;
                oauthHost: z.ZodOptional<z.ZodString>;
            }, z.core.$strip>>;
            customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    mergeAllAvailableSkills: z.ZodOptional<z.ZodBoolean>;
    extraSkillDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    extraAgentDirs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    loopControl: z.ZodOptional<z.ZodObject<{
        maxStepsPerTurn: z.ZodOptional<z.ZodNumber>;
        maxRetriesPerStep: z.ZodOptional<z.ZodNumber>;
        maxRalphIterations: z.ZodOptional<z.ZodNumber>;
        reservedContextSize: z.ZodOptional<z.ZodNumber>;
        compactionTriggerRatio: z.ZodOptional<z.ZodNumber>;
        compactionMaxAttempts: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    background: z.ZodOptional<z.ZodObject<{
        maxRunningTasks: z.ZodOptional<z.ZodNumber>;
        keepAliveOnExit: z.ZodOptional<z.ZodBoolean>;
        bashAutoBackgroundOnTimeout: z.ZodOptional<z.ZodBoolean>;
        bashTaskTimeoutS: z.ZodOptional<z.ZodNumber>;
        killGracePeriodMs: z.ZodOptional<z.ZodNumber>;
        printWaitCeilingS: z.ZodOptional<z.ZodNumber>;
        printBackgroundMode: z.ZodOptional<z.ZodEnum<{
            steer: "steer";
            exit: "exit";
            drain: "drain";
        }>>;
        printMaxTurns: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    subagent: z.ZodOptional<z.ZodObject<{
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    secondaryModel: z.ZodOptional<z.ZodObject<{
        reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        offEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxContextSize: z.ZodOptional<z.ZodNumber>;
        maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        capabilities: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        model: z.ZodOptional<z.ZodString>;
        defaultModel: z.ZodOptional<z.ZodString>;
        models: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        force: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    mcp: z.ZodOptional<z.ZodObject<{
        startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
        toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    image: z.ZodOptional<z.ZodObject<{
        maxEdgePx: z.ZodOptional<z.ZodNumber>;
        readByteBudget: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    modelCatalog: z.ZodOptional<z.ZodObject<{
        refreshIntervalMs: z.ZodOptional<z.ZodNumber>;
        refreshOnStart: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>;
    telemetry: z.ZodOptional<z.ZodBoolean>;
    raw: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;

export declare interface KimiConfigValidationIssue {
    readonly path: readonly KimiConfigValidationPathSegment[];
    readonly message: string;
}

export declare type KimiConfigValidationPathSegment = string | number;

export declare class KimiError extends Error {
    readonly code: KimiErrorCode;
    readonly details?: Record<string, unknown>;
    readonly cause?: unknown;
    constructor(code: KimiErrorCode, message: string, options?: KimiErrorOptions);
}

export declare type KimiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

declare type KimiErrorCode_2 = 'config.invalid' | 'config.persist_blocked' | 'session.not_found' | 'session.already_exists' | 'session.id_invalid' | 'session.id_required' | 'session.id_empty' | 'session.title_empty' | 'session.state_not_found' | 'session.state_invalid' | 'session.fork_active_turn' | 'session.undo_unavailable' | 'session.export_not_found' | 'session.export_missing_version' | 'session.export_output_conflict' | 'session.export_too_large' | 'session.closed' | 'session.permission_mode_invalid' | 'session.thinking_empty' | 'session.model_empty' | 'session.plan_mode_invalid' | 'session.approval_handler_error' | 'session.question_handler_error' | 'session.init_failed' | 'agent.not_found' | 'agent.already_exists' | 'agent.already_running' | 'agent.not_a_subagent' | 'agent.not_owned' | 'agent.type_not_allowed' | 'agent.max_tokens_exceeded' | 'turn.agent_busy' | 'goal.already_exists' | 'goal.not_found' | 'goal.objective_empty' | 'goal.objective_too_long' | 'goal.status_invalid' | 'goal.metadata_reserved' | 'goal.not_resumable' | 'goal.unsupported_agent' | 'model.not_configured' | 'model.config_invalid' | 'profile.thinking_alias_conflict' | 'profile.unknown' | 'profile.already_bound' | 'profile.not_bound' | 'model.not_found' | 'auth.login_required' | 'auth.provisioning_required' | 'auth.token_missing' | 'auth.token_unauthorized' | 'auth.model_not_resolved' | 'context.overflow' | 'loop.max_steps_exceeded' | 'provider.api_error' | 'provider.filtered' | 'provider.rate_limit' | 'provider.auth_error' | 'provider.connection_error' | 'provider.overloaded' | 'provider.not_found' | 'skill.not_found' | 'skill.type_unsupported' | 'skill.name_empty' | 'skill.parse_failed' | 'skill.nested_too_deep' | 'records.write_failed' | 'compaction.failed' | 'compaction.unable' | 'task.task_id_empty' | 'task.limit_exceeded' | 'usage.turn_id_conflict' | 'mcp.server_not_found' | 'mcp.server_disabled' | 'mcp.startup_failed' | 'mcp.tool_name_collision' | 'mcp.oauth_failed' | 'message.not_found' | 'plugin.not_found' | 'plugin.load_failed' | 'request.invalid' | 'request.work_dir_required' | 'request.prompt_input_empty' | 'prompt.id_conflict' | 'prompt.not_found' | 'session.busy' | 'shell.git_bash_not_found' | 'workspace.not_found' | 'terminal.not_found' | 'file.not_found' | 'file.too_large' | 'fs.path_not_found' | 'fs.permission_denied' | 'fs.path_escapes' | 'fs.is_directory' | 'fs.is_binary' | 'fs.too_large' | 'fs.already_exists' | 'fs.too_many_results' | 'fs.grep_timeout' | 'fs.git_unavailable' | 'os.fs.not_found' | 'os.fs.is_directory' | 'os.fs.not_directory' | 'os.fs.already_exists' | 'os.fs.permission_denied' | 'os.fs.not_empty' | 'os.fs.unavailable' | 'os.fs.unknown' | 'os.process.spawn_failed' | 'os.process.kill_failed' | 'storage.not_found' | 'storage.decode_failed' | 'storage.corrupted' | 'storage.io_failed' | 'storage.locked' | 'storage.permission_denied' | 'storage.disk_full' | 'wire.duplicate_op' | 'wire.cycle' | 'wire.unknown_record' | 'wire.migration_missing' | 'cron.expression_invalid' | 'web.invalid_url' | 'web.private_address' | 'web.fetch_failed' | 'validation.failed' | 'not_implemented' | 'internal';

export declare interface KimiErrorInfo {
    readonly title: string;
    readonly retryable: boolean;
    readonly public: boolean;
    readonly action?: string;
}

export declare interface KimiErrorOptions {
    readonly details?: Record<string, unknown>;
    readonly cause?: unknown;
}

export declare interface KimiErrorPayload {
    readonly code: KimiErrorCode;
    readonly message: string;
    readonly name?: string;
    readonly details?: Record<string, unknown>;
    readonly retryable: boolean;
}

declare type KimiErrorPayload_2 = ErrorPayload;

export declare class KimiForCodingProvider implements ModelProvider {
    private readonly model;
    private readonly baseUrl;
    private readonly promptCacheKey;
    private readonly defaultHeaders;
    private readonly toolkit;
    private readonly homeDir;
    private readonly identity;
    private readonly oauthRef;
    constructor(options: KimiForCodingProviderOptions);
    get defaultModel(): string;
    resolveProviderConfig(model: string): ResolvedRuntimeProvider;
    resolveAuth(_model: string, _options?: {
        readonly log?: Logger;
    }): <T>(request: (auth: ProviderRequestAuth) => Promise<T>) => Promise<T>;
    private buildAuth;
}

export declare interface KimiForCodingProviderOptions extends KimiHostIdentity {
    readonly homeDir?: string;
    readonly model?: string;
    readonly baseUrl?: string;
    readonly promptCacheKey?: string;
    readonly defaultHeaders?: Record<string, string>;
}

export declare class KimiHarness {
    private readonly rpc;
    readonly homeDir: string;
    readonly configPath: string;
    readonly auth: KimiAuthFacade;
    private readonly identity;
    private readonly uiMode;
    private readonly telemetry;
    private readonly activeSessions;
    private readonly resumeInflight;
    private readonly ensureConfigFileImpl;
    private readonly closeImpl;
    private readonly sessionStartedProperties;
    private readonly sessionStartedDynamicProperties;
    /**
     * Ingestion-side [image] limits owned by this harness's core; undefined for
     * daemon-client hosts, where the env var / built-in defaults apply.
     */
    readonly imageLimits: ImageLimits | undefined;
    constructor(rpc: SDKRpcClientBase, options: KimiHarnessRuntimeOptions);
    get sessions(): ReadonlyMap<string, Session>;
    get interactiveAgentId(): string;
    withInteractiveAgent<T>(agentId: string, fn: () => T): T;
    track(event: string, properties?: TelemetryProperties): void;
    trackWithContext(event: string, properties: TelemetryProperties | undefined, context: TelemetryContextPatch): void;
    setTelemetryContext(patch: TelemetryContextPatch): void;
    createSession(options: CreateSessionOptions): Promise<Session>;
    resumeSession(input: ResumeSessionInput): Promise<Session>;
    private doResumeSession;
    reloadSession(input: ReloadSessionInput): Promise<Session>;
    forkSession(input: ForkSessionInput): Promise<Session>;
    getSession(id: string): Session | undefined;
    closeSession(id: string): Promise<void>;
    deleteSession(id: string): Promise<void>;
    renameSession(input: RenameSessionInput): Promise<void>;
    /**
     * Generate and apply a session title from the main agent's first prompts
     * (v2 engine only). Resolves to `undefined` when generation is unavailable
     * and the current title is kept.
     */
    generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | undefined>;
    exportSession(input: ExportSessionInput): Promise<ExportSessionResult>;
    listSessions(options?: ListSessionsOptions): Promise<readonly SessionSummary[]>;
    /**
     * One keyset page of the session listing (`limit` / `before` in
     * `ListSessionsOptions`). Paged on the v2 engine; the v1 engine serves the
     * whole filtered set as a single terminal page.
     */
    listSessionsPage(options?: ListSessionsOptions): Promise<SessionSummaryPage>;
    /** Skills visible to a new session in `workDir`, without creating that session. */
    listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;
    /**
     * File suggestions for @ mention-style completion under `workDir`, no
     * session required. `undefined` on the v1 engine, which has no equivalent
     * capability; callers fall back to their own file search there.
     */
    suggestFiles(workDir: string, input: SuggestFilesInput): Promise<SuggestFilesResult | undefined>;
    /**
     * App-global plugin command list, no session required. Empty on the v1
     * engine, which only exposes plugin commands through a live session.
     */
    listPluginCommands(): Promise<readonly PluginCommandDef[]>;
    /**
     * App-global plugin management, no session required. The v2 engine keeps
     * plugin state app-global (these calls are routed through the klient
     * `global.plugins` facade), so `/plugins` works before the first session
     * exists; the v1 engine only exposes plugins through a live session.
     */
    listPlugins(): Promise<readonly PluginSummary[]>;
    /**
     * Workspace-level MCP server list, no session required. The v2 engine owns
     * one shared connection set per workspace handler, so `/mcp` is inspectable
     * before the first session exists; empty on the v1 engine.
     */
    listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]>;
    installPlugin(source: string): Promise<PluginSummary>;
    setPluginEnabled(id: string, enabled: boolean): Promise<void>;
    setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
    removePlugin(id: string): Promise<void>;
    reloadPlugins(): Promise<ReloadSummary>;
    getPluginInfo(id: string): Promise<PluginInfo>;
    /**
     * App-global capability readiness and setup (the built-in product
     * capabilities kimi-cu / kimi-webbridge), no session required. Routed
     * through the same global channel as session capability calls; requires
     * the v2 engine and throws on v1, which has no capability surface.
     */
    listCapabilities(): Promise<readonly CapabilityStatus[]>;
    getCapability(id: string): Promise<CapabilityStatus>;
    installCapability(id: string): Promise<CapabilityStatus>;
    /**
     * Trust state of `workDir` (agent-core-v2 only; the v1 engine reports an
     * always-trusted workspace). Querying may register the workDir as a
     * workspace, which session creation would do anyway.
     */
    getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo>;
    /** Mark `workDir` as trusted; project-level MCP servers connect live afterwards. */
    trustWorkspace(workDir: string): Promise<void>;
    getConfig(options?: GetConfigOptions): Promise<KimiConfig>;
    /** Warnings from the most recent config.toml load; empty when the config is fully valid. */
    getConfigDiagnostics(): Promise<ConfigDiagnostics>;
    getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]>;
    /**
     * Upload media bytes to the engine's file store; pair the returned meta
     * with `buildDaemonFileUrl` to reference the file from a prompt.
     * agent-core-v2 only — the v1 engine throws `not_implemented`.
     */
    uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta>;
    /** Delete a daemon upload owned by a client-side staging operation. */
    deleteFile(fileId: string): Promise<void>;
    ensureConfigFile(): Promise<void>;
    setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
    removeProvider(providerId: string): Promise<KimiConfig>;
    /**
     * Whether several config sections can be persisted as ONE atomic write
     * (see {@link replaceConfigSections}). False on the v1 harness.
     */
    supportsAtomicSectionReplace(): boolean;
    importCustomRegistry(options: ImportCustomRegistryOptions): Promise<ImportCustomRegistryResult>;
    /**
     * Replace several top-level config sections in ONE atomic write: a section
     * mapped to `undefined` is cleared, absent sections are left untouched.
     * Replace semantics (unlike {@link setConfig}'s deep-merge), so staged
     * removals are expressed by the written record itself.
     */
    replaceConfigSections(sections: Record<string, unknown>): Promise<void>;
    /**
     * The unified MCP management view: user-level `<KIMI_CODE_HOME>/mcp.json`
     * entries (mutable), plus read-only project-layer entries when `cwd` is
     * given and plugin-contributed entries — each tagged with its `source`,
     * `origin`, and `mutable` flag.
     */
    listMcpServers(options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    /** One entry of the unified MCP management view, resolved by name. */
    getMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<McpManagedServerInfo>;
    listMcpServerAuthStatuses(options?: {
        readonly cwd?: string;
        readonly verify?: boolean;
    }): Promise<readonly GlobalMcpServerAuthStatus[]>;
    /**
     * The app-level MCP catalog (global + plugin entries) with live
     * authorization state: OAuth candidates are probed with a real connection,
     * so a stored-but-rejected grant surfaces as `oauth-expired` and an
     * unreachable one as `unavailable`.
     */
    inspectAppMcpServers(targets?: readonly McpServerLocator[], options?: {
        readonly cwd?: string;
    }): Promise<readonly AppMcpServerInspection[]>;
    addMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    updateMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    removeMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    authenticateMcpServer(name: string, options: AuthenticateMcpServerOptions): Promise<void>;
    resetMcpServerAuth(name: string, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    /**
     * The locator-addressed variant of {@link authenticateMcpServer}: plugin
     * servers are addressed by `pluginId` + manifest-local `serverName`, so the
     * flow works even when the runtime name collides with a global entry.
     */
    authenticateAppMcpServer(locator: McpServerLocator, options: AuthenticateMcpServerOptions): Promise<void>;
    /** The locator-addressed variant of {@link resetMcpServerAuth}. */
    resetAppMcpServerAuth(locator: McpServerLocator, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    testMcpServer(name: string, options?: TestMcpServerOptions): Promise<McpTestResult>;
    /**
     * Probe a full inline MCP server config without saving it first — the
     * config counterpart of {@link testMcpServer}.
     */
    testMcpServerConfig(server: McpServerConfig, options?: TestMcpServerOptions): Promise<McpTestResult>;
    close(): Promise<void>;
    private trackSessionEvent;
    private trackSessionStarted;
}

export declare interface KimiHarnessOptions {
    readonly identity?: KimiHostIdentity | undefined;
    readonly homeDir?: string | undefined;
    readonly configPath?: string | undefined;
    readonly autoLoadConfig?: boolean | undefined;
    readonly uiMode?: string;
    readonly skillDirs?: readonly string[];
    /**
     * UI surfaces this host can render, declared once per process and passed
     * into the engine through `BootstrapInput.args.uiCapabilities`. Engine
     * features gate on them at tool-table build time; nothing is persisted, so
     * a session opened later by a host without the capability simply does not
     * offer the dependent tool.
     */
    readonly uiCapabilities?: readonly HostUiCapability[];
    /**
     * ZP-5/ZP-6（中软 fork）：追加到 bootstrap 的 DI 种子，排在内置种子之后，
     * 用于注入「拒绝式」IHostProcessService 与「受限」IHostFileSystem。
     */
    readonly extraSeeds?: ScopeSeed;
    readonly telemetry?: TelemetryClient | undefined;
    readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
    readonly sessionStartedProperties?: TelemetryProperties;
}

export declare interface KimiHarnessRuntimeOptions {
    readonly identity?: KimiHostIdentity;
    readonly uiMode?: string;
    readonly homeDir: string;
    readonly configPath: string;
    readonly auth: KimiAuthFacade;
    readonly telemetry: TelemetryClient;
    readonly ensureConfigFile: () => Promise<void>;
    readonly onClose: () => void | Promise<void>;
    readonly sessionStartedProperties?: TelemetryProperties;
    /**
     * Per-emission companion to `sessionStartedProperties`: evaluated at every
     * `session_started` call, so values that can change over the process
     * lifetime (e.g. experimental flag state) stay current. Its keys are
     * engine-owned: they win over both the static and the per-call
     * session-scoped properties, and lose only to the canonical harness fields.
     */
    readonly sessionStartedDynamicProperties?: () => TelemetryProperties;
    readonly imageLimits?: ImageLimits | undefined;
}

export declare interface KimiHostIdentity {
    readonly productName: string;
    readonly version: string;
    /**
     * `X-Msh-Platform` value reported to the OAuth host and managed endpoints
     * (e.g. `kimi_code_cli`, `kimi_code_desktop`). Every host must state its own
     * explicitly — `KIMI_CODE_PLATFORM` is the CLI's value, not a default to
     * inherit silently.
     */
    readonly platform: string;
    readonly userAgentSuffix?: string | undefined;
}

declare interface KimiOAuthLoginOptions extends LoginOptions {
    readonly provisionConfig?: boolean | undefined;
    readonly baseUrl?: string | undefined;
    readonly oauthRef?: KimiOAuthTokenRef | undefined;
    readonly oauthHost?: string | undefined;
}

declare interface KimiOAuthTokenRef {
    readonly key?: string | undefined;
    readonly oauthHost?: string | undefined;
}

declare interface KimiOptions {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    model: string;
    stream?: boolean | undefined;
    defaultHeaders?: Record<string, string> | undefined;
    generationKwargs?: GenerationKwargs | undefined;
    clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

declare type KimiRegion = 'mainland-cn' | 'global';

declare interface Klient {
    readonly global: GlobalFacade;
    readonly events: KlientEvents;
    session(sessionId: string): SessionHandle;
    close(): Promise<void>;
}

/** Aggregated host/environment snapshot (`bootstrapService` properties). */
declare interface KlientEnvInfo {
    readonly platform: string;
    readonly arch: string;
    readonly cwd: string;
    readonly osHomeDir: string;
    readonly homeDir: string;
    readonly configPath: string;
    readonly clientVersion: string;
    readonly sessionsDir: string;
    readonly blobsDir: string;
    readonly storeDir: string;
    readonly cacheDir: string;
    readonly logsDir: string;
}

/** Public event name → payload type. Keys must stay in sync with `globalEvents`. */
declare interface KlientEventPayloads {
    'config.changed': ConfigChangedEvent_2;
    'config.sectionChanged': ConfigChangedEvent_2;
    'kosong.providers.changed': ProvidersChangedEvent;
    'kosong.models.changed': ModelsChangedEvent;
    'plugins.reloaded': ReloadSummary;
    'session.archived': SessionArchivedPayload;
    'session.metaUpdated': SessionMetaUpdatedPayload;
    'kosong.changed': CatalogChangedPayload;
}

declare interface KlientEvents<TPayloadMap extends object = KlientEventPayloads> {
    on<E extends keyof TPayloadMap & string>(event: E, listener: (payload: TPayloadMap[E]) => void): IDisposable;
    /** Validation failures and listener exceptions surface here. */
    onError(listener: (error: Error) => void): IDisposable;
}

declare class Ledger {
    readonly label: string;
    static captureStacks: boolean;
    private _state;
    private readonly _records;
    private _teardownPromise;
    private _parentEntry;
    constructor(label?: string);
    get state(): LedgerState;
    get isActive(): boolean;
    get isDisposed(): boolean;
    get size(): number;
    register(disposer: Disposer, label?: string): LedgerEntry;
    registerFinalizer(disposer: Disposer, label?: string): LedgerEntry;
    effect(body: EffectBody, label?: string): LedgerEntry;
    createChild(label?: string): Ledger;
    teardown(reason?: TeardownReason): void | Promise<void>;
    clear(reason?: TeardownReason): void | Promise<void>;
    entries(): LedgerEntryInfo[];
    private _push;
    private _remove;
    private _detachFromParent;
    private _assertActive;
}

declare interface LedgerEntry {
    readonly label: string;
    readonly disposed: boolean;
    dispose(reason?: TeardownReason): void | Promise<void>;
    release(): void;
}

declare interface LedgerEntryInfo {
    readonly label: string;
    readonly kind: 'disposer' | 'effect' | 'ledger';
    readonly stack?: string;
    readonly children?: readonly LedgerEntryInfo[];
}

declare type LedgerState = 'active' | 'disposing' | 'disposed';

export declare function limitAgentReplayByTurns(records: readonly AgentReplayRecord[], maxTurns?: number): readonly AgentReplayRecord[];

export declare interface ListSessionsOptions {
    readonly workDir?: string;
    readonly sessionId?: string;
    /**
     * Include archived sessions in the listing. Defaults to non-archived only.
     */
    readonly includeArchived?: boolean;
    /**
     * Maximum number of summaries in one page. Only consulted by
     * `listSessionsPage`; plain `listSessions` always returns the whole
     * filtered set.
     */
    readonly limit?: number;
    /** Keyset cursor: return the page strictly older than this session id. */
    readonly before?: string;
}

/**
 * Parses an optional pruned models.dev catalog string — typically the
 * `__KIMI_CODE_BUILT_IN_CATALOG__` constant injected by tsdown at build
 * time. Returns `undefined` when the argument is missing or invalid.
 */
export declare function loadBuiltInCatalog(text?: string): Catalog | undefined;

export declare function loadRuntimeConfigSafe(filePath: string, env?: Readonly<Record<string, string | undefined>>): RuntimeConfigLoadResult;

export declare const log: Logger;

export declare type LogContext = Record<string, unknown>;

declare type LogContext_2 = Record<string, unknown>;

export declare interface Logger {
    error(message: string, payload?: LogPayload): void;
    warn(message: string, payload?: LogPayload): void;
    info(message: string, payload?: LogPayload): void;
    debug(message: string, payload?: LogPayload): void;
    createChild(ctx: LogContext): Logger;
}

declare interface LoginOptions {
    readonly onDeviceCode?: ((auth: DeviceAuthorization) => Promise<void> | void) | undefined;
    readonly signal?: AbortSignal | undefined;
}

export declare type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

export declare type LogPayload = unknown;

declare type LogPayload_2 = unknown;

export declare type LoopControl = z.infer<typeof LoopControlSchema>;

declare const LoopControlSchema: z.ZodObject<{
    maxStepsPerTurn: z.ZodOptional<z.ZodNumber>;
    maxRetriesPerStep: z.ZodOptional<z.ZodNumber>;
    maxRalphIterations: z.ZodOptional<z.ZodNumber>;
    reservedContextSize: z.ZodOptional<z.ZodNumber>;
    compactionTriggerRatio: z.ZodOptional<z.ZodNumber>;
    compactionMaxAttempts: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;

declare type LoopRecordedEvent = {
    readonly type: 'step.begin';
    readonly uuid: string;
    readonly turnId?: string;
    readonly step?: number;
} | {
    readonly type: 'step.end';
    readonly uuid: string;
    readonly turnId?: string;
    readonly step?: number;
    readonly finishReason?: string;
    readonly usage?: TokenUsage_2;
    readonly llmFirstTokenLatencyMs?: number;
    readonly llmStreamDurationMs?: number;
    readonly llmRequestBuildMs?: number;
    readonly llmServerFirstTokenMs?: number;
    readonly llmServerDecodeMs?: number;
    readonly llmClientConsumeMs?: number;
    readonly llmClientBlockedMs?: number;
    readonly messageId?: string;
    readonly providerFinishReason?: FinishReason;
    readonly rawFinishReason?: string;
} | {
    readonly type: 'content.part';
    readonly stepUuid: string;
    readonly part: ContentPart_2;
    readonly uuid?: string;
    readonly turnId?: string;
    readonly step?: number;
} | {
    readonly type: 'tool.call';
    readonly stepUuid: string;
    readonly toolCallId: string;
    readonly name: string;
    readonly args?: unknown;
    readonly extras?: Record<string, unknown>;
    readonly display?: ToolInputDisplay;
    readonly uuid?: string;
    readonly turnId?: string;
    readonly step?: number;
} | {
    readonly type: 'tool.result';
    readonly toolCallId: string;
    readonly result: {
        readonly output: string | readonly ContentPart_2[];
        readonly isError?: boolean;
        readonly note?: string;
        readonly durationMs?: number;
    };
    readonly parentUuid?: string;
};

declare type ManagedQuota = z.infer<typeof managedQuotaSchema>;

declare const managedQuotaSchema: z.ZodObject<{
    usages: z.ZodObject<{
        limit5h: z.ZodOptional<z.ZodObject<{
            usedRatio: z.ZodNumber;
            resetAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        limit7d: z.ZodOptional<z.ZodObject<{
            usedRatio: z.ZodNumber;
            resetAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        monthTotal: z.ZodOptional<z.ZodObject<{
            usedRatio: z.ZodNumber;
            resetAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        monthCode: z.ZodOptional<z.ZodObject<{
            usedRatio: z.ZodNumber;
            resetAt: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
    extraUsage: z.ZodNullable<z.ZodObject<{
        balanceCents: z.ZodNumber;
        totalCents: z.ZodNumber;
        monthlyChargeLimitEnabled: z.ZodBoolean;
        monthlyChargeLimitCents: z.ZodNumber;
        monthlyUsedCents: z.ZodNumber;
        currency: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;

declare type ManagedUserInfoResult = z.infer<typeof managedUserInfoResultSchema>;

declare const managedUserInfoResultSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"ok">;
    userInfo: z.ZodObject<{
        userId: z.ZodString;
        nickname: z.ZodString;
        status: z.ZodString;
        region: z.ZodString;
        userLevel: z.ZodNumber;
        userLevelName: z.ZodString;
        domain: z.ZodNumber;
        domainName: z.ZodString;
        goodsVersion: z.ZodOptional<z.ZodNumber>;
        globalId: z.ZodOptional<z.ZodString>;
        bio: z.ZodOptional<z.ZodString>;
        avatar: z.ZodOptional<z.ZodString>;
        username: z.ZodOptional<z.ZodString>;
        email: z.ZodOptional<z.ZodString>;
        phone: z.ZodOptional<z.ZodObject<{
            countryCode: z.ZodString;
            number: z.ZodString;
        }, z.core.$strip>>;
        createdTime: z.ZodOptional<z.ZodString>;
        lastLoginTime: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"error">;
    message: z.ZodString;
    status: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>], "kind">;

export declare function matchSingleMediaPathTag(text: string): MediaPathTag | undefined;

export declare const MAX_IMAGE_EDGE_PX = 2000;

export declare type MaybePromise<T> = T | Promise<T>;

export declare const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = "mcp.oauth.authorization_url";

declare interface MCPClient {
    listTools(): Promise<MCPToolDefinition[]>;
    callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPToolResult>;
    ping(signal?: AbortSignal): Promise<void>;
}

declare interface MCPContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
    resource?: MCPEmbeddedResourceContents;
    [key: string]: unknown;
}

declare interface MCPEmbeddedResourceContents {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [key: string]: unknown;
}

declare interface McpManagedServer {
    readonly name: string;
    readonly config: McpServerConfig_2 | McpServerConfigView;
    readonly source: McpServerSource;
    readonly origin: string;
    readonly mutable: boolean;
    readonly plugin?: McpRegistryPluginOrigin;
}

export declare type McpManagedServerInfo = McpServerConfig & {
    readonly source: McpServerSource;
    readonly origin: string;
    readonly mutable: boolean;
    readonly plugin?: McpRegistryPluginOrigin;
    readonly envKeys?: readonly string[];
    readonly headerKeys?: readonly string[];
};

export declare interface McpOAuthAuthorizationUrlUpdateData {
    readonly serverName: string;
    readonly authorizationUrl: string;
    readonly expiresAt?: number;
}

declare class McpOAuthClientProvider implements OAuthClientProvider {
    readonly storeKey: string;
    readonly serverUrl: string;
    readonly ready: Promise<void>;
    private readonly serverName;
    private readonly store;
    private readonly clientLabel;
    private readonly onTokensSaved;
    private readonly onCredentialsInvalidated;
    private readonly now;
    private _redirectUrl;
    private _codeVerifier;
    private _state;
    private _lastAuthorizationUrl;
    private readonly tokenTransaction;
    private clientCache;
    private discoveryCache;
    constructor(options: McpOAuthProviderOptions);
    private load;
    setRedirectUrl(url: URL): void;
    takeAuthorizationUrl(): URL | undefined;
    expectedState(): string | undefined;
    resetFlow(): void;
    get redirectUrl(): string | URL;
    get clientMetadata(): OAuthClientMetadata;
    state(): string;
    clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
    saveClientInformation(info: OAuthClientInformationMixed): Promise<void>;
    tokens(): Promise<OAuthTokens | undefined>;
    saveTokens(tokens: OAuthTokens): Promise<void>;
    createOAuthFetch(fetchFn?: typeof fetch): typeof fetch;
    redirectToAuthorization(url: URL): void;
    saveCodeVerifier(codeVerifier: string): void;
    codeVerifier(): string;
    saveDiscoveryState(state: OAuthDiscoveryState): Promise<void>;
    discoveryState(): Promise<OAuthDiscoveryState | undefined>;
    invalidateStaleRegistration(redirectUri: string): Promise<boolean>;
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>;
    clearCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>;
    clearTokensIfCurrent(expected: OAuthTokens): Promise<boolean>;
    private effectiveRedirectUri;
}

declare type McpOAuthEvent = {
    readonly type: 'tokens-saved';
    readonly serverName: string;
    readonly serverUrl: string;
} | {
    readonly type: 'tokens-invalidated';
    readonly serverName: string;
    readonly serverUrl: string;
    readonly scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery';
} | {
    readonly type: 'refresh-failed';
    readonly serverName: string;
    readonly serverUrl: string;
    readonly error: string;
};

declare type McpOAuthEventListener = (event: McpOAuthEvent) => void;

declare interface McpOAuthProviderOptions {
    readonly serverName: string;
    readonly serverUrl: string | URL;
    readonly store: McpOAuthStore;
    readonly clientLabel?: string;
    readonly clientName?: string;
    readonly now?: () => number;
    readonly onTokensSaved?: (tokens: StoredMcpOAuthTokens) => void;
    readonly onCredentialsInvalidated?: (scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') => void;
    readonly track?: (operation: Promise<unknown>) => void;
}

declare interface McpOAuthScheduledTask {
    cancel(): void;
}

declare interface McpOAuthScheduler {
    now(): number;
    schedule(delayMs: number, task: () => void | Promise<void>): McpOAuthScheduledTask;
}

declare class McpOAuthService {
    private readonly store;
    private readonly clientLabel;
    private readonly resolveClientName;
    private readonly log;
    private readonly scheduler;
    private readonly authRequestTimeoutMs;
    private readonly shutdownDrainTimeoutMs;
    private readonly providers;
    private readonly listeners;
    private readonly refreshes;
    private readonly refreshTimers;
    private readonly activeAuthorizations;
    private readonly backgroundTasks;
    private shuttingDown;
    private shutdownPromise;
    constructor(options: McpOAuthServiceOptions);
    dispose(): Promise<void>;
    getProvider(serverName: string, serverUrl: string | URL): McpOAuthClientProvider;
    hasTokens(serverName: string, serverUrl: string | URL): Promise<boolean>;
    tokenState(serverName: string, serverUrl: string | URL): Promise<McpOAuthTokenState>;
    onEvent(listener: McpOAuthEventListener): () => void;
    protected trackBackgroundTask(task: Promise<unknown>): void;
    refresh(serverName: string, serverUrl: string | URL): Promise<void>;
    sweepProactiveRefresh(): Promise<void>;
    stopProactiveRefresh(): void;
    shutdown(): Promise<void>;
    private drainBackgroundTasks;
    private drainDeadline;
    private authFetch;
    private resolveRequestScope;
    beginAuthorization(serverName: string, serverUrl: string | URL, options?: BeginAuthorizationOptions): Promise<BeginAuthorizationResult>;
    private startAuthorizationFlow;
    invalidate(serverName: string, serverUrl: string | URL, scope?: 'all' | 'client' | 'tokens' | 'discovery'): Promise<void>;
    invalidateTokensIfCurrent(serverName: string, serverUrl: string | URL, expected: OAuthTokens): Promise<boolean>;
    peekRejectedGrant(serverName: string, serverUrl: string | URL, connectedAt?: number): Promise<{
        readonly tokens: StoredMcpOAuthTokens;
        readonly concurrent: boolean;
    } | undefined>;
    now(): number;
    forgetProvider(serverName: string, serverUrl: string | URL): void;
    private createProvider;
    private refreshNow;
    private scheduleRefresh;
    private cancelScheduledRefresh;
    private emit;
}

declare interface McpOAuthServiceOptions {
    readonly store: McpOAuthStore;
    readonly clientLabel?: string;
    readonly resolveClientName?: () => string | undefined;
    readonly log?: ILogger;
    readonly scheduler?: McpOAuthScheduler;
    readonly authRequestTimeoutMs?: number;
    readonly shutdownDrainTimeoutMs?: number;
}

declare interface McpOAuthStore {
    read<T>(key: string): Promise<T | undefined>;
    write(key: string, data: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    list(prefix?: string): Promise<readonly string[]>;
}

declare interface McpOAuthTokenState {
    readonly hasTokens: boolean;
    readonly hasRefreshToken: boolean;
    readonly expiresAt?: number;
    readonly expired: boolean;
}

declare interface McpRegistryPluginOrigin {
    readonly id: string;
    readonly name: string;
}

declare interface McpResolvedServer {
    readonly client: MCPClient;
    readonly tools: readonly ToolDescription[];
    readonly rawTools: readonly MCPToolDefinition[];
    readonly enabledNames: ReadonlySet<string>;
    readonly deferred: boolean;
}

declare type McpServerAuthBeginResult = {
    readonly status: 'authorization-required';
    readonly flowId: string;
    readonly authorizationUrl: string;
} | {
    readonly status: 'already-authorized';
};

declare type McpServerAuthState = 'not-applicable' | 'bearer-token' | 'oauth-required' | 'oauth-authorized' | 'oauth-expired' | 'unavailable';

declare interface McpServerAuthStatus {
    readonly name: string;
    readonly authStatus: McpServerAuthState;
}

export declare type McpServerConfig = GlobalMcpServerConfig;

declare type McpServerConfig_2 = z.infer<typeof McpServerConfigSchema>;

declare type McpServerConfig_3 = z.infer<typeof mcpServerConfigSchema>;

declare const McpServerConfigSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodDiscriminatedUnion<[z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"stdio">;
    command: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    executor: z.ZodOptional<z.ZodEnum<{
        local: "local";
        kaos: "kaos";
    }>>;
    runtime_id: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"http">;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    auth: z.ZodOptional<z.ZodLiteral<"oauth">>;
    bearerTokenEnvVar: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"sse">;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    auth: z.ZodOptional<z.ZodLiteral<"oauth">>;
    bearerTokenEnvVar: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "transport">>;

declare const mcpServerConfigSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"stdio">;
    runtime_id: z.ZodOptional<z.ZodString>;
    command: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    cwd: z.ZodOptional<z.ZodString>;
    executor: z.ZodOptional<z.ZodEnum<{
        local: "local";
        kaos: "kaos";
    }>>;
}, z.core.$strip>, z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"http">;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    auth: z.ZodOptional<z.ZodLiteral<"oauth">>;
    bearerTokenEnvVar: z.ZodOptional<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    deferred: z.ZodOptional<z.ZodBoolean>;
    startupTimeoutMs: z.ZodOptional<z.ZodNumber>;
    toolTimeoutMs: z.ZodOptional<z.ZodNumber>;
    enabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    disabledTools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    transport: z.ZodLiteral<"sse">;
    url: z.ZodString;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    auth: z.ZodOptional<z.ZodLiteral<"oauth">>;
    bearerTokenEnvVar: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "transport">;

declare type McpServerConfigView = (Omit<Extract<McpServerConfig_2, {
    readonly transport: 'stdio';
}>, 'env'> & {
    readonly envKeys?: readonly string[];
}) | (Omit<Exclude<McpServerConfig_2, {
    readonly transport: 'stdio';
}>, 'headers'> & {
    readonly headerKeys?: readonly string[];
});

declare interface McpServerDescriptor {
    readonly serverId: string;
    readonly locator: McpServerLocator;
    readonly runtimeName: string;
    readonly canonicalUrl?: string;
    readonly origin: McpServerSource;
    readonly config: McpServerConfigView;
    readonly enabled: boolean;
    readonly editable: boolean;
}

declare type McpServerEntry = ReturnType<IAgentMcpService['list']>[number];

declare interface McpServerEntry_2 {
    readonly name: string;
    readonly transport: McpServerConfig_2['transport'];
    readonly status: McpServerStatus;
    readonly toolCount: number;
    readonly error?: string;
}

export declare interface McpServerInfo {
    readonly name: string;
    readonly transport: 'stdio' | 'http' | 'sse';
    readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
    readonly toolCount: number;
    readonly error?: string;
    readonly source?: McpServerSource;
    readonly config?: AppMcpServerConfig;
}

declare interface McpServerInspection extends McpServerDescriptor {
    readonly authStatus: McpServerAuthState;
    readonly checkedAt?: number;
    readonly error?: string;
}

export declare type McpServerLocator = {
    readonly source: 'global';
    readonly name: string;
} | {
    readonly source: 'plugin';
    readonly pluginId: string;
    readonly serverName: string;
};

export declare type McpServerSource = 'global' | 'plugin' | 'caller';

declare type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';

export declare interface McpServerStatusEvent extends Omit<McpServerStatusEventPayload, 'agentId'> {
    readonly type: 'mcp.server.status';
}

declare interface McpServerStatusEventPayload {
    readonly agentId: string;
    readonly server: McpServerStatusPayload;
}

export declare interface McpServerStatusPayload {
    readonly name: string;
    readonly transport: 'stdio' | 'http' | 'sse';
    readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
    readonly toolCount: number;
    readonly error?: string;
}

declare interface McpServerTestResult {
    readonly success: boolean;
    readonly output: string;
}

declare interface McpServerTestTarget {
    readonly name?: string;
    readonly server?: GlobalMcpServerConfig;
    readonly cwd?: string;
}

export declare interface McpStartupMetrics {
    readonly durationMs: number;
}

export declare type McpTestResult = McpServerTestResult;

declare interface MCPToolDefinition {
    name: string;
    description: string;
    inputSchema: unknown;
}

declare interface MCPToolResult {
    content: MCPContentBlock[];
    isError: boolean;
    structuredContent?: unknown;
    _meta?: Record<string, unknown>;
}

export declare type MediaKind = 'image' | 'video' | 'audio' | 'file';

declare interface MediaPathTag {
    readonly kind: MediaKind;
    readonly path: string;
    readonly index: number;
    readonly text: string;
}

/**
 * A single message in a conversation.
 *
 * Messages carry a {@link role} (system, user, assistant, or tool), an array
 * of {@link ContentPart} content blocks, and optional {@link ToolCall} entries.
 * Tool result messages set {@link toolCallId} to correlate with the originating
 * call.
 */
declare interface Message {
    /** The role of the message sender. */
    readonly role: Role;
    /** Optional display name for the sender (used by some providers). */
    readonly name?: string;
    /** Ordered content parts (text, images, thinking, etc.). */
    readonly content: ContentPart[];
    /** Tool calls requested by the assistant in this message. */
    readonly toolCalls: ToolCall[];
    /** For `tool` role messages, the ID of the tool call this result answers. */
    readonly toolCallId?: string;
    /** When `true`, indicates the message was not fully received (e.g. stream interrupted). */
    readonly partial?: boolean;
    /**
     * Full tool definitions carried by this message. Meaningful only on
     * `role: 'system'` messages: it is the append-only primitive for loading a
     * tool mid-conversation without touching the request's top-level `tools[]`
     * (which must stay byte-stable to preserve the provider's prompt cache).
     * Providers that support message-level tool declarations (Kimi
     * `messages[].tools`) serialize it; callers must not send such a message to
     * a provider without that capability.
     */
    readonly tools?: readonly Tool[] | undefined;
}

declare interface Message_2 {
    readonly role: Role_2;
    readonly name?: string;
    readonly content: ContentPart_2[];
    readonly toolCalls: ToolCall_2[];
    readonly toolCallId?: string;
    readonly partial?: boolean;
    readonly tools?: readonly Tool_2[];
}

declare type MessageContent = TextContent | ToolUseContent | ToolResultContent | ImageContent | VideoContent | FileContent | ThinkingContent;

declare interface Model {
    readonly id: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly protocol: Protocol;
    readonly baseUrl?: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly capabilities: ModelCapability_2;
    readonly maxContextSize: number;
    readonly maxInputSize?: number;
    readonly maxOutputSize?: number;
    readonly displayName?: string;
    readonly reasoningKey?: string;
    readonly supportEfforts?: readonly string[];
    readonly defaultEffort?: string;
    readonly alwaysThinking: boolean;
    readonly adaptiveThinking?: boolean;
    readonly providerType?: string;
    readonly providerName: string;
    readonly credentialProvider?: LlmCredentialProvider;
    readonly providerOptions?: ProtocolProviderOptions;
}

export declare type ModelAlias = z.infer<typeof ModelAliasSchema>;

declare const ModelAliasSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    maxContextSize: z.ZodNumber;
    maxInputSize: z.ZodOptional<z.ZodNumber>;
    maxOutputSize: z.ZodOptional<z.ZodNumber>;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    displayName: z.ZodOptional<z.ZodString>;
    reasoningKey: z.ZodOptional<z.ZodString>;
    protocol: z.ZodOptional<z.ZodEnum<{
        anthropic: "anthropic";
        openai_responses: "openai_responses";
    }>>;
    adaptiveThinking: z.ZodOptional<z.ZodBoolean>;
    supportEfforts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultEffort: z.ZodOptional<z.ZodString>;
    offEffort: z.ZodOptional<z.ZodString>;
    betaApi: z.ZodOptional<z.ZodBoolean>;
    baseUrl: z.ZodOptional<z.ZodString>;
    overrides: z.ZodOptional<z.ZodObject<{
        reasoningKey: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        supportEfforts: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        offEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        maxOutputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        maxContextSize: z.ZodOptional<z.ZodNumber>;
        maxInputSize: z.ZodOptional<z.ZodOptional<z.ZodNumber>>;
        capabilities: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
        displayName: z.ZodOptional<z.ZodOptional<z.ZodString>>;
        adaptiveThinking: z.ZodOptional<z.ZodOptional<z.ZodBoolean>>;
        defaultEffort: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;

/**
 * Declared capabilities for a specific model.
 *
 * `getModelCapability(wire, model)` returns one of these so callers can gate
 * requests against modalities the model does not accept without dispatching
 * the request and watching it fail upstream.
 *
 * `max_context_tokens: 0` means "unknown"; callers that do not gate on
 * context length can ignore the field.
 */
declare interface ModelCapability {
    readonly image_in: boolean;
    readonly video_in: boolean;
    readonly audio_in: boolean;
    readonly thinking: boolean;
    readonly tool_use: boolean;
    /** Total context window (input + output), used for completion budgeting. */
    readonly max_context_tokens: number;
    /**
     * Maximum prompt/input tokens when the model declares one below the total
     * window (e.g. gpt-5: 400k window, 272k input cap). Compaction and other
     * prompt-budget checks use this in preference to the total window; absent
     * means the total window is the only known ceiling.
     */
    readonly max_input_tokens?: number;
    /**
     * Model accepts message-level tool declarations (`messages[].tools`) — the
     * "dynamically loaded tools" wire feature that clients can drive with
     * progressive tool disclosure. Absent means unsupported: only models
     * explicitly catalogued or declared with this capability may ever receive a
     * message carrying `tools`.
     */
    readonly dynamically_loaded_tools?: boolean;
}

declare interface ModelCapability_2 {
    readonly image_in: boolean;
    readonly video_in: boolean;
    readonly audio_in: boolean;
    readonly thinking: boolean;
    readonly tool_use: boolean;
    readonly max_context_tokens: number;
    readonly max_input_tokens?: number;
    readonly dynamically_loaded_tools?: boolean;
}

declare interface ModelCatalogChangedEvent {
    readonly type: 'event.model_catalog.changed';
    readonly changed: readonly ProviderRefreshChange[];
    readonly unchanged: readonly string[];
    readonly failed: readonly ProviderRefreshFailure[];
}

declare type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

declare type ModelCatalogItem_2 = Awaited<ReturnType<IModelCatalog['listModels']>>[number];

declare const modelCatalogItemSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    display_name: z.ZodOptional<z.ZodString>;
    max_context_size: z.ZodNumber;
    capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
    support_efforts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    default_effort: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface ModelPingResult {
    readonly ok: boolean;
    readonly durationMs: number;
    readonly text?: string;
    readonly finishReason?: string;
    readonly usage?: TokenUsage_2;
    readonly error?: string;
}

declare interface ModelProvider {
    readonly defaultModel?: string;
    resolveProviderConfig(model: string): ResolvedRuntimeProvider;
    resolveAuth?(model: string, options?: {
        readonly log?: Logger;
    }): AuthorizedRequest | undefined;
}

declare interface ModelRequester {
    readonly model: Model;
    request(input: ModelRequestInput, signal?: AbortSignal, params?: ModelRequestParams): AsyncIterable<ModelRequestEvent>;
    uploadVideo?(input: string | VideoUploadInput, options?: {
        readonly signal?: AbortSignal;
    }): Promise<VideoURLPart_2>;
    uploadImage?(input: ImageUploadInput, options?: {
        readonly signal?: AbortSignal;
    }): Promise<ImageURLPart_2>;
}

declare type ModelRequestEvent = {
    readonly type: 'part';
    readonly part: StreamedMessagePart;
} | {
    readonly type: 'usage';
    readonly usage: TokenUsage_2;
    readonly model?: string;
} | {
    readonly type: 'finish';
    readonly message: Message_2;
    readonly providerFinishReason?: FinishReason;
    readonly rawFinishReason?: string;
    readonly id?: string;
    readonly traceId?: string;
} | ({
    readonly type: 'timing';
} & ModelRequestTiming);

declare interface ModelRequestInput {
    readonly systemPrompt: string;
    readonly tools: readonly Tool_2[];
    readonly messages: readonly Message_2[];
    readonly responseFormat?: ResponseFormat;
}

declare interface ModelRequestParams {
    readonly cacheKey?: string;
    readonly sampling?: SamplingOptions;
    readonly thinkingEffort?: ThinkingEffort_2;
    readonly thinkingKeep?: string;
    readonly maxCompletionTokens?: number;
    readonly usedContextTokens?: number;
    readonly maxContextTokens?: number;
    readonly onTraceId?: (traceId: string | null) => void;
}

declare interface ModelRequestTiming {
    readonly firstTokenLatencyMs: number;
    readonly streamDurationMs: number;
    readonly requestBuildMs?: number;
    readonly serverFirstTokenMs?: number;
    readonly serverDecodeMs?: number;
    readonly clientConsumeMs?: number;
    readonly clientBlockedMs?: number;
}

declare interface ModelsChangedEvent {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
}

declare interface ModelsDevModelItem {
    readonly id: string;
    readonly name?: string;
    readonly max_context_size: number;
    readonly capabilities?: readonly string[];
    readonly reasoning: boolean;
}

declare interface ModelsDevProviderItem {
    readonly id: string;
    readonly name: string;
    readonly wire_type: string | null;
    readonly base_url: string | null;
    readonly guessed: boolean;
    readonly needs_base_url: boolean;
    readonly rejected: boolean;
    readonly reject_reason: string | null;
    readonly env_key: string | null;
    readonly models: readonly ModelsDevModelItem[];
}

export declare type MoonshotServiceConfig = z.infer<typeof MoonshotServiceConfigSchema>;

declare const MoonshotServiceConfigSchema: z.ZodObject<{
    baseUrl: z.ZodOptional<z.ZodString>;
    apiKey: z.ZodOptional<z.ZodString>;
    oauth: z.ZodOptional<z.ZodObject<{
        storage: z.ZodEnum<{
            file: "file";
            keyring: "keyring";
        }>;
        key: z.ZodString;
        oauthHost: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;

export declare function normalizeImageMime(mimeType: string): string;

declare type OAuthFlowSnapshot = z.infer<typeof oauthFlowSnapshotSchema>;

declare type OAuthFlowSnapshot_2 = NonNullable<Awaited<ReturnType<IOAuthService['getFlow']>>>;

declare const oauthFlowSnapshotSchema: z.ZodObject<{
    flow_id: z.ZodString;
    provider: z.ZodString;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        expired: "expired";
        denied: "denied";
        authenticated: "authenticated";
    }>;
    verification_uri: z.ZodString;
    verification_uri_complete: z.ZodString;
    user_code: z.ZodString;
    expires_in: z.ZodNumber;
    expires_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    interval: z.ZodNumber;
    resolved_at: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    error_message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare type OAuthFlowStart = z.infer<typeof oauthFlowStartSchema>;

declare type OAuthFlowStart_2 = Awaited<ReturnType<IOAuthService['startLogin']>>;

declare const oauthFlowStartSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    flow_id: z.ZodString;
    provider: z.ZodString;
    status: z.ZodLiteral<"pending">;
    verification_uri: z.ZodString;
    verification_uri_complete: z.ZodString;
    user_code: z.ZodString;
    expires_in: z.ZodNumber;
    interval: z.ZodNumber;
    expires_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
}, z.core.$strip>, z.ZodObject<{
    flow_id: z.ZodString;
    provider: z.ZodString;
    status: z.ZodLiteral<"authenticated">;
}, z.core.$strip>], "status">;

declare type OAuthLoginCancelResponse = z.infer<typeof oauthLoginCancelResponseSchema>;

declare type OAuthLoginCancelResponse_2 = Awaited<ReturnType<IOAuthService['cancelLogin']>>;

declare const oauthLoginCancelResponseSchema: z.ZodObject<{
    cancelled: z.ZodBoolean;
    status: z.ZodEnum<{
        cancelled: "cancelled";
        pending: "pending";
        expired: "expired";
        denied: "denied";
        authenticated: "authenticated";
    }>;
}, z.core.$strip>;

declare interface OAuthLoginOptions {
    readonly region?: KimiRegion;
}

declare type OAuthLogoutResponse = z.infer<typeof oauthLogoutResponseSchema>;

declare type OAuthLogoutResponse_2 = Awaited<ReturnType<IOAuthService['logout']>>;

declare const oauthLogoutResponseSchema: z.ZodObject<{
    logged_out: z.ZodLiteral<true>;
    provider: z.ZodString;
}, z.core.$strip>;

export declare type OAuthRef = z.infer<typeof OAuthRefSchema>;

declare interface OAuthRef_2 {
    storage: 'file' | 'keyring';
    key: string;
    oauthHost?: string;
}

export declare type OAuthRefreshOutcome = {
    readonly success: true;
} | {
    readonly success: false;
    readonly reason: 'unauthorized' | 'network_or_other';
};

declare const OAuthRefSchema: z.ZodObject<{
    storage: z.ZodEnum<{
        file: "file";
        keyring: "keyring";
    }>;
    key: z.ZodString;
    oauthHost: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface OpenAI {}

declare namespace OpenAI {
    namespace Chat {
        type ChatCompletion = unknown;
        type ChatCompletionChunk = unknown;
        type ChatCompletionCreateParamsNonStreaming = unknown;
    }
}

declare interface OpenAILegacyGenerationKwargs {
    max_tokens?: number | undefined;
    max_completion_tokens?: number | undefined;
    temperature?: number | undefined;
    top_p?: number | undefined;
    n?: number | undefined;
    presence_penalty?: number | undefined;
    frequency_penalty?: number | undefined;
    stop?: string | string[] | undefined;
    [key: string]: unknown;
}

declare interface OpenAILegacyOptions {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    model: string;
    stream?: boolean | undefined;
    maxTokens?: number | undefined;
    reasoningKey?: string | undefined;
    /**
     * The effort value that encodes "thinking off" on this wire (e.g. `'none'`
     * for xai grok). When set, `withThinking('off')` sends it as
     * `reasoning_effort` instead of omitting the field — required by models
     * whose default is to reason.
     */
    offEffort?: string | undefined;
    httpClient?: unknown;
    defaultHeaders?: Record<string, string>;
    toolMessageConversion?: ToolMessageConversion | undefined;
    clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
    /**
     * Construction-time free-form request kwargs (e.g. `prompt_cache_key` for
     * session affinity), merged into every request at generate time. Explicit
     * first-class options (`maxTokens`) win on conflict; the
     * `withGenerationKwargs` morph layers on top of both.
     */
    generationKwargs?: OpenAILegacyGenerationKwargs | undefined;
}

declare interface OpenAIResponsesGenerationKwargs {
    max_output_tokens?: number | undefined;
    temperature?: number | undefined;
    top_p?: number | undefined;
    reasoning_effort?: string | undefined;
    [key: string]: unknown;
}

declare interface OpenAIResponsesOptions {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    model: string;
    maxOutputTokens?: number | undefined;
    /**
     * The effort value that encodes "thinking off" on this wire (e.g. `'none'`
     * for xai grok). When set, `withThinking('off')` sends it as
     * `reasoning_effort` instead of omitting the field — required by models
     * whose default is to reason.
     */
    offEffort?: string | undefined;
    httpClient?: unknown;
    defaultHeaders?: Record<string, string>;
    toolMessageConversion?: ToolMessageConversion | undefined;
    clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
    /**
     * Construction-time free-form request kwargs (e.g. `prompt_cache_key` for
     * session affinity), merged into every request at generate time. Explicit
     * first-class options (`maxOutputTokens`) win on conflict; the
     * `withGenerationKwargs` morph layers on top of both.
     */
    generationKwargs?: OpenAIResponsesGenerationKwargs | undefined;
}

/**
 * Environment — cross-platform probe of OS / shell.
 *
 * Detection is a pure function of injected probes (`platform` / `arch` /
 * `release` / `env` / `isFile` / `execFileText`) so the same suite runs
 * identically on any host OS. `detectEnvironmentFromNode()` bundles the Node
 * defaults for production callers.
 *
 * On Windows the probe expects bash from Git for Windows or MSYS2. If it
 * cannot be located the function throws `KaosShellNotFoundError`; the SDK
 * layer can wrap that into a user-facing install hint. Set
 * `KIMI_SHELL_PATH` to override.
 */
declare type OsKind = string;

declare interface Page<T> {
    readonly items: readonly T[];
    readonly nextCursor?: string;
}

declare interface ParseAgentFileOptions {
    readonly path: string;
    readonly source: AgentFileSource;
    readonly text: string;
}

export declare function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition;

export declare function parseDaemonFileUrl(url: string): DaemonFileRef | undefined;

export declare function parseImageDataUrl(url: string): {
    mimeType: string;
    base64: string;
} | null;

/** Engine `permission.approval.requested` — not in the protocol union; loose. */
declare const permissionApprovalRequestedEventSchema: z.ZodObject<{
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
    toolName: z.ZodString;
    action: z.ZodString;
}, z.core.$loose>;

/** Engine `permission.approval.resolved` — not in the protocol union; loose. */
declare const permissionApprovalResolvedEventSchema: z.ZodObject<{
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
}, z.core.$loose>;

declare interface PermissionApprovalResultRecord {
    readonly turnId: number;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly action: string;
    readonly sessionApprovalRule?: string;
    readonly result: ApprovalResponse;
}

declare interface PermissionData {
    mode: PermissionMode_2;
    rules: PermissionRule[];
}

export declare type PermissionMode = 'yolo' | 'manual' | 'auto';

declare type PermissionMode_2 = 'manual' | 'yolo' | 'auto';

declare interface PermissionRule {
    readonly decision: PermissionRuleDecision;
    readonly scope: PermissionRuleScope;
    readonly pattern: string;
    readonly reason?: string;
}

declare type PermissionRule_2 = z.infer<typeof permissionRuleSchema>;

declare type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

declare const permissionRuleSchema: z.ZodObject<{
    id: z.ZodString;
    tool_name: z.ZodString;
    matcher: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            always: "always";
            command_prefix: "command_prefix";
            path_glob: "path_glob";
            exact_input: "exact_input";
        }>;
        value: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    decision: z.ZodLiteral<"approved">;
    created_at: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    created_by: z.ZodEnum<{
        user: "user";
        agent: "agent";
    }>;
}, z.core.$strip>;

declare type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export declare function persistOriginalImage(bytes: Uint8Array, mimeType: string, options?: PersistOriginalImageOptions): Promise<string | null>;

declare interface PersistOriginalImageOptions {
    readonly dir?: string;
    readonly maxTotalBytes?: number;
}

declare type PlanData = null | {
    readonly id: string;
    readonly content: string;
    readonly path: string;
};

declare type PlanData_2 = Awaited<ReturnType<IAgentPlanService['status']>>;

export declare interface PlanInfo {
    readonly id: string;
    readonly content: string;
    readonly path: string;
}

declare interface PluginAuthor {
    readonly name?: string;
    readonly email?: string;
}

declare interface PluginChangedEvent {
    readonly type: 'event.plugin.changed';
}

export declare interface PluginCommandActivatedEvent extends Omit<PluginCommandActivatedPayload, 'agentId'> {
    readonly type: 'plugin_command.activated';
}

declare interface PluginCommandActivatedPayload {
    readonly agentId: string;
    readonly activationId: string;
    readonly pluginId: string;
    readonly commandName: string;
    readonly commandArgs?: string;
    readonly trigger: 'user-slash';
}

export declare interface PluginCommandDef {
    readonly pluginId: string;
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly path: string;
}

declare interface PluginCommandEntry {
    readonly path: string;
    readonly name: string;
}

declare interface PluginCommandOrigin {
    readonly kind: 'plugin_command';
    readonly activationId: string;
    readonly pluginId: string;
    readonly commandName: string;
    readonly commandArgs?: string | undefined;
    readonly trigger: 'user-slash';
}

declare interface PluginCommandOrigin_2 {
    readonly kind: 'plugin_command';
    readonly inTurn?: true;
    readonly activationId: string;
    readonly pluginId: string;
    readonly commandName: string;
    readonly commandArgs?: string | undefined;
    readonly trigger: 'user-slash';
}

declare interface PluginDiagnostic {
    readonly severity: PluginDiagnosticSeverity;
    readonly message: string;
}

declare type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export declare interface PluginGithubMetadata {
    readonly owner: string;
    readonly repo: string;
    readonly ref: PluginGithubRef;
    readonly installedSha?: string;
}

export declare interface PluginGithubRef {
    readonly kind: 'branch' | 'tag' | 'sha';
    readonly value: string;
}

export declare interface PluginInfo extends PluginSummary {
    readonly root: string;
    readonly installedAt: string;
    readonly updatedAt?: string;
    readonly manifestKind?: PluginManifestKind;
    readonly manifestPath?: string;
    readonly manifest?: PluginManifest;
    readonly mcpServers: readonly PluginMcpServerInfo[];
    readonly shadowedManifestPath?: string;
    readonly diagnostics: readonly PluginDiagnostic[];
}

declare interface PluginInterface {
    readonly displayName?: string;
    readonly shortDescription?: string;
    readonly longDescription?: string;
    readonly developerName?: string;
    readonly websiteURL?: string;
}

declare interface PluginManifest {
    readonly name: string;
    readonly version?: string;
    readonly description?: string;
    readonly keywords?: readonly string[];
    readonly author?: PluginAuthor;
    readonly homepage?: string;
    readonly license?: string;
    readonly skills?: readonly string[];
    readonly rootSkillFallback?: boolean;
    readonly agents?: readonly string[];
    readonly sessionStart?: PluginSessionStart;
    readonly mcpServers?: Readonly<Record<string, McpServerConfig_2>>;
    readonly hooks?: readonly HookDefConfig[];
    readonly commands?: readonly PluginCommandEntry[];
    readonly interface?: PluginInterface;
    readonly skillInstructions?: string;
    readonly systemPrompt?: string;
}

declare type PluginManifestKind = 'kimi-plugin-root' | 'kimi-plugin-dir';

export declare interface PluginMcpServerInfo {
    readonly name: string;
    readonly runtimeName: string;
    readonly enabled: boolean;
    readonly transport: 'stdio' | 'http' | 'sse';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly url?: string;
    readonly envKeys?: readonly string[];
    readonly headerKeys?: readonly string[];
}

declare interface PluginSessionStart {
    readonly skill: string;
}

export declare type PluginSource = 'local-path' | 'zip-url' | 'github';

declare type PluginState = 'ok' | 'error';

export declare interface PluginSummary {
    readonly id: string;
    readonly displayName: string;
    readonly version?: string;
    readonly enabled: boolean;
    readonly state: PluginState;
    readonly skillCount: number;
    readonly mcpServerCount: number;
    readonly enabledMcpServerCount: number;
    readonly hookCount: number;
    readonly commandCount: number;
    readonly hasErrors: boolean;
    readonly source: PluginSource;
    readonly originalSource?: string;
    readonly github?: PluginGithubMetadata;
}

declare interface PluginUpdateStatus {
    readonly id: string;
    readonly source: PluginSource;
    readonly current?: PluginGithubRef;
    readonly latest: PluginGithubRef;
    readonly displayVersion: string;
    readonly updateAvailable: boolean;
}

export declare const PRIMARY_SUBAGENT_MODEL_CHOICE = "primary";

export declare type ProcessBackgroundTaskInfo = ProcessTaskInfo;

declare interface ProcessTaskInfo extends AgentTaskInfoBase {
    readonly kind: 'process';
    readonly command: string;
    readonly pid: number;
    readonly exitCode: number | null;
    readonly parentToolCallId?: string;
}

declare interface ProfileBindingSnapshot {
    readonly modelAlias?: string;
    readonly profileName?: string;
    readonly thinkingLevel: string;
    readonly systemPrompt: string;
    readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
    readonly renderGeneration?: number;
    readonly agentsMdPaths?: readonly string[];
    readonly activeToolNames?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly subagents?: readonly string[];
}

declare interface ProfileData extends AgentConfigData_2 {
    readonly agentsMdPaths?: readonly string[];
    readonly activeToolNames?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly subagents?: readonly string[];
    readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
    readonly renderGeneration?: number;
}

declare interface ProfileModelContext {
    readonly modelAlias: string;
    readonly modelCapabilities: ModelCapability_2;
    readonly maxOutputSize: number | undefined;
    readonly alwaysThinking: boolean | undefined;
    readonly thinkingLevel: ThinkingEffort_2;
    readonly reservedContextSize: number | undefined;
    readonly compactionTriggerRatio: number | undefined;
    readonly compactionMaxAttempts: number | undefined;
}

declare interface ProfileServiceOptions {
    readonly emitStatusUpdated?: () => void;
}

declare interface ProfileSetModelResult {
    readonly model: string;
    readonly providerName?: string | undefined;
}

declare type ProfileUpdateData = Partial<{
    modelAlias: string;
    profileName: string;
    thinkingLevel: string;
    systemPrompt: string;
    environmentDisclosure: EnvironmentDisclosureSnapshot;
    agentsMdPaths: readonly string[];
    disallowedTools: readonly string[];
    activeToolNames: readonly string[];
}>;

declare interface PromptAbortedEvent extends Omit<PromptAbortedPayload, 'agentId'> {
    readonly type: 'prompt.aborted';
}

declare const promptAbortedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"prompt.aborted">;
    time: z.ZodOptional<z.ZodNumber>;
    promptId: z.ZodString;
    abortedAt: z.ZodString;
}, z.core.$strip>;

declare interface PromptAbortedPayload {
    readonly agentId: string;
    readonly promptId: string;
    readonly abortedAt: string;
}

declare interface PromptCompletedEvent {
    readonly type: 'prompt.completed';
    readonly promptId: string;
    readonly finishedAt: string;
    readonly reason?: 'completed' | 'failed' | 'blocked';
}

declare const promptCompletedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"prompt.completed">;
    time: z.ZodOptional<z.ZodNumber>;
    promptId: z.ZodString;
    finishedAt: z.ZodString;
    reason: z.ZodOptional<z.ZodEnum<{
        completed: "completed";
        failed: "failed";
        blocked: "blocked";
    }>>;
}, z.core.$strip>;

declare interface PromptFileAttachment {
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly path: string;
}

export declare type PromptInput = readonly PromptPart[];

declare type PromptLaunchResult = PromptLaunchResult_2 | undefined;

declare interface PromptLaunchResult_2 {
    readonly turn_id: number;
}

export declare type PromptOrigin = UserPromptOrigin | SkillActivationOrigin | PluginCommandOrigin | InjectionOrigin | ShellCommandOrigin | CompactionSummaryOrigin | SystemTriggerOrigin | BackgroundTaskOrigin | CronJobOrigin | CronMissedOrigin | HookResultOrigin | RetryOrigin;

declare type PromptOrigin_2 = UserPromptOrigin_2 | SkillActivationOrigin_2 | PluginCommandOrigin_2 | InjectionOrigin_2 | ShellCommandOrigin_2 | CompactionSummaryOrigin_2 | SystemTriggerOrigin_2 | TaskOrigin | CronJobOrigin_2 | CronMissedOrigin_2 | HookResultOrigin_2 | RetryOrigin_2;

export declare type PromptPart = Extract<ContentPart, {
    type: 'text' | 'image_url' | 'video_url';
}>;

export declare interface PromptSkillActivation {
    readonly name: string;
    readonly args?: string;
}

declare interface PromptSkillActivation_2 {
    readonly name: string;
    readonly args?: string;
}

declare interface PromptSteeredEvent {
    readonly type: 'prompt.steered';
    readonly activePromptId: string;
    readonly promptIds: readonly string[];
    readonly content: readonly MessageContent[];
    readonly steeredAt: string;
    readonly messageId?: string;
}

declare interface PromptSubmittedEvent {
    readonly type: 'prompt.submitted';
    readonly promptId: string;
    readonly userMessageId: string;
    readonly status: 'running' | 'queued' | 'blocked';
    readonly content: readonly MessageContent[];
    readonly createdAt: string;
}

declare type PromptWithSkillsInput = Parameters<IAgentSkillService['promptWithSkills']>[0];

declare interface PromptWithSkillsInput_2 {
    readonly input: readonly ContentPart_2[];
    readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
    readonly skills: readonly PromptSkillActivation_2[];
    readonly attachments?: readonly PromptFileAttachment[];
}

declare interface PromptWithSkillsResult {
    readonly turn_id?: number;
    readonly prompt_id: string;
    readonly created_at: string;
    readonly state: 'running' | 'queued' | 'blocked';
}

declare type PromptWithSkillsResult_2 = Awaited<ReturnType<IAgentSkillService['promptWithSkills']>>;

declare type Protocol = z.infer<typeof ProtocolSchema>;

declare interface ProtocolProviderOptions {
    readonly reasoningKey?: string;
    readonly defaultMaxTokens?: number;
    readonly supportEfforts?: readonly string[];
    readonly offEffort?: string;
    readonly adaptiveThinking?: boolean;
    readonly betaApi?: boolean;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly vertexai?: boolean;
    readonly project?: string;
    readonly location?: string;
}

declare const ProtocolSchema: z.ZodEnum<{
    anthropic: "anthropic";
    openai: "openai";
    "google-genai": "google-genai";
    openai_responses: "openai_responses";
}>;

/** How the provider authenticates — API key or managed OAuth. */
declare type ProviderAuth = {
    method: 'api-key';
    apiKey: string;
} | {
    method: 'oauth';
};

declare type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

declare type ProviderCatalogItem_2 = Awaited<ReturnType<IModelCatalog['listProviders']>>[number];

declare const providerCatalogItemSchema: z.ZodObject<{
    id: z.ZodString;
    type: z.ZodString;
    base_url: z.ZodOptional<z.ZodString>;
    default_model: z.ZodOptional<z.ZodString>;
    api_key_env: z.ZodOptional<z.ZodString>;
    has_api_key: z.ZodBoolean;
    status: z.ZodEnum<{
        error: "error";
        connected: "connected";
        unconfigured: "unconfigured";
    }>;
    models: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;

export declare type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

declare type ProviderConfig_2 = ({
    type: 'anthropic';
} & AnthropicOptions) | ({
    type: 'openai';
} & OpenAILegacyOptions) | ({
    type: 'kimi';
} & KimiOptions) | ({
    type: 'google-genai';
} & GoogleGenAIOptions) | ({
    type: 'openai_responses';
} & OpenAIResponsesOptions) | ({
    type: 'vertexai';
} & GoogleGenAIOptions);

declare interface ProviderConfigResponse {
    type: string;
    base_url?: string;
    default_model?: string;
    has_api_key: boolean;
}

declare const ProviderConfigSchema: z.ZodObject<{
    type: z.ZodEnum<{
        anthropic: "anthropic";
        vertexai: "vertexai";
        kimi: "kimi";
        openai: "openai";
        "google-genai": "google-genai";
        openai_responses: "openai_responses";
    }>;
    apiKey: z.ZodOptional<z.ZodString>;
    apiKeyEnv: z.ZodOptional<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
    defaultModel: z.ZodOptional<z.ZodString>;
    oauth: z.ZodOptional<z.ZodObject<{
        storage: z.ZodEnum<{
            file: "file";
            keyring: "keyring";
        }>;
        key: z.ZodString;
        oauthHost: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    source: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;

/** Named provider configuration passed to `kosong.addProvider(id, config)`. */
declare interface ProviderInput {
    type: string;
    baseUrl?: string;
    auth: ProviderAuth;
    defaultModel?: string;
}

declare type ProviderRefreshChange = z.infer<typeof providerRefreshChangeSchema>;

declare const providerRefreshChangeSchema: z.ZodObject<{
    provider_id: z.ZodString;
    provider_name: z.ZodString;
    added: z.ZodNumber;
    removed: z.ZodNumber;
}, z.core.$strip>;

declare type ProviderRefreshFailure = z.infer<typeof providerRefreshFailureSchema>;

declare const providerRefreshFailureSchema: z.ZodObject<{
    provider: z.ZodString;
    reason: z.ZodString;
}, z.core.$strip>;

/**
 * Options that can be forwarded to a single {@link ChatProvider.generate} call.
 */
declare interface ProviderRequestAuth {
    /** Bearer/API token resolved for this specific provider request. */
    apiKey?: string;
    /** Request-scoped headers. These override constructor-level default headers. */
    headers?: Record<string, string>;
}

declare interface ProvidersChangedEvent {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
}

export declare type ProviderType = z.infer<typeof ProviderTypeSchema>;

declare type ProviderType_2 = ProviderConfig_2['type'];

declare const ProviderTypeSchema: z.ZodEnum<{
    anthropic: "anthropic";
    vertexai: "vertexai";
    kimi: "kimi";
    openai: "openai";
    "google-genai": "google-genai";
    openai_responses: "openai_responses";
}>;

export declare type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';

export declare type QuestionAnswers = Record<string, string | true>;

export declare type QuestionBackgroundTaskInfo = QuestionTaskInfo;

export declare type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;

export declare interface QuestionItem {
    readonly question: string;
    readonly header?: string;
    readonly body?: string;
    readonly options: readonly QuestionOption[];
    readonly multiSelect?: boolean;
    readonly otherLabel?: string;
    readonly otherDescription?: string;
}

export declare interface QuestionOption {
    readonly label: string;
    readonly description?: string;
}

export declare interface QuestionRequest {
    readonly id?: string;
    readonly turnId?: number;
    readonly toolCallId?: string;
    readonly questions: readonly QuestionItem[];
}

export declare interface QuestionResponse {
    readonly answers: QuestionAnswers;
    readonly method?: QuestionAnswerMethod;
}

export declare type QuestionResult = null | QuestionAnswers | QuestionResponse;

declare interface QuestionTaskInfo extends AgentTaskInfoBase {
    readonly kind: 'question';
    readonly questionCount: number;
    readonly toolCallId?: string;
}

declare interface ReconnectMcpServerRpcInput extends SessionIdRpcInput {
    readonly name: string;
    readonly config?: McpServerConfig;
}

export declare function redact<T>(value: T): T;

declare type RefreshOAuthProviderModelsResponse = z.infer<typeof refreshOAuthProviderModelsResponseSchema>;

declare const refreshOAuthProviderModelsResponseSchema: z.ZodObject<{
    changed: z.ZodArray<z.ZodObject<{
        provider_id: z.ZodString;
        provider_name: z.ZodString;
        added: z.ZodNumber;
        removed: z.ZodNumber;
    }, z.core.$strip>>;
    unchanged: z.ZodArray<z.ZodString>;
    failed: z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;

declare type RefreshProviderModelsOptions = NonNullable<Parameters<IProviderDiscoveryService['refreshProviderModels']>[0]>;

declare interface RefreshProviderModelsOptions_2 {
    readonly scope?: RefreshProviderModelsScope;
    readonly providerId?: string;
}

declare type RefreshProviderModelsResponse = z.infer<typeof refreshProviderModelsResponseSchema>;

declare type RefreshProviderModelsResponse_2 = Awaited<ReturnType<IOAuthService['refreshOAuthProviderModels']>>;

declare const refreshProviderModelsResponseSchema: z.ZodObject<{
    changed: z.ZodArray<z.ZodObject<{
        provider_id: z.ZodString;
        provider_name: z.ZodString;
        added: z.ZodNumber;
        removed: z.ZodNumber;
    }, z.core.$strip>>;
    unchanged: z.ZodArray<z.ZodString>;
    failed: z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        reason: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;

declare type RefreshProviderModelsScope = 'all' | 'oauth';

declare interface RegisterAgentTaskOptions {
    readonly detached?: boolean;
    readonly timeoutMs?: number;
    readonly detachTimeoutMs?: number;
    readonly autoBackgroundOnTimeout?: boolean;
    readonly signal?: AbortSignal;
}

export declare class RegistryImportError extends Error {
    readonly phase: 'fetch' | 'empty' | 'apply';
    readonly status?: number | undefined;
    constructor(message: string, phase: 'fetch' | 'empty' | 'apply', status?: number | undefined);
}

export declare interface ReloadSessionInput extends ResumeSessionInput {
    readonly forcePluginSessionStartReminder?: boolean;
}

export declare interface ReloadSessionOptions {
    readonly forcePluginSessionStartReminder?: boolean;
}

declare interface ReloadSessionRpcInput extends SessionIdRpcInput {
    readonly forcePluginSessionStartReminder?: boolean;
}

export declare interface ReloadSummary {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly errors: ReadonlyArray<{
        readonly id: string;
        readonly message: string;
    }>;
}

/**
 * Apply the v1 remove-provider cascade to a whole `KimiConfig` in memory (no
 * persistence): drop the provider entry, every model pointing at it, and the
 * default pointers when they dangle. Hosts that stage a removal and fold it
 * into a later atomic write (instead of persisting it immediately) build on
 * this — the same role the v2 engine's `shapeWithoutProvider` plays for its
 * own refresh path.
 */
export declare function removeProviderFromConfig(config: KimiConfig, providerId: string): KimiConfig;

export declare interface RenameSessionInput {
    readonly id: string;
    readonly title: string;
}

export declare function resolveAgentPath(path: string, baseDir: string, osHomeDir: string): string;

/**
 * Resolves a catalog provider entry into an import decision.
 *
 * Wire: an explicit `type` is authoritative (honored when known, refused
 * when not); otherwise `npm`/`id` heuristics; otherwise the
 * OpenAI-compatible fallback (`guessed: true`) — except SDKs known to be
 * non-OpenAI proprietary, which are refused outright.
 *
 * Endpoint: a user-supplied URL wins over the catalog's `api` (after trim;
 * blank and `${VAR}` placeholders are rejected). Without one, the catalog
 * `api` applies; with neither, only wires whose default endpoint belongs to
 * the vendor's official SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`, or
 * env-resolved vertex/google) resolve without asking — everything else is
 * `needs-base-url`, because persisting no endpoint would silently send the
 * key to the wrong host. URLs are adapted to the wire's SDK convention
 * (trailing `/v1` stripped for Anthropic).
 */
export declare function resolveCatalogImport(entry: CatalogProviderEntry, userBaseUrl?: string): CatalogImportResolution;

export declare function resolveConfigPath(input: {
    readonly homeDir?: string;
    readonly configPath?: string;
}): string;

declare type ResolvedAgentProfile = AgentProfile;

declare interface ResolvedRuntimeProvider {
    readonly providerName: string;
    readonly provider: ProviderConfig_2;
    readonly modelCapabilities: ModelCapability;
    readonly alwaysThinking?: boolean;
    readonly supportEfforts?: readonly string[];
    readonly defaultEffort?: string;
    readonly maxOutputSize?: number;
    readonly type: ProviderType;
    readonly protocol: ModelAlias['protocol'];
}

export declare function resolveGlobalLogPath(homeDir: string): string;

export declare interface ResolveKimiConfigPathInput {
    readonly homeDir?: string | undefined;
    readonly configPath?: string | undefined;
}

export declare function resolveKimiHome(homeDir?: string, env?: NodeJS.ProcessEnv, osHomeDir?: string): string;

declare type ResponseFormat_2 = JsonObjectResponseFormat | JsonSchemaResponseFormat;

export declare interface ResumedAgentState {
    readonly type: AgentType;
    readonly config: AgentConfigData;
    readonly context: AgentContextData;
    readonly replay: readonly AgentReplayRecord[];
    readonly permission: PermissionData;
    readonly plan: PlanData;
    readonly swarmMode?: boolean | undefined;
    readonly usage: UsageStatus;
    readonly tools: readonly ToolInfo[];
    readonly toolStore?: Readonly<Record<string, unknown>>;
    readonly background: readonly BackgroundTaskInfo[];
}

export declare type ResumedSessionState = Pick<ResumeSessionResult, 'sessionMetadata' | 'agents' | 'warning'>;

export declare interface ResumedSessionSummary extends SessionSummary, ResumedSessionState {
}

export declare interface ResumeSessionInput {
    readonly id: string;
    readonly kaos?: Kaos | undefined;
    readonly persistenceKaos?: Kaos | undefined;
    readonly additionalDirs?: readonly string[];
    /** Re-select the session's already-bound main profile; a different name fails. */
    readonly agentProfile?: string;
    /** Include persisted subagent states in the returned replay snapshot. */
    readonly includeSubagents?: boolean;
    /**
     * Limit each returned agent replay to the most recent N user turns. Omit to
     * return the full replay. Lets UI callers that only render the tail avoid
     * transferring the entire history over the RPC boundary.
     */
    readonly replayTurnLimit?: number;
    readonly sessionStartedProperties?: TelemetryProperties;
}

declare interface ResumeSessionResult extends SessionSummary_2 {
    readonly sessionMetadata: SessionMeta;
    readonly agents: Readonly<Record<string, ResumedAgentState>>;
    readonly warning?: string | undefined;
}

declare interface RetryOrigin {
    readonly kind: 'retry';
    readonly trigger?: string;
}

declare interface RetryOrigin_2 {
    readonly kind: 'retry';
    readonly trigger?: string;
}

export declare type Role = 'system' | 'user' | 'assistant' | 'tool';

declare interface RunCommandRpcInput extends SessionIdRpcInput {
    readonly name: string;
    readonly args?: string | undefined;
}

declare interface RunShellCommandInput {
    readonly command: string;
    readonly commandId?: string;
}

declare interface RunShellCommandResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly isError?: boolean;
    readonly backgrounded?: boolean;
}

declare type RuntimeBinding = ReturnType<IAgentRuntimeBindingService['get']>;

declare interface RuntimeBinding_2 {
    readonly workspaceId: string;
    readonly runtimeId: string;
}

declare interface RuntimeConfigLoadResult {
    readonly config: KimiConfig;
    readonly fileWarnings: readonly string[];
    readonly envWarnings: readonly string[];
    readonly fileError?: KimiError;
}

declare interface SamplingOptions {
    readonly temperature?: number;
    readonly topP?: number;
}

export declare type ScopeSeed = ReadonlyArray<readonly [ServiceIdentifier<any>, unknown]>;

export declare abstract class SDKRpcClientBase {
    private readonly interactiveAgentScope;
    private readonly eventListeners;
    private readonly approvalHandlers;
    private readonly questionHandlers;
    get interactiveAgentId(): string;
    withInteractiveAgent<T>(agentId: string, fn: () => T): T;
    abstract createSession(input: CreateSessionOptions): Promise<SessionSummary>;
    createSessionWithKaos(input: CreateSessionOptions, kaos: Kaos, persistenceKaos?: Kaos): Promise<SessionSummary>;
    abstract resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary>;
    resumeSessionWithKaos(input: ResumeSessionInput, kaos: Kaos, persistenceKaos?: Kaos): Promise<ResumedSessionSummary>;
    abstract reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary>;
    abstract forkSession(input: ForkSessionInput): Promise<SessionSummary>;
    abstract closeSession(input: SessionIdRpcInput): Promise<void>;
    abstract deleteSession(input: SessionIdRpcInput): Promise<void>;
    abstract listSessions(input?: ListSessionsOptions): Promise<readonly SessionSummary[]>;
    abstract listSessionsPage(input?: ListSessionsOptions): Promise<SessionSummaryPage>;
    abstract listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;
    abstract getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo>;
    abstract trustWorkspace(workDir: string): Promise<void>;
    abstract renameSession(input: RenameSessionInput): Promise<void>;
    abstract generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | undefined>;
    abstract exportSession(input: ExportSessionInput): Promise<ExportSessionResult>;
    abstract getConfig(input?: GetConfigOptions): Promise<KimiConfig>;
    abstract getConfigDiagnostics(): Promise<ConfigDiagnostics>;
    abstract getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]>;
    abstract setConfig(input: KimiConfigPatch): Promise<KimiConfig>;
    abstract removeProvider(providerId: string): Promise<KimiConfig>;
    abstract supportsAtomicSectionReplace(): boolean;
    abstract importCustomRegistry(options: ImportCustomRegistryOptions): Promise<ImportCustomRegistryResult>;
    abstract replaceConfigSections(sections: Record<string, unknown>): Promise<void>;
    abstract uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta>;
    abstract deleteFile(fileId: string): Promise<void>;
    abstract listGlobalMcpServers(options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    abstract getGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<McpManagedServerInfo>;
    abstract listGlobalMcpServerAuthStatuses(options?: {
        readonly cwd?: string;
        readonly verify?: boolean;
    }): Promise<readonly GlobalMcpServerAuthStatus[]>;
    abstract inspectAppMcpServers(targets?: readonly McpServerLocator[], options?: {
        readonly cwd?: string;
    }): Promise<readonly AppMcpServerInspection[]>;
    abstract addGlobalMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    abstract updateGlobalMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    abstract removeGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    abstract beginGlobalMcpServerAuth(name: string, options?: {
        readonly cwd?: string;
    }): Promise<BeginGlobalMcpServerAuthResult>;
    abstract beginMcpServerAuth(locator: McpServerLocator, options?: {
        readonly cwd?: string;
    }): Promise<BeginGlobalMcpServerAuthResult>;
    abstract completeGlobalMcpServerAuth(input: {
        readonly flowId: string;
        readonly timeoutMs?: number;
    }, signal?: AbortSignal): Promise<void>;
    abstract completeMcpServerAuth(input: {
        readonly flowId: string;
        readonly timeoutMs?: number;
    }, signal?: AbortSignal): Promise<void>;
    abstract cancelGlobalMcpServerAuth(flowId: string): Promise<void>;
    abstract cancelMcpServerAuth(flowId: string): Promise<void>;
    abstract resetGlobalMcpServerAuth(name: string, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    abstract resetMcpServerAuth(locator: McpServerLocator, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    abstract testGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<McpTestResult>;
    abstract testGlobalMcpServerConfig(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<McpTestResult>;
    abstract prompt(input: SessionPromptRpcInput): Promise<void>;
    abstract promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void>;
    abstract runShellCommand(input: {
        sessionId: string;
        command: string;
        commandId?: string;
    }): Promise<{
        stdout: string;
        stderr: string;
        isError?: boolean;
        backgrounded?: boolean;
    }>;
    abstract cancelShellCommand(input: {
        sessionId: string;
        commandId: string;
    }): Promise<void>;
    abstract steer(input: SessionPromptRpcInput): Promise<void>;
    abstract generateAgentsMd(input: SessionIdRpcInput): Promise<void>;
    abstract getSessionWarnings(input: SessionIdRpcInput): Promise<readonly SessionWarningInfo[]>;
    abstract addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult>;
    abstract startBtw(input: SessionIdRpcInput): Promise<string>;
    abstract cancel(input: SessionIdRpcInput): Promise<void>;
    abstract clearContext(input: SessionIdRpcInput): Promise<void>;
    abstract importContext(input: ImportContextRpcInput): Promise<void>;
    abstract setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult>;
    abstract setThinking(input: SetSessionThinkingRpcInput): Promise<void>;
    abstract setPermission(input: SetSessionPermissionRpcInput): Promise<void>;
    abstract updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void>;
    abstract setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void>;
    abstract setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void>;
    abstract swarm(input: SessionPromptRpcInput): Promise<void>;
    abstract setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void>;
    abstract getPlan(input: SessionIdRpcInput): Promise<SessionPlan>;
    abstract clearPlan(input: SessionIdRpcInput): Promise<void>;
    abstract compact(input: SessionIdRpcInput & CompactOptions): Promise<void>;
    abstract cancelCompaction(input: SessionIdRpcInput): Promise<void>;
    abstract getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]>;
    abstract undoHistory(input: SessionIdRpcInput & {
        count: number;
    }): Promise<void>;
    abstract getContext(input: SessionIdRpcInput): Promise<AgentContextData>;
    abstract getUsage(input: SessionIdRpcInput): Promise<SessionUsage>;
    abstract getStatus(input: SessionIdRpcInput): Promise<SessionStatus>;
    abstract listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]>;
    abstract listPluginCommands(input: SessionIdRpcInput): Promise<readonly PluginCommandDef[]>;
    abstract listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]>;
    abstract suggestFiles(workDir: string, input: SuggestFilesInput): Promise<SuggestFilesResult | undefined>;
    abstract listBackgroundTasks(input: SessionIdRpcInput & {
        activeOnly?: boolean;
        limit?: number;
    }): Promise<readonly BackgroundTaskInfo[]>;
    abstract getBackgroundTaskOutput(input: SessionIdRpcInput & {
        taskId: string;
        tail?: number;
    }): Promise<string>;
    abstract stopBackgroundTask(input: SessionIdRpcInput & {
        taskId: string;
        reason?: string;
    }): Promise<void>;
    abstract detachBackgroundTask(input: SessionIdRpcInput & {
        taskId: string;
    }): Promise<BackgroundTaskInfo | undefined>;
    abstract waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void>;
    abstract handlePrintMainTurnCompleted(input: SessionIdRpcInput): Promise<'finish' | 'continue'>;
    abstract createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot>;
    abstract getGoal(input: SessionIdRpcInput): Promise<GoalToolResult>;
    abstract pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    abstract resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    abstract cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    abstract getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult>;
    abstract listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]>;
    abstract listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]>;
    abstract getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics>;
    abstract reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void>;
    abstract addSessionMcpServer(input: {
        readonly sessionId: string;
        readonly server: McpServerConfig;
        readonly persist?: boolean;
    }): Promise<McpServerInfo>;
    abstract listPlugins(): Promise<readonly PluginSummary[]>;
    abstract installPlugin(source: string): Promise<PluginSummary>;
    abstract setPluginEnabled(id: string, enabled: boolean): Promise<void>;
    abstract setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
    abstract removePlugin(id: string): Promise<void>;
    abstract reloadPlugins(): Promise<ReloadSummary>;
    abstract getPluginInfo(id: string): Promise<PluginInfo>;
    abstract activateSkill(input: ActivateSkillRpcInput): Promise<void>;
    abstract activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void>;
    abstract listCommands(input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]>;
    abstract runCommand(input: RunCommandRpcInput): Promise<void>;
    abstract getRuntime(input: SessionIdRpcInput): Promise<AgentRuntimeBinding>;
    abstract switchRuntime(input: SwitchSessionRuntimeRpcInput): Promise<AgentRuntimeBinding>;
    onEvent(listener: (event: Event_2) => void): Unsubscribe;
    receiveEvent(event: Event_2): void;
    setApprovalHandler(sessionId: string, handler: ApprovalHandler | undefined): void;
    setQuestionHandler(sessionId: string, handler: QuestionHandler | undefined): void;
    clearSessionHandlers(sessionId: string): void;
    requestApproval(request: ApprovalRequest & {
        sessionId: string;
        agentId: string;
    }): Promise<ApprovalResponse>;
    requestQuestion(request: QuestionRequest & {
        sessionId: string;
        agentId: string;
    }): Promise<QuestionResult>;
    toolCall(request: ToolCallRequest): Promise<ToolCallResponse>;
}

export declare class SDKRpcClientV2 extends SDKRpcClientBase {
    readonly homeDir: string;
    readonly configPath: string;
    readonly identity: KimiHostIdentity | undefined;
    readonly telemetry: TelemetryClient;
    readonly auth: KimiAuthFacade;
    readonly klient: Klient;
    private readonly app;
    /**
     * The engine's config reads (`get`/`getAll`/`inspect`/`diagnostics`) are
     * synchronous over state that only exists once the initial load settles;
     * unlike the mutating methods they do not await `IConfigService.ready`
     * internally, so every config override below awaits this first. Awaiting
     * the engine's own ready handle (via the accessor) instead of issuing a
     * dummy facade call keeps the reads honest no-ops.
     */
    private readonly configReady;
    /**
     * Per-session print-steer state for `handlePrintMainTurnCompleted`: v1
     * keeps the deadline/turn counters on the `Session` object, so they reset
     * when the session closes (a resume builds a fresh `Session`); mirrored
     * here by deleting the entry in {@link unwireSession}, which every close
     * path (client, engine, delete) funnels through.
     */
    private readonly printSteerStates;
    /**
     * The model/provider registries (`IModelService` / `IProviderService`)
     * share the config service's ready trap: their `get`/`list` reads are
     * synchronous over state that only exists after hydration, and every
     * agent-side model operation (profile bind, `setModel`, capability reads)
     * flows through them. Agent-interaction overrides await this before
     * touching a profile.
     */
    private readonly modelReady;
    /**
     * Per-live-session event/interaction wirings (`src/v2/session-wiring.ts`):
     * created when a session materializes through this client (create / resume /
     * fork / reload), dropped on close (ours or the engine's). Each wiring feeds
     * the base class's event listeners from the session's per-agent event buses
     * and bridges its pending approvals / questions / user-tool calls to the
     * registered handlers.
     */
    private readonly sessionWirings;
    /**
     * Per-session serialization for the operations that change a session's
     * live ownership: the temporary resume→act→close paths (`renameSession`,
     * `generateSessionTitle`) and the public `resumeSession` / `closeSession`
     * / `reloadSession`. Chaining them through one queue per session id makes
     * the handoff atomic — a public resume either lands first (the temporary
     * path then reuses the live handle and leaves it open) or waits for the
     * temporary close to finish and materializes a fresh scope, so a caller
     * can never receive a handle whose close is already in flight.
     */
    private readonly sessionAccessQueues;
    /** App-scope subscriptions (global event forwarding, lifecycle tracking), disposed in {@link close}. */
    private readonly appSubscriptions;
    constructor(options?: SDKRpcClientV2Options);
    ensureConfigFile(): Promise<void>;
    close(): Promise<void>;
    /**
     * Forward engine telemetry to the host-supplied client. Without this the
     * client only served `KimiHarness`-level events and every engine-side event
     * (`track2` facts from agent/session scopes) was dropped on the v2 route.
     * The v1 `TelemetryClient` is wrapped into the engine appender record shape
     * (event + ambient context + final properties). The `telemetry` config
     * section gates engine events the same way the v2 print runner gates them;
     * the host keeps owning the client's lifecycle (flush / shutdown stay with
     * the host, matching the v1 core's arrangement).
     *
     * The engine's own `session_started` is forwarded unless
     * {@link suppressEngineSessionStarted} was called — see its doc for why the
     * harness-assembled client drops that row.
     */
    private installEngineTelemetry;
    private engineSessionStartedSuppressed;
    /**
     * Drop the engine's own `session_started` from telemetry forwarding. Called
     * by `createKimiHarness` at assembly time: the harness emits that event
     * for every session it opens (create / resume / reload / fork) with the
     * richer client-attribution schema, so the engine's
     * `{resumed, experimental_flags}` copy would double-count every open.
     * Direct `SDKRpcClientV2` consumers never call this and keep the engine row
     * — it is their only `session_started` producer. Hosts without a harness
     * (run-v2-print, kap-server) wire their own appenders and are unaffected
     * either way.
     */
    suppressEngineSessionStarted(): void;
    /**
     * Exposed experimental flag ids in the `session_started` wire shape (sorted,
     * comma-joined), read live from the in-process engine's flag service. The
     * harness-side `session_started` row merges this so both producers of the
     * event carry the same flag dimension. Exposure is the flag system's own
     * notion (`IFlagService.exposedIds`): a flag that is enabled but not yet
     * active in this process (e.g. its feature assembles at App construction)
     * does not count.
     */
    enabledExperimentalFlags(): string;
    /**
     * Escape hatch to the in-process engine's app-scope service accessor, for
     * SDK methods whose capability exists in agent-core-v2 but is not (yet)
     * exposed through the klient facade. This is a deliberate migration
     * pressure valve, not a new public API direction:
     * - it only exists because this client owns the bootstrapped `Scope` —
     *   there is nothing equivalent on a remote (ipc) transport, so anything
     *   built on it is in-process-only by construction;
     * - it resolves App-scope services only. Session/agent services need their
     *   own scope handles (via the lifecycle services), not this accessor;
     * - every use should name the klient facade method it stands in for, and
     *   move onto the facade once one exists. Remove when the migration ends.
     */
    get engineAccessor(): ServicesAccessor;
    getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]>;
    /**
     * `uploadFile` → `klient.global.files.save` (the app-scope `IFileService`).
     * The SDK's single `name` doubles as the engine's `filename`; the engine's
     * `SaveOptions.name` (display name) defaults to it.
     */
    uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta>;
    deleteFile(fileId: string): Promise<void>;
    /**
     * Through the workspace handler's `IWorkspaceSkillCatalog` — the engine's
     * own merged view (builtin / user / explicit / extra / workspace-root /
     * plugin), so the session-less list matches what a session would serve.
     * `handlerFor` is create-or-get: session creation materializes the handler
     * anyway.
     */
    listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]>;
    /**
     * Through the workspace handler's `IWorkspaceFsService` — the same engine
     * suggest the kap-server `fs:suggest` routes serve (fuzzy scoring,
     * directories included, gitignore respected), so in-process hosts match
     * the web client's @ mention results.
     */
    suggestFiles(workDir: string, input: SuggestFilesInput): Promise<SuggestFilesResult | undefined>;
    /**
     * klient has no workspace-trust facade; composed directly from the engine
     * via {@link engineAccessor} — the same `handlerFor({ root })` path
     * `createSession` takes (materializing the workspace handler is a no-op
     * cost here: session creation does it anyway). The gated-server list is
     * the final merged config entries whose origins are project files (the
     * workspaceTrust gate inside the engine's `workspaceMcpConfig`),
     * computed best-effort: an unreadable/invalid project file degrades to an
     * empty list rather than failing the caller.
     */
    getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo>;
    /**
     * klient has no workspace-trust facade; see {@link getWorkspaceTrustInfo}.
     * The flip fires `IWorkspaceTrust.onDidChange`, which makes the engine's
     * `workspaceMcpConfig` reload with project files included — project MCP
     * servers connect live, no restart needed.
     */
    trustWorkspace(workDir: string): Promise<void>;
    /**
     * v1 returns the whole config.toml document as one `KimiConfig`; v2
     * resolves the same file per config domain. `getAll()` is the effective
     * view (file + env overlays + section defaults), which matches v1's
     * runtime config (`loadRuntimeConfigSafe` + the KIMI_MODEL_* overlay);
     * `reload` mirrors v1's re-read-from-disk option.
     */
    getConfig(options?: GetConfigOptions): Promise<KimiConfig>;
    getConfigDiagnostics(): Promise<ConfigDiagnostics>;
    /**
     * A v1 patch is one deep-merge over the whole document; v2 deep-merges
     * per domain with the same plain-object-recursive / array-replace
     * semantics, so the patch fans out one `config.set` per top-level field.
     * Unknown-to-v2 fields (`yolo`, `planMode`, `telemetry`, ...) persist as
     * unregistered pass-through domains, like v1's schema keeping them.
     */
    setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
    /**
     * v1's removal cascades: the provider entry, every model pointing at it,
     * and the default pointers when they dangle. The engine's own
     * `kosong.removeProvider` only clears the default-provider pointer, so the
     * full v1 cascade is computed from the user-layer values (see
     * `planProviderRemoval`) and persisted as ONE atomic multi-section
     * replace — the same single-write shape as v1's `removeKimiProvider`, so a
     * process exit can never leave the file in a halfway-cascaded state. The
     * `[secondary_model]` section is left alone on purpose: an entry whose
     * model no longer resolves fails pool validation on the next session
     * create, surfacing a named error instead of silently rewriting the
     * user's configuration.
     */
    removeProvider(providerId: string): Promise<KimiConfig>;
    supportsAtomicSectionReplace(): boolean;
    importCustomRegistry(options: ImportCustomRegistryOptions): Promise<ImportCustomRegistryResult>;
    replaceConfigSections(sections: Record<string, unknown>): Promise<void>;
    listPlugins(): Promise<readonly PluginSummary[]>;
    installPlugin(source: string): Promise<PluginSummary>;
    setPluginEnabled(id: string, enabled: boolean): Promise<void>;
    setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
    removePlugin(id: string): Promise<void>;
    reloadPlugins(): Promise<ReloadSummary>;
    getPluginInfo(id: string): Promise<PluginInfo>;
    /**
     * Capability surface (v2-only): built-in product capabilities (kimi-cu,
     * kimi-webbridge) with layered readiness and idempotent installs. v1 has
     * no capability domain, so these stay off the shared base — callers
     * feature-detect via `in` before use.
     */
    listCapabilities(): Promise<readonly CapabilityStatus[]>;
    getCapability(id: string): Promise<CapabilityStatus>;
    installCapability(id: string): Promise<CapabilityStatus>;
    /**
     * Scope gap: v1 answers from the session's creation-time snapshot of the
     * enabled plugin commands, while the v2 engine only exposes the app-global
     * live view (`pluginService.listPluginCommands`), so the sessionId is
     * ignored here. The two agree for any session created after the last
     * plugin change; a v1 session predating an install/toggle goes stale where
     * v2 stays live.
     */
    listPluginCommands(input: SessionIdRpcInput): Promise<readonly PluginCommandDef[]>;
    /** App-global live view of the enabled plugin commands, no session required. */
    listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]>;
    private liveSession;
    /**
     * Runs `work` after every previously queued operation on the same session
     * settles; different sessions still run in parallel. The map entry drops
     * itself once the queue drains.
     */
    private runSessionAccess;
    /**
     * Multi-key variant of {@link runSessionAccess}: acquires the queues in
     * sorted order so concurrent multi-key operations (fork A→B vs fork B→A)
     * cannot deadlock.
     */
    private runSessionAccessAll;
    /**
     * Runs `action` against the session without changing its live footprint: a
     * session that is already live (publicly resumed or created through this
     * client) is used in place and left open, while a cold session is resumed
     * for the duration of the action and closed again. Only safe inside
     * {@link runSessionAccess} — the queue is what makes the resume/close pair
     * atomic against the public lifecycle operations.
     */
    private withTemporarySession;
    /** v1's `requireSession` / store lookup failure shape. */
    private static sessionNotFound;
    /** The live session handle, or the error v1 raises for a non-active session. */
    private requireLiveSession;
    /**
     * v1's persist-add project guard ported to the workspace loader. This read
     * deliberately includes the project layer even while the workspace is
     * untrusted: a user-level write must not create a shadow that springs into
     * conflict when the workspace is trusted later.
     */
    private rejectProjectLayerPersistedMcpAdd;
    /**
     * Attach the event/interaction wiring to a freshly materialized session
     * (idempotent). Unwiring needs no call site of its own: every close path
     * goes through the engine's lifecycle close, whose `onDidCloseSession`
     * subscription (constructor) drops the wiring.
     */
    private wireSession;
    private unwireSession;
    /**
     * The v1 summary of a live session, read from its own scope services (the
     * metadata document, the context's cwd/sessionDir, the workspace context's
     * additional dirs) rather than the index — no disk round-trip, and the
     * additional dirs only exist on the live session in both engines.
     */
    private liveSessionSummary;
    /**
     * The `ResumedSessionSummary` of a just-materialized session, including the
     * per-agent snapshot v1 serves: the live slices are read from the restored
     * agent scope (profile / permission / swarm services and the klient agent
     * facade for context / plan / usage / background tasks), while `replay` and
     * `toolStore` are folded from the agent's `wire.jsonl` by
     * {@link foldAgentWireReplay} over the engine's `foldWireRecords`. The main
     * agent's fold may arrive already in flight via `mainWireFold` (started by
     * `resumeSession` ahead of the restore; subagents always fold lazily here).
     * `warning` stays undefined — v2's resume has no migration-warning channel.
     */
    private resumedSessionSummary;
    /**
     * One agent's v1 `ResumedAgentState`. The scope reads mirror v1's
     * `resumeSessionResult` field-by-field; the casts only bridge the two
     * packages' type declarations (the wire shapes are the documented-identical
     * ports, same as the `getContext` / `listBackgroundTasks` overrides). One
     * deliberate gap: `config.provider` is always undefined — v1 resolves the
     * full runtime `ProviderConfig` into the snapshot, agent-core-v2 has no
     * equivalent read, and the TUI only falls back to `provider?.model` when
     * `modelAlias` is unset (pinned in the parity KNOWN_DIFFS). `earlyWireFold`
     * is the main agent's fold started before the engine restore finished; an
     * `undefined` outcome (path unknown ahead of time) falls back to folding
     * from the live handle here.
     */
    private resumedAgentState;
    /**
     * Every v2 workspace-id bucket addressing `workDir` (already normalized):
     * the registered workspace's alias set when the catalog knows the root, or
     * the freshly minted bucket key for index-only sessions (mirrors how v1's
     * store lists a bucket that never touched the workspace registry).
     */
    private workspaceIdsFor;
    listSessions(input?: ListSessionsOptions): Promise<readonly SessionSummary[]>;
    listSessionsPage(input?: ListSessionsOptions): Promise<SessionSummaryPage>;
    /**
     * Map one v2 index summary to the v1 wire shape, resolving the filesystem
     * facts the index does not carry. Returns `undefined` when the session's
     * workDir is unrecoverable (corrupt metadata, deleted workspace): such a
     * session cannot be resumed on either engine, and v1's store never lists
     * one in the first place.
     */
    private mapIndexSummary;
    /**
     * v1 semantics: register the workDir as a workspace and create the session
     * (the handler's `ISessionLifecycleService.create` does both; the klient facade
     * wrapper is bypassed because it takes neither an explicit session id nor
     * caller metadata). The `model` / `thinking` / `permission` options are the
     * main-agent configuration v1 applies eagerly at creation: supplying any of
     * them materializes the main agent here (v2 otherwise keeps it lazy) and
     * binds the default profile with the requested model/thinking. v1 never
     * validates either at create time — an unknown alias is recorded verbatim
     * and an unlisted effort normalizes to the model default — so the bind is
     * deliberately NOT `strictThinking`, and the v2-only create-time rejections
     * that still leak through (unknown alias → `config.invalid`, no configured
     * default model → `model.not_configured`) are pinned in the parity tests.
     */
    createSession(input: CreateSessionOptions): Promise<SessionSummary>;
    private doCreateSession;
    /**
     * v1 renames through the live session when there is one and at the store
     * level otherwise. The v2 metadata service is session-scoped (and the
     * klient session facade 404s on a non-live session), so a closed session is
     * resumed, renamed, and closed again to land in the same state. The v2
     * `setTitle` does no validation, so v1's trim + empty-title rejection lives
     * here.
     */
    renameSession(input: RenameSessionInput): Promise<void>;
    /**
     * v2-only (`ISessionTitleService`, session scope). Like `renameSession`, a
     * closed session is resumed, titled, and closed again so generation does
     * not leak a live session. `undefined` means generation was unavailable
     * (no managed OAuth login, no prompt yet, or a custom title is set) — the
     * current title is kept.
     */
    generateSessionTitle(input: GenerateSessionTitleInput): Promise<string | undefined>;
    /**
     * Through `engineAccessor` (the handler chain's `ISessionLifecycleService.fork`) because the
     * klient facade fork takes no explicit target id. `turnIndex` truncation and
     * the live-source busy rejection (v1's `SESSION_FORK_ACTIVE_TURN`) are the
     * engine's own now, so their failures cross the in-process call with v1's
     * codes and details (`request.invalid` with `{turnIndex, availableTurns}` /
     * `session.fork_active_turn`). The default title still differs by design
     * (v1: "New Session", v2: "Fork: <source>") — pass an explicit title for
     * identical results.
     */
    forkSession(input: ForkSessionInput): Promise<SessionSummary>;
    closeSession(input: SessionIdRpcInput): Promise<void>;
    /**
     * Through `engineAccessor` (the handler chain's
     * `ISessionLifecycleService.delete`) because the klient facade's
     * `session(id).delete()` reports a missing session with its own
     * `RPCError(NOT_FOUND)` where v1's store failure is a
     * `KimiError(SESSION_NOT_FOUND)` — the pre-check here keeps the v1 shape.
     * The engine's delete mirrors v1's order: close the live session first
     * (which also drops this client's wiring via the close subscription), then
     * remove the session dir, the index entry, and journal the deletion.
     */
    deleteSession(input: SessionIdRpcInput): Promise<void>;
    /**
     * Materializes the session through `engineAccessor`
     * (`resumeSessionById` through the handler chain; the facade only offers `restore`,
     * which would also clear the archived flag — v1's resume does not).
     * `includeSubagents` / `replayTurnLimit` shape the returned per-agent
     * snapshot exactly like v1: subagent states are folded best-effort from
     * each persisted agent wire, and every agent's replay is trimmed to the
     * most recent N user turns via the shared `limitAgentReplayByTurns`.
     */
    resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary>;
    /**
     * Starts the main agent's wire fold as soon as its path is known — a live
     * session's own context, or the bucket computed from the index summary —
     * so the read-only fold overlaps the engine's restore instead of waiting
     * for it. The returned promise never rejects: the fold swallows its own
     * failures into an empty fold, and the path lookup degrades to `undefined`,
     * which makes {@link resumedAgentState} fold from the materialized handle
     * exactly as it would without the early start.
     */
    private startMainWireFold;
    /**
     * v1's reload: refuse while a turn runs, re-read config + plugins, close
     * the live session, resume from disk. The v2 busy check reads each live
     * agent's loop status (turn lane only — background tasks do not block,
     * matching v1's `hasActiveTurn`). `forcePluginSessionStartReminder` has no
     * v2 channel (the engine owns plugin session-start injection), so reload
     * refreshes the durable guidance snapshot through the Agent service.
     */
    reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary>;
    private refreshPluginSessionStarts;
    /**
     * The base-class contract merges the patch into the session's `custom` map
     * (v1 routes through the live session and 404s on a closed one; mirrored
     * here by {@link requireLiveSession}).
     */
    updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void>;
    /**
     * Through the session's handler (`IWorkspaceDirs`, workspace scope) — the
     * workspace-level add-dir surface: `persist: true` (default) appends to the
     * project-local `.kimi-code/local.toml`, `persist: false` joins the
     * handler's shared in-memory set. The set is shared by every session of
     * the workspace (a v1 `persist: false` dir was session-scoped and written
     * into session metadata to survive a resume; the v2 handler keeps it for
     * every session of the workspace until the process exits). Returns the
     * same `{additionalDirs, projectRoot, configPath, persisted}` shape as v1.
     */
    addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult>;
    /**
     * Through `engineAccessor` (`ISessionExportService`, app scope) — the v2
     * port of v1's export: same payload fields, same zip writer layout, same
     * live-session flush before the read, and the same
     * `SESSION_EXPORT_NOT_FOUND` for a session without an exportable directory.
     * Works on closed sessions on both engines (v1 reads the store, v2 the
     * index). Gaps, pinned in the migration tracker: v2 additionally validates
     * the host `version` (`SESSION_EXPORT_MISSING_VERSION` on blank — v1
     * records it unchecked), the manifest's activity timestamps come from v2's
     * per-agent wire scan (v1 scans only the root `wire.jsonl`), and the
     * manifest carries v2's extra `webLogPath` field (absent unless the host
     * passes a web log, which this client never does). The zip ENTRY LIST is
     * not part of the parity surface: the two engines lay their session
     * directories out differently by design.
     */
    exportSession(input: ExportSessionInput): Promise<ExportSessionResult>;
    /**
     * Through the session scope (`ISessionSkillCatalog`) — no klient facade
     * exists. Same merged view v1's `Session.listSkills` serves (builtin +
     * user + project + plugin skills through the same `summarizeSkill`
     * mapping), with the same snapshot-vs-live caveat as `listPluginCommands`:
     * v1 loads the registry once at session creation while the v2 catalog
     * re-merges on source changes mid-session; the two agree for any session
     * created after the last skill change.
     */
    listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]>;
    /**
     * The session's materialized main agent with v1's eager default binding
     * applied: a freshly created agent whose profile is still unbound gets the
     * default profile + configured default model (the same bind kap-server's
     * prompt route performs on first use). A home with no configured model
     * leaves the agent unbound instead of failing — v1's model-less session
     * reads (`model: undefined`, `'off'` thinking, zero capabilities) map onto
     * the unbound state exactly.
     */
    private materializeMainAgent;
    /** The target agent's live scope handle (see the section header). */
    private agentScope;
    /**
     * The klient agent facade for the target agent. The scope is resolved
     * first so the main agent exists and carries its default binding before
     * the facade call crosses the channel (the channel's own materialization
     * leaves the profile unbound).
     */
    private agentFacade;
    /**
     * Facade (`agentProfileService.setModel`). Both engines resolve the alias
     * up front, report the resolved provider name, and reject an unknown alias
     * with `config.invalid` (only the trailing message wording differs).
     */
    setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult>;
    /**
     * Through the agent scope (`IAgentProfileService.setThinking`) — no klient
     * facade exists. Same registry-driven strictness as v1's
     * `setThinkingEffort`: an unlisted effort on a strict-thinking model
     * rejects with `model.config_invalid` and the same message on both
     * engines; anything else normalizes through the same resolution.
     */
    setThinking(input: SetSessionThinkingRpcInput): Promise<void>;
    setPermission(input: SetSessionPermissionRpcInput): Promise<void>;
    /** v1 maps the toggle onto two RPCs (`enterPlan` / `cancelPlan`); so does v2. */
    setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void>;
    getPlan(input: SessionIdRpcInput): Promise<SessionPlan>;
    clearPlan(input: SessionIdRpcInput): Promise<void>;
    /** Facade (`agentCommandService.list`) — the v2-only contributed-command seam. */
    listCommands(input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]>;
    /** Facade (`agentCommandService.run`) — runs the contribution engine-side. */
    runCommand(input: RunCommandRpcInput): Promise<void>;
    getRuntime(input: SessionIdRpcInput): Promise<AgentRuntimeBinding>;
    switchRuntime(input: SwitchSessionRuntimeRpcInput): Promise<AgentRuntimeBinding>;
    /**
     * Facade (`getContext`, merged client-side from `agentContextMemoryService.get`
     * and `agentTokenCountingService.statusSize`). The v2 `AgentContextData` is the
     * same wire shape as v1's — the cast only bridges the two packages' type
     * declarations (v2's origin union carries kinds a v1 client never sees in
     * practice); the data itself crossed the same JSON boundary on both sides.
     * Token-count semantics differ by design: v1 reports the running estimate,
     * v2 the provider-measured prefix (`0` until the first LLM round) — pinned
     * in the parity KNOWN_DIFFS.
     */
    getContext(input: SessionIdRpcInput): Promise<AgentContextData>;
    getUsage(input: SessionIdRpcInput): Promise<SessionUsage>;
    /**
     * The base class aggregates v1's per-agent `getConfig` / `getContext` /
     * `getPermission` / `getPlan` / `getSwarmMode` / `getUsage` RPCs. The v2
     * rebuild reads the same six slices: the profile's bound model alias and
     * resolved thinking level + capabilities (v1's agent `getConfig` — its
     * `provider?.model` fallback is unreachable without an alias), the
     * facade's context/plan/usage, and the permission-mode and swarm services.
     */
    getStatus(input: SessionIdRpcInput): Promise<SessionStatus>;
    /**
     * Facade (`agentLoopService.cancelFromUser`) plus the session-level init
     * run: v1's cancel cascades from the agent's turn to every foreground
     * subagent run of the session, and /init is the one session-level run v2
     * keeps off the agent turn lane — its abort controller lives in
     * `ISessionInitService` (a silent no-op when no init is running).
     */
    cancel(input: SessionIdRpcInput): Promise<void>;
    /**
     * Through the agent scope (`IAgentFullCompactionService.begin`) — no klient
     * facade exists. Same semantics as v1's `beginCompaction`: a manual
     * compaction launches the summarizer immediately in the background, is a
     * silent no-op while one is already running, and rejects with
     * `compaction.unable` on an empty history or an active turn.
     */
    compact(input: SessionIdRpcInput & CompactOptions): Promise<void>;
    /**
     * Through the agent scope (`IAgentFullCompactionService.cancel`) — no
     * klient facade exists. Aborts the in-flight compaction; a no-op when idle,
     * like v1.
     */
    cancelCompaction(input: SessionIdRpcInput): Promise<void>;
    /**
     * Through the agent scope (`IAgentConversationUndoService.undo`) — no
     * klient facade exists; the returned count is
     * dropped (v1 returns void). Failure semantics differ by design: v2
     * prechecks and rejects atomically with `session.undo_unavailable`, while
     * v1 splices a partial suffix out of the live history and then throws
     * `request.invalid` — pinned in the parity KNOWN_DIFFS.
     */
    getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]>;
    undoHistory(input: SessionIdRpcInput & {
        count: number;
    }): Promise<void>;
    /**
     * Through the agent scope (`IAgentContextMemoryService.clear`) — no klient
     * facade exists. v1's `context.clear` has no busy check and does not touch
     * queued or running prompts; the memory-service clear matches that exactly
     * (the prompt service's own `clear` would additionally abort prompts).
     */
    clearContext(input: SessionIdRpcInput): Promise<void>;
    /**
     * No v2 engine capability exists for import-context (nothing under
     * agent-core-v2 builds this message), so the SDK composes v1's exact
     * behavior over v2 primitives: the same busy rejection
     * (`turn.agent_busy`), the byte-identical import message and validations
     * (`src/v2/import-context.ts`), the same overflow gate, then the same wire
     * `context.append_message` Op v1 persists. Known gap: v1 also adopts the
     * post-import estimate as its reported token count, while v2's reported
     * count is provider-measured and has no public setter — post-import
     * `getContext().tokenCount` diverges (pinned in the parity KNOWN_DIFFS).
     */
    importContext(input: ImportContextRpcInput): Promise<void>;
    /**
     * Facade (`agentPromptService.submit`). The launch result (`{turn_id}`, or
     * `undefined` when the prompt queued behind a running turn) is dropped —
     * v1's RPC returns void. The pre-provider surface matches v1: the metadata
     * update (title/lastPrompt) runs through the same shared helpers before the
     * turn launches, and a model-less turn fails asynchronously exactly like
     * v1's. One enqueue-semantics gap vs v1, pinned in the migration tracker:
     * v1 drops a prompt submitted while a turn is active (error event only)
     * where v2 queues it FIFO.
     */
    prompt(input: SessionPromptRpcInput): Promise<void>;
    /**
     * Facade (`agentSkillService.promptWithSkills`) — bundled skill submission:
     * the engine renders every skill activation into the prompt's own user
     * message, so the bundle launches as one turn and undoes as a single
     * anchor. v2-only: the base class rejects this method on the v1 engine.
     * The launch result is dropped like `prompt` (v1's RPC shape returns void).
     */
    promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void>;
    /**
     * Facade (`agentPromptService.submitSteer`). Matches v1 on both paths: mid-turn
     * steers join the running turn, and an idle-session steer degrades to
     * launching a fresh turn (the enqueue launches it directly) while
     * title/lastPrompt are updated like a prompt's.
     */
    steer(input: SessionPromptRpcInput): Promise<void>;
    /**
     * Facade (`agentShellCommandService.run`) — the same builtin-Bash execution
     * and `shell_command`-origin history records as v1, with an identical
     * `{stdout, stderr, isError?, backgrounded?}` result shape. The `commandId`
     * event stream (`shell.output` / `shell.started` / `shell.completed`) is
     * engine-side on both; translating it into SDK events is the event batch's
     * job, not this one's. Model-less gap, not pinned: v1's builtin tools only
     * exist on a profiled agent, so a model-less v1 session answers "Bash tool
     * is not available." where v2 runs the command.
     */
    runShellCommand(input: {
        sessionId: string;
        command: string;
        commandId?: string;
    }): Promise<{
        stdout: string;
        stderr: string;
        isError?: boolean;
        backgrounded?: boolean;
    }>;
    /** Facade (`agentShellCommandService.cancel`) — an unknown id is a silent no-op on both engines. */
    cancelShellCommand(input: {
        sessionId: string;
        commandId: string;
    }): Promise<void>;
    /**
     * Through the target agent's `IAgentSkillService` — the direct call
     * keeps v1's semantics: validate first (`skill.not_found` /
     * `skill.type_unsupported` reject synchronously), then render the skill
     * prompt and launch a turn with it. The engine updates title/lastPrompt for
     * the MAIN agent only, matching v1's session layer. Busy-turn behavior now
     * matches v1 too: the activation steers into the running turn at the next
     * step boundary (v1's `SkillManager.recordActivation` steer; v2 queues a
     * fresh prompt turn only when idle).
     */
    activateSkill(input: ActivateSkillRpcInput): Promise<void>;
    /**
     * Through the agent scope (`IAgentPluginCommandService.activate`): the same
     * `request.invalid` rejection text for an unknown command, the same
     * argument expansion, the activation event, the prompt enqueue, and the
     * main-agent-only metadata update. Two gaps vs v1,
     * pinned in the migration tracker: v1 resolves the command against the
     * session's creation-time snapshot (v2 uses the app-global live view), and
     * v1 drops the activation while a turn runs where v2 queues it.
     */
    activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void>;
    /**
     * Through the session scope (`ISessionInitService.generateAgentsMd`, the
     * engine's port of v1's `Session.generateAgentsMd`) — a session-level
     * operation pinned to the main agent on both engines, so
     * `interactiveAgentId` does not apply; the main agent is materialized first
     * (v1 creates it eagerly at createSession). The success path is a real
     * subagent LLM round (`/init` brief), so parity covers only the model-less
     * rejection: both engines fail with `session.init_failed`, with different
     * messages (v1 wraps the provider-resolution failure, v2 preflights the
     * missing binding) — pinned in the parity tests.
     */
    generateAgentsMd(input: SessionIdRpcInput): Promise<void>;
    /**
     * No v2 service implements the session-warnings aggregate, so the SDK rebuilds v1's
     * `Session.getSessionWarnings` over v2 primitives: the profile's cached
     * `agentsMdWarning` (computed on every bind, v1's bootstrap-time cache),
     * recomputed through the engine's own `prepareSystemPromptContext` when the
     * cache is empty — v1 recomputes on demand whenever no warning is cached,
     * so an AGENTS.md that outgrows the budget mid-session surfaces on both
     * engines. The single warning shape (`agents-md-oversized`, severity
     * `warning`) mirrors v1's assembly.
     */
    getSessionWarnings(input: SessionIdRpcInput): Promise<{
        code: string;
        message: string;
        severity: "warning";
    }[]>;
    /**
     * Through the session scope (`ISessionBtwService`) — no klient facade
     * exists. The v2 service is the port of v1's btw fork: same inherited
     * profile/context, same byte-identical side-question reminder, same
     * tool-call deny, and the same return (the forked child's agent id). The
     * main agent is materialized first — both engines fork it as the source,
     * and v2's `fork('main')` throws on a missing source. Gaps, pinned in the
     * migration tracker: v2 always forks MAIN where v1 forks the agent
     * `interactiveAgentId` addresses (SDK hosts only ever btw the main agent),
     * and the v2 child is a regular persisted agent where v1's is memory-only
     * (`InMemoryAgentRecordPersistence`, no metadata).
     */
    startBtw(input: SessionIdRpcInput): Promise<string>;
    /**
     * Through the agent scope (`IAgentSwarmService.enter` / `.exit`) — no
     * klient facade exists. The v2 service is the port of v1's `SwarmMode`:
     * enter is idempotent and injects the byte-identical enter reminder for
     * non-`tool` triggers, exit pops that reminder when it is the last message
     * (appending the exit reminder otherwise), and `task` / `tool` triggers
     * auto-exit on turn end. The base class's private enter/exit pair is
     * replaced wholesale; `swarm()` below recomposes it over this override.
     */
    setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void>;
    /** v1's `swarm()` composition: enter with the one-shot `task` trigger, then prompt. */
    swarm(input: SessionPromptRpcInput): Promise<void>;
    /** Through the agent scope (`IAgentTowerService.enter` / `.exit`) — no klient facade exists. */
    setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void>;
    /**
     * Through the target agent scope's `IAgentGoalService` — no klient
     * facade exists for the goal domain. Gap: v2 rejects every goal command on
     * a non-main agent (`goal.unsupported_agent`) where v1 keeps a `GoalMode`
     * on every agent; only reachable through a non-main `interactiveAgentId`
     * (tracked in the migration tracker).
     */
    createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot>;
    getGoal(input: SessionIdRpcInput): Promise<GoalToolResult>;
    pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot>;
    /**
     * Through the main agent's `IAgentCronService` — no klient facade
     * exists for cron. v1's cron manager is per-agent: the main agent's
     * manager is what the v2 cron service ports (it borrows the main
     * agent to steer fires), and a v1 subagent reports `[]` (`cron` is null) —
     * mirrored here for a non-main `interactiveAgentId`. The v1 snapshot shape
     * is restored field-by-field: `recurring` defaults to true, and the
     * post-jitter `nextFireAt` comes from the same scheduler read v1's
     * `listTaskSnapshots` forwards to.
     */
    getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult>;
    /**
     * Facade (`agentTaskService.list`). The v2 `AgentTaskInfo` union is the
     * same wire shape as v1's `BackgroundTaskInfo` — the process / agent /
     * question kinds are field-identical ports — so the cast only bridges the
     * two packages' type declarations. One content gap, pinned in the parity
     * KNOWN_DIFFS: after a detach, v2 rewrites the reported `timeoutMs` to the
     * detach deadline where v1 keeps the foreground one.
     */
    listBackgroundTasks(input: SessionIdRpcInput & {
        activeOnly?: boolean;
        limit?: number;
    }): Promise<readonly BackgroundTaskInfo[]>;
    /**
     * Facade (`agentTaskService.readOutput`) — same unknown-id-returns-`''`
     * behavior and the same trailing-characters `tail` semantics as v1.
     */
    getBackgroundTaskOutput(input: SessionIdRpcInput & {
        taskId: string;
        tail?: number;
    }): Promise<string>;
    /**
     * Through the agent scope (`IAgentTaskService.stop`) — deliberately NOT the
     * facade's `stopTask`, whose no-reason path routes to `stopByUser` and
     * stamps a user-cancellation `stopReason` where v1's
     * `background.stop(taskId, reason)` records none. The direct call matches
     * v1 in both shapes (reason trimmed, blank → undefined). Timing gap: v1
     * fire-and-forgets the stop so its RPC returns before the kill settles;
     * the v2 service awaits the termination — a strictly stronger guarantee.
     */
    stopBackgroundTask(input: SessionIdRpcInput & {
        taskId: string;
        reason?: string;
    }): Promise<void>;
    /**
     * Through the agent scope (`IAgentTaskService.detach`) — no klient facade
     * exists. Same semantics as v1's `background.detach`: releases the
     * foreground tool-call waiter, returns the live info (or the ghost / live
     * info for an already-terminal task, `undefined` for an unknown id).
     */
    detachBackgroundTask(input: SessionIdRpcInput & {
        taskId: string;
    }): Promise<BackgroundTaskInfo | undefined>;
    /**
     * v1's `Session.waitForBackgroundTasksOnPrint`, rebuilt over v2 primitives
     * — no v2 service owns the print policy (the native v2 print runner
     * re-implements the same drain inline in run-v2-print). Same gate (drain
     * mode only), same ceiling, same suppress + wait + re-enumerate loop over
     * every live agent's task service. Config timing note: v1 reads the
     * `background` section captured at session creation; v2 resolves the live
     * config (the `[task]` section layered over `[background]`) — identical
     * unless the config changes mid-session.
     */
    waitForBackgroundTasksOnPrint(input: SessionIdRpcInput): Promise<void>;
    /**
     * v1's `Session.handlePrintMainTurnCompleted`, rebuilt over the same v2
     * primitives: `'exit'` finishes immediately, `'drain'` drains then
     * finishes, and `'steer'` keeps the run alive while background tasks are
     * pending, bounded by the wall-clock ceiling (`print_wait_ceiling_s`) and
     * the turn cap (`print_max_turns`). The steer deadline/turn counters are
     * per-session SDK state ({@link printSteerStates}), mirroring v1's
     * Session-object fields.
     */
    handlePrintMainTurnCompleted(input: SessionIdRpcInput): Promise<'finish' | 'continue'>;
    /**
     * The shared drain pass of the two print-policy overrides, ported from
     * v1's `waitForBackgroundTasksOnPrint` (the native v2 print runner carries
     * the same loop): re-enumerate active tasks across every live agent until
     * none remain or the ceiling expires — a subagent may fan out new tasks
     * mid-drain — with terminal notifications suppressed up front so a
     * completing task cannot steer a finished main turn.
     */
    private drainBackgroundTasksOnPrint;
    /** v1's `countActiveBackgroundTasks`: active tasks across every live agent. */
    private countActiveBackgroundTasks;
    /**
     * The engine's management plane throws `Error2`; the SDK's public error
     * contract is `KimiError` (what `isKimiError` branches on, and what the v1
     * client throws for the same failures). Restate so both engines surface
     * the identical class — see `restateEngineError`.
     */
    private mcpManagement;
    listGlobalMcpServers(options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    getGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<McpManagedServerInfo>;
    listGlobalMcpServerAuthStatuses(options?: {
        readonly cwd?: string;
        readonly verify?: boolean;
    }): Promise<readonly GlobalMcpServerAuthStatus[]>;
    inspectAppMcpServers(targets?: readonly McpServerLocator[], options?: {
        readonly cwd?: string;
    }): Promise<readonly AppMcpServerInspection[]>;
    addGlobalMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    updateGlobalMcpServer(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    removeGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<readonly McpManagedServerInfo[]>;
    /**
     * The legacy name-only entry point resolves its locator first: exactly one
     * enabled entry may own the runtime name, so a global/plugin collision
     * rejects instead of guessing which credential the flow acts on.
     */
    beginGlobalMcpServerAuth(name: string, options?: {
        readonly cwd?: string;
    }): Promise<BeginGlobalMcpServerAuthResult>;
    beginMcpServerAuth(locator: McpServerLocator, options?: {
        readonly cwd?: string;
    }): Promise<BeginGlobalMcpServerAuthResult>;
    completeGlobalMcpServerAuth(input: {
        readonly flowId: string;
        readonly timeoutMs?: number;
    }, signal?: AbortSignal): Promise<void>;
    completeMcpServerAuth(input: {
        readonly flowId: string;
        readonly timeoutMs?: number;
    }, signal?: AbortSignal): Promise<void>;
    cancelGlobalMcpServerAuth(flowId: string): Promise<void>;
    cancelMcpServerAuth(flowId: string): Promise<void>;
    resetGlobalMcpServerAuth(name: string, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    resetMcpServerAuth(locator: McpServerLocator, options?: {
        readonly cwd?: string;
    }): Promise<void>;
    testGlobalMcpServer(name: string, options?: {
        readonly cwd?: string;
    }): Promise<McpTestResult>;
    /**
     * The inline-config channel of v1's `testGlobalMcpServer`: the same
     * schema-validated, unsaved probe — nothing has to be persisted first.
     */
    testGlobalMcpServerConfig(server: McpServerConfig, options?: {
        readonly cwd?: string;
    }): Promise<McpTestResult>;
    /**
     * Through the session scope (the seeded `ISessionMcpHandle.connectionManager`
     * — the workspace handler's one shared manager). This is a live snapshot:
     * create/resume no longer waits for MCP startup, so entries may still be
     * pending. The v2 `McpServerEntry` is field-identical with v1's
     * `McpServerInfo` (the cast bridges the two packages' type declarations).
     */
    listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]>;
    /**
     * Workspace-level MCP view (the handler's one shared connection set), so
     * `/mcp` is inspectable on a v2 session-less startup before any session
     * exists. Awaits `ready` so a fresh handler's initial connect settles
     * before the list is read.
     * Same `McpServerEntry`-as-`McpServerInfo` cast as listMcpServers.
     */
    listWorkspaceMcpServers(workDir: string): Promise<readonly McpServerInfo[]>;
    getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics>;
    /**
     * Same direct `reconnect` as v1's session RPC — the v2 manager raises the
     * same `mcp.server_not_found` / `mcp.server_disabled` errors, and the tool
     * re-registration rides on the status listeners in both engines. The
     * "name + full config" channel rides the manager's upserting `connect`
     * (validated exactly like v1's session RPC), which only exists on a plain
     * manager — a session created with ephemeral MCP servers holds a merged
     * view instead and rejects loudly.
     */
    reconnectMcpServer(input: ReconnectMcpServerRpcInput): Promise<void>;
    /**
     * v1's `addSessionMcpServer` over the session scope's connection manager:
     * validate, optionally persist to the user-level file, then upsert through
     * `connect`. Two accepted gaps against v1: the v2 entry carries no
     * `source`/`config` tags (the manager does not track origins), and the one
     * shared manager per workspace handler makes an unpersisted add visible to
     * sibling sessions of the same workspace. The same merged-view limitation
     * as {@link reconnectMcpServer} applies.
     */
    addSessionMcpServer(input: {
        readonly sessionId: string;
        readonly server: McpServerConfig;
        readonly persist?: boolean;
    }): Promise<McpServerInfo>;
}

export declare interface SDKRpcClientV2Options {
    readonly homeDir?: string;
    readonly configPath?: string;
    readonly identity?: KimiHostIdentity;
    /**
     * Explicit skill directories for this process (v1's SDK `skillDirs` /
     * the CLI's `--skills-dir`): when non-empty, default user / project skill
     * discovery is skipped and these directories serve as the user skill
     * source. Passed into the engine through `BootstrapInput.args.skillDirs`.
     */
    readonly skillDirs?: readonly string[];
    readonly telemetry?: TelemetryClient;
    readonly onOAuthRefresh?: (outcome: OAuthRefreshOutcome) => void;
    readonly uiMode?: string;
    /** UI surfaces this host renders; forwarded as `BootstrapInput.args.uiCapabilities`. */
    readonly uiCapabilities?: readonly HostUiCapability[];
    /** ZP-5/ZP-6（中软 fork）：透传到 bootstrap 的额外 DI 种子（见 types.ts KimiHarnessOptions）。 */
    readonly extraSeeds?: ScopeSeed;
}

export declare const SECONDARY_DERIVED_MODEL_ALIAS = "__secondary__";

declare interface SerializedEvent2 {
    readonly type: string;
    readonly time: number;
    readonly [key: string]: unknown;
}

declare interface ServiceIdentifier<T> {
    (target: any, key: string | symbol | undefined, index: number): void;
    readonly type: T;
    toString(): string;
}

declare interface ServicesAccessor {
    get<T>(id: ServiceIdentifier<T>): T;
}

export declare type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

declare const ServicesConfigSchema: z.ZodObject<{
    moonshotSearch: z.ZodOptional<z.ZodObject<{
        baseUrl: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        oauth: z.ZodOptional<z.ZodObject<{
            storage: z.ZodEnum<{
                file: "file";
                keyring: "keyring";
            }>;
            key: z.ZodString;
            oauthHost: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
    moonshotFetch: z.ZodOptional<z.ZodObject<{
        baseUrl: z.ZodOptional<z.ZodString>;
        apiKey: z.ZodOptional<z.ZodString>;
        oauth: z.ZodOptional<z.ZodObject<{
            storage: z.ZodEnum<{
                file: "file";
                keyring: "keyring";
            }>;
            key: z.ZodString;
            oauthHost: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>;
        customHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
}, z.core.$strip>;

export declare class Session {
    readonly id: string;
    readonly workDir: string;
    summary?: SessionSummary | undefined;
    private resumeState;
    private readonly rpc;
    private readonly onClose?;
    private closed;
    constructor(options: SessionOptions);
    /** True once {@link close} began — the session may still be closing in the engine. */
    get isClosed(): boolean;
    getResumeState(): ResumedSessionState | undefined;
    reloadSession(options?: ReloadSessionOptions): Promise<ResumedSessionSummary>;
    onEvent(listener: (event: Event_2) => void): Unsubscribe;
    setApprovalHandler(handler: ApprovalHandler | undefined): void;
    setQuestionHandler(handler: QuestionHandler | undefined): void;
    prompt(input: string | PromptInput, options?: {
        promptId?: string;
    }): Promise<void>;
    /**
     * Submit one prompt with one or more skill activations bundled into the
     * same user message: the skills are validated up front (an unknown name
     * rejects the whole submission), rendered ahead of the prompt in the same
     * turn, and the bundle undoes as a single anchor. Requires the
     * agent-core-v2 engine.
     */
    promptWithSkills(input: string | PromptInput, skills: readonly PromptSkillActivation[]): Promise<void>;
    /** Execute a user-initiated `!` shell command (silent — does not prompt the
     *  model). Resolves with the command's stdout/stderr for immediate display.
     *  Pass `commandId` to receive live `shell.output` events for this command. */
    runShellCommand(command: string, options?: {
        commandId?: string;
    }): Promise<{
        stdout: string;
        stderr: string;
        isError?: boolean;
        backgrounded?: boolean;
    }>;
    /** Cancel a running `!` shell command by its commandId (e.g. on Esc / Ctrl+C). */
    cancelShellCommand(commandId: string): Promise<void>;
    steer(input: string | PromptInput): Promise<void>;
    swarm(input: string | PromptInput): Promise<void>;
    init(): Promise<void>;
    getSessionWarnings(): Promise<readonly SessionWarningInfo[]>;
    addAdditionalDir(path: string, options?: AddAdditionalDirOptions): Promise<AddAdditionalDirResult>;
    startBtw(): Promise<string>;
    cancel(): Promise<void>;
    setModel(model: string): Promise<void>;
    getRuntime(): Promise<AgentRuntimeBinding>;
    switchRuntime(runtimeId: string): Promise<AgentRuntimeBinding>;
    setThinking(effort: ThinkingEffort): Promise<void>;
    setPermission(mode: PermissionMode): Promise<void>;
    /** Shallow-merge host-owned fields into this session's persisted custom metadata. */
    updateMetadata(patch: JsonObject): Promise<void>;
    setPlanMode(enabled: boolean): Promise<void>;
    setSwarmMode(enabled: boolean, trigger: SwarmModeTrigger): Promise<void>;
    setTowerMode(enabled: boolean, base?: string): Promise<void>;
    getPlan(): Promise<SessionPlan>;
    clearPlan(): Promise<void>;
    compact(options?: CompactOptions): Promise<void>;
    cancelCompaction(): Promise<void>;
    undoHistory(count?: number): Promise<void>;
    getTodos(): Promise<readonly SessionTodoItem[]>;
    /** Clear this session's model context without creating a new session. */
    clearContext(): Promise<void>;
    /** Append imported text to this session's context without prompting the model. */
    importContext(content: string, source: string): Promise<void>;
    getContext(): Promise<AgentContextData>;
    getUsage(): Promise<SessionUsage>;
    getStatus(): Promise<SessionStatus>;
    listSkills(): Promise<readonly SkillSummary[]>;
    listPluginCommands(): Promise<readonly PluginCommandDef[]>;
    /**
     * Contributed commands registered with this session's interactive agent
     * (agent-core-v2 only — a v1-backed session reports the empty set).
     */
    listCommands(): Promise<readonly AgentCommandInfo[]>;
    /**
     * List background tasks for this session's interactive agent.
     *
     * Defaults to all tasks (including terminal/lost). Pass
     * `{ activeOnly: true }` to filter to non-terminal entries.
     */
    listBackgroundTasks(options?: {
        activeOnly?: boolean;
        limit?: number;
    }): Promise<readonly BackgroundTaskInfo[]>;
    /**
     * Read a background task's captured output. Returns the in-memory
     * ring buffer if available, otherwise falls back to the persisted
     * `<sessionDir>/tasks/<taskId>/output.log`. `tail` caps the returned
     * string to that many trailing characters.
     */
    getBackgroundTaskOutput(taskId: string, options?: {
        tail?: number;
    }): Promise<string>;
    /**
     * Request a running background task to stop. Sends SIGTERM with a
     * grace period (handled by the core BPM); subscribers receive a
     * `background.task.terminated` event when the kill settles. Calls
     * for unknown or already-terminal task ids are no-ops at the core
     * level — this method does not throw in those cases.
     */
    stopBackgroundTask(taskId: string, options?: {
        reason?: string;
    }): Promise<void>;
    /**
     * Detach a running foreground task so the current tool call can return while
     * the task continues under background-task management.
     */
    detachBackgroundTask(taskId: string): Promise<BackgroundTaskInfo | undefined>;
    /**
     * Block until every still-running background task (across all agents in this
     * session) reaches a terminal state. Used by `kimi -p` after the main agent's
     * turn finishes when the resolved print background mode is `'drain'`
     * (`print_background_mode = "drain"`, or the legacy `keep_alive_on_exit = true`
     * fallback), so background subagents get a chance to complete before the process
     * exits. No-op in other modes. Bounded by `background.print_wait_ceiling_s`.
     */
    waitForBackgroundTasksOnPrint(): Promise<void>;
    /**
     * Used by `kimi -p` after the main agent's turn ends with `reason ===
     * 'completed'`. Returns `'finish'` when the run may exit, or `'continue'` when
     * the caller must keep the session alive so a background-task completion can
     * steer the main agent into a new turn. Policy is selected by
     * `background.print_background_mode` (`'exit' | 'drain' | 'steer'`); when unset
     * it falls back to the legacy `keep_alive_on_exit` mapping (`true ⇒ 'drain'`).
     */
    handlePrintMainTurnCompleted(): Promise<'finish' | 'continue'>;
    createGoal(input: CreateGoalInput): Promise<GoalSnapshot>;
    getGoal(): Promise<GoalToolResult>;
    pauseGoal(): Promise<GoalSnapshot>;
    resumeGoal(): Promise<GoalSnapshot>;
    cancelGoal(): Promise<GoalSnapshot>;
    /**
     * Enumerate the cron tasks scheduled in this session. Hosts running a
     * bounded session lifetime (e.g. `kimi -p`) poll this to decide whether
     * pending scheduled work still needs the process alive.
     */
    getCronTasks(): Promise<GetCronTasksResult>;
    listMcpServers(): Promise<readonly McpServerInfo[]>;
    getMcpStartupMetrics(): Promise<McpStartupMetrics>;
    /**
     * Connect an MCP server in this live session. `persist: true` also writes
     * the user-level `mcp.json` (the entry becomes a mutable `global` one);
     * otherwise it stays a session-local `caller` entry.
     */
    addMcpServer(server: McpServerConfig, options?: {
        readonly persist?: boolean;
    }): Promise<McpServerInfo>;
    /**
     * Reconnect a server. Without `config` the session re-resolves the current
     * effective config from the unified registry (file edits and plugin
     * enable/disable land here). With `config`, the entry is replaced with the
     * given full config — a plugin-contributed server rejects this because its
     * config is read-only, owned by the plugin manifest.
     */
    reconnectMcpServer(name: string, config?: McpServerConfig): Promise<void>;
    listPlugins(): Promise<readonly PluginSummary[]>;
    installPlugin(source: string): Promise<PluginSummary>;
    setPluginEnabled(id: string, enabled: boolean): Promise<void>;
    /** Built-in capabilities with layered readiness (v2 engine only). */
    listCapabilities(): Promise<readonly CapabilityStatus[]>;
    /** One capability's layered readiness + live install progress. */
    getCapability(id: string): Promise<CapabilityStatus>;
    /**
     * Start an idempotent capability install (binary runtime + wiring) in the
     * background; poll `getCapability` for progress.
     */
    installCapability(id: string): Promise<CapabilityStatus>;
    setPluginMcpServerEnabled(id: string, server: string, enabled: boolean): Promise<void>;
    removePlugin(id: string): Promise<void>;
    reloadPlugins(): Promise<ReloadSummary>;
    getPluginInfo(id: string): Promise<PluginInfo>;
    activateSkill(name: string, args?: string | undefined): Promise<void>;
    activatePluginCommand(pluginId: string, commandName: string, args?: string | undefined): Promise<void>;
    /**
     * Run a contributed command engine-side (agent-core-v2 only — a v1-backed
     * client rejects with `not_implemented`). Unknown names reject with the
     * engine's `request.invalid` error.
     */
    runCommand(name: string, args?: string): Promise<void>;
    close(): Promise<void>;
    /** @internal */
    emitMetaUpdated(patch: {
        readonly title?: string;
        readonly isCustomTitle?: boolean;
    }): void;
    private emit;
    private ensureOpen;
    private requireSummary;
}

declare interface Session_2 {
    id: string;
    workspace_id: string;
    title: string;
    created_at: string;
    updated_at: string;
    busy: boolean;
    main_turn_active?: boolean;
    pending_interaction?: SessionPendingInteraction;
    last_turn_reason?: SessionTurnOutcome;
    archived?: boolean;
    archived_at?: string;
    current_prompt_id?: string;
    last_prompt?: string;
    metadata: SessionMetadata;
    agent_config: SessionAgentConfig;
    usage: SessionUsage_2;
    permission_rules: PermissionRule_2[];
    message_count: number;
    last_seq: number;
}

declare type SessionAgentConfig = z.infer<typeof sessionAgentConfigSchema>;

declare const sessionAgentConfigSchema: z.ZodObject<{
    model: z.ZodString;
    system_prompt: z.ZodOptional<z.ZodString>;
    tools: z.ZodOptional<z.ZodArray<z.ZodString>>;
    mcp_servers: z.ZodOptional<z.ZodArray<z.ZodString>>;
    thinking: z.ZodOptional<z.ZodString>;
    permission_mode: z.ZodOptional<z.ZodEnum<{
        manual: "manual";
        yolo: "yolo";
        auto: "auto";
    }>>;
    plan_mode: z.ZodOptional<z.ZodBoolean>;
    swarm_mode: z.ZodOptional<z.ZodBoolean>;
    tower_mode: z.ZodOptional<z.ZodBoolean>;
    tower_base: z.ZodOptional<z.ZodString>;
    goal_objective: z.ZodOptional<z.ZodString>;
    goal_control: z.ZodOptional<z.ZodEnum<{
        cancel: "cancel";
        pause: "pause";
        resume: "resume";
    }>>;
}, z.core.$strip>;

declare interface SessionApprovalsFacade {
    list(): Promise<readonly ApprovalRequest_2[]>;
    decide(id: string, response: ApprovalResponse): Promise<void>;
}

/** Payload of `event.session.archived` on the global bus. */
declare interface SessionArchivedPayload {
    readonly sessionId: string;
}

declare interface SessionCreatedEvent {
    readonly type: 'event.session.created';
    readonly session: Session_2;
}

/** Public event name → payload type. Keys must stay in sync with `sessionEvents`. */
declare interface SessionEventPayloads {
    'metadata.changed': SessionMetadataChangedEvent;
    'interactions.changed': readonly Interaction[];
    'interactions.resolved': InteractionResolution;
    /** The merged skill catalog changed; the payload is the changed source id. */
    'skills.changed': string;
}

declare interface SessionFacade {
    get(): Promise<SessionMeta_2>;
    setTitle(title: string): Promise<void>;
    /**
     * Generate and apply a title from the main agent's first prompts via the
     * managed `chat_title` tool. `undefined` when generation is unavailable
     * (no managed OAuth login, no prompt yet, or a custom title is set).
     * `force` regenerates anyway, overwriting a generated or custom title.
     * `source` picks the conversation excerpt: `user_prompts` (default),
     * `first_turn` (opening prompt + first reply; strict), or `digest`
     * (head+tail of a multi-turn conversation).
     */
    generateTitle(opts?: {
        force?: boolean;
        source?: 'user_prompts' | 'first_turn' | 'digest';
    }): Promise<string | undefined>;
    update(patch: SessionMetaPatch): Promise<void>;
    setArchived(archived: boolean): Promise<void>;
    status(): Promise<SessionStatus_2>;
    close(): Promise<void>;
    archive(): Promise<void>;
    /** Re-materialize a closed session; `false` when it no longer exists. */
    restore(opts?: SessionRestoreOptions): Promise<boolean>;
    /** Permanently delete the session and its persisted data; throws when missing. */
    delete(): Promise<void>;
    fork(input?: {
        title?: string;
        metadata?: Record<string, unknown>;
    }): Promise<SessionMeta_2>;
    createChild(input?: {
        title?: string;
        metadata?: Record<string, unknown>;
    }): Promise<SessionMeta_2>;
    readonly approvals: SessionApprovalsFacade;
    readonly questions: SessionQuestionsFacade;
    readonly interactions: SessionInteractionsFacade;
    readonly skills: SessionSkillsFacade;
    /** Agent id → metadata for every agent registered in this session. */
    agents(): Promise<Readonly<Record<string, AgentMeta_2>>>;
}

declare interface SessionHandle extends SessionFacade {
    readonly events: KlientEvents<SessionEventPayloads>;
    agent(agentId: string): AgentHandle;
}

declare interface SessionIdRpcInput {
    readonly sessionId: string;
}

declare interface SessionInteractionsFacade {
    list(kind?: InteractionKind): Promise<readonly Interaction[]>;
    respond(id: string, response: unknown): Promise<void>;
}

declare interface SessionListQuery {
    readonly workspaceIds?: readonly string[];
    readonly sessionId?: string;
    readonly includeArchived?: boolean;
    readonly limit?: number;
    readonly childOf?: string;
    readonly before?: string;
    readonly after?: string;
}

export declare function sessionMediaOriginalsDir(sessionDir: string): string;

declare interface SessionMeta {
    createdAt: string;
    updatedAt: string;
    title: string;
    isCustomTitle: boolean;
    lastPrompt?: string;
    forkedFrom?: string;
    workDir?: string;
    additionalDirs?: string[];
    agents: Record<string, AgentMeta>;
    custom: Record<string, any>;
}

declare interface SessionMeta_2 {
    readonly id: string;
    readonly version?: number;
    readonly title?: string;
    readonly titleKind?: SessionTitleKind_2;
    readonly lastPrompt?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived: boolean;
    readonly archivedAt?: number;
    readonly cwd?: string;
    readonly forkedFrom?: string;
    readonly agents?: Readonly<Record<string, AgentMeta_2>>;
    readonly custom?: Record<string, unknown>;
    readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

declare type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

declare interface SessionMetadataChangedEvent {
    readonly changed: readonly (keyof SessionMeta_2)[];
}

declare const sessionMetadataSchema: z.ZodObject<{
    cwd: z.ZodString;
}, z.core.$catchall<z.ZodUnknown>>;

declare type SessionMetaPatch = Partial<Omit<SessionMeta_2, 'id' | 'createdAt'>>;

export declare interface SessionMetaUpdatedEvent {
    readonly type: 'session.meta.updated';
    readonly title?: string;
    readonly patch?: Record<string, unknown>;
}

/** Payload of `session.meta.updated` on the global bus (`session/sessionMetadata/promptMetadata.ts`). */
declare interface SessionMetaUpdatedPayload {
    readonly agentId: string;
    readonly sessionId: string;
    readonly title?: string;
    readonly patch: {
        readonly title?: string;
        readonly isCustomTitle?: boolean;
        readonly lastPrompt?: string;
    };
}

declare interface SessionOptions {
    readonly id: string;
    readonly workDir: string;
    readonly summary?: SessionSummary | undefined;
    readonly resumeState?: ResumedSessionState | undefined;
    readonly rpc: SDKRpcClientBase;
    readonly onClose?: (() => void | Promise<void>) | undefined;
}

declare type SessionPendingInteraction = 'none' | 'approval' | 'question';

export declare type SessionPlan = PlanInfo | null;

declare interface SessionPromptRpcInput {
    readonly sessionId: string;
    readonly input: PromptInput;
    readonly promptId?: string;
}

declare interface SessionPromptWithSkillsRpcInput extends SessionPromptRpcInput {
    readonly skills: readonly PromptSkillActivation[];
}

declare interface SessionQuestionsFacade {
    list(): Promise<readonly QuestionRequest[]>;
    answer(id: string, result: QuestionResult): Promise<void>;
    dismiss(id: string): Promise<void>;
}

/**
 * Options for `SessionFacade.restore` — mirrors the engine's
 * `ResumeSessionOptions`. `mcpServers` injects ephemeral per-session MCP
 * servers when restore re-materializes a cold session (ignored when the
 * session is already live).
 */
declare interface SessionRestoreOptions {
    readonly additionalDirs?: readonly string[];
    readonly mcpServers?: Readonly<Record<string, McpServerConfig_3>>;
}

declare interface SessionSkillsFacade {
    /**
     * Every skill in the session-merged catalog as a plain summary (the
     * catalog's readiness is resolved engine-side). Subscribe to
     * `session.events` `'skills.changed'` for updates.
     */
    list(): Promise<readonly SkillSummary[]>;
}

export declare interface SessionStatus {
    readonly model?: string;
    readonly thinkingEffort: string;
    readonly permission: PermissionMode;
    readonly planMode: boolean;
    readonly swarmMode?: boolean;
    readonly towerMode?: boolean;
    readonly contextTokens: number;
    readonly maxContextTokens: number;
    readonly contextUsage: number;
    readonly usage?: SessionUsage;
}

/**
 * Derived session lifecycle phase. The facade reads the engine's session
 * activity view (busy + pending interaction) and maps it onto the v1
 * precedence: pending approvals and questions first, then busy, then idle.
 */
declare type SessionStatus_2 = 'running' | 'idle' | 'awaiting_approval' | 'awaiting_question';

declare interface SessionStatusChangedEvent {
    readonly type: 'event.session.status_changed';
    readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
    readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
    readonly current_prompt_id?: string;
}

export declare interface SessionSummary {
    readonly id: string;
    readonly title?: string | undefined;
    readonly titleKind?: SessionTitleKind;
    readonly lastPrompt?: string;
    readonly workDir: string;
    readonly sessionDir: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived?: boolean | undefined;
    readonly metadata?: JsonObject | undefined;
    readonly additionalDirs?: readonly string[];
    /** Terminal outcome of the session's latest main turn, when one ended. */
    readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

declare interface SessionSummary_2 {
    readonly id: string;
    readonly workspaceId: string;
    readonly cwd?: string;
    readonly title?: string;
    readonly lastPrompt?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archived: boolean;
    readonly archivedAt?: number;
    readonly custom?: Record<string, unknown>;
    readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export declare interface SessionSummaryPage {
    readonly items: readonly SessionSummary[];
    /** Pass as `before` for the next older page; absent when the listing is exhausted. */
    readonly nextCursor?: string;
}

/**
 * The engine's canonical title state: `replaceable` (a prompt-derived easy
 * title auto generation may overwrite), `generated` (an auto-generated title
 * already landed), `custom` (a user-set title that is never overwritten).
 * Only populated by the v2 engine on live / resumed sessions (read off the
 * metadata document); v1 backends leave it undefined, and the v2 list path
 * does not project it.
 */
export declare type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

declare type SessionTitleKind_2 = 'replaceable' | 'generated' | 'custom';

export declare interface SessionTodoItem {
    readonly title: string;
    readonly status: SessionTodoStatus;
}

export declare type SessionTodoStatus = 'pending' | 'in_progress' | 'done';

declare type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export declare interface SessionUsage {
    readonly byModel?: Record<string, TokenUsage> | undefined;
    readonly currentTurn?: TokenUsage | undefined;
    readonly total?: TokenUsage | undefined;
}

declare interface SessionUsage_2 {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_cost_usd?: number;
    context_tokens: number;
    context_limit?: number;
    turn_count?: number;
}

declare interface SessionWarningInfo {
    readonly code: string;
    readonly message: string;
    readonly severity: 'info' | 'warning' | 'error';
}

declare interface SessionWorkChangedEvent {
    readonly type: 'event.session.work_changed';
    readonly busy: boolean;
    readonly main_turn_active?: boolean;
    readonly pending_interaction?: SessionPendingInteraction;
    readonly last_turn_reason?: SessionTurnOutcome;
}

declare type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

declare type SetDefaultModelResponse_2 = Awaited<ReturnType<IModelCatalog['setDefaultModel']>>;

declare const setDefaultModelResponseSchema: z.ZodObject<{
    default_model: z.ZodString;
    model: z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        display_name: z.ZodOptional<z.ZodString>;
        max_context_size: z.ZodNumber;
        capabilities: z.ZodOptional<z.ZodArray<z.ZodString>>;
        support_efforts: z.ZodOptional<z.ZodArray<z.ZodString>>;
        default_effort: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;

declare type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;

declare interface SetSessionModelRpcInput extends SessionIdRpcInput {
    readonly model: string;
}

declare interface SetSessionModelRpcResult {
    readonly model: string;
    readonly providerName?: string | undefined;
}

declare interface SetSessionPermissionRpcInput extends SessionIdRpcInput {
    readonly mode: PermissionMode;
}

declare interface SetSessionPlanModeRpcInput extends SessionIdRpcInput {
    readonly enabled: boolean;
}

declare type SetSessionSwarmModeRpcInput = (SessionIdRpcInput & {
    readonly enabled: true;
    readonly trigger: SwarmModeTrigger;
}) | (SessionIdRpcInput & {
    readonly enabled: false;
});

declare interface SetSessionThinkingRpcInput extends SessionIdRpcInput {
    readonly effort: string;
}

declare interface SetSessionTowerModeRpcInput extends SessionIdRpcInput {
    readonly enabled: boolean;
    readonly base?: string;
}

declare interface ShellCommandOrigin {
    readonly kind: 'shell_command';
    readonly phase: 'input' | 'output';
    readonly isError?: boolean;
}

declare interface ShellCommandOrigin_2 {
    readonly kind: 'shell_command';
    readonly phase: 'input' | 'output';
    readonly isError?: boolean;
}

declare type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;

declare interface ShellCompletedEvent extends Omit<ShellCompletedPayload, 'agentId'> {
    readonly type: 'shell.completed';
}

declare interface ShellCompletedPayload {
    readonly agentId: string;
    readonly commandId: string;
    readonly isError: boolean;
    readonly taskId?: string;
}

export declare interface ShellEnvironment {
    readonly term?: string | undefined;
    readonly termProgram?: string | undefined;
    readonly termProgramVersion?: string | undefined;
    readonly multiplexer?: string | undefined;
    readonly shell?: string | undefined;
}

declare type ShellName = 'bash' | 'sh';

declare interface ShellOutputEvent extends Omit<ShellOutputPayload, 'agentId'> {
    readonly type: 'shell.output';
}

declare interface ShellOutputPayload {
    readonly agentId: string;
    readonly commandId: string;
    readonly update: ToolUpdate;
    readonly taskId?: string;
}

declare interface ShellStartedEvent extends Omit<ShellStartedPayload, 'agentId'> {
    readonly type: 'shell.started';
}

declare interface ShellStartedPayload {
    readonly agentId: string;
    readonly commandId: string;
    readonly taskId: string;
}

export declare interface SkillActivatedEvent {
    readonly type: 'skill.activated';
    readonly activationId: string;
    readonly skillName: string;
    readonly skillArgs?: string;
    readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
    readonly skillPath?: string;
    readonly skillSource?: SkillSource_3;
}

declare interface SkillActivationInput {
    readonly name: string;
    readonly args?: string;
    readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
    readonly content?: readonly ContentPart_2[];
    readonly attachments?: readonly PromptFileAttachment[];
}

declare interface SkillActivationOrigin {
    readonly kind: 'skill_activation';
    readonly activationId: string;
    readonly skillName: string;
    readonly skillArgs?: string | undefined;
    readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
    readonly skillType?: string | undefined;
    readonly skillPath?: string | undefined;
    readonly skillSource?: SkillSource | undefined;
}

declare interface SkillActivationOrigin_2 {
    readonly kind: 'skill_activation';
    readonly inTurn?: true;
    readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
    readonly activationId: string;
    readonly skillName: string;
    readonly skillArgs?: string | undefined;
    readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
    readonly skillType?: string | undefined;
    readonly skillPath?: string | undefined;
    readonly skillSource?: SkillSource_3 | undefined;
    readonly attachments?: readonly PromptFileAttachment[];
}

declare type SkillScope = 'tui' | 'web';

declare type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

declare type SkillSource_2 = 'project' | 'user' | 'extra' | 'builtin';

declare type SkillSource_3 = 'project' | 'user' | 'extra' | 'builtin';

export declare interface SkillSummary {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly source: SkillSource_2;
    readonly type?: string | undefined;
    readonly disableModelInvocation?: boolean | undefined;
    readonly isSubSkill?: boolean | undefined;
    readonly scopes?: readonly SkillScope[];
}

declare interface StateKey<T> {
    readonly name: string;
    readonly initial: () => T;
    readonly snapshotExcluded?: boolean;
}

/**
 * KAOS stat result, mirroring Python's os.stat_result fields.
 */
declare interface StatResult {
    stMode: number;
    stIno: number;
    stDev: number;
    stNlink: number;
    stUid: number;
    stGid: number;
    stSize: number;
    stAtime: number;
    stMtime: number;
    stCtime: number;
}

declare interface StoredMcpOAuthTokens extends OAuthTokens {
    readonly obtained_at?: number;
}

declare type StreamedMessagePart_2 = ContentPart_3 | ToolCall_3 | ToolCallPart;

export declare interface SubagentCancelledEvent extends SubagentCancelledPayload {
    readonly type: 'subagent.cancelled';
}

declare interface SubagentCancelledPayload {
    readonly subagentId: string;
}

export declare interface SubagentCompletedEvent extends SubagentCompletedPayload {
    readonly type: 'subagent.completed';
}

declare interface SubagentCompletedPayload {
    readonly subagentId: string;
    readonly resultSummary: string;
    readonly usage?: TokenUsage_2;
    readonly contextTokens?: number;
}

export declare interface SubagentFailedEvent extends SubagentFailedPayload {
    readonly type: 'subagent.failed';
}

declare interface SubagentFailedPayload {
    readonly subagentId: string;
    readonly error: string;
}

export declare interface SubagentSpawnedEvent extends SubagentSpawnedPayload {
    readonly type: 'subagent.spawned';
}

declare interface SubagentSpawnedPayload {
    readonly subagentId: string;
    readonly subagentName: string;
    readonly parentToolCallId: string;
    readonly parentToolCallUuid?: string;
    readonly parentAgentId?: string;
    readonly callerAgentId?: string;
    readonly description?: string;
    readonly swarmIndex?: number;
    readonly runInBackground: boolean;
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly taskId?: string;
}

export declare interface SubagentStartedEvent extends SubagentStartedPayload {
    readonly type: 'subagent.started';
}

declare interface SubagentStartedPayload {
    readonly subagentId: string;
}

export declare interface SubagentSuspendedEvent extends SubagentSuspendedPayload {
    readonly type: 'subagent.suspended';
}

declare interface SubagentSuspendedPayload {
    readonly subagentId: string;
    readonly reason: string;
}

declare interface SubagentTaskInfo extends AgentTaskInfoBase {
    readonly kind: 'agent';
    readonly agentId?: string;
    readonly subagentType?: string;
    readonly parentToolCallId?: string;
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly stopCode?: string;
}

/**
 * File-suggestion query against a workspace root, no session required. Only
 * meaningful on the agent-core-v2 engine; the v1 engine has no equivalent
 * and reports `undefined`.
 */
export declare interface SuggestFilesInput {
    readonly query: string;
    readonly limit?: number;
}

export declare interface SuggestFilesItem {
    readonly path: string;
    readonly name: string;
    readonly kind: 'file' | 'directory' | 'symlink';
    /** Matched-character offsets into `path`, for mention-style highlighting. */
    readonly matchPositions: readonly number[];
}

export declare interface SuggestFilesResult {
    readonly items: readonly SuggestFilesItem[];
    readonly truncated: boolean;
}

declare type SwarmModeTrigger = 'manual' | 'task' | 'tool';

declare interface SwitchSessionRuntimeRpcInput extends SessionIdRpcInput {
    readonly runtimeId: string;
}

declare interface SystemPromptContext extends AgentProfileContext {
    readonly agentsMdWarning?: string;
    readonly agentsMdPaths?: readonly string[];
}

declare interface SystemPromptRenderResult {
    readonly text: string;
    readonly environment: EnvironmentDisclosureSnapshot;
}

declare interface SystemTriggerOrigin {
    readonly kind: 'system_trigger';
    readonly name: string;
}

declare interface SystemTriggerOrigin_2 {
    readonly kind: 'system_trigger';
    readonly name: string;
}

declare type TaskInfo = TaskInfoBase & ({
    readonly kind: 'process';
    readonly command: string;
    readonly pid: number;
    readonly exitCode: number | null;
} | {
    readonly kind: 'agent';
    readonly agentId?: string;
    readonly subagentType?: string;
    readonly model?: string;
    readonly thinkingEffort?: string;
} | {
    readonly kind: 'question';
    readonly questionCount: number;
    readonly toolCallId?: string;
});

declare interface TaskInfoBase {
    readonly taskId: string;
    readonly description: string;
    readonly status: AgentTaskStatus;
    readonly detached?: boolean;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly stopReason?: string;
    readonly terminalNotificationSuppressed?: boolean;
    readonly timeoutMs?: number;
}

declare interface TaskOrigin {
    readonly kind: 'task';
    readonly taskId: string;
    readonly status: AgentTaskStatus;
    readonly notificationId: string;
}

declare interface TaskStartedEvent {
    readonly type: 'task.started';
    readonly info: TaskInfo;
}

declare type TaskState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

declare interface TaskTerminatedEvent {
    readonly type: 'task.terminated';
    readonly info: TaskInfo;
}

declare type TeardownReason = 'scope-close' | 'cascade' | 'unload';

export declare interface TelemetryClient {
    track(event: string, properties?: TelemetryProperties): void;
    withContext?(patch: TelemetryContextPatch): TelemetryClient;
    setContext?(patch: TelemetryContextPatch): void;
}

export declare interface TelemetryContextPatch {
    readonly sessionId?: string | null;
}

export declare type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

declare type TelemetryPropertyValue = boolean | number | string | undefined | null;

export declare interface TestMcpServerOptions {
    readonly cwd?: string;
}

declare interface TextContent {
    type: 'text';
    text: string;
}

declare type TextDecodeErrors = 'strict' | 'replace' | 'ignore';

declare interface TextPart {
    type: 'text';
    text: string;
}

declare interface TextPart_2 {
    type: 'text';
    text: string;
}

export declare type TextPromptPart = Extract<ContentPart, {
    type: 'text';
}>;

export declare type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

declare interface ThinkingConfig_2 {
    type?: 'enabled' | 'disabled';
    effort?: string;
    keep?: unknown;
    [key: string]: unknown;
}

declare const ThinkingConfigSchema: z.ZodObject<{
    enabled: z.ZodOptional<z.ZodBoolean>;
    effort: z.ZodOptional<z.ZodString>;
    keep: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface ThinkingContent {
    type: 'thinking';
    thinking: string;
    signature?: string;
}

export declare interface ThinkingDeltaEvent extends Omit<ThinkingDeltaPayload, 'agentId'> {
    readonly type: 'thinking.delta';
}

declare const thinkingDeltaEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"thinking.delta">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    delta: z.ZodString;
}, z.core.$strip>;

declare interface ThinkingDeltaPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly delta: string;
}

/**
 * Thinking effort passed to {@link ChatProvider.withThinking}.
 *
 * `'off'` and `'on'` are the only reserved values: `'off'` disables thinking,
 * and `'on'` is the on-signal for boolean models (models that do not declare
 * `support_efforts`). Everything else is a model-declared effort (e.g.
 * `"low"`, `"high"`, `"max"`) carried as an open string. The type collapses to
 * `string` at runtime; it exists purely as a semantic marker that a value is
 * expected to be `'off'`, `'on'`, or a model-declared effort.
 *
 * Provider adapters receive an already-resolved effort. Adapters with a native
 * effort field pass concrete strings through to their upstream API; model
 * compatibility and fallback are resolved before this boundary.
 */
export declare type ThinkingEffort = 'off' | 'on' | (string & {});

declare type ThinkingLevel = ReturnType<IAgentProfileService['getEffectiveThinkingLevel']>;

declare interface ThinkPart {
    type: 'think';
    think: string;
    encrypted?: string;
    hidden?: boolean;
}

declare interface ThinkPart_2 {
    type: 'think';
    think: string;
    encrypted?: string;
    detailsIndex?: number;
    hidden?: boolean;
    reasoningKey?: string;
}

declare interface TokenCountingRebaseInput {
    readonly length: number;
    readonly tokens: number;
    readonly measured: boolean;
}

declare interface TokenCountingRequest {
    readonly systemPrompt: string;
    readonly tools: readonly ToolDescription[];
    readonly messages: readonly Message_2[];
}

declare type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';

export declare interface TokenUsage {
    readonly inputOther: number;
    readonly output: number;
    readonly inputCacheRead: number;
    readonly inputCacheCreation: number;
}

declare interface TokenUsage_3 {
    inputOther: number;
    output: number;
    inputCacheRead: number;
    inputCacheCreation: number;
    raw?: Record<string, unknown>;
}

export declare function toKimiErrorPayload(error: unknown): KimiErrorPayload;

/**
 * A tool that the model may invoke during generation.
 *
 * The definition is provider-agnostic; each provider implementation converts
 * it to the appropriate wire format (e.g. OpenAI function-calling, Anthropic
 * tool-use, Google function declarations).
 */
declare interface Tool {
    /** Unique tool name used to match invocations. */
    name: string;
    /** Human-readable description shown to the model. */
    description: string;
    /** JSON Schema describing the tool's parameters. */
    parameters: Record<string, unknown>;
    /**
     * Client-internal marker: the tool is executable but its schema must not be
     * serialized into the request's top-level `tools[]` — it was (or will be)
     * delivered through a message-level `tools` declaration instead, and the
     * top-level list must stay byte-stable for prompt caching. `generate()`
     * strips marked tools before the provider builds the request; the marker
     * itself never reaches the wire.
     */
    deferred?: true;
}

declare type Tool_2 = ToolDescription;

export declare interface ToolCall {
    type: 'function';
    id: string;
    name: string;
    arguments: string | null;
    extras?: Record<string, unknown>;
    /**
     * Provider-specific streaming index used to route argument deltas to the
     * correct parallel tool call. Set by streaming providers (OpenAI Chat
     * Completions `index`, Responses API `item_id`). Consumed internally by
     * {@link generate} and stripped before the ToolCall is stored on a Message.
     *
     * @internal
     */
    _streamIndex?: number | string;
}

declare interface ToolCall_3 {
    type: 'function';
    id: string;
    name: string;
    arguments: string | null;
    extras?: Record<string, unknown>;
    rawId?: string;
    _streamIndex?: number | string;
}

export declare interface ToolCallDeltaEvent extends Omit<ToolCallDeltaPayload, 'agentId'> {
    readonly type: 'tool.call.delta';
}

declare const toolCallDeltaEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool.call.delta">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    argumentsPart: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface ToolCallDeltaPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly name?: string;
    readonly argumentsPart?: string;
}

declare interface ToolCallPart {
    type: 'tool_call_part';
    argumentsPart: string | null;
    index?: number | string;
}

export declare interface ToolCallRequest {
    readonly turnId?: number | undefined;
    readonly toolCallId: string;
    readonly args: unknown;
}

export declare interface ToolCallResponse {
    readonly output: string | ContentPart[];
    readonly isError?: boolean | undefined;
}

export declare interface ToolCallStartedEvent extends Omit<ToolCallStartedPayload, 'agentId'> {
    readonly type: 'tool.call.started';
}

declare const toolCallStartedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool.call.started">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
    name: z.ZodString;
    args: z.ZodUnknown;
    description: z.ZodOptional<z.ZodString>;
    display: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;

declare interface ToolCallStartedPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly name: string;
    readonly args: unknown;
    readonly description?: string;
    readonly display?: ToolInputDisplay;
}

declare interface ToolDescription_2 {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    deferred?: true;
}

export declare interface ToolInfo {
    readonly name: string;
    readonly description: string;
    readonly active: boolean;
    readonly source: ToolSource;
}

export declare type ToolInputDisplay = {
    kind: 'command';
    command: string;
    cwd?: string | undefined;
    description?: string | undefined;
    language?: 'bash' | undefined;
} | {
    kind: 'file_io';
    operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
    path: string;
    detail?: string | undefined;
    content?: string | undefined;
    before?: string | undefined;
    after?: string | undefined;
} | {
    kind: 'diff';
    path: string;
    before: string;
    after: string;
    hunks?: number | undefined;
} | {
    kind: 'search';
    query: string;
    scope?: string | undefined;
} | {
    kind: 'url_fetch';
    url: string;
    method?: string | undefined;
} | {
    kind: 'agent_call';
    agent_name: string;
    prompt: string;
    background?: boolean | undefined;
} | {
    kind: 'skill_call';
    skill_name: string;
    args?: string | undefined;
} | {
    kind: 'todo_list';
    items: {
        title: string;
        status: string;
    }[];
} | {
    kind: 'task';
    task_id: string;
    status: string;
    description: string;
    task_kind?: string | undefined;
} | {
    kind: 'task_stop';
    task_id: string;
    task_description: string;
} | {
    kind: 'plan_review';
    plan: string;
    path?: string | undefined;
    options?: readonly {
        label: string;
        description: string;
    }[] | undefined;
} | {
    kind: 'goal_start';
    objective: string;
    completionCriterion?: string | undefined;
    mode: 'manual' | 'yolo';
} | {
    kind: 'generic';
    summary: string;
    detail?: unknown;
};

export declare interface ToolListUpdatedEvent extends Omit<ToolListUpdatedPayload, 'agentId'> {
    readonly type: 'tool.list.updated';
}

declare interface ToolListUpdatedPayload {
    readonly agentId: string;
    readonly reason: ToolListUpdatedReason;
    readonly serverName: string;
}

export declare type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

/**
 * Strategy for converting tool-role message content.
 *
 * - `'extract_text'`: flatten all content parts into a single text string
 *   (some providers require tool results as plain text).
 * - `null`: convert content parts to the standard OpenAI content-part array.
 */
declare type ToolMessageConversion = 'extract_text' | null;

export declare interface ToolProgressEvent extends Omit<ToolProgressPayload, 'agentId'> {
    readonly type: 'tool.progress';
}

declare const toolProgressEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool.progress">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
    update: z.ZodObject<{
        kind: z.ZodEnum<{
            status: "status";
            custom: "custom";
            stdout: "stdout";
            stderr: "stderr";
            progress: "progress";
        }>;
        text: z.ZodOptional<z.ZodString>;
        percent: z.ZodOptional<z.ZodNumber>;
        customKind: z.ZodOptional<z.ZodString>;
        customData: z.ZodOptional<z.ZodUnknown>;
        replace: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>;
}, z.core.$strip>;

declare interface ToolProgressPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly update: ToolUpdate;
}

declare interface ToolResultContent {
    type: 'tool_result';
    tool_call_id: string;
    output: unknown;
    is_error?: boolean;
}

export declare interface ToolResultEvent extends Omit<ToolResultEventPayload, 'agentId'> {
    readonly type: 'tool.result';
}

declare interface ToolResultEventPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly toolCallId: string;
    readonly output: unknown;
    readonly isError?: boolean;
    readonly synthetic?: boolean;
}

declare const toolResultEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"tool.result">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    toolCallId: z.ZodString;
    output: z.ZodUnknown;
    isError: z.ZodOptional<z.ZodBoolean>;
    synthetic: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;

declare type ToolSource = 'builtin' | 'user' | 'mcp';

export declare interface ToolUpdate {
    kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
    text?: string | undefined;
    percent?: number | undefined;
    customKind?: string | undefined;
    customData?: unknown;
    replace?: boolean;
}

declare interface ToolUseContent {
    type: 'tool_use';
    tool_call_id: string;
    tool_name: string;
    input: unknown;
}

export declare interface TurnEndedEvent {
    readonly type: 'turn.ended';
    readonly time?: number;
    readonly turnId: number;
    readonly reason: TurnEndReason;
    readonly error?: KimiErrorPayload_2;
    readonly durationMs?: number;
    readonly interruptReason?: TurnInterruptReason;
    readonly traceId?: string;
}

declare const turnEndedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"turn.ended">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    reason: z.ZodEnum<{
        completed: "completed";
        cancelled: "cancelled";
        failed: "failed";
        blocked: "blocked";
    }>;
    error: z.ZodOptional<z.ZodUnknown>;
    durationMs: z.ZodOptional<z.ZodNumber>;
    interruptReason: z.ZodOptional<z.ZodEnum<{
        filtered: "filtered";
        error: "error";
        aborted: "aborted";
        blocked: "blocked";
        user_cancelled: "user_cancelled";
        max_steps: "max_steps";
    }>>;
    traceId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

export declare type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

declare type TurnInterruptReason = 'user_cancelled' | 'aborted' | 'max_steps' | 'error' | 'filtered' | 'blocked';

declare type TurnPromptAttachment = {
    readonly kind: 'image' | 'video' | 'audio';
    readonly fileId: string;
    readonly name?: string;
} | TurnPromptAttachmentFile;

declare interface TurnPromptAttachmentFile {
    readonly kind: 'file';
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly path: string;
}

export declare interface TurnStartedEvent extends Omit<TurnStartedPayload, 'agentId'> {
    readonly type: 'turn.started';
}

declare const turnStartedEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"turn.started">;
    time: z.ZodOptional<z.ZodNumber>;
    turnId: z.ZodNumber;
    origin: z.ZodUnknown;
    prompt: z.ZodOptional<z.ZodString>;
    promptId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface TurnStartedPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly promptId?: string;
    readonly origin: PromptOrigin_2;
    readonly prompt?: string;
    readonly promptAttachments?: readonly TurnPromptAttachment[];
}

export declare interface TurnStepCompletedEvent extends Omit<TurnStepCompletedPayload, 'agentId'> {
    readonly type: 'turn.step.completed';
}

declare interface TurnStepCompletedPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly step: number;
    readonly stepId?: string;
    readonly usage?: TokenUsage_2;
    readonly finishReason?: string;
    readonly llmFirstTokenLatencyMs?: number;
    readonly llmStreamDurationMs?: number;
    readonly llmRequestBuildMs?: number;
    readonly llmServerFirstTokenMs?: number;
    readonly llmServerDecodeMs?: number;
    readonly llmClientConsumeMs?: number;
    readonly llmClientBlockedMs?: number;
    readonly providerFinishReason?: FinishReason;
    readonly rawFinishReason?: string;
}

export declare interface TurnStepInterruptedEvent extends Omit<TurnStepInterruptedPayload, 'agentId'> {
    readonly type: 'turn.step.interrupted';
}

declare interface TurnStepInterruptedPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly step: number;
    readonly stepId?: string;
    readonly reason: string;
    readonly message?: string;
}

export declare interface TurnStepRetryingEvent extends Omit<TurnStepRetryingPayload, 'agentId'> {
    readonly type: 'turn.step.retrying';
}

declare interface TurnStepRetryingPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly step: number;
    readonly stepId?: string;
    readonly failedAttempt: number;
    readonly nextAttempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly errorName: string;
    readonly errorMessage: string;
    readonly statusCode?: number;
}

export declare interface TurnStepStartedEvent extends Omit<TurnStepStartedPayload, 'agentId'> {
    readonly type: 'turn.step.started';
}

declare interface TurnStepStartedPayload {
    readonly agentId: string;
    readonly turnId: number;
    readonly step: number;
    readonly stepId?: string;
}

export declare type Unsubscribe = () => void;

declare interface UpdateSessionMetadataRpcInput extends SessionIdRpcInput {
    readonly metadata: JsonObject;
}

/** Input for `uploadFile`: the upload's display name and MIME type. */
export declare interface UploadFileOptions {
    readonly name: string;
    readonly mimeType?: string;
    /** Optional daemon-side TTL for staging uploads. */
    readonly expiresInSec?: number;
}

declare interface UsageRecordedContext {
    readonly agent: AgentContext;
    readonly model: string;
    readonly usage: Readonly<TokenUsage_2>;
    readonly source?: AgentLLMRequestSource;
    readonly firstRecord: boolean;
}

export declare interface UsageStatus {
    readonly byModel?: Record<string, TokenUsage_2>;
    readonly total?: TokenUsage_2;
    readonly currentTurn?: TokenUsage_2;
}

declare type UsageStatus_2 = Awaited<ReturnType<ISessionUsageService['status']>>;

declare interface UserPromptOrigin {
    readonly kind: 'user';
}

declare interface UserPromptOrigin_2 {
    readonly kind: 'user';
    readonly inTurn?: true;
    readonly clientMetadata?: readonly Readonly<Record<string, unknown>>[];
    readonly skillActivations?: readonly BundledSkillActivation[];
    readonly attachments?: readonly PromptFileAttachment[];
}

export declare interface ValidateKimiConfigTomlInput {
    readonly text: string;
    readonly filePath?: string | undefined;
}

declare interface VideoContent {
    type: 'video';
    source: ImageSource;
    name?: string;
}

declare interface VideoURLPart {
    type: 'video_url';
    videoUrl: {
        url: string;
        id?: string | undefined;
        name?: string;
    };
}

declare interface VideoURLPart_3 {
    type: 'video_url';
    videoUrl: {
        url: string;
        id?: string;
        name?: string;
    };
}

export declare interface WarningEvent {
    readonly type: 'warning';
    readonly message: string;
    readonly code?: string;
}

declare const warningEventSchema: z.ZodObject<{
    type: z.ZodLiteral<"warning">;
    time: z.ZodOptional<z.ZodNumber>;
    message: z.ZodString;
    code: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;

declare interface WireLineRange {
    readonly start: number;
    readonly end: number;
}

declare interface Workspace {
    id: string;
    root: string;
    name: string;
    created_at: string;
    last_opened_at: string;
    session_count: number;
}

declare interface Workspace_2 {
    readonly id: string;
    readonly root: string;
    readonly name: string;
    readonly createdAt: number;
    readonly lastOpenedAt: number;
}

declare interface WorkspaceCreatedEvent {
    readonly type: 'event.workspace.created';
    readonly workspace: Workspace;
}

declare interface WorkspaceDeletedEvent {
    readonly type: 'event.workspace.deleted';
    readonly workspace_id: string;
    readonly root: string;
}

export declare interface WorkspaceTrustInfo {
    readonly trusted: boolean;
    /** Safe descriptions of project-level MCP servers that trusting would enable. */
    readonly gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[];
}

/**
 * Trust state of a workspace directory. Only meaningful on the agent-core-v2
 * engine; the v1 engine has no workspace-trust concept and reports
 * `{ trusted: true, gatedMcpServers: [] }`.
 */
export declare interface WorkspaceTrustMcpServerInfo {
    readonly name: string;
    readonly transport: 'stdio' | 'http' | 'sse';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly cwd?: string;
    readonly url?: string;
}

declare interface WorkspaceUpdate {
    readonly name?: string;
}

declare interface WorkspaceUpdatedEvent {
    readonly type: 'event.workspace.updated';
    readonly workspace: Workspace;
}

export { }

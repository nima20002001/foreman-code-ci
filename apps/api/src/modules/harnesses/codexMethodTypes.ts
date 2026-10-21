// Generated from bundled codex-cli 0.154.0 via scripts/generate-codex-method-types.mjs.
// Compile-time baseline only; every launch still validates its own emitted schema.

export type AbsolutePathBuf = string;

export type AgentPath = string;

export type AutoCompactTokenLimitScope = "total" | "body_after_prefix";

export type ClientInfo = { name: string, title: string | null, version: string, };

export type ForcedLoginMethod = "chatgpt" | "api";

export type FunctionCallOutputBody = string | Array<FunctionCallOutputContentItem>;

export type FunctionCallOutputContentItem = { "type": "input_text", text: string, } | { "type": "input_image", image_url: string, detail?: ImageDetail, } | { "type": "input_audio", audio_url: string, } | { "type": "encrypted_content", encrypted_content: string, };

export type ImageDetail = "auto" | "low" | "high" | "original";

export type ImageGenerationFailure = { "type": "usageLimitExceeded", limitId: string, resetsAt: number | null, };

export type ImageGenerationItem = { id: string, status: string, revisedPrompt: string | null, result: string, transparentBackground?: boolean, failure: ImageGenerationFailure | null, savedPath?: AbsolutePathBuf, };

export type InitializeCapabilities = {

experimentalApi: boolean,

requestAttestation: boolean,

mcpServerOpenaiFormElicitation?: boolean,

optOutNotificationMethods?: Array<string> | null,

extensions?: { [key in string]?: JsonValue } | null, };

export type InitializeParams = { clientInfo: ClientInfo, capabilities: InitializeCapabilities | null, };

export type InitializeResponse = { userAgent: string,

codexHome: AbsolutePathBuf,

platformFamily: string,

platformOs: string, };

export type InputModality = "text" | "image" | "audio";

export type LegacyAppPathString = string;

export type McpServerInfo = { name: string, title: string | null, version: string, description: string | null, icons: Array<JsonValue> | null, websiteUrl: string | null, };

export type MessagePhase = "commentary" | "final_answer";

export type Personality = "none" | "friendly" | "pragmatic";

export type ReasoningEffort = string;

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export type Resource = { annotations?: JsonValue, description?: string, mimeType?: string, name: string, size?: number, title?: string, uri: string, icons?: Array<JsonValue>, _meta?: JsonValue, };

export type ResourceTemplate = { annotations?: JsonValue, uriTemplate: string, name: string, title?: string, description?: string, mimeType?: string, };

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;

export type SleepItem = { id: string, durationMs: number, };

export type SubAgentSource = "review" | "compact" | { "thread_spawn": { parent_thread_id: ThreadId, depth: number, agent_path: AgentPath | null, agent_nickname: string | null, agent_role: string | null, } } | "memory_consolidation" | { "other": string };

export type ThreadId = string;

export type Tool = { name: string, title?: string, description?: string, inputSchema: JsonValue, outputSchema?: JsonValue, annotations?: JsonValue, icons?: Array<JsonValue>, _meta?: JsonValue, };

export type AgentMessageDelivery = "async";

export type AllowDenyRequirement = "allow" | "deny";

export type AnalyticsConfig = { enabled: boolean | null, } & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export type AskForApproval = "untrusted" | "on-request" | { "granular": { sandbox_approval: boolean, rules: boolean, skill_approval: boolean, request_permissions: boolean, mcp_elicitations: boolean, } } | "never";

export type AsyncUserInputQuestion = { title: string, options: Array<string> | null, };

export type BrowserUseConfig = { allow_history_access: boolean | null, default_origin_policy: BrowserUseOriginPolicyConfig | null, origins: { [key in string]?: BrowserUseOriginPolicyConfig } | null, };

export type BrowserUseOriginPolicyConfig = { access: AllowDenyRequirement | null, downloads: AllowDenyRequirement | null, uploads: AllowDenyRequirement | null, full_cdp_access: AllowDenyRequirement | null, };

export type ByteRange = { start: number, end: number, };

export type CancelLoginAccountParams = { loginId: string, };

export type CancelLoginAccountResponse = { status: CancelLoginAccountStatus, };

export type CancelLoginAccountStatus = "canceled" | "notFound";

export type CodexErrorInfo = "contextWindowExceeded" | "sessionBudgetExceeded" | "usageLimitExceeded" | "rateLimitExceeded" | "serverOverloaded" | "cyberPolicy" | "misalignmentPolicyViolation" | { "httpConnectionFailed": { httpStatusCode: number | null, } } | { "responseStreamConnectionFailed": { httpStatusCode: number | null, } } | "internalServerError" | "unauthorized" | "badRequest" | "threadRollbackFailed" | "sandboxError" | { "responseStreamDisconnected": { httpStatusCode: number | null, } } | { "responseTooManyFailedAttempts": { httpStatusCode: number | null, } } | { "activeTurnNotSteerable": { turnKind: NonSteerableTurnKind, } } | "other";

export type CollabAgentState = { status: CollabAgentStatus, message: string | null, };

export type CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound";

export type CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents";

export type CollabAgentToolCallStatus = "inProgress" | "completed" | "failed" | "interrupted";

export type CommandAction = { "type": "read", command: string, name: string, path: LegacyAppPathString, } | { "type": "listFiles", command: string, path: string | null, } | { "type": "search", command: string, query: string | null, path: string | null, } | { "type": "unknown", command: string, };

export type CommandExecutionSource = "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction";

export type CommandExecutionStatus = "inProgress" | "completed" | "failed" | "declined";

export type ComputerUseConfig = { default_app_access: AllowDenyRequirement | null, macos: ComputerUseMacosConfig | null, windows: ComputerUseWindowsConfig | null, };

export type ComputerUseMacosConfig = { bundle_ids: { [key in string]?: AllowDenyRequirement } | null, };

export type ComputerUseWindowsConfig = { aumids: { [key in string]?: AllowDenyRequirement } | null, exes: Array<ComputerUseWindowsExeConfig> | null, };

export type ComputerUseWindowsExeConfig = { publisher_name: string, product_name: string, binary_name: string | null, access: AllowDenyRequirement, };

export type Config = {model: string | null, review_model: string | null, model_context_window: bigint | null, model_auto_compact_token_limit: bigint | null, model_auto_compact_token_limit_scope: AutoCompactTokenLimitScope | null, model_provider: string | null, approval_policy: AskForApproval | null, 
approvals_reviewer: ApprovalsReviewer | null, sandbox_mode: SandboxMode | null, sandbox_workspace_write: SandboxWorkspaceWrite | null, forced_chatgpt_workspace_id: ForcedChatgptWorkspaceIds | null, forced_login_method: ForcedLoginMethod | null, web_search: WebSearchMode | null, tools: ToolsV2 | null, instructions: string | null, developer_instructions: string | null, compact_prompt: string | null, model_reasoning_effort: ReasoningEffort | null, model_reasoning_summary: ReasoningSummary | null, model_verbosity: Verbosity | null, service_tier: string | null, analytics: AnalyticsConfig | null, browser_use: BrowserUseConfig | null, computer_use: ComputerUseConfig | null, desktop: { [key in string]?: JsonValue } | null} & ({ [key in string]?: number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null });

export type ConfigBatchWriteParams = { edits: Array<ConfigEdit>,

filePath?: string | null, expectedVersion?: string | null,

reloadUserConfig?: boolean, };

export type ConfigEdit = { keyPath: string, value: JsonValue, mergeStrategy: MergeStrategy, };

export type ConfigLayer = { name: ConfigLayerSource, version: string, config: JsonValue, disabledReason: string | null, };

export type ConfigLayerMetadata = { name: ConfigLayerSource, version: string, };

export type ConfigLayerSource = { "type": "packagedDefaults",

file: AbsolutePathBuf, } | { "type": "mdm", domain: string, key: string, } | { "type": "system",

file: AbsolutePathBuf, } | { "type": "enterpriseManaged",

id: string,

name: string, } | { "type": "user",

file: AbsolutePathBuf,

profile: string | null, } | { "type": "project", dotCodexFolder: AbsolutePathBuf, } | { "type": "sessionFlags" } | { "type": "legacyManagedConfigTomlFromFile", file: AbsolutePathBuf, } | { "type": "legacyManagedConfigTomlFromMdm" };

export type ConfigReadParams = { includeLayers?: boolean,

cwd?: string | null, };

export type ConfigReadResponse = { config: Config, origins: { [key in string]?: ConfigLayerMetadata }, layers: Array<ConfigLayer> | null, };

export type ConfigWriteResponse = { status: WriteStatus, version: string,

filePath: AbsolutePathBuf, overriddenMetadata: OverriddenMetadata | null, };

export type DynamicToolCallOutputContentItem = { "type": "inputText", text: string, } | { "type": "inputImage", imageUrl: string, } | { "type": "inputAudio", audioUrl: string, };

export type DynamicToolCallStatus = "inProgress" | "completed" | "failed";

export type FileUpdateChange = { path: string, kind: PatchChangeKind, diff: string, };

export type ForcedChatgptWorkspaceIds = string | Array<string>;

export type GitInfo = { sha: string | null, branch: string | null, originUrl: string | null, };

export type HookPromptFragment = { text: string, hookRunId: string, };

export type ListMcpServerStatusParams = {

cursor?: string | null,

limit?: number | null,

detail?: McpServerStatusDetail | null, threadId?: string | null, };

export type ListMcpServerStatusResponse = { data: Array<McpServerStatus>,

nextCursor: string | null, };

export type LoginAccountParams = { "type": "apiKey", apiKey: string, } | { "type": "chatgpt", codexStreamlinedLogin?: boolean, useHostedLoginSuccessPage?: boolean, appBrand?: LoginAppBrand | null, } | { "type": "chatgptDeviceCode" } | { "type": "chatgptAuthTokens",

accessToken: string,

chatgptAccountId: string,

chatgptPlanType?: string | null, } | { "type": "amazonBedrock", apiKey: string, region: string, } | { "type": "amazonBedrockAccessKeys", accessKeyId: string, secretAccessKey: string, sessionToken?: string | null, region: string, };

export type LoginAccountResponse = { "type": "apiKey", } | { "type": "chatgpt", loginId: string,

authUrl: string, } | { "type": "chatgptDeviceCode", loginId: string,

verificationUrl: string,

userCode: string, } | { "type": "chatgptAuthTokens", } | { "type": "amazonBedrock", };

export type LoginAppBrand = "codex" | "chatgpt";

export type McpAuthStatus = "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";

export type McpServerConnectionStatus = "notStarted" | "starting" | "connected" | "authenticationRequired" | "failed" | "cancelled" | "disabled";

export type McpServerStatus = { name: string,

runtimeStatus: McpServerConnectionStatus | null, pluginId: string | null, serverInfo: McpServerInfo | null, tools: { [key in string]?: Tool },

toolsError: string | null, resources: Array<Resource>, resourceTemplates: Array<ResourceTemplate>, authStatus: McpAuthStatus, };

export type McpServerStatusDetail = "full" | "toolsAndAuthOnly";

export type McpToolCallAppContext = { connectorId: string, linkId: string | null, resourceUri: string | null, appName: string | null, actionName: string | null, };

export type McpToolCallError = { message: string, };

export type McpToolCallResult = { content: Array<JsonValue>, structuredContent: JsonValue | null, _meta: JsonValue | null, };

export type McpToolCallStatus = "inProgress" | "completed" | "failed";

export type MemoryCitation = { entries: Array<MemoryCitationEntry>, threadIds: Array<string>, };

export type MemoryCitationEntry = { path: string, lineStart: number, lineEnd: number, note: string, };

export type MergeStrategy = "replace" | "upsert";

export type MisalignmentErrorDetails = {

errorType: string | null,

detailedExplanation: string | null,

steer: MisalignmentSteer | null, };

export type MisalignmentSteer = { message: string, };

export type Model = { id: string, model: string, upgrade: string | null, upgradeInfo: ModelUpgradeInfo | null, availabilityNux: ModelAvailabilityNux | null, displayName: string, description: string, modelSpecialty: string | null, hidden: boolean, supportedReasoningEfforts: Array<ReasoningEffortOption>, defaultReasoningEffort: ReasoningEffort, inputModalities: Array<InputModality>, supportsPersonality: boolean,

multiAgentVersion: MultiAgentVersion | null,

additionalSpeedTiers: Array<string>, serviceTiers: Array<ModelServiceTier>,

defaultServiceTier: string | null, isDefault: boolean, };

export type ModelAvailabilityNux = { message: string, };

export type ModelListParams = {

cursor?: string | null,

limit?: number | null,

includeHidden?: boolean | null, };

export type ModelListResponse = { data: Array<Model>,

nextCursor: string | null, };

export type ModelServiceTier = { id: string, name: string, description: string, };

export type ModelUpgradeInfo = { model: string, upgradeCopy: string | null, modelLink: string | null, migrationMarkdown: string | null,

retirementAt: number | null, };

export type MultiAgentVersion = "disabled" | "v1" | "v2";

export type NetworkAccess = "restricted" | "enabled";

export type NonSteerableTurnKind = "review" | "compact";

export type OverriddenMetadata = { message: string, overridingLayer: ConfigLayerMetadata, effectiveValue: JsonValue, };

export type PatchApplyStatus = "inProgress" | "completed" | "failed" | "declined";

export type PatchChangeKind = { "type": "add" } | { "type": "delete" } | { "type": "update", move_path: string | null, };

export type ReasoningEffortOption = { reasoningEffort: ReasoningEffort, description: string, };

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type SandboxPolicy = { "type": "dangerFullAccess" } | { "type": "readOnly", networkAccess: boolean, } | { "type": "externalSandbox", networkAccess: NetworkAccess, } | { "type": "workspaceWrite", writableRoots: Array<AbsolutePathBuf>, networkAccess: boolean, excludeTmpdirEnvVar: boolean, excludeSlashTmp: boolean, };

export type SandboxWorkspaceWrite = { writable_roots: Array<string>, network_access: boolean, exclude_tmpdir_env_var: boolean, exclude_slash_tmp: boolean, };

export type SessionSource = "cli" | "vscode" | "exec" | "appServer" | { "custom": string } | { "subAgent": SubAgentSource } | "unknown";

export type SortDirection = "asc" | "desc";

export type SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed";

export type TextElement = {

byteRange: ByteRange,

placeholder: string | null, };

export type Thread = {
id: string, 
sessionId: string, 
forkedFromId: string | null, 
parentThreadId: string | null, 
preview: string, 
ephemeral: boolean, 
section: ThreadSection | null, 
sectionEnteredAt: number | null, 
projectId: string | null, 
historyMode: ThreadHistoryMode, 
modelProvider: string, 
model: string | null, 
reasoningEffort: ReasoningEffort | null, 
createdAt: number, 
updatedAt: number, 
recencyAt: number | null, 
status: ThreadStatus, 
path: string | null, 
cwd: AbsolutePathBuf, 
cliVersion: string, 
originator: string | null, 
source: SessionSource, 
threadSource: ThreadSource | null, 
agentNickname: string | null, 
agentRole: string | null, 
gitInfo: GitInfo | null, 
name: string | null, 
turns: Array<Turn>};

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadForkParams = {threadId: string, 
lastTurnId?: string | null, 
model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, 
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, baseInstructions?: string | null, developerInstructions?: string | null, ephemeral?: boolean, 
threadSource?: ThreadSource | null, 
excludeTurns?: boolean};

export type ThreadForkResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, cwd: AbsolutePathBuf, 
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, 
approvalsReviewer: ApprovalsReviewer, 
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null};

export type ThreadHistoryMode = "legacy" | "paginated";

export type ThreadItem = { "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "hookPrompt", id: string, fragments: Array<HookPromptFragment>, } | { "type": "agentMessage", id: string, text: string, phase: MessagePhase | null, memoryCitation: MemoryCitation | null, delivery: AgentMessageDelivery | null, questions: Array<AsyncUserInputQuestion> | null, } | { "type": "functionCallOutput", id: string, name: string, namespace: string | null, output: FunctionCallOutputBody, } | { "type": "plan", id: string, text: string, } | { "type": "reasoning", id: string, summary: Array<string>, content: Array<string>, } | { "type": "commandExecution", id: string,

pluginId: string | null,

scriptPath: string | null,

command: string,

cwd: LegacyAppPathString,

processId: string | null, source: CommandExecutionSource, status: CommandExecutionStatus,

commandActions: Array<CommandAction>,

aggregatedOutput: string | null,

exitCode: number | null,

durationMs: number | null, } | { "type": "fileChange", id: string, changes: Array<FileUpdateChange>, status: PatchApplyStatus, } | { "type": "mcpToolCall", id: string, server: string, tool: string, status: McpToolCallStatus, arguments: JsonValue, appContext: McpToolCallAppContext | null,

mcpAppResourceUri?: string, pluginId: string | null, readOnlyHint: boolean | null, result: McpToolCallResult | null, error: McpToolCallError | null,

durationMs: number | null, } | { "type": "dynamicToolCall", id: string, namespace: string | null, tool: string, arguments: JsonValue, status: DynamicToolCallStatus, contentItems: Array<DynamicToolCallOutputContentItem> | null, success: boolean | null,

durationMs: number | null, } | { "type": "collabAgentToolCall",

id: string,

tool: CollabAgentTool,

status: CollabAgentToolCallStatus,

senderThreadId: string,

receiverThreadIds: Array<string>,

prompt: string | null,

model: string | null,

reasoningEffort: ReasoningEffort | null,

agentsStates: { [key in string]?: CollabAgentState }, } | { "type": "subAgentActivity", id: string, kind: SubAgentActivityKind, agentThreadId: string, agentPath: string, } | { "type": "webSearch" } & WebSearchItem | { "type": "imageView", id: string, path: LegacyAppPathString, } | { "type": "sleep" } & SleepItem | { "type": "imageGeneration" } & ImageGenerationItem | { "type": "enteredReviewMode", id: string, review: string, } | { "type": "exitedReviewMode", id: string, review: string, } | { "type": "contextCompaction", id: string, };

export type ThreadItemEntry = {

turnId: string, item: ThreadItem, };

export type ThreadItemsListParams = { threadId: string,

turnId?: string | null,

cursor?: string | null,

limit?: number | null,

sortDirection?: SortDirection | null, };

export type ThreadItemsListResponse = { data: Array<ThreadItemEntry>,

nextCursor: string | null,

backwardsCursor: string | null, };

export type ThreadReadParams = { threadId: string,

includeTurns?: boolean, };

export type ThreadReadResponse = { thread: Thread, };

export type ThreadResumeParams = {threadId: string, 
model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, 
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, baseInstructions?: string | null, developerInstructions?: string | null, personality?: Personality | null, 
excludeTurns?: boolean};

export type ThreadResumeResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, cwd: AbsolutePathBuf, 
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, 
approvalsReviewer: ApprovalsReviewer, 
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null, 
turnsBackwardsCursor: string | null, 
itemsBackwardsCursor: string | null};

export type ThreadSection = {

id: string,

name: string,

appearance: ThreadSectionAppearance | null, };

export type ThreadSectionAppearance = { icon: string | null, color: string | null, };

export type ThreadSource = string;

export type ThreadStartParams = {model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null, 
approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, serviceName?: string | null, baseInstructions?: string | null, developerInstructions?: string | null, personality?: Personality | null, ephemeral?: boolean | null, sessionStartSource?: ThreadStartSource | null, 
threadSource?: ThreadSource | null};

export type ThreadStartResponse = {thread: Thread, model: string, modelProvider: string, serviceTier: string | null, cwd: AbsolutePathBuf, 
instructionSources: Array<LegacyAppPathString>, approvalPolicy: AskForApproval, 
approvalsReviewer: ApprovalsReviewer, 
sandbox: SandboxPolicy, reasoningEffort: ReasoningEffort | null};

export type ThreadStartSource = "startup" | "clear";

export type ThreadStatus = { "type": "notLoaded" } | { "type": "idle" } | { "type": "systemError" } | { "type": "active", activeFlags: Array<ThreadActiveFlag>, };

export type ThreadTurnsListParams = { threadId: string,

cursor?: string | null,

limit?: number | null,

sortDirection?: SortDirection | null,

itemsView?: TurnItemsView | null, };

export type ThreadTurnsListResponse = { data: Array<Turn>,

nextCursor: string | null,

backwardsCursor: string | null, };

export type ToolsV2 = { web_search: WebSearchToolConfig | null, };

export type Turn = {

id: string,

items: Array<ThreadItem>,

itemsView: TurnItemsView, status: TurnStatus,

error: TurnError | null,

startedAt: number | null,

completedAt: number | null,

durationMs: number | null, };

export type TurnError = { message: string, codexErrorInfo: CodexErrorInfo | null, additionalDetails: string | null,

misalignment: MisalignmentErrorDetails | null, };

export type TurnInterruptParams = { threadId: string, turnId: string, };

export type TurnInterruptResponse = Record<string, never>;

export type TurnItemsView = "notLoaded" | "summary" | "full";

export type TurnStartParams = {threadId: string, clientUserMessageId?: string | null, input: Array<UserInput>, 
turnTrigger?: string | null, toolOutput?: TurnToolOutput | null, 
cwd?: string | null, 
approvalPolicy?: AskForApproval | null, 
approvalsReviewer?: ApprovalsReviewer | null, 
sandboxPolicy?: SandboxPolicy | null, 
model?: string | null, 
serviceTier?: string | null | null, 
serviceTierForTurn?: string | null, 
effort?: ReasoningEffort | null, 
summary?: ReasoningSummary | null, 
personality?: Personality | null, 
outputSchema?: JsonValue | null};

export type TurnStartResponse = { turn: Turn, };

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export type TurnSteerParams = {threadId: string, clientUserMessageId?: string | null, input: Array<UserInput>, 
expectedTurnId: string};

export type TurnSteerResponse = { turnId: string, };

export type TurnToolOutput = { name: string, namespace: string | null, output: FunctionCallOutputBody, };

export type UserInput = { "type": "text", text: string,

text_elements: Array<TextElement>, } | { "type": "image", detail?: ImageDetail, url: string, } | { "type": "localImage", detail?: ImageDetail, path: string, } | { "type": "audio", url: string, } | { "type": "localAudio", path: string, } | { "type": "skill", name: string, path: string, } | { "type": "mention", name: string, path: string, };

export type WebSearchAction = { "type": "search", query: string | null, queries: Array<string> | null, } | { "type": "openPage", url: string | null, } | { "type": "findInPage", url: string | null, pattern: string | null, } | { "type": "other" };

export type WriteStatus = "ok" | "okOverridden";

export type Verbosity = "low" | "medium" | "high";

export type WebSearchContextSize = "low" | "medium" | "high";

export type WebSearchItem = { id: string, query: string, action: WebSearchAction | null,

results: Array<JsonValue> | null, };

export type WebSearchLocation = { country: string | null, region: string | null, city: string | null, timezone: string | null, };

export type WebSearchMode = "disabled" | "cached" | "indexed" | "live";

export type WebSearchToolConfig = { context_size: WebSearchContextSize | null, allowed_domains: Array<string> | null, location: WebSearchLocation | null, };

export interface CodexMethodMap {
  'initialize': { params: InitializeParams; result: InitializeResponse }
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse }
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse }
  'thread/items/list': { params: ThreadItemsListParams; result: ThreadItemsListResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse }
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse }
  'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse }
  'config/read': { params: ConfigReadParams; result: ConfigReadResponse }
  'model/list': { params: ModelListParams; result: ModelListResponse }
  'config/batchWrite': { params: ConfigBatchWriteParams; result: ConfigWriteResponse }
  'mcpServerStatus/list': { params: ListMcpServerStatusParams; result: ListMcpServerStatusResponse }
  'account/login/start': { params: LoginAccountParams; result: LoginAccountResponse }
  'account/login/cancel': { params: CancelLoginAccountParams; result: CancelLoginAccountResponse }
  'config/mcpServer/reload': { params: Record<string, never>; result: Record<string, never> }
}

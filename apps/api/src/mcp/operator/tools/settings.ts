import { operatorControlTools } from './operatorControls.js'
import { z } from 'zod'
import { OperatorChatSetupSchema, OperatorChatSetupQuerySchema } from '@foreman-code/contracts'
import { operatorChatTools } from './operatorChat.js'

import {
  CircleAccountAddInputSchema, CircleAccountRemoveInputSchema, ManagedCircleAccountsSchema,
  CircleAccountsUpdateResultSchema,
  WorkerExecutionSettingsSchema,
  ManagedRemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateInputSchema,
  RemoteExecutionSettingsUpdateResultSchema,
  ManagedGeneralSettingsSchema,
  ManagedCircleCreditAllowanceSchema,
  CircleCreditAllowanceUpdateInputSchema,
  CircleCreditAllowanceUpdateResultSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { defineOperatorTool } from '../definition.js'

export const settingsTools = [
  defineOperatorTool({
    name: 'circle_accounts_list',
    requires: [['settings:read', 'global']],
    enabled: services => !!services.circleAccounts,
    description: 'Read primary and standby CircleCI logins, organization status, observed authentication/readiness, '
      + 'per-org scheduling role and estimated credits from the dispatch fleet. organizations contains saved bindings; '
      + 'orgs includes automatically discovered primary organizations. Usage exports are sampled at most '
      + 'every three hours and readings are usable for four hours from their export window end. '
      + 'Local human setup provisions API tokens in private CLI profiles outside Foreman; no credentials are returned.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedCircleAccountsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: context => context.services.circleAccounts!.get(context.principal),
  }),
  defineOperatorTool({
    name: 'circle_account_add',
    requires: [['settings:update', 'global']],
    enabled: services => !!services.circleAccounts,
    description: 'Register or update nonsecret CircleCI account metadata: one stable default primary login and '
      + 'one standby login, each with three distinct GitHub org owners. An omitted role defaults to standby. '
      + 'Missing local credentials do not prevent registration. Local human setup provisions the token outside '
      + 'Foreman. No token argument is accepted. Omit expectedRevision for last write wins or supply it to reject '
      + 'stale metadata; reuse commandId with identical input after an uncertain save. Read back with circle_accounts_list.',
    // Retain strict validation so an accidental credential argument is rejected before command persistence.
    inputSchema: { '~standard': CircleAccountAddInputSchema['~standard'] }, outputSchema: CircleAccountsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.circleAccounts!.add(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'circle_account_remove',
    requires: [['settings:update', 'global']],
    enabled: services => !!services.circleAccounts,
    description: 'Remove the standby CircleCI registration after assigned jobs and result collection settle. '
      + 'The default primary identity cannot be removed. Historical records and private CLI profiles remain; '
      + 'local human cleanup revokes the token separately. Optional expectedRevision rejects stale metadata; '
      + 'commandId supports identical retries. Read back with circle_accounts_list.',
    inputSchema: { '~standard': CircleAccountRemoveInputSchema['~standard'] }, outputSchema: CircleAccountsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.circleAccounts!.remove(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'worker_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workerExecution,
    description: 'Read whether Main permits execution on connected Worker computers. Requires global settings:read. Use remote_execution_settings_get/update to change persisted settings. Explicit environment overrides remain controlled at startup. History, cancellation and cleanup remain available through their existing permissions.',
    inputSchema: z.object({}).strict(),
    outputSchema: WorkerExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context) => context.services.workerExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Read Main’s persisted remote execution and device listener settings, revision, effective values, '
      + 'explicit environment overrides and listener runtime status. Requires global settings:read. '
      + 'TLS file paths refer to Main; certificate and key contents are never returned.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedRemoteExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.remoteExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Replace Main’s persisted global remote execution and device listener settings. Requires global '
      + 'settings:update. Omit expectedRevision for last write wins; supply it to reject a stale revision. Reuse commandId with identical '
      + 'input after an uncertain save. Explicit environment values override saved values. TLS certificate/key paths '
      + 'must name owner-only files owned by Main’s OS user. Execution enablement applies live. Listener changes '
      + 'apply live when no computers are connected; otherwise restart Main. Read back effective values and '
      + 'restartRequired with remote_execution_settings_get. This grants no device, harness or workflow permissions.',
    inputSchema: RemoteExecutionSettingsUpdateInputSchema, outputSchema: RemoteExecutionSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.remoteExecution!.update(context.principal, 'mcp', input),
  }),
  ...operatorControlTools,
  ...operatorChatTools,
  defineOperatorTool({
    name: 'operator_mcp_setup_get',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Check the Operator Foreman Code MCP installation, configured endpoint and managed credential arrangement. Omit selectors to inspect current defaults; supply conversationId to inspect its pinned configuration, and requestId to inspect an accepted message configuration. configurationVersionId, harness and expectedDefaultsRevision retain the shared setup query checks. Conversation selectors require owner-bound operator_chat:read; private configuration pins require owned history or a live authorized chat binding. Requires global harnesses:read. Native chat-derived callers need a live submitted owner-bound turn and current parent grants. Claude inspects the selected Main or paired Worker profile with read authority and no model input. This does not install MCP, issue credentials, grant execution authority or prove a per-turn connection.',
    inputSchema: OperatorChatSetupQuerySchema, outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.operatorChat!.setup(context.principal, input),
  }),
  defineOperatorTool({
    name: 'system_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the app-wide System prompt and its revision. It is prepended to newly started workflow '
      + 'and Agent chat sessions for Codex and Claude. The Operator is excluded. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getSystemPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'system_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the app-wide System prompt for newly started Codex and Claude workflow and Agent chat '
      + 'sessions. Existing sessions keep their saved revision; the Operator is excluded. Requires global '
      + 'settings:update. Omit expectedRevision for last write wins; supply it to reject a stale revision. Retry an uncertain save with the same '
      + 'commandId and input, then read back with system_prompt_get. Empty text clears the prompt.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateSystemPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the Operator own Initial prompt and revision. Newly created Operator conversations '
      + 'use this text; they do not receive the app-wide System prompt. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getOperatorInitialPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the Operator own Initial prompt for new conversations. Existing conversations keep '
      + 'their saved revision. Requires global settings:update. Omit expectedRevision for last write wins; supply it to reject a stale revision. '
      + 'Reuse commandId with the same input after an uncertain save. '
      + 'Read back with operator_initial_prompt_get. Empty text clears the custom Initial prompt.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateOperatorInitialPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'general_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read Main’s saved general preferences and revision. Theme is shared by browsers on all computers '
      + 'connected to this Main. Requires global settings:read. Credentials and native profiles remain per computer.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedGeneralSettingsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getGeneralSettings(context.principal),
  }),
  defineOperatorTool({
    name: 'general_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save general preferences on Main for all connected browsers. Requires global settings:update. '
      + 'Omit expectedRevision for last write wins; supply it to reject a stale revision. Reuse commandId with the same input after an uncertain save. '
      + 'Read back with general_settings_get. This does not sync database files, credentials or native profiles.',
    inputSchema: GeneralSettingsUpdateInputSchema, outputSchema: GeneralSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateGeneralSettings(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'circle_credit_allowance_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the monthly CircleCI credit allowance per organization and its revision. defaultMonthlyCredits '
      + '(400,000: the CircleCI Free plan grants each organization that for Linux open-source builds) applies to every '
      + 'organization without an entry in accounts, which is keyed by the GitHub owner of the CircleCI org. '
      + 'ci_computers_list and computer_activity_list report each CircleCI org\u2019s remaining credits as this '
      + 'allowance minus that org\u2019s compute usage this month, excluding storage and other charges. This is reporting '
      + 'only; usage reports never block standby eligibility. Credit refusals allow one coordinated recovery probe '
      + 'after five minutes, keeping the replacement active until CircleCI starts the probe job. Exports are sampled at most every '
      + 'three hours; readings are usable for four hours from export window end. Primary and standby orgs '
      + 'have separate usage estimates. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedCircleCreditAllowanceSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getCircleCreditAllowance(context.principal),
  }),
  defineOperatorTool({
    name: 'circle_credit_allowance_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Replace the monthly CircleCI credit allowance: defaultMonthlyCredits plus per-organization overrides keyed '
      + 'by the GitHub owner of the CircleCI org. This changes reporting only and never blocks CI starts. '
      + 'Requires global settings:update. Omit expectedRevision for last write wins; supply it to reject a stale '
      + 'revision. Reuse commandId with identical input after an uncertain save. Read back with '
      + 'circle_credit_allowance_get; the new total applies to the next ci_computers_list at once. This grants no CI or credential permissions.',
    inputSchema: CircleCreditAllowanceUpdateInputSchema, outputSchema: CircleCreditAllowanceUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateCircleCreditAllowance(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'agent_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read saved Master, Orchestrator, Worker and Operator defaults and nativeTools loading policy (mcpServers allowlist, apps switch). An omitted Master template uses Orchestrator settings for new Masters. Workflow role graphqlTools are copied only into new Agents: omitted new Master/Orchestrator choices include memory Write, new Worker choices include memory Read; an explicit empty list selects None. Existing Agent configurations retain their original tools. Includes the Operator chat model, harness, Codex or Claude sandbox, effort, and thinking preferences. Unsaved Operator defaults use full access; existing saved settings remain authoritative. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getAgentDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Read defaults copied into newly created workflows, including user, orchestrator or explicit native harness approval handling. Native handling requires compatible saved settings on each Agent. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getWorkflowDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'agent_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Replace role defaults, including an explicit Master template and workflow role graphqlTools. Tool choices affect only new Agents; an empty graphqlTools list selects None, and omitted choices use new-role memory defaults (Master/Orchestrator Write, Worker Read). Existing Agents keep their tools and read-only execution restrictions still apply. Omit expectedRevision for last write wins; supply it to reject a stale revision. nativeTools.mcpServers is the native MCP server allowlist ([] = Foreman Code only); nativeTools.apps controls apps/connectors and Claude SDK plugins. Omitted policy fields inherit host settings. Foreman Code stays available under existing grants. These settings are copied into new Agents and pinned into new Operator conversations. Read agent_defaults_get to verify persisted settings. Includes the Operator sandbox or permission rules shared by chat and Settings > Agents > Operator. Codex and Claude support explicit danger-full-access. Access choices do not grant app authority or bypass native qualification and approval routing. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Requires global settings:update; changing Operator skills, harness, thinking or native-tool settings also requires skills:read in every assigned skill workspace. First local Claude preparation additionally requires harnesses:read and harnesses:update, and runs finite subscription diagnostics for the exact submitted configuration. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateAgentDefaults(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Replace defaults for future workflows. Omit expectedRevision for last write wins; supply it to reject a stale revision. approvalHandler accepts user, orchestrator or native; native handling still requires explicitly configured native approval on each Agent and preserves its permission rules. Existing workflows and in-flight approvals do not change.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateWorkflowDefaults(context.principal, 'mcp', input),
  }),
]

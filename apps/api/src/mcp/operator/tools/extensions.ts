import { requireHarnessOptionsAccountAccess } from '../../../modules/harnesses/harnessOptionsAccess.js'
import { requireAuthorization } from '../../../modules/access/policy.js'
import * as contracts from '@foreman-code/contracts/management'
import { SavedWorkflowVersionPageSchema, SavedWorkflowVersionDetailSchema } from '@foreman-code/contracts/wave25'
import { defineOperatorTool } from '../definition.js'

// Skill tools stay listed for every Operator credential: the service checks grants and
// workspace scope on each call, so a forbidden call returns an audited ACCESS_DENIED
// instead of an unknown-tool error.
const listedForEveryOperator = () => true

export const extendedOperatorTools = [
  defineOperatorTool({
    name: 'harness_configuration_check',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.extensions?.native,
    description: "Check a proposed native configuration without creating a session or model turn.", inputSchema: contracts.NativeConfigurationCheckInputSchema, outputSchema: contracts.NativeConfigurationCheckResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input, { extra }) => context.services.harnesses.checkConfiguration(context.principal, input.configuration, extra.mcpReq.signal),
  }),
  defineOperatorTool({
    name: 'harness_options_get',
    permissionDetail: 'Managed accountBinding also requires provider_accounts:read on its owning target and account.',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.extensions?.native,
    description: "Discover authenticated native model IDs, release dates or native default preference, advertised context windows, supported efforts/variants, native Agents and field support. Claude uses an owned zero-input SDK control query without a model turn; installation and execution qualification remain separate. Optional hostRef selects a connected Worker instead of Main; accountBinding selects its managed profile, otherwise its native login is used. No secrets are returned.", inputSchema: contracts.HarnessOptionsInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: async (context, input) => {
    requireAuthorization(context.principal, 'harnesses:read')
    await requireHarnessOptionsAccountAccess(context.principal, input.accountBinding, context.services.providerAccounts)
    return context.services.extensions!.native.options(input.harness, input.accountBinding, input.hostRef)
  },
  }),
  defineOperatorTool({
    name: 'harness_options_refresh',
    permissionDetail: 'Managed accountBinding also requires provider_accounts:read on its owning target and account.',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.extensions?.native,
    description: "Reread the configured qualified CLI's model catalog without requesting a models.dev cache update. Optional hostRef and accountBinding select the same computer and profile as harness_options_get. Requires harnesses:read.", inputSchema: contracts.HarnessOptionsInputSchema, outputSchema: contracts.HarnessOptionsResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: async (context, input) => {
    requireAuthorization(context.principal, 'harnesses:read')
    await requireHarnessOptionsAccountAccess(context.principal, input.accountBinding, context.services.providerAccounts)
    context.services.harnesses.invalidateChecks()
    return context.services.extensions!.native.refreshOptions(input.harness, 'catalog', input.accountBinding, input.hostRef)
  },
  }),
  defineOperatorTool({
    name: 'harness_mcp_detection_get',
    requires: [['harnesses:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.extensions?.workspace,
    description: "Inspect MCP configuration in the saved workspace directory. Optional hostRef inspects the paired device’s native user configuration through its authenticated Worker; Main is the default. Requires location-read permission.", inputSchema: contracts.HarnessMcpDetectionInputSchema, outputSchema: contracts.HarnessMcpDetectionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: async (context, input) => {
      if (input.hostRef?.kind === 'device') {
        requireAuthorization(context.principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
        const detected = await context.services.harnessSettings!.mcp.detectDevice(context.principal, input.harness,
          input.hostRef, { workspaceId: input.workspaceId })
        return detected
      }
      return context.services.extensions!.workspace.diagnostics(context.principal, input)
    },
  }),
  defineOperatorTool({
    name: 'agent_create',
    requires: [['agents:create', 'workspace'], ['agents:read', 'workspace']],
    enabled: s => !!s.extensions?.agents,
    description: "Create a standalone workspace Agent from an explicit native configuration or a role template. prompt.system holds persistent Agent instructions; assignedSkills lists exact {skillId, version} references from this workspace (skill_list/skill_get), delivered in order after the instructions. Assigning skills needs skills:read; archived, missing or other-workspace skills are rejected. nativeTools overrides the copied role loading policy: mcpServers is an allowlist ([] = Foreman Code only), apps controls apps/connectors and Claude SDK plugins. Omitted policy inherits the role template; {} inherits host settings. Existing credentials do not gain new grants automatically. graphqlTools sets its default Foreman Code MCP tools (absent = every tool its role allows); a workflow node can add/remove tools via its graphqlTools field. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.", inputSchema: contracts.AgentCreateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.agents.create(context.principal,input,'mcp'),
  }),
  defineOperatorTool({
    name: 'agent_update',
    requires: [['agents:update', 'workspace'], ['agents:read', 'workflow']],
    enabled: s => !!s.extensions?.agents,
    permissionDetail: 'Requires workspace-scoped agents:update and agents:read on the workspace or at least one referencing workflow. The service resolves all references and requires graph:read and graph:edit on every referencing workflow. Configuration changes can require harnesses:update or skills:read.',
    description: "Revision-check Agent metadata/configuration. nativeTools replaces native MCP/app loading policy; mcpServers is an allowlist, apps is on/off, {} restores host settings, omission keeps the saved policy. Foreman Code is always available under existing role/access grants. Read agent_list with workflowId or agent_get with workspace Agent-read access to verify persisted policy. graphqlTools replaces its default Foreman Code MCP tools, within its role. Requires authority across every referencing workflow and rejects busy Agents. assignedSkills replaces the ordered exact skill versions; a newer skill version is used only when you set it here. Returns affectedWorkflowIds for every referencing workflow. Re-save those workflows with the returned Agent configuration version before running changed settings. Workflow save updates this Agent’s explicit node placements to the selected profile on the same computer; a different computer is rejected with a node-specific issue. Historical workflow versions and Runs retain their original placements. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.", inputSchema: contracts.AgentUpdateInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.agents.update(context.principal,input,'mcp'),
  }),
  defineOperatorTool({
    name: 'agent_clone',
    requires: [['agents:create', 'workspace'], ['agents:read', 'resource']],
    enabled: s => !!s.extensions?.agents,
    description: "Clone an authorized workspace Agent, including one outside the current board. Does not copy live execution state.", inputSchema: contracts.AgentCloneInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.agents.clone(context.principal,input),
  }),
  defineOperatorTool({
    name: 'workflow_versions_list',
    requires: [['workflows:read', 'workflow']],
    enabled: s => !!s.workflows && !!s.extensions?.history,
    description: "List immutable workflow versions in increasing numeric version order.", inputSchema: contracts.WorkflowVersionListInputSchema, outputSchema: SavedWorkflowVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.history.workflows(context.principal,input),
  }),
  defineOperatorTool({
    name: 'workflow_version_get',
    requires: [['workflows:read', 'workflow']],
    enabled: s => !!s.workflows && !!s.extensions?.history,
    description: "Inspect one immutable current-semantics-3 version. Re-author its definition through workflow_validate_v3 and workflow_save_v3 with today’s exact base/configuration/location pins; historical versions are never edited.", inputSchema: contracts.WorkflowVersionGetInputSchema, outputSchema: SavedWorkflowVersionDetailSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.history.workflow(context.principal,input),
  }),
  defineOperatorTool({
    name: 'agent_configuration_versions_list',
    requires: [['agents:read', 'resource']],
    enabled: s => !!s.extensions?.history,
    description: "List immutable Agent configuration versions. Reading resolved skill contents additionally requires skills:read.", inputSchema: contracts.AgentVersionListInputSchema, outputSchema: contracts.AgentVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.history.agents(context.principal,input),
  }),
  defineOperatorTool({
    name: 'agent_configuration_version_get',
    requires: [['agents:read', 'resource']],
    enabled: s => !!s.extensions?.history,
    description: "Inspect a historical Agent configuration in the authorized workspace. Does not start or change an execution.", inputSchema: contracts.AgentVersionGetInputSchema, outputSchema: contracts.AgentVersionResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.history.agent(context.principal,input),
  }),
  defineOperatorTool({
    name: 'agent_configuration_restore',
    requires: [['agents:update', 'workspace'], ['agents:read', 'workspace']],
    enabled: s => !!s.extensions?.agents,
    description: "Restore historical settings into a new current Agent configuration, with revision, shared-workflow, idle, skill, and native qualification checks.", inputSchema: contracts.AgentVersionRestoreInputSchema, outputSchema: contracts.AgentMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.agents.restore(context.principal,input),
  }),
  defineOperatorTool({
    name: 'workspace_restore',
    requires: [['workspaces:restore', 'workspace']],
    enabled: s => !!s.extensions?.lifecycle,
    description: "Unarchive a workspace with an expected revision. Does not restore its children or start work.", inputSchema: contracts.WorkspaceLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.lifecycle.restoreWorkspace(context.principal,input),
  }),
  defineOperatorTool({
    name: 'workflow_restore',
    requires: [['workflows:restore', 'workflow']],
    enabled: s => !!s.workflows && !!s.extensions?.lifecycle,
    description: "Unarchive a workflow in an active workspace without changing history or starting work.", inputSchema: contracts.WorkflowLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.lifecycle.restoreWorkflow(context.principal,input),
  }),
  defineOperatorTool({
    name: 'agent_archive',
    requires: [['agents:archive', 'workspace']],
    enabled: s => !!s.extensions?.lifecycle,
    description: "Archive an unused idle Agent; reject saved-workflow or active-draft references. Immutable history is retained.", inputSchema: contracts.AgentLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.lifecycle.agent(context.principal,input,true),
  }),
  defineOperatorTool({
    name: 'agent_restore',
    requires: [['agents:restore', 'workspace']],
    enabled: s => !!s.extensions?.lifecycle,
    description: "Restore an archived workspace Agent without launching a native session.", inputSchema: contracts.AgentLifecycleInputSchema, outputSchema: contracts.LifecycleResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.lifecycle.agent(context.principal,input,false),
  }),
  defineOperatorTool({
    name: 'workspace_location_clear',
    requires: [['workspace_locations:update', 'workspace']],
    enabled: s => !!s.extensions?.workspace,
    description: "Clear the location for future Runs using its expected revision. Existing accepted Run snapshots are unchanged.", inputSchema: contracts.LocationClearInputSchema, outputSchema: contracts.LocationClearResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.workspace.clear(context.principal,input),
  }),
  defineOperatorTool({
    name: 'workspace_location_provision',
    requires: [['workspace_locations:provision', 'workspace'], ['workspace_locations:read', 'workspace'], ['workspace_locations:update', 'workspace']],
    enabled: s => !!s.extensions?.workspace?.provisioningEnabled,
    description: "Provision and select one runner-owned workspace directory below the explicitly configured private provisioning root. No arbitrary paths, shell commands, or sandbox expansion.", inputSchema: contracts.LocationProvisionInputSchema, outputSchema: contracts.LocationProvisionResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.workspace.provision(context.principal,input),
  }),
  defineOperatorTool({
    name: 'runner_list',
    requires: [['workspace_locations:read', 'workspace']],
    enabled: s => !!s.extensions?.workspace,
    description: "Discover the available local runner and whether controlled provisioning is configured. Remote dispatch is not supported.", inputSchema: contracts.RunnerListInputSchema, outputSchema: contracts.RunnerListResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.workspace.runners(context.principal,input.workspaceId),
  }),
  defineOperatorTool({
    name: 'skill_list',
    requires: [['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "List logical skills, one row per skill with its current version, name, description and archive state. Omit workspaceId to list every workspace you may read. Never returns instruction bodies; use skill_get.", inputSchema: contracts.SkillListInputSchema, outputSchema: contracts.SkillPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.list(context.principal,input),
  }),
  defineOperatorTool({
    name: 'skill_get',
    requires: [['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "Read a skill's current head and the instructions of its current version, or of one exact immutable version.", inputSchema: contracts.SkillGetInputSchema, outputSchema: contracts.SkillGetResultSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.get(context.principal,input),
  }),
  defineOperatorTool({
    name: 'skill_versions_list',
    requires: [['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "List a skill's immutable versions, newest first, without instruction bodies.", inputSchema: contracts.SkillVersionListInputSchema, outputSchema: contracts.SkillVersionPageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.versions(context.principal,input),
  }),
  defineOperatorTool({
    name: 'skill_create',
    requires: [['skills:publish', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "Create a workspace skill from Markdown instruction text. The server assigns the skill ID and version 1. Text is stored literally: no packages, scripts, URLs or includes. Retry the same commandId after an uncertain reply. Assign it to an Agent by exact version through agent_create/agent_update or the board.", inputSchema: contracts.SkillCreateInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.create(context.principal,input,'mcp'),
  }),
  defineOperatorTool({
    name: 'skill_update',
    requires: [['skills:publish', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "Save a skill's name, description and instructions as a new immutable version. Requires expectedRevision from skill_get/skill_list; a stale revision returns SKILL_REVISION_CONFLICT. An identical save creates no version (changed=false). Existing Agent assignments stay pinned to their versions until explicitly updated; skill_usage_get lists them and skill_users_update moves them and their workflows to the new version.", inputSchema: contracts.SkillUpdateInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.update(context.principal,input,'mcp'),
  }),
  defineOperatorTool({
    name: 'skill_archive',
    requires: [['skills:publish', 'workspace'], ['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "Archive (archived=true) or restore a skill. Requires skills:publish and skills:read in its workspace because the result includes the current version. Archived skills are hidden from default lists and cannot be newly assigned; versions and pinned Agent snapshots are kept.", inputSchema: contracts.SkillArchiveInputSchema, outputSchema: contracts.SkillMutationResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skills.archive(context.principal,input,'mcp'),
  }),
  defineOperatorTool({
    name: 'skill_usage_get',
    requires: [['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "List all Agents still assigned an older version of this skill and affected saved workflows, including older node skill additions and workflows still pinned before a consumer's Agent update. Unrelated Agents and workflows are excluded. Requires skills:read.", inputSchema: contracts.SkillUsageInputSchema, outputSchema: contracts.SkillUsageSchema,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skillUsage.usage(context.principal,input),
  }),
  defineOperatorTool({
    name: 'skill_users_update',
    requires: [['agents:update', 'workspace'], ['skills:read', 'workspace']],
    enabled: s => !!s.extensions?.skills,
    discoverable: listedForEveryOperator,
    description: "Move this skill's Agent assignments and node skill additions to its current version through normal Agent and workflow saves. Requires skills:read, agents:update and the saves' scoped graph/workflow permissions. Unrelated workflow pins are preserved; concurrent configuration changes can cause per-item conflicts. Running Agents keep their saved version. The original head and consumer plan are retained before any child save: retry the same commandId to resume failures or replay the completed result. Use a new commandId to include newer skill versions or new consumers.", inputSchema: contracts.SkillUsersUpdateInputSchema, outputSchema: contracts.SkillUsersUpdateResultSchema,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
    run: (context, input) => context.services.extensions!.skillUsage.updateUsers(context.principal,'mcp',input),
  }),
]

import { COLLABORATION_AGENT_TOOLS, isCollaborationAgentTool, memoryBoardTools, newAgentMemoryBoardAccess } from './collaborationTools.js';
export * from './collaborationTools.js';
import { type WorkflowAgentProductRole, agentProductRoleLabel } from './agentIdentity.js';
import { z } from "zod";

/** Who is calling the one Foreman Code MCP server. Operator credentials manage the app; Worker
 * credentials belong to a workflow Agent whose pinned configuration sets its product role. */
export type GraphqlMcpRole = "operator" | WorkflowAgentProductRole;

export const GRAPHQL_MCP_ROLE_LABELS: Record<GraphqlMcpRole, string> = {
  operator: agentProductRoleLabel("operator"), master: agentProductRoleLabel("master"),
  orchestrator: agentProductRoleLabel("orchestrator"), coder: agentProductRoleLabel("coder"),
};

/** Agent-facing Foreman Code MCP tools. Every other Foreman Code MCP tool is Operator-only and can
 * never be enabled for an Agent. Grants and scope are still checked per call. */
const LEGACY_GRAPHQL_AGENT_TOOLS = {
  bug_report: {
    label: 'Report a bug',
    description: 'Always available to workflow Agents. Report a Foreman Code feature or MCP tool failure. '
      + 'Summarize inputs without secrets; reporter, workspace, time and harness are derived by the server. '
      + 'Requires the scoped reporting grant. Retry the same commandId and input.',
    roles: ['operator', 'master', 'orchestrator', 'coder'],
  },
  'files.references_list': {
    label: 'List references', description: 'List permanent workspace and workflow references inherited by this execution. Scope comes from its credential.',
    roles: ['master', 'orchestrator', 'coder'],
  },
  'files.reference_read': {
    label: 'Read a reference', description: 'Read up to 64 KiB of an inherited reference or an attachment admitted to this exact execution or consultation, using fileId and revisionId. Reading grants no file mutations.',
    roles: ['master', 'orchestrator', 'coder'],
  },
  context_get: { label: "Read run context", description: "Its own identity, role, scope and enabled tools.", roles: ["master", "orchestrator", "coder"] },
  interaction_list: { label: "List interactions", description: "Approval requests in its run.", roles: ["operator", "master", "orchestrator", "coder"] },
  interaction_get: { label: "Read an interaction", description: "One approval request and its options.", roles: ["operator", "master", "orchestrator", "coder"] },
  interaction_respond: { label: "Respond to approvals", description: "Answer user-handled approvals as Operator or assigned approvals as Orchestrator, with scoped response grants.", roles: ["operator", "master", "orchestrator"] },
  "files.native_output_create": {
    label: "Create workflow output", description: "Create an opaque output for this declared workflow turn.",
    roles: ["master", "orchestrator", "coder"],
  },
  "files.native_output_append": {
    label: "Append workflow output", description: "Append bounded bytes to this turn's output.",
    roles: ["master", "orchestrator", "coder"],
  },
  "files.native_output_seal": {
    label: "Seal workflow output", description: "Freeze this turn's output bytes before publication.",
    roles: ["master", "orchestrator", "coder"],
  },
  "files.native_output_publish": {
    label: "Publish workflow output", description: "Publish this turn's sealed output under its saved permissions.",
    roles: ["master", "orchestrator", "coder"],
  },
  ci_run: {
    label: "Run CI",
    description: "Run install, typecheck, lint, unit, build or integration on a build computer. "
      + "Tests the requested commit, the Agent's current files published to GitHub, or the default branch head. "
      + "Edited Agent files use snapshot bundles up to 32 MiB before publication. "
      + "Scope defaults to affected. Omit files for runner selection against the workspace default branch merge-base; "
      + "Priority defaults to normal; callers authorized for ci can request high. CI-only commits are automatically high. "
      + "caller files remain supported with an explicit commit. Missing selectors, shared infrastructure changes and "
      + "the default branch head run the full suite and report the reason. Scope full always runs everything. "
      + "Retry the same commandId and payload. Integration automatically sizes duration-balanced parts to free CI slots; "
      + "partitions caps the count (2–64). Requires the ci action. Newer descendant commits supersede active work of the same "
      + "suite and requester on the same branch or Agent execution. Main and noSupersede=true tickets are kept.",
    roles: ["operator", "master", "orchestrator", "coder"],
  },
  ci_get: { label: "Read CI result", description: "Read any CI ticket in the workspace, including other Agent executions and Runs: state, priority, queue position and waiting reason, current step, computer, exit code and bounded log tail by ticketId. To wait for CI, make one call with waitUntil=group-terminal, waitSeconds=1800 and logTail=false on any ticket of the group instead of polling each ticket: it returns wait.status settled once every ticket of the group is terminal with results collected (partitions then lists each final ticket), or still-running when the budget ends or the client tool deadline approaches (call again). Read logs once at the end with ci_logs_read. Without waitUntil, waitSeconds waits at most 60 seconds for this ticket's next state or step change; request cancellation ends any wait. The tail is included by default. Superseded tickets report supersededBy and a replacement ticket message.", roles: ["operator", "master", "orchestrator", "coder"] },
  ci_computers_list: { label: "List CI computers", description: "Read authorized build computers with readiness, Worker protocol/update readiness reasons, GitHub login, saved build allowance percent, allowed CPU count and memory, used/total CI slots, running CI runs and authorized queued tickets with priority, position and reason.", roles: ["operator", "master", "orchestrator", "coder"] },
  ci_cancel: { label: "Cancel CI", description: "Cancel any queued or running CI ticket in the workspace by ticketId, including other Agent executions and Runs. Requires ci. Poll ci_get to confirm the outcome.", roles: ["operator", "master", "orchestrator", "coder"] },
  ci_logs_read: { label: "Read CI logs", description: "Read CI log text for any ticket in the workspace by ticketId, including other Agent executions and Runs. Omit afterOffset for the last maxBytes, or continue with nextOffset.", roles: ["operator", "master", "orchestrator", "coder"] },
  run_status_get: {
    label: "Read own Run status",
    description: "Read-only, bounded status of this Agent's own Run: Run state, each node's latest execution state, "
      + "the Run's latest CI tickets and recent errors, including AGENT_EXECUTION_STUCK warnings for idle running "
      + "executions whose CI tickets are all terminal. Warnings do not stop executions. "
      + "Available only on workflow nodes with a loop enabled.",
    roles: ["master", "orchestrator", "coder"],
  },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[] }>;

/** Reserved collaboration tools remain dormant until their implemented names are explicitly supplied. */
export const GRAPHQL_AGENT_TOOLS = { ...LEGACY_GRAPHQL_AGENT_TOOLS, ...COLLABORATION_AGENT_TOOLS } as const;

/** Explicit Operator catalog. Listing a tool never supplies a grant or native qualification. */
export const GRAPHQL_OPERATOR_TOOLS = {
  workspace_repository_get: {
    label: 'Read workspace project', description: 'Read the prepared repository or an incomplete import by its original command ID.',
    roles: ['operator'], action: 'read-workspace-repository',
    actions: ['workspaces:read', 'workspace_locations:read', 'sources:read', 'source_roots:read'],
    scope: 'workspace', readOnly: true,
  },
  workspace_repository_add: {
    label: 'Prepare workspace project', description: 'Clone a GitHub project, save its location, approve its tracked snapshot and bind its source in one revision-checked command.',
    roles: ['operator'], action: 'prepare-workspace-repository',
    actions: ['workspaces:read', 'workspaces:update', 'workspace_locations:read', 'workspace_locations:validate',
      'workspace_locations:update', 'workspace_locations:provision', 'sources:read', 'sources:approve', 'source_roots:read', 'source_roots:bind'],
    scope: 'workspace', readOnly: false,
  },
  operator_tool_schema_get: { label: 'Read Operator tool schema', description: 'Read one caller-available tool’s input schema and instructions; output schema is opt-in.', roles: ['operator'], action: 'read-operator-tool-schema', actions: ['capabilities:read'], scope: 'caller', readOnly: true },
  workspace_root_configuration_adopt: { label: "Adopt protected root configuration", description: "Audit adoption of the selected host's approved roots, including private product storage approved by human computer pairing. Arbitrary user paths require explicit local approval; caller paths are not accepted.", roles: ["operator"], action: "adopt-workspace-root-configuration", actions: ["source_roots:bind", "workspace_locations:update"], scope: "workspace", readOnly: false },
} as const satisfies Record<string, { label: string; description: string; roles: readonly GraphqlMcpRole[]; action: string; actions: readonly string[]; scope: "run" | "workspace" | "caller"; readOnly: boolean }>;

export const GraphqlAgentToolSchema = z.enum(
  Object.keys(GRAPHQL_AGENT_TOOLS) as [keyof typeof GRAPHQL_AGENT_TOOLS, ...(keyof typeof GRAPHQL_AGENT_TOOLS)[]],
);
export type GraphqlAgentTool = z.infer<typeof GraphqlAgentToolSchema>;

/** Absent saved defaults retain the legacy role tools; future families require explicit choices. */
export const GraphqlToolDefaultsSchema = z.array(GraphqlAgentToolSchema).max(100)
  .refine((tools) => new Set(tools).size === tools.length, "Foreman Code MCP tools must be unique");

/** A workflow node's tool changes. bug_report remains available even when named in remove. */
export const GraphqlToolOverrideSchema = z.object({
  add: z.array(GraphqlAgentToolSchema).max(100),
  remove: z.array(GraphqlAgentToolSchema).max(100),
}).strict().superRefine((value, context) => {
  const removed = new Set(value.remove);
  for (const [index, tool] of value.add.entries()) {
    if (removed.has(tool)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["add", index], message: "a Foreman Code MCP tool cannot be both added and removed" });
  }
});
export type GraphqlToolOverride = z.infer<typeof GraphqlToolOverrideSchema>;

export function graphqlToolRoles(name: string): readonly GraphqlMcpRole[] {
  return (GRAPHQL_AGENT_TOOLS as Record<string, { roles: readonly GraphqlMcpRole[] }>)[name]?.roles
    ?? (GRAPHQL_OPERATOR_TOOLS as Record<string, { roles: readonly GraphqlMcpRole[] }>)[name]?.roles ?? ["operator"];
}

/** Enabled by a node's interval setting, never by Agent defaults or node tool changes. */
export const GRAPHQL_INTERVAL_TOOLS: readonly GraphqlAgentTool[] = ["run_status_get"];

/** The Agent tools a product role may be given, in catalog order. */
export function graphqlRoleTools(role: WorkflowAgentProductRole, implementedCollaborationTools: readonly string[] = []): GraphqlAgentTool[] {
  return GraphqlAgentToolSchema.options.filter((tool) => graphqlToolRoles(tool).includes(role)
    && !GRAPHQL_INTERVAL_TOOLS.includes(tool)
    && (!isCollaborationAgentTool(tool) || implementedCollaborationTools.includes(tool)));
}

/** Copy only into a newly created Agent. Old absent tool choices retain their legacy meaning. */
export function newAgentGraphqlTools(role: WorkflowAgentProductRole): GraphqlAgentTool[] {
  return [...graphqlRoleTools(role), ...memoryBoardTools(newAgentMemoryBoardAccess(role))];
}

/** Tools named here that the role can never use. */
export function graphqlToolsOutsideRole(role: WorkflowAgentProductRole, tools: readonly string[]): string[] {
  return tools.filter((tool) => !graphqlToolRoles(tool).includes(role));
}

/** Applies saved tool choices within the role. Bug reporting is available to every workflow Agent. */
export function effectiveGraphqlTools(
  role: WorkflowAgentProductRole, defaults?: readonly string[], override?: GraphqlToolOverride, interval = false,
  implementedCollaborationTools: readonly string[] = [],
): GraphqlAgentTool[] {
  const roleTools = graphqlRoleTools(role, implementedCollaborationTools);
  // Missing old defaults retain the old capability set even after new handlers are enabled.
  const enabled = new Set<string>(defaults ?? graphqlRoleTools(role));
  for (const tool of override?.add ?? []) enabled.add(tool);
  for (const tool of override?.remove ?? []) enabled.delete(tool);
  enabled.add('bug_report');
  return [...roleTools.filter((tool) => enabled.has(tool)), ...(interval ? GRAPHQL_INTERVAL_TOOLS : [])];
}

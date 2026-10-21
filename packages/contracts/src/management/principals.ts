import { z } from 'zod'
import { IdSchema, TimestampSchema } from '../schemaPrimitives.js'

const ManagementAudienceSchema = z.enum(["operator", "worker", "user"]);
export type ManagementAudience = z.infer<typeof ManagementAudienceSchema>;

export const ManagementActionSchema = z.enum([
  'provider_accounts:read', 'provider_accounts:manage',
  'bug_reports:report', 'bug_reports:read', 'bug_reports:update',
  "sources:read", "sources:approve", "sources:reconcile", "source_roots:read", "source_roots:bind",
  "job_definitions:read", "job_definitions:write", "jobs:start", "jobs:read", "jobs:cancel", "job_logs:read", "job_artifacts:read",
  'ci', 'jobs:prioritize',
  "agents:create",
  "agents:update",
  "agents:archive",
  "agents:restore",
  "workspaces:restore",
  "workflows:restore",
  "workspace_locations:provision",
  "skills:read",
  "skills:publish",
  "workflow_triggers:read",
  "workflow_triggers:update",
  "workflow_triggers:fire",
  "runs:resume",

  "capabilities:read",
  "operator_chat:read",
  "operator_chat:write",
  "operator_chat:cancel",
  "operator_chat:respond",
  "operator_handoff:read",
  "agent_chat:read",
  "agent_chat:write",
  "agent_chat:cancel",
  "agent_chat:respond",
  "harnesses:read",
  "harnesses:update",
  "devices:read",
  "devices:metrics:read",
  "settings:read",
  "settings:update",
  "workspaces:read",
  "workspaces:create",
  "workspaces:update",
  "workspaces:archive",
  "workspace_locations:read",
  "workspace_locations:validate",
  "workspace_locations:update",
  "workflows:read",
  "workflows:create",
  "workflows:update",
  "workflows:archive",
  "agents:read",
  "graph:read",
  "graph:edit",
  "graph:save",
  "runs:read",
  "runs:start",
  "runs:stop",
  "runs:subagents:input",
  "interactions:read",
  "interactions:respond",
]);
export type ManagementAction = z.infer<typeof ManagementActionSchema>;

/** The local owner's manage preset includes every supported action. */
export const DEFAULT_MANAGEMENT_ACTIONS = ManagementActionSchema.options;

const ManagementScopeSchema = z
  .object({
    workspaceIds: z.array(IdSchema).max(500).optional(),
    workflowIds: z.array(IdSchema).max(500).optional(),
    runIds: z.array(IdSchema).max(500).optional(),
    mainIds: z.array(z.uuid()).max(500).optional(),
    deviceIds: z.array(z.uuid()).max(500).optional(),
    applicationInstallationIds: z.array(z.uuid()).max(500).optional(),
    providerAccountIds: z.array(z.uuid()).max(500).optional(),
  })
  .strict();
export type ManagementScope = z.infer<typeof ManagementScopeSchema>;

export const ManagementGrantSchema = z
  .object({
    actions: z.array(ManagementActionSchema).min(1),
    scope: ManagementScopeSchema,
  })
  .strict();
export type ManagementGrant = z.infer<typeof ManagementGrantSchema>;

/** Timestamp representation for credentials whose lifetime ends only on revocation. */
export const NON_EXPIRING_CREDENTIAL_TIMESTAMP = '9999-12-31T23:59:59.999Z'

export const ManagementPrincipalSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1),
    audience: ManagementAudienceSchema,
    /** Immutable backend-issued logical Agent subject for worker/App principals. */
    agentId: IdSchema.optional(),
    grants: z.array(ManagementGrantSchema),
    expiresAt: TimestampSchema.describe('Credential expiry; 9999-12-31T23:59:59.999Z means no expiry.'),
    revokedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.audience === "worker" && !value.agentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "worker principals require an immutable Agent subject" });
    }
    if (value.audience !== "worker" && value.agentId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["agentId"], message: "Operator principals do not impersonate board Agents" });
    }
  });
export type ManagementPrincipal = z.infer<typeof ManagementPrincipalSchema>;

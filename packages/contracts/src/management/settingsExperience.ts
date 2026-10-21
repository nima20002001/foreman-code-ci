import { optionalCommandId } from './commands.js'
import { z } from "zod";

const SettingsAgentRoleSchema = z.enum(["operator", "master", "orchestrator", "coder"]);
export type SettingsAgentRole = z.infer<typeof SettingsAgentRoleSchema>;
const HarnessSettingsSectionSchema = z.enum(["model", "permissions", "session", "tools", "connections", "plugins", "workspace"]);
export type HarnessSettingsSection = z.infer<typeof HarnessSettingsSectionSchema>;
export const AgentSettingsSearchSchema = z.object({
  role: SettingsAgentRoleSchema.optional().catch(undefined),
  section: z.enum(["model", "permissions", "session", "tools"]).optional().catch(undefined),
});
export const HarnessSettingsSearchSchema = z.object({
  harness: z.enum(["codex", "claude"]).optional().catch(undefined),
  section: HarnessSettingsSectionSchema.optional().catch(undefined),
  pluginView: z.enum(['installed', 'available']).optional().catch(undefined),
  pluginQuery: z.string().max(100).optional().catch(undefined),
  pluginOffset: z.coerce.number().int().min(0).optional().catch(undefined),
  pluginId: z.string().max(240).optional().catch(undefined),
});
/** Settings → Skills list filters. Selection is part of the route path. */
export const SkillSettingsSearchSchema = z.object({
  workspace: z.string().trim().min(1).max(200).optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  archived: z.boolean().optional().catch(undefined),
});

/** Creation suggestions only. A template never grants filesystem or runner access. */
export const WorkspaceDefaultsSchema = z.object({
  parentPath: z.string().trim().min(1).max(4096).refine((value) => !value.includes("\0"), "Invalid folder path").optional(),
  suggestedName: z.string().trim().min(1).max(200),
  description: z.string().max(10_000),
}).strict();
export type WorkspaceDefaults = z.infer<typeof WorkspaceDefaultsSchema>;
export const DEFAULT_WORKSPACE_DEFAULTS: WorkspaceDefaults = { suggestedName: "New workspace", description: "" };
export const ManagedWorkspaceDefaultsSchema = z.object({
  value: WorkspaceDefaultsSchema,
  revision: z.number().int().nonnegative(),
  versionId: z.string().min(1).nullable(),
}).strict();
export const WorkspaceDefaultsUpdateInputSchema = z.object({
  value: WorkspaceDefaultsSchema,
  commandId: optionalCommandId(z.string().trim().min(8).max(200)),
  expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
}).strict();
export type WorkspaceDefaultsUpdateInput = z.infer<typeof WorkspaceDefaultsUpdateInputSchema>;
export const WorkspaceDefaultsUpdateResultSchema = z.object({
  value: ManagedWorkspaceDefaultsSchema, replayed: z.boolean(),
}).strict();

import { z } from 'zod'
import { ManagedWorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema, WorkspaceDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { defineOperatorTool } from '../definition.js'

export const workspaceDefaultsTools = [
  defineOperatorTool({
    name: 'workspace_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the default parentPath, suggested name and starting description for new workspaces. '
      + 'An unavailable saved parent returns WORKSPACE_DEFAULT_UNAVAILABLE with its saved path and revision; '
      + 'it is never replaced by another folder. Pass parentPath to workspace_create to create a project folder. '
      + 'Reading defaults does not grant filesystem access.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkspaceDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getWorkspaceDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'workspace_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save workspace creation defaults. Omit expectedRevision for last write wins; supply it to reject a stale revision. Existing workspaces, paths and grants are unchanged.',
    inputSchema: WorkspaceDefaultsUpdateInputSchema, outputSchema: WorkspaceDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateWorkspaceDefaults(context.principal, 'mcp', input),
  }),
]

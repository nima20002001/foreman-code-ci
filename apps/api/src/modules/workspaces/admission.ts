import type { GraphSqlClient } from '../run-graph/connection.js'

import { DomainError } from '../errors.js'

/**
 * Child mutations and archive share this admission lock. Acquire it before
 * workspace, workflow, draft, or agent row locks, never after them.
 */
export async function lockActiveWorkspace(client: GraphSqlClient, workspaceId: string): Promise<void> {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${workspaceId}`])
  const workspace = await client.query<{ archived_at: Date | null }>(
    'select archived_at from workspaces where id = $1 for share', [workspaceId],
  )
  if (!workspace.rows[0]) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
  if (workspace.rows[0].archived_at) throw new DomainError('WORKSPACE_ARCHIVED', 'Archived workspaces cannot be edited.', 409)
}

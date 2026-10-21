import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'

it.each([1, 100])('uses a constant five domain queries to archive %i workflows', async (size) => {
  const workflows = Array.from({ length: size }, (_, index) => ({ workflowId: `workflow-${index}`, expectedRevision: 0 }))
  const query = vi.fn(async (sql: string) => ({ rows:
    sql.includes('select archived_at') ? [{ archived_at: null }]
      : sql.includes('select id, revision') ? workflows.map((item) => ({ id: item.workflowId, revision: '0' })) : [],
  }))
  const client = { query } as unknown as pg.PoolClient
  const commands = { execute: async (input: { perform: (client: pg.PoolClient) => Promise<unknown> }) => input.perform(client) } as unknown as PostgresCommandCoordinator
  const service = new WorkflowManagementService({} as pg.Pool, commands)
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['workflows:archive'], scope: {} }] }
  await service.archiveBatch(principal, 'http', { workspaceId: 'workspace', commandId: 'batch-query-count', workflows })
  expect(query).toHaveBeenCalledTimes(5)
  expect(query.mock.calls.filter(([sql]) => sql.startsWith('update workflows'))).toHaveLength(1)
})

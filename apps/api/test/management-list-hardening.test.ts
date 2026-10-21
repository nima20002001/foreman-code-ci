import assert from 'node:assert/strict'
import { test } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { authorizedPage } from '../src/modules/access/authorizedPage.js'

const principal = ManagementPrincipalSchema.parse({
  id: 'principal-a', name: 'Narrow reader', audience: 'operator', revokedAt: null,
  expiresAt: '2100-01-01T00:00:00.000Z',
  grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['workspace-a'], runIds: ['run-150', 'run-151'] } }],
})
const records = Array.from({ length: 200 }, (_, index) => ({
  id: `run-${String(index).padStart(3, '0')}`, workspaceId: 'workspace-a', workflowId: 'workflow-a',
}))
test('F20 run-scoped readers can list their exact resources after hidden pages', async () => {
  const page = await authorizedPage({
    principal, action: 'runs:read', limit: 1,
    read: async (cursor, limit) => records.filter((row) => cursor === undefined || row.id > cursor).slice(0, limit),
    id: (row) => row.id,
    resource: (row) => ({ workspaceId: row.workspaceId, workflowId: row.workflowId, runId: row.id }),
  })
  assert.deepEqual(page.items.map((row) => row.id), ['run-150'])
  assert.equal(page.pageInfo.nextCursor, 'run-150')
})
test('F20 expired readers are rejected before any resource read', async () => {
  await assert.rejects(authorizedPage<{ id: string }>({
    principal: { ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }, action: 'runs:read', limit: 1,
    read: async () => { throw new Error('Must not read resources') },
    id: (row) => row.id, resource: (row) => ({ runId: row.id }),
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ACCESS_DENIED')
})

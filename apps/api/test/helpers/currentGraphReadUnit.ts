import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'
import { canonicalRunGraphReadApi } from '../../src/modules/run-graph/repeatReadService.js'
import { ProjectionDatabase, projectionScope } from '../eng04-projection-fixture.js'

export const currentGraphRequest = { protocolVersion: 1 as const, scope: projectionScope }
export function currentGraphPrincipal(read = true): ManagementPrincipal {
  return { id: 'unit-current-reader', name: 'Current graph reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: read
      ? [{ actions: ['runs:read'], scope: { workspaceIds: [projectionScope.workspaceId],
        workflowIds: [projectionScope.workflowId], runIds: [projectionScope.runId] } }] : [] }
}
export async function currentGraphReadUnit() {
  const db = new ProjectionDatabase()
  db.fixture.run.input = { canary: 'PRIVATE-RUN-INPUT-NOT-CURRENT-GRAPH' }
  await db.initialize()
  const reads = new RunGraphReadService(db.pool(), { qualifiedReads: true })
  return { db, reads, canonical: canonicalRunGraphReadApi(reads), request: currentGraphRequest, principal: currentGraphPrincipal() }
}

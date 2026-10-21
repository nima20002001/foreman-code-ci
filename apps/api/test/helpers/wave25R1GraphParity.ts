import type pg from 'pg'
import { expect } from 'vitest'
import { reduceRepeatGraphPageV3, type RepeatGraphScopeV3, type RepeatGraphSnapshotV3 } from '@foreman-code/contracts/wave25'
import { RunGraphReadService } from '../../src/modules/run-graph/readService.js'

/** Actual read service plus the COMPLETE frozen reference consumer. No fact
 * filtering, activity-only reducer, SQL mutation, or sorting-away differences. */
export async function graphParity(pool: pg.Pool, scope: RepeatGraphScopeV3, initial?: RepeatGraphSnapshotV3) {
  const reads = new RunGraphReadService(pool, { qualifiedReads: true })
  const principal = { id: 'r1-parity-reader', name: 'Synthetic reader', audience: 'operator' as const,
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['runs:read' as const], scope: { workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId], runIds: [scope.runId] } }] }
  const request = { protocolVersion: 1 as const, scope }
  let replayed = initial ?? await reads.snapshot(principal, request)
  return { compare: async () => {
    for (;;) {
      const page = await reads.events(principal, { ...request, afterSequence: replayed.asOfSequence })
      expect(page.kind).toBe('page')
      if (page.kind !== 'page') throw new Error('Unexpected graph reset in bounded parity fixture')
      replayed = reduceRepeatGraphPageV3(replayed, page)
      if (!page.hasMore) break
    }
    const fresh = await reads.snapshot(principal, request)
    expect(replayed.state).toEqual(fresh.state)
    expect(replayed.scope).toEqual(fresh.scope)
    expect(replayed.topology).toEqual(fresh.topology)
    expect(replayed.asOfSequence).toBe(fresh.asOfSequence)
    expect(replayed.retentionFloor).toBe(fresh.retentionFloor)
    expect(replayed.historyCoverage).toBe(fresh.historyCoverage)
    return fresh
  } }
}

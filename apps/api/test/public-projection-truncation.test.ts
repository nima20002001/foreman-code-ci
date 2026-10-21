import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, type NodeResolution, type RunGraphScope } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { readPublicNodeProjection } from '../src/modules/run-graph/publicProjection.js'

it('reads the newest bounded resolutions without failing on an extra row', async () => {
  const saved = makeCurrentWorkflowFixture('projection-truncation', 'single')
  const nodeId = saved.identities[0]!.workflowNodeId
  const scope: RunGraphScope = { workspaceId: saved.run.workspaceId, workflowId: saved.run.workflowId,
    workflowVersionId: saved.version.id, runId: saved.run.id, executionSemanticsVersion: 3 }
  const newest: NodeResolution = { workflowNodeId: nodeId, resolution: 'skipped', branchEnded: false,
    selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: '2026-01-02T00:00:00.000Z' }
  const rows = [newest, ...Array.from({ length: 2000 }, () => ({ ...newest,
    resolution: 'excluded' as const, resolvedAt: '2026-01-01T00:00:00.000Z' }))]
    .map(value => ({ record: { value } }))
  const empty = { rows: [], rowCount: 0 }
  const query = vi.fn().mockResolvedValue(empty)
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({ rows: [{ closed: false, cleanup_pending: false }], rowCount: 1 })
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce(empty)
    .mockResolvedValueOnce({ rows, rowCount: rows.length })
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  const counts = new Map([[nodeId, { pendingInteractionCount: 0, unsettledReviewCount: 0,
    cleanupPending: false, deliveryBlocked: false }]])
  const nodes = await connection.transaction(sql =>
    readPublicNodeProjection(sql, scope, [nodeId], { native: [] }, counts), true)
  expect(nodes).toHaveLength(1)
  expect(nodes[0]?.resolution).toEqual(newest)
  expect(nodes[0]?.state.lifecycle).toBe('skipped')
})

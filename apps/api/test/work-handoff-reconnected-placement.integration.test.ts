import { describe, expect, it } from 'vitest'
import { handoffPlacementFixture } from './helpers/handoffPlacementFixture.js'
import { waitForHandoffCompletion } from './helpers/handoffCompletion.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

describe('handed-off node placement after a Worker reconnect', () => {
  it('runs the coordinator and all three Agents after requalification and reads success through MCP', async () => {
    const f = await handoffPlacementFixture()
    try {
      const accepted = await f.start()
      const finished = await waitForHandoffCompletion(f, 'all three handed-off Agents finish').catch(async error => {
        const events = await f.base.client.callTool({ name: 'run_events_list', arguments: { workspaceId: f.startInput.workspaceId, runId: accepted.run.id, limit: 200 } })
        console.error('DEBUGDISPATCH', JSON.stringify(f.base.dispatchErrors.map(String)), 'DEBUGEVENTS', JSON.stringify(events).slice(0, 12000))
        throw error
      })
      expect(finished.run, JSON.stringify(finished.run.result)).toMatchObject({ outcome: 'succeeded' })
      expect(finished.executions).toHaveLength(4)
      expect(finished.executions.every(execution => execution.result?.outcome === 'succeeded')).toBe(true)
      expect(new Set(f.base.provider.startedNodes)).toEqual(new Set([f.coordinator.id, ...f.workers.map(node => node.id)]))
      const requests = (await f.base.db.pool.query<{ destination_node_id: string }>(
        'select destination_node_id from run_work_requests where run_id=$1', [accepted.run.id])).rows
      expect(new Set(requests.map(request => request.destination_node_id))).toEqual(new Set(f.workers.map(node => node.id)))
      const placements = (await f.base.db.pool.query<{ record: { hostRef: unknown } }>(
        'select record from run_node_placements where run_id=$1', [accepted.run.id])).rows
      expect(new Set(placements.map(row => JSON.stringify(row.record.hostRef))).size).toBe(3)
      const cleanup = await f.base.db.pool.query('select 1 from run_cleanup_intents where run_id=$1 and failure_result is not null',
        [accepted.run.id])
      expect(cleanup.rowCount).toBe(0)
      const reader = await f.base.access.issue({ name: 'Unscoped Run reader', audience: 'operator',
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }] })
      const denied = await f.base.connect(reader.token)
      await expectMcpAccessDenied(denied.callTool({ name: 'run_get', arguments: {
        workspaceId: f.startInput.workspaceId, runId: accepted.run.id,
      } }))
    } finally { await f.close() }
  }, 60_000)

  it('records the real profile error on its node while healthy sibling Agents finish', async () => {
    const f = await handoffPlacementFixture({ checkOutcome: 'failed' })
    try {
      const accepted = await f.start()
      const finished = await waitForHandoffCompletion(f, 'profile failure and healthy sibling completion')
      expect(finished.executions).toHaveLength(4)
      const failed = finished.executions.find(execution => execution.workflowNodeId === f.workers[1]!.id)
      expect(failed).toMatchObject({ state: 'completed', result: { outcome: 'failed', error: {
        code: 'HARNESS_PROFILE_UNAVAILABLE', message: 'The native profile check failed.', retryable: false,
      } } })
      expect(finished.run).toMatchObject({ outcome: 'failed', result: failed!.result })
      const siblings = finished.executions.filter(execution => execution.workflowNodeId !== f.coordinator.id
        && execution.workflowNodeId !== f.workers[1]!.id)
      expect(siblings).toHaveLength(2)
      expect(siblings.every(execution => execution.state === 'completed'
        && execution.result?.outcome === 'succeeded')).toBe(true)
      expect(f.base.provider.startedNodes).toHaveLength(3)
      expect(new Set(f.base.provider.startedNodes)).toEqual(new Set([
        f.coordinator.id, f.workers[0]!.id, f.workers[2]!.id,
      ]))
      expect((await f.base.db.pool.query('select stop_requested_at from runs where id=$1', [accepted.run.id]))
        .rows[0]?.stop_requested_at).toBeNull()
    } finally { await f.close() }
  }, 60_000)
})

import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, completedRun } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: workflow-readback', { timeout: 120000 }, () => {
  it('persists completed Run checkpoints in the fixture database used by authenticated readback', async () => {
    const f = await setup()
    const detail = await completedRun(f)
    const checkpoints = await f.db.pool.query<{ thread_id: string }>(`
      select distinct thread_id from "${f.db.schema}_cp".checkpoints where thread_id=$1`, [detail.run.id])
    expect(checkpoints.rows).toEqual([{ thread_id: detail.run.id }])

    const readback = await f.call('run_get', {
      workspaceId: detail.run.workspaceId,
      runId: detail.run.id,
      detail: 'full',
    })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).run).toEqual(detail.run)
  })

  it('waits for cleanup activity when a successful HTTP snapshot precedes final settlement', async () => {
    const f = await setup()
    let suppliedEarlySnapshot = false
    const detail = await completedRun({
      ...f,
      http: async (...args) => {
        const response = await f.http(...args)
        if (args[0] !== 'GET' || suppliedEarlySnapshot) return response
        const snapshot = SavedRunDetailsSchema.parse(response.json())
        if (snapshot.run.outcome !== 'succeeded') return response
        suppliedEarlySnapshot = true
        // Success can be saved before the cleanup intent and its final activity.
        snapshot.cleanupPending = false
        snapshot.activity = snapshot.activity.filter((event) => event.kind !== 'run_cleanup_checked')
        return { ...response, json: <T>() => snapshot as T }
      },
    })
    expect(suppliedEarlySnapshot).toBe(true)
    expect(detail.cleanupPending).toBe(false)
    expect(detail.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run_cleanup_checked', payload: expect.objectContaining({ failed: false }) }),
    ]))
    const readback = await f.call('run_get', {
      workspaceId: detail.run.workspaceId,
      runId: detail.run.id,
      detail: 'full',
    })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(detail.activitySnapshot)
  })

  it('Workflow: real Run snapshot/cursor and denied caller preserve original execution and delivery evidence', async () => {
    const f = await setup(), detail = await completedRun(f)
    expect(detail.activitySnapshot!.scope).toEqual({ kind: 'workflow_run', workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId })
    expect(detail.activitySnapshot!.active).toEqual([])
    const readback = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(detail.activitySnapshot)
    const activity = await f.call('run_activities_get_v1', { workspaceId: detail.run.workspaceId, runId: detail.run.id, limit: 10 })
    expect(activity.isError).not.toBe(true)
    expect(decodeMcpToolResult(activity)).toMatchObject({ scope: { workspaceId: detail.run.workspaceId,
      workflowId: detail.run.workflowId, runId: detail.run.id, workflowVersionId: detail.run.workflowVersionId } })
    expect(decodeMcpToolResult(activity)).not.toHaveProperty('activitySnapshot')
    const denied = await f.call('run_get', { workspaceId: detail.run.workspaceId, runId: detail.run.id }, f.denied.token)
    expect(denied.isError).toBe(true)
    await f.access.revoke(f.writer.principal.id)
    const revoked = await f.http('GET', `/api/management/workspaces/${detail.run.workspaceId}/runs/${detail.run.id}`)
    expect(revoked.statusCode).toBe(401)
    expect(f.replay.responses).toHaveLength(0)
    expect((await f.db.pool.query('select count(*)::int as count from harness_executions where run_id=$1', [detail.run.id])).rows[0]!.count)
      .toBe(detail.executions.length)
  })
})

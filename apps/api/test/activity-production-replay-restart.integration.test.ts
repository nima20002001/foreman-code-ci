import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManualRunStartResultSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { vi } from 'vitest'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import * as workflowLifecycle from '../src/modules/runs/workflowLifecycle.js'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, eventually, completedRun } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: restart', { timeout: 120000 }, () => {
  it('retains a completed Run and authenticated readback when production reopens its fixture database', async () => {
    const f = await setup()
    const completed = await completedRun(f)
    const { workspaceId, id: runId } = completed.run
    const starts = structuredClone(f.replay.starts)
    await f.restart()
    await f.reconcile()
    const response = await f.http('GET', `/api/management/workspaces/${workspaceId}/runs/${runId}`)
    expect(response.statusCode, response.body).toBe(200)
    const detail = SavedRunDetailsSchema.parse(response.json())
    expect(detail.run).toEqual(completed.run)
    expect(detail.executions).toEqual(completed.executions)
    const readback = await f.call('run_get', { workspaceId, runId, detail: 'full' })
    expect(readback.isError).not.toBe(true)
    expect(SavedRunDetailsSchema.parse(decodeMcpToolResult(readback)).run).toEqual(completed.run)
    const denied = await f.call('run_get', { workspaceId, runId }, f.denied.token)
    expect(denied.isError).toBe(true)
    expect(f.replay.starts).toEqual(starts)
  })

  for (const boundary of ['queued successor', 'native terminal'] as const) {
    it(`restarts the actual engine at a ${boundary} without replaying native work`, async () => {
      const f = await setup({ form: 'sequential', handoffs: true })
      let queued!: () => void
      let release!: () => void
      const successorQueued = new Promise<void>((resolve) => { queued = resolve })
      const pause = new Promise<void>((resolve) => { release = resolve })
      let classified!: () => void
      const restartClassified = new Promise<void>((resolve) => { classified = resolve })
      const preserve = workflowLifecycle.settleWorkForRestart
      const classification = vi.spyOn(workflowLifecycle, 'settleWorkForRestart')
        .mockImplementation(async (...args) => {
          const result = await preserve(...args)
          if (result) classified()
          return result
        })
      const admit = RepeatRunRepository.prototype.admitWorkActivation
      let paused = false
      const admission = vi.spyOn(RepeatRunRepository.prototype, 'admitWorkActivation')
        .mockImplementation(async function (this: RepeatRunRepository, ...args) {
          const result = await admit.apply(this, args)
          if (boundary === 'queued successor' && !paused
            && result.execution.workflowNodeId === f.saved.version.definition.nodes[1]!.id) {
            paused = true
            queued()
            await pause
          }
          return result
        })
      const accept = RepeatRunRepository.prototype.acceptWorkTerminal
      const acceptance = vi.spyOn(RepeatRunRepository.prototype, 'acceptWorkTerminal')
        .mockImplementation(async function (this: RepeatRunRepository, ...args) {
          if (boundary === 'native terminal' && !paused) {
            paused = true
            queued()
            await pause
          }
          return accept.apply(this, args)
        })
      try {
        const workflow = f.saved.scope
        const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1',
          [workflow.workflowId])).rows[0]!
        const response = await f.http('POST', `/api/management/workspaces/${workflow.workspaceId}/workflows/${workflow.workflowId}/runs`, {
          workflowVersionId: f.saved.version.id, commandId: randomUUID(), executionSemanticsVersion: 3,
          expectedWorkflowRevision: Number(revision.revision),
          expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: f.location.locationRevision, input: {},
        })
        expect(response.statusCode, response.body).toBe(202)
        const started = ManualRunStartResultSchema.parse(response.json())
        // Supply the provider's original accepted handoff result through its native transport.
        const first = await eventually(async () => f.replay.starts[0], (value) => value !== undefined)
        f.replay.complete(first!.sessionId, first!.nativeTurnId, JSON.stringify({ routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
          summary: 'Completed the first handoff.', board: { kind: 'none', reason: 'no_access' } }))
        await successorQueued
        const before = (await f.db.pool.query<{ id: string; record: { state: string; input: unknown } }>(
          'select id,record from harness_executions where run_id=$1 and workflow_node_id=$2',
          [started.run.id, f.saved.version.definition.nodes[boundary === 'queued successor' ? 1 : 0]!.id])).rows[0]!
        expect(before.record.state).toBe(boundary === 'queued successor' ? 'queued' : 'completed')
        expect(f.replay.starts).toHaveLength(1)
        const restarting = f.restart()
        await restartClassified
        release()
        await restarting
        admission.mockRestore()
        expect((await f.db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending',
          [started.run.id])).rowCount).toBe(0)
        const resumed = f.reconcile()
        const second = await eventually(async () => f.replay.starts[1], (value) => value !== undefined)
        f.replay.complete(second!.sessionId, second!.nativeTurnId, JSON.stringify({ routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: [] },
          summary: 'Completed the second handoff.', board: { kind: 'none', reason: 'no_access' } }))
        await resumed
        const detail = await eventually(async () => SavedRunDetailsSchema.parse((await f.http('GET',
          `/api/management/workspaces/${f.saved.scope.workspaceId}/runs/${started.run.id}`)).json()),
        (value) => value.run.executionState === 'completed')
        expect(detail.run.outcome).toBe('succeeded')
        expect(detail.executions.find((execution) => execution.id === before.id)?.input).toEqual(before.record.input)
        expect(f.replay.starts).toHaveLength(2)
        expect((await f.db.pool.query('select id from harness_executions where run_id=$1', [started.run.id])).rowCount).toBe(2)
      } finally { release(); admission.mockRestore(); acceptance.mockRestore(); classification.mockRestore() }
    })
  }
})

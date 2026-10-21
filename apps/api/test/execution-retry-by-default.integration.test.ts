import { expect, it } from 'vitest'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import { attempts, describeRetryBudget, sameSlot } from './helpers/retryBudget.js'
import { executionRows, readback, recoveryFixture, scope, toolValue, type RecoveryFixture } from './helpers/eng06DRecovery.js'

const dropped = { outcome: 'failed', error: { code: 'CODEX_APP_SERVER_DISCONNECTED', retryable: true } }

const nodeRows = async (f: RecoveryFixture, index: number) => (await executionRows(f))
  .filter((row) => row.execution.workflowNodeId === f.base.f.version.definition.nodes[index]!.id)

async function activities(f: RecoveryFixture) {
  const result = await f.transport.client.callTool({ name: 'run_activities_get_v1', arguments: { ...scope(f), limit: 100 } })
  return RunActivitiesPageSchema.parse(toolValue(result)).items
}

describeRetryBudget('retry by default after infrastructure failures', () => {
  it('retries a dropped native stream in a fresh attempt, and a late failure of the abandoned attempt changes nothing', async () => {
    const f = await recoveryFixture('sequential', (submission) =>
      submission.attempt === 1 && submission.request.workflowNodeId === f.base.f.version.entryNodeId ? 'transport_failure' : 'success')
    try {
      f.launch(); await f.settled()
      const before = await readback(f)
      expect(before.record.run, JSON.stringify(f.diagnostics())).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const entry = await nodeRows(f, 0)
      expect(attempts(entry)).toEqual([1, 2]); sameSlot(entry)
      expect(entry[0]!.execution.result).toMatchObject(dropped)
      expect(entry[1]!.execution.result).toMatchObject({ outcome: 'succeeded' })
      expect(before.details.find((detail) => detail.execution.executionId === entry[0]!.execution.id)?.reportedResult)
        .toMatchObject(dropped)
      expect(await activities(f)).toContainEqual(expect.objectContaining({ status: 'failed',
        detail: expect.stringContaining('CODEX_APP_SERVER_DISCONNECTED') }))
      // The provider reports the abandoned turn as failed after the Run finished.
      f.provider.deliverLateFailures()
      await f.restart()
      for (let tick = 0; tick < 3; tick++) await f.runtime.engine.reconcile((error) => f.errors.push(error))
      await f.settled()
      expect(await readback(f)).toEqual(before)
    } finally { await f.close() }
  }, 90000)

  it('keeps a running sibling Agent working while another Agent retries a transient failure', async () => {
    const f = await recoveryFixture('parallel', (submission) => {
      const nodes = f.base.f.version.definition.nodes
      if (submission.request.workflowNodeId === nodes[1]!.id && submission.attempt === 1) return 'transport_failure'
      if (submission.request.workflowNodeId === nodes[1]!.id) f.provider.releaseGate()
      return submission.request.workflowNodeId === nodes[2]!.id ? 'gated_success' : 'success'
    }, 12, { parallelism: 2 })
    try {
      f.launch(); await f.settled()
      const view = await readback(f)
      expect(view.record.run, JSON.stringify(f.diagnostics())).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const retried = await nodeRows(f, 1), sibling = await nodeRows(f, 2)
      expect(attempts(retried)).toEqual([1, 2])
      expect(retried[0]!.execution.result).toMatchObject(dropped)
      expect(sibling).toHaveLength(1)
      expect(sibling[0]!.execution.result).toMatchObject({ outcome: 'succeeded' })
      expect(sibling[0]!.result_digest).not.toBeNull()
    } finally { await f.close() }
  }, 90000)

  it('recovers after three infrastructure failures, each attempt keeping its own cause', async () => {
    const f = await recoveryFixture('sequential', (submission) =>
      submission.request.workflowNodeId === f.base.f.version.entryNodeId && submission.attempt <= 3
        ? 'transport_failure' : 'success')
    try {
      f.launch(); await f.settled()
      const view = await readback(f)
      expect(view.record.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const entry = await nodeRows(f, 0)
      expect(attempts(entry)).toEqual([1, 2, 3, 4]); sameSlot(entry)
      for (const row of entry.slice(0, 3)) expect(row.execution.result).toMatchObject(dropped)
      expect(entry[3]!.execution.result).toMatchObject({ outcome: 'succeeded' })
      expect(await nodeRows(f, 1)).toHaveLength(1)
    } finally { await f.close() }
  }, 90000)

  it('retries an attempt whose native session was lost to an API restart', async () => {
    const f = await recoveryFixture('sequential', (submission) =>
      submission.attempt === 1 && submission.request.workflowNodeId === f.base.f.version.entryNodeId ? 'park' : 'success')
    try {
      const parked = new Promise((resolve) => f.provider.events.once('parked', resolve))
      f.launch(); await parked
      await f.restart({ mode: 'crash' })
      await f.settled()
      const view = await readback(f)
      expect(view.record.run, JSON.stringify({ d: f.diagnostics(), run: view.record.run.result, rows: (await executionRows(f)).map((row) => [row.execution.attempt, row.execution.result]) })).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const entry = await nodeRows(f, 0)
      expect(attempts(entry)).toEqual([1, 2]); sameSlot(entry)
      expect(entry[0]!.execution.result).toMatchObject({ outcome: 'failed',
        error: { code: 'EXECUTION_INTERRUPTED', retryable: true } })
    } finally { await f.close() }
  }, 90000)
})

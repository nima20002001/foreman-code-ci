import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_TOOLS, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { assertSettled, corruptProof, editThrough, meaningfulInput, saveThrough, stageThrough,
  transports } from './helpers/eng07SaveAdmission.testSupport.js'

for (const transport of transports) describe.skipIf(!postgresEnabled)(`Main-local detached closure over ${transport}`, () => {
  it('reconciles a terminal Main-local detachment before permitting workflow edits', async () => {
    const shape = makeCurrentWorkflowFixture(randomUUID(), 'single')
    const closed = new Set<string>()
    const f = await currentOperatorIntegration({ fixture: shape, approvalNodeIds: [shape.version.entryNodeId],
      recoverNativeProcesses: async (executionId, signal) => {
        signal.throwIfAborted()
        return closed.has(executionId)
      } })
    let restore: (() => Promise<void>) | undefined
    try {
      await f.engine.start(f.f.run.id)
      const execution = (await readCurrentExecutions(f.runs, f.f.run.id))[0]!
      await f.engine.shutdown()
      const session = NativeSessionReferenceSchema.parse((await f.db.pool.query(
        'select reference from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]?.reference)
      await f.provider.close(session)
      closed.add(execution.id)
      const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
      if (!owner) throw new Error('Expected the restarted Run to be unowned')
      try {
        await f.runs.requestCleanup(f.f.run.id, owner)
      } finally {
        await owner.release()
      }
      const settled = f.compose()
      await settled.engine.start(f.f.run.id)
      await settled.engine.shutdown()
      await assertSettled(f)
      // Remove only recovery evidence to reproduce the historical terminal detachment.
      restore = await corruptProof(f.db.pool, 'execution_native_recoveries', execution.id, 'missing')
      closed.clear()
      const originalRun = await f.runs.get(f.f.run.id)
      expect(originalRun?.result?.error?.code).toBe('EXECUTION_INTERRUPTED')
      const originalExecution = await f.runs.getExecution(execution.id)
      const originalVersion = await f.workflows.getVersion(f.f.run.workflowVersionId)
      const closureRows = () => f.db.pool.query(`select to_jsonb(c) as record
        from execution_native_closures c where execution_id=$1 order by generation`, [execution.id])
      const originalClosures = (await closureRows()).rows
      expect(originalClosures[0]?.record).toMatchObject({ closed_at: null })
      expect(originalClosures[0]?.record.detached_at).not.toBeNull()
      expect((await f.runs.reconciliationCandidates()).map(run => run.id)).toContain(f.f.run.id)
      const cold = f.compose()
      await expect(cold.engine.start(f.f.run.id)).rejects.toThrow()
      const input = await meaningfulInput(f)
      const blocked = await stageThrough(f, transport, input)
      expect(blocked.result.current).toEqual([expect.objectContaining({ settled: false, nativePending: true })])
      closed.add(execution.id)
      await cold.engine.reconcile()
      await cold.engine.start(f.f.run.id)
      restore = undefined
      await assertSettled(f)
      expect(await f.runs.get(f.f.run.id)).toEqual(originalRun)
      expect(await f.runs.getExecution(execution.id)).toEqual(originalExecution)
      expect(await f.workflows.getVersion(f.f.run.workflowVersionId)).toEqual(originalVersion)
      expect((await closureRows()).rows).toEqual(originalClosures)
      expect((await f.db.pool.query('select generation from execution_native_recoveries where execution_id=$1',
        [execution.id])).rows).toHaveLength(1)
      expect((await f.runs.reconciliationCandidates()).map(run => run.id)).not.toContain(f.f.run.id)
      const advanced = await editThrough(f, transport, blocked.advance)
      expect(advanced.intent?.state).toBe('saved')
      expect(advanced.current.every(run => run.settled && !run.nativePending)).toBe(true)
      const nextInput = await meaningfulInput(f)
      const denied = await f.access.issue({ name: 'Read-only recovery observer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read'], scope: {} }] })
      const deniedClient = await f.connect(denied.token)
      expect((await deniedClient.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: nextInput })).isError).toBe(true)
      const saved = await saveThrough(f, transport, nextInput)
      expect(await saveThrough(f, transport, nextInput)).toEqual({ ...saved, replayed: true })
      expect(await f.workflows.getVersion(saved.value.version.id)).toEqual(saved.value.version)
    } finally {
      try {
        if (restore) await restore()
      } finally {
        await f.close()
      }
    }
  }, 60000)

})

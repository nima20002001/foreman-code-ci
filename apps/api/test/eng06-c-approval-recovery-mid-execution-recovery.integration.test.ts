import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { createApprovalRecoverySetup, assertInterrupted } from './helpers/approvalRecovery.js'
import { executionRows, readback, recoveryFixture, scope } from './helpers/eng06DRecovery.js'
import { parked } from './helpers/recoveryReadback.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const setup = createApprovalRecoverySetup()

for (const form of ['ordinary', 'repeat'] as const) {
  describe.skipIf(!postgresEnabled)(`Approval recovery ${form}: mid execution recovery`, () => {
    it('settles a dead mid-execution native lifetime after restart with EXECUTION_INTERRUPTED and no replay', async () => {
      const t = await setup(form, { approvals: false }), gate = t.faults.holdNextTurn()
      const started = t.runtime.engine.start(t.runId).then(() => undefined, (error: unknown) => error)
      try {
        const sessionId = await gate.entered
        const execution = (await readCurrentExecutions(t.runtime.runs, t.runId)).find((item) => item.nativeSessionId === sessionId)!
        expect(execution.state).toBe('running')
        await t.compare()
        t.faults.killOnRestart = true
        await t.restart(); await started
        expect(t.faults.deadSessions.has(sessionId)).toBe(true)
        const detached = await t.closureRows()
        await t.recoverUntilSettled(); await assertInterrupted(t, execution.id)
        const closures = await t.closureRows()
        expect(closures).toHaveLength(detached.length + 1)
        expect(closures.slice(0, detached.length)).toEqual(detached)
        const attachment = closures.at(-1)!
        expect(attachment).toMatchObject({ execution_id: execution.id,
          execution_identity: detached[0]!.execution_identity,
          expected_reference: detached[0]!.detached_reference,
          closed_at: null, closed_reference: null, closed_without_session: false,
          detached_at: null, detached_reference: null })
        expect((await t.recoveryRows())[0]).toMatchObject({ generation: attachment.generation })
        expect(t.f.provider.counts).toMatchObject({ starts: 1, responses: 0, attaches: 0 })
      } finally { gate.release(); await started }
    }, 90000)

    it('reports a refused restart attachment as interruption through HTTP and authenticated MCP', async () => {
      // The original lifetime must be detachable, or restart closes it and never attempts an attachment.
      const f = await recoveryFixture(form === 'ordinary' ? 'sequential' : 'repeat', () => 'park', undefined,
        { sessionPersistence: 'persistent' })
      const connection = f.provider.connection.bind(f.provider)
      let refusedAttachments = 0
      const attachment = vi.spyOn(f.provider, 'connection').mockImplementation(() => ({
        ...connection(),
        async attachSession() {
          refusedAttachments++
          throw new HarnessExecutionError('NATIVE_SESSION_UNAVAILABLE', 'The original process cannot be attached.')
        },
      }))
      try {
        f.launch()
        const before = await parked(f)
        const executionId = before.details[0]!.execution.executionId
        await f.restart()
        await f.settled()
        const after = await readback(f)
        const result = { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false } }
        expect(after.record).toMatchObject({ cleanupPending: false,
          run: { executionState: 'completed', outcome: 'failed', result } })
        expect(after.details).toHaveLength(1)
        expect(after.details[0]).toMatchObject({ execution: { executionId, attempt: 1, state: 'completed' },
          reportedResult: result, acceptedResult: { status: 'not_accepted' } })
        expect(await executionRows(f)).toHaveLength(1)
        expect(refusedAttachments).toBe(1)
        expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1, attaches: 0 })
        const outside = await f.base.access.issue({ name: 'Reader outside Run scope', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000),
          grants: [{ actions: ['runs:read'], scope: { runIds: ['another-run'] } }] })
        const denied = await f.transport.connect(outside.token)
        await expectMcpAccessDenied(denied.callTool({ name: 'run_record_get', arguments: scope(f) }))
        await f.runtime.engine.reconcile(error => f.errors.push(error))
        expect(await readback(f)).toEqual(after)
        expect(f.provider.counts.starts).toBe(1)
        expect(f.shutdownErrors).toEqual([])
      } finally {
        attachment.mockRestore()
        await f.close()
      }
    }, 90000)
  })
}

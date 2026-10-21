import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { CURRENT_WORKFLOW_TOOLS, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { assertSettled, corruptProof, definitionUrl, editThrough, meaningfulInput, parkBeforeNativeEntry,
  rpc, stageThrough, versionCount, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { nativeFacts, recoveredFixture } from './helpers/saveAdmissionTransport.js'

describe.skipIf(!postgresEnabled)('workflow Save after native recovery', () => {
  describe.each(['http', 'mcp'] as Transport[])('over %s', (transport) => {
    it.each(['missing', 'mismatched'] as const)('%s recovered evidence blocks both direct Save and a previously planned Stop-and-save', async (fault) => {
      const { f, executionId } = await recoveredFixture('single')
      let restore: (() => Promise<void>) | undefined
      try {
        const input = await meaningfulInput(f), count = await versionCount(f)
        const stage = await stageThrough(f, transport, input)
        expect(stage.intent.stops).toHaveLength(0)
        const intact = await nativeFacts(f)
        restore = await corruptProof(f.db.pool, 'execution_native_recoveries', executionId, fault)
        const facts = await nativeFacts(f), counts = { ...f.provider.counts }
        const rejected = { ...input, commandId: randomUUID() }
        if (transport === 'http') {
          const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(input), headers: graphHeaders(f.writer.token), payload: rejected })
          expect(reply.statusCode).toBe(409)
          expect(reply.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        } else {
          const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, rejected)
          expect(reply.result?.isError).toBe(true)
          expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        }
        const blocked = await editThrough(f, transport, stage.advance)
        expect(blocked.intent?.state).toBe('waiting')
        expect(blocked.intent?.saveAttempted).toBe(false)
        expect(blocked.current).toEqual([expect.objectContaining({ settled: false, nativePending: true })])
        expect(blocked.intent?.saveInput).toEqual(stage.intent.saveInput)
        expect(await versionCount(f)).toBe(count)
        expect(await nativeFacts(f)).toEqual(facts)
        expect(f.provider.counts).toEqual(counts)
        // Restore ONLY the fixture's original evidence, then reuse the exact
        // retained command. This proves the fault, not an unrelated admission
        // guard, caused the preceding rejection/wait.
        await restore(); restore = undefined
        expect(await nativeFacts(f)).toEqual(intact)
        const saved = await editThrough(f, transport, stage.advance)
        expect(saved.intent?.state).toBe('saved')
        expect(saved.intent?.saveInput).toEqual(stage.intent.saveInput)
        expect(saved.current.every((item) => item.settled && !item.nativePending)).toBe(true)
        expect(await versionCount(f)).toBe(count + 1)
        expect(await nativeFacts(f)).toEqual(intact)
        expect(f.provider.counts).toEqual(counts)
      } finally { await restore?.(); await f.close() }
    }, 60000)

    it('an unbound terminal without its seal is not negative native evidence', async () => {
      const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
      const gate = parkBeforeNativeEntry(f)
      let restore: (() => Promise<void>) | undefined
      try {
        const execution = await gate.parked
        await f.stop(); await f.engine.cancel(f.f.run.id); await gate.drive; await assertSettled(f)
        const input = await meaningfulInput(f), count = await versionCount(f)
        const stage = await stageThrough(f, transport, input)
        expect(stage.intent.stops).toHaveLength(0)
        const intact = await nativeFacts(f)
        restore = await corruptProof(f.db.pool, 'workflow_native_entries', execution.id, 'missing')
        const blocked = await editThrough(f, transport, stage.advance)
        expect(blocked.intent?.state).toBe('waiting')
        expect(blocked.current).toEqual([expect.objectContaining({ nativePending: true, settled: false })])
        const rejected = { ...input, commandId: randomUUID() }
        if (transport === 'http') {
          const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(input), headers: graphHeaders(f.writer.token), payload: rejected })
          expect(reply.statusCode).toBe(409)
          expect(reply.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        } else {
          const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, rejected)
          expect(reply.result?.isError).toBe(true)
          expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
        }
        expect(await versionCount(f)).toBe(count)
        expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
        await restore(); restore = undefined
        const saved = await editThrough(f, transport, stage.advance)
        expect(saved.intent?.state).toBe('saved')
        expect(saved.intent?.saveInput).toEqual(stage.intent.saveInput)
        expect(saved.current.every((item) => item.settled && !item.nativePending)).toBe(true)
        expect(await versionCount(f)).toBe(count + 1)
        expect(await nativeFacts(f)).toEqual(intact)
        expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      } finally { await restore?.(); gate.release(); await gate.drive; gate.restore(); await f.close() }
    }, 60000)
  })
})

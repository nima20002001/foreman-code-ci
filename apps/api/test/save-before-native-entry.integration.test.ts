import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { nativeSavePreEntryFixtures } from './helpers/nativeSavePreEntryFixture.js'
import { assertSettled, editThrough, meaningfulInput, parkBeforeNativeEntry,
  saveThrough, stageThrough, versionCount, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { assertNewVersionOnly, nativeFacts } from './helpers/saveAdmissionTransport.js'

describe.skipIf(!postgresEnabled)('workflow Save before native entry', () => {
  const createFixture = nativeSavePreEntryFixtures()
  describe.each(['http', 'mcp'] as Transport[])('over %s', transport => {
    for (const form of ['single', 'repeat'] as const) {
      it(`${form}: meaningful Save after Stop-before-native-entry uses the canonical seal`, async () => {
        const f = await createFixture(form)
        const gate = parkBeforeNativeEntry(f)
        try {
          const execution = await gate.parked
          const before = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows[0]!
          expect(['reserved', 'prepared']).toContain(before.phase)
          await f.stop() // Real authorized durable Stop; the engine owns negative settlement.
          await f.engine.cancel(f.f.run.id)
          await gate.drive
          await assertSettled(f)
          const entries = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows
          expect(entries).toEqual([{ phase: 'not_submitted' }])
          expect((await f.runs.getExecution(execution.id))?.nativeSessionId).toBeUndefined()
          expect(f.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
          const input = await meaningfulInput(f), count = await versionCount(f), facts = await nativeFacts(f)
          const saved = await saveThrough(f, transport, input)
          expect(agentWorkflowNode(saved.value.version.definition.nodes[0]).initialPrompt).toBe(agentWorkflowNode(input.graph.nodes[0]).initialPrompt)
          await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
          expect(await nativeFacts(f)).toEqual(facts)
        } finally { gate.release(); await gate.drive; gate.restore(); await f.close() }
      }, 60000)

      it(`${form}: Stop-and-save settles the unentered execution and publishes the retained edit`, async () => {
        const f = await createFixture(form)
        const gate = parkBeforeNativeEntry(f)
        try {
          const execution = await gate.parked
          const input = await meaningfulInput(f), count = await versionCount(f)
          const stage = await stageThrough(f, transport, input)
          expect(stage.intent.stops).toHaveLength(1)
          const first = await editThrough(f, transport, stage.advance)
          expect(['waiting', 'saved']).toContain(first.intent?.state)
          // Drain the already authorized Stop, never manufacture another receipt
          // or silently reissue a different command after an uncertain response.
          await f.engine.cancel(f.f.run.id)
          await gate.drive
          await assertSettled(f)
          const result = first.intent?.state === 'saved' ? first : await editThrough(f, transport, stage.advance)
          expect(result.intent?.state).toBe('saved')
          expect(result.intent?.saveInput).toEqual(stage.intent.saveInput)
          expect(result.current.every((item) => item.settled && !item.nativePending)).toBe(true)
          expect((await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows).toEqual([{ phase: 'not_submitted' }])
          expect((await f.runs.getExecution(execution.id))?.nativeSessionId).toBeUndefined()
          expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
          await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
        } finally { gate.release(); await gate.drive; gate.restore(); await f.close() }
      }, 60000)

    }
  })
})

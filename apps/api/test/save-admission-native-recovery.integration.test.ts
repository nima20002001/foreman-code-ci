import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { editThrough, meaningfulInput, saveThrough, stageThrough,
  versionCount, type Transport } from './helpers/eng07SaveAdmission.testSupport.js'
import { assertNewVersionOnly, nativeFacts, recoveredFixture } from './helpers/saveAdmissionTransport.js'

describe.skipIf(!postgresEnabled)('workflow Save after native recovery', () => {
  describe.each(['http', 'mcp'] as Transport[])('over %s', (transport) => {
    for (const form of ['single', 'repeat'] as const) {
      it(`${form}: Save and Stop-and-save accept exact restart-recovery receipts without replay`, async () => {
        const { f } = await recoveredFixture(form)
        try {
          const counts = { ...f.provider.counts }, facts = await nativeFacts(f)
          const input = await meaningfulInput(f), count = await versionCount(f)
          await saveThrough(f, transport, input)
          await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
          const next = await meaningfulInput(f)
          const entry = agentWorkflowNode(next.graph.nodes[0])
          entry.initialPrompt += ' / another meaningful edit'
          const stage = await stageThrough(f, transport, next)
          expect(stage.intent.stops).toHaveLength(0)
          expect(stage.result.current.every((item) => item.settled && !item.nativePending)).toBe(true)
          const result = await editThrough(f, transport, stage.advance)
          expect(result.intent?.state).toBe('saved')
          expect(result.intent?.saveInput).toEqual(stage.intent.saveInput)
          expect(await versionCount(f)).toBe(count + 2)
          expect((await f.runs.get(f.f.run.id))?.workflowVersionId).toBe(input.expectedWorkflowVersionId)
          expect(await nativeFacts(f)).toEqual(facts)
          expect(f.provider.counts).toEqual(counts)
        } finally { await f.close() }
      }, 60000)
    }
  })
})

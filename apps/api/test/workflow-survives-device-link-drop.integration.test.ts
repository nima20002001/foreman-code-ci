import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faultWorkflowFixture, expectRecoveredFault } from './helpers/faultWorkflowFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow device reconnect', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => {
    fixture = await faultWorkflowFixture()
    await fixture.prepareEntry()
  }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // Device transport loss must reconnect without failing the Run or replaying healthy siblings.
  it('finishes after the remote device link drops during an admitted turn', async () => {
    await fixture.launch()
    await fixture.active()
    const before = await fixture.read()
    fixture.worker.disconnect()
    try {
      await readUntil(async () => fixture.worker.rejectedRequests, count => count > 0,
        { timeoutMs: 2_000, description: 'a request hitting the dropped device link' })
      fixture.worker.reconnect()
      fixture.release()
      const details = await fixture.finished()
      expectRecoveredFault(details, fixture, /transport|disconnect|reconnect/i)
      expect(details.run.workflowVersionId).toBe(before.run.workflowVersionId)
      expect(details.run.input).toEqual(before.run.input)
    } finally {
      fixture.worker.reconnect()
      fixture.release()
    }
    // Two full remote launches (the dropped attempt and its fresh retry) plus closure of the
    // abandoned one: about 6-8 s per launch on a loaded CI host, so 18 s left no headroom.
    // finished() still fails a Run that stops changing for 8 s.
  }, 30_000)
})

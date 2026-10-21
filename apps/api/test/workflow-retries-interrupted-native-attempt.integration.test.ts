import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faultWorkflowFixture, expectBoundedNodeFault } from './helpers/faultWorkflowFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('native interruption without an answer', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => {
    fixture = await faultWorkflowFixture()
    await fixture.prepareEntry()
  }, 10_000)
  beforeAll(async () => {
    await fixture.launch()
    await fixture.active()
  }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // An interrupted native turn without a result must retry only the affected node.
  it.fails('retries an interrupted remote attempt without treating it as a user Stop', async () => {
    const before = await fixture.read()
    const execution = before.executions.find(item => item.workflowNodeId === fixture.affected.id)!
    const turn = fixture.worker.replay.starts.find(item => item.correlationId === `execution:${execution.id}`)!
    const thread = fixture.worker.replay.threads.get(turn.sessionId)!
    const native = thread.turns.find(item => item.id === turn.nativeTurnId)!
    expect(native.status).toBe('inProgress')
    native.status = 'interrupted'
    native.items = []
    fixture.worker.replay.channels.get(turn.sessionId)!.notify('turn/completed', {
      threadId: turn.sessionId, turn: structuredClone(native),
    })
    fixture.release()
    const details = await fixture.finished()
    expect(details.run.stopCause).toBeUndefined()
    expectBoundedNodeFault(details, fixture, /interrupt|cancel|retry/i)
    expect(details.executions.find(item => item.id === execution.id)?.result?.output).toBeUndefined()
    // Two full remote launches on a loaded CI host need more than 18 s; finished() still fails a Run that stops changing.
  }, 30_000)
})

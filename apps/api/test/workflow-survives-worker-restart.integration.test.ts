import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faultWorkflowFixture, expectBoundedNodeFault } from './helpers/faultWorkflowFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('workflow Worker restart', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  beforeAll(async () => {
    fixture = await faultWorkflowFixture()
    await fixture.prepareEntry()
  }, 10_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  // Worker restart must recover the turn or exhaust only that node's bounded retry budget.
  it('reopens the Worker journal mid-turn and leaves sibling work intact', async () => {
    await fixture.launch()
    await fixture.active()
    const before = await fixture.read()
    const original = before.executions.find(execution => execution.workflowNodeId === fixture.affected.id)!
    const intent = fixture.intents.get(original.id)!
    const status = await fixture.worker.journal.status(intent.operationId)
    expect(status).toMatchObject({ status: 'known', receipt: { native: { sessionId: original.nativeSessionId } } })
    const bootId = fixture.worker.connection.bootId
    await fixture.worker.restart()
    expect(fixture.worker.connection.bootId).not.toBe(bootId)
    expect(await fixture.worker.journal.status(intent.operationId)).toMatchObject({ status: 'known',
      receipt: { intent: { executionId: original.id, attemptId: intent.attemptId },
        terminal: { kind: 'failed', result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } } } } })
    fixture.release()
    const details = await fixture.finished()
    expectBoundedNodeFault(details, fixture, /worker|restart|interrupt|uncertain/i)
    expect(details.run.workflowVersionId).toBe(before.run.workflowVersionId)
    expect(details.run.input).toEqual(before.run.input)
    // Two full remote launches on a loaded CI host need more than 18 s; finished() still fails a Run that stops changing.
  }, 30_000)
})

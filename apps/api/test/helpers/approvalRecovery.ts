import { afterEach, expect, vi } from 'vitest'
import { DomainError } from '../../src/modules/errors.js'
import { readCurrentExecutions } from './wave25Agent3.js'
import { approvalFaultFixture, approvalResponse, type ApprovalFaultFixture, type FaultForm } from './eng06ApprovalFaults.js'

export function createApprovalRecoverySetup() {
  const fixtures: ApprovalFaultFixture[] = []
  afterEach(async () => {
    const failures: unknown[] = []
    try {
      while (fixtures.length) {
        try {
          await fixtures.pop()!.close()
        } catch (error) {
          failures.push(error)
        }
      }
    } finally {
      vi.restoreAllMocks()
    }
    if (failures.length) throw new AggregateError(failures, 'Approval test-provider shutdown did not settle')
  })
  return async function setup(form: FaultForm, options: { approvals?: boolean } = {}) {
    const fixture = await approvalFaultFixture(form, options)
    fixtures.push(fixture)
    return fixture
  }
}
export async function startWaiting(t: ApprovalFaultFixture) {
  await t.runtime.engine.start(t.runId)
  expect(await t.runtime.runs.get(t.runId)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
  await t.assertShape(1)
  const interaction = await t.onePending()
  expect(interaction.executionId).toBeDefined()
  expect((await t.compare()).state.run.pendingInteractionCount).toBe(1)
  return interaction
}
export async function loseGraphAcknowledgement(t: ApprovalFaultFixture) {
  const pending = await startWaiting(t)
  // Fail AFTER positive delivery, before the actual checkpoint consumer. This
  // injects a lost callback, not a manufactured delivery or graph.resume receipt.
  const interrupted = vi.spyOn(t.runtime.engine, 'resumeInteraction').mockRejectedValueOnce(
    new DomainError('ENGINE_RESTART', 'Injected loss of the API graph-resume callback.', 409))
  try {
    const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(response.interaction).toMatchObject({ id: pending.id, status: 'delivered', deliveryState: 'delivered' })
    expect(interrupted).toHaveBeenCalledTimes(1)
    expect(await t.f.receipts()).toHaveLength(0)
    expect((await t.runtime.runs.get(t.runId))?.executionState).toBe('waiting')
    expect(t.f.provider.counts.responses).toBe(1)
    await t.assertNoNativeAcknowledgement(pending.id)
    return { pending, delivered: response.interaction }
  } finally { interrupted.mockRestore() }
}
export async function assertInterrupted(t: ApprovalFaultFixture, executionId: string) {
  await t.settled('failed')
  expect(await t.runtime.runs.getExecution(executionId)).toMatchObject({ state: 'completed',
    result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } } })
  const recovered = await t.recoveryRows()
  expect(recovered).toHaveLength(1)
  expect(recovered[0]).toMatchObject({ execution_id: executionId,
    execution_identity: { id: executionId, runId: t.runId } })
  expect(recovered[0]!.reference?.nativeSessionId).toBe((await t.runtime.runs.getExecution(executionId))?.nativeSessionId)
  expect(recovered[0]!.owner_id).toMatch(/^\d+$/)
  expect(recovered[0]!.owner_fence).toMatch(/^\d+$/)
  expect(t.faults.processes.isClosed(executionId)).toBe(true)
  expect(t.faults.processes.recoveredExecutions).toEqual([executionId])
  expect(t.f.provider.counts.attaches).toBe(0)
  expect(new Set(t.f.provider.startedExecutions).size).toBe(t.f.provider.startedExecutions.length)
  await t.assertShape(1)
}
export async function assertPredecessorsUnchanged(t: ApprovalFaultFixture, before: Awaited<ReturnType<typeof readCurrentExecutions>>) {
  for (const execution of before.filter((item) => item.state === 'completed')) {
    expect(await t.runtime.runs.getExecution(execution.id)).toEqual(execution)
  }
}

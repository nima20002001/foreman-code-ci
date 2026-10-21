import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { expect, it, vi } from 'vitest'
import { createApprovalRecoverySetup, startWaiting } from './helpers/approvalRecovery.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'

const setup = createApprovalRecoverySetup()

it('delivers the original approval after consecutive transient attachment failures', async () => {
  const t = await setup('ordinary')
  const pending = await startWaiting(t)
  const original = await t.runtime.runs.getExecution(pending.executionId)
  const responseInput = approvalResponse(pending)
  const sessions = t.f.provider.counts.sessions
  await t.restart()
  const attach = vi.spyOn(t.f.provider, 'attachSession')
    .mockRejectedValueOnce(new Error('Query read timeout'))
    .mockRejectedValueOnce(new Error('Query read timeout'))

  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(t.runtime.service.respond(t.responder, responseInput)).rejects.toThrow('Query read timeout')
    expect(await t.runtime.service.get(pending.id)).toEqual(pending)
    expect(await t.runtime.runs.getExecution(pending.executionId)).toEqual(original)
    expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(false)
    expect(t.f.provider.counts.responses).toBe(0)
  }

  const response = await t.runtime.service.respond(t.responder, responseInput)
  expect(response.interaction).toMatchObject({
    id: pending.id,
    executionId: pending.executionId,
    nativeSessionId: pending.nativeSessionId,
    deliveryState: 'delivered',
  })
  expect(attach).toHaveBeenCalledTimes(3)
  await t.finishApprovals()
  expect(t.f.provider.counts.sessions).toBe(sessions)
  expect(t.f.provider.counts.responses).toBe(1)
  expect(t.f.provider.counts.starts).toBe(2)
}, 90_000)

it.each(['execution read', 'native attachment', 'native reconciliation'] as const)(
  'retries a transient %s failure without fencing or replacing the pending requester', async stage => {
    const t = await setup('ordinary')
    const pending = await startWaiting(t)
    const original = await t.runtime.runs.getExecution(pending.executionId!)
    const principal = (await t.f.db.pool.query('select principal_id from worker_credential_bindings where execution_id=$1',
      [pending.executionId])).rows[0]!.principal_id
    await t.restart()
    const error = new Error('Query read timeout')
    let injected = false
    if (stage === 'execution read') {
      const read = t.runtime.runs.getExecution.bind(t.runtime.runs)
      vi.spyOn(t.runtime.runs, 'getExecution').mockImplementation(async (...args) => {
        // Recovery passes the Run owner to its scan; attach performs the ownerless read.
        if (!args[1] && !injected) { injected = true; throw error }
        return read(...args)
      })
    } else if (stage === 'native attachment') {
      const attach = t.f.provider.attachSession.bind(t.f.provider)
      vi.spyOn(t.f.provider, 'attachSession').mockImplementation(async (...args) => {
        if (!injected) { injected = true; throw error }
        return attach(...args)
      })
    } else {
      const reconcile = t.f.provider.reconcile.bind(t.f.provider)
      vi.spyOn(t.f.provider, 'reconcile').mockImplementation(async (...args) => {
        if (!injected) { injected = true; throw error }
        return reconcile(...args)
      })
    }
    await expect(t.runtime.engine.prepareInteraction(pending)).rejects.toThrow('Query read timeout')
    expect(injected).toBe(true)
    expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(false)
    expect(await t.runtime.repository.get(pending.id)).toEqual(pending)
    expect(await t.runtime.runs.getExecution(pending.executionId!)).toEqual(original)
    await t.runtime.engine.prepareInteraction(pending)
    const live = (await t.f.db.pool.query('select principal_id,revoked_at from worker_credential_bindings where execution_id=$1',
      [pending.executionId])).rows
    expect(live).toEqual([{ principal_id: principal, revoked_at: null }])
    const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(response.interaction.deliveryState).toBe('delivered')
    await t.finishApprovals()
    expect(t.f.provider.counts.responses).toBe(1)
    expect(t.f.provider.counts.starts).toBe(2)
  }, 90_000,
)

it.each(['CODEX_APP_SERVER_TIMEOUT', 'CODEX_APP_SERVER_DISCONNECTED'])(
  'restores the original approval after native transport failure %s', async code => {
    const t = await setup('ordinary')
    const pending = await startWaiting(t)
    const original = await t.runtime.runs.getExecution(pending.executionId!)
    await t.restart()
    vi.spyOn(t.f.provider, 'attachSession').mockRejectedValueOnce(new HarnessExecutionError(code, 'Native link unavailable'))
    await expect(t.runtime.engine.prepareInteraction(pending)).rejects.toThrow('Native link unavailable')
    expect(await t.runtime.runs.hasPendingCleanup(t.runId)).toBe(false)
    expect(await t.runtime.repository.get(pending.id)).toEqual(pending)
    expect(await t.runtime.runs.getExecution(pending.executionId!)).toEqual(original)
    await t.runtime.engine.prepareInteraction(pending)
    const response = await t.runtime.service.respond(t.responder, approvalResponse(pending))
    expect(response.interaction).toMatchObject({ id: pending.id, nativeSessionId: pending.nativeSessionId,
      executionId: pending.executionId, deliveryState: 'delivered' })
    await t.finishApprovals()
    expect(t.f.provider.counts.responses).toBe(1)
  }, 90_000,
)

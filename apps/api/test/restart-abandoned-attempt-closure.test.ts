import { expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

it('closes an abandoned attempt whose cleanup was unconfirmed when Main shuts down for restart', async () => {
  const f = native2Fixture(false)
  const execution = f.get()
  f.installResident()
  let workerAvailable = false
  const released: string[] = []
  Object.assign(f.runs, {
    repeat: async () => f.store,
    recordExecutionFailure: async () => {},
    acquireOwnership: async (runId: string) => ({ ...f.owner, retain: () => async () => {},
      release: async () => { released.push(runId) } }),
  })
  Object.assign(f.budgets, { stop: async () => {} })
  // Production Worker credentials are renewable, so restart closure renews resident sessions it preserves.
  Object.assign(f.credentials, { renew: async () => new Date(Date.now() + 60_000).toISOString() })
  Object.assign(f.manager, {
    cancel: async () => true,
    close: async (reference: NativeSessionReference) => {
      if (!workerAvailable) throw new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', 'Worker retention is full.', 503)
      f.calls.push(`close:${reference.nativeSessionId}`)
    },
    closeForRestart: async (reference: NativeSessionReference) => { f.calls.push(`detach:${reference.nativeSessionId}`) },
  })
  try {
    // A transient Worker failure abandons the attempt, but its native close cannot be confirmed yet.
    await expect(f.coordinator.abandonAttempt(f.owner as never, execution, { outcome: 'failed',
      error: { code: 'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', message: 'Worker retention is full.', retryable: true } }))
      .rejects.toThrow()
    expect(f.coordinator.residentRunIds()).toEqual([execution.runId])

    workerAvailable = true
    await expect(f.coordinator.closeForRestart()).resolves.toBeUndefined()

    expect(f.calls).toContain(`close:${f.session.nativeSessionId}`)
    expect(f.calls).not.toContain(`detach:${f.session.nativeSessionId}`)
    expect(f.getProof()?.session).toEqual(f.session)
    expect(f.coordinator.residentRunIds()).toEqual([])
    expect(released).toEqual([execution.runId])
  } finally { await f.connection.close() }
})

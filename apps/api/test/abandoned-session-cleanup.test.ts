import { expect, it, vi } from 'vitest'
import { native2Fixture } from './eng04-native2-fixtures.js'

it('closes the persisted native session after its save acknowledgement was lost', async () => {
  const f = native2Fixture(false)
  const execution = f.get()
  f.installResident()
  f.resident.execution = { ...execution, nativeSessionId: undefined, state: 'starting' }
  const settle = vi.fn(async () => {})
  Object.assign(f.store, { settleNegativeExecution: settle })
  Object.assign(f.runs, { repeat: async () => f.store, recordExecutionFailure: async () => {} })
  Object.assign(f.budgets, { stop: async () => {} })
  Object.assign(f.manager, { cancel: async () => true })
  try {
    await f.coordinator.abandonAttempt(f.owner as never, execution, { outcome: 'failed',
      error: { code: '08006', message: 'Session save acknowledgement lost.', retryable: true } })
    expect(f.getProof()?.session).toEqual(f.session)
    expect(f.calls).toContain(`close:${f.session.nativeSessionId}`)
    expect(settle).toHaveBeenCalledWith(execution.id, false)
    expect(f.coordinator.residentRunIds()).toEqual([])
  } finally { await f.connection.close() }
})

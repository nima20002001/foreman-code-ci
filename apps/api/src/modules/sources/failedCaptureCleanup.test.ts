import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { reconcileFailedCaptures } from './failedCaptureCleanup.js'

function fixture() {
  const state = { locked: true, commandOwned: false, approvalState: 'failed', reservationState: 'uncertain',
    accountedBytes: 170_000_000, expired: false }
  const reservation = {
    reservationId: 'reservation', scopeId: 'scope', ownerKind: 'capture', ownerId: 'snapshot',
    reservedBytes: state.accountedBytes,
  }
  const candidate = { snapshot_id: 'snapshot', requested_by: 'principal', command_id: 'command' }
  const commandLock = `command:${candidate.requested_by}:source.approve:${candidate.command_id}`
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    if (text.includes('pg_try_advisory_lock')) {
      if (values?.[0] !== commandLock) return { rows: [{ locked: true }], rowCount: 1 }
      state.commandOwned = state.locked
      return { rows: [{ locked: state.locked }], rowCount: 1 }
    }
    if (text.includes('pg_advisory_unlock')) {
      if (values?.[0] === commandLock) state.commandOwned = false
      return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 }
    }
    if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: state.locked }], rowCount: 1 }
    if (text.includes('select r.record')) return { rows: [{ record: reservation, state: state.approvalState,
      workspace_id: 'workspace', expired: state.expired }], rowCount: 1 }
    if (text.includes('from management_principals')) return { rows: [{
      id: 'principal', name: 'Capture owner', audience: 'operator',
      grants: [{ actions: ['source_roots:bind', 'sources:read', 'workspace_locations:read'], scope: {} }],
      expires_at: new Date(Date.now() + 60_000), revoked_at: null, delegated_from: null,
    }], rowCount: 1 }
    if (text.startsWith('update source_approvals')) state.approvalState = 'failed'
    if (text.startsWith('update source_storage_reservations')) {
      if (values!.length === 1) state.reservationState = 'reclaimed'
      else {
        state.reservationState = String(values![1])
        state.accountedBytes = Number(values![2])
      }
    }
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const pool = {
    query: async () => ({ rows: [candidate] }),
    connect: async () => ({ query, release }),
  } as unknown as pg.Pool
  const store = {
    retainedCaptureBytes: vi.fn(async () => {
      expect(state.commandOwned).toBe(true)
      return 8192
    }),
    withCaptureLock: async <T>(_snapshotId: string, work: () => Promise<T>): Promise<T> => work(),
    remove: vi.fn(async () => {
      expect(state.commandOwned).toBe(true)
    }),
    manifest: vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error('Capture not finalized'), { code: 'ENOENT' })
    }),
  }
  const withCaptureLock = vi.spyOn(store, 'withCaptureLock')
  const report = vi.fn()
  return { pool, state, query, release, store, withCaptureLock, report }
}

it('corrects a failed capture reservation under its original command lock and retains metadata', async () => {
  const f = fixture()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.retainedCaptureBytes).toHaveBeenCalledExactlyOnceWith('snapshot')
  expect(f.state).toMatchObject({ reservationState: 'retained', accountedBytes: 24_576 })
  expect(f.report).not.toHaveBeenCalled()
  expect(f.state.commandOwned).toBe(false)
  expect(f.release).toHaveBeenCalledOnce()
})

it('keeps the full reservation while the original capture command still owns its lock', async () => {
  const f = fixture()
  f.state.locked = false
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.withCaptureLock).not.toHaveBeenCalled()
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect(f.state.accountedBytes).toBe(170_000_000)
})

it('keeps the reservation and reports failed physical accounting', async () => {
  const f = fixture()
  f.store.retainedCaptureBytes.mockRejectedValue(new Error('unsafe retained file'))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.state.reservationState).toBe('uncertain')
  expect(f.state.accountedBytes).toBe(170_000_000)
  expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'unsafe retained file' }))
  expect(f.state.commandOwned).toBe(false)
})

it('keeps an interrupted capture fully charged while a filesystem writer still owns it', async () => {
  const f = fixture()
  f.state.approvalState = 'capturing'
  f.state.reservationState = 'preparing'
  f.withCaptureLock.mockRejectedValueOnce(Object.assign(new Error('Live capture writer'),
    { code: 'SOURCE_CLAIM_LOCK_FAILED' }))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.manifest).not.toHaveBeenCalled()
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect(f.state).toMatchObject({ reservationState: 'preparing', accountedBytes: 170_000_000 })
  expect(f.report).not.toHaveBeenCalled()
  expect(f.state.commandOwned).toBe(false)
})

it('frees an abandoned partial capture slot even while its original caller remains authorized', async () => {
  const f = fixture()
  f.state.approvalState = 'capturing'
  f.state.reservationState = 'preparing'
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.state).toMatchObject({ approvalState: 'failed', reservationState: 'retained', accountedBytes: 24_576 })
  expect(f.store.remove).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

it('reclaims expired failed capture bytes only after physical removal succeeds', async () => {
  const f = fixture()
  f.state.expired = true
  f.store.remove.mockRejectedValueOnce(new Error('Removal interrupted'))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.state.reservationState).toBe('retained')
  expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Removal interrupted' }))
  expect(f.state.commandOwned).toBe(false)
  f.report.mockClear()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.state.reservationState).toBe('reclaimed')
  expect(f.store.remove).toHaveBeenCalledTimes(2)
  expect(f.report).not.toHaveBeenCalled()
  expect(f.state.commandOwned).toBe(false)
})

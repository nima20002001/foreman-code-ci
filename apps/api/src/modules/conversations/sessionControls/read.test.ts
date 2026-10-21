import { expect, it, vi } from 'vitest'
import {
  SessionPreferencesSchema, unavailableSessionControls, type NativeSessionReference, type SessionControlState,
} from '@foreman-code/contracts'
import { HarnessExecutionError } from '../../harnesses/errors.js'
import { DomainError } from '../../errors.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { memorySessionControlPool } from '../../../../test/support/sessionControls.js'
import { SessionControlStore, type SessionControlBinding } from './store.js'

const providers = [
  { harness: 'codex', code: 'CODEX_SESSION_UNAVAILABLE' },
  { harness: 'claude', code: 'CLAUDE_SESSION_UNAVAILABLE' },
] as const

async function fixture(harness: NativeSessionReference['harness'] = 'codex') {
  const records = new Map<string, SessionControlState>()
  const pool = memorySessionControlPool({ records })
  const store = new SessionControlStore(pool, 'operator')
  const capabilities = { ...unavailableSessionControls('native-profile'), model: 'model',
    plan: { supported: true, reason: null }, compact: { supported: true, reason: null } }
  const manager = {
    sessionControlCapabilities: vi.fn(async () => capabilities),
    appliedSessionPreferences: vi.fn(() => SessionPreferencesSchema.parse({ contextBudget: 100000 })),
    contextSnapshot: vi.fn(() => null),
  } as unknown as NativeHarnessSessionManager
  const binding: SessionControlBinding = {
    conversationId: 'conversation', principalId: 'owner', defaultSubject: 'application-operator',
    profileKey: 'profile', busyReason: null, manager,
    session: { harness, nativeSessionId: 'native', providerVersion: 'fixture-1' },
    pendingCapabilities: unavailableSessionControls('profile'),
  }
  const state = await store.read(binding)
  records.set('conversation', { ...state, desiredMode: 'plan', appliedMode: 'plan',
    context: { nativeSessionId: 'native', model: 'model', generation: 'connection', sequence: 1,
      source: harness, accuracy: 'native', usedTokens: 1000, capacityTokens: 200000,
      lifetimeTokens: 1000, cost: null, observedAt: '2026-10-08T00:00:00.000Z', stale: false } })
  return { store, binding, manager, capabilities, records, pool }
}

it.each(providers)('reads saved controls when the $harness runtime has unloaded', async ({ harness, code }) => {
  const f = await fixture(harness)
  vi.mocked(f.manager.sessionControlCapabilities!).mockRejectedValue(new HarnessExecutionError(code, 'Unloaded'))
  const read = await f.store.read(f.binding)
  expect(read).toMatchObject({ desiredMode: 'plan', appliedMode: 'plan', nativeSessionId: 'native',
    nativeStatus: 'resume-required', capabilities: f.capabilities,
    applied: { contextBudget: 100000 }, context: { usedTokens: 1000, stale: true } })
  expect(f.manager.appliedSessionPreferences).toHaveBeenCalledTimes(1)
  expect(f.manager.contextSnapshot).toHaveBeenCalledTimes(1)
})

it.each(providers)('reads persisted $harness capabilities after a service restart without loading native work', async ({ harness }) => {
  const f = await fixture(harness)
  const restarted = new SessionControlStore(f.pool, 'operator')
  const read = await restarted.read({ ...f.binding, manager: undefined })
  expect(read).toMatchObject({ desiredMode: 'plan', capabilities: f.capabilities,
    nativeStatus: 'resume-required', context: { usedTokens: 1000, stale: true } })
  expect(f.manager.sessionControlCapabilities).toHaveBeenCalledTimes(1)
})

it('persists discovered capabilities even when no setting changes and no context is available', async () => {
  const f = await fixture()
  f.records.clear()
  vi.mocked(f.manager.appliedSessionPreferences!).mockReturnValue(null)
  await f.store.read({ ...f.binding, manager: undefined, session: undefined })
  await f.store.read(f.binding)
  const restarted = new SessionControlStore(f.pool, 'operator')
  expect((await restarted.read({ ...f.binding, manager: undefined })).capabilities).toEqual(f.capabilities)
})

it('reports recovery with persisted settings when capabilities have not been discovered', async () => {
  const f = await fixture()
  f.records.clear()
  const read = await f.store.read({ ...f.binding, manager: undefined })
  expect(read).toMatchObject({ nativeStatus: 'resume-required', desiredMode: 'regular',
    capabilities: { plan: { supported: false } } })
})

it('does not hide unrelated provider failures as an unloaded session', async () => {
  const f = await fixture()
  const failure = new HarnessExecutionError('CODEX_THREAD_IDENTITY_MISMATCH', 'Wrong native session')
  vi.mocked(f.manager.sessionControlCapabilities!).mockRejectedValue(failure)
  await expect(f.store.read(f.binding)).rejects.toBe(failure)
})

it.each(providers)('reads saved controls when the $harness owner retires during capability discovery', async ({ harness }) => {
  const f = await fixture(harness)
  let owner: NativeHarnessSessionManager | undefined = f.manager
  const binding = { ...f.binding, get manager() { return owner } }
  vi.mocked(f.manager.sessionControlCapabilities!).mockImplementation(async () => {
    owner = undefined
    throw new Error('Native transport aborted when its owner closed')
  })
  expect(await f.store.read(binding)).toMatchObject({ desiredMode: 'plan', capabilities: f.capabilities,
    nativeStatus: 'resume-required', nativeSessionId: 'native', context: { stale: true } })
})

it('propagates transport failures while the native owner is still current', async () => {
  const f = await fixture()
  const failure = new Error('Native transport unavailable')
  vi.mocked(f.manager.sessionControlCapabilities!).mockRejectedValue(failure)
  await expect(f.store.read(f.binding)).rejects.toBe(failure)
})

it.each(providers)('reads persisted $harness controls when its admitted owner is disposed during discovery', async ({ harness }) => {
  const f = await fixture(harness)
  let owner: NativeHarnessSessionManager | undefined = f.manager
  const binding = { ...f.binding, get manager() { return owner } }
  vi.mocked(f.manager.sessionControlCapabilities!).mockImplementation(async () => {
    owner = undefined
    throw new DomainError('NATIVE_MANAGER_DISPOSED', 'The admitted native allocation is disposed.', 409)
  })
  expect(await f.store.read(binding)).toMatchObject({ desiredMode: 'plan', capabilities: f.capabilities,
    nativeStatus: 'resume-required', nativeSessionId: 'native', context: { stale: true } })
})

it('propagates disposal errors without confirmed owner retirement', async () => {
  const f = await fixture()
  const failure = new DomainError('NATIVE_MANAGER_DISPOSED', 'The native allocation is disposed.', 409)
  vi.mocked(f.manager.sessionControlCapabilities!).mockRejectedValue(failure)
  await expect(f.store.read(f.binding)).rejects.toBe(failure)
})

it('does not hide native identity errors even if the owner retires during the read', async () => {
  const f = await fixture()
  let owner: NativeHarnessSessionManager | undefined = f.manager
  const binding = { ...f.binding, get manager() { return owner } }
  const failure = new HarnessExecutionError('CODEX_THREAD_IDENTITY_MISMATCH', 'Wrong native session')
  vi.mocked(f.manager.sessionControlCapabilities!).mockImplementation(async () => {
    owner = undefined
    throw failure
  })
  await expect(f.store.read(binding)).rejects.toBe(failure)
})

it('preserves authorization rejection even if the native owner retires during the read', async () => {
  const f = await fixture()
  let owner: NativeHarnessSessionManager | undefined = f.manager
  const binding = { ...f.binding, get manager() { return owner } }
  const failure = new DomainError('ACCESS_DENIED', 'Read permission was removed', 403)
  vi.mocked(f.manager.sessionControlCapabilities!).mockImplementation(async () => {
    owner = undefined
    throw failure
  })
  await expect(f.store.read(binding)).rejects.toBe(failure)
})

it.each(['appliedSessionPreferences', 'contextSnapshot'] as const)(
  'keeps saved controls when the runtime unloads during %s', async method => {
    const f = await fixture()
    vi.mocked(f.manager[method]!).mockImplementation(() => {
      throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'Native runtime unloaded')
    })
    expect(await f.store.read(f.binding)).toMatchObject({ desiredMode: 'plan', nativeStatus: 'resume-required',
      capabilities: f.capabilities, applied: { contextBudget: 100000 }, context: { stale: true } })
  },
)

it.each(providers)('recovers saved compaction when the $harness runtime unloads during reconciliation',
  async ({ harness, code }) => {
    const f = await fixture(harness)
    const compaction = {
      requestId: 'pending-compaction', nativeSessionId: 'native', nativeOperationId: 'native-operation',
      dispatchPhase: 'dispatched' as const, status: 'uncertain' as const, beforeTokens: 1000,
      message: 'Compaction is unconfirmed.', observedAt: '2026-10-08T00:00:00.000Z',
    }
    f.records.set('conversation', { ...f.records.get('conversation')!, compaction })
    f.manager.reconcileCompaction = vi.fn(async () => {
      throw new HarnessExecutionError(code, 'Native runtime unloaded')
    })
    const recoverCompaction = vi.fn(async () => compaction)
    const read = await f.store.read({ ...f.binding, recoverCompaction })
    expect(read).toMatchObject({ desiredMode: 'plan', capabilities: f.capabilities,
      nativeStatus: 'resume-required', compaction, context: { stale: true } })
    expect(recoverCompaction).toHaveBeenCalledWith(compaction)
    expect(f.manager.appliedSessionPreferences).toHaveBeenCalledTimes(1)
    expect(f.manager.contextSnapshot).toHaveBeenCalledTimes(1)
    await expect(f.store.assertSendAllowed('conversation')).rejects.toMatchObject({
      code: 'SESSION_COMPACT_UNCONFIRMED',
    })
  },
)

it('propagates unrelated compaction reconciliation errors', async () => {
  const f = await fixture()
  const compaction = {
    requestId: 'pending-compaction', nativeSessionId: 'native', nativeOperationId: 'native-operation',
    dispatchPhase: 'dispatched' as const, status: 'uncertain' as const, beforeTokens: 1000,
    message: 'Compaction is unconfirmed.', observedAt: '2026-10-08T00:00:00.000Z',
  }
  f.records.set('conversation', { ...f.records.get('conversation')!, compaction })
  const failure = new HarnessExecutionError('CODEX_THREAD_IDENTITY_MISMATCH', 'Wrong native session')
  f.manager.reconcileCompaction = vi.fn(async () => { throw failure })
  const recoverCompaction = vi.fn(async () => compaction)
  await expect(f.store.read({ ...f.binding, recoverCompaction })).rejects.toBe(failure)
  expect(recoverCompaction).not.toHaveBeenCalled()
})

it('does not reuse capabilities from a different configuration', async () => {
  const f = await fixture()
  const read = await f.store.read({ ...f.binding, manager: undefined, profileKey: 'other-profile' })
  expect(read).toMatchObject({ profileKey: 'other-profile', desiredMode: 'regular', nativeStatus: 'resume-required',
    capabilities: { plan: { supported: false } }, context: null })
})

it('distinguishes a new conversation from an existing session that needs resume', async () => {
  const f = await fixture()
  const read = await f.store.read({ ...f.binding, conversationId: 'new-conversation', manager: undefined, session: undefined })
  expect(read).toMatchObject({ nativeStatus: 'not-started', nativeSessionId: null, context: null })
})

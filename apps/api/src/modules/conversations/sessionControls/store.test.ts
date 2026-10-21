import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SessionPreferencesSchema, unavailableSessionControls, type SessionControlState } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { memorySessionControlPool } from '../../../../test/support/sessionControls.js'
import { SessionControlStore, type SessionControlBinding } from './store.js'

// Command journaling and authenticated grants are covered by the PostgreSQL transport tests.
vi.mock('../nativeControlCommands.js', () => ({
  NativeConversationControlCommands: class {
    async execute(...args: [unknown, unknown, unknown, unknown, unknown,
      (markDispatch: () => void) => Promise<unknown>, () => Promise<unknown>]) {
      await args[5](() => {})
      return args[6]()
    }
  },
}))

const principal = { id: 'owner' } as ManagementPrincipal

async function fixture() {
  const records = new Map<string, SessionControlState>()
  const defaults = new Map<string, unknown>()
  const store = new SessionControlStore(memorySessionControlPool({ records, defaults }), 'operator')
  const binding: SessionControlBinding = { conversationId: 'conversation', principalId: principal.id,
    defaultSubject: 'application-operator', profileKey: 'profile', busyReason: null,
    pendingCapabilities: { ...unavailableSessionControls('profile'), contextBudgets: [100000, 200000, 300000],
      autoCompact: { supported: true, reason: null }, autoCompactBudget: { supported: true, reason: null },
      model: 'model', modelCapacity: 200000 } }
  const state = await store.read(binding)
  records.set(binding.conversationId, { ...state, context: { nativeSessionId: 'session', model: 'model',
    generation: 'connection', sequence: 1, source: 'codex', accuracy: 'native', usedTokens: 150000,
    capacityTokens: 200000, lifetimeTokens: 150000, cost: null, observedAt: '2026-10-08T00:00:00.000Z',
    stale: true } })
  return { store, binding, records, state }
}

it('saves future defaults below current usage and starts a new conversation with them', async () => {
  const f = await fixture()
  const preferences = SessionPreferencesSchema.parse({ contextBudget: 100000 })
  const saved = await f.store.execute(principal, 'mcp', { kind: 'save-default', preferences,
    expectedRevision: f.state.revision, requestId: 'future-default' }, async () => f.binding)
  expect(saved.defaults).toEqual(preferences)
  expect(saved.desired).toEqual(f.state.desired)
  expect(saved.context?.usedTokens).toBe(150000)
  expect((await f.store.read(f.binding)).defaults).toEqual(preferences)
  const fresh = await f.store.read({ ...f.binding, conversationId: 'future-conversation' })
  expect(fresh.desired).toEqual(preferences)
  expect(fresh.context).toBeNull()
})

it('still rejects lowering the current session below its history usage', async () => {
  const f = await fixture()
  await expect(f.store.execute(principal, 'http', { kind: 'preferences',
    preferences: SessionPreferencesSchema.parse({ contextBudget: 100000 }),
    expectedRevision: f.state.revision, requestId: 'current-budget' }, async () => f.binding))
    .rejects.toMatchObject({ code: 'SESSION_BUDGET_TOO_SMALL' })
  expect(f.records.get(f.binding.conversationId)?.desired).toEqual(f.state.desired)
})

it.each([
  { preferences: { contextBudget: 300000 }, code: 'SESSION_BUDGET_TOO_LARGE' },
  { preferences: { contextBudget: 120000 }, code: 'SESSION_PREFERENCE_UNSUPPORTED' },
  { preferences: { contextProfile: 'unavailable' }, code: 'SESSION_PREFERENCE_UNSUPPORTED' },
])('keeps model and capability validation for future defaults: $code', async ({ preferences, code }) => {
  const f = await fixture()
  await expect(f.store.execute(principal, 'mcp', { kind: 'save-default',
    preferences: SessionPreferencesSchema.parse(preferences), expectedRevision: f.state.revision,
    requestId: 'invalid-default' }, async () => f.binding)).rejects.toMatchObject({ code })
  expect((await f.store.read(f.binding)).defaults).toEqual(f.state.defaults)
})

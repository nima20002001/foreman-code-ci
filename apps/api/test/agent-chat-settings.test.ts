import { expect, it } from 'vitest'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { context, eventually, fixture } from './helpers/agentChatF1.js'
import { deferred } from './helpers/deferred.js'

it('keeps the native message receipt when settings change during its acknowledgment', async () => {
  const f = fixture()
  const query = f.store.pool.query.bind(f.store.pool)
  let changed = false
  f.store.pool.query = (async (text: string, values?: unknown[]) => {
    if (!changed && f.manager.starts.length && text.includes('update conversation_session_controls')) {
      changed = true
      const saved = f.store.sessionControls.get(f.store.row.id)!
      f.store.sessionControls.set(f.store.row.id, { ...saved, revision: saved.revision + 1,
        desiredMode: 'regular', desired: SessionPreferencesSchema.parse({ contextBudget: 100000 }),
        applied: SessionPreferencesSchema.parse({ contextBudget: 200000 }),
        applicability: 'safe-resume' })
    }
    return query(text, values)
  }) as typeof f.store.pool.query
  try {
    await f.send('planned-request', { sessionMode: 'plan' })
    await f.idle()
    expect(changed).toBe(true)
    expect(f.store.turns.get('planned-request')).toMatchObject({
      delivery: 'completed', native_turn_id: 'turn-planned-request',
    })
    expect(f.store.sessionControls.get(f.store.row.id)).toMatchObject({
      desiredMode: 'regular', desired: { contextBudget: 100000 }, appliedMode: 'plan',
      // The acknowledgment records the settings the native turn actually received (the accepted ones), not the concurrent edit.
      applied: { contextBudget: null }, applicability: 'safe-resume',
    })
    expect(f.manager.starts).toEqual(['planned-request'])
  } finally { await f.service.shutdown() }
})

it('continues the native message when applied-settings storage is unavailable', async () => {
  const f = fixture()
  const query = f.store.pool.query.bind(f.store.pool)
  let failed = false
  f.store.pool.query = (async (text: string, values?: unknown[]) => {
    if (!failed && f.manager.starts.length && text.includes('update conversation_session_controls')) {
      failed = true
      throw new Error('Settings storage unavailable')
    }
    return query(text, values)
  }) as typeof f.store.pool.query
  try {
    await f.send('accepted-request')
    await f.idle()
    expect(failed).toBe(true)
    expect(f.store.turns.get('accepted-request')).toMatchObject({
      delivery: 'completed', native_turn_id: 'turn-accepted-request',
    })
  } finally { await f.service.shutdown() }
})

it.each(['Planned steering text', '/plan Planned steering text'])(
  'rejects a Plan-mode steer before admitting or forwarding %s', async content => {
    const f = fixture()
    try {
      await f.active()
      await expect(f.send('plan-steer', { intent: 'steer', sessionMode: 'plan', content,
        expectedNativeTurnId: 'turn-A' })).rejects.toMatchObject({ code: 'SESSION_STEER_MODE_UNSUPPORTED' })
      expect(f.manager.steers).toEqual([])
      expect(f.store.turns.has('plan-steer')).toBe(false)
      expect((await f.read()).turns).toHaveLength(1)
    } finally { await f.service.shutdown() }
  },
)

it.each(['regular', 'plan'] as const)(
  'keeps text steering in the active %s mode without changing future defaults', async mode => {
    const f = fixture()
    try {
      f.manager.holds.set('active-turn', deferred())
      await f.send('active-turn', { sessionMode: mode })
      await eventually(() => f.store.row.active_native_turn_id === 'turn-active-turn')
      const saved = f.store.sessionControls.get(f.store.row.id)!
      const futureMode = mode === 'regular' ? 'plan' : 'regular'
      f.store.sessionControls.set(f.store.row.id, { ...saved, desiredMode: futureMode })
      const sent = await f.send('same-mode-steer', { intent: 'steer', sessionMode: mode,
        expectedNativeTurnId: 'turn-active-turn' })
      expect(sent.turn.delivery).toBe('accepted')
      expect(f.manager.steers).toHaveLength(1)
      expect(f.store.sessionControls.get(f.store.row.id)?.desiredMode).toBe(futureMode)
    } finally { await f.service.shutdown() }
  },
)

it('rejects switching a running Plan turn back to Regular through steering', async () => {
  const f = fixture()
  try {
    f.manager.holds.set('plan-turn', deferred())
    await f.send('plan-turn', { sessionMode: 'plan' })
    await eventually(() => f.store.row.active_native_turn_id === 'turn-plan-turn')
    await expect(f.service.send(f.principal, context.workspaceId, f.request('regular-steer', {
      intent: 'steer', sessionMode: 'regular', expectedNativeTurnId: 'turn-plan-turn',
    }))).rejects.toMatchObject({ code: 'SESSION_STEER_MODE_UNSUPPORTED' })
    expect(f.manager.steers).toEqual([])
  } finally { await f.service.shutdown() }
})

it.each(['turn', 'session', 'profile'] as const)(
  'ignores a late applied-settings callback after its %s changes', async changed => {
    const f = fixture()
    const start = f.manager.startTurn.bind(f.manager)
    let applied: (() => Promise<void>) | undefined
    f.manager.startTurn = async function* (session, input, signal) {
      applied = input.onSettingsApplied
      yield* start(session, input, signal)
    }
    try {
      await f.active()
      const saved = f.store.sessionControls.get(f.store.row.id)!
      const retained = { ...saved, appliedMode: 'plan' as const }
      if (changed === 'turn') f.store.row.active_request_id = 'later-request'
      if (changed === 'session') f.store.row.native_session_id = 'later-session'
      if (changed === 'profile') retained.profileKey = 'later-profile'
      f.store.sessionControls.set(f.store.row.id, retained)
      await applied!()
      expect(f.store.sessionControls.get(f.store.row.id)).toEqual(retained)
    } finally { await f.service.shutdown() }
  },
)

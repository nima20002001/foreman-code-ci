import type pg from 'pg'
import type { ReadObservation } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { nativePersistenceRedactor } from '../src/modules/interactions/nativePersistence.js'
import { reconcileKnownActivities } from '../src/modules/conversations/reconcileKnownActivities.js'
import { PostgresOperatorActivityRepository } from '../src/modules/conversations/operatorActivityRepository.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { knownNativeActivity } from '../src/modules/conversations/knownNativeActivity.js'
import { settleKnownActivity } from '../src/modules/conversations/settleKnownActivity.js'
function fixture() {
  const writes: string[] = []; const persisted: unknown[] = []
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('select id')) return { rows: [{ id: 'conversation', active_request_id: 'newer-B' }], rowCount: 1 }
    if (sql.includes('select a.request_id')) return { rows: [{ request_id: 'A', activity_id: 'child', sequence: '4', revision: '2', input_hash: 'hash-A',
      record: { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'unknown' },
      source_provenance: { native: { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', generation: 'generation', itemId: 'child' },
        ownerNative: { harness: 'codex', sessionId: 'root-session', turnId: 'root-A' }, ownerInputHash: 'hash-A' } }], rowCount: 1 }
    if (sql.startsWith('update')) { writes.push(sql); if (sql.includes('set record=')) persisted.push(JSON.parse(String(values[3]))); return { rows: [{ revision: '3' }], rowCount: 1 } }
    return { rows: [], rowCount: 0 }
  }
  return { pool: { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool, writes, persisted }
}
describe('independent known child settlement', () => {
  it('settles existing exact child after parent while leaving newer current owner fields untouched', async () => {
    const f = fixture()
    expect(await settleKnownActivity(f.pool, 'conversation', 'A', { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'completed' },
      { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', generation: 'generation', itemId: 'child' })).toMatchObject({ itemRevision: '3' })
    expect(f.writes).toHaveLength(2)
    expect(f.writes.join(' ')).not.toMatch(/active_request_id|active_native_turn_id|last_result|turn_state/)
  })
  it('rejects different native turn/generation before any mutation', async () => {
    const f = fixture()
    expect(await settleKnownActivity(f.pool, 'conversation', 'A', { id: 'child', requestId: 'A', kind: 'subagent', title: 'Child', status: 'completed' },
      { harness: 'codex', sessionId: 'child-session', turnId: 'other', generation: 'generation', itemId: 'child' })).toBeUndefined()
    expect(f.writes).toEqual([])
  })
  it('redacts synthetic credential-shaped input/output before shared known settlement persists or returns it', async () => {
    const f = fixture(), token = `opm_${'A'.repeat(43)}`
    const known = knownNativeActivity({ type: 'item.completed', sequence: 1, occurredAt: '2026-10-01T00:00:00Z',
      payload: { threadId: 'child-session', turnId: 'child-turn', nativeGeneration: 'generation', item: {
        id: 'child', type: 'commandExecution', status: 'completed', command: token, aggregatedOutput: `output ${token}`,
      } } }, 'codex')!
    const settled = await settleKnownActivity(f.pool, 'conversation', undefined, known.change, known.native)
    expect(settled).toBeDefined()
    expect(JSON.stringify(f.persisted)).not.toContain(token)
    expect(JSON.stringify(settled)).not.toContain(token)
    expect(settled?.activity).toMatchObject({ id: 'child', requestId: 'A', output: 'output [REDACTED]' })
  })

  it('uses captured owned secret values while leaving exact activity/native/owner identifiers untouched', async () => {
    const f = fixture(), captured = nativePersistenceRedactor(['child', 'owned-fixture-secret'])
    const settled = await settleKnownActivity(f.pool, 'conversation', 'A', {
      id: 'child', requestId: 'A', kind: 'subagent', title: 'owned-fixture-secret', status: 'completed', input: 'child owned-fixture-secret', output: 'owned-fixture-secret',
    }, { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', generation: 'generation', itemId: 'child' }, captured)
    expect(settled?.activity).toMatchObject({ id: 'child', requestId: 'A', title: '[REDACTED]', input: '[REDACTED] [REDACTED]', output: '[REDACTED]' })
    expect(f.writes.join(' ')).not.toMatch(/active_request_id|active_native_turn_id|last_result|turn_state/)
  })

  it('resident history settlement retains the captured owning redactor before credential cleanup', async () => {
    const f = fixture(), secrets = ['owned-fixture-secret'], token = `opm_${'B'.repeat(43)}`
    const activity = new PostgresOperatorActivityRepository(f.pool)
    vi.spyOn(activity, 'unfinishedOwners').mockResolvedValue({ hasMore: false, owners: [{ conversationId: 'conversation', requestId: 'A', activityId: 'child',
      native: { harness: 'codex', sessionId: 'child-session', turnId: 'child-turn', itemId: 'child', generation: 'generation' },
      ownerNative: { harness: 'codex', sessionId: 'root-session', turnId: 'root-A' } }] })
    const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'root-session' }
    const manager = { harness: 'codex', history: async () => {
      secrets.length = 0
      return { pendingInteractions: [], events: [{ sequence: 1, type: 'item.completed', occurredAt: '2026-10-01T00:00:00Z',
        payload: { threadId: 'child-session', turnId: 'child-turn', nativeGeneration: 'generation', item: {
          id: 'child', type: 'commandExecution', status: 'completed', command: 'owned-fixture-secret', aggregatedOutput: `${token} owned-fixture-secret`,
        } } }] }
    } } as unknown as NativeHarnessSessionManager
    const publish = vi.fn()
    const observations = new Map<string, ReadObservation>()
    await reconcileKnownActivities({ kind: 'operator', activity, signal: new AbortController().signal,
      observations, onObservation: vi.fn(),
      runtimeFor: () => ({ manager, session, redact: nativePersistenceRedactor(secrets) }), publish })
    expect(observations.get('conversation')).toMatchObject({ status: 'available', consecutiveFailures: 0 })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.persisted)).not.toContain(token); expect(JSON.stringify(f.persisted)).not.toContain('owned-fixture-secret')
    expect(JSON.stringify(publish.mock.calls)).not.toContain(token); expect(JSON.stringify(publish.mock.calls)).not.toContain('owned-fixture-secret')
    expect(publish.mock.calls[0]?.[1].activity).toMatchObject({ id: 'child', requestId: 'A', output: '[REDACTED] [REDACTED]' })
  })

})

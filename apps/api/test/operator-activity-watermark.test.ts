import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresOperatorActivityRepository, type ActivityMutationFence } from '../src/modules/conversations/operatorActivityRepository.js'
import type { OperatorActivityChange } from '../src/modules/conversations/operatorActivity.js'

function fixture() {
  let scopeRevision = 0
  let item: { record: OperatorActivityChange; source_provenance: Record<string, unknown>; sequence: string; revision: string } | undefined
  const owner = { requestId: 'A', sessionId: 'session', turnId: 'turn-A' }
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('select id,harness')) {
      const admitted = values[1] === owner.requestId && (values[2] === null || values[2] === owner.sessionId)
        && (values[3] === null || values[3] === owner.turnId)
      return { rows: admitted ? [{ id: 'conversation', harness: 'codex' }] : [], rowCount: admitted ? 1 : 0 }
    }
    if (sql.startsWith('select record,source_provenance')) return { rows: item ? [structuredClone(item)] : [], rowCount: item ? 1 : 0 }
    if (sql.startsWith('select input_hash')) return { rows: [{ input_hash: 'attempt-A' }], rowCount: 1 }
    if (sql.startsWith('insert into operator_conversation_activity')) {
      item = { record: JSON.parse(String(values[3])) as OperatorActivityChange,
        source_provenance: JSON.parse(String(values[4])) as Record<string, unknown>, sequence: '1', revision: String(item ? Number(item.revision) + 1 : 0) }
      return { rows: [structuredClone(item)], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversation_activity set source_provenance')) {
      item!.source_provenance = JSON.parse(String(values[3])) as Record<string, unknown>
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update operator_conversations set revision')) {
      scopeRevision++
      return { rows: [{ revision: String(scopeRevision) }], rowCount: 1 }
    }
    if (!['begin', 'commit', 'rollback'].includes(sql)) throw new Error(`Unexpected SQL ${sql}`)
    return { rows: [], rowCount: 0 }
  }
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  return { repository: new PostgresOperatorActivityRepository(pool), owner, state: () => structuredClone({ scopeRevision, item }) }
}

const value = (title: string, status: 'running' | 'completed' = 'running'): OperatorActivityChange => ({ id: 'tool', requestId: 'A', kind: 'tool', title, status })
const ownerFence: ActivityMutationFence = { nativeSessionId: 'session', nativeTurnId: 'turn-A' }
const history: ActivityMutationFence = { ...ownerFence, source: { system: 'codex_history' }, authoritativeReconciliation: true }
const sources: Array<{ name: string; source: (sequence: string) => NonNullable<ActivityMutationFence['source']>; watermark: Record<string, unknown> }> = [
  { name: 'legacy transport', source: (sequence) => ({ connectionId: 'connection-1', sequence }), watermark: { connectionId: 'connection-1', sequence: '8', transportSequence: 8 } },
  { name: 'explicit transport', source: (sequence) => ({ connectionId: 'connection-1', transportSequence: Number(sequence) }), watermark: { connectionId: 'connection-1', transportSequence: 8 } },
  { name: 'legacy native', source: (sequence) => ({ sequence }), watermark: { sequence: '8', nativeSequence: '8' } },
  { name: 'explicit native', source: (sequence) => ({ nativeSequence: sequence }), watermark: { nativeSequence: '8' } },
]

describe('Operator activity authoritative history watermarks', () => {
  for (const source of sources) it(`retains ${source.name} order through unsequenced corrections and rejects stale snapshots`, async () => {
    const f = fixture(), append = (title: string, fence: ActivityMutationFence) => f.repository.append('conversation', 'A', value(title), fence)
    await append('stream', { ...ownerFence, source: source.source('8') })
    expect(await append('current history', history)).toMatchObject({ itemRevision: '1', scopeRevision: '2' })
    const corrected = f.state()
    expect(await append('current history', history)).toBeUndefined()
    for (const authoritativeReconciliation of [false, true]) for (const sequence of ['7', '8']) {
      expect(await append(`stale ${sequence}`, { ...ownerFence, source: source.source(sequence), authoritativeReconciliation })).toBeUndefined()
    }
    expect(f.state()).toEqual(corrected)
    expect(f.state().item?.source_provenance).toMatchObject({ ...source.watermark, system: 'codex_history' })
    expect(await append('newer history', { ...history, source: source.source('9') })).toMatchObject({ itemRevision: '2', scopeRevision: '3' })
    expect(await append('another unsequenced correction', history)).toMatchObject({ itemRevision: '3', scopeRevision: '4' })
    expect(f.state().item?.record.title).toBe('another unsequenced correction')
  })

  it('preserves both independent watermarks and native owner generation/attempt provenance', async () => {
    const f = fixture()
    const native = { harness: 'codex', sessionId: 'session', turnId: 'turn-A', generation: 'generation-A', itemId: 'tool' }
    await f.repository.append('conversation', 'A', value('stream'), { ...ownerFence, native,
      parent: { kind: 'chat_request', conversationId: 'conversation', requestId: 'A' },
      source: { connectionId: 'connection-1', nativeSequence: '80', transportSequence: 8 } })
    expect(await f.repository.append('conversation', 'A', value('history'), history)).toBeDefined()
    expect(f.state().item?.source_provenance).toMatchObject({ connectionId: 'connection-1', nativeSequence: '80', transportSequence: 8,
      native, ownerNative: native, ownerInputHash: 'attempt-A', parent: { kind: 'chat_request', conversationId: 'conversation', requestId: 'A' } })
    const corrected = f.state()
    for (const source of [
      { connectionId: 'connection-1', nativeSequence: '79', transportSequence: 9 },
      { connectionId: 'connection-1', nativeSequence: '81', transportSequence: 7 },
    ]) expect(await f.repository.append('conversation', 'A', value('reordered'), { ...history, source })).toBeUndefined()
    expect(f.state()).toEqual(corrected)
  })

  it('admits shorter and empty same-status terminal history while retaining stream fences', async () => {
    const f = fixture(), source = { connectionId: 'connection-1', transportSequence: 8 }
    await f.repository.append('conversation', 'A', value('long provisional', 'completed'), { ...ownerFence, source })
    for (const output of ['short', '']) {
      expect(await f.repository.append('conversation', 'A', { ...value('terminal', 'completed'), output }, history)).toBeDefined()
      expect(f.state().item?.record.output).toBe(output)
    }
    const corrected = f.state()
    expect(await f.repository.append('conversation', 'A', value('stale', 'completed'), { ...history, source })).toBeUndefined()
    expect(await f.repository.append('conversation', 'A', value('wrong status'), history)).toBeUndefined()
    expect(f.state()).toEqual(corrected)
  })

  it('requests history on a changed connection and admits its authoritative reset sequence', async () => {
    const f = fixture(), reconcile = vi.fn()
    await f.repository.append('conversation', 'A', value('old connection'), { ...ownerFence, source: { connectionId: 'old', transportSequence: 50 } })
    await f.repository.append('conversation', 'A', value('history'), history)
    const corrected = f.state(), source = { connectionId: 'new', transportSequence: 1 }
    expect(await f.repository.append('conversation', 'A', value('new connection'), { ...ownerFence, source, onReconciliationRequired: reconcile })).toBeUndefined()
    expect(reconcile).toHaveBeenCalledOnce(); expect(f.state()).toEqual(corrected)
    expect(await f.repository.append('conversation', 'A', value('new history'), { ...history, source })).toBeDefined()
    expect(f.state().item?.source_provenance).toMatchObject(source)
    expect(await f.repository.append('conversation', 'A', value('new stream'), { ...ownerFence, source: { ...source, transportSequence: 2 } })).toBeDefined()
  })

  it('does not carry a prior connection watermark into an explicitly different unsequenced connection', async () => {
    const f = fixture()
    await f.repository.append('conversation', 'A', value('old connection'), { ...ownerFence, source: { connectionId: 'old', sequence: '50' } })
    expect(await f.repository.append('conversation', 'A', value('new history'), { ...history, connectionId: 'new' })).toBeDefined()
    expect(f.state().item?.source_provenance.connectionId).toBe('new')
    expect(f.state().item?.source_provenance.transportSequence).toBeUndefined()
    expect(f.state().item?.source_provenance.sequence).toBeUndefined()
    expect(await f.repository.append('conversation', 'A', value('new sequenced history'), { ...history, source: { connectionId: 'new', sequence: '1' } })).toBeDefined()
  })

  it('rejects unsequenced history for a different request, session or turn', async () => {
    const f = fixture()
    await f.repository.append('conversation', 'A', value('current'), { ...ownerFence, source: { connectionId: 'connection-1', transportSequence: 8 } })
    const before = f.state()
    expect(await f.repository.append('conversation', 'A', value('old session'), { ...history, nativeSessionId: 'old-session' })).toBeUndefined()
    expect(await f.repository.append('conversation', 'A', value('old turn'), { ...history, nativeTurnId: 'old-turn' })).toBeUndefined()
    f.owner.requestId = 'B'
    expect(await f.repository.append('conversation', 'A', value('old request'), history)).toBeUndefined()
    expect(f.state()).toEqual(before)
  })
})

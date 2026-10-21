import { describe, expect, it } from 'vitest'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { visitRepeatNativeAttemptsLocked, type RepeatNativeAttemptSelection } from '../src/modules/runs/repeatNativeAttempts.js'

type Attempt = { id: string; run: string; occurrence: string | null; slot: string | null; attempt: number }
function database(attempts: Attempt[]) {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const sql = { query: async (text: string, values: unknown[]) => {
    queries.push({ text, values })
    const [run, after, kind, key, through] = values
    expect(text).toContain('left join run_repeat_executions')
    expect(text).toContain('e.repeat_occurrence_id=$4')
    expect(text).toContain('x.technical_attempt<=$5::integer')
    expect(text).toContain('for update of e')
    const rows = attempts.filter((row) => row.run === run && row.id > String(after)
      && (kind === 'run' || kind === 'occurrence' && row.occurrence === key
        || kind === 'slot' && row.slot === key && row.attempt <= Number(through)))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 100).map(({ id }) => ({ id }))
    return { rows, rowCount: rows.length }
  } }
  return { sql: sql as unknown as GraphTransactionSql, queries }
}
function rows(count: number): Attempt[] {
  return Array.from({ length: count }, (_, i) => ({ id: `execution-${String(i).padStart(5, '0')}`,
    run: 'run', occurrence: 'occurrence-1', slot: `slot-${i}`, attempt: 1 }))
}

describe('ENG04 native attempt settlement scope', () => {
  it('settles old failed attempts without reaching an already-admitted future technical retry', async () => {
    const db = database([1, 2, 3].map((attempt) => ({ id: `attempt-${attempt}`, run: 'run', occurrence: 'occurrence-1', slot: 'slot', attempt })))
    const visited: string[] = []
    await visitRepeatNativeAttemptsLocked(db.sql, 'run', { kind: 'slot', id: 'slot', throughAttempt: 2 }, async (ids) => { visited.push(...ids) })
    expect(visited).toEqual(['attempt-1', 'attempt-2'])
    expect(db.queries[0]!.values).toEqual(['run', '', 'slot', 'slot', 2])
  })
  it('does not mix the same node from different occurrences', async () => {
    const data = rows(3)
    data[1]!.occurrence = 'occurrence-2'
    data[2]!.occurrence = null
    const db = database(data), visited: string[] = []
    await visitRepeatNativeAttemptsLocked(db.sql, 'run', { kind: 'occurrence', id: 'occurrence-1' }, async (ids) => { visited.push(...ids) })
    expect(visited).toEqual(['execution-00000'])
  })
  it('Run cleanup includes unmapped work and earlier occurrences, not only final resolutions', async () => {
    const data = rows(3)
    data[1]!.occurrence = 'occurrence-2'
    data[2]!.occurrence = null
    data[2]!.slot = null
    const db = database(data), visited: string[] = []
    await visitRepeatNativeAttemptsLocked(db.sql, 'run', { kind: 'run' }, async (ids) => { visited.push(...ids) })
    expect(visited).toEqual(data.map(({ id }) => id))
  })
  it('pages more than 1000 actual executions without a new arbitrary Run cap', async () => {
    const db = database(rows(1003)), batches: number[] = []
    await visitRepeatNativeAttemptsLocked(db.sql, 'run', { kind: 'run' }, async (ids) => { batches.push(ids.length) })
    expect(batches).toEqual([...Array<number>(10).fill(100), 3])
    expect(db.queries).toHaveLength(11)
  })
  it('does not continue to later attempts after a pending cleanup failure', async () => {
    const db = database(rows(201)), pending = new Error('same-execution closure pending')
    await expect(visitRepeatNativeAttemptsLocked(db.sql, 'run', { kind: 'run' }, async () => { throw pending })).rejects.toBe(pending)
    expect(db.queries).toHaveLength(1)
  })
  it.each([0, -1, 1.5, Number.NaN, 2147483648])('rejects an invalid technical-attempt bound %s', async (throughAttempt) => {
    const db = database(rows(1))
    const selected: RepeatNativeAttemptSelection = { kind: 'slot', id: 'slot', throughAttempt }
    await expect(visitRepeatNativeAttemptsLocked(db.sql, 'run', selected, async () => {})).rejects.toMatchObject({ code: 'REPEAT_EXECUTION_SCAN_CONFLICT' })
    expect(db.queries).toHaveLength(0)
  })
  it('fails closed on a duplicated page rather than revisiting the same receipt indefinitely', async () => {
    const sql = { query: async () => ({ rows: [{ id: 'duplicate' }, { id: 'duplicate' }], rowCount: 2 }) } as unknown as GraphTransactionSql
    await expect(visitRepeatNativeAttemptsLocked(sql, 'run', { kind: 'run' }, async () => {})).rejects.toMatchObject({ code: 'REPEAT_EXECUTION_SCAN_CONFLICT' })
  })
})

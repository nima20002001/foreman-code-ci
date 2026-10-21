import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { validateCiSupersession } from './supersession.js'
import { claimCiDispatch } from './dispatch.js'
import type { HostCiComputer } from './service.js'

function ticket(commit: string): CiRunRecord {
  return CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId: randomUUID(), suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'fixture/project', commit,
    state: 'queued', computer: null, step: null, exitCode: null, message: null,
    queuedAt: '2026-01-01T00:00:00Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: 'execution' },
  })
}

/** Row locks last until the admission transaction ends; dispatch uses a separate connection. */
function database(tickets: CiRunRecord[]) {
  const records = new Map(tickets.map(run => [run.id, run]))
  const locks = new Set<string>()
  let release!: () => void
  const committed = new Promise<void>(resolve => { release = resolve })
  const client = { query: async (text: string, values: unknown[] = []) => {
    const selected = Array.isArray(values[5]) ? values[5] as string[] : [...records.keys()]
    const rows = [...records.values()].filter(run => selected.includes(run.id))
    if (text.includes('for update')) for (const run of rows) locks.add(run.id)
    return { rows: rows.map(record => ({ record, joined_principal: null, joined_execution: null })) }
  } } as unknown as pg.PoolClient
  const dispatch = { query: async (_text: string, values: unknown[]) => {
    const id = values[0] as string
    if (locks.has(id)) await committed
    const run = records.get(id)!
    if (JSON.stringify(run) !== values[4]) return { rows: [], rowCount: 0 }
    records.set(id, CiRunRecordSchema.parse(JSON.parse(values[3] as string)))
    return { rows: [], rowCount: 1 }
  } } as unknown as pg.Pool
  return { client, dispatch, release, read: (id: string) => records.get(id) }
}

const computer: HostCiComputer = {
  key: 'build-slot', hostRef: { kind: 'main', mainId: 'main' }, label: 'Build slot', priority: 0,
}

it.each(['same commit', 'retained ancestry', 'no supersede'] as const)(
  'does not hold a ticket with %s while another ticket is superseded', async reason => {
    const replacement = ticket('a'.repeat(40))
    const kept = ticket(reason === 'same commit' ? replacement.commit : 'b'.repeat(40))
    if (reason === 'no supersede') kept.noSupersede = true
    const old = ticket('c'.repeat(40))
    const db = database([kept, old])
    expect(await validateCiSupersession(db.client, replacement,
      new Map([[kept.id, reason !== 'retained ancestry'], [old.id, true]]))).toEqual([old])
    const dispatch = claimCiDispatch(db.dispatch, kept, computer, {
      version: 1, operation: 'start', runId: kept.id, repository: kept.repository, commit: kept.commit,
      suite: kept.suite, scope: kept.scope, files: [],
    } as Parameters<typeof claimCiDispatch>[3])
    try {
      const outcome = await Promise.race([
        dispatch.then(result => result?.state),
        new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 100)),
      ])
      expect(outcome).toBe('starting')
      expect(db.read(kept.id)?.state).toBe('starting')
    } finally {
      db.release()
      await dispatch
    }
  },
)

it('retries preparation for an unrecognized candidate and respects changed protection', async () => {
  const replacement = ticket('a'.repeat(40))
  const old = ticket('b'.repeat(40))
  const db = database([old])
  expect(await validateCiSupersession(db.client, replacement, new Map())).toBeNull()
  old.noSupersede = true
  expect(await validateCiSupersession(db.client, replacement, new Map([[old.id, true]]))).toEqual([])
  db.release()
})

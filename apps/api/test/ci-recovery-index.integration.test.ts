import { randomUUID } from 'node:crypto'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { describe, expect, it, vi } from 'vitest'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

type Plan = { 'Node Type': string; 'Actual Rows': number; Plans?: Plan[] }

const recoveryQuery = `select id,record,host_key from ci_runs
  where state in ('starting','running') or record->>'collection'='pending'
    or (state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable')`

function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)]
}

describe.skipIf(!postgresEnabled)('CI recovery eligibility index', () => {
  it('reads every recovery branch through an index without scanning completed history', async () => {
    const database = await currentDatabase()
    try {
      await database.pool.query(`insert into workspaces(id,record) values('recovery-fixture','{}'::jsonb)`)
      await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
        select md5(n::text)::uuid,'recovery-fixture',md5(n::text)::uuid,'passed','{}'::jsonb
        from generate_series(1,6000) n`)
      const candidates = [
        { state: 'starting', record: {} },
        { state: 'running', record: {} },
        { state: 'passed', record: { collection: 'pending' } },
        { state: 'failed', record: { observation: { status: 'unavailable' } } },
        { state: 'canceled', record: { observation: { status: 'unavailable' } } },
        { state: 'lost', record: { observation: { status: 'unavailable' } } },
      ]
      for (const [index, candidate] of candidates.entries()) {
        await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
          values(md5($1)::uuid,'recovery-fixture',md5($1)::uuid,$2,$3::jsonb)`,
        [`candidate-${index}`, candidate.state, JSON.stringify(candidate.record)])
      }
      await database.pool.query('analyze ci_runs')
      expect((await database.pool.query(recoveryQuery)).rows).toHaveLength(candidates.length)
      const result = await database.pool.query(`explain (analyze,buffers,format json) ${recoveryQuery}`)
      const plan = result.rows[0]['QUERY PLAN'][0].Plan as Plan
      expect(plan['Actual Rows']).toBe(candidates.length)
      expect(nodes(plan).some(node => ['Index Scan', 'Bitmap Index Scan'].includes(node['Node Type']))).toBe(true)
      expect(nodes(plan).some(node => node['Node Type'] === 'Seq Scan')).toBe(false)
    } finally { await database.close() }
  }, 60_000)
})

it('recovers only eligible persisted tickets through dispatch without loading completed history', async () => {
  const database = await currentDatabase()
  const pool = database.pool
  const workspaceId = 'recovery-dispatch'
  const at = new Date().toISOString()
  const computer: HostCiComputer = { key: 'recovery-builder', label: 'Recovery builder', priority: 1,
    hostRef: { kind: 'main', mainId: 'fixture-main' } }
  const template = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId, groupId: randomUUID(),
    suite: 'lint', scope: 'full', part: null, partition: null, files: [], repository: 'example/project',
    commit: 'a'.repeat(40), state: 'passed', computer: { hostRef: computer.hostRef, label: computer.label },
    step: 'lint', exitCode: 0, message: null, queuedAt: at, startedAt: at, finishedAt: at,
    initiator: { principalId: 'fixture-operator', executionId: null } })
  const candidates = [
    { state: 'starting', finishedAt: null, exitCode: null },
    { state: 'running', finishedAt: null, exitCode: null },
    { state: 'passed', collection: 'pending' },
    ...['failed', 'canceled', 'lost'].map(state => ({ state, observation: { status: 'unavailable',
      lastSuccessAt: null, lastError: 'Disconnected', consecutiveFailures: 1, nextAttemptAt: null } })),
  ].map(changes => CiRunRecordSchema.parse({ ...template, id: randomUUID(), groupId: randomUUID(), ...changes }))
  const computers = candidates.map((record, index) => {
    const selected = { ...computer, key: `recovery-${index}`,
      hostRef: { kind: 'main' as const, mainId: `fixture-main-${index}` } }
    record.computer = { hostRef: selected.hostRef, label: selected.label }
    return selected
  })
  const observed = new Set<string>()
  const service = new HostCiService(pool, new PostgresCommandCoordinator(pool), new RunCiAuthority(pool), {} as CiCommits, {
    computers: async () => computers,
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, slotsTotal: 2, slotsUsed: 2, runs: [] }
      if (request.operation !== 'read') throw new Error('Recovery must observe an existing execution')
      observed.add(request.runId)
      const record = candidates.find(record => record.id === request.runId)
      if (!record) throw new Error('Completed history was sent to the build computer')
      return { operation: 'read', text: '', nextOffset: 0, run: { runId: record.id, state: record.state,
        step: 'lint', exitCode: record.exitCode, message: null, startedAt: at,
        finishedAt: record.finishedAt, logBytes: 0 } }
    },
  })
  try {
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Recovery dispatch' })])
    await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record)
      select md5(n::text)::uuid,$1,md5(n::text)::uuid,'passed',
        $2::jsonb || jsonb_build_object('id',md5(n::text),'groupId',md5(n::text)) from generate_series(1,6000) n`,
    [workspaceId, JSON.stringify(template)])
    for (const [index, record] of candidates.entries()) {
      const hostKey = ['starting', 'running'].includes(record.state) ? computers[index]!.key : null
      await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,host_key)
        values($1,$2,$3,$4,$5::jsonb,$6)`,
      [record.id, workspaceId, record.groupId, record.state, JSON.stringify(record), hostKey])
    }
    await pool.query('analyze ci_runs')
    let returnedRows = 0
    const query = pool.query.bind(pool)
    const measurement = vi.spyOn(pool, 'query').mockImplementation((async (text: string, values?: unknown[]) => {
      const result = await query(text, values)
      returnedRows += result.rows.length
      return result
    }) as typeof pool.query)
    try {
      await service.dispatch()
      await service.drain()
      await service.dispatch()
      await service.drain()
      expect(returnedRows).toBeLessThan(200)
      expect([...observed].sort()).toEqual(candidates.map(record => record.id).sort())
    } finally { measurement.mockRestore() }
    const stored = (await pool.query('select id,record from ci_runs where id=any($1::uuid[])',
      [candidates.map(record => record.id)])).rows
    expect(stored).toHaveLength(6)
    for (const row of stored) expect(row.record.observation).toMatchObject({ status: 'available', consecutiveFailures: 0 })
  } finally {
    await service.close()
    await database.close()
  }
})

import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'

/** Persisted ci_runs rows; each write replaces only the exact record it read, like the real compare-and-set. */
export function ticketStore(initial: CiRunRecord[], hostKeys: Record<string, string> = {},
  stoppedRun?: { id: string; executionId: string; commandId: string }) {
  const rows = new Map(initial.map(run => [run.id, { state: run.state as string, hostKey: hostKeys[run.id] ?? null,
    record: run as unknown }]))
  const matches = (id: unknown, previous: unknown) => {
    const row = rows.get(id as string)
    return row && isDeepStrictEqual(row.record, JSON.parse(previous as string)) ? row : undefined
  }
  const listed = (filter: (run: CiRunRecord, row: { state: string; hostKey: string | null }) => boolean) =>
    [...rows].filter(([, row]) => filter(CiRunRecordSchema.parse(row.record), row))
      .map(([id, row]) => ({ id, state: row.state, host_key: row.hostKey, record: row.record, durations: null }))
  const changed = (row: { state: string; hostKey: string | null; record: unknown } | undefined,
    next: { state?: unknown; hostKey?: unknown; record: unknown }) => {
    if (!row) return { rows: [], rowCount: 0 }
    if (next.state !== undefined) row.state = next.state as string
    if (next.hostKey !== undefined) row.hostKey = next.hostKey as string | null
    row.record = JSON.parse(next.record as string)
    return { rows: [], rowCount: 1 }
  }
  const claims = new Map<unknown, unknown>()
  const query = async (sql: string, p: unknown[] = []) => {
    const text = sql.replace(/\s+/gu, ' ').trim()
    if (stoppedRun) {
      if (text.startsWith('select workspace_id,record from workflow_stop_intents')) {
        return { rows: [{ workspace_id: initial[0]!.workspaceId, record: {
          principalId: 'operator', source: 'http', commandId: stoppedRun.commandId, runId: stoppedRun.id,
        } }] }
      }
      if (text.startsWith('select id from harness_executions')) return { rows: [{ id: stoppedRun.executionId }] }
      if (text.startsWith('select distinct c.group_id')) {
        return { rows: initial.map(run => ({ group_id: run.groupId })) }
      }
      if (text.startsWith('select record from ci_runs where workspace_id=$1 and group_id=$2')) {
        return { rows: listed(run => run.groupId === p[1]) }
      }
      if (text.startsWith('select id from ci_runs where workspace_id=$1 and group_id=any')) {
        return { rows: listed(run => ['queued', 'starting', 'running'].includes(run.state)) }
      }
    }
    if (text.startsWith('insert into ci_dispatch_claims')) {
      if (claims.has(p[0])) return { rows: [], rowCount: 0 }
      claims.set(p[0], p[1])
      return { rows: [{ ticket_id: p[0] }], rowCount: 1 }
    }
    if (text.startsWith('update ci_dispatch_claims')) {
      return { rows: [], rowCount: Number(claims.get(p[0]) === p[1]) }
    }
    if (text.startsWith('delete from ci_dispatch_claims')) {
      if (claims.get(p[0]) === p[1]) claims.delete(p[0])
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith("update ci_runs set state='canceled', host_key=null")) {
      const row = rows.get(p[0] as string)
      const run = row ? CiRunRecordSchema.parse(row.record) : undefined
      const matches = run?.state === 'queued' && (run.supersededBy ?? null) === p[2]
      return changed(matches ? row : undefined, { state: 'canceled', hostKey: null, record: p[1] })
    }
    if (text.startsWith('select record from ci_runs where state in')) {
      return { rows: listed(run => ['queued', 'starting', 'running'].includes(run.state) && !!run.supersededBy) }
    }
    if (text.startsWith('update ci_runs set record=$2::jsonb')) {
      return changed(matches(p[0], p[2]), { record: p[1] })
    }
    if (text.startsWith('select id,state,record')) return { rows: listed(() => true) }
    if (text.startsWith('update ci_runs set state=$2, host_key=case')) {
      const row = matches(p[0], p[5])
      return changed(row?.state === p[3] ? row : undefined, { state: p[1], hostKey: p[4] ? undefined : null, record: p[2] })
    }
    if (text.startsWith('update ci_runs set host_key=null, record=$2::jsonb')) {
      return changed(matches(p[0], p[2]), { hostKey: null, record: p[1] })
    }
    if (text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb where id=$1 and state=\'queued\'')) {
      return changed(matches(p[0], p[4]), { state: p[1], hostKey: p[2], record: p[3] })
    }
    if (text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb where id=$1 and state=\'starting\'')) {
      const row = matches(p[0], p[4])
      return changed(row?.state === 'starting' && row.hostKey === p[2] ? row : undefined,
        { state: p[1], hostKey: p[2], record: p[3] })
    }
    if (text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb,')
      || text.startsWith('update ci_runs set state=$2, host_key=$3, record=$4::jsonb ||')
      || text.startsWith('update ci_runs set state=$2, host_key=$3, log_tail=')) {
      return changed(matches(p[0], p[8]), { state: p[1], hostKey: p[2], record: p[3] })
    }
    if (text.startsWith('update ci_runs set record=$4::jsonb where id=$1 and state=$2 and workspace_id=$3')) {
      return changed(matches(p[0], p[4]), { record: p[3] })
    }
    if (text.startsWith('select record from ci_runs where id=$1')) return { rows: listed(run => run.id === p[0]) }
    if (text.startsWith('select id,record,host_key from ci_runs')) {
      return { rows: listed(run => ['starting', 'running'].includes(run.state) || run.collection === 'pending'
        || run.observation?.status === 'unavailable') }
    }
    if (text.startsWith('select host_key,record from ci_runs')) {
      return { rows: listed(run => ['starting', 'running'].includes(run.state) || run.deadlineExceeded?.executor === 'retained') }
    }
    if (text.startsWith('select record,durations from ci_runs where state=\'queued\'')) {
      return { rows: listed(run => run.state === 'queued' && !run.supersededBy) }
    }
    return { rows: [], rowCount: 0 }
  }
  const pool = { options: { max: 10 }, query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  return { pool, read: (id: string) => ({ ...rows.get(id)!, record: CiRunRecordSchema.parse(rows.get(id)!.record) }) }
}

import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { CiCommits } from './service.js'
import { serializeCiJson } from './text.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'

interface Candidate { run: CiRunRecord; requester: CiRunRecord['initiator'] }

/** Active tickets of the same suite this requester initiated, or whose group it joined; `requester` is how the
 * replacement's requester asked for each one. */
async function candidates(sql: SqlQuery, replacement: CiRunRecord, lockIds?: string[]): Promise<Candidate[]> {
  const rows = (await sql.query<{ record: unknown; joined_principal: string | null; joined_execution: string | null }>(
    `select c.record,q.principal_id as joined_principal,q.execution_id as joined_execution from ci_runs c
    left join lateral (select principal_id,execution_id from ci_group_requesters q
      where q.workspace_id=c.workspace_id and q.group_id=c.group_id and q.detached_at is null and not q.initiator
        and (q.principal_id=$4 or ($5::text is not null and q.execution_id=$5))
      order by q.joined_at limit 1) q on true
    where c.workspace_id=$1 and c.state in ('queued','starting','running')
      and c.record->>'repository'=$2 and c.record->>'suite'=$3
      and (c.record#>>'{initiator,principalId}'=$4
        or ($5::text is not null and c.record#>>'{initiator,executionId}'=$5) or q.principal_id is not null)
      ${lockIds ? 'and c.id=any($6::uuid[])' : ''}
    order by c.created_at,c.id${lockIds ? ' for update of c' : ''}`,
  [replacement.workspaceId, replacement.repository, replacement.suite,
    replacement.initiator.principalId, replacement.initiator.executionId, ...(lockIds ? [lockIds] : [])])).rows
  return rows.map(row => {
    const run = CiRunRecordSchema.parse(row.record)
    const initiated = run.initiator.principalId === replacement.initiator.principalId
      || (replacement.initiator.executionId !== null && run.initiator.executionId === replacement.initiator.executionId)
    return { run, requester: initiated || row.joined_principal === null ? run.initiator
      : { principalId: row.joined_principal, executionId: row.joined_execution } }
  })
}

function protectedRun(old: CiRunRecord, replacement: CiRunRecord): boolean {
  return old.commit === replacement.commit || Boolean(old.noSupersede || old.supersededBy)
}

/** Resolve Git facts without holding row or admission locks. */
export async function prepareCiSupersession(sql: SqlQuery, commits: CiCommits, replacement: CiRunRecord) {
  if (!commits.isAncestor || replacement.branch === undefined || !replacement.defaultBranch
    || replacement.branch === replacement.defaultBranch) return undefined
  const prepared = new Map<string, boolean>()
  const ancestry = new Map<string, boolean>()
  for (const { run: old, requester } of await candidates(sql, replacement)) {
    prepared.set(old.id, false)
    if (protectedRun(old, replacement)) continue
    const branch: string | null | undefined = old.branch === undefined
      ? await commits.branch?.(old.repository, replacement.defaultBranch, old.commit) : old.branch
    if (branch === undefined || branch === replacement.defaultBranch || branch === old.defaultBranch) continue
    const sameExecution = replacement.initiator.executionId !== null
      && requester.executionId === replacement.initiator.executionId
    const sameBranch = replacement.branch !== null && branch === replacement.branch
      && requester.principalId === replacement.initiator.principalId
    if (!sameExecution && !sameBranch) continue
    if (!ancestry.has(old.commit)) {
      ancestry.set(old.commit, await commits.isAncestor(replacement.repository, old.commit, replacement.commit))
    }
    prepared.set(old.id, ancestry.get(old.commit)!)
  }
  return prepared
}

/** Newly arrived candidates require another preparation pass outside the transaction. */
export async function validateCiSupersession(client: pg.PoolClient, replacement: CiRunRecord,
  prepared: Map<string, boolean> | undefined): Promise<CiRunRecord[] | null> {
  if (!prepared) return []
  const rows = (await candidates(client, replacement)).map(candidate => candidate.run)
  if (rows.some(old => !protectedRun(old, replacement) && !prepared.has(old.id))) return null
  const selected = rows.filter(old => !protectedRun(old, replacement) && prepared.get(old.id)).map(old => old.id)
  if (!selected.length) return []
  const locked = (await candidates(client, replacement, selected)).map(candidate => candidate.run)
  return locked.filter(old => !protectedRun(old, replacement) && prepared.get(old.id))
}

/** Admission and cancellation intent share a transaction; dispatch retries unfinished cleanup. */
export async function supersedeCiRuns(client: pg.PoolClient, replacement: CiRunRecord, rows: CiRunRecord[],
  audit: { source: 'mcp' | 'http'; commandId: string }) {
  for (const old of rows) {
    const next = { ...old, supersededBy: replacement.id, message: `superseded by ${replacement.id}` }
    await client.query('update ci_runs set record=$2::jsonb where id=$1', [old.id, serializeCiJson(next)])
    await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'ci.supersede',$3,'succeeded',$4::jsonb)`,
    [replacement.initiator.principalId, audit.source, `ci:${old.id}`, JSON.stringify({
      commandId: audit.commandId, ticketId: old.id, supersededBy: replacement.id,
    })])
  }
}

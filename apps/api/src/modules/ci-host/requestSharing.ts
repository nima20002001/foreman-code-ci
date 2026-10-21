import { createHash } from 'node:crypto'
import type pg from 'pg'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { CI_SHARING_REQUESTERS_LIMIT, CiRunOutputSchema, CiRunRecordSchema, type CiRunInput, type CiRunOutput,
  type CiRunRecord, type CiSharing } from '@foreman-code/contracts'
import { withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'

/** Who asked for a ticket group: an Operator or another principal, and the Agent execution when an Agent asked. */
export interface CiRequester { principalId: string; executionId: string | null }
type Requester = CiRequester & { initiator: boolean; active: boolean }
type Leaving = (requester: CiRequester) => boolean

const ACTIVE_STATES = ['queued', 'starting', 'running']
const sameRequester = (left: CiRequester, right: CiRequester) =>
  left.principalId === right.principalId && left.executionId === right.executionId
/** Supersession matches a requester's tickets by principal, or by Agent execution. */
const sameSupersessionRequester = (requester: CiRequester): Leaving => candidate =>
  candidate.principalId === requester.principalId
  || (requester.executionId !== null && candidate.executionId === requester.executionId)

/** Identical requests: same repository, resolved commit, suite, scope, base, file and partition selection and gate
 * flag. The workspace scopes every lookup. Smoke runs target one computer and never share. */
export function ciRequestKey(input: CiRunInput, run: CiRunRecord): string | null {
  if (input.smokeComputer) return null
  return createHash('sha256').update(canonicalJson({ repository: run.repository, commit: run.commit, suite: input.suite,
    scope: run.scope, baseCommit: input.baseCommit ?? null,
    files: input.files === undefined ? null : [...new Set(input.files)].sort(),
    partitions: input.partitions ?? null, gate: input.gate === true })).digest('hex')
}

async function readRequesters(sql: SqlQuery, workspaceId: string, groupId: string): Promise<Requester[]> {
  return (await sql.query<{ principal_id: string; execution_id: string | null; initiator: boolean; active: boolean }>(
    `select principal_id,execution_id,initiator,detached_at is null as active from ci_group_requesters
      where workspace_id=$1 and group_id=$2 order by initiator desc,joined_at,principal_id,execution_id`,
    [workspaceId, groupId])).rows.map(row => ({ principalId: row.principal_id, executionId: row.execution_id,
    initiator: row.initiator, active: row.active }))
}

async function insertRequester(sql: SqlQuery, workspaceId: string, groupId: string, requester: CiRequester,
  options: { initiator: boolean; commandId?: string; detached?: boolean }) {
  await sql.query(`insert into ci_group_requesters(group_id,workspace_id,principal_id,execution_id,initiator,command_id,
      detached_at) values($1,$2,$3,$4,$5,$6,case when $7 then now() end)
    on conflict (group_id,principal_id,(coalesce(execution_id,''))) do update set detached_at=excluded.detached_at`,
  [groupId, workspaceId, requester.principalId, requester.executionId, options.initiator, options.commandId ?? null,
    options.detached === true])
}

/** A group is joinable while it still runs and nothing canceled, lost or superseded any of its tickets. */
function joinable(tickets: CiRunRecord[]) {
  return tickets.some(ticket => ACTIVE_STATES.includes(ticket.state))
    && tickets.every(ticket => !['canceled', 'lost'].includes(ticket.state) && !ticket.supersededBy && !ticket.cancellation)
}

/** Joins the newest identical active group of the workspace that another requester asked for, inside the admission
 * transaction; null when none. A requester repeating its own request with a new commandId gets new tickets.
 * Identical admissions serialize on the request key, so concurrent requests find one group. */
export async function joinCiRequest(client: pg.ClientBase, workspaceId: string, key: string, requester: CiRequester,
  commandId: string): Promise<{ output: CiRunOutput; groupId: string } | null> {
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`ci-request:${workspaceId}:${key}`])
  const groups = (await client.query<{ group_id: string; output: unknown }>(`select g.group_id,g.output
    from ci_request_groups g where g.workspace_id=$1 and g.request_key=$2 and exists(select 1 from ci_runs c
      where c.workspace_id=g.workspace_id and c.group_id=g.group_id and c.state in ('queued','starting','running'))
    order by g.created_at desc limit 3`, [workspaceId, key])).rows
  for (const group of groups) {
    // Cancellation and supersession lock these rows for update while deciding; read what they decided.
    const tickets = (await client.query<{ record: unknown }>(`select record from ci_runs
      where workspace_id=$1 and group_id=$2 order by id for share`, [workspaceId, group.group_id])).rows
      .map(row => CiRunRecordSchema.parse(row.record))
    if (!joinable(tickets)) continue
    const requesters = await readRequesters(client, workspaceId, group.group_id)
    // Every requester of this group left; its cancellation is underway.
    if (requesters.length && !requesters.some(value => value.active)) continue
    const attached = requesters.length ? requesters.filter(value => value.active) : [tickets[0]!.initiator]
    if (attached.some(value => sameRequester(value, requester))) continue
    if (!requesters.length) {
      await insertRequester(client, workspaceId, group.group_id, tickets[0]!.initiator, { initiator: true })
    }
    await insertRequester(client, workspaceId, group.group_id, requester, { initiator: false, commandId })
    const others = (await readRequesters(client, workspaceId, group.group_id))
      .filter(value => value.active && !sameRequester(value, requester)).length
    return { groupId: group.group_id,
      output: CiRunOutputSchema.parse({ ...CiRunOutputSchema.parse(group.output), joined: true, sharedWith: others }) }
  }
  return null
}

/** Makes a newly admitted group findable by identical requests while it is active. */
export async function registerCiRequest(client: pg.ClientBase, workspaceId: string, groupId: string, key: string,
  output: CiRunOutput) {
  await client.query(`insert into ci_request_groups(group_id,workspace_id,request_key,output) values($1,$2,$3,$4::jsonb)`,
    [groupId, workspaceId, key, JSON.stringify(output)])
}

/** Detaches leaving requesters from one group and returns how many other requesters still need it; 0 means its
 * tickets may be canceled. `close` records an unshared group's initiator as detached so no request joins it while
 * its cancellation is underway; a caller that never requested the group closes it for everyone. */
async function releaseGroup(client: pg.ClientBase, workspaceId: string, groupId: string, leaving: Leaving,
  close: boolean): Promise<number> {
  const tickets = (await client.query<{ record: unknown }>(`select record from ci_runs
    where workspace_id=$1 and group_id=$2 order by id for update`, [workspaceId, groupId])).rows
  if (!tickets.length) return 0
  const requesters = await readRequesters(client, workspaceId, groupId)
  if (!requesters.length) {
    if (close) {
      await insertRequester(client, workspaceId, groupId, CiRunRecordSchema.parse(tickets[0]!.record).initiator,
        { initiator: true, detached: true })
    }
    return 0
  }
  const wasRequester = requesters.some(leaving)
  const remaining = requesters.filter(value => value.active && !leaving(value))
  for (const value of requesters.filter(value => value.active && (leaving(value) || (close && !wasRequester)))) {
    await client.query(`update ci_group_requesters set detached_at=now()
      where workspace_id=$1 and group_id=$2 and principal_id=$3 and execution_id is not distinct from $4`,
    [workspaceId, groupId, value.principalId, value.executionId])
  }
  return wasRequester ? remaining.length : 0
}

/** ci_cancel: a requester of a group others still share only detaches. Returns the requesters that remain, or 0 when
 * the ticket should be canceled. */
export function releaseCiRequester(pool: pg.Pool, run: CiRunRecord, requester: CiRequester): Promise<number> {
  return withTransaction(pool, client => releaseGroup(client, run.workspaceId, run.groupId,
    value => sameRequester(value, requester), true), { conflictRetries: 2 })
}

/** Run Stop detaches the Run's Agents from every group they initiated or joined, and returns the groups no other
 * requester still needs: those the Stop cancels. */
export function releaseStoppedRun(pool: pg.Pool, runId: string, workspaceId: string): Promise<string[]> {
  return withTransaction(pool, async client => {
    const executions = (await client.query<{ id: string }>('select id from harness_executions where run_id=$1',
      [runId])).rows.map(row => row.id)
    if (!executions.length) return []
    const groups = (await client.query<{ group_id: string }>(`select distinct c.group_id from ci_runs c
      where c.workspace_id=$1 and c.state in ('queued','starting','running')
        and (c.record#>>'{initiator,executionId}'=any($2::text[]) or exists(select 1 from ci_group_requesters q
          where q.workspace_id=c.workspace_id and q.group_id=c.group_id and q.execution_id=any($2::text[])))
      order by c.group_id`, [workspaceId, executions])).rows
    const stopped = new Set(executions)
    const canceled: string[] = []
    for (const { group_id: groupId } of groups) {
      const remaining = await releaseGroup(client, workspaceId, groupId,
        value => value.executionId !== null && stopped.has(value.executionId), true)
      if (!remaining) canceled.push(groupId)
    }
    return canceled
  }, { conflictRetries: 2 })
}

/** Superseded tickets of groups that other requesters still share stay; the superseding requester only detaches. */
export async function spareSharedSupersession(client: pg.ClientBase, superseded: CiRunRecord[], requester: CiRequester) {
  const kept = new Set<string>()
  for (const groupId of [...new Set(superseded.map(run => run.groupId))].sort()) {
    const run = superseded.find(value => value.groupId === groupId)!
    if (await releaseGroup(client, run.workspaceId, groupId, sameSupersessionRequester(requester), false)) kept.add(groupId)
  }
  return superseded.filter(run => !kept.has(run.groupId))
}

/** The group's requesters, when identical requests joined it. */
export async function ciGroupSharing(sql: SqlQuery, workspaceId: string, groupId: string): Promise<CiSharing | undefined> {
  const requesters = await readRequesters(sql, workspaceId, groupId)
  if (!requesters.some(value => !value.initiator)) return undefined
  return { requesters: requesters.slice(0, CI_SHARING_REQUESTERS_LIMIT) }
}

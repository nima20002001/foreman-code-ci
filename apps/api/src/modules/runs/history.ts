import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { RunExecutionStateSchema, RunOutcomeSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  RunBoardSnapshotGetInputSchema, RunBoardSnapshotGetResultSchema, RunBoardSnapshotSchema,
  RunDropdownListInputSchema, RunDropdownPageSchema, RunDropdownSummarySchema, runDropdownStatus,
  type RunBoardSnapshotGetResult, type RunDropdownPage,
} from '@foreman-code/contracts/run-snapshots'
import { isAuthorized, requireAuthorization, type AuthorizedResource } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { decodeRunHistoryCursor, encodeRunHistoryCursor } from './historyCursor.js'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { readRunActivitySnapshot } from './activitySnapshot.js'
import { readRunIntervalChecks } from './intervalChecks.js'
import { readRunExecutionQueue } from './executionQueue.js'

type WorkflowScope = { workspaceId: string; workflowId: string }

/** null means all Runs in THIS workflow, not an unscoped resource. A Run-only
 * grant may list its own Runs but must not learn other IDs through a cursor. */
function allowedRunIds(principal: ManagementPrincipal, scope: WorkflowScope): string[] | null {
  if (isAuthorized(principal, 'runs:read', scope)) return null
  const ids = [...new Set(principal.grants.flatMap((grant) => grant.scope.runIds ?? []))]
    .filter((runId) => isAuthorized(principal, 'runs:read', { ...scope, runId }))
  if (!ids.length) throw new DomainError('ACCESS_DENIED', 'Run history is not authorized for this workflow.', 403)
  return ids
}

function intersect(left: string[] | null, right: string[] | null): string[] | null {
  if (left === null) return right
  if (right === null) return left
  const allowed = new Set(right)
  return left.filter((id) => allowed.has(id))
}

function storedDataInvalid(): never {
  throw new DomainError('RUN_HISTORY_DATA_INVALID', 'Stored Run history is invalid; no current graph was substituted.', 409)
}

interface SummaryRow {
  id: string
  admitted_at: string
  started_at: unknown
  execution_state: unknown
  outcome: unknown
  trigger: unknown
}

/** Read-only, shared HTTP/Operator service. It deliberately has no dependency on
 * the current workflow definition, Agent repository, engine or native sessions. */
export class RunHistoryService {
  constructor(private readonly pool: pg.Pool) {}

  private async read<T>(principal: ManagementPrincipal,
    authorize: (candidate: ManagementPrincipal) => void,
    work: (client: pg.PoolClient, live: ManagementPrincipal) => Promise<T>): Promise<T> {
    authorize(principal)
    return withTransaction(this.pool, async (client) => {
      // Delegation/grant rows remain share-locked until this read commits.
      const live = await readLiveManagementPrincipal(client, principal.id)
      authorize(live)
      const result = await work(client, live)
      // Expiry can pass while SQL is in flight even though revocation is locked.
      authorize(principal)
      authorize(live)
      return result
    }, { isolation: 'repeatable read' })
  }

  async list(principal: ManagementPrincipal, raw: unknown): Promise<RunDropdownPage> {
    const input = RunDropdownListInputSchema.parse(raw)
    const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    return this.read(principal, (candidate) => { allowedRunIds(candidate, scope) }, async (client, live) => {
      const allowed = intersect(allowedRunIds(principal, scope), allowedRunIds(live, scope))
      if (allowed !== null && !allowed.length) throw new DomainError('ACCESS_DENIED', 'Run history is not authorized.', 403)
      const cursor = decodeRunHistoryCursor(scope, input.cursor)
      const workflow = await client.query('select id from workflows where workspace_id=$1 and id=$2',
        [scope.workspaceId, scope.workflowId])
      if (!workflow.rowCount) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not found in this workspace.', 404)
      // New admissions persist ACTUAL trigger provenance with the snapshot.
      // At this pinned base, pre-capture V3 admission permits only manual Start
      // (triggerJobId is fenced). executionCondition is merely eligibility: a
      // manual Start of a schedule-eligible graph must NOT be called scheduled.
      // Older non-V3 rows have no proven two-value trigger here; omit those
      // summaries, retain their rows and permit explicit unavailable snapshots.
      // See the frozen-contract gap in the handoff; never query mutable triggers.
      const found = await client.query<SummaryRow>(`
        select r.id,
          to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as admitted_at,
          r.record->'startedAt' as started_at, r.execution_state, r.record->'outcome' as outcome,
          coalesce(s.admission_trigger, case when r.record->>'executionSemanticsVersion'='3' then 'manual' end) as trigger
        from runs r left join run_board_snapshots s on s.run_id=r.id
        where r.workspace_id=$1 and r.workflow_id=$2
          and ($3::timestamptz is null or
            (r.created_at, r.id collate "C") < ($3::timestamptz, $4::text collate "C"))
          and ($5::text[] is null or r.id=any($5::text[]))
          and coalesce(s.admission_trigger, case when r.record->>'executionSemanticsVersion'='3' then 'manual' end) in ('manual','schedule')
        order by r.created_at desc, r.id collate "C" desc limit $6`,
      [scope.workspaceId, scope.workflowId, cursor?.admittedAt ?? null, cursor?.runId ?? null, allowed, input.limit + 1])
      const page = found.rows.slice(0, input.limit)
      const items = page.map((row) => {
        const executionState = RunExecutionStateSchema.safeParse(row.execution_state)
        const outcome = RunOutcomeSchema.safeParse(row.outcome)
        if (!executionState.success || !outcome.success
          || (executionState.data === 'completed' && outcome.data === 'pending')) storedDataInvalid()
        const summary = RunDropdownSummarySchema.safeParse({
          runId: row.id, shortId: row.id.replace(/^run-/, '').slice(0, 8) || row.id.slice(0, 8),
          startedAt: row.started_at ?? null,
          status: runDropdownStatus({ executionState: executionState.data, outcome: outcome.data }), trigger: row.trigger,
        })
        if (!summary.success) storedDataInvalid()
        return summary.data
      })
      const last = page.at(-1)
      return RunDropdownPageSchema.parse({ items, pageInfo: {
        nextCursor: found.rows.length > input.limit && last
          ? encodeRunHistoryCursor(scope, { admittedAt: last.admitted_at, runId: last.id }) : null,
      } })
    })
  }

  async snapshot(principal: ManagementPrincipal, raw: unknown): Promise<RunBoardSnapshotGetResult> {
    const input = RunBoardSnapshotGetInputSchema.parse(raw)
    const resource: AuthorizedResource = { ...input }
    return this.read(principal, (candidate) => requireAuthorization(candidate, 'runs:read', resource), async (client) => {
      // Check ALL physical identifiers. An authorized workflow ID cannot be used
      // as a wrapper around an unrelated/forged Run ID, including legacy Runs.
      const result = await client.query<{ workflow_version_id: string; snapshot_id: string | null; snapshot: unknown
        execution_state: string }>(`
        select r.workflow_version_id, s.run_id as snapshot_id, s.record as snapshot, r.execution_state
        from runs r left join run_board_snapshots s on s.run_id=r.id
        where r.workspace_id=$1 and r.workflow_id=$2 and r.id=$3`,
      [input.workspaceId, input.workflowId, input.runId])
      const row = result.rows[0]
      if (!row) throw new DomainError('RUN_NOT_FOUND', 'Run not found in this workspace and workflow.', 404)
      if (row.snapshot_id === null) return RunBoardSnapshotGetResultSchema.parse({ snapshot: {
        ...input, kind: 'unavailable', reason: 'legacy_run',
      } })
      const parsed = RunBoardSnapshotSchema.safeParse(row.snapshot)
      if (!parsed.success || parsed.data.kind !== 'available') storedDataInvalid()
      const snapshot = parsed.data
      if (snapshot.workspaceId !== input.workspaceId || snapshot.workflowId !== input.workflowId
        || snapshot.runId !== input.runId || snapshot.workflowVersionId !== row.workflow_version_id) storedDataInvalid()
      const ci = await client.query(`select 1 from ci_runs c join harness_executions e
        on (e.id=c.record#>>'{initiator,executionId}'
          or exists(select 1 from ci_group_requesters q where q.workspace_id=c.workspace_id
            and q.group_id=c.group_id and q.execution_id=e.id))
        where e.run_id=$1 and c.workspace_id=$2 limit 1`, [input.runId, input.workspaceId])
      const versionRow = (await client.query<{ record: unknown }>(
        'select record from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3',
        [snapshot.workflowVersionId, input.workspaceId, input.workflowId])).rows[0]
      const version = WorkflowVersionV3Schema.parse(versionRow?.record)
      const intervalChecks = version.definition.nodes.some(node => node.kind !== 'job' && node.interval)
        ? await readRunIntervalChecks(client, input.runId, row.execution_state, version) : undefined
      const executionQueue = row.execution_state === 'completed' ? [] : readRunExecutionQueue(input.runId)
      if (!ci.rows.length) return RunBoardSnapshotGetResultSchema.parse({ snapshot, executionQueue,
        ...(intervalChecks ? { intervalChecks } : {}) })
      const activitySnapshot = await readRunActivitySnapshot(client,
        { ...input, workflowVersionId: snapshot.workflowVersionId }, version)
      return RunBoardSnapshotGetResultSchema.parse({ snapshot, activitySnapshot, executionQueue,
        ...(intervalChecks ? { intervalChecks } : {}) })
    })
  }
}

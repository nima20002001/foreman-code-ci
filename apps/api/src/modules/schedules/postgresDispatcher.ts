import { createHash } from 'node:crypto'
import { withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  nextOccurrences, ScheduleOccurrenceSchema, scheduleOccurrenceId,
  type ScheduleOccurrence, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import { RunStartV3InputSchema, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { DeviceAccessError } from '../devices/access.js'
import {
  IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion, type ImmutableWorkflowVersionRow,
} from '../workflows/immutableRead.js'
import { readScheduleAuthority } from './authority.js'
import { decideDueSchedule, planDueSchedule, type DueScheduleStep } from './dispatchPlan.js'
import { PostgresWorkflowScheduleRepository } from './postgres.js'
import type { ScheduleStartGuard } from '../runs/repeatStartAdmission.js'
import type { RepeatStartPreparation } from '../runs/repeatStartAdmission.js'

interface PreparedStart {
  kind: 'start'
  schedule: WorkflowSchedule
  dueAt: string
  principal: ManagementPrincipal
  input: RunStartV3Input
}
type SchedulePreparation = PreparedStart | { kind: 'continue'; schedule: WorkflowSchedule }
export type ScheduledStart = (principal: ManagementPrincipal, input: RunStartV3Input,
  guard: ScheduleStartGuard) => Promise<void>
const retry = () => new DomainError('SCHEDULE_DISPATCH_RETRY', 'Re-read the schedule before admission.', 409)

/** Application-owned reason codes only. Unknown/native/SQL errors are retried,
 * never copied into public history and never treated as negative COMMIT proof. */
export function scheduleRejectionReason(error: unknown): string | undefined {
  if (error instanceof DeviceAccessError) {
    return error.code === 'conflict' ? 'workflow_not_executable' : 'schedule_authorization_denied'
  }
  if (!(error instanceof DomainError)) return undefined
  if (['ACCESS_DENIED', 'AUTH_INVALID', 'AUTH_REVOKED', 'AUTH_EXPIRED', 'AUTH_RUN_ENDED'].includes(error.code)) {
    return 'schedule_authorization_denied'
  }
  if (error.code === 'SCHEDULE_AUTHORITY_MISSING') return 'schedule_authority_missing'
  if (['WORKFLOW_VERSION_NOT_FOUND', 'SCHEDULE_WORKFLOW_NOT_SAVED'].includes(error.code)) return 'workflow_not_saved'
  if (['WORKFLOW_CONFIGURATION_STALE', 'EXECUTION_SEMANTICS_UNSUPPORTED', 'AGENT_CONFIGURATION_UNAVAILABLE',
    'WORKFLOW_VERSION_RECORD_INVALID', 'WORKFLOW_VERSION_PIN_MISMATCH', 'WORKFLOW_VERSION_HASH_MISMATCH',
    'PLACEMENT_ADMISSION_CONFLICT', 'PLACEMENT_INVALID_ROOT', 'SOURCE_UNAVAILABLE',
    'ROOT_POLICY_CONFLICT', 'ROOT_POLICY_UNAVAILABLE', 'ROOT_CONFIGURATION_CONFLICT', 'ROOT_CONFIGURATION_MISSING',
    'HARNESS_INSTANCE_INVALID', 'HARNESS_INSTANCE_CHANGED', 'HARNESS_INSTALLATION_INVALID', 'HARNESS_INSTALLATION_CHANGED',
  ].includes(error.code)) return 'workflow_not_executable'
  return undefined
}

/** Actual admission uses shared workspace/workflow/schedule row locks, NOT this
 * process's polling state. An occurrence and its cursor advance always commit
 * together. The common Start transaction additionally owns Run/authority/G1.
 * No filesystem/native I/O is performed in these short preparation transactions. */
export class PostgresScheduleDispatcher {
  readonly repository: PostgresWorkflowScheduleRepository
  constructor(private readonly pool: pg.Pool, private readonly start: ScheduledStart,
    private readonly clock: () => Date = () => new Date()) {
    this.repository = new PostgresWorkflowScheduleRepository(pool)
  }
  listDueSchedules(input: Parameters<PostgresWorkflowScheduleRepository['listDueSchedules']>[0]) {
    return this.repository.listDueSchedules(input)
  }
  async dispatch(observed: WorkflowSchedule, signal?: AbortSignal,
    onCandidate?: (candidate: WorkflowSchedule) => void): Promise<void> {
    // Re-read once after a disable/version/time race. Persistent failures leave
    // the due cursor intact; the next bounded scan retries from durable state.
    let candidate = observed
    const preparation: RepeatStartPreparation = {}
    let attempt = 0
    while (attempt < 2) {
      onCandidate?.(candidate)
      signal?.throwIfAborted()
      const prepared = await this.prepare(candidate)
      signal?.throwIfAborted()
      if (!prepared) return
      candidate = prepared.schedule
      onCandidate?.(candidate)
      if (prepared.kind === 'continue') continue
      attempt++
      try {
        await this.start(prepared.principal, prepared.input, this.guard(prepared, preparation, signal))
        return
      } catch (error) {
        const reason = scheduleRejectionReason(error)
        if (reason) {
          await this.prepare(candidate, { dueAt: prepared.dueAt, reason })
          continue // a newer occurrence needs its own latest-saved admission
        }
        if (error instanceof DomainError && ['SCHEDULE_DISPATCH_RETRY', 'WORKFLOW_BASE_CONFLICT',
          'LOCATION_REVISION_CONFLICT'].includes(error.code)) continue
        throw error
      }
    }
  }
  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }
  private async existing(client: SqlQuery, schedule: WorkflowSchedule, dueAt: string) {
    const row = (await client.query<{ record: unknown }>(`select record from workflow_schedule_occurrences
      where workspace_id=$1 and workflow_id=$2 and due_at=$3`,
    [schedule.workspaceId, schedule.workflowId, dueAt])).rows[0]
    return row ? ScheduleOccurrenceSchema.parse(row.record) : null
  }
  private async overlapping(client: SqlQuery, schedule: WorkflowSchedule, exceptRunId?: string): Promise<boolean> {
    const found = await client.query(`select 1 from workflow_schedule_occurrences occurrence
      join runs run on run.id=occurrence.run_id
      where occurrence.workspace_id=$1 and occurrence.workflow_id=$2 and occurrence.status='accepted'
        and ($3::text is null or run.id<>$3)
        and (run.execution_state in ('queued','running','waiting','interrupted')
          or exists(select 1 from run_cleanup_intents cleanup where cleanup.run_id=run.id and cleanup.pending)) limit 1`,
    [schedule.workspaceId, schedule.workflowId, exceptRunId ?? null])
    return found.rows.length !== 0
  }
  private fact(schedule: WorkflowSchedule, dueAt: string,
    outcome: { status: 'skipped' | 'missed' | 'rejected'; reason: string }): ScheduleOccurrence {
    return ScheduleOccurrenceSchema.parse({ workspaceId: schedule.workspaceId, workflowId: schedule.workflowId,
      id: scheduleOccurrenceId(schedule.workflowId, dueAt), dueAt, scheduleRevision: schedule.revision, ...outcome })
  }
  private async recordMissedBatch(client: pg.PoolClient, schedule: WorkflowSchedule,
    steps: DueScheduleStep[], now: string): Promise<void> {
    const facts = steps.map((step) => {
      if (step.decision.status !== 'missed') throw new Error('Recovery requires missed occurrences.')
      return this.fact(schedule, step.dueAt, step.decision)
    })
    // The workflow lock serializes writers; existing immutable outcomes remain intact.
    await client.query(`insert into workflow_schedule_occurrences
      (id,workspace_id,workflow_id,due_at,schedule_revision,status,reason,record,recorded_at)
      select fact->>'id',fact->>'workspaceId',fact->>'workflowId',(fact->>'dueAt')::timestamptz,
        (fact->>'scheduleRevision')::bigint,fact->>'status',fact->>'reason',fact,$2::timestamptz
      from jsonb_array_elements($1::jsonb) fact
      on conflict (workflow_id,due_at) do nothing`, [JSON.stringify(facts), now])
    await this.repository.advanceCursor(client, { workspaceId: schedule.workspaceId, workflowId: schedule.workflowId },
      schedule.revision,
      steps[0]!.dueAt, steps.at(-1)!.nextDueAt)
  }
  private async prepare(observed: WorkflowSchedule,
    rejection?: { dueAt: string; reason: string }): Promise<SchedulePreparation | undefined> {
    return this.transaction(async (client) => {
      // Principal locks precede workspace locks, matching schedule writes and
      // manual admission. Revisions below fence a concurrently replaced binding.
      let principal: ManagementPrincipal | undefined
      let authorityFailure: string | undefined
      try { principal = await readScheduleAuthority(client, observed) } catch (error) {
        authorityFailure = scheduleRejectionReason(error)
        if (!authorityFailure) throw error
      }
      const slot = await this.repository.lock(client, observed)
      const now = this.clock().toISOString() // after any lock wait
      const current = slot?.value
      if (!slot || !observed.nextOccurrenceAt) return
      if (!current?.enabled) {
        const dueAt = observed.nextOccurrenceAt
        if (await this.existing(client, observed, dueAt)) return
        const decision = decideDueSchedule(observed, dueAt, now, false, false)
        if (decision.status === 'missed' || decision.status === 'skipped') {
          await this.repository.recordOccurrence(client, this.fact(observed, dueAt, decision), now)
        }
        return // disable/clear already nulled the cursor, never restore it
      }
      if (current.revision !== observed.revision) return // changed configuration: rescan, never use stale pins
      const steps = planDueSchedule(current, now)
      const missed = steps.filter((step) => step.decision.status === 'missed')
      if (!rejection && missed.length) {
        await this.recordMissedBatch(client, current, missed, now)
        return { kind: 'continue', schedule: { ...current, nextOccurrenceAt: missed.at(-1)!.nextDueAt } }
      }
      for (const step of steps) {
        // A delayed Start failure belongs only to the attempted occurrence.
        // A clock/peer cursor advance must not apply it to a newer due instant.
        if (rejection && step.dueAt !== rejection.dueAt) return
        const previous = await this.existing(client, current, step.dueAt)
        if (!previous) {
          // Refresh after each awaited read: draining older facts must not
          // accidentally keep an earlier "latest" decision alive.
          let decision = decideDueSchedule(current, step.dueAt, this.clock().toISOString(), true, false)
          if (decision.status === 'eligible') {
            const overlap = await this.overlapping(client, current)
            decision = decideDueSchedule(current, step.dueAt, this.clock().toISOString(), true, overlap)
          }
          if (decision.status === 'not_due') return
          if (decision.status === 'eligible') {
            const reason = authorityFailure ?? rejection?.reason
            if (!reason) {
              if (!principal) throw new Error('Schedule authority was not resolved.')
              try {
                return { kind: 'start', schedule: { ...current, nextOccurrenceAt: step.dueAt }, dueAt: step.dueAt,
                  principal, input: await this.latestStartInput(client, current, step.dueAt) }
              } catch (error) {
                const failure = scheduleRejectionReason(error)
                if (!failure) throw error
                await this.repository.recordOccurrence(client, this.fact(current, step.dueAt,
                  { status: 'rejected', reason: failure }), now)
              }
            } else await this.repository.recordOccurrence(client, this.fact(current, step.dueAt,
              { status: 'rejected', reason }), now)
          } else await this.repository.recordOccurrence(client, this.fact(current, step.dueAt, decision), now)
        }
        await this.repository.advanceCursor(client, { workspaceId: current.workspaceId, workflowId: current.workflowId },
          current.revision, step.dueAt, step.nextDueAt)
      }
      const nextDueAt = steps.at(-1)?.nextDueAt
      if (nextDueAt && Date.parse(nextDueAt) <= Date.parse(this.clock().toISOString())) {
        return { kind: 'continue', schedule: { ...current, nextOccurrenceAt: nextDueAt } }
      }
    })
  }
  private async latestStartInput(client: pg.PoolClient, schedule: WorkflowSchedule, dueAt: string): Promise<RunStartV3Input> {
    const row = (await client.query<{ current_version_id: string | null; revision: string; location_revision: string }>(
      `select workflow.current_version_id,workflow.revision::text,workspace.location_revision::text
        from workflows workflow join workspaces workspace on workspace.id=workflow.workspace_id
        where workflow.workspace_id=$1 and workflow.id=$2`, [schedule.workspaceId, schedule.workflowId])).rows[0]
    if (!row?.current_version_id) throw new DomainError('SCHEDULE_WORKFLOW_NOT_SAVED', 'Save an executable workflow first.', 409)
    const versionRow = (await client.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions
        where workspace_id=$1 and workflow_id=$2 and id=$3`,
      [schedule.workspaceId, schedule.workflowId, row.current_version_id])).rows[0]
    if (!versionRow) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The saved workflow is unavailable.', 409)
    const version = readImmutableWorkflowVersion(versionRow, { workspaceId: schedule.workspaceId,
      workflowId: schedule.workflowId, id: row.current_version_id })
    return RunStartV3InputSchema.parse({ workspaceId: schedule.workspaceId, workflowId: schedule.workflowId,
      commandId: `schedule-v1:${createHash('sha256').update(scheduleOccurrenceId(schedule.workflowId, dueAt)).digest('hex')}`,
      executionSemanticsVersion: 3, workflowVersionId: version.id, expectedWorkflowRevision: Number(row.revision),
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: Number(row.location_revision), input: {} })
  }
  private guard(prepared: PreparedStart, preparation: RepeatStartPreparation, signal?: AbortSignal): ScheduleStartGuard {
    const { schedule, dueAt } = prepared
    const validate = async (sql: GraphTransactionSql, exceptRunId?: string) => {
      signal?.throwIfAborted()
      const principal = await readScheduleAuthority(sql, schedule)
      if (principal.id !== prepared.principal.id) throw retry()
      const slot = await this.repository.lock(sql, schedule)
      if (!slot?.value?.enabled || slot.value.revision !== schedule.revision) throw retry()
      if (exceptRunId === undefined && slot.value.nextOccurrenceAt !== dueAt) throw retry()
      if (exceptRunId === undefined && await this.existing(sql, schedule, dueAt)) throw retry()
      const overlap = await this.overlapping(sql, schedule, exceptRunId)
      // Sample time after the final awaited read, including in beforeGraphCommit.
      const decision = decideDueSchedule(schedule, dueAt, this.clock().toISOString(), true, overlap)
      signal?.throwIfAborted()
      if (decision.status !== 'eligible') throw retry()
    }
    return {
      occurrenceId: scheduleOccurrenceId(schedule.workflowId, dueAt),
      preparation,
      ...(signal ? { signal } : {}),
      beforeAcceptance: (sql) => validate(sql),
      afterAcceptance: async (sql, run) => {
        const now = this.clock().toISOString()
        await this.repository.recordOccurrence(sql, ScheduleOccurrenceSchema.parse({
          workspaceId: schedule.workspaceId, workflowId: schedule.workflowId,
          id: scheduleOccurrenceId(schedule.workflowId, dueAt), dueAt, scheduleRevision: schedule.revision,
          status: 'accepted', reason: null, runId: run.id, workflowVersionId: run.workflowVersionId,
        }), now)
        await this.repository.advanceCursor(sql, { workspaceId: schedule.workspaceId, workflowId: schedule.workflowId },
          schedule.revision, dueAt,
          nextOccurrences(schedule, dueAt, 1)[0] ?? null)
        // A long publication can outlive grace or a newer due instant. Abort ALL
        // speculative work rather than accepting a now-ineligible occurrence.
        beforeGraphCommit(sql, () => validate(sql, run.id))
      },
    }
  }
}

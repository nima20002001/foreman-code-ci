import type pg from 'pg'
import type { SqlQuery, TransactionSql } from '../../infrastructure/transaction.js'
import { z } from 'zod'
import {
  ScheduleGetInputSchema, ScheduleInstantSchema, ScheduleOccurrenceSchema, WorkflowScheduleSchema,
  type ScheduleGetInput, type ScheduleOccurrence, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { decodeScheduleCursor, DueCursorSchema, encodeScheduleCursor, OccurrenceCursorSchema } from './cursors.js'
import {
  ScheduleOccurrenceListInputSchema, ScheduleOccurrencePageSchema,
  type ScheduleOccurrenceListInput, type ScheduleOccurrencePage,
} from './transportSchemas.js'

type Sql = SqlQuery
interface SlotRow { revision: string; record: unknown; updated_by_principal_id: string }
export interface ScheduleSlot {
  /** Retained even after clear, so a later create cannot reuse a saved revision. */
  lastRevision: number
  value: WorkflowSchedule | null
  /** Audit provenance only: this ID is NOT a durable grant for future Run admission. */
  updatedByPrincipalId: string
}
const DueInputSchema = z.object({
  throughUtc: ScheduleInstantSchema,
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).max(4096).optional(),
}).strict()
export type DueScheduleInput = z.input<typeof DueInputSchema>

/** Internal persistence seam. Public access must go through WorkflowScheduleService.
 * Methods accepting a client never BEGIN/COMMIT: SCH-04 must own one admission transaction. */
export class PostgresWorkflowScheduleRepository {
  constructor(private readonly pool: pg.Pool) {}

  async requireWorkflow(client: Sql, scope: ScheduleGetInput): Promise<void> {
    const found = await client.query('select 1 from workflows where workspace_id=$1 and id=$2',
      [scope.workspaceId, scope.workflowId])
    if (!found.rows.length) throw new DomainError('WORKFLOW_NOT_FOUND', 'The scoped workflow was not found.', 404)
  }

  async getSlot(client: Sql, scope: ScheduleGetInput): Promise<ScheduleSlot | null> {
    const row = (await client.query<SlotRow>(`select revision,record,updated_by_principal_id
      from workflow_schedules where workspace_id=$1 and workflow_id=$2`,
    [scope.workspaceId, scope.workflowId])).rows[0]
    if (!row) return null
    return { lastRevision: Number(row.revision), value: row.record === null ? null : WorkflowScheduleSchema.parse(row.record),
      updatedByPrincipalId: row.updated_by_principal_id }
  }

  /** Same lock order as workflow management: workspace -> workflow -> schedule.
   * Also serializes creates when there is no schedule row to lock yet. */
  async lock(client: TransactionSql, scope: ScheduleGetInput): Promise<ScheduleSlot | null> {
    await lockActiveWorkspace(client, scope.workspaceId)
    const workflow = (await client.query<{ archived_at: Date | null }>(
      'select archived_at from workflows where workspace_id=$1 and id=$2 for update',
      [scope.workspaceId, scope.workflowId],
    )).rows[0]
    if (!workflow) throw new DomainError('WORKFLOW_NOT_FOUND', 'The scoped workflow was not found.', 404)
    if (workflow.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot change schedules.', 409)
    await client.query('select workflow_id from workflow_schedules where workspace_id=$1 and workflow_id=$2 for update',
      [scope.workspaceId, scope.workflowId])
    return this.getSlot(client, scope)
  }

  /** Caller holds lock(). A single row remains the sole authority, including disabled/cleared states. */
  async put(client: TransactionSql, value: WorkflowSchedule, principalId: string): Promise<void> {
    const accepted = WorkflowScheduleSchema.parse(value)
    await client.query(`insert into workflow_schedules
      (workspace_id,workflow_id,revision,record,enabled,next_occurrence_at,updated_by_principal_id)
      values($1,$2,$3,$4::jsonb,$5,$6,$7)
      on conflict (workflow_id) do update set revision=excluded.revision,record=excluded.record,
        enabled=excluded.enabled,next_occurrence_at=excluded.next_occurrence_at,
        cleared_at=null,updated_by_principal_id=excluded.updated_by_principal_id,updated_at=clock_timestamp()`,
    [accepted.workspaceId, accepted.workflowId, accepted.revision, JSON.stringify(accepted), accepted.enabled,
      accepted.nextOccurrenceAt, principalId])
  }

  async clear(client: TransactionSql, scope: ScheduleGetInput, revision: number, principalId: string): Promise<void> {
    await client.query(`update workflow_schedules set revision=$3,record=null,enabled=false,next_occurrence_at=null,
      cleared_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by_principal_id=$4
      where workspace_id=$1 and workflow_id=$2`, [scope.workspaceId, scope.workflowId, revision, principalId])
  }

  async recent(client: Sql, raw: ScheduleOccurrenceListInput): Promise<ScheduleOccurrencePage> {
    const input = ScheduleOccurrenceListInputSchema.parse(raw)
    const cursor = input.cursor ? decodeScheduleCursor(input.cursor, OccurrenceCursorSchema) : undefined
    if (cursor && (cursor.workspaceId !== input.workspaceId || cursor.workflowId !== input.workflowId)) {
      throw new DomainError('INVALID_CURSOR', 'The occurrence cursor belongs to another workflow.', 400)
    }
    const rows = await client.query<{ record: unknown }>(`select record from workflow_schedule_occurrences
      where workspace_id=$1 and workflow_id=$2 and ($3::timestamptz is null or due_at<$3)
      order by due_at desc limit $4`, [input.workspaceId, input.workflowId, cursor?.beforeDueAt ?? null, input.limit + 1])
    const items = rows.rows.slice(0, input.limit).map((row) => ScheduleOccurrenceSchema.parse(row.record))
    const last = items.at(-1)
    return ScheduleOccurrencePageSchema.parse({ items, pageInfo: {
      nextCursor: rows.rows.length > input.limit && last ? encodeScheduleCursor({ kind: 'schedule-occurrences-v1',
        workspaceId: input.workspaceId, workflowId: input.workflowId, beforeDueAt: last.dueAt }) : null,
    } })
  }

  /** Bounded candidate scan, NOT a claim or admission. Recheck under lock() in SCH-04.
   * The cursor is bound to the exact scan boundary. Disabled, cleared and archived parents are excluded. */
  async listDueSchedules(raw: DueScheduleInput, client: Sql = this.pool): Promise<{
    items: WorkflowSchedule[]; pageInfo: { nextCursor: string | null }
  }> {
    const input = DueInputSchema.parse(raw)
    const cursor = input.cursor ? decodeScheduleCursor(input.cursor, DueCursorSchema) : undefined
    if (cursor && cursor.throughUtc !== input.throughUtc) {
      throw new DomainError('INVALID_CURSOR', 'Keep the same due-scan boundary when paging.', 400)
    }
    const rows = await client.query<{ record: unknown }>(`select schedule.record from workflow_schedules schedule
      join workflows workflow on workflow.id=schedule.workflow_id and workflow.workspace_id=schedule.workspace_id
      join workspaces workspace on workspace.id=schedule.workspace_id
      where schedule.enabled and schedule.cleared_at is null and schedule.next_occurrence_at<=$1::timestamptz
        and workflow.archived_at is null and workspace.archived_at is null
        and ($2::timestamptz is null or (schedule.next_occurrence_at,schedule.workflow_id)>($2::timestamptz,$3::text))
      order by schedule.next_occurrence_at,schedule.workflow_id limit $4`,
    [input.throughUtc, cursor?.nextOccurrenceAt ?? null, cursor?.workflowId ?? null, input.limit + 1])
    const items = rows.rows.slice(0, input.limit).map((row) => WorkflowScheduleSchema.parse(row.record))
    const last = items.at(-1)
    return { items, pageInfo: { nextCursor: rows.rows.length > input.limit && last ? encodeScheduleCursor({
      kind: 'due-schedules-v1', throughUtc: input.throughUtc, nextOccurrenceAt: last.nextOccurrenceAt, workflowId: last.workflowId,
    }) : null } }
  }

  /** Insert immutable facts in the dispatcher's transaction, alongside Run creation/snapshot capture.
   * No Run is started here. Changed outcomes for an existing identity conflict; never overwrite.
   * nowUtc is the dispatcher's trusted server clock, not a public request field. */
  async recordOccurrence(client: TransactionSql, raw: ScheduleOccurrence, nowUtc: string): Promise<{
    value: ScheduleOccurrence; replayed: boolean
  }> {
    const value = ScheduleOccurrenceSchema.parse(raw)
    const now = ScheduleInstantSchema.parse(nowUtc)
    if (Date.parse(value.dueAt) > Date.parse(now)) {
      throw new DomainError('SCHEDULE_NOT_DUE', 'Future occurrences cannot be recorded early.', 409)
    }
    if (value.status === 'accepted') {
      const run = await client.query(`select 1 from runs where id=$1 and workspace_id=$2
        and workflow_id=$3 and workflow_version_id=$4`,
      [value.runId, value.workspaceId, value.workflowId, value.workflowVersionId])
      if (!run.rows.length) throw new DomainError('SCHEDULE_RUN_MISMATCH', 'Acceptance must reference the exact scoped Run and version.', 409)
    }
    const inserted = await client.query(`insert into workflow_schedule_occurrences
      (id,workspace_id,workflow_id,due_at,schedule_revision,status,reason,workflow_version_id,run_id,record,recorded_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
      on conflict (workflow_id,due_at) do nothing returning id`,
    [value.id, value.workspaceId, value.workflowId, value.dueAt, value.scheduleRevision, value.status, value.reason,
      value.status === 'accepted' ? value.workflowVersionId : null, value.status === 'accepted' ? value.runId : null,
      JSON.stringify(value), now])
    if (inserted.rows.length) return { value, replayed: false }
    const existing = (await client.query<{ record: unknown }>(`select record from workflow_schedule_occurrences
      where workspace_id=$1 and workflow_id=$2 and due_at=$3`, [value.workspaceId, value.workflowId, value.dueAt])).rows[0]
    const previous = existing ? ScheduleOccurrenceSchema.parse(existing.record) : undefined
    if (!previous || commandInputHash(previous) !== commandInputHash(value)) {
      throw new DomainError('SCHEDULE_OCCURRENCE_CONFLICT', 'This occurrence already has a different immutable outcome.', 409)
    }
    return { value: previous, replayed: true }
  }

  /** Optional SCH-04 cursor CAS, in the same transaction as admission/recordOccurrence.
   * Processing a due occurrence does not change the editable schedule revision. */
  async advanceCursor(client: TransactionSql, scope: ScheduleGetInput, expectedRevision: number,
    previousDueAt: string, nextDueAt: string | null): Promise<void> {
    const accepted = ScheduleGetInputSchema.parse(scope)
    const previous = ScheduleInstantSchema.parse(previousDueAt)
    const next = nextDueAt === null ? null : ScheduleInstantSchema.parse(nextDueAt)
    z.number().int().positive().parse(expectedRevision)
    if (next !== null && Date.parse(next) <= Date.parse(previous)) {
      throw new DomainError('INVALID_SCHEDULE_CURSOR', 'The schedule cursor must advance strictly forward.', 400)
    }
    const changed = await client.query(`update workflow_schedules set next_occurrence_at=$5::timestamptz,
      record=jsonb_set(record,'{nextOccurrenceAt}',$6::jsonb),updated_at=clock_timestamp()
      where workspace_id=$1 and workflow_id=$2 and revision=$3 and enabled
        and cleared_at is null and next_occurrence_at=$4::timestamptz returning workflow_id`,
    [accepted.workspaceId, accepted.workflowId, expectedRevision, previous, next, JSON.stringify(next)])
    if (!changed.rows.length) throw new DomainError('REVISION_CONFLICT', 'The due schedule changed before its cursor advanced.', 409)
  }
}

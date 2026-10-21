import type pg from 'pg'
import { DomainError } from '../errors.js'

export const COMMAND_RECEIPT_RETENTION_MS = 30 * 86_400_000
const batchSize = 100

// These responses are retry snapshots. Other operations also store live bindings,
// workflow publication facts or resumable external work in the same table.
const retrySnapshotOperations = [
  'agent_chat_control', 'operator_chat_control', 'operator_chat_create',
  'workflow.create', 'workflow.update', 'workflow.reorder', 'workflow.archive',
  'workflow.batch_archive', 'workflow.restore',
  'workspace.archive', 'workspace.batch_archive', 'workspace.restore',
  'agent.create', 'agent.update', 'agent.archive', 'agent.restore', 'agent.clone', 'agent.configuration.restore',
  'harness.defaults.update', 'harness.instance.save', 'harness.instance.check',
  'workspace.location.clear', 'workspace.location.provision',
  'workspace.root.configuration.adopt', 'workspace.root.managed.bind',
  'computer_sync_update', 'ci_enrollment_update',
  'source.approve', 'source.project.capture',
]
const retrySnapshots = new Set(retrySnapshotOperations)
// A reused capture has no approval row of its own. Keep its approval response
// until the capture response is gone, so later pages can still resolve its snapshot.
const sourceResponseReleased = `(r.operation not in ('source.approve','source.project.capture') or exists (
  select 1 from management_command_receipts response
  left join management_command_receipts approved on approved.principal_id=response.principal_id
    and approved.command_id=response.command_id and approved.operation='source.approve'
  left join source_approvals approval on approval.requested_by=response.principal_id
    and approval.command_id=response.command_id
  join source_snapshots snapshot on snapshot.snapshot_id=(case when r.operation='source.approve'
    then response.result#>>'{manifest,snapshotId}'
    else coalesce(approved.result#>>'{manifest,snapshotId}',approval.snapshot_id::text) end)::uuid
  where response.principal_id=r.principal_id and response.operation=r.operation and response.command_id=r.command_id
    and snapshot.availability='unavailable'
    and (r.operation<>'source.approve' or approval.snapshot_id=snapshot.snapshot_id or not exists (
      select 1 from management_command_receipts capture where capture.principal_id=r.principal_id
        and capture.command_id=r.command_id and capture.operation='source.project.capture'
    ))
))`

export function expiredCommandResult(): DomainError {
  return new DomainError('COMMAND_RESULT_EXPIRED',
    'This command already completed, but its saved response has expired. Read the current state before sending a new command.', 409)
}

export interface ExpiringCommandReceipt {
  principalId: string
  operation: string
  commandId: string
  createdAt: number
  completedAt?: number
  revision?: string
  status: string | null
  hasAcceptedControl: boolean
  hasAcknowledgment: boolean
}
export interface CommandReceiptRetentionStore {
  /** Candidates have a successful completion audit whose identity outlives the response. */
  candidates(limit: number): Promise<ExpiringCommandReceipt[]>
  /** Delete only the selected revision, retaining its existing audit identity. */
  remove(receipt: ExpiringCommandReceipt): Promise<boolean>
}

interface ReceiptCursor {
  operation: string
  createdAt: string
  principalId: string
  commandId: string
}

export async function pruneCompletedCommandReceipts(store: CommandReceiptRetentionStore, now: number): Promise<number> {
  const cutoff = now - COMMAND_RECEIPT_RETENTION_MS
  let removed = 0
  for (const row of await store.candidates(batchSize)) {
    if (!retrySnapshots.has(row.operation) || Math.max(row.createdAt, row.completedAt ?? row.createdAt) >= cutoff) continue
    const chat = row.operation === 'agent_chat_control' || row.operation === 'operator_chat_control'
    const completed = chat ? row.status === 'completed' && (!row.hasAcceptedControl || row.hasAcknowledgment)
      : row.status === null || row.status === 'completed' || row.status === 'succeeded'
    if (completed && await store.remove(row)) removed++
  }
  return removed
}

/** One bounded batch per periodic cleanup, with optimistic concurrency on mutable responses. */
export class PostgresCommandReceiptRetention {
  private cursor: ReceiptCursor | undefined

  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async prune(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - COMMAND_RECEIPT_RETENTION_MS)
    let nextCursor: ReceiptCursor | undefined
    const removed = await pruneCompletedCommandReceipts({
      candidates: async limit => {
        const rows = (await this.pool.query<{
          principal_id: string; operation: string; command_id: string; created_at: Date;
          created_at_key: string; completed_at: Date | null;
          revision: string; status: string | null; has_control: boolean; has_ack: boolean; source_released: boolean;
        }>(`with candidates as materialized (
          select principal_id,operation,command_id,created_at,activity_record_revision,
            activity_status,activity_control,activity_acknowledgment from management_command_receipts
          where operation=any($1::text[]) and created_at<$2
            and (operation,created_at,principal_id,command_id)>($3::text,$4::timestamptz,$5::text,$6::text)
          order by operation,created_at,principal_id,command_id limit $7
        ) select r.principal_id,r.operation,r.command_id,r.created_at,r.created_at::text as created_at_key,
          a.occurred_at as completed_at,
          r.activity_record_revision::text as revision,r.activity_status as status,
          r.activity_control is not null as has_control,r.activity_acknowledgment is not null as has_ack,
          ${sourceResponseReleased} as source_released
          from candidates r
          left join lateral (select occurred_at from management_audit
            where principal_id=r.principal_id and action=r.operation and details->>'commandId'=r.command_id
              and outcome='succeeded'
            order by occurred_at desc limit 1) a on true
          order by r.operation,r.created_at,r.principal_id,r.command_id`,
        [retrySnapshotOperations, cutoff, this.cursor?.operation ?? '', this.cursor?.createdAt ?? new Date(0),
          this.cursor?.principalId ?? '', this.cursor?.commandId ?? '', limit])).rows
        const last = rows.at(-1)
        if (last) nextCursor = { operation: last.operation, createdAt: last.created_at_key,
          principalId: last.principal_id, commandId: last.command_id }
        return rows.flatMap(row => row.completed_at === null || !row.source_released ? [] : [{
          principalId: row.principal_id, operation: row.operation, commandId: row.command_id,
          createdAt: row.created_at.getTime(), completedAt: row.completed_at.getTime(), revision: row.revision,
          status: row.status, hasAcceptedControl: row.has_control, hasAcknowledgment: row.has_ack,
        }])
      },
      remove: async row => {
        const deleted = await this.pool.query(`delete from management_command_receipts r
          where principal_id=$1 and operation=$2 and command_id=$3 and activity_record_revision=$4
            and ${sourceResponseReleased}`,
        [row.principalId, row.operation, row.commandId, row.revision])
        return deleted.rowCount === 1
      },
    }, now)
    this.cursor = nextCursor
    return removed
  }
}

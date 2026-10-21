import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { SourceOperationOwnerSchema, type SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { SourcePreparationClosureSchema } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import type { SourceExecutionHostPort } from './ports.js'
import { loadSourcePreparation, requireSourcePreparationHost, resolvePreparationReconciliationOwner,
  validateSourcePreparationClosure, validateQueuedSourcePreparation } from './preparationReconciliation.js'
import { requireQueuedPreparationClosed } from './queuedPreparationAuthority.js'
import { PostgresSourceReservations } from './reservations.js'

export class QueuedSourcePreparationCleanup {
  constructor(private readonly pool: pg.Pool, private readonly executions: SourceExecutionHostPort,
    private readonly retireTransfers?: (closure: ReturnType<typeof SourcePreparationClosureSchema.parse>) => Promise<void>) {}

  private async transaction<T>(work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work)
  }

  async close(ticket: JobQueueTicket): Promise<void> {
    const pending = await this.transaction(async sql => {
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-reconcile:${ticket.operationId}`])
      const current = await requireQueuedPreparationClosed(sql, ticket.id)
      const state = await loadSourcePreparation(sql, current.workspaceId, current.operationId)
      validateQueuedSourcePreparation(current, state)
      await requireSourcePreparationHost(sql, state)
      if (state.status === 'closed') return null
      if (state.reconciliation_id) {
        const existing = (await sql.query<{ queue_ticket_id: string | null }>(
          'select queue_ticket_id from source_preparation_reconciliations where operation_id=$1',
          [current.operationId])).rows[0]!
        if (existing.queue_ticket_id !== current.id) {
          throw new DomainError('SOURCE_RECONCILIATION_CONFLICT', 'The original source cleanup command is still pending.', 409)
        }
      }
      const reconciliationId = state.reconciliation_id ?? randomUUID()
      const owner: SourceOperationOwner = SourceOperationOwnerSchema.parse({
        identity: { operationId: current.operationId, ownerPrincipalId: current.principalId,
          expiresAt: new Date(Date.now() + 300000).toISOString() },
        root: state.root, attempt: state.attempt, source: state.root.source, record: state.record,
        physicalClosureConfirmed: false, preparationClosed: true,
        ...(current.definition.schemaVersion === 2 ? { quotaRequired: true } : {}),
      })
      await sql.query(`insert into source_preparation_reconciliations
        (operation_id,reconciliation_id,workspace_id,principal_id,command_id,status,owner,queue_ticket_id)
        values($1,$2,$3,$4,$5,'reconciling',$6::jsonb,$7)
        on conflict(operation_id) do update set owner=excluded.owner,queue_ticket_id=excluded.queue_ticket_id`,
      [current.operationId, reconciliationId, current.workspaceId, current.principalId,
        current.commandId, JSON.stringify(owner), current.id])
      return { reconciliationId, owner }
    })
    if (!pending) return
    if (!this.executions.reconcilePreparation) {
      throw new DomainError('SOURCE_RECONCILIATION_UNAVAILABLE', 'The installed host cannot reconcile preparation.', 409)
    }
    const closure = validateSourcePreparationClosure(pending.reconciliationId, pending.owner,
      await this.executions.reconcilePreparation(pending.reconciliationId, pending.owner))
    await this.retireTransfers?.(closure)
    await this.transaction(async sql => {
      await resolvePreparationReconciliationOwner(sql, pending.reconciliationId)
      const state = await loadSourcePreparation(sql, ticket.workspaceId, ticket.operationId)
      await new PostgresSourceReservations().retainClosedPreparation(sql, state.reservation,
        closure, Number(state.reserved_bytes))
      await sql.query("update source_execution_materializations set state='closed' where operation_id=$1", [ticket.operationId])
      await sql.query("update source_preparation_reconciliations set status='closed',closure=$2::jsonb where operation_id=$1",
        [ticket.operationId, JSON.stringify(closure)])
      await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,'system','job.queue.cleanup',$2,'succeeded',$3::jsonb)`,
      [ticket.principalId, ticket.workspaceId, JSON.stringify({ ticketId: ticket.id, operationId: ticket.operationId,
        reconciliationId: pending.reconciliationId })])
    })
  }
}

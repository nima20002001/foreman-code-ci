import type pg from 'pg'

import { DomainError } from '../errors.js'

interface BudgetRow {
  active_timeout_ms: string
  active_elapsed_ms: string
  active_started_at: Date | null
  approval_wait_started_at: Date | null
  stopped_at: Date | null
  revision: string
}

export class PostgresApprovalBudgetRepository {
  constructor(private readonly pool: pg.Pool) {}

  async ensure(executionId: string, graphThreadId: string, activeTimeoutMs: number): Promise<void> {
    await this.pool.query(
      `insert into approval_execution_state
       (execution_id,graph_thread_id,active_timeout_ms,active_elapsed_ms,active_started_at)
       values ($1,$2,$3,0,now()) on conflict (execution_id) do nothing`,
      [executionId, graphThreadId, activeTimeoutMs],
    )
  }

  async beginWait(executionId: string): Promise<void> {
    const result = await this.pool.query(
      `update approval_execution_state set
         active_elapsed_ms=active_elapsed_ms + coalesce(extract(epoch from (now()-active_started_at))*1000,0)::bigint,
         active_started_at=null,approval_wait_started_at=coalesce(approval_wait_started_at,now()),
         revision=revision+1,updated_at=now()
       where execution_id=$1 and stopped_at is null
         and not exists (select 1 from harness_executions he where he.id=$1 and he.record->>'state'='completed')`, [executionId],
    )
    if (result.rowCount !== 1) throw new DomainError('EXECUTION_NOT_WAITABLE', 'The execution is terminal or has no active-time budget.', 409)
  }

  async resume(executionId: string): Promise<void> {
    const result = await this.pool.query(
      `update approval_execution_state set active_started_at=coalesce(active_started_at,now()),
         approval_wait_started_at=null,revision=revision+1,updated_at=now()
       where execution_id=$1 and stopped_at is null
         and not exists (select 1 from harness_executions he where he.id=$1 and he.record->>'state'='completed')`, [executionId],
    )
    if (result.rowCount !== 1) throw new DomainError('EXECUTION_STOPPED', 'A terminal execution cannot be resumed.', 409)
  }

  /** Freeze accounting without turning a successful completion into Stop. */
  async finish(executionId: string, finishedAt?: string): Promise<void> {
    await this.finalize(executionId, finishedAt, false)
  }

  async stop(executionId: string): Promise<void> {
    await this.finalize(executionId, undefined, true)
  }

  private async finalize(executionId: string, finishedAt: string | undefined, stopped: boolean): Promise<void> {
    await this.pool.query(
      `update approval_execution_state set
         active_elapsed_ms=active_elapsed_ms + greatest(0,coalesce(
           extract(epoch from (coalesce($2::timestamptz,now())-active_started_at))*1000,0))::bigint,
         active_started_at=null,approval_wait_started_at=null,
         stopped_at=case when $3::boolean then coalesce($2::timestamptz,now()) else stopped_at end,
         revision=revision+1,updated_at=now()
       where execution_id=$1 and stopped_at is null
         and ($3::boolean or active_started_at is not null or approval_wait_started_at is not null)`,
      [executionId, finishedAt ?? null, stopped],
    )
  }

  async assertActive(executionId: string): Promise<void> {
    await this.remaining(executionId)
  }

  async remaining(executionId: string): Promise<number> {
    const result = await this.pool.query<BudgetRow>(
      `select active_timeout_ms::text,active_elapsed_ms::text,active_started_at,
         approval_wait_started_at,stopped_at,revision::text
       from approval_execution_state where execution_id=$1`, [executionId],
    )
    const row = result.rows[0]
    if (!row || row.stopped_at) throw new DomainError('EXECUTION_STOPPED', 'A stopped execution cannot accept approval delivery.', 409)
    const runningMs = row.active_started_at ? Date.now() - row.active_started_at.getTime() : 0
    const remaining = Number(row.active_timeout_ms) - Number(row.active_elapsed_ms) - runningMs
    if (remaining <= 0) {
      throw new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)
    }
    return remaining
  }
}

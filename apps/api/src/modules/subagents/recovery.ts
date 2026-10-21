import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { HarnessNativeEventSchema, NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { appendNativeEvent } from '../runs/nativeEvents.js'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunSubagentCommandReceiptSchema } from '@foreman-code/contracts/subagents'
import type { SubagentServicePort } from './types.js'

/** Main startup has no proof whether pre-crash native dispatch ran. Never replay prompts or declare termination. */
export async function recoverSubagentCommands(pool: pg.Pool): Promise<number> {
  const result = await pool.query(`update run_subagent_command_receipts set record=record || jsonb_build_object(
    'state','uncertain','reasonCode','MAIN_RESTART_DELIVERY_UNCERTAIN','updatedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    where record->>'state' in ('accepted','dispatching')`)
  await pool.query(`update run_subagent_backfill_state set complete=false,child_cursor=null
    where execution_id in (select id from harness_executions where record->>'state' <> 'completed')`)
  await pool.query(`update run_subagents set revision=revision+1,record=record || jsonb_build_object('revision',(revision+1)::text,'status','unknown','evidence','reconciling')
    where record->>'status' not in ('completed','failed','canceled')`)
  return result.rowCount ?? 0
}
/** Only exact provider correlation readback can resolve uncertain delivery. This never sends input. */
export async function reconcileSubagentCommand(service: SubagentServicePort, principal: ManagementPrincipal,
  input: { workspaceId: string; runId: string; subagentId: string; receiptId: string }, source: 'http' | 'mcp' = 'http') {
  const captured = await service.scoped(principal, input, 'runs:read', async scope => {
    const child = await service.child(scope, input)
    const row = (await scope.sql.query<{ record: unknown }>('select record from run_subagent_command_receipts where id=$1 and subagent_id=$2 and principal_id=$3 for update',
      [input.receiptId, child.id, principal.id])).rows[0]
    if (!row) return undefined
    const receipt = RunSubagentCommandReceiptSchema.parse(row.record)
    const lease = receipt.state === 'uncertain' ? service.controls(child) : undefined
    const matched = lease?.matches(child)
      && (lease.generation === receipt.nativeGeneration || receipt.response) ? lease : undefined
    return { receipt, lease: matched, generation: matched?.generation }
  })
  if (!captured?.lease?.reconcile) return captured?.receipt
  const { receipt, lease, generation } = captured
  // Native readback may publish evidence through another SQL connection. Never
  // hold the Run/child transaction while waiting for the native transport.
  let state: 'acknowledged' | 'rejected' | 'uncertain' = 'uncertain'
  try {
    lease.assertCurrent()
    state = await lease.reconcile!(receipt)
    lease.assertCurrent()
    if (lease.generation !== generation) state = 'uncertain'
  } catch (error) { logIgnoredError('harness', 'reconcile native child control', error); state = 'uncertain' }
  let action: 'runs:subagents:input' | 'runs:stop' | 'interactions:respond' = 'runs:stop'
  if (receipt.operation === 'run_subagent_input_v1') action = 'runs:subagents:input'
  else if (receipt.operation === 'run_subagent_respond_v1') action = 'interactions:respond'
  return service.scoped(principal, input, action, async scope => {
    const child = await service.child(scope, input)
    const current = service.controls(child)
    const row = (await scope.sql.query<{ record: unknown }>('select record from run_subagent_command_receipts where id=$1 and subagent_id=$2 and principal_id=$3 for update',
      [receipt.id, child.id, principal.id])).rows[0]
    if (!row) return undefined
    const latest = RunSubagentCommandReceiptSchema.parse(row.record)
    if (latest.state !== 'uncertain' || !current?.matches(child) || current.generation !== generation) return latest
    current.assertCurrent()
    if (state === 'uncertain') return latest
    const next = RunSubagentCommandReceiptSchema.parse({ ...latest, state,
      reasonCode: state === 'acknowledged' ? undefined : 'SUBAGENT_NATIVE_RECONCILED_REJECTION', updatedAt: new Date().toISOString() })
    await scope.sql.query('update run_subagent_command_receipts set record=$2::jsonb where id=$1', [receipt.id, JSON.stringify(next)])
    await scope.sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details) values($1,$2,$3,$4,$5,$6::jsonb)`,
      [principal.id, source, receipt.operation, child.id, state === 'rejected' ? 'failed' : 'succeeded',
        JSON.stringify({ receiptId: receipt.id, state, evidence: 'native_readback' })])
    return next
  })
}


/** The first response is a SQL snapshot. Native history backfill runs separately, and uses only the original admitted parent on its owning computer. */
export async function backfillRunSubagents(service: SubagentServicePort, principal: ManagementPrincipal, input: { workspaceId: string; runId: string }) {
  if (!service.nativeRecovery) return
  const sources = await service.scoped(principal, input, 'runs:read', async scope => (await scope.sql.query<{ id: string; reference: unknown; child_cursor: string | null }>(
    `select e.id,s.reference,b.child_cursor from harness_executions e join execution_native_sessions s on s.execution_id=e.id
     left join run_subagent_backfill_state b on b.execution_id=e.id where e.run_id=$1 and not coalesce(b.complete,false)
     -- An unavailable provider is retried once a minute while the Run is live, hourly once it has finished
     -- (a finished Main-local session is usually gone; a Worker may still come back), never on every Board poll.
     and (b.last_failure is null or b.updated_at < clock_timestamp() - case when exists(select 1 from runs r
       where r.id=e.run_id and r.execution_state='completed') then interval '1 hour' else interval '1 minute' end)
     order by e.id limit 8`, [input.runId])).rows)
  for (const source of sources) {
    const session = NativeSessionReferenceSchema.parse(source.reference)
    let page
    try { page = await service.nativeRecovery(source.id, session, source.child_cursor ?? undefined, AbortSignal.timeout(10000)) }
    catch (error) {
      logIgnoredError('harness', 'read native child recovery', error)
      service.reportRecoveryFailure({ ...input, executionId: source.id, code: 'NATIVE_CHILD_READBACK_UNAVAILABLE' })
      await service.scoped(principal, input, 'runs:read', async scope => {
        await scope.sql.query(`insert into run_subagent_backfill_state(execution_id,last_failure) values($1,'NATIVE_CHILD_READBACK_UNAVAILABLE')
          on conflict(execution_id) do update set last_failure=excluded.last_failure,updated_at=clock_timestamp()`, [source.id])
      })
      continue
    }
    if (page.events.length > 500) throw new Error('Native child backfill page exceeds its bound.')
    await service.scoped(principal, input, 'runs:read', async scope => {
      const current = (await scope.sql.query<{ reference: unknown; child_cursor: string | null }>(`select s.reference,b.child_cursor from execution_native_sessions s
        left join run_subagent_backfill_state b using(execution_id) where s.execution_id=$1`, [source.id])).rows[0]
      if (!current || JSON.stringify(current.reference) !== JSON.stringify(source.reference) || current.child_cursor !== source.child_cursor) return
      for (const native of page.events) {
        const event = HarnessNativeEventSchema.parse({ ...native, executionId: source.id })
        if (!event.connectionId?.startsWith('child-history-') || event.sequence !== 0) throw new Error('Native child readback lacks its stable source identity.')
        const prior = (await scope.sql.query<{ record: { occurredAt: string } }>(`select record from harness_native_events
          where execution_id=$1 and connection_id=$2 and source_sequence=0`, [source.id, event.connectionId])).rows[0]
        if (prior) event.occurredAt = prior.record.occurredAt
        await appendNativeEvent(scope.sql, event)
      }
      await scope.sql.query(`insert into run_subagent_backfill_state(execution_id,child_cursor,complete) values($1,$2,$3)
        on conflict(execution_id) do update set child_cursor=excluded.child_cursor,complete=excluded.complete,last_failure=null,updated_at=clock_timestamp()`,
        [source.id, page.nextCursor, page.nextCursor === null])
    })
  }
}

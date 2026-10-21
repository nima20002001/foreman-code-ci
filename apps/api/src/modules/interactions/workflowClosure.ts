import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import { HarnessExecutionSchema, NativeSessionReferenceSchema,
  type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import type pg from 'pg'
import { beforeGraphCommit, type GraphSqlClient, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { readExecutionPlacement } from '../placement/persistence.js'
import { assertReviewerCheckoutAvailable } from '../runs/worktreeReviewers.js'

/** Private native-closure evidence, captured by the coordinator, never an API
 * input or an inference from a terminal business result. No secrets are stored. */
export interface ClosedWorkflowSession {
  execution: Pick<HarnessExecution, 'id' | 'runId' | 'workflowNodeId' | 'agentId' | 'agentConfigurationVersionId'
    | 'attempt' | 'workingDirectory' | 'runtimeDirectory' | 'nativeSessionId'>
  session: NativeSessionReference
  durableGeneration?: string
}

/** Backend-only lifetime receipt. It is not a native action or Run authority.
 * Reserve BEFORE credential preflight, create or
 * attach. Record ONLY after the captured manager confirms exact-session close.
 * No receipt is synthesized for pre-upgrade or uncertain native work. */
export interface WorkflowClosureStore {
  begin(execution: HarnessExecution): Promise<string>
  record(execution: HarnessExecution, session: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<ClosedWorkflowSession>
  recordDetached(execution: HarnessExecution, session: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<void>
  recoverDetached?(owner: RunOwnership, execution: HarnessExecution): Promise<NativeSessionReference | undefined>
  read(execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined>
  /** Positive disposal of the ORIGINAL manager, including a failed create or
   * credential preflight that never returned a session identity. Not absence. */
  recordUnbound(execution: HarnessExecution, generation: string, assertCurrent: () => void): Promise<UnboundWorkflowClosure>
  readUnbound(execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined>
}

function conflict(): never {
  throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
    'Native closure does not match the current execution, session and manager lifetime.', 409)
}

// These values are immutable across a native lifetime. Native identity is bound
// separately because createSession has not returned when begin commits.
function executionIdentity(execution: HarnessExecution) {
  return { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt,
    ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
    ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) }
}

export interface UnboundWorkflowClosure {
  execution: ReturnType<typeof executionIdentity>
  durableGeneration: string
}

export interface ClosureRow {
  generation: string
  execution_identity: unknown
  expected_reference: unknown | null
  closed_reference: unknown | null
  closed: boolean
  detached: boolean
  detached_reference: unknown | null
  prior_unclosed: boolean
  closed_without_session: boolean
}

type Sql = GraphSqlClient
async function latest(sql: Sql, executionId: string): Promise<ClosureRow | undefined> {
  const result = await sql.query<ClosureRow>(`select generation::text,execution_identity,
    expected_reference,closed_reference,closed_at is not null as closed,detached_at is not null as detached,detached_reference,closed_without_session,
    exists(select 1 from execution_native_closures prior where prior.execution_id=c.execution_id
      and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed
    from execution_native_closures c where execution_id=$1 order by generation desc limit 1`, [executionId])
  return result.rows[0]
}

async function exactLifetime(sql: Sql, executionId: string, generation: string): Promise<ClosureRow | undefined> {
  if (!/^[1-9][0-9]*$/.test(generation)) return conflict()
  return (await sql.query<ClosureRow>(`select generation::text,execution_identity,expected_reference,closed_reference,
    closed_at is not null as closed,detached_at is not null as detached,detached_reference,closed_without_session,
    exists(select 1 from execution_native_closures p where p.execution_id=c.execution_id
      and p.generation<c.generation and p.closed_at is null and p.detached_at is null) as prior_unclosed
    from execution_native_closures c where execution_id=$1 and generation=$2::bigint for update`,
  [executionId, generation])).rows[0]
}

/** The caller's execution is always checked against fresh durable identity.
 * A newer preflight invalidates an earlier close, even before native attach
 * obtains a writer lane. An unclosed older lifetime also remains outstanding.
 * A missing row/manager/process proves nothing. */
export async function readWorkflowClosure(sql: Sql, execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined> {
  const result = await sql.query<ClosureRow & { record: unknown; reference: unknown }>(`select
    c.generation::text,c.execution_identity,c.expected_reference,c.closed_reference,
    c.closed_at is not null as closed,c.detached_at is not null as detached,c.detached_reference,c.closed_without_session,e.record,s.reference,
    exists(select 1 from execution_native_closures prior where prior.execution_id=e.id
      and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed
    from harness_executions e join execution_native_sessions s on s.execution_id=e.id
    join lateral (select * from execution_native_closures where execution_id=e.id
      order by generation desc limit 1) c on true where e.id=$1 and e.run_id=$2`, [execution.id, execution.runId])
  const row = result.rows[0]
  if (!row || !row.closed || row.detached || row.closed_without_session || row.prior_unclosed !== false) {
    const recovered = await readRecoveredWorkflowClosure(sql, execution)
    return recovered?.session ? { execution: { ...executionIdentity(execution), nativeSessionId: recovered.session.nativeSessionId },
      session: recovered.session, durableGeneration: recovered.generation } : undefined
  }
  return closedWorkflowSession(row, execution)
}

/** Validate a closed lifetime read alongside other executions on the same SQL cut. */
export function closedWorkflowSession(row: ClosureRow & { record: unknown; reference: unknown },
  execution: HarnessExecution): ClosedWorkflowSession {
  if (!row.closed || row.detached || row.closed_without_session || row.prior_unclosed !== false) return conflict()
  const current = HarnessExecutionSchema.parse(row.record)
  const session = NativeSessionReferenceSchema.parse(row.reference)
  if (!isDeepStrictEqual(executionIdentity(current), executionIdentity(execution))
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
    || current.nativeSessionId !== session.nativeSessionId || execution.nativeSessionId !== session.nativeSessionId
    || !isDeepStrictEqual(row.closed_reference, session)
    || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
  return { execution: { ...executionIdentity(current), nativeSessionId: session.nativeSessionId },
    session, durableGeneration: row.generation }
}

/** Restart attachment requires the original manager's detachment of the saved session. */
export async function readDetachedWorkflowSession(owner: RunOwnership,
  execution: HarnessExecution): Promise<NativeSessionReference | undefined> {
  return (await readDetachedWorkflowLifetime(owner, execution))?.session
}

export async function readDetachedWorkflowLifetime(owner: RunOwnership, execution: HarnessExecution) {
  owner.assertOwned()
  const lifetime = await readDetachableWorkflowLifetime(owner.oneShotConnection(), owner, execution)
  owner.assertOwned()
  return lifetime?.detached ? { generation: lifetime.generation, session: lifetime.session } : undefined
}

async function readDetachableWorkflowLifetime(sql: Sql, owner: RunOwnership, execution: HarnessExecution) {
  if (execution.runId !== owner.runId || !['running', 'waiting'].includes(execution.state)) return conflict()
  const row = (await sql.query<ClosureRow & { record: unknown; reference: unknown }>(`select
    c.generation::text,c.execution_identity,c.expected_reference,c.closed_reference,
    c.closed_at is not null as closed,c.detached_at is not null as detached,c.detached_reference,c.closed_without_session,
    e.record,s.reference,
    exists(select 1 from execution_native_closures prior where prior.execution_id=e.id
      and prior.generation<c.generation and prior.closed_at is null and prior.detached_at is null) as prior_unclosed
    from runs r join harness_executions e on e.run_id=r.id
    join execution_native_sessions s on s.execution_id=e.id
    join lateral (select * from execution_native_closures where execution_id=e.id
      order by generation desc limit 1) c on true
    where e.id=$1 and r.id=$2 and r.record->>'executionSemanticsVersion'='3'
      and r.execution_state in ('running','waiting')
      and r.record->>'outcome'='pending' and r.stop_requested_at is null
      and s.workflow_finalized_at is null
      and not exists(select 1 from run_cleanup_intents intent where intent.run_id=r.id and intent.pending)`,
  [execution.id, owner.runId])).rows[0]
  if (!row || row.closed || row.closed_without_session || row.prior_unclosed !== false) return undefined
  const current = HarnessExecutionSchema.parse(row.record)
  const session = NativeSessionReferenceSchema.parse(row.reference)
  if (!['running', 'waiting'].includes(current.state) || !isDeepStrictEqual(current, execution)
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
    || current.nativeSessionId !== session.nativeSessionId
    || row.detached && !isDeepStrictEqual(row.detached_reference, session)
    || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
  return { generation: row.generation, session, detached: row.detached }
}

/** A saved continuation still requires authenticated attachment and the original process credential. */
export async function readRemoteWorkflowContinuation(owner: RunOwnership, execution: HarnessExecution) {
  owner.assertOwned()
  if (execution.runId !== owner.runId || !['running', 'waiting'].includes(execution.state)
    || !execution.nativeSessionId) return undefined
  return owner.oneShotConnection().transaction(async sql => {
    const placement = await readExecutionPlacement(sql, execution.id)
    if (placement?.hostRef.kind !== 'device' || placement.payload.kind !== 'agent') return undefined
    const row = (await sql.query<{ record: unknown; reference: unknown; receipt: unknown }>(`select e.record,s.reference,r.receipt
      from harness_executions e join runs run on run.id=e.run_id
      join execution_native_sessions s on s.execution_id=e.id
      join execution_dispatch_intents i on i.execution_id=e.id
      join remote_execution_receipts r using(operation_id)
      where e.id=$1 and run.id=$2 and run.record->>'executionSemanticsVersion'='3'
        and run.execution_state in ('running','waiting') and run.record->>'outcome'='pending'
        and run.stop_requested_at is null and s.workflow_finalized_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=run.id and c.pending)
      for share of e,s,r`, [execution.id, owner.runId])).rows[0]
    if (!row) return undefined
    const current = HarnessExecutionSchema.parse(row.record)
    const session = NativeSessionReferenceSchema.parse(row.reference)
    const receipt = RemoteOperationReceiptSchema.parse(row.receipt)
    const lifetime = await latest(sql, execution.id)
    if (!lifetime || lifetime.closed || lifetime.closed_without_session || lifetime.prior_unclosed
      || receipt.terminal || receipt.stopFence)
      return undefined
    if (!isDeepStrictEqual(current, execution) || !isDeepStrictEqual(lifetime.execution_identity, executionIdentity(current))
      || session.nativeSessionId !== current.nativeSessionId || session.harness !== placement.payload.driverId
      || receipt.native?.sessionId !== session.nativeSessionId || receipt.intent.executionId !== current.id
      || receipt.intent.runId !== current.runId || receipt.intent.nodeId !== current.workflowNodeId
      || receipt.intent.bindingHash !== placement.bindingHash
      || lifetime.expected_reference !== null && !isDeepStrictEqual(lifetime.expected_reference, session)
      || lifetime.detached && !isDeepStrictEqual(lifetime.detached_reference, session)) return conflict()
    const principals = (await sql.query<{ principal_id: string }>(`select b.principal_id
      from worker_credential_bindings b join management_principals p on p.id=b.principal_id
      where b.execution_id=$1 and b.run_id=$2 and b.agent_id=$3 and b.revoked_at is null
        and p.revoked_at is null and p.expires_at>clock_timestamp() and p.audience='worker' and p.agent_id=b.agent_id
      limit 2`, [current.id, current.runId, current.agentId])).rows
    if (principals.length !== 1) return undefined
    owner.assertOwned()
    return { session, generation: lifetime.generation, principalId: principals[0]!.principal_id, detached: lifetime.detached }
  })
}

/** No-session closure is accepted only from the exact reserved lifetime's
 * positive manager-dispose receipt. The absent binding is a consistency check,
 * never the source of this proof. It cannot accept success or authorize retry. */
export async function readUnboundWorkflowClosure(sql: Sql, execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined> {
  const row = await latest(sql, execution.id)
  if (!row || !row.closed || row.detached || !row.closed_without_session || row.prior_unclosed !== false) {
    const recovered = await readRecoveredWorkflowClosure(sql, execution)
    return recovered && !recovered.session ? { execution: executionIdentity(execution), durableGeneration: recovered.generation } : undefined
  }
  const current = (await sql.query<{ record: unknown; bound: boolean }>(`select e.record,
    exists(select 1 from execution_native_sessions s where s.execution_id=e.id) as bound
    from harness_executions e where e.id=$1 and e.run_id=$2`, [execution.id, execution.runId])).rows[0]
  if (!current) return conflict()
  const parsed = HarnessExecutionSchema.parse(current.record)
  if (execution.nativeSessionId || parsed.nativeSessionId || current.bound || row.expected_reference !== null
    || row.closed_reference !== null || !isDeepStrictEqual(executionIdentity(execution), executionIdentity(parsed))
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(parsed))) return conflict()
  return { execution: executionIdentity(parsed), durableGeneration: row.generation }
}

/** Uses ordinary short SQL transactions for private lifecycle receipts only.
 * No native calls occur in SQL. Finalization remains a separate Run-owner duty.
 * Parent Run then execution locks serialize lifetime admission with Stop and
 * owner-fenced workflow finalization; old closure evidence is never overwritten.
 */
export class PostgresWorkflowClosureStore implements WorkflowClosureStore {
  constructor(private readonly pool: pg.Pool,
    private readonly hasRestartDetachment?: (executionId: string) => boolean) {}

  async recoverDetached(owner: RunOwnership, execution: HarnessExecution): Promise<NativeSessionReference | undefined> {
    const saved = await readDetachedWorkflowSession(owner, execution)
    if (saved || !this.hasRestartDetachment?.(execution.id)) return saved
    const recovered = await owner.oneShotConnection().transaction(async sql => {
      const allowed = await sql.query(`select 1 from runs r where r.id=$1
        and r.record->>'executionSemanticsVersion'='3' and r.execution_state in ('running','waiting')
        and r.record->>'executionState'=r.execution_state and r.record->>'outcome'='pending'
        and r.stop_requested_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
        for update`, [owner.runId])
      if (allowed.rowCount !== 1) return false
      await sql.query('select record from harness_executions where id=$1 and run_id=$2 for update',
        [execution.id, owner.runId])
      const lifetime = await readDetachableWorkflowLifetime(sql, owner, execution)
      if (!lifetime) return false
      const fence = await owner.readOneShotFence(sql)
      owner.assertOwned()
      if (!this.hasRestartDetachment?.(execution.id)) return false
      if (!lifetime.detached) {
        const changed = await sql.query(`update execution_native_closures
          set detached_reference=$3::jsonb,detached_at=clock_timestamp()
          where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null
          returning generation`, [execution.id, lifetime.generation, JSON.stringify(lifetime.session)])
        if (changed.rowCount !== 1) return conflict()
      }
      beforeGraphCommit(sql, async () => {
        owner.assertOwned()
        if (!isDeepStrictEqual(fence, await owner.readOneShotFence(sql))) return conflict()
        const current = await readDetachableWorkflowLifetime(sql, owner, execution)
        if (!current?.detached || current.generation !== lifetime.generation
          || !isDeepStrictEqual(current.session, lifetime.session)) return conflict()
      })
      return true
    })
    return recovered ? readDetachedWorkflowSession(owner, execution) : undefined
  }

  private async transaction<T>(execution: HarnessExecution, work: (sql: Sql, current: HarnessExecution) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      const parent = await client.query('select id from runs where id=$1 for update', [execution.runId])
      const row = await client.query<{ record: unknown }>(
        'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, execution.runId])
      if (parent.rowCount !== 1 || row.rowCount !== 1) return conflict()
      const current = HarnessExecutionSchema.parse(row.rows[0]!.record)
      if (!isDeepStrictEqual(executionIdentity(current), executionIdentity(execution))) return conflict()
      const value = await work(client, current)
      return value
    })
  }

  async begin(execution: HarnessExecution): Promise<string> {
    return this.transaction(execution, async (sql, current) => {
      if (current.state === 'completed') await assertReviewerCheckoutAvailable(sql, current)
      // This does not authorize native work. The existing continuation,
      // credentials, harness and writer-lane checks still run at their boundaries.
      const allowed = await sql.query(`select 1 from runs r where r.id=$1
        and r.execution_state in ('running','waiting') and r.record->>'executionState'=r.execution_state
        and r.record->>'outcome'='pending' and r.stop_requested_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`, [execution.runId])
      if (allowed.rowCount !== 1) return conflict()
      const previous = await latest(sql, execution.id)
      if (previous && (!(previous.closed || previous.detached) || previous.prior_unclosed)) return conflict()
      const native = await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])
      const reference = native.rows[0] ? NativeSessionReferenceSchema.parse(native.rows[0].reference) : null
      if (current.nativeSessionId && reference?.nativeSessionId !== current.nativeSessionId) return conflict()
      const result = await sql.query<{ generation: string }>(`insert into execution_native_closures
        (execution_id,execution_identity,expected_reference) values($1,$2::jsonb,$3::jsonb) returning generation::text`,
      [execution.id, JSON.stringify(executionIdentity(current)), reference === null ? null : JSON.stringify(reference)])
      return result.rows[0]!.generation
    })
  }

  async record(execution: HarnessExecution, reference: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<ClosedWorkflowSession> {
    assertCurrent()
    const session = NativeSessionReferenceSchema.parse(reference)
    return this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.detached || row.generation !== generation || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
        || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
      const native = await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])
      if (current.nativeSessionId !== session.nativeSessionId || !isDeepStrictEqual(native.rows[0]?.reference, session)) return conflict()
      if (row.closed) {
        if (!isDeepStrictEqual(row.closed_reference, session)) return conflict()
      } else {
        const updated = await sql.query(`update execution_native_closures
          set closed_reference=$3::jsonb,closed_at=clock_timestamp()
          where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`,
        [execution.id, generation, JSON.stringify(session)])
        if (updated.rowCount !== 1) return conflict()
      }
      // This synchronous check is immediately before COMMIT, with the parent
      // and execution locks still held. A late attach/local replacement cannot
      // convert its predecessor's close into the successor's closure evidence.
      assertCurrent()
      return { execution: { ...executionIdentity(current), nativeSessionId: session.nativeSessionId },
        session, durableGeneration: generation }
    })
  }

  async recordDetached(execution: HarnessExecution, reference: NativeSessionReference, generation: string,
    assertCurrent: () => void): Promise<void> {
    assertCurrent()
    const session = NativeSessionReferenceSchema.parse(reference)
    await this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.closed || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))
        || row.expected_reference !== null && !isDeepStrictEqual(row.expected_reference, session)) return conflict()
      const native = (await sql.query<{ reference: unknown }>(
        'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])).rows[0]
      if (current.nativeSessionId !== session.nativeSessionId || !isDeepStrictEqual(native?.reference, session)) return conflict()
      if (row.detached) {
        if (!isDeepStrictEqual(row.detached_reference, session)) return conflict()
      } else if ((await sql.query(`update execution_native_closures
        set detached_reference=$3::jsonb,detached_at=clock_timestamp()
        where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`,
      [execution.id, generation, JSON.stringify(session)])).rowCount !== 1) return conflict()
      assertCurrent()
    })
  }

  async recordUnbound(execution: HarnessExecution, generation: string,
    assertCurrent: () => void): Promise<UnboundWorkflowClosure> {
    assertCurrent()
    return this.transaction(execution, async (sql, current) => {
      assertCurrent()
      const row = await exactLifetime(sql, execution.id, generation)
      if (!row || row.detached || row.generation !== generation
        || row.expected_reference !== null || current.nativeSessionId || execution.nativeSessionId
        || !isDeepStrictEqual(row.execution_identity, executionIdentity(current))) return conflict()
      if ((await sql.query('select 1 from execution_native_sessions where execution_id=$1', [execution.id])).rowCount !== 0) return conflict()
      if (row.closed) {
        if (!row.closed_without_session || row.closed_reference !== null) return conflict()
      } else {
        const changed = await sql.query(`update execution_native_closures set closed_without_session=true,closed_at=clock_timestamp()
          where execution_id=$1 and generation=$2::bigint and closed_at is null and detached_at is null returning generation`, [execution.id, generation])
        if (changed.rowCount !== 1) return conflict()
      }
      assertCurrent()
      return { execution: executionIdentity(current), durableGeneration: generation }
    })
  }

  readUnbound(execution: HarnessExecution): Promise<UnboundWorkflowClosure | undefined> {
    return readUnboundWorkflowClosure(this.pool, execution)
  }

  read(execution: HarnessExecution): Promise<ClosedWorkflowSession | undefined> {
    return readWorkflowClosure(this.pool, execution)
  }
}

/** Private physical-disposal receipts are separate from original-manager close
 * and restart-detach receipts. Never rewrite a detached generation into a close,
 * invent a native terminal/ACK, or let a registry miss stand in for a receipt. */
interface RecoveredClosureRow {
  generation: string
  execution_identity: unknown
  reference: unknown | null
}
async function readRecoveredWorkflowClosure(sql: Sql, execution: HarnessExecution): Promise<{
  generation: string; session: NativeSessionReference | null
} | undefined> {
  const row = (await sql.query<RecoveredClosureRow>(`select p.generation::text,p.execution_identity,p.reference
    from execution_native_recoveries p join execution_native_closures c on c.generation=p.generation
    where p.execution_id=$1 and c.execution_id=p.execution_id
      and not exists(select 1 from execution_native_closures n where n.execution_id=c.execution_id and n.generation>c.generation)
      and not exists(select 1 from execution_native_closures n where n.execution_id=c.execution_id
        and n.generation<c.generation and n.closed_at is null and n.detached_at is null)`, [execution.id])).rows[0]
  if (!row) return undefined
  const current = (await sql.query<{ record: unknown; reference: unknown | null }>(`select e.record,s.reference
    from harness_executions e left join execution_native_sessions s on s.execution_id=e.id
    where e.id=$1 and e.run_id=$2`, [execution.id, execution.runId])).rows[0]
  if (!current) return conflict()
  const parsed = HarnessExecutionSchema.parse(current.record)
  const session = current.reference === null ? null : NativeSessionReferenceSchema.parse(current.reference)
  if (!isDeepStrictEqual(executionIdentity(parsed), executionIdentity(execution))
    || !isDeepStrictEqual(row.execution_identity, executionIdentity(parsed))
    || !isDeepStrictEqual(row.reference, session)
    || (parsed.nativeSessionId ?? null) !== (session?.nativeSessionId ?? null)
    || (execution.nativeSessionId ?? null) !== (session?.nativeSessionId ?? null)) return conflict()
  return { generation: row.generation, session }
}

type WorkflowRecoveryPurpose = 'cleanup' | 'terminal' | 'failed_attempt'

async function recoveryTarget(sql: GraphTransactionSql, owner: RunOwnership, execution: HarnessExecution,
  purpose: WorkflowRecoveryPurpose) {
  owner.assertOwned()
  if (execution.runId !== owner.runId) return conflict()
  const run = (await sql.query<{ semantics: string; fenced: boolean }>(`select
    r.record->>'executionSemanticsVersion' as semantics,
    (r.stop_requested_at is not null or r.execution_state='completed'
      or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)) as fenced
    from runs r where r.id=$1 for update`, [owner.runId])).rows[0]
  if (run?.semantics !== '3') return conflict()
  const fence = await owner.readOneShotFence(sql)
  const current = (await sql.query<{ record: unknown }>(
    'select record from harness_executions where id=$1 and run_id=$2 for update', [execution.id, owner.runId])).rows[0]
  if (!current) return conflict()
  const parsed = HarnessExecutionSchema.parse(current.record)
  if (!isDeepStrictEqual(executionIdentity(parsed), executionIdentity(execution))
    || parsed.nativeSessionId !== execution.nativeSessionId) return conflict()
  // Terminals retain their accepted result; failed attempts carry their own cleanup
  // cause. Other lifetimes require the Run's committed Stop/cleanup fence.
  if (purpose === 'terminal' && (!isDeepStrictEqual(parsed, execution) || parsed.state !== 'completed' || !parsed.result
    || !parsed.finishedAt || !parsed.nativeSessionId)) return conflict()
  if (purpose === 'failed_attempt') {
    const failedAttempt = await sql.query(`select 1 from harness_executions e
      join approval_execution_state b on b.execution_id=e.id
      where e.id=$1 and e.run_id=$2 and b.failure_result is not null`,
    [execution.id, owner.runId])
    if (failedAttempt.rowCount !== 1) return conflict()
  } else if (run.fenced !== true && purpose !== 'terminal') return conflict()
  if (!execution.nativeSessionId) {
    const entry = (await sql.query<{ phase: string }>(
      'select phase from workflow_native_entries where execution_id=$1 and run_id=$2', [execution.id, owner.runId])).rows[0]
    // The normal repository must still validate and seal the exact canonical
    // reserved/prepared entry. Preparation cannot spawn native work, so a crash
    // between lifetime registration and native entry needs no invented close.
    if (entry && ['reserved', 'prepared', 'not_submitted'].includes(entry.phase)) return undefined
  }
  const lifetime = await latest(sql, execution.id)
  if (!lifetime) return undefined // Only the existing repository can seal a reserved entry.
  if (lifetime.prior_unclosed || !isDeepStrictEqual(lifetime.execution_identity, executionIdentity(parsed))) return conflict()
  if (await (execution.nativeSessionId ? readWorkflowClosure : readUnboundWorkflowClosure)(sql, execution)) return undefined
  const native = (await sql.query<{ reference: unknown; finalized?: boolean }>(
    purpose === 'terminal'
      ? 'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1 for share'
      : 'select reference from execution_native_sessions where execution_id=$1 for share', [execution.id])).rows[0]
  // A completed workflow may have handed this session to a reviewer. That
  // later lifetime belongs to its review-job finalizer, never terminal replay.
  if (purpose === 'terminal' && native?.finalized !== false) return conflict()
  const session = native ? NativeSessionReferenceSchema.parse(native.reference) : null
  if ((execution.nativeSessionId ?? null) !== (session?.nativeSessionId ?? null)
    || lifetime.expected_reference !== null && !isDeepStrictEqual(lifetime.expected_reference, session)
    || lifetime.detached && !isDeepStrictEqual(lifetime.detached_reference, session)) return conflict()
  beforeGraphCommit(sql, async () => {
    owner.assertOwned()
    if (!isDeepStrictEqual(fence, await owner.readOneShotFence(sql))) return conflict()
  })
  return { lifetime, execution: executionIdentity(parsed), session, fence }
}

/** The production callback is NativeProcessRegistry.closeOwner for THIS exact
 * execution scope. It validates positive launch/guardian/cgroup closure receipts;
 * an empty registry returns false. No manager, credential, attach, turn or native
 * response is created here. SQL locks are never held over native IO. */
export async function recoverWorkflowNativeClosure(owner: RunOwnership, execution: HarnessExecution,
  closeProcesses: ((executionId: string, signal: AbortSignal, owner: RunOwnership) => Promise<boolean>) | undefined,
  signal: AbortSignal, options: { purpose?: WorkflowRecoveryPurpose; generation?: string } = {}): Promise<void> {
  signal.throwIfAborted()
  const purpose = options.purpose ?? 'cleanup'
  const target = await owner.oneShotConnection().transaction(async (sql) => {
    const target = await recoveryTarget(sql, owner, execution, purpose)
    if (options.generation !== undefined
      && (await latest(sql, execution.id))?.generation !== options.generation) return conflict()
    return target
  })
  if (!target) return
  owner.assertOwned(); signal.throwIfAborted()
  if (!closeProcesses || !await closeProcesses(execution.id, signal, owner)) throw new DomainError(
    'REPEAT_CLEANUP_PENDING', 'The original native process has no positive closure receipt yet.', 409)
  owner.assertOwned(); signal.throwIfAborted()
  await owner.oneShotConnection().transaction(async (sql) => {
    const current = await recoveryTarget(sql, owner, execution, purpose)
    // An original close may have committed while physical cleanup ran. Reuse
    // only its exact readback; any other generation/session/owner change fails.
    if (!current) {
      const proof = await (execution.nativeSessionId ? readWorkflowClosure : readUnboundWorkflowClosure)(sql, execution)
      if (proof?.durableGeneration !== target.lifetime.generation) return conflict()
      return
    }
    if (!isDeepStrictEqual(current, target)) return conflict()
    owner.assertOwned(); signal.throwIfAborted()
    await sql.query(`insert into execution_native_recoveries
      (generation,execution_id,execution_identity,reference,owner_id,owner_fence)
      values($1::bigint,$2,$3::jsonb,$4::jsonb,$5,$6)`,
    [target.lifetime.generation, execution.id, JSON.stringify(target.execution),
      target.session === null ? null : JSON.stringify(target.session), target.fence.ownerId, target.fence.fence])
    beforeGraphCommit(sql, async () => {
      owner.assertOwned(); signal.throwIfAborted()
      const proof = await readRecoveredWorkflowClosure(sql, execution)
      if (proof?.generation !== target.lifetime.generation || !isDeepStrictEqual(proof.session, target.session)) return conflict()
    })
  })
}

/** Diagnostic selection only, never settlement authority. The existing finalizer
 * still revalidates every exact attempt, native generation and resource receipt. */
export async function hasRecoveredWorkflowNativeLifetime(owner: RunOwnership): Promise<boolean> {
  owner.assertOwned()
  const row = (await owner.oneShotConnection().query<{ recovered: boolean }>(`select exists(
    select 1 from execution_native_recoveries p join harness_executions e on e.id=p.execution_id
    where e.run_id=$1) as recovered`, [owner.runId])).rows[0]
  owner.assertOwned()
  return row?.recovered === true
}

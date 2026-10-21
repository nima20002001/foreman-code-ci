import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { NativeExecutionPlacementSchema } from '@foreman-code/contracts/node-placement'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema, type SourceRootRecord, type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readAcceptedPlacement, readDispatchIntent } from '../placement/persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError, retryDatabaseRead } from '../errors.js'
import type { SourceAttemptAuthority } from './ports.js'
import type { MaterializationAttempt } from './ports.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { sourceMaterializationDigest } from './bindingHash.js'

interface AuthorizationInput { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }
type AcceptedAgentSource = Awaited<ReturnType<AgentSourceAttemptAuthority['accepted']>>

/** Source authority from the genuine accepted Agent execution/Run/dispatch.
 * No Agent is converted to a Job and no pre-Run materialization is fabricated. */
export class AgentSourceAttemptAuthority implements SourceAttemptAuthority {
  constructor(private readonly pool: pg.Pool, private readonly rootFence: (sql: GraphSqlClient, root: SourceRootRecord) => Promise<void>) {}
  /** Writers keep the Run rows locked until COMMIT. A read-only check (`lock` false) reads committed rows and acts
   * only after it returns, so it never queues behind the Run owner. */
  private async accepted(sql: GraphSqlClient, executionId: string, attemptId: string, operationId: string, caller?: ManagementPrincipal,
    lock = true) {
    const share = lock ? ' for share' : ''
    const original = await readDispatchIntent(sql, executionId), intent = await readReconciledDispatchIntent(sql, operationId, lock)
    const execution = (await sql.query<{ run_id: string; workflow_node_id: string; agent_id: string }>(`select run_id,workflow_node_id,agent_id from harness_executions where id=$1${share}`, [executionId])).rows[0]
    if (!execution || !original || !intent || original.operationId !== operationId || intent.executionId !== executionId || intent.attemptId !== attemptId
      || intent.runId !== execution.run_id || intent.nodeId !== execution.workflow_node_id || original.bindingHash !== intent.bindingHash)
      throw new DomainError('AGENT_SOURCE_ALLOCATION_MISSING', 'The original real Agent execution and accepted dispatch source allocation are required.', 409)
    const grant = await sql.query(`select 1 from execution_dispatch_owner_grants where execution_id=$1
      and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked${share}`,
      [executionId, operationId, intent.owner.grantId, intent.owner.epoch])
    if (grant.rowCount !== 1) throw new DomainError('AGENT_SOURCE_OWNER_REVOKED', 'The original current execution owner grant is unavailable.', 403)
    const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
    const row = (await sql.query<{ record: unknown; stopped: boolean; cleanup: boolean }>(`select r.record,r.stop_requested_at is not null stopped,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) cleanup from runs r where id=$1${share}`, [intent.runId])).rows[0]
    if (!placement || !row || placement.payload.kind !== 'agent' || placement.payload.agentId !== execution.agent_id || placement.bindingHash !== intent.bindingHash)
      throw new DomainError('AGENT_SOURCE_PIN_CONFLICT', 'Source authority must belong to the actual accepted Agent/configuration/placement.', 409)
    const run = AcceptedWorkflowRunV3Schema.parse(row.record)
    const principal = (await currentOperatorAuthority(sql, run.authorizationPrincipalId)).principal
    if (caller && caller.id !== principal.id || run.id !== intent.runId || row.stopped || row.cleanup || ['completed', 'interrupted'].includes(run.executionState)
      || run.agentConfigurationVersionIds[execution.agent_id] !== placement.payload.agentConfigurationVersionId)
      throw new DomainError('AGENT_SOURCE_AUTHORITY_ENDED', 'The original accepted Agent Run authority no longer admits source operations.', 403)
    requireAuthorization(principal, 'runs:start', { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id })
    requireAuthorization(principal, 'sources:read', { workspaceId: run.workspaceId }); requireAuthorization(principal, 'source_roots:read', { workspaceId: run.workspaceId })
    return { execution, intent, placement, run, principal }
  }
  async authorize(sql: GraphSqlClient, principal: ManagementPrincipal, input: AuthorizationInput, lock = true): Promise<void> {
    const actual = await this.accepted(sql, input.attempt.executionId, input.attempt.attemptId, input.operationId, principal, lock)
    await this.authorizeAccepted(sql, actual, input)
  }
  private async authorizeAccepted(sql: GraphSqlClient, actual: AcceptedAgentSource, input: AuthorizationInput): Promise<void> {
    const source = actual.placement.source
    if (!('kind' in source) || source.kind !== 'pending' || actual.run.workspaceId !== input.workspaceId || input.root.binding.workspaceId !== input.workspaceId
      || source.approvedSourceId !== input.root.source.approvedSourceId || source.snapshotId !== input.root.source.snapshotId || source.manifestDigest !== input.root.source.manifestDigest
      || source.rootId !== input.root.binding.rootId || source.bindingRevision !== input.root.binding.bindingRevision
      || !isDeepStrictEqual(actual.placement.hostRef, input.root.selection.hostRef) || !isDeepStrictEqual(actual.placement.registration, input.root.registration)
      || input.attempt.placementHash !== sourceOperationSelectionHash(input.root, input.attempt, input.operationId))
      throw new DomainError('AGENT_SOURCE_PIN_CONFLICT', 'Actual Agent source preparation cannot change accepted source/root/host/operation pins.', 409)
    await this.rootFence(sql, input.root)
  }
  async authorizeFinal(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, finalHash: string,
    lock = true): Promise<void> {
    const actual = await this.accepted(sql, record.receipt.executionId, record.receipt.attemptId, record.operationId, principal, lock)
    await this.assertFinal(sql, actual, record, finalHash, lock)
  }
  private async assertFinal(sql: GraphSqlClient, actual: AcceptedAgentSource, record: SourceMaterializationRecord, finalHash: string,
    lock: boolean): Promise<void> {
    const share = lock ? ' for share' : ''
    const row = (await sql.query<{ record: unknown }>(`select record from execution_native_placements where execution_id=$1${share}`, [record.receipt.executionId])).rows[0]
    const binding = NativeExecutionPlacementSchema.parse(row?.record)
    if (binding.acceptedBindingHash !== actual.placement.bindingHash || binding.bindingHash !== finalHash || binding.runId !== actual.run.id
      || binding.nodeId !== actual.intent.nodeId || binding.executionId !== record.receipt.executionId || binding.attemptId !== record.receipt.attemptId || binding.operationId !== record.operationId
      || binding.materialization.receipt.materializationId !== record.receipt.materializationId || sourceMaterializationDigest(binding.materialization) !== sourceMaterializationDigest(record))
      throw new DomainError('AGENT_SOURCE_FINAL_BINDING_CONFLICT', 'Only the actual finalized execution placement may adopt this original Agent source materialization.', 409)
    const rootRow = (await sql.query<{ record: unknown }>(`select record from source_root_bindings where root_id=$1 and binding_revision=$2${share}`, [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
    await this.authorizeAccepted(sql, actual, { workspaceId: actual.run.workspaceId, root: SourceRootRecordSchema.parse(rootRow?.record), attempt: record.receipt, operationId: record.operationId })
  }
  /** Revalidation only reads: it uses committed rows and is replayed after a lock or statement timeout. */
  private async read<T>(operation: (sql: GraphSqlClient) => Promise<T>): Promise<T> {
    return retryDatabaseRead(() => withTransaction(this.pool, operation))
  }
  revalidate(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<void> {
    return this.read(async sql => {
      const original = await readDispatchIntent(sql, attempt.executionId)
      if (!original) throw new DomainError('AGENT_SOURCE_ALLOCATION_MISSING', 'The original Agent allocation is missing.', 409)
      const actual = await this.accepted(sql, attempt.executionId, attempt.attemptId, original.operationId, undefined, false)
      await this.authorizeAccepted(sql, actual, { workspaceId: actual.run.workspaceId, root, attempt, operationId: original.operationId })
    })
  }
  revalidateMaterialization(record: SourceMaterializationRecord): Promise<void> {
    return this.read(async sql => {
      const actual = await this.accepted(sql, record.receipt.executionId, record.receipt.attemptId, record.operationId, undefined, false)
      const root = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2', [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
      await this.authorizeAccepted(sql, actual, { workspaceId: actual.run.workspaceId, root: SourceRootRecordSchema.parse(root?.record), attempt: record.receipt, operationId: record.operationId })
      if (record.finalDispatchBindingHash) await this.assertFinal(sql, actual, record, record.finalDispatchBindingHash, false)
    })
  }
}
/** Selection is actual persisted execution subject membership, never caller kind. */
export function installedSourceAttemptAuthority(pool: pg.Pool, agent: SourceAttemptAuthority, job: SourceAttemptAuthority): SourceAttemptAuthority {
  async function selected(sql: GraphSqlClient, id: string) {
    const subjects = (await sql.query<{ kind: string }>(`select 'agent' kind from harness_executions where id=$1
      union all select 'job' kind from job_preparations where execution_id=$1
      union all select 'job' kind from workflow_job_preparations where preparation->>'executionId'=$1`, [id])).rows
    if (subjects.length !== 1) throw new DomainError('SOURCE_SUBJECT_AMBIGUOUS', 'Exactly one actual Agent or Job allocation must own the source operation.', 409)
    return subjects[0]!.kind === 'agent' ? agent : job
  }
  const withSubject = async (id: string, action: (authority: SourceAttemptAuthority) => Promise<void>) => {
    const sql = await pool.connect()
    let authority: SourceAttemptAuthority
    try { authority = await selected(sql, id) } finally { sql.release() }
    await action(authority)
  }
  return {
    authorize: async (sql, principal, input, lock) => (await selected(sql, input.attempt.executionId)).authorize(sql, principal, input, lock),
    authorizeFinal: async (sql, principal, record, hash, lock) => (await selected(sql, record.receipt.executionId)).authorizeFinal(sql, principal, record, hash, lock),
    revalidate: (root, attempt) => withSubject(attempt.executionId, a => a.revalidate(root, attempt)),
    revalidateMaterialization: record => withSubject(record.receipt.executionId, a => a.revalidateMaterialization(record)),
  }
}

/** Full-tree verification is always allowed; a child CWD must be the exact
 * original accepted Agent path. Job preparations use their clone root. */
export async function assertAcceptedSourceRelativeCwd(sql: GraphSqlClient, executionId: string, relativeCwd: string): Promise<void> {
  if (!relativeCwd) return
  const execution = (await sql.query<{ run_id: string; workflow_node_id: string }>('select run_id,workflow_node_id from harness_executions where id=$1 for share', [executionId])).rows[0]
  const placement = execution ? await readAcceptedPlacement(sql, execution.run_id, execution.workflow_node_id) : undefined
  if (!placement || placement.payload.kind !== 'agent' || relativeCwd !== posix.relative(placement.destination.canonicalProjectRoot, placement.destination.canonicalCwd))
    throw new DomainError('SOURCE_CWD_PIN_CONFLICT', 'Working directory must match the exact original accepted Agent path.', 409)
}

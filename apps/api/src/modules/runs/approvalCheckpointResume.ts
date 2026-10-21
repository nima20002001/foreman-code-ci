import { readPublicProjectionLocked } from '../run-graph/compactSnapshot.js'
import { randomUUID } from 'node:crypto'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { DurableInteraction } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, RunGraphScopeSchema } from '@foreman-code/contracts/wave25'
import { isAtomicApprovalCheckpointSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import { DomainError } from '../errors.js'
import { openRunGraphPublication } from '../run-graph/publication.js'
import { beforeGraphCommit, didGraphTransactionCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { PostgresInteractionRepository } from '../interactions/postgres.js'
import { Wave25InteractionRepository } from '../interactions/wave25/repository.js'
import { lockInteraction, readContext } from '../interactions/wave25/context.js'
import { consumeApprovalGraphResume, holdResumeClaims } from '../interactions/wave25/resume.js'
import type { GraphResumeClaim } from '../interactions/deliveryPostgres.js'
import type { RunOwnership } from './ownership.js'
import { mintWorkflowResumePermit, type WorkflowResumePermit } from './workflowResumePermit.js'
import { assertWorkflowApprovalAckLocked } from '../interactions/nativeApprovalProof.js'

type WorkflowRunV3 = ReturnType<typeof WorkflowRunV3Schema.parse>
export type { WorkflowResumePermit }
export type AuthorizeApprovalResume = (sql: GraphTransactionSql, run: WorkflowRunV3) => Promise<void>

/** The existing permission checker reads current grants. Hold the accepted and
 * root principal rows so revocation/grant changes serialize with this receipt;
 * a timer-based expiry still needs a database-clock check just before COMMIT. */
async function lockResumeAuthority(sql: GraphTransactionSql, run: WorkflowRunV3): Promise<string[]> {
  const id = run.authorizationPrincipalId
  if (!id) return []
  const discovery = (await sql.query<{ delegated_from: string | null }>(
    'select delegated_from from management_principals where id=$1', [id])).rows[0]
  const ids = [...new Set([id, ...(discovery?.delegated_from ? [discovery.delegated_from] : [])])].sort()
  const locked = await sql.query<{ id: string; delegated_from: string | null }>(
    'select id,delegated_from from management_principals where id=any($1::text[]) order by id for share', [ids])
  if (!discovery || locked.rows.length !== ids.length
    || locked.rows.find((row) => row.id === id)?.delegated_from !== discovery.delegated_from) {
    throw new DomainError('RUN_AUTHORIZATION_REVOKED', 'The accepted Run authority changed.', 403)
  }
  if (discovery.delegated_from) await sql.query(
    'select principal_id from run_authority_principals where principal_id=$1 for share', [id])
  return ids
}

/** The service and periodic engine recovery share this SQL-only boundary.
 * Claims are short independent transactions. Actual checkpoint writes and every
 * graph.resume receipt use the EXISTING dedicated Run owner's one transaction.
 * A caller may invoke the graph only after this function has committed.
 */
export async function consumeDeliveredApprovals(owner: RunOwnership, saver: BaseCheckpointSaver,
  repository: PostgresInteractionRepository | undefined, delivered: readonly DurableInteraction[],
  suppliedClaim?: GraphResumeClaim, authorize?: AuthorizeApprovalResume): Promise<WorkflowResumePermit | undefined> {
  if (!(repository instanceof Wave25InteractionRepository) || !isAtomicApprovalCheckpointSaver(saver)) {
    throw new DomainError('GRAPH_RESUME_ATOMIC_CONSUMER_REQUIRED', 'V3 resume requires the real atomic checkpoint saver and approval repository.', 409)
  }
  if (delivered.length > 1000 || new Set(delivered.map((item) => item.id)).size !== delivered.length
    || delivered.some((item) => item.runId !== owner.runId || item.graphThreadId !== owner.runId
      || item.status !== 'delivered' || item.deliveryState !== 'delivered')) {
    throw new DomainError('GRAPH_INTERRUPT_INVALID', 'Resume must use current delivered interactions from one Run.', 409)
  }
  if (suppliedClaim && !delivered.some((item) => item.id === suppliedClaim.interaction.id)) {
    throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'The supplied resume claim is not a current delivered branch.', 409)
  }
  owner.assertOwned()
  if (!delivered.length) return undefined
  const ordered = [...delivered].sort((a, b) => a.id.localeCompare(b.id))
  const claims = new Map<string, GraphResumeClaim>()
  const claimedAt = Date.now()
  for (const item of ordered) {
    owner.assertOwned()
    const claim = suppliedClaim?.interaction.id === item.id ? suppliedClaim
      : await repository.delivery.claimAtomicGraphResume(item.id, randomUUID())
    if (claim) claims.set(item.id, claim)
  }
  for (const claim of holdResumeClaims(repository.delivery, [...claims.values()].filter(claim => claim !== suppliedClaim), claimedAt)) {
    claims.set(claim.interaction.id, claim)
  }
  const releaseClaims = () => Promise.all([...claims.values()].map(claim => claim.release?.()))
  let transaction: GraphTransactionSql | undefined
  const consumeCheckpoint = async (sql: GraphTransactionSql) => {
    // The owner takes over the claims here; a renewal must not queue behind this transaction's row locks.
    await releaseClaims()
    transaction = sql
    owner.assertOwned()
    const row = (await sql.query<{ record: unknown }>('select record from runs where id=$1', [owner.runId])).rows[0]
    const discovery = WorkflowRunV3Schema.parse(row?.record)
    const scope = RunGraphScopeSchema.parse({ workspaceId: discovery.workspaceId, workflowId: discovery.workflowId,
      runId: discovery.id, workflowVersionId: discovery.workflowVersionId, executionSemanticsVersion: 3 })
    const publication = await openRunGraphPublication(sql, scope, readPublicProjectionLocked)
    await owner.readOneShotFence(sql)
    // Match the shared publication hierarchy: parent/head, executions, then
    // interactions/outboxes, and finally checkpoint writes. Never lock a child
    // from a notification before discovering the current immutable Run.
    const ids = [...new Set(ordered.map((item) => item.executionId))].sort()
    const executions = await sql.query('select id from harness_executions where run_id=$1 and id=any($2::text[]) order by id for update', [owner.runId, ids])
    if (executions.rows.length !== ids.length) throw new DomainError('GRAPH_RESUME_LIMIT', 'The exact resumed executions are missing.', 409)
    const currentRun = WorkflowRunV3Schema.parse((await sql.query<{ record: unknown }>(
      'select record from runs where id=$1', [owner.runId])).rows[0]?.record)
    if (currentRun.authorizationPrincipalId && !authorize) {
      throw new DomainError('GRAPH_SECURITY_UNQUALIFIED', 'Resume requires the accepted Run authorization check.', 409)
    }
    // This is the existing SQL-only permission ceiling check, NOT filesystem or
    // native preflight. The latter still runs outside SQL at native dispatch.
    const principalIds = await lockResumeAuthority(sql, currentRun)
    await authorize?.(sql, currentRun)
    const current: DurableInteraction[] = []
    const checkpointIds = new Set<string>()
    const completedReplays = new Set<string>()
    for (const notification of ordered) {
      const item = await lockInteraction(sql, notification.id)
      if (item.runId !== owner.runId || item.graphThreadId !== owner.runId
        || item.graphInterruptId !== notification.graphInterruptId
        || item.status !== 'delivered' || item.deliveryState !== 'delivered') {
        throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'The delivered notification is no longer current.', 409)
      }
      // A receipt proves a past checkpoint commit, not present continuation
      // authority. Check Stop, cleanup and credential closure even on replay.
      const execution = (await sql.query<{ record: { state?: unknown } }>(
        'select record from harness_executions where id=$1 and run_id=$2', [item.executionId, item.runId])).rows[0]
      if (execution?.record.state === 'completed') {
        // A crash after the exact native terminal but before graph checkpoint
        // completion is a read-only replay. Its original ACK and consumed
        // checkpoint receipt must already exist; an enum alone is insufficient.
        await assertWorkflowApprovalAckLocked(sql, item)
        completedReplays.add(item.id)
      }
      await readContext(sql, item, true, completedReplays.has(item.id))
      checkpointIds.add(await saver.inspectApprovalInterrupt(sql, item))
      current.push(item)
    }
    // Save original lease deadlines: the atomic consumer releases the outbox
    // lease in its mutation, but expiration must still fence the eventual commit.
    const deadlines = await sql.query<{ deadline: Date | null }>(`select min(lease_expires_at) as deadline
      from interaction_graph_resumes where run_id=$1 and interaction_id=any($2::text[])
        and lease_token=any($3::text[]) and state='resuming'`,
    [currentRun.id, current.map((item) => item.id), [...claims.values()].map((claim) => claim.ownerToken)])
    const deadline = deadlines.rows[0]?.deadline
    for (const item of current) {
      if (claims.has(item.id)) continue
      const consumed = await sql.query(`select 1 from run_graph_effects
        where run_id=$1 and effect_kind='graph.resume' and entity_id=$2`, [currentRun.id, item.id])
      if (consumed.rowCount === 1) continue
      // Recovery waits for review completion or another callback's lease without consuming sibling interrupts.
      if (!suppliedClaim) {
        const pending = await sql.query(`select 1 from interaction_graph_resumes g
          where g.interaction_id=$1 and g.state not in ('canceled','resumed')
            and g.last_error is distinct from 'GRAPH_RESUME_RECEIPT_MISSING'
            and (g.lease_expires_at>clock_timestamp() or ($2::text='orchestrator' and exists (
              select 1 from review_jobs j where j.interaction_id=g.interaction_id
                and j.state not in ('completed','failed'))))`, [item.id, item.approval.handler])
        if (pending.rowCount === 1) return undefined
      }
      throw new DomainError('GRAPH_RESUME_OWNER_LOST', 'A delivered branch is still owned by another resume attempt.', 409)
    }
    let ready = false
    for (const item of current) {
      const claim = claims.get(item.id)
      if (claim) {
        await consumeApprovalGraphResume(publication, claim, (transaction, actual) => saver.consumeApprovalInterrupt(transaction, actual))
        ready = true
      } else {
        // A persisted receipt still needs digest validation; an unclaimed path cannot write a checkpoint.
        await consumeApprovalGraphResume(publication, { interaction: item, ownerToken: '' }, async () => {
          throw new DomainError('GRAPH_RESUME_RECEIPT_MISSING', 'Unclaimed recovery cannot consume an interrupt.', 409)
        })
        ready = true
      }
    }
    // The callback can release outbox leases before COMMIT; the existing
    // consumer retains their original expiry checks. Recheck owner/authority at
    // this final boundary too, including transactions containing only replays.
    beforeGraphCommit(sql, async () => {
      await owner.readOneShotFence(sql)
      await authorize?.(sql, currentRun)
      for (const item of current) await readContext(sql, item, true, completedReplays.has(item.id))
      const alive = await sql.query(`select 1 where
        ($1::timestamptz is null or $1::timestamptz>clock_timestamp()) and not exists (
          select 1 from management_principals where id=any($2::text[])
            and (revoked_at is not null or expires_at<=clock_timestamp())) and not exists (
          select 1 from run_authority_principals where principal_id=any($2::text[])
            and accepted_expires_at<=clock_timestamp())`, [deadline ?? null, principalIds])
      if (alive.rowCount !== 1) throw new DomainError('GRAPH_RESUME_AUTHORITY_EXPIRED', 'Resume authority expired before commit.', 409)
    })
    if (!ready || checkpointIds.size !== 1) throw new DomainError('GRAPH_INTERRUPT_NOT_CURRENT', 'Resume did not consume one current checkpoint.', 409)
    return { runId: owner.runId, versionId: currentRun.workflowVersionId, checkpointId: [...checkpointIds][0]!,
      fence: await owner.readOneShotFence(sql), interactions: current }
  }
  let committed: Awaited<ReturnType<typeof consumeCheckpoint>>
  try {
    committed = await owner.oneShotConnection().transaction(consumeCheckpoint)
  } finally {
    await releaseClaims()
  }
  owner.assertOwned()
  if (!transaction || !didGraphTransactionCommit(transaction) || owner.oneShotConnection().unusable) {
    throw new DomainError('GRAPH_RESUME_COMMIT_UNCERTAIN', 'No confirmed checkpoint commit permits graph continuation.', 409)
  }
  if (!committed) {
    for (const claim of claims.values()) {
      await repository.delivery.finishGraphResume(claim, 'GRAPH_RESUME_DEFERRED')
    }
    return undefined
  }
  return mintWorkflowResumePermit({ ...committed, owner, saver })
}

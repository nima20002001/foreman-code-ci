import { readPublicProjectionLocked } from '../run-graph/compactSnapshot.js'
import type pg from 'pg'
import { AcceptedWorkflowRunV3Schema, RepeatGraphScopeV3Schema,
  type AcceptedWorkflowRunV3, type GraphEffectAccessState } from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import { beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { currentRunGraphPublication, graphSourceDigest, openRunGraphPublication, readRepeatRunSourceLocked } from '../run-graph/publication.js'
import { readPublicRunStateLocked } from '../run-graph/publicRunState.js'
import { publicRunClosedFacts } from '../run-graph/publicProjection.js'
import { publishRepeatRunStateLocked } from '../run-graph/repeatPublication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { assertConsumedWorkflowResumeLocked, type WorkflowResumePermit } from './workflowResumePermit.js'
import type { RunOwnership } from './ownership.js'
import type { RunStateUpdate } from './port.js'
import { sameRepeatValue } from './repeatResolution.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { cancelHierarchyContinuationsLocked } from './hierarchyDirection.js'
import { cancelWorkflowControlsLocked } from '../collaboration/workflowControlStore.js'

export function workflowRunScope(run: AcceptedWorkflowRunV3) {
  return RepeatGraphScopeV3Schema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 })
}

/** Discovery is intentionally not FOR SHARE: openRunGraphPublication takes the
 * parent UPDATE lock before the head/children. Upgrading a prior shared parent
 * lock would deadlock two concurrent lifecycle writers. Never initialize a head. */
export async function openWorkflowLifecycleLocked(sql: GraphTransactionSql, runId: string) {
  const found = await sql.query<{ record: unknown }>('select record from runs where id=$1', [runId])
  if (found.rows.length !== 1) throw new DomainError('RUN_NOT_FOUND', 'The exact Run was not found.', 404)
  const discovery = AcceptedWorkflowRunV3Schema.parse(found.rows[0]!.record)
  if (discovery.id !== runId) throw new DomainError('RUN_PIN_CONFLICT', 'Run identity changed during lifecycle discovery.', 409)
  const publication = await openRunGraphPublication(sql, workflowRunScope(discovery), readPublicProjectionLocked)
  const snapshot = await readAcceptedRepeatRunLocked(sql, runId)
  if (!sameRepeatValue(workflowRunScope(snapshot.run), publication.scope)) throw new DomainError('RUN_PIN_CONFLICT', 'The locked Run scope differs from its canonical head.', 409)
  return { publication, snapshot }
}

/** A replay verifies an existing complete source, never reconstructs a missing
 * transition or creates a new cleanup intent. The receipt is checked again after
 * G1 finalization, so returning from a producer is not mistaken for COMMIT. */
async function verifyRunReplay(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3, stopped: boolean): Promise<void> {
  const scope = workflowRunScope(run)
  const source = await readRepeatRunSourceLocked(sql, scope)
  if (!source.replayed || source.stopped !== stopped || !sameRepeatValue(source.run, run)) throw new DomainError('GRAPH_SOURCE_CONFLICT', 'The exact persisted Run state has no matching canonical source.', 409)
  requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence: source.evidence,
    sourceDigest: source.sourceDigest, semanticDigest: source.semanticDigest, effect: null })
  beforeGraphCommit(sql, async () => {
    const latest = await readRepeatRunSourceLocked(sql, scope)
    if (!latest.replayed || latest.stopped !== stopped || !sameRepeatValue(latest.run, run)
      || !sameRepeatValue(latest.evidence, source.evidence) || latest.sourceDigest !== source.sourceDigest
      || latest.semanticDigest !== source.semanticDigest) {
      throw new DomainError('GRAPH_SOURCE_CONFLICT', 'Run state changed after exact replay validation.', 409)
    }
  })
}

/** Common owner-state writer. Waiting -> running needs the exact confirmed
 * atomic checkpoint/effect permit. Terminal transitions have a separate proof
 * writer; a generic state update cannot pretend to complete or resume work. */
export async function markRepeatRunRunning(owner: RunOwnership,
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization'>, input: RunStateUpdate, resume?: WorkflowResumePermit): Promise<void> {
  const update = structuredClone(input)
  if (update.executionState !== 'running' || update.outcome !== 'pending'
    || Object.keys(update).some((key) => !['executionState', 'outcome', 'startedAt'].includes(key))) {
    throw new DomainError('REPEAT_LIFECYCLE_PUBLICATION_REQUIRED', 'Use the current proof-bearing writer for this lifecycle transition.', 409)
  }
  owner.assertOwned()
  await owner.oneShotConnection().transaction(async (sql) => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    const { run } = snapshot
    const fence = await owner.readOneShotFence(sql)
    const authorize = async (atCommit = false) => {
      owner.assertOwned()
      // Same accepted authority and revocation locks as the occurrence host. No
      // caller-supplied principal, fresh grant, location or version is accepted.
      await sql.query(`select principal_id from run_authority_principals
        where principal_id=$1 and run_id=$2 for share`, [run.authorizationPrincipalId, run.id])
      await sql.query(`select p.id from management_principals p where p.id=$1
        or p.id=(select owner_principal_id from run_authority_principals where principal_id=$1 and run_id=$2)
        order by p.id for share`, [run.authorizationPrincipalId, run.id])
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId,
        sql, atCommit)
      if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) throw new DomainError('RUN_OWNERSHIP_LOST', 'The exact Run owner changed before lifecycle COMMIT.', 409)
    }
    await authorize()
    beforeGraphCommit(sql, () => authorize(true))
    if (snapshot.stopRequested || snapshot.cleanupPending) throw new DomainError('GRAPH_STOP_CONFLICT', 'Stop/cleanup fences block repeat progress.', 409)
    if (run.executionState === 'waiting') await assertConsumedWorkflowResumeLocked(sql, owner, run, resume)
    if (!['queued', 'running', 'waiting'].includes(run.executionState)) throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'A terminal/interrupted Run cannot be started again.', 409)
    if (run.startedAt !== undefined && update.startedAt !== undefined && run.startedAt !== update.startedAt) {
      throw new DomainError('RUN_PIN_CONFLICT', 'The original Run start timestamp cannot be replaced.', 409)
    }
    if (run.executionState === 'running') {
      if (!run.startedAt) throw new DomainError('RUN_PIN_CONFLICT', 'A running Run has no original start timestamp.', 409)
      await verifyRunReplay(sql, run, snapshot.stopRequested)
      return
    }
    const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'running', outcome: 'pending',
      startedAt: run.startedAt ?? update.startedAt ?? new Date().toISOString() })
    const changed = await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [run.id, next.executionState, JSON.stringify(next)])
    if (changed.rowCount !== 1) throw new DomainError('RUN_NOT_FOUND', 'The owned Run disappeared during lifecycle publication.', 409)
    await publishRepeatRunStateLocked(publication, owner)
  })
}

export type AuthorizeWorkflowStop = (sql: GraphTransactionSql) => Promise<void>

/** Shared SQL Stop writer. The authenticated command and an internal authorized
 * Stop compose this on their existing G1. No provider/process work occurs here. */
export async function requestWorkflowStopLocked(sql: GraphTransactionSql, runId: string,
  authorize: AuthorizeWorkflowStop, opened?: Awaited<ReturnType<typeof openWorkflowLifecycleLocked>>): Promise<'accepted' | 'already_terminal'> {
  if (typeof authorize !== 'function') throw new DomainError('REPEAT_STOP_AUTHORIZATION_REQUIRED', 'Stop requires its live SQL command authorizer.', 409)
  const { publication, snapshot } = opened ?? await openWorkflowLifecycleLocked(sql, runId)
  if (snapshot.run.id !== runId || publication.sql !== sql
    || currentRunGraphPublication(sql, workflowRunScope(snapshot.run)) !== publication) throw new DomainError(
    'GRAPH_SCOPE_MISMATCH', 'Stop must join the actual publication for this Run.', 409)
  await authorize(sql)
  beforeGraphCommit(sql, () => authorize(sql))
  if (snapshot.stopRequested || snapshot.run.executionState === 'completed') {
    await verifyRunReplay(sql, snapshot.run, snapshot.stopRequested)
    return snapshot.stopRequested ? 'accepted' : 'already_terminal'
  }
  const effect = { identity: { kind: 'run.stop' as const, entityId: runId }, digest: graphSourceDigest({ runId, stop: true }) }
  // This authority is the actual authorized command transaction, not a native
  // session or replacement Run owner. Parent locking fences concurrent launch.
  const readAuthority = async (): Promise<GraphEffectAccessState> => {
    await authorize(sql)
    const row = (await sql.query<{ owner: string; fence: string; record: unknown }>(
      'select pg_backend_pid()::text as owner,txid_current()::text as fence,record from runs where id=$1', [runId])).rows[0]
    if (!row) throw new DomainError('RUN_NOT_FOUND', 'The locked Run disappeared.', 404)
    const actual = AcceptedWorkflowRunV3Schema.parse(row.record)
    return { scope: workflowRunScope(actual), effect: effect.identity, effectDigest: effect.digest,
      ownerId: row.owner, fence: row.fence, connectionGeneration: null, ownership: 'held',
      access: 'effect', security: 'valid', effectClosed: actual.executionState === 'completed', submission: 'unknown' }
  }
  const authority = await readAuthority()
  const expected = { scope: authority.scope, effect: effect.identity, effectDigest: effect.digest,
    ownerId: authority.ownerId, fence: authority.fence, connectionGeneration: null }
  const state = { ...await readPublicRunStateLocked(sql, publication.scope), stopRequested: true, cleanupPending: true }
  const evidence = { sourceKind: 'run' as const, sourceId: `stop-${effect.digest.slice(7)}`, sourceRevision: '0' }
  await publication.effect({ effect, sourceDigest: effect.digest, evidence,
    facts: [{ type: 'run.state', state }, ...await publicRunClosedFacts(sql, publication.scope)] },
  { expected, readCurrentLocked: readAuthority }, async () => {
    await cancelHierarchyContinuationsLocked(sql, runId)
    await cancelWorkflowControlsLocked(sql, runId, new Date().toISOString())
    await sql.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=now()`, [runId])
    await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
      values($1,'backend','run_stop_requested',clock_timestamp(),$2::jsonb)`,
    [runId, JSON.stringify({ stopRequested: true })])
  })
  requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: publication.scope, evidence, sourceDigest: effect.digest,
    effect: { kind: 'run.stop', entityId: runId, digest: effect.digest } })
  const receipt = await publication.repeatStoppedRunReadback()
  requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: publication.scope, evidence: receipt.evidence,
    sourceDigest: receipt.sourceDigest, semanticDigest: receipt.semanticDigest, effect: null })
  return 'accepted'
}

export async function requestRepeatRunStop(pool: pg.Pool, runId: string, authorize: AuthorizeWorkflowStop): Promise<void> {
  await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    await requestWorkflowStopLocked(sql, runId, authorize)
  }))
}

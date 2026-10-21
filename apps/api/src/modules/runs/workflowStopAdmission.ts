import type pg from 'pg'
import { commandInputHash } from '../commands/postgres.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { graphSourceDigest, readRepeatRunSourceLocked } from '../run-graph/publication.js'
import { readPublicRunStateLocked } from '../run-graph/publicRunState.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { CurrentStopContext, CurrentStopReceipt } from './currentProduction.js'
import type { LangGraphWorkflowEngine } from './engine.js'
import type { PostgresRunRepository } from './postgres.js'
import { openWorkflowLifecycleLocked, requestWorkflowStopLocked } from './repeatLifecycle.js'
import { sameRepeatValue } from './repeatResolution.js'
import { assertWorkflowRunSettlementLocked } from './workflowRepositoryServices.js'

/** Exclude only mutable lifecycle fields. In particular, preserve absence of
 * optional fields and the exact accepted input/configuration/location/authority
 * values. There is no request normalization, retagging or draft substitution. */
export function immutableWorkflowRunPins(run: CurrentStopContext['run']): Record<string, unknown> {
  const pins: Record<string, unknown> = structuredClone(run)
  for (const key of ['executionState', 'outcome', 'result', 'startedAt', 'finishedAt', 'stopCause']) delete pins[key]
  return pins
}
interface StopIntent {
  principalId: string
  commandId: string
  workspaceId: string
  runId: string
  requestHash: string
  source: 'http' | 'mcp'
  pins: Record<string, unknown>
  receipt: CurrentStopReceipt
}
function uncertain(code = 'WORKFLOW_STOP_SETTLEMENT_PENDING'): never {
  throw new DomainError(code,
    'The original Stop command remains pending. Reconcile this same command ID; intent acceptance is not native settlement.', 409)
}
function conflict(): never {
  throw new DomainError('IDEMPOTENCY_CONFLICT', 'The original Stop command has different immutable request or Run pins.', 409)
}
function intentEvidence(intent: StopIntent) {
  return { sourceKind: 'cleanup' as const,
    sourceId: `stop-intent:${graphSourceDigest([intent.principalId, intent.commandId]).slice(7)}`, sourceRevision: '1' }
}
async function lockStopRun(sql: GraphTransactionSql, context: CurrentStopContext) {
  // Acquire the stronger parent lock BEFORE the head or any child; B's callback
  // takes this same lock, so there is no late NO KEY UPDATE -> UPDATE upgrade.
  if ((await sql.query('select id from runs where id=$1 for update', [context.input.runId])).rowCount !== 1) {
    throw new DomainError('RUN_NOT_FOUND', 'The exact Stop Run was not found.', 404)
  }
  const opened = await openWorkflowLifecycleLocked(sql, context.input.runId)
  await context.authorizeLocked(sql)
  beforeGraphCommit(sql, () => context.authorizeLocked(sql))
  if (context.run.id !== context.input.runId || context.run.workspaceId !== context.input.workspaceId
    || opened.snapshot.run.id !== context.run.id
    || !sameRepeatValue(immutableWorkflowRunPins(opened.snapshot.run), immutableWorkflowRunPins(context.run))) return conflict()
  return opened
}

/** B already holds its dedicated command advisory lock and owns the management
 * receipt/audit. This helper must NOT reacquire that lock or write a second
 * management receipt. Its command-specific intent bridges a crash after the
 * negative G1 COMMIT and before B's final receipt COMMIT. */
export async function admitWorkflowStopIntent(pool: pg.Pool, supplied: CurrentStopContext): Promise<StopIntent> {
  const context = { ...supplied, input: structuredClone(supplied.input), run: structuredClone(supplied.run) }
  const requestHash = commandInputHash(context.input)
  return withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    const opened = await lockStopRun(sql, context)
    // Intents are immutable; the command and Run locks already serialize admission.
    const row = (await sql.query<{ record: StopIntent; source_id: string; source_digest: string }>(
      'select record,source_id,source_digest from workflow_stop_intents where principal_id=$1 and command_id=$2',
      [context.principal.id, context.input.commandId])).rows[0]
    if (row) {
      const stored = row.record
      if (intentEvidence(stored).sourceId !== row.source_id || graphSourceDigest(stored) !== row.source_digest || stored.requestHash !== requestHash
        || stored.principalId !== context.principal.id || stored.commandId !== context.input.commandId
        || stored.runId !== context.input.runId || stored.workspaceId !== context.input.workspaceId
        || !sameRepeatValue(stored.pins, immutableWorkflowRunPins(opened.snapshot.run))
        || stored.receipt.runId !== stored.runId || stored.receipt.processStopped !== false
        || !['accepted', 'already_terminal'].includes(stored.receipt.status)) return conflict()
      if (stored.receipt.status === 'accepted' && !opened.snapshot.stopRequested) return uncertain('WORKFLOW_STOP_INTENT_CONFLICT')
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: opened.publication.scope,
        evidence: intentEvidence(stored), sourceDigest: row.source_digest, effect: null })
      return structuredClone(stored)
    }
    const status = await requestWorkflowStopLocked(sql, context.input.runId,
      (transaction) => context.authorizeLocked(transaction), opened)
    const record: StopIntent = { principalId: context.principal.id, commandId: context.input.commandId,
      workspaceId: context.input.workspaceId, runId: context.input.runId, requestHash,
      source: context.source, pins: immutableWorkflowRunPins(opened.snapshot.run),
      receipt: { runId: context.input.runId, status, processStopped: false } }
    const recordJson = canonicalGraphJson(record)
    const evidence = intentEvidence(record), sourceDigest = graphSourceDigest(record)
    // The fact is read from the locked durable state, not invented from the Stop
    // request. This source is intent evidence only, never physical closure.
    const state = await readPublicRunStateLocked(sql, opened.publication.scope)
    const changed = await opened.publication.source({ evidence, sourceDigest, facts: [{ type: 'run.state', state }] },
      async () => {
        const inserted = await sql.query(`insert into workflow_stop_intents
          (principal_id,command_id,workspace_id,run_id,request_hash,source_digest,record,record_json,source_id)
          values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text,$9)`, [record.principalId, record.commandId,
          record.workspaceId, record.runId, requestHash, sourceDigest, recordJson, recordJson, evidence.sourceId])
        if (inserted.rowCount !== 1) return conflict()
      })
    if (changed.replayed) return conflict() // no intent row, but a receipt: corruption, not recovery
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: opened.publication.scope, evidence, sourceDigest, effect: null })
    return record
  }))
}

/** No native work occurs in G1. The existing engine drains its original native
 * lifetimes, then a new owner transaction verifies positive settlement. Unknown
 * COMMIT/closure/ownership throws without writing B's successful receipt. Exact
 * retry reads the same intent and continues cleanup, never submits a new Stop. */
export async function stopCurrentWorkflow(pool: pg.Pool, runs: PostgresRunRepository,
  engine: LangGraphWorkflowEngine, context: CurrentStopContext): Promise<CurrentStopReceipt> {
  try {
    return await completeWorkflowStop(pool, runs, engine, context)
  } catch (error) {
    if (error instanceof DomainError) throw error
    const failure = new DomainError('WORKFLOW_STOP_SETTLEMENT_PENDING',
      'Stop could not confirm cleanup. Retry with the same command ID and input.', 409, { retryable: true })
    failure.cause = error
    throw failure
  }
}

async function completeWorkflowStop(pool: pg.Pool, runs: PostgresRunRepository,
  engine: LangGraphWorkflowEngine, context: CurrentStopContext): Promise<CurrentStopReceipt> {
  const intent = await admitWorkflowStopIntent(pool, context)
  if (!await engine.cancel(intent.runId)) return uncertain()
  const owner = await runs.acquireOwnership(intent.runId, () => undefined)
  if (!owner) return uncertain('WORKFLOW_STOP_OWNER_UNCERTAIN')
  try {
    await owner.oneShotConnection().transaction(async (sql) => {
      const { publication, snapshot } = await lockStopRun(sql, context)
      if (snapshot.run.executionState !== 'completed' || snapshot.cleanupPending
        || intent.receipt.status === 'accepted' && !snapshot.stopRequested) return uncertain()
      const verify = async () => {
        owner.assertOwned()
        await assertWorkflowRunSettlementLocked(sql, snapshot.run, owner,
          snapshot.run.outcome === 'succeeded' && !snapshot.stopRequested ? 'success' : 'cleanup')
      }
      await verify()
      beforeGraphCommit(sql, verify)
      const source = await readRepeatRunSourceLocked(sql, publication.scope)
      if (!source.replayed || !sameRepeatValue(source.run, snapshot.run)) return uncertain('WORKFLOW_STOP_PUBLICATION_UNCERTAIN')
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: publication.scope, evidence: source.evidence,
        sourceDigest: source.sourceDigest, semanticDigest: source.semanticDigest, effect: null })
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: publication.scope, evidence: intentEvidence(intent),
        sourceDigest: graphSourceDigest(intent), effect: null })
    })
    return structuredClone(intent.receipt)
  } finally { await owner.release() }
}

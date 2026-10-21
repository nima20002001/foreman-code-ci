import { graphSourceDigest } from './graphDigest.js'
import type { PublicProjectionReader } from './publicProjectionReader.js'
import { timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import { readPublicRunStateLocked } from './publicRunState.js'
import { capturePublicProjectionLocked, assertPublicProjectionUnchangedLocked, assertPublicProjectionCommittedLocked } from './publicProjectionReceipt.js'
import { randomUUID } from 'node:crypto'
import {
  canonicalGraphJson, graphJsonBytes, sameGraphScope, GraphDigestSchema, GraphEvidenceSchema, GraphFactSchema,
  RUN_GRAPH_LIMITS, RunGraphScopeSchema,
  GraphEffectSchema, GraphEffectFenceSchema, assertGraphEffectAuthority, RunGraphErrorCodeSchema,
  type GraphEffect, type GraphEffectFence, type GraphEffectAccessState, type GraphEffectIdentity,
  type GraphEvidence, type GraphFact, type RunGraphEvent, type RunGraphScope,
  CanonicalRunGraphScopeSchema, sameCanonicalGraphScope, RepeatGraphScopeV3Schema,
  RepeatGraphFactV3Schema, RepeatGraphEffectV3Schema, RepeatGraphEventContentV3Schema, RepeatGraphBatchV3Schema,
  assertRepeatGraphFactScope,
  GraphSequenceSchema, AcceptedWorkflowRunV3Schema,
  type AcceptedWorkflowRunV3, type RepeatGraphScopeV3, type RepeatGraphBatchV3,
  type CanonicalRunGraphScope, type RepeatGraphFactV3,
  type RepeatGraphEventV3, type RepeatGraphEffectV3,
} from '@foreman-code/contracts/wave25'
import {
  assertGraphTransaction, beforeGraphCommit, beforeGraphCommitChecks, didGraphTransactionCommit, poisonGraphTransaction,
  type ExclusiveGraphConnection, type GraphTransactionSql,
} from './connection.js'
import { activeNativeBatch, memoizeNativeRead, nativeCommitCollect, seedNativeRead } from './nativeBatch.js'
import { RunGraphError } from './errors.js'
import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import { workflowJobGraphSourceChangesLocked } from './workflowJobProjection.js'
import { componentLogger } from '../diagnostics/logger.js'
import { ZodError } from 'zod'

export { graphSourceDigest } from './graphDigest.js'

function throwPublicationFailure(error: unknown, runId: string): never {
  if (error instanceof RunGraphError || error instanceof DomainError) throw error
  componentLogger('engine').error({ err: error, runId, operation: 'publish run graph' },
    'Run graph publication failed')
  if (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT') {
    throw new RunGraphError('GRAPH_TRANSACTION_LIMIT', { cause: error })
  }
  if (error instanceof ZodError) throw new RunGraphError('GRAPH_INVALID_FACT', { cause: error })
  throw error
}

/** Digest-only receipt for the complete ordered envelope, in the EXISTING
 * source table. Per-source digests alone cannot prove source-group ordering.
 * This reserved source never emits another event or allocates another counter.
 */
export function repeatGraphBatchReceipt(batch: Pick<RepeatGraphBatchV3,
  'protocolVersion' | 'scope' | 'batchId' | 'previousSequence' | 'sequence' | 'events'>) {
  const digest = graphSourceDigest(batch)
  return { evidence: { sourceKind: 'run' as const, sourceId: `repeat-batch:${batch.batchId}`, sourceRevision: '1' },
    sourceDigest: digest, semanticDigest: digest }
}

/** Exact private Run readback. Public state is deliberately a three-field
 * whitelist. The source revision uses the existing complete-batch head, never
 * a new counter. Reusing a historical state after an intervening transition
 * therefore cannot be mistaken for a duplicate source.
 */
export async function readRepeatRunSourceLocked(sql: GraphTransactionSql, input: RepeatGraphScopeV3) {
  assertGraphTransaction(sql)
  const scope = RepeatGraphScopeV3Schema.parse(input)
  const row = (await sql.query<{ record: unknown; workspace_id: string; workflow_id: string; workflow_version_id: string;
    execution_state: string; stopped: boolean; written_here: boolean; created_here: boolean }>(
    `select record,workspace_id,workflow_id,workflow_version_id,execution_state,stop_requested_at is not null as stopped,
       xmin=pg_current_xact_id_if_assigned()::xid as written_here,
       created_at=transaction_timestamp() as created_here from runs where id=$1`, [scope.runId])).rows[0]
  if (!row) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  const run = AcceptedWorkflowRunV3Schema.parse(row.record)
  if (row.workspace_id !== scope.workspaceId || row.workflow_id !== scope.workflowId || row.workflow_version_id !== scope.workflowVersionId
    || run.id !== scope.runId || run.workspaceId !== scope.workspaceId || run.workflowId !== scope.workflowId
    || run.workflowVersionId !== scope.workflowVersionId || run.executionState !== row.execution_state) {
    throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
  }
  const state = await readPublicRunStateLocked(sql, scope)
  const fact = RepeatGraphFactV3Schema.parse({ type: 'repeat.run.state', state })
  const semanticDigest = graphSourceDigest([fact])
  const sourceDigest = graphSourceDigest({ scope, record: run, state })
  const head = (await sql.query<{ head_sequence: string; source_revision: string | null;
    source_digest: string | null; semantic_digest: string | null; first_sequence: string | null }>(`
    select h.head_sequence::text,latest.source_revision,latest.source_digest,latest.semantic_digest,latest.first_sequence
    from run_graph_heads h left join lateral (
      select s.source_revision::text,s.source_digest,s.semantic_digest,s.first_sequence::text
      from run_graph_sources s where s.run_id=h.run_id and s.source_kind='run' and s.source_id=h.run_id
      order by s.source_revision desc limit 1
    ) latest on true where h.run_id=$1`, [scope.runId])).rows[0]
  if (!head) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
  GraphSequenceSchema.parse(head.head_sequence)
  const latest = head.source_revision === null ? undefined : { source_revision: head.source_revision,
    source_digest: head.source_digest!, semantic_digest: head.semantic_digest!, first_sequence: head.first_sequence! }
  if (!latest && head.head_sequence !== '0') throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  if (latest && (!GraphSequenceSchema.safeParse(latest.source_revision).success
    || !GraphSequenceSchema.safeParse(latest.first_sequence).success || BigInt(latest.first_sequence) < 1n
    || BigInt(latest.first_sequence) > BigInt(head.head_sequence)
    || (latest.source_revision === '0' ? latest.first_sequence !== '1' : latest.source_revision !== latest.first_sequence))) {
    throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  }
  const baseline = latest?.source_revision === '0' && run.executionState === 'queued' && run.outcome === 'pending' && !row.stopped
    && latest.source_digest === graphSourceDigest(run)
  const replayed = Boolean(latest && latest.semantic_digest === semanticDigest && (baseline || latest.source_digest === sourceDigest))
  const revision = replayed ? latest!.source_revision : String(BigInt(head.head_sequence) + 1n)
  if (!GraphSequenceSchema.safeParse(revision).success) throw new RunGraphError('GRAPH_SEQUENCE_EXHAUSTED')
  return { run, stopped: row.stopped, writtenHere: row.written_here === true, createdHere: row.created_here === true,
    head: head.head_sequence, fact, semanticDigest, replayed,
    evidence: { sourceKind: 'run' as const, sourceId: scope.runId, sourceRevision: revision },
    sourceDigest: replayed ? latest!.source_digest : sourceDigest }
}

export interface RetainSourceRow { proof_id: string; record: unknown; source_digest: string;
  saved_digest: string | null; semantic_digest: string | null; sequence: string }
function retainRowKey(runId: string, proofId: string): string { return `retain-row:${runId}:${proofId}` }

async function queryRetainRows(sql: GraphTransactionSql, runId: string, proofIds: readonly string[]): Promise<Map<string, RetainSourceRow>> {
  const rows = await sql.query<RetainSourceRow>(
    `select p.proof_id,p.record,p.source_digest,s.source_digest as saved_digest,s.semantic_digest,
      h.head_sequence::text as sequence from workflow_native_proofs p
      join run_graph_heads h on h.run_id=p.run_id
      left join run_graph_sources s on s.run_id=p.run_id and s.source_kind='native_event'
        and s.source_id=p.proof_id and s.source_revision=1
      where p.run_id=$1 and p.proof_id=any($2::text[]) for share of p`, [runId, [...proofIds]])
  return new Map(rows.rows.map((row) => [row.proof_id, row]))
}

/** Once per group, after its proofs are persisted: the retention rows for every proof, locked for share. */
export async function seedRetainRows(sql: GraphTransactionSql, runId: string, proofIds: readonly string[]): Promise<void> {
  const rows = await queryRetainRows(sql, runId, proofIds)
  for (const proofId of proofIds) seedNativeRead(sql, retainRowKey(runId, proofId), rows.get(proofId) ?? null)
}

/** Retained-source rows: the group's seeded rows when present, otherwise one locked read. */
async function readRetainRows(sql: GraphTransactionSql, runId: string, proofIds: readonly string[]): Promise<Map<string, RetainSourceRow>> {
  const batch = activeNativeBatch(sql)
  if (batch && proofIds.every((proofId) => batch.reads.has(retainRowKey(runId, proofId)))) {
    const rows = await Promise.all(proofIds.map((proofId) => batch.reads.get(retainRowKey(runId, proofId))!))
    return new Map(rows.filter((row): row is RetainSourceRow => row !== null).map((row) => [row.proof_id, row]))
  }
  return queryRetainRows(sql, runId, proofIds)
}

export function graphSourceRowKey(runId: string, sourceKind: string, sourceId: string, sourceRevision: string): string {
  return `graph-source:${runId}:${sourceKind}:${sourceId}:${sourceRevision}`
}

/** The persisted source row, read once per batch; staged sources are checked by the caller first. */
export function readGraphSourceRow(sql: GraphTransactionSql, runId: string, sourceKind: string, sourceId: string,
  sourceRevision: string): Promise<{ source_digest: string; semantic_digest: string } | undefined> {
  return memoizeNativeRead(sql, graphSourceRowKey(runId, sourceKind, sourceId, sourceRevision), async () => (await sql.query<{
    source_digest: string; semantic_digest: string }>(
    `select source_digest,semantic_digest from run_graph_sources
     where run_id=$1 and source_kind=$2 and source_id=$3 and source_revision=$4::bigint`,
    [runId, sourceKind, sourceId, sourceRevision])).rows[0])
}

export interface GraphSourceChange {
  evidence: GraphEvidence
  /** Hash the immutable source fact INCLUDING private fields; never send those fields to the journal. */
  sourceDigest: string
  facts: readonly GraphFact[]
}
export interface GraphEffectGuard {
  expected: GraphEffectFence
  /** SQL-only: lock/read the EXISTING authority in the frozen lock order until COMMIT.
   * Return exact scope/subject/session binding, live owner/fence/generation and
   * qualified security. Cached snapshots or echoing expected is NOT an implementation.
   */
  readCurrentLocked(sql: GraphTransactionSql, scope: RunGraphScope, effect: GraphEffectIdentity): Promise<GraphEffectAccessState>
}
export interface GraphEffectChange extends GraphSourceChange { effect: GraphEffect }
interface StagedEffect { effect: GraphEffect | RepeatGraphEffectV3; semanticDigest: string }
interface StagedSource {
  evidence: GraphEvidence; sourceDigest: string; semanticDigest: string; events: (RunGraphEvent | RepeatGraphEventV3)[]
  /** Aliases of already committed effects point at their original publication. */
  firstSequence?: string
}
export interface GraphPublicationReceipt {
  sequence: string | null
  batchId: string | null
  kind: 'none' | 'events' | 'reset'
}
const publications = new WeakMap<GraphTransactionSql, Map<string, RunGraphPublication<CanonicalRunGraphScope>>>()
const constructionKey = Symbol('RunGraphPublication')

/** Domain producers for each Run share one finalized batch on the transaction. */
export interface RepeatGraphSourceChange {
  evidence: GraphEvidence
  sourceDigest: string
  effect: RepeatGraphEffectV3 | null
}

export class RunGraphPublication<S extends CanonicalRunGraphScope = RunGraphScope> {
  readonly sql: GraphTransactionSql
  readonly scope: S
  readonly #hasJobNodes: boolean
  readonly #sources = new Map<string, StagedSource>()
  readonly #effects = new Map<string, StagedEffect>()
  #bytes = 0
  #busy = false
  #admissionOnly = false
  readonly #ownerCommitChecks = new WeakMap<RunOwnership, (expected: readonly { ownerId: string; fence: string }[]) => Promise<void>>()
  #finalized = false
  #receipt: GraphPublicationReceipt = { sequence: null, batchId: null, kind: 'none' }
  constructor(key: symbol, sql: GraphTransactionSql, scope: S, version: { hasJobNodes: boolean },
    private readonly readPublicProjection: PublicProjectionReader) {
    if (key !== constructionKey) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
    this.sql = sql
    this.scope = Object.freeze({ ...scope })
    this.#hasJobNodes = version.hasJobNodes
    beforeGraphCommit(sql, () => timeRuntimeOperation('db', 'graph.finalize', () => this.finalize(),
      { runId: this.scope.runId }))
  }
  /** Source/projection bookkeeping; grants no authority for a workflow effect.
   * Exact duplicate sources do not call mutate; conflicts poison the transaction. */
  async source<T>(input: GraphSourceChange, mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    return this.change(input, undefined, mutate)
  }
  /** Persisted workflow effects use BOTH source and stable effect deduplication.
   * This records database effects/intents, never performs a network/native write.
   */
  async effect<T>(input: GraphEffectChange, guard: GraphEffectGuard, mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    return this.change(input, { effect: input.effect, guard }, mutate)
  }
  private async change<T>(input: GraphSourceChange, guarded: { effect: GraphEffect; guard: GraphEffectGuard } | undefined,
    mutate: (sql: GraphTransactionSql) => Promise<T>): Promise<{ replayed: true } | { replayed: false; value: T }> {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      if (this.#finalized) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true
      entered = true
      const currentScope = RunGraphScopeSchema.parse(this.scope)
      if (!guarded && Object.prototype.hasOwnProperty.call(input, 'effect')) throw new RunGraphError('GRAPH_INVALID_FACT')
      if (guarded && this.scope.executionSemanticsVersion !== 3) throw new RunGraphError('GRAPH_EFFECT_ACCESS_DENIED')
      const evidence = GraphEvidenceSchema.parse(input.evidence)
      const sourceDigest = GraphDigestSchema.parse(input.sourceDigest)
      // Bound before parsing/retaining large arrays. Facts may exceed a wire event,
      // in which case finalization writes a reset barrier, not a partial batch.
      canonicalGraphJson(input.facts, RUN_GRAPH_LIMITS.transactionBytes)
      if (!input.facts.length) throw new RunGraphError('GRAPH_INVALID_FACT')
      const facts = input.facts.map((fact) => GraphFactSchema.parse(fact))
      const effect = guarded ? GraphEffectSchema.parse(guarded.effect) : undefined
      const semanticDigest = graphSourceDigest(effect ? { effect, facts } : facts)
      const events = facts.map((fact) => RepeatGraphEventContentV3Schema.parse({ eventId: randomUUID(), evidence,
        sourceDigest, semanticDigest, effect: effect ?? null, fact }))
      const key = canonicalGraphJson(evidence)
      const staged = this.#sources.get(key)
      if (staged) {
        this.assertSame(staged, sourceDigest, semanticDigest)
        return { replayed: true }
      }
      const existing = await readGraphSourceRow(this.sql, this.scope.runId, evidence.sourceKind, evidence.sourceId, evidence.sourceRevision)
      if (existing) {
        this.assertSame({ sourceDigest: existing.source_digest, semanticDigest: existing.semantic_digest }, sourceDigest, semanticDigest)
        return { replayed: true }
      }
      const bytes = Buffer.byteLength(canonicalGraphJson({ evidence, sourceDigest, semanticDigest, events }, RUN_GRAPH_LIMITS.transactionBytes))
      if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
      if (effect) {
        const effectKey = canonicalGraphJson(effect.identity)
        const stagedEffect = this.#effects.get(effectKey)
        const saved = stagedEffect ? undefined : (await this.sql.query<{
          effect_digest: string; semantic_digest: string; first_sequence: string
        }>(`select effect_digest,semantic_digest,first_sequence::text from run_graph_effects
            where run_id=$1 and effect_kind=$2 and entity_id=$3`,
          [this.scope.runId, effect.identity.kind, effect.identity.entityId])).rows[0]
        if (stagedEffect || saved) {
          if ((stagedEffect?.effect.digest ?? saved!.effect_digest) !== effect.digest
            || (stagedEffect?.semanticDigest ?? saved!.semantic_digest) !== semanticDigest) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
          // A new observation of the same effect is an alias, NOT a second effect
          // or public cursor. Bind its source digest without replaying mutate.
          this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events: [],
            ...(saved ? { firstSequence: saved.first_sequence } : {}) })
          this.#bytes += bytes
          return { replayed: true }
        }
        if (!guarded?.guard || typeof guarded.guard.readCurrentLocked !== 'function') throw new RunGraphError('GRAPH_AUTHORITY_INVALID')
        const expected = GraphEffectFenceSchema.parse(guarded.guard.expected)
        if (!sameGraphScope(expected.scope, currentScope) || canonicalGraphJson(expected.effect) !== effectKey || expected.effectDigest !== effect.digest) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        // Parent Run already locked by openRunGraphPublication. Never use cleanup
        // as Stop or trust a caller-supplied terminal flag for this parent fence.
        const run = (await this.sql.query<{ execution_state: string; stopped: boolean }>(
          'select execution_state,stop_requested_at is not null as stopped from runs where id=$1', [this.scope.runId])).rows[0]
        if (!run) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        if (!['review.settle', 'run.stop'].includes(effect.identity.kind)) {
          if (run.stopped) throw new RunGraphError('GRAPH_STOP_CONFLICT')
          if (['completed', 'interrupted'].includes(run.execution_state)) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
        }
        assertGraphEffectAuthority(expected, await guarded.guard.readCurrentLocked(this.sql, currentScope, effect.identity))
        if (effect.identity.kind === 'run.stop') {
          if (effect.identity.entityId !== this.scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
          if (!facts.some((fact) => fact.type === 'run.state' && fact.state.stopRequested === true)) throw new RunGraphError('GRAPH_INVALID_FACT')
          await this.sql.query('update runs set stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) where id=$1', [this.scope.runId])
        }
      }
      const value = await mutate(this.sql)
      assertGraphTransaction(this.sql)
      if (effect && facts.some((fact) => fact.type === 'run.state')) {
        const persisted = (await this.sql.query<{ execution_state: string; outcome: string; stopped: boolean }>(
          "select execution_state,record->>'outcome' as outcome,stop_requested_at is not null as stopped from runs where id=$1",
          [this.scope.runId])).rows[0]
        if (!persisted || facts.some((fact) => fact.type === 'run.state' && (
          fact.state.executionState !== persisted.execution_state || fact.state.outcome !== persisted.outcome
          || fact.state.stopRequested !== persisted.stopped))) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
      if (effect) this.#effects.set(canonicalGraphJson(effect.identity), { effect, semanticDigest })
      this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events })
      this.#bytes += bytes
      return { replayed: false, value }
    } catch (error) {
      poisonGraphTransaction(this.sql)
      if (error instanceof RunGraphError || error instanceof DomainError) throw error
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'PGR01') throw new RunGraphError('GRAPH_STOP_CONFLICT', { cause: error })
        if (error.code === 'PGR02') throw new RunGraphError('GRAPH_TERMINAL_CONFLICT', { cause: error })
      }
      const code = RunGraphErrorCodeSchema.safeParse(error instanceof Error ? error.message : undefined)
      if (code.success) throw new RunGraphError(code.data, { cause: error })
      return throwPublicationFailure(error, this.scope.runId)
    } finally { if (entered) this.#busy = false }
  }
  /** Verify a source already staged by this branded G1 or durably committed.
   * This grants no mutation permission; it allows atomic downstream consumers
   * to verify a producer before G1's single finalizer writes journal receipts. */
  async assertSourceEnlisted(evidenceInput: GraphEvidence, sourceDigest: string, semanticDigest: string): Promise<void> {
    assertGraphTransaction(this.sql)
    const evidence = GraphEvidenceSchema.parse(evidenceInput)
    GraphDigestSchema.parse(sourceDigest); GraphDigestSchema.parse(semanticDigest)
    const staged = this.#sources.get(canonicalGraphJson(evidence))
    if (staged) { this.assertSame(staged, sourceDigest, semanticDigest); return }
    const row = (await this.sql.query<{ source_digest: string; semantic_digest: string; first_sequence: string; head: string }>(
      `select s.source_digest,s.semantic_digest,s.first_sequence::text,h.head_sequence::text as head
       from run_graph_sources s join run_graph_heads h on h.run_id=s.run_id where s.run_id=$1
        and s.source_kind=$2 and s.source_id=$3 and s.source_revision=$4::bigint`,
      [this.scope.runId, evidence.sourceKind, evidence.sourceId, evidence.sourceRevision])).rows[0]
    if (!row || BigInt(GraphSequenceSchema.parse(row.first_sequence)) < 1n
      || BigInt(row.first_sequence) > BigInt(GraphSequenceSchema.parse(row.head))) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    this.assertSame({ sourceDigest: row.source_digest, semanticDigest: row.semantic_digest }, sourceDigest, semanticDigest)
  }

  /** Retain a coordinator-authenticated ORIGINAL native source even when the
   * provider event has no public activity change. Read the actual immutable row
   * in this G1 transaction; there is no caller facts/authority/mutation callback.
   * A source-only receipt anchors to the existing committed cut and does not
   * fabricate a cursor advance, a result, native activity or acknowledgement. */
  async retainNativeSource(owner: RunOwnership, proofId: string) {
    const [receipt] = await this.retainNativeSources(owner, [proofId])
    return receipt!
  }

  async retainNativeSources(owner: RunOwnership, proofIds: readonly string[]): Promise<Array<{
    evidence: GraphEvidence; sourceDigest: string; semanticDigest: string
  }>> {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      if (this.#finalized || this.#admissionOnly) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true
      entered = true
      owner.assertOwned()
      if (owner.runId !== this.scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      const fence = await owner.readOneShotFence(this.sql)
      const originals = await readRetainRows(this.sql, owner.runId, proofIds)
      const receipts = proofIds.map((proofId) => {
        const row = originals.get(proofId)
        if (!row || graphSourceDigest(row.record) !== row.source_digest) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        const evidence = GraphEvidenceSchema.parse({ sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' })
        const sourceDigest = GraphDigestSchema.parse(row.source_digest)
        const semanticDigest = graphSourceDigest({ evidence, facts: [], effect: null })
        const key = canonicalGraphJson(evidence)
        const staged = this.#sources.get(key)
        if (staged || row.saved_digest !== null) {
          this.assertSame(staged ?? { sourceDigest: row.saved_digest!, semanticDigest: row.semantic_digest! },
            sourceDigest, semanticDigest)
        } else {
          if (BigInt(GraphSequenceSchema.parse(row.sequence)) < 1n) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
          const bytes = graphJsonBytes({ evidence, sourceDigest, semanticDigest })
          if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources
            || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
          this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events: [], firstSequence: row.sequence })
          this.#bytes += bytes
        }
        return { evidence, sourceDigest, semanticDigest }
      })
      // Every retained call shares one live COMMIT read; each call's receipts and fence are still verified.
      nativeCommitCollect(this.sql, 'retained-native-sources', { owner, fence, proofIds, receipts }, async (checks) => {
        owner.assertOwned()
        const current = await owner.readOneShotFence(this.sql)
        const latest = await this.sql.query<{ proof_id: string; record: unknown; source_digest: string }>(
          'select proof_id,record,source_digest from workflow_native_proofs where run_id=$1 and proof_id=any($2::text[])',
          [owner.runId, [...new Set(checks.flatMap((check) => check.proofIds))]])
        const persisted = new Map(latest.rows.map((row) => [row.proof_id, row]))
        for (const check of checks) {
          if (current.ownerId !== check.fence.ownerId || current.fence !== check.fence.fence
            || check.receipts.some(({ evidence, sourceDigest }) => {
              const row = persisted.get(evidence.sourceId)
              return !row || row.source_digest !== sourceDigest || graphSourceDigest(row.record) !== sourceDigest
            })) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        }
      })
      return receipts
    } catch (error) { poisonGraphTransaction(this.sql); throw error }
    finally { if (entered) this.#busy = false }
  }

  /** Same journal, exact reviewer lease instead of the workflow drive owner.
   * This retains only a verifier-produced immutable reviewer source row. */
  async retainReviewSource(jobId: string, token: string, proofId: string): Promise<{
    evidence: GraphEvidence; sourceDigest: string; semanticDigest: string
  }> {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      if (this.#finalized || this.#admissionOnly) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true; entered = true
      const lease = async () => {
        const row = (await this.sql.query<{ fence: string; live: boolean }>(`select j.lease_fence::text as fence,
          coalesce(j.lease_expires_at>clock_timestamp(),false) as live from review_jobs j
          join harness_executions e on e.id=j.execution_id
          where j.id=$1 and j.lease_token=$2 and e.run_id=$3 for update of j`, [jobId, token, this.scope.runId])).rows[0]
        if (!row?.live) throw new RunGraphError('GRAPH_OWNER_LOST')
        return row.fence
      }
      const fence = await lease()
      const row = (await this.sql.query<{ record: unknown; source_digest: string }>(
        'select record,source_digest from review_native_proofs where proof_id=$1 and run_id=$2 and job_id=$3 for share',
        [proofId, this.scope.runId, jobId])).rows[0]
      if (!row || graphSourceDigest(row.record) !== row.source_digest) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      const evidence = GraphEvidenceSchema.parse({ sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' })
      const sourceDigest = GraphDigestSchema.parse(row.source_digest)
      const semanticDigest = graphSourceDigest({ evidence, facts: [], effect: null })
      const key = canonicalGraphJson(evidence), staged = this.#sources.get(key)
      const saved = staged ? undefined : (await this.sql.query<{ source_digest: string; semantic_digest: string }>(
        `select source_digest,semantic_digest from run_graph_sources where run_id=$1
         and source_kind='native_event' and source_id=$2 and source_revision=1`, [this.scope.runId, proofId])).rows[0]
      if (staged || saved) this.assertSame(staged ?? { sourceDigest: saved!.source_digest,
        semanticDigest: saved!.semantic_digest }, sourceDigest, semanticDigest)
      else {
        const head = (await this.sql.query<{ sequence: string }>(
          'select head_sequence::text as sequence from run_graph_heads where run_id=$1', [this.scope.runId])).rows[0]
        if (!head || BigInt(GraphSequenceSchema.parse(head.sequence)) < 1n) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
        const bytes = graphJsonBytes({ evidence, sourceDigest, semanticDigest })
        if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) {
          throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
        }
        this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events: [], firstSequence: head.sequence })
        this.#bytes += bytes
      }
      beforeGraphCommit(this.sql, async () => {
        const current = await lease()
        const latest = (await this.sql.query<{ record: unknown; source_digest: string }>(
          'select record,source_digest from review_native_proofs where proof_id=$1 and run_id=$2 and job_id=$3', [proofId, this.scope.runId, jobId])).rows[0]
        if (current !== fence || !latest
          || latest.source_digest !== sourceDigest || graphSourceDigest(latest.record) !== sourceDigest) {
          throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        }
      })
      return { evidence, sourceDigest, semanticDigest }
    } catch (error) { poisonGraphTransaction(this.sql); throw error }
    finally { if (entered) this.#busy = false }
  }

  /** V3 owner mutation and post-mutation metadata projection in the SAME journal.
   * Private rows (notably input bindings) do not exist before mutate. No native
   * I/O belongs here. Exact duplicates project immutable metadata but never call
   * mutate; N1 additionally requires exactly one mutation on its fresh path.
   * Source-only run readback is deliberately separate: it grants no mutation.
   */
  async repeatChange<T>(input: RepeatGraphSourceChange, owner: RunOwnership,
    mutate: (sql: GraphTransactionSql) => Promise<T>,
    projectLocked: (sql: GraphTransactionSql) => Promise<readonly RepeatGraphFactV3[]>,
  ): Promise<{ replayed: boolean; semanticDigest: string; value?: T }> {
    return this.repeatChangeInternal(input, owner, mutate, projectLocked, 'progress')
  }

  /** Enlist the already authorized Run writer's exact SQL state. This method
   * cannot mutate a Run, request Stop, launch work or waive native settlement. */
  async repeatRunReadback(input: Omit<RepeatGraphSourceChange, 'effect'>, owner: RunOwnership,
    projectLocked: (sql: GraphTransactionSql) => Promise<readonly RepeatGraphFactV3[]>,
  ): Promise<{ replayed: boolean; semanticDigest: string }> {
    return this.repeatChangeInternal({ ...input, effect: null }, owner, async () => undefined, projectLocked, 'run_readback')
  }

  /** Exact native observation writes are authorized by the existing N1/N2 host.
   * After Stop/terminal only terminal execution metadata may be enlisted. This
   * does not accept a business result, route work, or create a launch permit. */
  async repeatObservation<T>(input: Omit<RepeatGraphSourceChange, 'effect'>, owner: RunOwnership,
    mutate: (sql: GraphTransactionSql) => Promise<T>,
    projectLocked: (sql: GraphTransactionSql) => Promise<readonly RepeatGraphFactV3[]>,
  ): Promise<{ replayed: boolean; semanticDigest: string; value?: T }> {
    return this.repeatChangeInternal({ ...input, effect: null }, owner, mutate, projectLocked, 'native_evidence')
  }

  /** Only the actual newly INSERTed queued Run can establish from-admission
   * coverage. This readback cannot write a Run, enter a block or mint an owner.
   * The authorized Start caller still owns command/live-authority validation.
   */
  repeatInsertedRunReadback(run: AcceptedWorkflowRunV3) {
    return this.repeatSqlRunReadback(AcceptedWorkflowRunV3Schema.parse(JSON.parse(canonicalGraphJson(run))))
  }

  /** An ownerless authenticated Stop writer may enlist its actual same-tx SQL
   * Stop, never progress work. A retry of an already published Stop may only
   * verify its exact receipt. No mutation/authorization callback is accepted.
   */
  repeatStoppedRunReadback() { return this.repeatSqlRunReadback() }

  private async repeatSqlRunReadback(accepted?: AcceptedWorkflowRunV3) {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      if (this.#finalized) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true; entered = true
      const scope = RepeatGraphScopeV3Schema.parse(this.scope)
      if (this.#admissionOnly) throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
      const current = await readRepeatRunSourceLocked(this.sql, scope)
      const sameRecord = (run: AcceptedWorkflowRunV3) => canonicalGraphJson(run) === canonicalGraphJson(current.run)
      if (accepted) {
        if (!sameRecord(accepted) || !current.writtenHere || !current.createdHere || current.stopped
          || current.head !== '0' || this.#sources.size || accepted.executionState !== 'queued' || accepted.outcome !== 'pending'
          || accepted.startedAt !== undefined || accepted.finishedAt !== undefined || accepted.result !== undefined) {
          throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        }
        const empty = (await this.sql.query<{ empty: boolean }>(`select
          not exists(select 1 from harness_executions where run_id=$1)
          and not exists(select 1 from run_repeat_occurrences where run_id=$1)
          and not exists(select 1 from run_repeat_slots where run_id=$1)
          and not exists(select 1 from run_repeat_effects where run_id=$1)
          and not exists(select 1 from run_cleanup_intents where run_id=$1)
          and not exists(select 1 from run_graph_sources where run_id=$1)
          and not exists(select 1 from run_graph_effects where run_id=$1)
          and exists(select 1 from run_graph_heads where run_id=$1 and head_sequence=0
            and retention_floor=0 and history_coverage='from_admission') as empty`, [scope.runId])).rows[0]
        if (empty?.empty !== true) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        this.#admissionOnly = true
      } else if (!current.stopped || !current.replayed && !current.writtenHere) {
        throw new RunGraphError('GRAPH_STOP_CONFLICT')
      }
      const evidence = accepted ? { sourceKind: 'run' as const, sourceId: scope.runId, sourceRevision: '0' } : current.evidence
      const sourceDigest = accepted ? graphSourceDigest(accepted) : current.sourceDigest
      const semanticDigest = current.semanticDigest
      const key = canonicalGraphJson(evidence), staged = this.#sources.get(key)
      if (staged) this.assertSame(staged, sourceDigest, semanticDigest)
      const replayed = !accepted && current.replayed || Boolean(staged)
      if (!replayed) {
        const event = RepeatGraphEventContentV3Schema.parse({ eventId: randomUUID(), evidence, sourceDigest, semanticDigest,
          effect: null, fact: current.fact })
        const bytes = graphJsonBytes(event)
        if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) {
          throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
        }
        this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events: [event] }); this.#bytes += bytes
      }
      beforeGraphCommit(this.sql, async () => {
        const row = await readRepeatRunSourceLocked(this.sql, scope)
        if (!sameRecord(row.run) || row.stopped !== current.stopped || !row.replayed) {
          throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
        }
        if (accepted) {
          const children = await this.sql.query(`select 1 where
            exists(select 1 from harness_executions where run_id=$1)
            or exists(select 1 from run_repeat_occurrences where run_id=$1)
            or exists(select 1 from run_repeat_slots where run_id=$1)
            or exists(select 1 from run_repeat_effects where run_id=$1)
            or exists(select 1 from run_cleanup_intents where run_id=$1)`, [scope.runId])
          if (children.rowCount !== 0) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
        }
      })
      return { replayed, evidence, sourceDigest, semanticDigest }
    } catch (error) {
      poisonGraphTransaction(this.sql)
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    } finally { if (entered) this.#busy = false }
  }

  /** Read back the concrete N1 writer's physical execution metadata without
   * accepting a result, changing native state or granting another launch. */
  repeatExecutionReadback(input: Omit<RepeatGraphSourceChange, 'effect'>, owner: RunOwnership,
    projectLocked: (sql: GraphTransactionSql) => Promise<readonly RepeatGraphFactV3[]>,
  ) {
    return this.repeatChangeInternal({ ...input, effect: null }, owner, async () => undefined, projectLocked, 'native_evidence')
  }

  private async repeatChangeInternal<T>(input: RepeatGraphSourceChange, owner: RunOwnership,
    mutate: (sql: GraphTransactionSql) => Promise<T>,
    projectLocked: (sql: GraphTransactionSql) => Promise<readonly RepeatGraphFactV3[]>, mode: 'progress' | 'run_readback' | 'native_evidence',
  ): Promise<{ replayed: boolean; semanticDigest: string; value?: T }> {
    let entered = false
    try {
      assertGraphTransaction(this.sql)
      const scope = RepeatGraphScopeV3Schema.parse(this.scope)
      if (this.#admissionOnly) throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
      if (this.#finalized) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
      if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
      this.#busy = true; entered = true
      owner.assertOwned()
      if (owner.runId !== scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      const ownerFence = await owner.readOneShotFence(this.sql)
      const checkOwner = async () => {
        owner.assertOwned()
        if (canonicalGraphJson(await owner.readOneShotFence(this.sql)) !== canonicalGraphJson(ownerFence)) {
          throw new RunGraphError('GRAPH_OWNER_LOST')
        }
      }
      const evidence = GraphEvidenceSchema.parse(input.evidence)
      const sourceDigest = GraphDigestSchema.parse(input.sourceDigest)
      const effect = input.effect === null ? null : RepeatGraphEffectV3Schema.parse(input.effect)
      const runReadback = mode === 'run_readback'
      if (mode === 'native_evidence' && (evidence.sourceKind !== 'execution' || effect !== null)) throw new RunGraphError('GRAPH_INVALID_FACT')
      if (runReadback && (evidence.sourceKind !== 'run' || effect !== null)) throw new RunGraphError('GRAPH_INVALID_FACT')
      const key = canonicalGraphJson(evidence), effectKey = effect ? canonicalGraphJson(effect.identity) : null
      const staged = this.#sources.get(key)
      const saved = staged ? undefined : (await this.sql.query<{
        source_digest: string; semantic_digest: string; first_sequence: string
      }>(`select source_digest,semantic_digest,first_sequence::text from run_graph_sources
         where run_id=$1 and source_kind=$2 and source_id=$3 and source_revision=$4::bigint`,
      [scope.runId, evidence.sourceKind, evidence.sourceId, evidence.sourceRevision])).rows[0]
      const stagedEffect = effectKey ? this.#effects.get(effectKey) : undefined
      const savedEffect = !effect || stagedEffect ? undefined : (await this.sql.query<{
        effect_digest: string; semantic_digest: string; first_sequence: string
      }>(`select effect_digest,semantic_digest,first_sequence::text from run_graph_effects
         where run_id=$1 and effect_kind=$2 and entity_id=$3`,
      [scope.runId, effect.identity.kind, effect.identity.entityId])).rows[0]
      if ((staged && staged.sourceDigest !== sourceDigest) || (saved && saved.source_digest !== sourceDigest)) {
        throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      }
      if (effect && (stagedEffect || savedEffect)
        && (stagedEffect?.effect.digest ?? savedEffect!.effect_digest) !== effect.digest) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
      // A source with a missing effect is corruption, not permission to repair it.
      if (effect && (staged || saved) && !stagedEffect && !savedEffect) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
      const replayed = Boolean(staged || saved || stagedEffect || savedEffect)
      let value: T | undefined
      let terminalEvidenceOnly = false
      if (!replayed) {
        const run = (await this.sql.query<{ execution_state: string; stopped: boolean }>(
          'select execution_state,stop_requested_at is not null as stopped from runs where id=$1', [scope.runId])).rows[0]
        if (!run) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
        terminalEvidenceOnly = run.stopped || ['completed', 'interrupted'].includes(run.execution_state)
        if (mode === 'progress') {
          if (run.stopped) throw new RunGraphError('GRAPH_STOP_CONFLICT')
          if (['completed', 'interrupted'].includes(run.execution_state)) throw new RunGraphError('GRAPH_TERMINAL_CONFLICT')
        }
        if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
        value = await mutate(this.sql)
      }
      const projected = await projectLocked(this.sql)
      canonicalGraphJson(projected, RUN_GRAPH_LIMITS.transactionBytes)
      if (!projected.length && effect?.operation !== 'run.complete') throw new RunGraphError('GRAPH_INVALID_FACT')
      const facts = projected.map((fact) => RepeatGraphFactV3Schema.parse(fact))
      for (const fact of facts) assertRepeatGraphFactScope(scope, fact)
      if (mode === 'native_evidence' && (facts.length !== 1 || facts[0]!.type !== 'repeat.execution'
        || terminalEvidenceOnly && facts[0]!.execution.state !== 'completed')) throw new RunGraphError('GRAPH_STOP_CONFLICT')
      if (runReadback && (facts.length !== 1 || facts[0]!.type !== 'repeat.run.state')) throw new RunGraphError('GRAPH_INVALID_FACT')
      const runFacts = facts.filter((fact) => fact.type === 'repeat.run.state')
      if (runFacts.length) {
        const row = (await this.sql.query<{ execution_state: string; outcome: string; stopped: boolean }>(
          "select execution_state,record->>'outcome' as outcome,stop_requested_at is not null as stopped from runs where id=$1", [scope.runId])).rows[0]
        if (!row || runFacts.some(({ state }) => state.executionState !== row.execution_state
          || state.outcome !== row.outcome || state.stopRequested !== row.stopped)) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
      const semanticDigest = graphSourceDigest(effect ? { effect, facts } : facts)
      if (staged) this.assertSame(staged, sourceDigest, semanticDigest)
      if (saved) this.assertSame({ sourceDigest: saved.source_digest, semanticDigest: saved.semantic_digest }, sourceDigest, semanticDigest)
      if (effect && (stagedEffect || savedEffect)
        && (stagedEffect?.semanticDigest ?? savedEffect!.semantic_digest) !== semanticDigest) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
      if (saved && savedEffect && saved.first_sequence !== savedEffect.first_sequence) throw new RunGraphError('GRAPH_EFFECT_CONFLICT')
      if (!staged && !saved) {
        const events = (replayed ? [] : facts.map((fact) => RepeatGraphEventContentV3Schema.parse({
          eventId: randomUUID(), evidence, sourceDigest, semanticDigest, effect, fact,
        })))
        const bytes = Buffer.byteLength(canonicalGraphJson({ evidence, sourceDigest, semanticDigest, events }, RUN_GRAPH_LIMITS.transactionBytes))
        if (this.#sources.size >= RUN_GRAPH_LIMITS.transactionSources || this.#bytes + bytes > RUN_GRAPH_LIMITS.transactionBytes) {
          throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
        }
        this.#sources.set(key, { evidence, sourceDigest, semanticDigest, events,
          ...(savedEffect ? { firstSequence: savedEffect.first_sequence } : {}) })
        if (effect && !replayed) this.#effects.set(effectKey!, { effect, semanticDigest })
        this.#bytes += bytes
      }
      await checkOwner()
      // Registered after the existing publication finalizer. A caught owner
      // failure cannot commit either domain rows or the staged batch/receipts.
      let verifyCommit = this.#ownerCommitChecks.get(owner)
      if (!verifyCommit) {
        verifyCommit = async (expected) => {
          owner.assertOwned()
          const current = canonicalGraphJson(await owner.readOneShotFence(this.sql))
          if (expected.some((fence) => canonicalGraphJson(fence) !== current)) throw new RunGraphError('GRAPH_OWNER_LOST')
        }
        this.#ownerCommitChecks.set(owner, verifyCommit)
      }
      beforeGraphCommitChecks(this.sql, owner, ownerFence, verifyCommit)
      return { replayed, semanticDigest, ...(!replayed && value !== undefined ? { value } : {}) }
    } catch (error) {
      poisonGraphTransaction(this.sql)
      return throwPublicationFailure(error, this.scope.runId)
    } finally { if (entered) this.#busy = false }
  }
  private assertSame(existing: { sourceDigest: string; semanticDigest: string }, sourceDigest: string, semanticDigest: string) {
    if (existing.sourceDigest !== sourceDigest || existing.semanticDigest !== semanticDigest) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
  }
  /** Read only AFTER the owning connection's transaction promise resolves. */
  get receipt(): Readonly<GraphPublicationReceipt> {
    if (!didGraphTransactionCommit(this.sql)) throw new RunGraphError('GRAPH_TRANSACTION_CLOSED')
    return { ...this.#receipt }
  }
  private async finalize(): Promise<void> {
    assertGraphTransaction(this.sql)
    if (this.#busy) throw new RunGraphError('GRAPH_TRANSACTION_CONCURRENT')
    if (this.#finalized) return
    if (!this.#admissionOnly) {
      const current = await readRepeatRunSourceLocked(this.sql, this.scope)
      const key = canonicalGraphJson(current.evidence), staged = this.#sources.get(key)
      if (staged) this.assertSame(staged, current.sourceDigest, current.semanticDigest)
      else if (!current.replayed) this.#sources.set(key, { evidence: current.evidence,
        sourceDigest: current.sourceDigest, semanticDigest: current.semanticDigest,
        events: [RepeatGraphEventContentV3Schema.parse({ eventId: randomUUID(), evidence: current.evidence,
          sourceDigest: current.sourceDigest, semanticDigest: current.semanticDigest, effect: null, fact: current.fact })] })
      beforeGraphCommit(this.sql, async () => {
        const final = await readRepeatRunSourceLocked(this.sql, this.scope)
        if (!final.replayed || canonicalGraphJson(final.run) !== canonicalGraphJson(current.run)
          || canonicalGraphJson(final.fact) !== canonicalGraphJson(current.fact)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      })
    }
    const jobChanges = this.#hasJobNodes ? await workflowJobGraphSourceChangesLocked(this.sql, this.scope) : []
    for (const change of jobChanges) {
      const executionId = change.fact.execution.identity.executionId
      const published = [...this.#sources.values()].some(source => source.events.some(({ fact }) => {
        if (fact.type === 'repeat.execution') return fact.execution.identity.executionId === executionId
        return fact.type === 'node.state' && fact.state.execution?.executionId === executionId
      }))
      if (!published) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    for (const change of jobChanges) {
      const key = canonicalGraphJson(change.evidence)
      if (this.#sources.has(key)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      this.#sources.set(key, { evidence: change.evidence, sourceDigest: change.sourceDigest,
        semanticDigest: change.semanticDigest, events: [RepeatGraphEventContentV3Schema.parse({
          eventId: randomUUID(), evidence: change.evidence, sourceDigest: change.sourceDigest,
          semanticDigest: change.semanticDigest, effect: null, fact: change.fact,
        })] })
    }
    if (jobChanges.length) beforeGraphCommit(this.sql, async () => {
      if ((await workflowJobGraphSourceChangesLocked(this.sql, this.scope)).length) {
        throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      }
    })
    // Retirement reads source receipts. Persist the staged domain receipts before
    // capturing their public projection, in this same atomic transaction. The
    // locked head reserves the next sequence; any finalization failure rolls back.
    const stagedSources = new Set(this.#sources.keys())
    if (stagedSources.size) {
      await this.sql.query(
        `insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
         select $1,x.source_kind,x.source_id,x.source_revision,x.source_digest,x.semantic_digest,
           coalesce(x.first_sequence,h.head_sequence+1)
         from run_graph_heads h cross join jsonb_to_recordset($2::jsonb)
           as x(source_kind text,source_id text,source_revision bigint,source_digest text,semantic_digest text,first_sequence bigint)
         where h.run_id=$1`,
        [this.scope.runId, JSON.stringify([...this.#sources.values()].map((source) => ({
          source_kind: source.evidence.sourceKind, source_id: source.evidence.sourceId,
          source_revision: source.evidence.sourceRevision, source_digest: source.sourceDigest,
          semantic_digest: source.semanticDigest, first_sequence: source.firstSequence ?? null,
        })))],
      )
    }
    const projection = await timeRuntimeOperation('db', 'graph.capture_projection',
      () => capturePublicProjectionLocked(this.sql, this.scope, this.readPublicProjection), { runId: this.scope.runId })
    if (projection) {
      const key = canonicalGraphJson(projection.evidence)
      if (this.#sources.has(key)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      this.#sources.set(key, { evidence: projection.evidence, sourceDigest: projection.sourceDigest,
        semanticDigest: projection.semanticDigest, events: [RepeatGraphEventContentV3Schema.parse({ eventId: randomUUID(),
          evidence: projection.evidence, sourceDigest: projection.sourceDigest, semanticDigest: projection.semanticDigest,
          effect: null, fact: projection.fact })] })
      beforeGraphCommit(this.sql, () => timeRuntimeOperation('db', 'graph.recheck_projection',
        () => assertPublicProjectionUnchangedLocked(this.sql, this.scope, projection, this.readPublicProjection), { runId: this.scope.runId }))
    }
    if (this.#sources.size > RUN_GRAPH_LIMITS.transactionSources
      || graphJsonBytes([...this.#sources.values()]) > RUN_GRAPH_LIMITS.transactionBytes) throw new RunGraphError('GRAPH_TRANSACTION_LIMIT')
    this.#finalized = true
    if (!this.#sources.size) return
    const events = [...this.#sources.values()].flatMap((source) => source.events)
    const head = events.length ? await this.sql.query<{ head_sequence: string }>(
      `update run_graph_heads set head_sequence=head_sequence+1
       where run_id=$1 and head_sequence<9223372036854775807 returning head_sequence::text`, [this.scope.runId],
    ) : undefined
    const sequence = head?.rows[0]?.head_sequence
    if (events.length && !sequence) throw new RunGraphError('GRAPH_SEQUENCE_EXHAUSTED')
    let batchId: string | null = null
    let kind: GraphPublicationReceipt['kind'] = 'none'
    let batchProof: ReturnType<typeof repeatGraphBatchReceipt> | undefined
    if (sequence) {
      batchId = randomUUID()
      const candidate = {
        protocolVersion: 1 as const, scope: this.scope, batchId,
        previousSequence: String(BigInt(sequence) - 1n), sequence, events,
      }
      const oversized = events.length > RUN_GRAPH_LIMITS.batchEvents
        || events.some((event) => graphJsonBytes(event) > RUN_GRAPH_LIMITS.eventBytes)
        || graphJsonBytes(candidate) > RUN_GRAPH_LIMITS.batchBytes
      kind = oversized ? 'reset' : 'events'
      if (!oversized) batchProof = repeatGraphBatchReceipt({
        ...candidate, scope: RepeatGraphScopeV3Schema.parse(this.scope), events: events as RepeatGraphEventV3[],
      })
      const parsed = oversized ? undefined : RepeatGraphBatchV3Schema.safeParse(candidate)
      if (parsed && !parsed.success) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      // A size barrier preserves domain state and ALL source receipts. Invalid
      // semantic content is instead a rollback, never disguised as an oversized batch.
      await this.sql.query(
        `insert into run_graph_batches(run_id,sequence,batch_id,kind,payload,reset_reason)
         values($1,$2::bigint,$3::uuid,$4,$5,$6)`,
        [this.scope.runId, sequence, batchId, kind, parsed?.success ? canonicalGraphJson(parsed.data) : null,
          oversized ? 'atomic_change_too_large' : null],
      )
    }
    const receipts = [...this.#sources.entries()].filter(([key]) => !stagedSources.has(key)).map(([, source]) => ({
      first_sequence: source.firstSequence ?? sequence,
      source_kind: source.evidence.sourceKind, source_id: source.evidence.sourceId, source_revision: source.evidence.sourceRevision,
      source_digest: source.sourceDigest, semantic_digest: source.semanticDigest,
    }))
    if (batchProof) receipts.push({ first_sequence: sequence,
      source_kind: batchProof.evidence.sourceKind, source_id: batchProof.evidence.sourceId,
      source_revision: batchProof.evidence.sourceRevision, source_digest: batchProof.sourceDigest, semantic_digest: batchProof.semanticDigest })
    await this.sql.query(
      `insert into run_graph_sources(run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
       select $1,x.source_kind,x.source_id,x.source_revision,x.source_digest,x.semantic_digest,x.first_sequence
       from jsonb_to_recordset($2::jsonb) as x(source_kind text,source_id text,source_revision bigint,source_digest text,semantic_digest text,first_sequence bigint)`,
      [this.scope.runId, JSON.stringify(receipts)],
    )
    if (this.#effects.size) await this.sql.query(
      `insert into run_graph_effects(run_id,effect_kind,entity_id,effect_digest,semantic_digest,first_sequence)
       select $1,x.effect_kind,x.entity_id,x.effect_digest,x.semantic_digest,$2::bigint
       from jsonb_to_recordset($3::jsonb) as x(effect_kind text,entity_id text,effect_digest text,semantic_digest text)`,
      [this.scope.runId, sequence, JSON.stringify([...this.#effects.values()].map(({ effect, semanticDigest }) => ({
        effect_kind: effect.identity.kind, entity_id: effect.identity.entityId,
        effect_digest: effect.digest, semantic_digest: semanticDigest,
      })))],
    )
    this.#receipt = { sequence: sequence ?? null, batchId, kind }
  }
}

/**
 * Must be the FIRST Run/domain lock in a caller-owned exclusive transaction
 * (workspace admission/command receipt locks may precede it; never executions).
 * NO KEY UPDATE serializes Run mutation but permits the KEY SHARE acquired by
 * legacy Activity foreign keys after execution-first native appends. Never
 * upgrade the Run lock after taking the head/child locks.
 * No arbitrary ClientBase overload exists. The commit finalizer cannot be forgotten.
 */
export async function openRunGraphPublication<S extends CanonicalRunGraphScope>(
  sql: GraphTransactionSql, input: S, readPublicProjection: PublicProjectionReader,
  initialize?: { historyCoverage: 'from_admission' | 'from_snapshot' },
): Promise<RunGraphPublication<S>> {
  assertGraphTransaction(sql)
  try {
    const scope = CanonicalRunGraphScopeSchema.parse(input) as S
    const transactionPublications = publications.get(sql) ?? new Map<string, RunGraphPublication<CanonicalRunGraphScope>>()
    // Continuation Start publishes its original Run and a newly inserted Run together.
    if (transactionPublications.has(scope.runId)
      || (transactionPublications.size > 0 && initialize?.historyCoverage !== 'from_admission')) {
      throw new RunGraphError('GRAPH_TRANSACTION_NESTED')
    }
    const found = await sql.query<{ workspace_id: string; workflow_id: string; workflow_version_id: string;
      execution_semantics_version: number; has_job_nodes: boolean }>(
      `select r.workspace_id,r.workflow_id,r.workflow_version_id,v.execution_semantics_version,
         v.record->'definition'->'nodes' @> '[{"kind":"job"}]'::jsonb as has_job_nodes
       from runs r join workflow_versions v on v.id=r.workflow_version_id
       where r.id=$1 for no key update of r`, [scope.runId],
    )
    const run = found.rows[0]
    if (!run || run.workspace_id !== scope.workspaceId || run.workflow_id !== scope.workflowId
      || run.workflow_version_id !== scope.workflowVersionId || run.execution_semantics_version !== scope.executionSemanticsVersion) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    if (initialize) await sql.query(
      `insert into run_graph_heads(run_id,protocol_version,history_coverage) values($1,1,$2) on conflict(run_id) do nothing`,
      [scope.runId, initialize.historyCoverage],
    )
    const head = await sql.query<{ protocol_version: number; sequence: string }>('select protocol_version,head_sequence::text as sequence from run_graph_heads where run_id=$1 for update', [scope.runId])
    if (!head.rows[0]) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    if (head.rows[0].protocol_version !== 1) throw new RunGraphError('GRAPH_UNSUPPORTED_PROTOCOL')
    if (head.rows[0].sequence !== '0') {
      const priorRun = await readRepeatRunSourceLocked(sql, scope)
      if (!priorRun.replayed) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      await assertPublicProjectionCommittedLocked(sql, scope, head.rows[0].sequence, readPublicProjection)
      if (run.has_job_nodes && (await workflowJobGraphSourceChangesLocked(sql, scope)).length) {
        throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      }
    } else {
      const inserted = (await sql.query<{ fresh: boolean }>(
        'select xmin=pg_current_xact_id_if_assigned()::xid and created_at=transaction_timestamp() as fresh from runs where id=$1', [scope.runId])).rows[0]
      if (!initialize || initialize.historyCoverage !== 'from_admission' || inserted?.fresh !== true) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    }
    const publication = new RunGraphPublication(constructionKey, sql, scope, { hasJobNodes: run.has_job_nodes }, readPublicProjection)
    transactionPublications.set(scope.runId, publication)
    publications.set(sql, transactionPublications)
    return publication
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

export function assertRunGraphPublication(sql: GraphTransactionSql, scope: CanonicalRunGraphScope): void {
  assertGraphTransaction(sql)
  const publication = publications.get(sql)?.get(scope.runId)
  if (!publication || !sameCanonicalGraphScope(publication.scope, scope)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
}

export async function withRunGraphPublication<T>(
  connection: ExclusiveGraphConnection, scope: RunGraphScope,
  work: (publication: RunGraphPublication) => Promise<T>,
  readPublicProjection: PublicProjectionReader,
  initialize?: { historyCoverage: 'from_admission' | 'from_snapshot' },
): Promise<{ value: T; publication: Readonly<GraphPublicationReceipt> }> {
  let publication: RunGraphPublication | undefined
  const value = await connection.transaction(async (sql) => {
    publication = await openRunGraphPublication(sql, scope, readPublicProjection, initialize)
    return work(publication)
  })
  return { value, publication: publication!.receipt }
}

/** False while a publication is still being opened (its committed projection is
 * being re-read), so read-only proof verification can skip enlistment. */
export function hasRunGraphPublication(sql: GraphTransactionSql, scope: CanonicalRunGraphScope): boolean {
  const publication = publications.get(sql)?.get(scope.runId)
  return !!publication && sameCanonicalGraphScope(publication.scope, scope)
}

export function currentRunGraphPublication<S extends CanonicalRunGraphScope>(sql: GraphTransactionSql, scope: S): RunGraphPublication<S> {
  assertRunGraphPublication(sql, scope)
  return publications.get(sql)!.get(scope.runId)! as RunGraphPublication<S>
}

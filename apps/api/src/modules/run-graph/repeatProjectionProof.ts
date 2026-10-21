import {
  canonicalGraphJson, GraphDigestSchema, GraphSequenceSchema, REPEAT_GRAPH_LIMITS,
  repeatGraphStateFacts, repeatGraphResolutionKey,
  type RepeatGraphFactV3, type RepeatGraphScopeV3, type RepeatGraphStateV3, type RepeatGraphBatchV3,
  sameCanonicalGraphScope,
} from '@foreman-code/contracts/wave25'
import type { RepeatEffect } from '../runs/repeatPostgres.js'
import { repeatId, repeatSlotId } from '../runs/repeatResolution.js'
import type { GraphTransactionSql } from './connection.js'
import { graphSourceDigest, readRepeatRunSourceLocked, repeatGraphBatchReceipt } from './publication.js'
import { canonicalRepeatEffect, canonicalRepeatEffectReceipt } from './repeatPublication.js'
import { boundedRepeatRows } from './repeatProjectionRows.js'
import { repeatExecutionStateDigest } from './graphDigest.js'
import { RunGraphError } from './errors.js'

const fail = (): never => { throw new RunGraphError('GRAPH_INVARIANT_VIOLATION') }
const equal = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
function factKey(fact: RepeatGraphFactV3): string {
  switch (fact.type) {
    case 'repeat.run.state': return fact.type
    case 'repeat.occurrence': return `${fact.type}/${fact.occurrence.identity.occurrenceId}`
    case 'repeat.decision': return `${fact.type}/${fact.decision.decisionId}`
    case 'repeat.execution': return `${fact.type}/${fact.execution.identity.executionId}`
    case 'repeat.node.resolved': return `${fact.type}/${repeatGraphResolutionKey(fact.resolution)}`
    case 'repeat.result.accepted': return `${fact.type}/${fact.result.execution.executionId}`
    case 'repeat.input.bound': return `${fact.type}/${fact.binding.bindingId}`
  }
}
/** Reconstruct immutable publication metadata from durable normalized records,
 * not retained batches, wall time or checkpoint guesses. The only historical
 * lifecycle here is queued, fixed by the input.bind writer's exact contract.
 * Its immutable input/previous-attempt/identity/bindings must match the receipt.
 */
export function repeatEffectFactsFromState(scope: RepeatGraphScopeV3, state: RepeatGraphStateV3,
  effect: RepeatEffect): RepeatGraphFactV3[] {
  switch (effect.kind) {
    case 'occurrence.create': {
      const occurrence = state.occurrences.find((item) => item.identity.occurrenceId === effect.entityId)
      if (!occurrence || occurrence.identity.occurrenceIndex !== 1) return fail()
      return [{ type: 'repeat.occurrence', occurrence }]
    }
    case 'input.bind': {
      const preparation = state.executions.find((item) => item.identity.kind === 'job'
        && repeatId('job-preparation', item.identity.executionId) === effect.entityId)
      if (preparation) return [{ type: 'repeat.execution', execution: {
        ...preparation, state: 'starting', resultOutcome: null,
      } }]
      const execution = state.executions.find((item) => item.identity.executionId === effect.entityId)
      if (!execution) return fail()
      const queued = { ...execution }
      delete queued.continuedFromExecutionId
      const bindings = state.bindings.filter((item) => item.recipient.executionId === effect.entityId).sort((a, b) => a.ordinal - b.ordinal)
      return [{ type: 'repeat.execution', execution: { ...queued, state: 'queued', resultOutcome: null } },
        ...bindings.map((binding): RepeatGraphFactV3 => ({ type: 'repeat.input.bound', binding }))]
    }
    case 'node.inactive': {
      const resolutions = state.resolutions.filter((item) => !item.value.execution && repeatSlotId(scope.runId, item.ref) === effect.entityId)
      if (resolutions.length !== 1) return fail()
      return [{ type: 'repeat.node.resolved', resolution: resolutions[0]! }]
    }
    case 'terminal.accept': {
      const execution = state.executions.find((item) => item.identity.executionId === effect.entityId)
      const resolutions = state.resolutions.filter((item) => item.value.execution?.executionId === effect.entityId)
      const result = state.results.find((item) => item.execution.executionId === effect.entityId)
      if (execution?.workActivationId) {
        if (execution.state !== 'completed' || execution.resultOutcome !== 'succeeded' || resolutions.length
          || !result || !equal(result.execution, execution.identity)
          || state.decisions.some((item) => item.exitExecution.executionId === effect.entityId)) return fail()
        return [{ type: 'repeat.result.accepted', result }]
      }
      const local = resolutions.find((item) => item.outside === (execution?.identity.occurrence === null))
      if (!execution || execution.state !== 'completed' || !local) return fail()
      const decision = state.decisions.find((item) => item.exitExecution.executionId === effect.entityId)
      const next = decision && state.occurrences.find((item) => item.input.previous?.decisionId === decision.decisionId)
      const exported = execution.identity.occurrence ? resolutions.find((item) => item.outside) : undefined
      if (resolutions.length !== (exported ? 2 : 1) || decision && (decision.reason === 'repeat') !== Boolean(next)
        || decision && (decision.reason !== 'repeat') !== Boolean(exported)) return fail()
      // Exact order used by RepeatRunRepository.acceptTerminal, including the
      // separately namespaced final export. Never collapse by workflowNodeId.
      return [...(result ? [{ type: 'repeat.result.accepted' as const, result }] : []),
        { type: 'repeat.node.resolved', resolution: local },
        ...(decision ? [{ type: 'repeat.decision' as const, decision }] : []),
        ...(next ? [{ type: 'repeat.occurrence' as const, occurrence: next }] : []),
        ...(exported ? [{ type: 'repeat.node.resolved' as const, resolution: exported }] : [])]
    }
    case 'run.complete':
      if (effect.entityId !== scope.runId) return fail()
      return []
    default: return fail()
  }
}
interface SourceProof {
  source_kind: string; source_revision: string; source_id: string | null; source_digest: string | null;
  semantic_digest: string; effect_kind: string | null; entity_id: string | null; effect_digest: string | null;
}
interface ProofRow {
  ordinal: number; source_id: string | null; source_digest: string | null; semantic_digest: string | null;
  first_sequence: string | null; effect_digest: string | null; effect_semantic_digest: string | null; effect_sequence: string | null;
}
/** One bounded SQL query per proof page, not a query for every execution. No
 * JOIN to retained batches: expiration and reset must not destroy source proof.
 */
async function readProofs(sql: GraphTransactionSql, scope: RepeatGraphScopeV3, head: string,
  proofs: readonly SourceProof[]): Promise<ProofRow[]> {
  const result: ProofRow[] = []
  for (let offset = 0; offset < proofs.length; offset += 256) {
    const page = proofs.slice(offset, offset + 256)
    const rows = await sql.query<ProofRow>(`select p.ordinal,s.source_id,s.source_digest,s.semantic_digest,s.first_sequence::text,
        e.effect_digest,e.semantic_digest as effect_semantic_digest,e.first_sequence::text as effect_sequence
      from jsonb_to_recordset($3::jsonb) as p(ordinal integer,source_kind text,source_revision text,source_id text,source_digest text,
        semantic_digest text,effect_kind text,entity_id text,effect_digest text)
      left join lateral (select s.source_id,s.source_digest,s.semantic_digest,s.first_sequence from run_graph_sources s
        where s.run_id=$1 and s.source_kind=p.source_kind and s.source_revision=p.source_revision::bigint and s.semantic_digest=p.semantic_digest
          and (p.source_id is null or s.source_id=p.source_id) and (p.source_digest is null or s.source_digest=p.source_digest)
          and s.first_sequence>0 and s.first_sequence<=$2::bigint order by s.first_sequence desc,s.source_id limit 1) s on true
      left join run_graph_effects e on e.run_id=$1 and e.effect_kind=p.effect_kind and e.entity_id=p.entity_id
      order by p.ordinal`, [scope.runId, head, JSON.stringify(page.map((proof, ordinal) => ({ ordinal, ...proof })))])
    if (rows.rows.length !== page.length || rows.rows.some((row, index) => row.ordinal !== index)) return fail()
    result.push(...rows.rows)
  }
  return result
}
function validProof(row: ProofRow | undefined, proof: SourceProof, head: string): boolean {
  return Boolean(row && row.source_id && GraphDigestSchema.safeParse(row.source_digest).success
    && row.semantic_digest === proof.semantic_digest && row.first_sequence && GraphSequenceSchema.safeParse(row.first_sequence).success
    && BigInt(row.first_sequence) > 0n && BigInt(row.first_sequence) <= BigInt(head)
    && (proof.effect_kind === null || row.effect_digest === proof.effect_digest
      && row.effect_semantic_digest === proof.semantic_digest && row.effect_sequence === row.first_sequence))
}
/** Every assembled entity needs a committed proof at or before THIS captured
 * head. Missing canonical publication is an error, never an unjournaled snapshot
 * silently labelled current, including at head 0 or after an oversize reset.
 */
export async function assertRepeatGraphCommittedState(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  head: string, state: RepeatGraphStateV3): Promise<void> {
  GraphSequenceSchema.parse(head)
  const raw = boundedRepeatRows((await sql.query<{ effect_kind: RepeatEffect['kind']; entity_id: string; payload_digest: string }>(
    `select effect_kind,entity_id,payload_digest from run_repeat_effects where run_id=$1 order by effect_kind,entity_id limit $2`,
    [scope.runId, REPEAT_GRAPH_LIMITS.executions * 3 + REPEAT_GRAPH_LIMITS.resolutions + REPEAT_GRAPH_LIMITS.occurrences + 2])).rows,
  REPEAT_GRAPH_LIMITS.executions * 3 + REPEAT_GRAPH_LIMITS.resolutions + REPEAT_GRAPH_LIMITS.occurrences + 1)
  const covered = new Set<string>(), proofs: SourceProof[] = []
  for (const row of raw) {
    const effect = { kind: row.effect_kind, entityId: row.entity_id, digest: row.payload_digest }
    const publicEffect = canonicalRepeatEffect(scope, effect), facts = repeatEffectFactsFromState(scope, state, effect)
    const receipt = canonicalRepeatEffectReceipt(scope, effect)
    proofs.push({ source_kind: receipt.evidence.sourceKind, source_revision: receipt.evidence.sourceRevision, source_id: receipt.evidence.sourceId, source_digest: receipt.sourceDigest,
      semantic_digest: graphSourceDigest({ effect: publicEffect, facts }), effect_kind: publicEffect.identity.kind,
      entity_id: publicEffect.identity.entityId, effect_digest: publicEffect.digest })
    for (const fact of facts) {
      // Completion only covers the actual current Run if it is still identical.
      if (fact.type !== 'repeat.run.state' || equal(fact.state, state.run)) covered.add(factKey(fact))
    }
  }
  const rows = await readProofs(sql, scope, head, proofs)
  if (proofs.some((proof, i) => !validProof(rows[i], proof, head))) return fail()
  for (const fact of repeatGraphStateFacts(state)) {
    if (fact.type !== 'repeat.run.state' && !covered.has(factKey(fact))) return fail()
  }
  // Jobs use their shared Run publication and latest execution source below;
  // harness executions additionally require a native observation receipt.
  const live = state.executions.filter((item) => item.identity.kind !== 'job' && item.state !== 'queued')
  const launchRows = live.length ? (await sql.query<{ entity_id: string; effect_digest: string }>(
    `select entity_id,effect_digest from run_graph_effects where run_id=$1 and effect_kind='execution.launch'
      and entity_id=any($2::text[])`, [scope.runId, live.map((item) => item.identity.executionId)])).rows : []
  const launches = new Map(launchRows.map((row) => [row.entity_id, row.effect_digest]))
  const current: SourceProof[] = [], candidates: { native: number; launch: number | null }[] = []
  for (const execution of live) {
    const facts: RepeatGraphFactV3[] = [{ type: 'repeat.execution', execution }]
    const native = current.push({ source_kind: 'execution', source_revision: '1', source_id: null, source_digest: null,
      semantic_digest: graphSourceDigest(facts), effect_kind: null, entity_id: null, effect_digest: null }) - 1
    let launch: number | null = null
    const digest = launches.get(execution.identity.executionId)
    if (digest && execution.state === 'starting') {
      const effect = { identity: { kind: 'execution.launch' as const, entityId: execution.identity.executionId }, digest,
        operation: 'execution.launch' as const, subjectId: execution.identity.executionId }
      launch = current.push({ source_kind: 'execution', source_revision: '1', source_id: repeatId('repeat-native', scope.runId,
        execution.identity.occurrence?.occurrenceId ?? 'outside', execution.identity.executionId, 'launch', digest), source_digest: digest,
      semantic_digest: graphSourceDigest({ effect, facts }), effect_kind: effect.identity.kind, entity_id: effect.identity.entityId, effect_digest: digest }) - 1
    }
    candidates.push({ native, launch })
  }
  const currentRows = await readProofs(sql, scope, head, current)
  for (const [i, { native, launch }] of candidates.entries()) {
    const row = currentRows[native], execution = live[i]!
    const exactSource = row && ['observation', 'native_entry', 'negative_settlement'].some((kind) => row.source_id === repeatId('repeat-native', scope.runId,
      execution.identity.occurrence?.occurrenceId ?? 'outside', execution.identity.executionId, kind, row.source_digest!))
    if (!(exactSource && validProof(row, current[native]!, head))
      && !(launch !== null && validProof(currentRows[launch], current[launch]!, head))) return fail()
  }
  // A historical native receipt with the same semantic state cannot prove
  // that state is still latest (running -> waiting -> running is a real cycle).
  // Supplemental exact-execution sources retain the last public cut permanently.
  const latestRows = state.executions.length ? (await sql.query<{
    source_id: string; source_revision: string; first_sequence: string; source_digest: string; semantic_digest: string
  }>(`select distinct on (s.source_id) s.source_id,s.source_revision::text,s.first_sequence::text,s.source_digest,s.semantic_digest
      from run_graph_sources s where s.run_id=$1 and s.source_kind='execution' and s.source_id=any($2::text[])
      order by s.source_id,s.source_revision desc`, [scope.runId, state.executions.map((execution) => execution.identity.executionId)])).rows : []
  const latest = new Map(latestRows.map((row) => [row.source_id, row]))
  if (latest.size !== state.executions.length) return fail()
  for (const execution of state.executions) {
    const row = latest.get(execution.identity.executionId)
    if (!row || !GraphSequenceSchema.safeParse(row.first_sequence).success || row.source_revision !== row.first_sequence
      || BigInt(row.first_sequence) < 1n || BigInt(row.first_sequence) > BigInt(head)
      || row.source_digest !== repeatExecutionStateDigest(scope, execution)
      || row.semantic_digest !== graphSourceDigest([{ type: 'repeat.execution', execution }])) return fail()
  }
  const runSource = await readRepeatRunSourceLocked(sql, scope)
  if (!runSource.replayed || !equal(runSource.fact, { type: 'repeat.run.state', state: state.run })) return fail()

}

/** A schema-valid retained payload is not enough: recompute each source's exact
 * ordered semantic body and prove its source/effect first position is THIS batch.
 * A rewritten/reordered payload, replayed duplicate or orphan delta fails closed.
 */
export async function assertRepeatGraphBatchesCommitted(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  head: string, batches: readonly RepeatGraphBatchV3[]): Promise<void> {
  const proofs: SourceProof[] = [], sequences: string[] = [], seen = new Set<string>()
  for (const batch of batches) {
    if (!sameCanonicalGraphScope(batch.scope, scope)) return fail()
    const envelope = repeatGraphBatchReceipt(batch)
    proofs.push({ source_kind: envelope.evidence.sourceKind, source_revision: envelope.evidence.sourceRevision,
      source_id: envelope.evidence.sourceId, source_digest: envelope.sourceDigest, semantic_digest: envelope.semanticDigest,
      effect_kind: null, entity_id: null, effect_digest: null })
    sequences.push(batch.sequence)
    const groups = new Map<string, RepeatGraphBatchV3['events']>()
    for (const event of batch.events) {
      const key = canonicalGraphJson(event.evidence)
      const group = groups.get(key) ?? []
      group.push(event); groups.set(key, group)
    }
    for (const [key, events] of groups) {
      if (seen.has(key)) return fail()
      seen.add(key)
      const first = events[0]!, facts = events.map(event => event.fact), effect = first.effect
      const semantic = graphSourceDigest(effect ? { effect, facts } : facts)
      if (events.some(event => event.semanticDigest !== semantic || event.sourceDigest !== first.sourceDigest || !equal(event.effect, effect))) return fail()
      proofs.push({ source_kind: first.evidence.sourceKind, source_revision: first.evidence.sourceRevision,
        source_id: first.evidence.sourceId, source_digest: first.sourceDigest, semantic_digest: semantic,
        effect_kind: effect?.identity.kind ?? null, entity_id: effect?.identity.entityId ?? null, effect_digest: effect?.digest ?? null })
      sequences.push(batch.sequence)
    }
  }
  const rows = await readProofs(sql, scope, head, proofs)
  if (proofs.some((proof, index) => !validProof(rows[index], proof, head) || rows[index]!.first_sequence !== sequences[index])) return fail()
}

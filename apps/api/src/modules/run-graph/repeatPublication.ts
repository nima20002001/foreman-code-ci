import type { PublicProjectionReader } from './publicProjectionReader.js'
import { readPublicProjectionLocked } from './compactSnapshot.js'
import { canonicalRepeatEffect, canonicalRepeatEffectReceipt } from './repeatEffects.js'
import {
  canonicalGraphJson, RepeatGraphEffectV3Schema,
  RepeatGraphFactV3Schema, RepeatGraphScopeV3Schema, sameCanonicalGraphScope,
  qualifyRepeatGraphExecution, validateRepeatGraphFactsV3, RUN_GRAPH_LIMITS,
  type RepeatGraphEffectV3, type RepeatGraphFactV3, type RepeatGraphScopeV3, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { RepeatEffect, RepeatFact } from '../runs/repeatPostgres.js'
import type { RepeatCanonicalPublication } from '../runs/repeatRepositoryHost.js'
import { repeatDigest, repeatId, repeatSlotId, repeatExecutionIdentity } from '../runs/repeatResolution.js'
import { repeatLaunchClaim, type RepeatLaunchClaim, type RepeatNativeChange } from '../runs/repeatNativeRepository.js'
import type { RunOwnership } from '../runs/ownership.js'
import {
  assertGraphTransaction, beforeGraphCommit, isReadOnlyGraphTransaction, poisonGraphTransaction,
  type GraphTransactionSql,
} from './connection.js'
import { assertRunGraphPublication, readRepeatRunSourceLocked, openRunGraphPublication, type RunGraphPublication } from './publication.js'
import {
  assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit, type RepeatCanonicalReceipt,
} from './repeatReceipts.js'
import { readRepeatGraphBindingsLocked, readRepeatGraphExecutionsLocked, readRepeatGraphPinsLocked, readRepeatRunStateLocked } from './repeatProjectionRows.js'
import { publishRepeatExecutionStateLocked } from './repeatExecutionPublication.js'
import { RunGraphError } from './errors.js'
import { assertPublicProjectionCommittedLocked } from './publicProjectionReceipt.js'
import { DomainError } from '../errors.js'
import { workflowJobGraphSourceChangesLocked } from './workflowJobProjection.js'

export { canonicalRepeatEffect, canonicalRepeatEffectReceipt } from './repeatEffects.js'

const same = (left: unknown, right: unknown) => canonicalGraphJson(left) === canonicalGraphJson(right)
const fail = (): never => { throw new RunGraphError('GRAPH_INVARIANT_VIOLATION') }

export function canonicalRepeatLaunchEffect(claim: RepeatLaunchClaim, digest: string): RepeatGraphEffectV3 {
  if (repeatDigest(claim) !== digest) return fail()
  return RepeatGraphEffectV3Schema.parse({ operation: 'execution.launch', subjectId: claim.executionId,
    identity: { kind: 'execution.launch', entityId: claim.executionId }, digest })
}

/** Explicit private-to-public mapping. The private union is not a public schema.
 * Queued execution state/input bindings are supplied from newly persisted rows.
 * No object spread of a Run, HarnessExecution, input, result or native source. */
export function mapRepeatFactMetadata(fact: Exclude<RepeatFact, { type: 'repeat.execution.queued' }>): RepeatGraphFactV3 {
  switch (fact.type) {
    case 'repeat.occurrence': return RepeatGraphFactV3Schema.parse({ type: fact.type, occurrence: fact.occurrence })
    case 'repeat.decision': return RepeatGraphFactV3Schema.parse({ type: fact.type, decision: fact.decision })
    case 'repeat.node.resolved': return RepeatGraphFactV3Schema.parse({ type: fact.type, resolution: {
      ref: fact.resolution.ref, value: fact.resolution.value, deferredRelationshipIds: fact.resolution.deferredRelationshipIds, outside: fact.outside,
    } })
    case 'repeat.result.accepted':
      if (fact.ref.nodeId !== fact.execution.workflowNodeId) return fail()
      return RepeatGraphFactV3Schema.parse({ type: fact.type, result: {
        execution: qualifyRepeatGraphExecution(fact.execution, fact.ref.occurrence), resultDigest: fact.resultDigest,
      } })
    default: return fail()
  }
}

async function assertPersistedFact(sql: GraphTransactionSql, scope: RepeatGraphScopeV3, fact: RepeatGraphFactV3): Promise<void> {
  switch (fact.type) {
    case 'repeat.occurrence': {
      const row = (await sql.query<{ record: unknown }>(
        'select record from run_repeat_occurrences where run_id=$1 and occurrence_id=$2', [scope.runId, fact.occurrence.identity.occurrenceId])).rows[0]
      if (!row || !same(row.record, fact.occurrence)) return fail()
      return
    }
    case 'repeat.decision': {
      const row = (await sql.query<{ metadata: unknown }>(
        "select record-'resultData' as metadata from run_repeat_decisions where run_id=$1 and decision_id=$2", [scope.runId, fact.decision.decisionId])).rows[0]
      if (!row || !same(row.metadata, fact.decision)) return fail()
      return
    }
    case 'repeat.node.resolved': {
      const { outside, ...resolution } = fact.resolution
      const row = (await sql.query<{ record: unknown }>(
        'select record from run_repeat_resolutions where run_id=$1 and occurrence_key=$2 and workflow_node_id=$3',
        [scope.runId, outside ? '' : resolution.ref.occurrence!.occurrenceId, resolution.ref.nodeId])).rows[0]
      if (!row || !same(row.record, resolution)) return fail()
      return
    }
    case 'repeat.result.accepted': {
      const [execution] = await readRepeatGraphExecutionsLocked(sql, scope,
        { executionIds: [fact.result.execution.executionId] })
      const row = (await sql.query<{ result_digest: string; occurrence_id: string | null }>(
        'select result_digest,occurrence_id from run_repeat_results where run_id=$1 and execution_id=$2',
        [scope.runId, fact.result.execution.executionId])).rows[0]
      if (!execution || execution.state !== 'completed' || execution.resultOutcome !== 'succeeded'
        || !same(execution.identity, fact.result.execution) || !row || row.result_digest !== fact.result.resultDigest
        || row.occurrence_id !== (execution.identity.occurrence?.occurrenceId ?? null)) return fail()
      return
    }
    case 'repeat.run.state': if (!same(await readRepeatRunStateLocked(sql, scope), fact.state)) return fail(); return
    // Both are constructed by the concrete physical readers below, never caller input.
    case 'repeat.execution': case 'repeat.input.bound': return
  }
}
function assertEffectFacts(scope: RepeatGraphScopeV3, version: WorkflowVersionV3, effect: RepeatEffect, facts: readonly RepeatFact[]): void {
  if (effect.kind === 'run.complete') { if (effect.entityId !== scope.runId || facts.length !== 0) return fail(); return }
  if (effect.kind === 'occurrence.create') {
    if (facts.length !== 1 || facts[0]!.type !== 'repeat.occurrence' || facts[0]!.occurrence.identity.occurrenceId !== effect.entityId) return fail()
  } else if (effect.kind === 'input.bind') {
    if (facts.length !== 1 || facts[0]!.type !== 'repeat.execution.queued' || facts[0]!.execution.executionId !== effect.entityId) return fail()
  } else if (effect.kind === 'node.inactive') {
    const fact = facts[0]
    if (facts.length !== 1 || fact?.type !== 'repeat.node.resolved' || fact.resolution.value.execution
      || effect.entityId !== repeatSlotId(scope.runId, fact.resolution.ref)) return fail()
  } else if (effect.kind === 'terminal.accept') {
    if (version.definition.handoffs) {
      if (facts.length !== 1 || facts[0]?.type !== 'repeat.result.accepted'
        || facts[0].execution.executionId !== effect.entityId || facts[0].ref.occurrence !== null) return fail()
      return
    }
    let position = 0
    const result = facts[position]?.type === 'repeat.result.accepted' ? facts[position++] : undefined
    const local = facts[position++]
    if (local?.type !== 'repeat.node.resolved' || local.resolution.value.execution?.executionId !== effect.entityId
      || local.outside !== (local.resolution.ref.occurrence === null)
      || Boolean(result) !== (local.resolution.value.resolution === 'succeeded')) return fail()
    if (result && (result.type !== 'repeat.result.accepted' || result.execution.executionId !== effect.entityId
      || !same(result.ref, local.resolution.ref) || result.resultDigest !== local.resolution.value.acceptedResultDigest)) return fail()
    if (position === facts.length) return
    const decision = facts[position++]
    if (decision?.type !== 'repeat.decision' || decision.decision.exitExecution.executionId !== effect.entityId
      || !same(local.resolution.ref.occurrence, decision.decision.occurrence.identity)) return fail()
    const boundary = facts[position++]
    if (decision.decision.reason === 'repeat') {
      if (boundary?.type !== 'repeat.occurrence' || boundary.occurrence.input.previous?.decisionId !== decision.decision.decisionId
        || boundary.occurrence.input.previous.acceptedResultDigest !== decision.decision.acceptedResultDigest
        || boundary.occurrence.identity.blockId !== decision.decision.occurrence.identity.blockId) return fail()
    } else if (boundary?.type !== 'repeat.node.resolved' || !boundary.outside
      || !same(boundary.resolution.ref, local.resolution.ref)
      || boundary.resolution.value.execution?.executionId !== effect.entityId) return fail()
    if (position !== facts.length) return fail()
  } else return fail()
}

/** Concrete N1 port. owner must be the current RunOwnership (not a supplied
 * owner ID or boolean); the factory integration hunk passes it explicitly.
 * A caller that already opened G1 at admission passes that SAME publication.
 * Otherwise this opens G1 once without initializing or repairing a missing head.
 */
export async function openRepeatCanonicalPublicationLocked(sql: GraphTransactionSql, input: RepeatGraphScopeV3,
  owner: RunOwnership, existing?: RunGraphPublication<RepeatGraphScopeV3>): Promise<RepeatCanonicalPublication> {
  assertGraphTransaction(sql)
  try {
    const scope = RepeatGraphScopeV3Schema.parse(input)
    owner.assertOwned()
    if (owner.runId !== scope.runId) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    if (isReadOnlyGraphTransaction(sql)) return await readRepeatCanonicalPublication(sql, scope, owner, readPublicProjectionLocked)
    const publication = existing ?? await openRunGraphPublication(sql, scope, readPublicProjectionLocked)
    if (publication.sql !== sql || !sameCanonicalGraphScope(publication.scope, scope)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    assertRunGraphPublication(sql, scope)
    const { version } = await readRepeatGraphPinsLocked(sql, scope)
    await owner.readOneShotFence(sql)
    const protect = async <T>(work: () => Promise<T>): Promise<T> => {
      try { assertGraphTransaction(sql); owner.assertOwned(); return await work() }
      catch (error) { poisonGraphTransaction(sql); throw error }
    }
    const verify = (receipt: RepeatCanonicalReceipt) => requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
    const checkNative = (change: RepeatNativeChange) => {
      if (!sameCanonicalGraphScope(change.scope, scope) || repeatDigest(change.source, RUN_GRAPH_LIMITS.transactionBytes) !== change.sourceDigest
        || change.sourceRevision !== '1' || change.sourceId !== repeatId('repeat-native', scope.runId,
          change.ref.occurrence?.occurrenceId ?? 'outside', change.next.id, change.kind, change.sourceDigest)
        || change.previous.id !== change.next.id || change.previous.runId !== scope.runId || change.next.runId !== scope.runId
        || !same(repeatExecutionIdentity(change.previous), repeatExecutionIdentity(change.next))
        || change.ref.nodeId !== change.next.workflowNodeId || (change.kind === 'launch') !== (change.effect !== null)) return fail()
      if (change.effect && (change.effect.kind !== 'execution.launch' || change.effect.entityId !== change.next.id || change.effect.digest !== change.sourceDigest)) return fail()
    }
    return {
      sql, scope,
      publishEffectLocked: (effectValue, factValues, mutate) => protect(async () => {
        // Capture before the first await; retargeting caller objects cannot change
        // a registered source/effect or its immutable receipt assertion.
        canonicalGraphJson(factValues, RUN_GRAPH_LIMITS.transactionBytes)
        const effect = structuredClone(effectValue), facts = structuredClone(factValues)
        const publicEffect = canonicalRepeatEffect(scope, effect), receipt = canonicalRepeatEffectReceipt(scope, effect)
        assertEffectFacts(scope, version, effect, facts)
        const result = await publication.repeatChange({ evidence: receipt.evidence, sourceDigest: receipt.sourceDigest, effect: publicEffect }, owner,
          async () => { await mutate() }, async () => {
            const privateReceipt = (await sql.query<{ payload_digest: string }>(
              'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
              [scope.runId, effect.kind, effect.entityId])).rows[0]
            if (!privateReceipt || privateReceipt.payload_digest !== effect.digest) return fail()
            const metadata: RepeatGraphFactV3[] = []
            for (const fact of facts) {
              if (fact.type === 'repeat.execution.queued') {
                const [execution] = await readRepeatGraphExecutionsLocked(sql, scope,
                  { executionIds: [fact.execution.executionId], version })
                if (!execution || execution.state !== 'queued' || execution.inputDigest !== fact.inputDigest
                  || fact.ref.nodeId !== fact.execution.workflowNodeId
                  || !same(execution.identity, qualifyRepeatGraphExecution(fact.execution, fact.ref.occurrence))) return fail()
                metadata.push({ type: 'repeat.execution', execution })
                const bindings = await readRepeatGraphBindingsLocked(sql, scope, [fact.execution.executionId])
                metadata.push(...bindings.map((binding): RepeatGraphFactV3 => ({ type: 'repeat.input.bound', binding })))
              } else metadata.push(mapRepeatFactMetadata(fact))
            }
            if (effect.kind === 'run.complete') {
              const state = await readRepeatRunStateLocked(sql, scope)
              if (state.executionState !== 'completed' || state.outcome !== 'succeeded' || state.stopRequested) return fail()
            }
            validateRepeatGraphFactsV3(version, scope, metadata)
            for (const fact of metadata) await assertPersistedFact(sql, scope, fact)
            return metadata
          })
        verify(canonicalRepeatEffectReceipt(scope, effect, result.semanticDigest))
        if (effect.kind === 'run.complete') await publishRepeatRunStateLocked(publication, owner)
        if (effect.kind === 'input.bind' || effect.kind === 'terminal.accept') {
          await publishRepeatExecutionStateLocked(publication, owner, effect.entityId)
        }
      }),
      assertEffectReceiptLocked: (effect) => protect(async () => { verify(canonicalRepeatEffectReceipt(scope, structuredClone(effect))) }),
      publishNativeLocked: (changeValue, mutate) => protect(async () => {
        canonicalGraphJson(changeValue, RUN_GRAPH_LIMITS.transactionBytes)
        const change = structuredClone(changeValue)
        checkNative(change)
        let effect: RepeatGraphEffectV3 | null = null
        if (change.kind === 'launch') {
          const [before] = await readRepeatGraphExecutionsLocked(sql, scope, { executionIds: [change.next.id], version })
          if (!before) return fail()
          const claim = repeatLaunchClaim(scope, change.ref, change.next, before.inputDigest)
          if (!same(claim, change.source)) return fail()
          effect = canonicalRepeatLaunchEffect(claim, change.sourceDigest)
        }
        const evidence = { sourceKind: 'execution' as const, sourceId: change.sourceId, sourceRevision: change.sourceRevision }
        const project = async (): Promise<RepeatGraphFactV3[]> => {
          const [execution] = await readRepeatGraphExecutionsLocked(sql, scope, { executionIds: [change.next.id], version })
          if (!execution || !same(execution.identity, qualifyRepeatGraphExecution(repeatExecutionIdentity(change.next), change.ref.occurrence))
            || execution.state !== change.next.state || execution.resultOutcome !== (change.next.result?.outcome ?? null)) return fail()
          const facts: RepeatGraphFactV3[] = [{ type: 'repeat.execution', execution }]
          validateRepeatGraphFactsV3(version, scope, facts)
          return facts
        }
        const mutation = async () => { await mutate() }
        const result = effect
          ? await publication.repeatChange({ evidence, sourceDigest: change.sourceDigest, effect }, owner, mutation, project)
          : await publication.repeatObservation({ evidence, sourceDigest: change.sourceDigest }, owner, mutation, project)
        verify({ scope, evidence, sourceDigest: change.sourceDigest, effect: change.effect, semanticDigest: result.semanticDigest })
        await publishRepeatExecutionStateLocked(publication, owner, change.next.id)
      }),
      assertNativeReceiptLocked: (change) => protect(async () => {
        checkNative(change)
        verify({ scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: change.sourceRevision },
          sourceDigest: change.sourceDigest, effect: change.effect })
      }),
      assertLaunchReceiptLocked: (claimValue, digest) => protect(async () => {
        const claim = structuredClone(claimValue)
        if (!sameCanonicalGraphScope(claim.scope, scope)) return fail()
        canonicalRepeatLaunchEffect(claim, digest)
        verify({ scope, evidence: { sourceKind: 'execution', sourceId: repeatId('repeat-native', scope.runId,
          claim.ref.occurrence?.occurrenceId ?? 'outside', claim.executionId, 'launch', digest), sourceRevision: '1' },
        sourceDigest: digest, effect: { kind: 'execution.launch', entityId: claim.executionId, digest } })
      }),
    }
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

/** Owner observations validate committed sources without opening a writer or staging finalization. */
async function readRepeatCanonicalPublication(sql: GraphTransactionSql, scope: RepeatGraphScopeV3,
  owner: RunOwnership, readPublicProjection: PublicProjectionReader): Promise<RepeatCanonicalPublication> {
  const { version } = await readRepeatGraphPinsLocked(sql, scope)
  const source = await readRepeatRunSourceLocked(sql, scope)
  if (!source.replayed) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  await assertPublicProjectionCommittedLocked(sql, scope, source.head, readPublicProjection)
  if (version.definition.nodes.some(node => node.kind === 'job')
    && (await workflowJobGraphSourceChangesLocked(sql, scope)).length) {
    throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  }
  await owner.readOneShotFence(sql)
  const unavailable = async (): Promise<never> => {
    throw new DomainError('RUN_READ_ONLY', 'A Run observation cannot publish changes or authorize native entry.', 409)
  }
  return {
    sql,
    scope,
    publishEffectLocked: unavailable,
    publishNativeLocked: unavailable,
    assertNativeReceiptLocked: unavailable,
    assertLaunchReceiptLocked: unavailable,
    assertEffectReceiptLocked: async (effect) => {
      owner.assertOwned()
      await assertRepeatCanonicalReceiptLocked(sql, canonicalRepeatEffectReceipt(scope, effect))
    },
  }
}

/** Call AFTER the excluded authorized owner-scoped lifecycle SQL writer, before
 * COMMIT, on its existing owner transaction/publication. No new authority,
 * mutation, counter, head, command receipt or native acknowledgement is created.
 * Full private Run data contributes only to its digest, never to graph facts. */
export async function publishRepeatRunStateLocked(publication: RunGraphPublication<RepeatGraphScopeV3>, owner: RunOwnership): Promise<void> {
  const { sql, scope } = publication
  try {
    assertGraphTransaction(sql)
    await readRepeatGraphPinsLocked(sql, scope)
    const current = await readRepeatRunSourceLocked(sql, scope)
    const { evidence, sourceDigest } = current
    const result = await publication.repeatRunReadback({ evidence, sourceDigest }, owner,
      async () => [current.fact])
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence, sourceDigest, effect: null, semanticDigest: result.semanticDigest })
    // Publishing a later mutation in another callback is not atomic readback.
    beforeGraphCommit(sql, async () => {
      const latest = await readRepeatRunSourceLocked(sql, scope)
      if (!same(latest.run, current.run) || latest.stopped !== current.stopped) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    })
  } catch (error) { poisonGraphTransaction(sql); throw error }
}

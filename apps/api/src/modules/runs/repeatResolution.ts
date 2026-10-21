import { createHash } from 'node:crypto'
import type { ExecutionResult, HarnessExecution, RunInput } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type {
  AgentGraphExecutionIdentity, GraphExecutionIdentity, NodeResolution, RepeatBlockV1, RepeatDecisionV1,
  RepeatExecutionIdentityV1, RepeatExitDataV1, RepeatOccurrenceIdentityV1,
  RepeatOccurrenceV1, WorkflowVersionV3, WorkflowRelationship,
} from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import { compileExecutionTopology, decideExecutionAdmission, type ExecutionTopology } from './topology.js'

export type RepeatScope = RepeatOccurrenceIdentityV1['scope']
export interface RepeatNodeRef { nodeId: string; occurrence: RepeatOccurrenceIdentityV1 | null }
/** Outside consumers read only final exports, never the occurrence-local exit row. */
export interface RepeatResolution {
  ref: RepeatNodeRef
  value: NodeResolution
  deferredRelationshipIds: string[]
}
export interface RepeatSource {
  relationshipId: string
  execution: GraphExecutionIdentity
  occurrence: RepeatOccurrenceIdentityV1 | null
  acceptedResultDigest: string
  acceptedResult: ExecutionResult
}
/** Private immutable entry snapshot. Carries do not recursively embed older snapshots. */
export interface RepeatEntryInput {
  runInput: RunInput
  external: RepeatSource[]
  carry: {
    decisionId: string
    execution: RepeatExecutionIdentityV1
    acceptedResultDigest: string
    acceptedResult: ExecutionResult
  } | null
}
export interface RepeatNodeInput {
  executionSemanticsVersion: 3
  runInput: RunInput
  occurrence: RepeatOccurrenceV1 | null
  entry: RepeatEntryInput | null
  predecessors: RepeatSource[]
}
export interface RepeatInputBinding {
  bindingId: string
  recipient: GraphExecutionIdentity
  recipientOccurrence: RepeatOccurrenceIdentityV1 | null
  inputDigest: string
  source: RepeatSource | NonNullable<RepeatEntryInput['carry']>
  kind: 'predecessor' | 'external' | 'carry'
  ordinal: number
}

export function repeatConflict(code: string): never {
  // Never copy private input, model output, paths, or parser fragments into an error.
  throw new DomainError(code, 'The repeat operation conflicts with its pinned durable evidence.', 409)
}
export function repeatDigest(value: unknown, maxBytes?: number): string {
  return `sha256:${createHash('sha256').update(canonicalGraphJson(value, maxBytes)).digest('hex')}`
}
export function repeatId(kind: string, ...parts: (string | number)[]): string {
  return `${kind}-${createHash('sha256').update(canonicalGraphJson(parts)).digest('hex')}`
}
export function sameRepeatValue(left: unknown, right: unknown): boolean {
  // An absent optional field is not JSON; it only equals another absent field.
  if (left === undefined || right === undefined) return left === right
  return canonicalGraphJson(left) === canonicalGraphJson(right)
}
export function repeatExecutionIdentity(execution: HarnessExecution): AgentGraphExecutionIdentity {
  return { workflowNodeId: execution.workflowNodeId, executionId: execution.id,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt }
}
export function repeatSlotId(runId: string, ref: RepeatNodeRef): string {
  return repeatId('repeat-slot', runId, ref.occurrence?.occurrenceId ?? 'outside', ref.nodeId)
}
export function workActivationSlotId(runId: string, activationId: string): string {
  return repeatId('work-slot', runId, activationId)
}
export function tickSlotId(runId: string, nodeId: string, tickIndex: number): string {
  return repeatId('tick-slot', runId, nodeId, tickIndex)
}
/** The interval check index frozen in a slot input; undefined for ordinary graph work. */
export function repeatTickIndex(input: unknown): number | undefined {
  if (!input || typeof input !== 'object' || !('tick' in input)) return undefined
  const tick = (input as { tick: unknown }).tick
  const index = tick && typeof tick === 'object' && 'index' in tick ? (tick as { index: unknown }).index : undefined
  if (!Number.isSafeInteger(index) || (index as number) < 1) return repeatConflict('TICK_INPUT_INVALID')
  return index as number
}
/** The one slot an execution may occupy: its check, work activation or graph node slot. */
export function expectedRepeatSlotId(runId: string, ref: RepeatNodeRef, input: unknown,
  workActivationId: string | null): string {
  const tickIndex = repeatTickIndex(input)
  if (tickIndex !== undefined) return tickSlotId(runId, ref.nodeId, tickIndex)
  return workActivationId ? workActivationSlotId(runId, workActivationId) : repeatSlotId(runId, ref)
}
export function repeatBlock(version: WorkflowVersionV3, blockId: string): RepeatBlockV1 {
  const block = version.definition.repeat?.blocks.find((item) => item.id === blockId)
  if (!block) return repeatConflict('REPEAT_BLOCK_NOT_FOUND')
  return block
}
export function blockForNode(version: WorkflowVersionV3, nodeId: string): RepeatBlockV1 | undefined {
  return version.definition.repeat?.blocks.find((block) => block.nodeIds.includes(nodeId))
}
export function assertRepeatScope(version: WorkflowVersionV3, scope: RepeatScope): void {
  if (scope.executionSemanticsVersion !== 3 || version.executionSemanticsVersion !== 3
    || version.definition.executionSemanticsVersion !== 3 || !scope.runId
    || scope.workspaceId !== version.workspaceId || scope.workflowId !== version.workflowId
    || scope.workflowVersionId !== version.id) repeatConflict('REPEAT_SCOPE_CONFLICT')
}
export function assertRepeatRef(version: WorkflowVersionV3, scope: RepeatScope, ref: RepeatNodeRef): void {
  assertRepeatScope(version, scope)
  if (!version.definition.nodes.some((node) => node.id === ref.nodeId)) repeatConflict('WORKFLOW_NODE_NOT_FOUND')
  const block = blockForNode(version, ref.nodeId)
  if (!block) {
    if (ref.occurrence !== null) repeatConflict('REPEAT_OCCURRENCE_CONFLICT')
    return
  }
  const occurrence = ref.occurrence
  if (!occurrence || !sameRepeatValue(occurrence.scope, scope) || occurrence.blockId !== block.id
    || !Number.isInteger(occurrence.occurrenceIndex) || occurrence.occurrenceIndex < 1
    || occurrence.occurrenceIndex > block.maxOccurrences) repeatConflict('REPEAT_OCCURRENCE_CONFLICT')
}
export function assertRepeatExecution(version: WorkflowVersionV3, scope: RepeatScope,
  ref: RepeatNodeRef, execution: HarnessExecution): void {
  assertRepeatRef(version, scope, ref)
  const node = version.definition.nodes.find((item) => item.id === ref.nodeId)!
  if (node.kind === 'job' || execution.runId !== scope.runId || execution.workflowNodeId !== node.id || execution.agentId !== node.agentId
    || execution.agentConfigurationVersionId !== version.agentConfigurationVersionIds[node.agentId]
    || !Number.isInteger(execution.attempt) || execution.attempt < 1 || execution.attempt > 2147483647) {
    repeatConflict('EXECUTION_OCCURRENCE_CONFLICT')
  }
}

/** Current DAG/barrier algorithm on the validated block-induced subgraph. No saved-version retagging. */
export function occurrenceTopology(version: WorkflowVersionV3, occurrence: RepeatOccurrenceIdentityV1): ExecutionTopology {
  assertRepeatScope(version, occurrence.scope)
  const block = repeatBlock(version, occurrence.blockId)
  const members = new Set(block.nodeIds)
  return compileExecutionTopology({ entryNodeId: block.entryNodeId, definition: {
    entryNodeId: block.entryNodeId, nodes: version.definition.nodes.filter((node) => members.has(node.id)),
    edges: version.definition.edges.filter((edge) => edge.kind === 'execution' && members.has(edge.source) && members.has(edge.target)),
  } })
}
export function decideRepeatAdmission(version: WorkflowVersionV3, ref: RepeatNodeRef,
  resolutions: ReadonlyMap<string, RepeatResolution>) {
  if (!version.definition.nodes.some((node) => node.id === ref.nodeId)) repeatConflict('WORKFLOW_NODE_NOT_FOUND')
  if (ref.occurrence) assertRepeatRef(version, ref.occurrence.scope, ref)
  else if (blockForNode(version, ref.nodeId)) repeatConflict('REPEAT_OCCURRENCE_CONFLICT')
  const values = new Map<string, NodeResolution>()
  for (const [id, resolution] of resolutions) {
    if (id !== resolution.ref.nodeId || id !== resolution.value.workflowNodeId) repeatConflict('REPEAT_RESOLUTION_CONFLICT')
    if (ref.occurrence && !sameRepeatValue(ref.occurrence, resolution.ref.occurrence)) repeatConflict('REPEAT_CROSS_OCCURRENCE_JOIN')
    if (resolution.deferredRelationshipIds.length) {
      // A local exit is complete inside its occurrence, but cannot masquerade
      // as an external source. The final export has an empty deferred set.
      if (!ref.occurrence) repeatConflict('REPEAT_EGRESS_UNRESOLVED')
    }
    values.set(id, resolution.value)
  }
  return decideExecutionAdmission(ref.occurrence ? occurrenceTopology(version, ref.occurrence)
    : compileExecutionTopology(version), ref.nodeId, values)
}
/** Whether a repeat block may open its first occurrence, decided on the whole
 * graph from outside resolutions, including final exports with occurrence provenance. The entry node itself belongs
 * to the block, so the per-node admission above (which forbids a block member
 * without an occurrence) cannot answer this. */
export function decideRepeatBlockEntry(version: WorkflowVersionV3, block: RepeatBlockV1,
  resolutions: ReadonlyMap<string, RepeatResolution>) {
  const values = new Map<string, NodeResolution>()
  for (const [id, resolution] of resolutions) {
    if (id !== resolution.ref.nodeId || id !== resolution.value.workflowNodeId
      || resolution.deferredRelationshipIds.length) repeatConflict('REPEAT_RESOLUTION_CONFLICT')
    if (resolution.ref.occurrence) {
      assertRepeatRef(version, resolution.ref.occurrence.scope, resolution.ref)
      // Final exports retain the source occurrence. Local body rows and exits
      // whose routing has not been published cannot open another block.
      const sourceBlock = blockForNode(version, id)!
      if (sourceBlock.exitNodeId !== id || resolution.value.resolution !== 'succeeded'
        || !resolution.value.execution || !resolution.value.acceptedResultDigest
        || (!resolution.value.branchEnded && resolution.value.selectedRelationshipIds.length !== 1)) {
        repeatConflict('REPEAT_RESOLUTION_CONFLICT')
      }
    }
    values.set(id, resolution.value)
  }
  return decideExecutionAdmission(compileExecutionTopology(version), block.entryNodeId, values)
}
export function assertRepeatBodyComplete(version: WorkflowVersionV3, occurrence: RepeatOccurrenceIdentityV1,
  resolutions: ReadonlyMap<string, RepeatResolution>): void {
  const block = repeatBlock(version, occurrence.blockId)
  for (const id of block.nodeIds) {
    const row = resolutions.get(id)
    if (!row || !sameRepeatValue(row.ref.occurrence, occurrence)) repeatConflict('REPEAT_BODY_UNRESOLVED')
    if (!['succeeded', 'skipped'].includes(row.value.resolution)) repeatConflict('REPEAT_SELECTED_WORK_FAILED')
    if (id === block.exitNodeId && row.value.resolution !== 'succeeded') repeatConflict('REPEAT_EXIT_NOT_ACCEPTED')
  }
}

/** Caller loads the exact accepted row and validates its complete schema first. */
export function assertRepeatSource(version: WorkflowVersionV3, scope: RepeatScope,
  source: RepeatSource, execution: HarnessExecution, accepted: boolean): void {
  const ref = { nodeId: source.execution.workflowNodeId, occurrence: source.occurrence }
  assertRepeatExecution(version, scope, ref, execution)
  if (!accepted || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded'
    || !sameRepeatValue(repeatExecutionIdentity(execution), source.execution)
    || !sameRepeatValue(execution.result, source.acceptedResult)
    || repeatDigest(execution.result, 64 * 1024) !== source.acceptedResultDigest) repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
}
export function freezeRepeatEntry(runInput: RunInput, external: readonly RepeatSource[]): RepeatEntryInput {
  const ordered = [...external].sort((a, b) => a.relationshipId < b.relationshipId ? -1 : a.relationshipId > b.relationshipId ? 1 : 0)
  if (new Set(ordered.map((source) => source.relationshipId)).size !== ordered.length) repeatConflict('REPEAT_INPUT_DUPLICATE')
  const value: RepeatEntryInput = { runInput, external: ordered, carry: null }
  // Snapshot by canonical serialization, not aliases to mutable objects in a caller.
  return JSON.parse(canonicalGraphJson(value, 4 * 1024 * 1024)) as RepeatEntryInput
}
export function makeRepeatOccurrence(scope: RepeatScope, block: RepeatBlockV1, input: RepeatEntryInput,
  previous: RepeatDecisionV1 | null): { occurrence: RepeatOccurrenceV1; input: RepeatEntryInput } {
  const index = previous ? previous.occurrence.identity.occurrenceIndex + 1 : 1
  if (!Number.isInteger(block.maxOccurrences) || block.maxOccurrences < 1 || block.maxOccurrences > 2147483647
    || index > block.maxOccurrences) repeatConflict('REPEAT_LIMIT_EXCEEDED')
  if (previous && (previous.reason !== 'repeat' || previous.target.kind !== 'next_occurrence'
    || previous.target.entryNodeId !== block.entryNodeId || previous.target.occurrenceIndex !== index
    || !sameRepeatValue(previous.occurrence.identity.scope, scope)
    || previous.occurrence.identity.blockId !== block.id)) repeatConflict('REPEAT_ANCESTRY_CONFLICT')
  if (previous ? !input.carry || input.carry.decisionId !== previous.decisionId
    || input.carry.acceptedResultDigest !== previous.acceptedResultDigest
    || !sameRepeatValue(input.carry.execution, previous.exitExecution)
    || input.carry.acceptedResult.outcome !== 'succeeded'
    || repeatDigest(input.carry.acceptedResult, 64 * 1024) !== previous.acceptedResultDigest : input.carry !== null) repeatConflict('REPEAT_CARRY_CONFLICT')
  const occurrenceId = repeatId('occurrence', scope.runId, scope.workflowVersionId, block.id, index)
  const frozen = JSON.parse(canonicalGraphJson(input, 4 * 1024 * 1024)) as RepeatEntryInput
  return { occurrence: { contractVersion: 1,
    identity: { scope: { ...scope }, blockId: block.id, occurrenceId, occurrenceIndex: index },
    input: { bindingId: repeatId('repeat-input', occurrenceId), inputDigest: repeatDigest(frozen, 4 * 1024 * 1024),
      previous: previous ? { occurrenceId: previous.occurrence.identity.occurrenceId,
        occurrenceIndex: previous.occurrence.identity.occurrenceIndex, decisionId: previous.decisionId,
        acceptedResultDigest: previous.acceptedResultDigest } : null },
  }, input: frozen }
}
export function repeatSuccessorInput(initial: RepeatEntryInput, previous: RepeatDecisionV1,
  acceptedResult: ExecutionResult): RepeatEntryInput {
  if (acceptedResult.outcome !== 'succeeded' || repeatDigest(acceptedResult, 64 * 1024) !== previous.acceptedResultDigest) {
    repeatConflict('REPEAT_CARRY_CONFLICT')
  }
  return JSON.parse(canonicalGraphJson({ runInput: initial.runInput, external: initial.external,
    carry: { decisionId: previous.decisionId, execution: previous.exitExecution,
      acceptedResultDigest: previous.acceptedResultDigest, acceptedResult },
  }, 4 * 1024 * 1024)) as RepeatEntryInput
}

/** Deterministic business rule over a fully parsed accepted envelope; not launch authority. */
export function decideRepeatExit(version: WorkflowVersionV3, occurrence: RepeatOccurrenceV1,
  execution: HarnessExecution, envelope: { routing: { outcome: string }; data: RepeatExitDataV1 }, decidedAt: string): RepeatDecisionV1 {
  const identity = occurrence.identity, block = repeatBlock(version, identity.blockId)
  assertRepeatExecution(version, identity.scope, { nodeId: block.exitNodeId, occurrence: identity }, execution)
  if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded' || !execution.finishedAt) repeatConflict('REPEAT_EXIT_NOT_ACCEPTED')
  const outcome = envelope.routing.outcome
  if (outcome !== block.earlyExitOutcome && outcome !== block.repeatOutcome) repeatConflict('REPEAT_OUTCOME_UNDECLARED')
  const early = outcome === block.earlyExitOutcome
  const reason = early ? 'early_exit' : identity.occurrenceIndex === block.maxOccurrences ? 'limit_exit' : 'repeat'
  const choice = version.definition.nodes.find((node) => node.id === block.exitNodeId)!.choice!
  const target = early ? choice.outcomes.find((item) => item.outcome === outcome)!.target
    : reason === 'limit_exit' ? block.limitExit
      : { kind: 'next_occurrence' as const, entryNodeId: block.entryNodeId, occurrenceIndex: identity.occurrenceIndex + 1 }
  const acceptedResultDigest = repeatDigest(execution.result, 64 * 1024)
  return { contractVersion: 1, decisionId: repeatId('repeat-decision', identity.occurrenceId, execution.id, acceptedResultDigest),
    occurrence, exitExecution: { ...repeatExecutionIdentity(execution), occurrence: identity }, acceptedResultDigest,
    outcome, reason, target, decidedAt, resultData: envelope.data }
}

/** Only a FINAL decision can publish external relationship state. */
export function finalRepeatExport(version: WorkflowVersionV3, local: RepeatResolution,
  decision: RepeatDecisionV1): RepeatResolution {
  if (decision.reason === 'repeat' || decision.target.kind === 'next_occurrence') repeatConflict('REPEAT_EGRESS_UNRESOLVED')
  const { occurrence: exitOccurrence, ...exitExecution } = decision.exitExecution
  if (local.value.resolution !== 'succeeded' || local.ref.nodeId !== decision.exitExecution.workflowNodeId
    || !sameRepeatValue(local.value.execution, exitExecution)
    || !sameRepeatValue(exitOccurrence, decision.occurrence.identity)
    || !sameRepeatValue(local.ref.occurrence, decision.occurrence.identity)
    || local.value.execution?.executionId !== decision.exitExecution.executionId
    || local.value.acceptedResultDigest !== decision.acceptedResultDigest) repeatConflict('REPEAT_EXPORT_CONFLICT')
  const outgoing = version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === local.ref.nodeId)
  const selected = decision.target.kind === 'edge' ? [decision.target.relationshipId] : []
  return { ref: local.ref, deferredRelationshipIds: [], value: { ...local.value, outcome: decision.outcome,
    branchEnded: decision.target.kind === 'branch_end', selectedRelationshipIds: selected,
    unselectedRelationshipIds: outgoing.map((edge) => edge.id).filter((id) => !selected.includes(id)).sort(),
  } }
}

export function bindRepeatNodeInput(input: {
  version: WorkflowVersionV3; runInput: RunInput; recipient: HarnessExecution; ref: RepeatNodeRef;
  occurrence: RepeatOccurrenceV1 | null; entry: RepeatEntryInput | null; predecessors: RepeatSource[];
}): { input: RepeatNodeInput; digest: string; bindings: RepeatInputBinding[] } {
  const { ref, recipient, occurrence, entry } = input
  assertRepeatExecution(input.version, { workspaceId: input.version.workspaceId, workflowId: input.version.workflowId,
    workflowVersionId: input.version.id, runId: recipient.runId, executionSemanticsVersion: 3 }, ref, recipient)
  if (entry && !occurrence) repeatConflict('REPEAT_INPUT_OCCURRENCE_CONFLICT')
  if (occurrence && entry && !sameRepeatValue(input.runInput, entry.runInput)) repeatConflict('REPEAT_INPUT_DIGEST_CONFLICT')
  if (!sameRepeatValue(ref.occurrence, occurrence?.identity ?? null)) repeatConflict('REPEAT_INPUT_OCCURRENCE_CONFLICT')
  if (occurrence && (!entry || repeatDigest(entry, 4 * 1024 * 1024) !== occurrence.input.inputDigest)) repeatConflict('REPEAT_INPUT_DIGEST_CONFLICT')
  const block = ref.occurrence ? repeatBlock(input.version, ref.occurrence.blockId) : undefined
  const predecessors = [...input.predecessors].sort((a, b) => a.relationshipId < b.relationshipId ? -1 : a.relationshipId > b.relationshipId ? 1 : 0)
  if (new Set(predecessors.map((source) => source.relationshipId)).size !== predecessors.length) repeatConflict('REPEAT_INPUT_DUPLICATE')
  if (ref.occurrence && predecessors.some((source) => !sameRepeatValue(source.occurrence, ref.occurrence))) repeatConflict('REPEAT_CROSS_OCCURRENCE_JOIN')
  for (const source of predecessors) {
    const relationship = input.version.definition.edges.find((edge) => edge.id === source.relationshipId)
    if (!relationship || relationship.kind !== 'execution' || relationship.source !== source.execution.workflowNodeId
      || relationship.target !== ref.nodeId || source.acceptedResult.outcome !== 'succeeded'
      || repeatDigest(source.acceptedResult, 64 * 1024) !== source.acceptedResultDigest) repeatConflict('REPEAT_BINDING_CONFLICT')
  }
  const value = JSON.parse(canonicalGraphJson({ executionSemanticsVersion: 3, runInput: input.runInput,
    occurrence, entry: block?.entryNodeId === ref.nodeId ? entry : null, predecessors }, 4 * 1024 * 1024)) as RepeatNodeInput
  const digest = repeatDigest(value, 4 * 1024 * 1024)
  const sources: Array<{ source: RepeatInputBinding['source']; kind: RepeatInputBinding['kind'] }> = predecessors.map((source) => ({ source, kind: 'predecessor' }))
  if (value.entry) {
    sources.push(...value.entry.external.map((source) => ({ source, kind: 'external' as const })))
    if (value.entry.carry) sources.push({ source: value.entry.carry, kind: 'carry' })
  }
  return { input: value, digest, bindings: sources.map(({ source, kind }, ordinal) => ({
    bindingId: repeatId('repeat-binding', recipient.id, kind, ordinal), recipient: repeatExecutionIdentity(recipient),
    recipientOccurrence: ref.occurrence, inputDigest: digest, source, kind, ordinal,
  })) }
}

export function repeatInternalEdges(version: WorkflowVersionV3, block: RepeatBlockV1): WorkflowRelationship[] {
  const members = new Set(block.nodeIds)
  return version.definition.edges.filter((edge) => edge.kind === 'execution' && members.has(edge.source) && members.has(edge.target))
}

export interface RepeatGraphLayout {
  nodes: Array<{ name: string; kind: 'once' | 'body' | 'enter' | 'advance' | 'done'; nodeId: string; blockId: string | null }>
  edges: Array<{ sources: string[]; target: string }>
  boundaries: Array<{ enter: string; advance: string; body: string; done: string; blockId: string }>
  start: string
  sinks: string[]
  recursionLimit: number
}
/** O(static graph size), not O(cap). Only the two guarded block boundaries can
 * feed a body entry again; authored edges remain an acyclic, immutable graph. */
export function compileRepeatLayout(version: WorkflowVersionV3): RepeatGraphLayout {
  const topology = compileExecutionTopology(version)
  const name = (kind: string, id: string) => repeatId(`repeat-${kind}`, id)
  const result: RepeatGraphLayout = { nodes: [], edges: [], boundaries: [], start: '', sinks: [], recursionLimit: 2 }
  const component = (id: string, outgoing: boolean) => {
    const block = blockForNode(version, id)
    return block ? name(outgoing ? 'done' : 'enter', block.id) : name('once', id)
  }
  const outerEntries: string[] = []
  for (const id of topology.order) {
    const block = blockForNode(version, id)
    if (!block) {
      result.nodes.push({ name: name('once', id), kind: 'once', nodeId: id, blockId: null })
      outerEntries.push(id)
      result.recursionLimit++
      continue
    }
    result.nodes.push({ name: name('body', id), kind: 'body', nodeId: id, blockId: block.id })
    const sources = repeatInternalEdges(version, block).filter((edge) => edge.target === id).map((edge) => name('body', edge.source))
    if (sources.length) result.edges.push({ sources: [...new Set(sources)], target: name('body', id) })
    if (id !== block.entryNodeId) continue
    outerEntries.push(id)
    for (const kind of ['enter', 'advance', 'done'] as const) result.nodes.push({ name: name(kind, block.id), kind, nodeId: id, blockId: block.id })
    result.boundaries.push({ enter: name('enter', block.id), advance: name('advance', block.id),
      body: name('body', block.entryNodeId), done: name('done', block.id), blockId: block.id })
    result.edges.push({ sources: [name('body', block.exitNodeId)], target: name('advance', block.id) })
    result.recursionLimit += 2 + block.maxOccurrences * (block.nodeIds.length + 1)
  }
  for (const id of outerEntries) {
    const sources = topology.incoming.get(id)!.map((edge) => component(edge.source, true))
    if (sources.length) result.edges.push({ sources: [...new Set(sources)], target: component(id, false) })
  }
  result.start = component(version.entryNodeId, false)
  result.sinks = [...new Set(topology.sinks.map((id) => component(id, true)))]
  if (!Number.isSafeInteger(result.recursionLimit)) repeatConflict('REPEAT_EXECUTION_BUDGET_INVALID')
  return result
}

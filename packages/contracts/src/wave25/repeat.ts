import { RepeatExitDataV1Schema, parseCoordinationResult, type CoordinationResultContext,
  type ResultProtocol } from '../coordinationResult.js'
import { z } from 'zod'
import { AgentConfigurationVersionSchema, TimestampSchema } from '../index.js'
import type { WorkflowArtifactOutputsV1 } from '../workflowArtifactDeclarations.js'
import { canonicalGraphJson } from './json.js'
import {
  GraphDigestSchema, extendGraphExecutionIdentitySchema, GraphIdSchema,
} from './graphPrimitives.js'
import {
  ChoiceOutcomeSchema, ChoiceTargetSchema,
  parseChoiceResultEnvelope, type WorkflowChoice,
} from './currentResult.js'
import {
  CurrentWorkflowVersionBaseSchema, CurrentWorkflowRunSchema, CurrentRunScopeSchema,
  validateCurrentWorkflowTopology, validateCurrentWorkflowConfigurations, AcceptedCurrentNodeResultSchema,
} from './currentWorkflowFoundation.js'

export {
  REPEAT_CONTRACT_VERSION, REPEAT_EXECUTION_SEMANTICS_VERSION, RepeatBlockV1Schema, RepeatPlanV1Schema,
} from './workflowShape.js'
export type { RepeatBlockV1, RepeatPlanV1 } from './workflowShape.js'
import { REPEAT_CONTRACT_VERSION, WorkflowDefinitionV3Schema } from './workflowShape.js'
const Ordinal = z.number().int().min(1).max(2147483647)
const Header = { contractVersion: z.literal(REPEAT_CONTRACT_VERSION) }

/** ONE current V3 family. Omission is the canonical no-repeat representation.
 * Null/empty plans are invalid. No default, transform or fake occurrence is made. */
export const RepeatWorkflowVersionV1Schema = CurrentWorkflowVersionBaseSchema.extend({
  definition: WorkflowDefinitionV3Schema,
}).strict().superRefine((version, context) => {
  validateCurrentWorkflowTopology(version, context)
  const { repeat, ...definition } = version.definition
  if (repeat === undefined || !definition.executionPolicy) return
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const edges = definition.edges.filter((edge) => edge.kind === 'execution')
  let requiredExecutions = definition.nodes.length
  for (const [index, block] of repeat.blocks.entries()) {
    const fail = (message: string) => context.addIssue({ code: 'custom', path: ['definition', 'repeat', 'blocks', index], message })
    const members = new Set(block.nodeIds)
    if (block.nodeIds.some((id) => !nodes.has(id))) { fail('REPEAT_UNKNOWN_MEMBER'); continue }
    const internal = edges.filter((edge) => members.has(edge.source) && members.has(edge.target))
    const reachable = (start: string, backwards = false) => {
      const seen = new Set<string>(), queue = [start]
      for (let head = 0; head < queue.length; head++) {
        const id = queue[head]!
        if (seen.has(id)) continue
        seen.add(id)
        for (const edge of internal) {
          if ((backwards ? edge.target : edge.source) === id) queue.push(backwards ? edge.source : edge.target)
        }
      }
      return seen
    }
    const fromEntry = reachable(block.entryNodeId), toExit = reachable(block.exitNodeId, true)
    if (block.nodeIds.some((id) => !fromEntry.has(id) || !toExit.has(id))) fail('REPEAT_SCOPE_MUST_BE_SINGLE_ENTRY_EXIT')
    for (const edge of edges) {
      if (!members.has(edge.source) && members.has(edge.target) && edge.target !== block.entryNodeId) fail('REPEAT_SIDE_ENTRY_UNSUPPORTED')
      if (members.has(edge.source) && !members.has(edge.target) && edge.source !== block.exitNodeId) fail('REPEAT_SIDE_EXIT_UNSUPPORTED')
      if (edge.source === block.exitNodeId && members.has(edge.target)) fail('REPEAT_EXIT_REENTERS_SCOPE')
    }
    const choice = nodes.get(block.exitNodeId)!.choice
    const again = choice?.outcomes.find((item) => item.outcome === block.repeatOutcome)
    const early = choice?.outcomes.find((item) => item.outcome === block.earlyExitOutcome)
    if (!again || !early || choice?.outcomes.length !== 2) fail('REPEAT_EXIT_REQUIRES_EXACTLY_TWO_DECLARED_OUTCOMES')
    if (again && canonicalGraphJson(again.target) !== canonicalGraphJson(block.limitExit)) fail('REPEAT_LIMIT_ROUTE_MISMATCH')
    // This first contract does not support a selected path silently bypassing its decision.
    for (const nodeId of block.nodeIds) {
      if (nodeId !== block.exitNodeId && nodes.get(nodeId)!.choice?.outcomes.some((item) => item.target.kind === 'branch_end')) fail('REPEAT_INTERIOR_BRANCH_END_UNSUPPORTED')
    }
    requiredExecutions += (block.maxOccurrences - 1) * block.nodeIds.length
  }
  if (!Number.isSafeInteger(requiredExecutions) || definition.executionPolicy!.maxNodeExecutions < requiredExecutions) {
    context.addIssue({ code: 'custom', path: ['definition', 'executionPolicy', 'maxNodeExecutions'], message: 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT' })
  }
})
export type RepeatWorkflowVersionV1 = z.infer<typeof RepeatWorkflowVersionV1Schema>

/** Exact scoped configuration/role/native-approval checks on the V3 value. */
export const ExecutableRepeatWorkflowV1Schema = z.object({
  version: RepeatWorkflowVersionV1Schema,
  configurations: z.array(AgentConfigurationVersionSchema).max(1000),
}).strict().superRefine(validateCurrentWorkflowConfigurations)
type ExecutableRepeatWorkflowV1 = z.infer<typeof ExecutableRepeatWorkflowV1Schema>

const executableWorkflowPinsSchema = z.custom<ExecutableRepeatWorkflowV1>()
  .superRefine(validateCurrentWorkflowConfigurations)

/** Checks execution compatibility after the version and configurations have been parsed. */
export function assertExecutableWorkflow(snapshot: ExecutableRepeatWorkflowV1): void {
  executableWorkflowPinsSchema.parse(snapshot)
}

/** Same current Run lifecycle schema for ordinary work and real configured blocks.
 * The V1 suffix versions only the repeat contract, never execution semantics. */
export const RepeatWorkflowRunV1Schema = CurrentWorkflowRunSchema
export const RepeatRunVersionV1Schema = z.object({
  run: RepeatWorkflowRunV1Schema, version: RepeatWorkflowVersionV1Schema,
}).strict().superRefine(({ run, version }, context) => {
  if (run.workspaceId !== version.workspaceId || run.workflowId !== version.workflowId
    || run.workflowVersionId !== version.id
    || canonicalGraphJson(run.agentConfigurationVersionIds) !== canonicalGraphJson(version.agentConfigurationVersionIds)
    || canonicalGraphJson(run.approval ?? null) !== canonicalGraphJson(version.approval)
    || canonicalGraphJson(run.executionCondition) !== canonicalGraphJson(version.definition.executionCondition)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_RUN_VERSION_PIN_MISMATCH' })
  }
})

/** One fixed carry/exit payload, not an expression or configurable mapping language. */
export { RepeatExitDataV1Schema, type RepeatExitDataV1 } from '../coordinationResult.js'

/** Complete successful accepted results only. The exact native {text} carrier
 * is a parsing-only view, matching the existing one-shot choice policy. Validate
 * and bound the ORIGINAL result first; acceptance, digests, carries and history
 * retain that original value. Mixed carriers, prose and Markdown stay invalid.
 */
export function parseRepeatExitResultV1(result: unknown, choice: WorkflowChoice, artifactOutputs?: WorkflowArtifactOutputsV1,
  coordination?: CoordinationResultContext) {
  canonicalGraphJson(result, 64 * 1024)
  const accepted = AcceptedCurrentNodeResultSchema.parse(result)
  const output = accepted.outcome === 'succeeded' ? accepted.output : undefined
  if (coordination) {
    const envelope = parseCoordinationResult(output, coordination)
    if (!('routing' in envelope) || !('outcome' in envelope.routing) || typeof envelope.routing.outcome !== 'string') {
      throw new Error('REPEAT_EXIT_OUTCOME_REQUIRED')
    }
    return { ...envelope, routing: { outcome: envelope.routing.outcome }, data: RepeatExitDataV1Schema.parse(envelope.data) }
  }
  const textCarrier = output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string'
  const envelope = parseChoiceResultEnvelope(!artifactOutputs && textCarrier ? { ...accepted, output: output.text } : accepted, choice, artifactOutputs)
  return { ...envelope, data: RepeatExitDataV1Schema.parse(envelope.data) }
}

export const RepeatOccurrenceIdentityV1Schema = z.object({
  scope: CurrentRunScopeSchema,
  blockId: GraphIdSchema, occurrenceId: GraphIdSchema, occurrenceIndex: Ordinal,
}).strict()
export type RepeatOccurrenceIdentityV1 = z.infer<typeof RepeatOccurrenceIdentityV1Schema>

/** attempt belongs to an execution INSIDE an occurrence, never to the repeat counter. */
export const RepeatExecutionIdentityV1Schema = extendGraphExecutionIdentitySchema({
  occurrence: RepeatOccurrenceIdentityV1Schema,
})
export type RepeatExecutionIdentityV1 = z.infer<typeof RepeatExecutionIdentityV1Schema>

/** Immutable private input reference. Payload and exact selected bindings live in durable storage. */
export const RepeatOccurrenceV1Schema = z.object({
  ...Header, identity: RepeatOccurrenceIdentityV1Schema,
  input: z.object({
    bindingId: GraphIdSchema, inputDigest: GraphDigestSchema,
    /** Null only for occurrence 1; entry input captures selected external inputs and Run input. */
    previous: z.object({
      occurrenceId: GraphIdSchema, occurrenceIndex: Ordinal,
      decisionId: GraphIdSchema, acceptedResultDigest: GraphDigestSchema,
    }).strict().nullable(),
  }).strict(),
}).strict().superRefine(({ identity, input }, context) => {
  const previous = input.previous
  if (identity.occurrenceIndex === 1 ? previous !== null
    : !previous || previous.occurrenceIndex !== identity.occurrenceIndex - 1 || previous.occurrenceId === identity.occurrenceId) {
    context.addIssue({ code: 'custom', path: ['input', 'previous'], message: 'REPEAT_INPUT_ANCESTRY_INVALID' })
  }
})
export type RepeatOccurrenceV1 = z.infer<typeof RepeatOccurrenceV1Schema>

const DecisionShape = z.object({
  ...Header, decisionId: GraphIdSchema, occurrence: RepeatOccurrenceV1Schema,
  exitExecution: RepeatExecutionIdentityV1Schema, acceptedResultDigest: GraphDigestSchema,
  outcome: ChoiceOutcomeSchema, reason: z.enum(['repeat', 'early_exit', 'limit_exit']),
  target: z.union([ChoiceTargetSchema, z.object({
    kind: z.literal('next_occurrence'), entryNodeId: GraphIdSchema, occurrenceIndex: Ordinal,
  }).strict()]),
  decidedAt: TimestampSchema,
}).strict()
/** Content-free projection; NOT registered in the existing graph protocol or HTTP/MCP. */
function checkDecisionShape(value: z.infer<typeof DecisionShape>, context: z.RefinementCtx): void {
  const identity = value.occurrence.identity
  const next = value.target.kind === 'next_occurrence'
  if ((value.reason === 'repeat') !== next
    || (value.target.kind === 'next_occurrence' && value.target.occurrenceIndex !== identity.occurrenceIndex + 1)
    || canonicalGraphJson(value.exitExecution.occurrence) !== canonicalGraphJson(identity)) {
    context.addIssue({ code: 'custom', message: 'REPEAT_DECISION_IDENTITY_OR_TARGET_INVALID' })
  }
}
export const RepeatDecisionMetadataV1Schema = DecisionShape.superRefine(checkDecisionShape)
export type RepeatDecisionMetadataV1 = z.infer<typeof RepeatDecisionMetadataV1Schema>
export const RepeatDecisionV1Schema = DecisionShape.extend({ resultData: RepeatExitDataV1Schema }).strict().superRefine(checkDecisionShape)
export type RepeatDecisionV1 = z.infer<typeof RepeatDecisionV1Schema>

/** Checks an already-recorded decision against its immutable version and exact loaded result.
 * No launch/admission/Stop/native/ownership proof is supplied by this pure validator.
 * Caller must authenticate the source execution, recompute its digest, and load durable inputs.
 */
export function validateRepeatDecisionV1(versionValue: unknown, decisionValue: unknown, acceptedResult: unknown,
  resultProtocol?: ResultProtocol): RepeatDecisionV1 {
  const version = RepeatWorkflowVersionV1Schema.parse(versionValue)
  const decision = RepeatDecisionV1Schema.parse(decisionValue)
  const { scope, blockId, occurrenceIndex } = decision.occurrence.identity
  const block = version.definition.repeat?.blocks.find((candidate) => candidate.id === blockId)
  if (!block || scope.workflowVersionId !== version.id || scope.workspaceId !== version.workspaceId
    || scope.workflowId !== version.workflowId || occurrenceIndex > block.maxOccurrences) throw new Error('REPEAT_DECISION_SCOPE_INVALID')
  const exit = version.definition.nodes.find((node) => node.id === block.exitNodeId)!
  if (decision.exitExecution.workflowNodeId !== exit.id || (decision.exitExecution.kind==='job'
      ? exit.kind!=='job'||decision.exitExecution.jobDefinitionId!==exit.jobDefinitionId||decision.exitExecution.jobDefinitionVersionId!==exit.jobDefinitionVersionId
      : exit.kind==='job'||decision.exitExecution.agentId!==exit.agentId||decision.exitExecution.agentConfigurationVersionId!==version.agentConfigurationVersionIds[exit.agentId])
) throw new Error('REPEAT_EXIT_EXECUTION_PIN_INVALID')
  const envelope = parseRepeatExitResultV1(acceptedResult, exit.choice!, exit.kind === 'job' ? undefined : exit.artifactOutputs,
    resultProtocol && exit.kind !== 'job' ? { resultProtocol, definition: version.definition, workflowNodeId: exit.id } : undefined)
  if (decision.outcome !== envelope.routing.outcome || canonicalGraphJson(decision.resultData) !== canonicalGraphJson(envelope.data)) throw new Error('REPEAT_ACCEPTED_RESULT_MISMATCH')
  const early = decision.outcome === block.earlyExitOutcome
  const reason = early ? 'early_exit' : occurrenceIndex === block.maxOccurrences ? 'limit_exit' : 'repeat'
  const target = early ? exit.choice!.outcomes.find((item) => item.outcome === block.earlyExitOutcome)!.target
    : reason === 'limit_exit' ? block.limitExit
      : { kind: 'next_occurrence', entryNodeId: block.entryNodeId, occurrenceIndex: occurrenceIndex + 1 }
  if (decision.reason !== reason || canonicalGraphJson(decision.target) !== canonicalGraphJson(target)) throw new Error('REPEAT_ROUTE_PROVENANCE_INVALID')
  return decision
}

/** Adjacent immutable-link validation only; previous must come from authoritative storage.
 * A recorded repeat decision is NOT permission to launch after Stop or uncertain cleanup.
 */
export function validateRepeatSuccessorV1(versionValue: unknown, previousValue: unknown, nextValue: unknown, acceptedResult: unknown,
  resultProtocol?: ResultProtocol): RepeatOccurrenceV1 {
  const previous = validateRepeatDecisionV1(versionValue, previousValue, acceptedResult, resultProtocol)
  const next = RepeatOccurrenceV1Schema.parse(nextValue)
  const before = previous.occurrence.identity, after = next.identity, source = next.input.previous
  if (previous.reason !== 'repeat' || previous.target.kind !== 'next_occurrence'
    || canonicalGraphJson(before.scope) !== canonicalGraphJson(after.scope) || before.blockId !== after.blockId
    || after.occurrenceIndex !== before.occurrenceIndex + 1 || previous.target.occurrenceIndex !== after.occurrenceIndex
    || before.occurrenceId === after.occurrenceId || previous.occurrence.input.bindingId === next.input.bindingId
    || !source || source.occurrenceId !== before.occurrenceId || source.occurrenceIndex !== before.occurrenceIndex
    || source.decisionId !== previous.decisionId || source.acceptedResultDigest !== previous.acceptedResultDigest) throw new Error('REPEAT_SUCCESSOR_PROVENANCE_INVALID')
  return next
}

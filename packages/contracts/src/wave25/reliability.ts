import { z } from 'zod'
import { TimestampSchema } from '../index.js'
import {
  GraphDigestSchema, GraphEvidenceSchema, GraphIdSchema, GraphSequenceSchema,
  GraphNodeStateSchema, GraphRunStateSchema, RunGraphScopeSchema, sameGraphScope, GraphEffectIdentitySchema,
} from './graphPrimitives.js'
import { NativeGraphProjectionKeySchema } from './storage.js'
import { canonicalGraphJson } from './json.js'

/** A reference to EXISTING authority. These fields do not acquire a lease or grant permissions. */
export const GraphEffectFenceSchema = z.object({
  scope: RunGraphScopeSchema, effect: GraphEffectIdentitySchema, effectDigest: GraphDigestSchema,
  ownerId: GraphIdSchema, fence: GraphSequenceSchema,
  connectionGeneration: GraphSequenceSchema.nullable(),
}).strict()
export type GraphEffectFence = z.infer<typeof GraphEffectFenceSchema>
const NativeSubmissionStateSchema = z.enum(['unknown', 'not_submitted', 'uncertain', 'acknowledged', 'settled'])
export const GraphEffectAccessStateSchema = GraphEffectFenceSchema.extend({
  ownership: z.enum(['held', 'lost']), access: z.enum(['effect', 'observe']),
  security: z.enum(['valid', 'invalid', 'unknown']),
  /** Existing domain subject is closed to THIS effect, not merely a finished native turn. */
  effectClosed: z.boolean(), submission: NativeSubmissionStateSchema,
}).strict()
export type GraphEffectAccessState = z.infer<typeof GraphEffectAccessStateSchema>

/** Called on locked, current authority, never on a cached lease or model-supplied permission. */
export function assertGraphEffectAuthority(expectedInput: GraphEffectFence, currentInput: unknown): void {
  const expected = GraphEffectFenceSchema.parse(expectedInput)
  const result = GraphEffectAccessStateSchema.safeParse(currentInput)
  if (!result.success) throw new Error('GRAPH_AUTHORITY_INVALID')
  const current = result.data
  if (!sameGraphScope(expected.scope, current.scope)
    || canonicalGraphJson(expected.effect) !== canonicalGraphJson(current.effect)) throw new Error('GRAPH_SCOPE_MISMATCH')
  if (current.effectDigest !== expected.effectDigest) throw new Error('GRAPH_EFFECT_CONFLICT')
  if (current.ownership !== 'held' || current.ownerId !== expected.ownerId) throw new Error('GRAPH_OWNER_LOST')
  if (current.fence !== expected.fence) throw new Error('GRAPH_STALE_FENCE')
  if (current.connectionGeneration !== expected.connectionGeneration) throw new Error('GRAPH_STALE_GENERATION')
  if (current.access !== 'effect') throw new Error('GRAPH_EFFECT_ACCESS_DENIED')
  if (current.security !== 'valid') throw new Error('GRAPH_SECURITY_UNQUALIFIED')
  if (current.effectClosed && !['review.settle', 'run.stop'].includes(expected.effect.kind)) throw new Error('GRAPH_TERMINAL_CONFLICT')
  if (['execution.launch', 'approval.deliver'].includes(expected.effect.kind)
    && current.submission !== 'not_submitted') throw new Error('GRAPH_SUBMISSION_NOT_REPLAYABLE')
}

/** Native side effects MAY have happened even without an acknowledgement. No retry decision is implicit. */
export function nativeSubmissionRecovery(state: z.infer<typeof NativeSubmissionStateSchema>): 'observe' | 'eligible' | 'reconcile' | 'settle' {
  switch (NativeSubmissionStateSchema.parse(state)) {
    case 'unknown': return 'observe'
    case 'not_submitted': return 'eligible' // still requires current security, Stop and owner checks
    case 'uncertain': case 'acknowledged': return 'reconcile'
    case 'settled': return 'settle'
  }
}

export const NativeTerminalEvidenceSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'canceled', 'interrupted']),
  evidenceKind: z.enum(['provider_terminal', 'persisted_terminal']),
  evidenceId: GraphIdSchema,
  // A persisted abnormal execution disposition does not prove the native process closed.
  nativeSettled: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.outcome === 'succeeded' && !value.nativeSettled) context.addIssue({ code: 'custom', message: 'success requires confirmed native terminal evidence' })
})
export const NativeWorkReliabilitySchema = z.object({
  submission: NativeSubmissionStateSchema, submissionId: GraphIdSchema.nullable(),
  terminal: NativeTerminalEvidenceSchema.nullable(), stopRequested: z.boolean(),
}).strict().superRefine((value, context) => {
  if (['uncertain', 'acknowledged', 'settled'].includes(value.submission) && !value.submissionId) context.addIssue({ code: 'custom', message: 'submitted work retains its exact submission identity' })
  if (value.submission === 'settled' && !value.terminal?.nativeSettled) context.addIssue({ code: 'custom', message: 'settled submission requires positive native settlement evidence' })
  if (value.terminal?.outcome === 'succeeded' && !['acknowledged', 'settled'].includes(value.submission)) context.addIssue({ code: 'custom', message: 'unknown or uncertain submission is not success' })
})
type NativeWorkReliability = z.infer<typeof NativeWorkReliabilitySchema>
export function assertNativeWorkTransition(previousInput: NativeWorkReliability, nextInput: NativeWorkReliability): void {
  const previous = NativeWorkReliabilitySchema.parse(previousInput), next = NativeWorkReliabilitySchema.parse(nextInput)
  if (previous.stopRequested && !next.stopRequested) throw new Error('GRAPH_STOP_CONFLICT')
  if (previous.stopRequested && !previous.terminal && next.terminal?.outcome === 'succeeded') throw new Error('GRAPH_STOP_CONFLICT')
  if (previous.submissionId !== null && previous.submissionId !== next.submissionId) throw new Error('GRAPH_SOURCE_CONFLICT')
  const rank = { unknown: 0, not_submitted: 1, uncertain: 2, acknowledged: 3, settled: 4 }
  if (rank[next.submission] < rank[previous.submission]) throw new Error('GRAPH_SUBMISSION_NOT_REPLAYABLE')
  if (previous.terminal && (!next.terminal || previous.terminal.outcome !== next.terminal.outcome
    || previous.terminal.evidenceId !== next.terminal.evidenceId || previous.terminal.evidenceKind !== next.terminal.evidenceKind
    || (previous.terminal.nativeSettled && !next.terminal.nativeSettled))) throw new Error('GRAPH_TERMINAL_CONFLICT')
}

/** Normalized, complete observations. No raw frame, free-form prose, paths, arguments or keepalive-as-work. */
const ObservationFields = {
  scope: RunGraphScopeSchema, work: NativeGraphProjectionKeySchema,
  source: GraphEvidenceSchema, sourceStreamId: GraphIdSchema, sourcePosition: GraphSequenceSchema,
  connectionGeneration: GraphSequenceSchema, observedAt: TimestampSchema,
}
const NativeGraphObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...ObservationFields, kind: z.literal('transport'), transport: z.enum(['open', 'closed', 'keepalive']) }).strict(),
  z.object({ ...ObservationFields, kind: z.literal('submission'), submissionId: GraphIdSchema,
    state: z.enum(['uncertain', 'acknowledged']) }).strict(),
  z.object({ ...ObservationFields, kind: z.literal('terminal'), submissionId: GraphIdSchema,
    terminal: NativeTerminalEvidenceSchema }).strict(),
]).superRefine((value, context) => {
  if (value.source.sourceKind !== 'native_event') context.addIssue({ code: 'custom', message: 'normalized native observations retain native source identity' })
})
export type NativeGraphObservation = z.infer<typeof NativeGraphObservationSchema>
export const NATIVE_GRAPH_EVIDENCE_MAX_BYTES = 32768
/** Framing is adapter-owned. This function takes a complete structured value, never a JSON prefix. */
export function parseNativeGraphObservation(input: unknown): NativeGraphObservation {
  try { canonicalGraphJson(input, NATIVE_GRAPH_EVIDENCE_MAX_BYTES) } catch (error) {
    throw new Error(error instanceof Error && error.message === 'GRAPH_JSON_LIMIT' ? 'GRAPH_EVIDENCE_TOO_LARGE' : 'GRAPH_EVIDENCE_INVALID', { cause: error })
  }
  const parsed = NativeGraphObservationSchema.safeParse(input)
  if (!parsed.success) throw new Error('GRAPH_EVIDENCE_INVALID')
  return parsed.data
}

/** Ordering classification only, NOT a native projector or permission to discard late terminal evidence. */
const GraphSourceObservationSchema = z.object({
  scope: RunGraphScopeSchema, evidence: GraphEvidenceSchema, digest: GraphDigestSchema, streamId: GraphIdSchema, position: GraphSequenceSchema,
}).strict()
type GraphSourceObservation = z.infer<typeof GraphSourceObservationSchema>
export function classifyGraphObservation(previousInput: GraphSourceObservation, nextInput: GraphSourceObservation): 'duplicate' | 'earlier' | 'later' | 'independent' {
  const previous = GraphSourceObservationSchema.parse(previousInput), next = GraphSourceObservationSchema.parse(nextInput)
  if (!sameGraphScope(previous.scope, next.scope)) throw new Error('GRAPH_SCOPE_MISMATCH')
  if (canonicalGraphJson(previous.evidence) === canonicalGraphJson(next.evidence)) {
    if (previous.digest !== next.digest || previous.streamId !== next.streamId || previous.position !== next.position) throw new Error('GRAPH_SOURCE_CONFLICT')
    return 'duplicate'
  }
  if (previous.streamId !== next.streamId) return 'independent'
  if (previous.position === next.position) throw new Error('GRAPH_SOURCE_CONFLICT')
  return BigInt(next.position) < BigInt(previous.position) ? 'earlier' : 'later'
}

/** Shared validation, also used by the reference consumer; does not infer a terminal result. */
export function assertGraphRunTransition(previousInput: z.infer<typeof GraphRunStateSchema>, nextInput: z.infer<typeof GraphRunStateSchema>): void {
  const previous = GraphRunStateSchema.parse(previousInput), next = GraphRunStateSchema.parse(nextInput)
  if (previous.stopRequested && !next.stopRequested) throw new Error('GRAPH_STOP_CONFLICT')
  if (previous.stopRequested && previous.executionState !== 'completed' && next.outcome === 'succeeded') throw new Error('GRAPH_STOP_CONFLICT')
  if (previous.executionState === 'completed' && (next.executionState !== 'completed' || next.outcome !== previous.outcome)) throw new Error('GRAPH_TERMINAL_CONFLICT')
  if (previous.stopRequested && next.executionState !== previous.executionState && next.executionState !== 'completed'
    && next.executionState !== 'interrupted') throw new Error('GRAPH_STOP_CONFLICT')
}
export function assertGraphNodeTransition(previousInput: z.infer<typeof GraphNodeStateSchema>, nextInput: z.infer<typeof GraphNodeStateSchema>): void {
  const previous = GraphNodeStateSchema.parse(previousInput), next = GraphNodeStateSchema.parse(nextInput)
  if (previous.workflowNodeId !== next.workflowNodeId || (previous.execution && canonicalGraphJson(previous.execution) !== canonicalGraphJson(next.execution))) throw new Error('GRAPH_SCOPE_MISMATCH')
  if (['succeeded', 'failed', 'canceled', 'skipped', 'interrupted'].includes(previous.lifecycle)
    && next.lifecycle !== previous.lifecycle) throw new Error('GRAPH_TERMINAL_CONFLICT')
}


/** Existing projection-owner/session fence. Observation alone is not projection-write authority. */
export const NativeGraphProjectionFenceSchema = z.object({
  scope: RunGraphScopeSchema, key: NativeGraphProjectionKeySchema,
  ownerId: GraphIdSchema, fence: GraphSequenceSchema, connectionGeneration: GraphSequenceSchema,
}).strict()
export type NativeGraphProjectionFence = z.infer<typeof NativeGraphProjectionFenceSchema>
const NativeGraphProjectionAccessStateSchema = NativeGraphProjectionFenceSchema.extend({
  ownership: z.enum(['held', 'lost']), access: z.enum(['project', 'observe']),
}).strict()
export type NativeGraphProjectionAccessState = z.infer<typeof NativeGraphProjectionAccessStateSchema>
export function assertNativeGraphProjectionAuthority(expectedInput: NativeGraphProjectionFence, currentInput: unknown): void {
  const expected = NativeGraphProjectionFenceSchema.parse(expectedInput)
  const result = NativeGraphProjectionAccessStateSchema.safeParse(currentInput)
  if (!result.success) throw new Error('GRAPH_AUTHORITY_INVALID')
  const current = result.data
  if (!sameGraphScope(expected.scope, current.scope) || canonicalGraphJson(expected.key) !== canonicalGraphJson(current.key)) throw new Error('GRAPH_SCOPE_MISMATCH')
  if (current.ownership !== 'held' || expected.ownerId !== current.ownerId) throw new Error('GRAPH_OWNER_LOST')
  if (current.fence !== expected.fence) throw new Error('GRAPH_STALE_FENCE')
  if (current.connectionGeneration !== expected.connectionGeneration) throw new Error('GRAPH_STALE_GENERATION')
  if (current.access !== 'project') throw new Error('GRAPH_EFFECT_ACCESS_DENIED')
}

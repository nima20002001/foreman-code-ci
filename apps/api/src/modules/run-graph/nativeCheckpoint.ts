import { z } from 'zod'
import { GraphSequenceSchema, GraphIdSchema } from '@foreman-code/contracts/wave25'
import { NATIVE_PROJECTION_LIMITS, truncateNativeCheckpoint, type NativeProjectionState } from './nativeProjection.js'
import { RunGraphError } from './errors.js'
const internalId = z.string().min(1).max(NATIVE_PROJECTION_LIMITS.identityLength)
const schema = z.object({
  version: z.literal(1), bindingDigest: GraphIdSchema, generation: GraphSequenceSchema,
  boundTurnId: internalId.nullable(),
  evidenceFloor: z.object({ stream: internalId, position: GraphSequenceSchema, generation: GraphSequenceSchema }).strict().nullable(),
  transportFence: z.object({ stream: internalId, position: GraphSequenceSchema, generation: GraphSequenceSchema }).strict().nullable(),
  lastNativeSequence: GraphSequenceSchema.nullable(), terminalNativeSequence: GraphSequenceSchema.nullable(),
  acknowledgement: z.object({ id: GraphIdSchema, position: GraphSequenceSchema, stream: internalId, generation: GraphSequenceSchema }).strict().nullable(),
  disconnected: z.boolean(), uncertain: z.boolean(), overflow: z.boolean(),
  messages: z.array(z.object({ id: internalId, parent: internalId.nullable(), conflicted: z.boolean() }).strict()).max(NATIVE_PROJECTION_LIMITS.messages),
  operations: z.array(z.object({
    id: GraphIdSchema, messageId: internalId.nullable(), turnId: internalId.nullable(),
    action: z.enum(['working', 'reading_file', 'writing_file', 'creating_folder', 'using_tool', 'using_app_mcp', 'spawning_subagent', 'reviewing', 'waiting_approval']),
    position: GraphSequenceSchema, nativeSequence: GraphSequenceSchema, sourceId: GraphIdSchema,
    stream: internalId, generation: GraphSequenceSchema, pending: z.boolean(), ended: z.boolean(),
  }).strict()).max(NATIVE_PROJECTION_LIMITS.operations),
}).strict()
export function parseNativeCheckpoint(input: unknown): NativeProjectionState {
  try {
    const state = schema.parse(input)
    if (new Set(state.messages.map((message) => message.id)).size !== state.messages.length
      || new Set(state.operations.map((operation) => operation.id)).size !== state.operations.length
      || (state.terminalNativeSequence !== null && (state.lastNativeSequence === null
        || BigInt(state.terminalNativeSequence) > BigInt(state.lastNativeSequence)))) throw new Error('invalid checkpoint')
    return truncateNativeCheckpoint(state)
  } catch { throw new RunGraphError('GRAPH_INVARIANT_VIOLATION') }
}

import { z } from 'zod'
import type { DeviceApplicationResult } from './deviceApplication.js'
import { encodeWorkerMcpReference, decodeWorkerMcpReference } from './workerMcpReference.js'
export { WorkerConversationMcpRequestSchema, WorkerConversationMcpAuthorizationSchema,
  type WorkerConversationMcpRequest } from './workerConversationMcp.js'
import { DispatchIntentSchema, AcceptedNodePlacementSchema } from './nodePlacement.js'
import { WorkerNativeOutputOperationSchema } from './workerNativeOutput.js'
import { RemoteApplicationAccessSchema } from './remoteExecution.js'
import { TemporaryFileScopeSchema } from './files.js'
import { WORKER_MCP_EXTENSION, WORKER_MCP_RESPONSE_MAX_BYTES, WORKER_MCP_REQUEST_MAX_BYTES } from './workerMcpLimits.js'
export { WORKER_MCP_EXTENSION, WORKER_MCP_RESPONSE_MAX_BYTES, WORKER_MCP_REQUEST_MAX_BYTES } from './workerMcpLimits.js'
export const WorkerMcpRelayRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize-native-output'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    outputOperation: WorkerNativeOutputOperationSchema, nativeSessionId: z.string().min(1).max(500),
    turnId: z.string().min(1).max(500) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.authorize-native-output-declarations'),
    intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.native-output-readiness'),
    intent: DispatchIntentSchema, placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('worker-mcp.request'), intent: DispatchIntentSchema,
    placement: AcceptedNodePlacementSchema, applicationAccess: RemoteApplicationAccessSchema,
    body: z.json(), protocolVersion: z.string().max(64).optional() }).strict(),
])
export type WorkerMcpRelayRequest = z.infer<typeof WorkerMcpRelayRequestSchema>
export const WorkerMcpRelayAuthorizationSchema = z.object({ version: z.literal(1), mainId: z.uuid(),
  audience: z.literal('worker'), principalId: z.string().min(1), executionId: z.string().min(1), agentId: z.string().min(1),
  operationId: z.string().min(1), attemptId: z.string().min(1), bindingHash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime() }).strict()
export const WorkerMcpRelayResponseSchema = z.object({ statusCode: z.number().int().min(100).max(599),
  contentType: z.enum(['application/json', 'text/event-stream', 'empty']),
  body: z.string().max(WORKER_MCP_RESPONSE_MAX_BYTES) }).strict()
const WorkerMcpBinaryResponseSchema = WorkerMcpRelayResponseSchema.omit({ body: true }).extend({
  version: z.literal(2), bodyEncoding: z.literal('utf8'),
  bodyBytes: z.number().int().nonnegative().max(WORKER_MCP_RESPONSE_MAX_BYTES),
}).strict()

/** Measure the complete JSON carrier; escaped MCP bodies use the bounded binary channel. */
export function encodeWorkerMcpResult(payload: unknown): DeviceApplicationResult {
  if (!payload || typeof payload !== 'object' || !('statusCode' in payload) || !('body' in payload)) {
    return { payload }
  }
  const response = WorkerMcpRelayResponseSchema.parse(payload)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(response.body)
  if (bytes.byteLength > WORKER_MCP_RESPONSE_MAX_BYTES) throw new Error('MCP response exceeds its byte limit')
  if (encoder.encode(JSON.stringify(response)).byteLength <= WORKER_MCP_EXTENSION.maxJsonBytes) {
    return { payload: response }
  }
  const metadata = WorkerMcpBinaryResponseSchema.parse({ version: 2, bodyEncoding: 'utf8',
    statusCode: response.statusCode, contentType: response.contentType, bodyBytes: bytes.byteLength })
  if (encoder.encode(JSON.stringify(metadata)).byteLength > WORKER_MCP_EXTENSION.maxJsonBytes) {
    throw new Error('MCP response metadata exceeds its carrier limit')
  }
  return { payload: metadata, bytes }
}

export function decodeWorkerMcpResult(result: DeviceApplicationResult): unknown {
  const binary = result.payload && typeof result.payload === 'object' && 'bodyEncoding' in result.payload
  if (!binary && result.bytes === undefined) return result.payload
  const metadata = WorkerMcpBinaryResponseSchema.parse(result.payload)
  if (result.bytes === undefined || result.bytes.byteLength !== metadata.bodyBytes) {
    throw new Error('MCP binary response length differs from its metadata')
  }
  return WorkerMcpRelayResponseSchema.parse({ statusCode: metadata.statusCode, contentType: metadata.contentType,
    body: new TextDecoder('utf-8', { fatal: true }).decode(result.bytes) })
}

export const WorkerNativeOutputAuthorizationSchema = WorkerMcpRelayAuthorizationSchema.extend({
  outputOperation: WorkerNativeOutputOperationSchema, nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500),
  scope: TemporaryFileScopeSchema,
}).strict().refine(value => value.scope.chat.kind === 'agent' && value.scope.chat.agentId === value.agentId
  && value.scope.chat.executionId === value.executionId && value.scope.chat.runId !== undefined,
  'Native output requires the original workflow Agent file scope')
/** Permission to declare tools, before a native turn exists. This is not host qualification or mutation authority. */
export const WorkerNativeOutputDeclarationsPolicySchema = z.object({ agentConfigurationVersionId: z.string().min(1),
  outputOperations: z.tuple([z.literal('create'), z.literal('append'), z.literal('seal'), z.literal('publish')]) }).strict()
export const WorkerNativeOutputDeclarationsAuthorizationSchema = WorkerMcpRelayAuthorizationSchema
  .extend(WorkerNativeOutputDeclarationsPolicySchema.shape).strict()
export type WorkerNativeOutputDeclarationsPolicy = z.infer<typeof WorkerNativeOutputDeclarationsPolicySchema>
/** Readiness never grants a mutation or substitutes for operation authorization. */
export const WorkerNativeOutputReadinessSchema = WorkerMcpRelayAuthorizationSchema.extend({
  nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500), ready: z.boolean(),
}).strict()

const BinaryRequestSchema = z.object({
  operation: z.enum(['worker-mcp.request', 'conversation-mcp.request']),
  bodyEncoding: z.literal('utf8'), bodyBytes: z.number().int().nonnegative().max(WORKER_MCP_REQUEST_MAX_BYTES),
}).passthrough()

/** Large request bodies use the existing bounded binary carrier; credentials stay in the JSON envelope. */
export function encodeWorkerMcpRequest(raw: unknown): DeviceApplicationResult {
  const input = z.object({ body: z.json() }).passthrough().parse(raw)
  const encoded = new TextEncoder().encode(JSON.stringify(input))
  if (encoded.byteLength <= WORKER_MCP_EXTENSION.maxJsonBytes) return { payload: input }
  const reference = encodeWorkerMcpReference(input)
  if (reference) {
    if (new TextEncoder().encode(JSON.stringify(reference.payload)).byteLength > WORKER_MCP_EXTENSION.maxJsonBytes) {
      throw new Error('MCP request metadata exceeds its carrier limit')
    }
    return reference
  }
  const { body, ...envelope } = input
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const payload = BinaryRequestSchema.parse({ ...envelope, bodyEncoding: 'utf8', bodyBytes: bytes.byteLength })
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > WORKER_MCP_EXTENSION.maxJsonBytes) {
    throw new Error('MCP request metadata exceeds its carrier limit')
  }
  return { payload, bytes }
}

export function decodeWorkerMcpRequest(result: DeviceApplicationResult): unknown {
  if (result.bytes === undefined) {
    if (result.payload && typeof result.payload === 'object' && 'bodyEncoding' in result.payload) {
      throw new Error('MCP binary request bytes are missing')
    }
    return result.payload
  }
  if (result.payload && typeof result.payload === 'object'
    && 'bodyEncoding' in result.payload && result.payload.bodyEncoding === 'reference') {
    return decodeWorkerMcpReference(result)
  }
  const metadata = BinaryRequestSchema.parse(result.payload)
  const { bodyBytes, bodyEncoding, ...envelope } = metadata
  if (result.bytes.byteLength !== bodyBytes) throw new Error('MCP binary request length differs from its metadata')
  const body = JSON.parse(new TextDecoder(bodyEncoding, { fatal: true }).decode(result.bytes)) as unknown
  return { ...envelope, body: z.json().parse(body) }
}

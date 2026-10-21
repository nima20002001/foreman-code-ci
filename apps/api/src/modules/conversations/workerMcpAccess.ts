import { APP_MCP_TOKEN } from '../harnesses/appMcpLauncher.js'
import { WORKER_MCP_EXTENSION, decodeWorkerMcpResult, encodeWorkerMcpRequest, WorkerConversationMcpRequestSchema, WorkerConversationMcpAuthorizationSchema,
  WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { DomainError } from '../errors.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { withWorkerMcpDeadline, workerMcpUploadCeilingMs } from '../devices/workerMcpDeadline.js'
import type { DeviceApplicationRequestOptions } from '../devices/deviceApplicationChannel.js'

export async function prepareWorkerConversationMcp(input: {
  source: WorkerConversationRpcRequest
  token: string
  request(namespace: string, payload: unknown, options: DeviceApplicationRequestOptions & { signal: AbortSignal; timeoutMs: number }): Promise<DeviceApplicationResult>
  signal: AbortSignal
}) {
  const owner = input.source.binding.owner
  const access = 'applicationAccess' in input.source ? input.source.applicationAccess : undefined
  if (input.source.binding.appMcpAccess !== 'scoped' || !input.source.admissionId
    || owner.kind === 'agent' && access?.kind === 'operator-chat-mcp'
    || access && access.token !== input.token) {
    throw new DomainError('WORKER_CONVERSATION_MCP_DENIED', 'This chat has no matching admitted scoped credential.', 403)
  }
  const fields = { version: 1, binding: input.source.binding, token: input.token, admissionId: input.source.admissionId }
  input.signal.throwIfAborted()
  const authorization = WorkerConversationMcpRequestSchema.parse({ ...fields, operation: 'conversation-mcp.authorize' })
  const authorized = await input.request(WORKER_MCP_EXTENSION.namespace, authorization,
    { signal: input.signal, timeoutMs: deviceRequestTimeoutMs })
  input.signal.throwIfAborted()
  const lease = WorkerConversationMcpAuthorizationSchema.parse(decodeWorkerMcpResult(authorized))
  return { expiresAt: lease.expiresAt, environment: { agentId: owner.kind === 'operator' ? owner.operatorId : owner.agentId,
    variables: { [APP_MCP_TOKEN]: input.token } },
    async request(body: unknown, protocolVersion?: string, signal = input.signal) {
      signal.throwIfAborted()
      const payload = WorkerConversationMcpRequestSchema.parse({ ...fields, operation: 'conversation-mcp.request',
        body, ...(protocolVersion ? { protocolVersion } : {}) })
      const carrier = encodeWorkerMcpRequest(payload)
      const response = await withWorkerMcpDeadline((relaySignal, onUploaded, onUploadProgress, onUploadStarted) => input.request(
        WORKER_MCP_EXTENSION.namespace, carrier.payload, { signal: relaySignal, timeoutMs: deviceRequestTimeoutMs,
          ...(carrier.bytes ? { bytes: carrier.bytes, uploadTimeoutMs: workerMcpUploadCeilingMs } : {}),
          onUploaded, onUploadProgress, onUploadStarted }),
      signal, { uploading: carrier.bytes !== undefined })
      signal.throwIfAborted()
      return WorkerMcpRelayResponseSchema.parse(decodeWorkerMcpResult(response))
    } }
}

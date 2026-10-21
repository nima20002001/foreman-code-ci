import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import { RemoteApplicationAccessSchema, type RemoteApplicationAccess } from '@foreman-code/contracts/remote-execution'
import { WORKER_MCP_EXTENSION, decodeWorkerMcpResult, encodeWorkerMcpRequest, WorkerMcpRelayAuthorizationSchema, WorkerMcpRelayRequestSchema, WorkerMcpRelayResponseSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { ChildProcessEnvironment } from '../../harnesses/port.js'
import type { DeviceConnectionSupervisor } from '../../devices/connectionSupervisor.js'
import { deviceRequestTimeoutMs, retryDeviceRequest } from '../../devices/deviceRequestRetry.js'
import { withWorkerMcpDeadline, workerMcpUploadCeilingMs } from '../../devices/workerMcpDeadline.js'

/** Main reauthorizes the original lease on every request, including after owner renewal. */
export async function prepareWorkerApplicationAccess(channel: Pick<DeviceConnectionSupervisor, 'request'>,
  intent: DispatchIntent, placement: AcceptedNodePlacement, raw: RemoteApplicationAccess, signal?: AbortSignal,
  options?: { currentIntent(): DispatchIntent }) {
  const applicationAccess = RemoteApplicationAccessSchema.parse(raw)
  if (placement.payload.kind !== 'agent' || placement.hostRef.kind !== 'device'
    || applicationAccess.agentId !== placement.payload.agentId || applicationAccess.executionId !== intent.executionId
    || applicationAccess.operationId !== intent.operationId || applicationAccess.attemptId !== intent.attemptId
    || applicationAccess.bindingHash !== intent.bindingHash || placement.bindingHash !== intent.bindingHash
    || placement.mainId !== intent.mainId) throw new Error('Application access does not bind this original accepted execution')
  const envelope = () => ({ version: 1 as const, intent: options?.currentIntent() ?? intent, placement, applicationAccess })
  let principalId: string | undefined
  let expiresAt: string
  const refresh = async (refreshSignal = signal) => {
    refreshSignal?.throwIfAborted()
    const payload = WorkerMcpRelayRequestSchema.parse({ ...envelope(), operation: 'worker-mcp.authorize' })
    const authorized = await retryDeviceRequest(() => channel.request(WORKER_MCP_EXTENSION.namespace,
      payload, { ...(refreshSignal ? { signal: refreshSignal } : {}), timeoutMs: deviceRequestTimeoutMs }),
    { retry: 'idempotent', signal: refreshSignal })
    if (authorized.bytes !== undefined) throw new Error('Application lease authorization cannot contain binary bytes')
    const lease = WorkerMcpRelayAuthorizationSchema.parse(authorized.payload)
    if (lease.mainId !== intent.mainId || lease.agentId !== applicationAccess.agentId
      || lease.executionId !== intent.executionId || lease.operationId !== intent.operationId
      || lease.attemptId !== intent.attemptId || lease.bindingHash !== intent.bindingHash
      || principalId !== undefined && lease.principalId !== principalId
      || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('Original main application lease is unavailable')
    refreshSignal?.throwIfAborted()
    principalId ??= lease.principalId
    expiresAt = lease.expiresAt
    return expiresAt
  }
  await refresh()
  const environment: ChildProcessEnvironment = { agentId: applicationAccess.agentId, variables: { GRAPHQL_MCP_TOKEN: applicationAccess.token } }
  return { environment, get expiresAt() { return expiresAt }, refresh,
    async request(body: unknown, protocolVersion?: string, requestSignal?: AbortSignal) {
    requestSignal?.throwIfAborted()
    const payload = WorkerMcpRelayRequestSchema.parse({ ...envelope(), operation: 'worker-mcp.request', body,
      ...(protocolVersion ? { protocolVersion } : {}) })
    const carrier = encodeWorkerMcpRequest(payload)
    const response = await withWorkerMcpDeadline((relaySignal, onUploaded, onUploadProgress, onUploadStarted) => retryDeviceRequest(() => channel.request(WORKER_MCP_EXTENSION.namespace,
      carrier.payload, { signal: relaySignal, timeoutMs: deviceRequestTimeoutMs,
        ...(carrier.bytes ? { bytes: carrier.bytes, uploadTimeoutMs: workerMcpUploadCeilingMs } : {}),
        onUploaded, onUploadProgress, onUploadStarted }),
    { retry: 'admission', signal: relaySignal }), requestSignal, { uploading: carrier.bytes !== undefined })
    requestSignal?.throwIfAborted()
    return WorkerMcpRelayResponseSchema.parse(decodeWorkerMcpResult(response))
  } }
}

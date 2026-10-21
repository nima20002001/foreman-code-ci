import { RemoteExecutionRpcRequestSchema, REMOTE_EXECUTION_EXTENSION, REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationReceiptSchema, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { WorkspaceRootWorkerRequestSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import type { RootWorkerClient } from '../sources/rootHosts.js'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { RemoteNativeSessionManager, type RemoteNativeManagerOptions } from '../runs/remote/nativeManagerProxy.js'
import { readRemoteReceiptResponse } from '../runs/remote/installedWorkflowResponsePages.js'
import { VerifiedRemoteEvidence, type RemoteResultCommitPort } from '../runs/remote/resultBridge.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DomainError } from '../errors.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { isDeviceLinkDrop } from '../devices/deviceReconnect.js'

/** W07 returns the identity AND request closure of the SAME authenticated
 * channel instance. A presence label or separately looked-up mutable channel
 * is not enough to bind native responses to their originating connection. */
export interface AuthenticatedWorkerChannel {
  identity: DeviceConnectionIdentity
  readonly stopReadAdmission?: true
  supports?(namespace: string): boolean
  request(namespace: string, payload: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ payload: unknown; bytes?: Uint8Array }>
}
export interface MainWorkerCarrier {
  capture(deviceId: string): AuthenticatedWorkerChannel
  /** Resolves once the same Worker boot as `original` is connected again; otherwise throws `failure`, a revocation or DEVICE_LINK_DROPPED. */
  reconnect?(deviceId: string, original: DeviceConnectionIdentity, failure: unknown, signal?: AbortSignal): Promise<void>
}
function selected(carrier: MainWorkerCarrier, host: { kind: 'main' | 'device'; mainId: string; deviceId?: string },
  registration: { workerInstallationId: string; keyRevision: number; authorizationRevision: number } | null) {
  if (host.kind !== 'device' || !host.deviceId || !registration) throw new DomainError('REMOTE_BINDING_REQUIRED', 'A registered accepted device is required.', 409)
  const connection = carrier.capture(host.deviceId), identity = DeviceConnectionIdentitySchema.parse(connection.identity)
  if (identity.mainId !== host.mainId || identity.deviceId !== host.deviceId || identity.workerInstallationId !== registration.workerInstallationId
    || identity.keyRevision !== registration.keyRevision || identity.authorizationRevision !== registration.authorizationRevision) {
    throw new DomainError('REMOTE_CONNECTION_CONFLICT', 'The authenticated carrier does not match the accepted device registration.', 409)
  }
  return { identity, request: connection.request.bind(connection), supports: connection.supports?.bind(connection),
    stopReadAdmission: connection.stopReadAdmission }
}
export function rootWorkerCarrier(carrier: MainWorkerCarrier): RootWorkerClient {
  return { async request(host, registration, raw) {
    const request = WorkspaceRootWorkerRequestSchema.parse(raw)
    const connection = selected(carrier, host, registration)
    const result = await connection.request(WORKSPACE_ROOT_EXTENSION.namespace, request)
    if (result.bytes !== undefined) throw new DomainError('REMOTE_ROOT_RESPONSE_INVALID', 'Root metadata responses cannot contain arbitrary bytes.', 409)
    return result.payload
  } }
}
function receiptFromResponse(raw: unknown): RemoteOperationReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const status = value.status === 'known' ? value : value.status && typeof value.status === 'object' ? value.status as Record<string, unknown> : undefined
  if (status?.status !== 'known') return undefined
  return RemoteOperationReceiptSchema.parse(status.receipt)
}
/** Actual proxy construction over W07 execution-v1, with every receipt tied to
 * its authenticated response channel before B's branded canonical commit. */
export function remoteNativeManager(context: NativeManagerResolutionContext, binding: AcceptedExecutionBinding, options: {
  carrier: MainWorkerCarrier; commit(receipt: RemoteOperationReceipt, authenticated: DeviceConnectionIdentity, response: unknown): RemoteResultCommitPort | Promise<RemoteResultCommitPort>;
  beforePrepare(intent: AcceptedExecutionBinding['intent'], placement: AcceptedExecutionBinding['placement'], authenticated: DeviceConnectionIdentity): Promise<void>;
  controlFor: RemoteNativeManagerOptions['controlFor']
  readResponseControl?: NonNullable<RemoteNativeManagerOptions['readResponseControl']>
  authorizeResponseRetry?: NonNullable<RemoteNativeManagerOptions['authorizeResponseRetry']>
  observeOriginalSource?: NonNullable<RemoteNativeManagerOptions['observeOriginalSource']>
  workerExecution?: WorkerExecutionPolicy
  preparationTimeoutMs?: number
}): RemoteNativeSessionManager {
  if (binding.placement.payload.kind !== 'agent' || binding.placement.payload.agentId !== context.agentId
    || binding.placement.payload.agentConfigurationVersionId !== context.configuration.id) {
    throw new DomainError('REMOTE_BINDING_CONFLICT', 'Native manager allocation requires the accepted Agent configuration.', 409)
  }
  const sources = new Map<unknown, { connection: DeviceConnectionIdentity; response: unknown }>()
  let pendingSources = 0
  const workerExecution = options.workerExecution ?? new WorkerExecutionPolicy()
  // The Worker boot this manager last reached; only a reconnect of that boot may receive a replay.
  let reached: DeviceConnectionIdentity | undefined
  const takeSource = (response: unknown) => {
    const original = sources.get(response)
    sources.delete(response)
    if (!original) throw new DomainError('REMOTE_OBSERVATION_NOT_AUTHENTICATED', 'The receipt did not originate in this authenticated native proxy.', 403)
    return original
  }
  return new RemoteNativeSessionManager({ intent: binding.intent, placement: binding.placement, harness: context.harness,
    configuration: context.configuration, controlFor: options.controlFor,
    ...(options.readResponseControl ? { readResponseControl: options.readResponseControl } : {}),
    ...(options.authorizeResponseRetry ? { authorizeResponseRetry: options.authorizeResponseRetry } : {}),
    ...(options.observeOriginalSource ? { observeOriginalSource: options.observeOriginalSource } : {}),
    transport: { async request(method, raw, signal) {
      if (method === 'prepare' || method === 'start-turn') {
        workerExecution.requireEnabled(binding.placement.hostRef)
      }
      const request = RemoteExecutionRpcRequestSchema.parse(['prepare', 'capabilities', 'inspect-mcp'].includes(method) && binding.executionPlacement && raw && typeof raw === 'object'
        ? { ...raw, executionPlacement: binding.executionPlacement } : raw)
      if (request.method !== method || !sameWorkflowValue(request.placement, binding.placement)
        || request.intent.operationId !== binding.intent.operationId || request.intent.executionId !== binding.intent.executionId
        || request.intent.attemptId !== binding.intent.attemptId || request.intent.bindingHash !== binding.intent.bindingHash) {
        throw new DomainError('REMOTE_BINDING_CONFLICT', 'Native request cannot change its accepted operation or placement.', 409)
      }
      const connection = selected(options.carrier, binding.placement.hostRef, binding.placement.registration)
      const stopping = request.method === 'status' && request.forStop
        || request.method === 'receipt-continuation' && request.forStop
        || request.method === 'control' && request.command.action.kind === 'stop'
      if ((request.method === 'status' || request.method === 'receipt-continuation')
        && request.forStop && !connection.stopReadAdmission) delete request.forStop
      reached = connection.identity
      const continuesSession = request.method === 'prepare' && request.sessionContinuation !== undefined
      const namespace = continuesSession ? REMOTE_PREPARATION_EXTENSION.namespace : REMOTE_EXECUTION_EXTENSION
      if (continuesSession && !connection.supports?.(namespace)) {
        throw new DomainError('REMOTE_EXECUTION_INCOMPATIBLE',
          'Update the connected computer before continuing this workflow session.', 409)
      }
      if (['prepare', 'capabilities', 'inspect-mcp'].includes(method)) await options.beforePrepare(request.intent, request.placement, connection.identity)
      const preparesNative = ['prepare', 'reattach', 'capabilities', 'inspect-mcp'].includes(method)
      const requestOptions = { ...(signal ? { signal } : {}),
        timeoutMs: preparesNative && options.preparationTimeoutMs ? options.preparationTimeoutMs : deviceRequestTimeoutMs }
      const result = await connection.request(namespace, request, requestOptions)
      if (result.bytes !== undefined) throw new DomainError('REMOTE_NATIVE_RESPONSE_INVALID', 'Native metadata responses cannot contain arbitrary bytes.', 409)
      const response = await readRemoteReceiptResponse(result.payload, request.intent, async continuation => {
        const next = await connection.request(REMOTE_EXECUTION_EXTENSION, {
          method: 'receipt-continuation', intent: request.intent, placement: request.placement, ...continuation,
          ...(stopping && connection.stopReadAdmission ? { forStop: true } : {}),
        }, requestOptions)
        if (next.bytes !== undefined) {
          throw new DomainError('REMOTE_NATIVE_RESPONSE_INVALID', 'Native metadata responses cannot contain arbitrary bytes.', 409)
        }
        return next.payload
      }, signal)
      const receipt = receiptFromResponse(response)
      // History continuations supply bytes for the first page's observation, not another receipt observation.
      if (receipt && !(request.method === 'history' && request.metadata)) {
        if (pendingSources >= 32) throw new DomainError('REMOTE_RESPONSE_BACKPRESSURE', 'Uncommitted native receipt responses exceeded the bounded window.', 503)
        // Each request owns an envelope even when its carrier reuses a payload object.
        const observation = { ...response as Record<string, unknown> }
        sources.set(observation, { connection: connection.identity, response })
        pendingSources++
        return observation
      }
      return response
    },
    async reconnect(error, signal) {
      const hostRef = binding.placement.hostRef
      if (!options.carrier.reconnect || hostRef.kind !== 'device' || !reached || !isDeviceLinkDrop(error)) return false
      await options.carrier.reconnect(hostRef.deviceId, reached, error, signal)
      return true
    } },
    discardReceipt: response => {
      if (sources.delete(response)) pendingSources--
    },
    observeReceipt: async (receipt, response) => {
      const original = takeSource(response)
      try {
        const result = await VerifiedRemoteEvidence.commit(receipt, original.connection, await options.commit(receipt, original.connection, original.response))
        if (result === 'rejected') throw new DomainError('REMOTE_OBSERVATION_REJECTED', 'Main ownership rejected the original worker receipt.', 409)
      } finally { pendingSources-- }
    },
  })
}

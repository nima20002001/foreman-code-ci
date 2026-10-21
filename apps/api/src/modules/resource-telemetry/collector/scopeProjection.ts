import type { HarnessExecution, NativeSessionLane, NativeSessionReference } from '@foreman-code/contracts'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { JobExecution } from '@foreman-code/contracts/jobs'
import type { RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import { TelemetrySelectorSchema, telemetryCanonical, type TelemetryIdentity, type TelemetryOwner } from '@foreman-code/contracts/resource-telemetry'
import type { OCIHostCertificate } from '../../jobs/executorContainerOwner.js'
import type { TrustedNativeScope } from './registryAdapter.js'

const same = (a: unknown, b: unknown) => telemetryCanonical(a) === telemetryCanonical(b)
/** Supplied by the original owner under its active lease; never accepted from a telemetry frame. */
export interface CapturedScopeLease {
  nativeOwner: string
  lane: NativeSessionLane
  session: NativeSessionReference
  writer: { id: string; token: string; owner: string }
  shared: boolean
  lifecycle: TrustedNativeScope['lifecycle']
}
function activeLease(capture: CapturedScopeLease, nowUnixMs: number): boolean {
  const { lane, session, writer } = capture
  return !!capture.nativeOwner && lane.id === writer.id && !!writer.token && lane.leaseToken === writer.token
    && !!writer.owner && lane.leaseOwner === writer.owner && !!lane.leaseExpiresAt
    && Date.parse(lane.leaseExpiresAt) > nowUnixMs && lane.harness === session.harness
    && lane.nativeSessionId === session.nativeSessionId
}
function scope(identity: TelemetryIdentity, owner: TelemetryOwner, capture: CapturedScopeLease): TrustedNativeScope {
  return { nativeOwner: capture.nativeOwner, selector: TelemetrySelectorSchema.parse({ schemaVersion: 1, scope: 'owned', ...identity,
    owner, attributionRef: capture.lane.id, attributionRevision: String(capture.lane.revision) }) as TrustedNativeScope['selector'],
    leaseId: capture.lane.id, observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId,
    shared: capture.shared, lifecycle: capture.lifecycle }
}
function connectionMatches(identity: TelemetryIdentity, connection: RemoteJobOperationReceiptRecord['connection']): boolean {
  const h = identity.host
  if ('kind' in connection) return h.hostRef.kind === 'main' && connection.mainId === identity.mainId
    && connection.mainInstallationId === h.applicationInstallationId && connection.bootId === h.bootId
  return h.hostRef.kind === 'device' && connection.mainId === identity.mainId && connection.deviceId === h.deviceId
    && connection.workerInstallationId === h.applicationInstallationId && connection.bootId === h.bootId
    && connection.keyRevision === h.keyRevision && connection.authorizationRevision === h.authorizationRevision
    && connection.connectionGeneration === h.connectionGeneration
}
/** Exact accepted SQL snapshot and original resident capture. Mutable execution progress is excluded deliberately. */
function immutableExecution(e: HarnessExecution) {
  return { id: e.id, runId: e.runId, workflowNodeId: e.workflowNodeId, agentId: e.agentId,
    agentConfigurationVersionId: e.agentConfigurationVersionId, attempt: e.attempt, parallelGroupId: e.parallelGroupId ?? null,
    workingDirectory: e.workingDirectory ?? null, runtimeDirectory: e.runtimeDirectory ?? null, input: e.input, createdAt: e.createdAt }
}
export function projectAcceptedWorkflowScope(input: {
  identity: TelemetryIdentity; workspaceId: string; workflowId: string
  accepted: HarnessExecution; captured: HarnessExecution; placement: AcceptedNodePlacement; intent: DispatchIntent
  capture: CapturedScopeLease; nowUnixMs: number; receipt?: RemoteOperationReceipt
}): TrustedNativeScope | null {
  const { identity, accepted: e, captured, placement: p, intent: i, capture, receipt } = input
  if (!activeLease(capture, input.nowUnixMs) || !same(immutableExecution(e), immutableExecution(captured))
    || e.nativeSessionId !== capture.session.nativeSessionId || capture.lane.ownerAgentId !== e.agentId
    || e.id !== i.executionId || e.runId !== i.runId || e.workflowNodeId !== i.nodeId || e.attempt !== i.technicalAttempt
    || i.mainId !== identity.mainId || p.mainId !== identity.mainId || p.runId !== e.runId || p.nodeId !== e.workflowNodeId
    || p.bindingHash !== i.bindingHash || !same(p.hostRef, identity.host.hostRef) || p.payload.kind !== 'agent'
    || p.payload.agentId !== e.agentId || p.payload.agentConfigurationVersionId !== e.agentConfigurationVersionId) return null
  if (identity.host.hostRef.kind === 'device') {
    if (!receipt || !same(receipt.intent, i) || !receipt.native || receipt.native.sessionId !== capture.session.nativeSessionId
      || !connectionMatches(identity, receipt.connection) || !p.registration
      || p.registration.workerInstallationId !== identity.host.applicationInstallationId
      || p.registration.keyRevision !== identity.host.keyRevision || p.registration.authorizationRevision !== identity.host.authorizationRevision) return null
  } else if (receipt || p.mainInstallationId !== identity.host.applicationInstallationId || p.registration !== null) return null
  return scope(identity, { kind: 'workflow-execution', workspaceId: input.workspaceId, workflowId: input.workflowId,
    runId: e.runId, nodeId: e.workflowNodeId, agentId: e.agentId, executionId: i.executionId,
    attemptId: i.attemptId, operationId: i.operationId, bindingHash: i.bindingHash, owner: i.owner }, capture)
}
/** Conversation identity comes from its persisted owner row, never from native session/name correlation. */
export function projectConversationScope(input: {
  identity: TelemetryIdentity; owner: Extract<TelemetryOwner, { kind: 'agent-conversation' | 'operator-conversation' }>
  capture: CapturedScopeLease; nowUnixMs: number
}): TrustedNativeScope | null {
  if (!activeLease(input.capture, input.nowUnixMs) || input.owner.leaseId !== input.capture.lane.id
    || input.owner.kind === 'agent-conversation' && input.owner.agentId !== input.capture.lane.ownerAgentId) return null
  return scope(input.identity, input.owner, input.capture)
}
/** Existing OCI certificate + accepted job receipt only; qualifications are host overhead, never job owners. */
export function projectCIJobScope(input: {
  identity: TelemetryIdentity; receipt: RemoteJobOperationReceiptRecord; certificate: OCIHostCertificate
  nativeOwner: string; attributionRevision: string; shared: boolean; accepted: JobExecution
  lease: { id: string; owner: RemoteJobOperationReceiptRecord['intent']['owner']; expiresAt: string }; nowUnixMs: number
}): TrustedNativeScope | null {
  const { identity, receipt: r, certificate: c } = input, i = r.intent, s = c.scope, t = r.execution.acceptedSpec.target
  if (!('leaseId' in s) || s.subject.kind !== 'job') return null
  if (input.lease.id !== s.leaseId || !same(input.lease.owner, s.owner) || !(Date.parse(input.lease.expiresAt) > input.nowUnixMs)
    || !same({ id: input.accepted.id, workspaceId: input.accepted.workspaceId, acceptedSpec: input.accepted.acceptedSpec, workflow: input.accepted.workflow,
      attemptId: input.accepted.attemptId, operationId: input.accepted.operationId, owner: input.accepted.owner, createdAt: input.accepted.createdAt },
    { id: r.execution.id, workspaceId: r.execution.workspaceId, acceptedSpec: r.execution.acceptedSpec, workflow: r.execution.workflow,
      attemptId: r.execution.attemptId, operationId: r.execution.operationId, owner: r.execution.owner, createdAt: r.execution.createdAt })
    || !input.nativeOwner || !r.native || r.native.containerId !== c.containerId
    || !connectionMatches(identity, r.connection) || i.mainId !== identity.mainId
    || s.subject.executionId !== i.executionId || s.subject.attemptId !== i.attemptId
    || s.subject.operationId !== i.operationId || s.subject.bindingHash !== i.bindingHash || !same(s.owner, i.owner)
    || s.observedDeviceId !== identity.host.deviceId || s.observedInstallationId !== identity.host.applicationInstallationId
    || s.bootId !== identity.host.bootId || c.process.bootId !== s.bootId || c.helpers.some(h => h.process.bootId !== s.bootId)
    || t.mainId !== identity.mainId
    || (identity.host.hostRef.kind === 'main' ? t.registration !== null || t.mainInstallationId !== identity.host.applicationInstallationId
      : !t.registration || t.registration.workerInstallationId !== identity.host.applicationInstallationId
        || t.registration.keyRevision !== identity.host.keyRevision || t.registration.authorizationRevision !== identity.host.authorizationRevision)
    || r.execution.acceptedSpec.bindingHash !== i.bindingHash || !same(r.execution.acceptedSpec.target.hostRef, identity.host.hostRef)
    || (i.subject.kind === 'workflow-node' ? !same(r.execution.workflow, { workflowId: i.subject.workflowId, runId: i.subject.runId,
      nodeId: i.subject.nodeId, nodeExecutionId: i.subject.nodeExecutionId }) : r.execution.workflow !== null)
    || r.execution.id !== i.executionId || r.execution.attemptId !== i.attemptId || r.execution.operationId !== i.operationId
    || r.execution.workspaceId !== i.subject.workspaceId || !same(r.execution.owner, i.owner)) return null
  const owner: TelemetryOwner = { kind: 'ci-job', subject: i.subject, executionId: i.executionId, attemptId: i.attemptId,
    operationId: i.operationId, bindingHash: i.bindingHash, owner: i.owner }
  return { nativeOwner: input.nativeOwner, selector: TelemetrySelectorSchema.parse({ schemaVersion: 1, scope: 'owned', ...identity,
    owner, attributionRef: s.leaseId, attributionRevision: input.attributionRevision }) as TrustedNativeScope['selector'],
    leaseId: s.leaseId, observedDeviceId: s.observedDeviceId, observedInstallationId: s.observedInstallationId,
    shared: input.shared, lifecycle: c.lifecycle,
    captured: { launchIds: [c.containerId], roots: structuredClone([c.process, ...c.helpers.map(h => h.process)]),
      boundaries: structuredClone([c.boundary, ...c.helpers.flatMap(h => h.boundary ? [h.boundary] : [])]),
      incomplete: c.helpers.some(h => !h.boundary) } }
}

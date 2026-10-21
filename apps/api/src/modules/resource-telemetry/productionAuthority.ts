import { createHash } from 'node:crypto'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import type pg from 'pg'
import { HarnessExecutionSchema, NativeSessionLaneSchema, NativeSessionReferenceSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema, type RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { DeviceRegistrationSchema, DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import type { DevicePresence, DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceNegotiatedExtension } from '@foreman-code/contracts/device-application'
import {
  TELEMETRY_LIMITS, TelemetrySelectorSchema, telemetryCanonical, telemetrySelectorKey,
  type TelemetryHost, type TelemetryIdentity, type TelemetryOwner, type TelemetrySelector, type TelemetrySelectorTarget, type TrustedTelemetryContext,
} from '@foreman-code/contracts/resource-telemetry'
import { isAuthorized, type AuthorizedResource } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { readAcceptedPlacement, readDispatchIntent } from '../placement/persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import type { NativeLaunchObservation, PassiveNativeRegistry, TrustedNativeScope, TrustedNativeScopes } from './collector/registryAdapter.js'
import type { TelemetryOwnershipReader, TelemetryReadAuthority, TelemetrySessionReader } from './ingestion/ports.js'
import type { TelemetryOwnedTargetFacts, TelemetryTargetAuthority } from './readback/selector.js'

export interface CapturedTelemetryNativeOwner {
  execution: HarnessExecution
  session: NativeSessionReference
  writer: { id: string; token: string; connectionGeneration?: number }
  assertCurrent?(): void
  /** Captured recovery.owner from C's raw-manager WeakMap, never inferred from an ID prefix. */
  nativeOwner: string
}
/** Supplied only by the original remote native lifetime owner; never built from a telemetry payload. */
export interface CapturedRemoteTelemetryNativeOwner extends CapturedTelemetryNativeOwner {
  writer: CapturedTelemetryNativeOwner['writer'] & { connectionGeneration: number }
  binding: Readonly<DeviceSessionBinding>
  native: RemoteNativeIdentity
  assertCurrent(): void
}
export interface PassiveTelemetryServicesInput {
  pool: pg.Pool
  getNativeOwners(): readonly CapturedTelemetryNativeOwner[]
  getRemoteNativeOwners?(): readonly CapturedRemoteTelemetryNativeOwner[]
  mainContext(): Extract<TrustedTelemetryContext, { kind: 'main-local' }> | null
  mainActive(): boolean
  deviceBinding(deviceId: string): Readonly<DeviceSessionBinding> | null
  presence(deviceId: string): DevicePresence | null
  deviceCapabilities(deviceId: string): readonly DeviceNegotiatedExtension[]
  registry: PassiveNativeRegistry
}
type OwnedSelector = Extract<TelemetrySelector, { scope: 'owned' }>
interface ScopeFacts extends TelemetryOwnedTargetFacts {
  nativeOwner: string
  leaseId: string
  leaseExpiresAt: string
  state: TrustedNativeScope['lifecycle']
  sharedOwners: TelemetryOwner[]
}
const signature = (value: unknown) => createHash('sha256').update(telemetryCanonical(value)).digest('hex')
const withoutGeneration = (host: TelemetryHost): TelemetryOwnedTargetFacts['host'] => {
  const copy: TelemetryOwnedTargetFacts['host'] = { ...host }
  Reflect.deleteProperty(copy, 'collectorGeneration')
  return copy
}
function immutableExecution(execution: HarnessExecution) {
  return { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId, agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId, attempt: execution.attempt,
    parallelGroupId: execution.parallelGroupId ?? null, workingDirectory: execution.workingDirectory ?? null,
    runtimeDirectory: execution.runtimeDirectory ?? null, input: execution.input, createdAt: execution.createdAt }
}
function grant(target: TelemetrySelectorTarget): { action: ManagementAction; resource: AuthorizedResource } {
  if (target.scope === 'computer') return { action: 'devices:metrics:read', resource: {} }
  const owner = target.target
  return owner.kind === 'workflow-execution' ? { action: 'runs:read', resource: owner }
    : owner.kind === 'ci-job' ? { action: 'jobs:read', resource: { workspaceId: owner.workspaceId } }
      : owner.kind === 'agent-conversation' ? { action: 'agent_chat:read', resource: owner }
        : { action: 'operator_chat:read', resource: {} }
}
function ownerTarget(mainId: string, owner: TelemetryOwner): Extract<TelemetrySelectorTarget, { scope: 'owned' }> {
  const target = owner.kind === 'workflow-execution' ? { kind: owner.kind, workspaceId: owner.workspaceId, workflowId: owner.workflowId,
    runId: owner.runId, nodeId: owner.nodeId, executionId: owner.executionId }
    : owner.kind === 'ci-job' ? { kind: owner.kind, workspaceId: owner.subject.workspaceId, jobExecutionId: owner.executionId, attemptId: owner.attemptId }
      : owner.kind === 'agent-conversation' ? { kind: owner.kind, workspaceId: owner.workspaceId, workflowId: owner.workflowId,
        nodeId: owner.nodeId, agentId: owner.agentId, conversationId: owner.conversationId }
        : { kind: owner.kind, conversationId: owner.conversationId }
  return { schemaVersion: 1, scope: 'owned', mainId, target }
}
interface TelemetryScopeContext {
  mainContext: PassiveTelemetryServicesInput['mainContext']
  captureHost(capture: CapturedTelemetryNativeOwner): TelemetryOwnedTargetFacts['host'] | null
  currentCapture(capture: CapturedTelemetryNativeOwner): boolean
  computerAllowed(sql: GraphTransactionSql, target: Extract<TelemetrySelectorTarget, { scope: 'computer' }>): Promise<boolean>
}

async function readTelemetryScope(sql: GraphTransactionSql, capture: CapturedTelemetryNativeOwner,
  observed: readonly NativeLaunchObservation[], signal: AbortSignal, context: TelemetryScopeContext): Promise<ScopeFacts | null> {
  const { captureHost, currentCapture, computerAllowed } = context

  const host = captureHost(capture)
  if (!host || !currentCapture(capture)) return null
  if (host.hostRef.kind === 'device' && !await computerAllowed(sql, { schemaVersion: 1, scope: 'computer', mainId: host.hostRef.mainId, hostRef: host.hostRef })) return null
  const laneRows = await sql.query<{ id: string; revision: string; record: unknown }>(`select id,revision::text,record from native_session_lanes
    where id=$1 and record->>'leaseToken'=$2 and (record->>'leaseExpiresAt')::timestamptz > clock_timestamp()`, [capture.writer.id, capture.writer.token])
  const lane = NativeSessionLaneSchema.safeParse(laneRows.rows[0]?.record)
  if (laneRows.rows.length !== 1 || !lane.success || lane.data.id !== capture.writer.id || lane.data.leaseToken !== capture.writer.token
    || lane.data.id !== laneRows.rows[0]!.id || String(lane.data.revision) !== laneRows.rows[0]!.revision
    || !lane.data.leaseExpiresAt || Date.parse(lane.data.leaseExpiresAt) <= Date.now() || !lane.data.leaseOwner
    || lane.data.harness !== capture.session.harness || lane.data.nativeSessionId !== capture.session.nativeSessionId
    || lane.data.ownerAgentId !== capture.execution.agentId || lane.data.correlationId !== `execution:${capture.execution.id}`
    || capture.writer.connectionGeneration !== undefined && lane.data.connectionGeneration !== capture.writer.connectionGeneration) return null
  const rows = await sql.query<{ id: string; run_id: string; workflow_node_id: string; agent_id: string; attempt: number;
    accepted: boolean; record: unknown; workspace_id: string; workflow_id: string; workflow_version_id: string; run_record: unknown }>(`select e.id,e.run_id,e.workflow_node_id,e.agent_id,e.attempt,e.accepted,e.record,r.workspace_id,r.workflow_id,r.workflow_version_id,r.record as run_record
    from harness_executions e join runs r on r.id=e.run_id where e.id=$1 and e.run_id=$2`, [capture.execution.id, capture.execution.runId])
  const row = rows.rows[0], execution = HarnessExecutionSchema.safeParse(row?.record), run = AcceptedWorkflowRunV3Schema.safeParse(row?.run_record)
  if (rows.rows.length !== 1 || !row || !execution.success || !row.accepted || row.id !== capture.execution.id
    || row.run_id !== capture.execution.runId || row.workflow_node_id !== capture.execution.workflowNodeId
    || row.agent_id !== capture.execution.agentId || row.attempt !== capture.execution.attempt
    || execution.data.id !== row.id || execution.data.runId !== row.run_id || execution.data.workflowNodeId !== row.workflow_node_id
    || execution.data.agentId !== row.agent_id || execution.data.agentConfigurationVersionId !== capture.execution.agentConfigurationVersionId || execution.data.attempt !== row.attempt
    || execution.data.nativeSessionId !== capture.session.nativeSessionId
    || telemetryCanonical(immutableExecution(execution.data)) !== telemetryCanonical(immutableExecution(capture.execution)) || !run.success || run.data.id !== row.run_id
    || run.data.workspaceId !== row.workspace_id || run.data.workflowId !== row.workflow_id || run.data.workflowVersionId !== row.workflow_version_id
    || run.data.agentConfigurationVersionIds[row.agent_id] !== execution.data.agentConfigurationVersionId) return null
  const sessionRows = await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1', [row.id])
  const session = NativeSessionReferenceSchema.safeParse(sessionRows.rows[0]?.reference)
  if (sessionRows.rows.length !== 1 || !session.success || telemetryCanonical(session.data) !== telemetryCanonical(capture.session)) return null
  // Dispatch and grant epoch come from the same repeatable-read snapshot.
  const original = await readDispatchIntent(sql, row.id)
  if (!original) return null
  const intent = await readReconciledDispatchIntent(sql, original.operationId)
  const placement = await readAcceptedPlacement(sql, row.run_id, row.workflow_node_id)
  if (!intent || !placement || telemetryCanonical({ ...intent, owner: null }) !== telemetryCanonical({ ...original, owner: null }) || intent.executionId !== row.id || intent.runId !== row.run_id || intent.nodeId !== row.workflow_node_id
    || intent.technicalAttempt !== row.attempt || intent.mainId !== host.hostRef.mainId || intent.bindingHash !== placement.bindingHash
    || telemetryCanonical(placement.hostRef) !== telemetryCanonical(host.hostRef)
    || placement.mainInstallationId !== context.mainContext()?.applicationInstallationId || placement.payload.kind !== 'agent'
    || placement.payload.agentId !== row.agent_id || placement.payload.agentConfigurationVersionId !== execution.data.agentConfigurationVersionId) return null
  const grantRows = await sql.query(`select 1 from execution_dispatch_owner_grants
    where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked`,
    [intent.executionId, intent.operationId, intent.owner.grantId, intent.owner.epoch])
  if (grantRows.rowCount !== 1) return null
  let remoteClosed = false
  if ('binding' in capture) {
    const remote = capture as CapturedRemoteTelemetryNativeOwner
    const receipts = await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1', [intent.operationId])
    const receipt = RemoteOperationReceiptSchema.safeParse(receipts.rows[0]?.receipt)
    const { connectionEpoch: _epoch, ...connection } = remote.binding
    void _epoch
    const origins = await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1', [intent.operationId])
    const origin = DeviceConnectionIdentitySchema.safeParse(origins.rows[0]?.connection)
    if (origins.rows.length !== 1 || !origin.success || telemetryCanonical(origin.data) !== telemetryCanonical(connection)) return null
    if (receipts.rows.length !== 1 || !receipt.success || !receipt.data.native
      || telemetryCanonical(receipt.data.connection) !== telemetryCanonical(connection)
      || telemetryCanonical({ ...receipt.data.intent, owner: null }) !== telemetryCanonical({ ...intent, owner: null })
      || telemetryCanonical(receipt.data.native) !== telemetryCanonical(remote.native)
      || remote.native.sessionId !== session.data.nativeSessionId
      || receipt.data.native.turnId !== undefined && receipt.data.native.turnId !== lane.data.currentTurnOrMessageId
      || !placement.registration
      || placement.registration.keyRevision !== remote.binding.keyRevision || placement.registration.authorizationRevision !== remote.binding.authorizationRevision
      || placement.registration.workerInstallationId !== remote.binding.workerInstallationId) return null
    remoteClosed = receipt.data.phase === 'confirmed_terminal'
  }
  signal.throwIfAborted()
  if (!currentCapture(capture) || telemetryCanonical(captureHost(capture)) !== telemetryCanonical(host)) return null
  const launches = host.hostRef.kind === 'main' ? observed.filter(value => value.owner === capture.nativeOwner && value.bootId === host.bootId) : []
  const state = remoteClosed ? 'closed' : run.data.executionState === 'completed' ? 'ended' : launches.length && launches.every(value => value.lifecycle === 'closed') ? 'closed'
    : execution.data.state === 'completed' ? 'ended'
      : launches.some(value => value.lifecycle === 'closure-unconfirmed') ? 'closure-unconfirmed' : 'active'
  return { host, owner: { kind: 'workflow-execution', workspaceId: row.workspace_id, workflowId: row.workflow_id,
    runId: row.run_id, nodeId: row.workflow_node_id, agentId: row.agent_id, executionId: intent.executionId,
    attemptId: intent.attemptId, operationId: intent.operationId, bindingHash: intent.bindingHash, owner: intent.owner },
    attributionRef: lane.data.id, attributionRevision: String(lane.data.revision), leaseId: lane.data.id, leaseExpiresAt: lane.data.leaseExpiresAt,
    nativeOwner: capture.nativeOwner, state, sharedOwners: [] }
}

/** Read-only projection of actual accepted facts. No ownership ledger, PID discovery, runtime acquisition or grant upgrade. */
export function createPassiveTelemetryAuthorities(input: PassiveTelemetryServicesInput): {
  sessions: TelemetrySessionReader; ownership: TelemetryOwnershipReader; reads: TelemetryReadAuthority;
  targets: TelemetryTargetAuthority; nativeScopes(identity: TelemetryIdentity): TrustedNativeScopes;
} {
  const captures = () => {
    const owners = [...input.getNativeOwners(), ...input.getRemoteNativeOwners?.() ?? []]
    // Unknown co-owners beyond the bounded source cannot be represented as complete private ownership.
    return owners.length > TELEMETRY_LIMITS.rows + 1 ? [] : owners
  }
  const captureKey = (capture: CapturedTelemetryNativeOwner) => signature({ execution: immutableExecution(capture.execution),
    session: capture.session, writer: capture.writer, nativeOwner: capture.nativeOwner,
    remote: 'binding' in capture ? { binding: capture.binding, native: (capture as CapturedRemoteTelemetryNativeOwner).native } : null })
  const currentCapture = (capture: CapturedTelemetryNativeOwner) => {
    try { capture.assertCurrent?.(); return captures().some(value => captureKey(value) === captureKey(capture)) }
    catch { return false }
  }
  const localHost = (): TelemetryOwnedTargetFacts['host'] | null => {
    const context = input.mainContext()
    return !context || !input.mainActive() ? null : { hostRef: { kind: 'main', mainId: context.mainId },
      deviceId: context.deviceId, applicationInstallationId: context.applicationInstallationId, bootId: context.bootId,
      runtimeEpoch: context.runtimeEpoch, keyRevision: null, authorizationRevision: null, connectionGeneration: null }
  }
  const captureHost = (capture: CapturedTelemetryNativeOwner): TelemetryOwnedTargetFacts['host'] | null => {
    if (!('binding' in capture)) return localHost()
    const binding = (capture as CapturedRemoteTelemetryNativeOwner).binding
    const observed = input.presence(binding.deviceId)
    if (!input.mainActive() || binding.mainId !== input.mainContext()?.mainId || !observed
      || telemetryCanonical(observed.binding) !== telemetryCanonical(binding)) return null
    return { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, deviceId: binding.deviceId,
      applicationInstallationId: binding.workerInstallationId, bootId: binding.bootId, runtimeEpoch: binding.connectionEpoch,
      keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision, connectionGeneration: binding.connectionGeneration }
  }
  const withSql = async <T>(signal: AbortSignal, work: (sql: GraphTransactionSql) => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    return withExclusiveGraphConnection(input.pool, connection => connection.transaction(async (client) => {
      const result = await work(client)
      signal.throwIfAborted()
      return result
    }, true))
  }
  const authorized = async (sql: GraphTransactionSql, principal: ManagementPrincipal, target: TelemetrySelectorTarget) => {
    const requirement = grant(target)
    if (!isAuthorized(principal, requirement.action, requirement.resource)) return false
    try {
      const live = await readLiveManagementPrincipal(sql, principal.id)
      return isAuthorized(live, requirement.action, requirement.resource)
    } catch (error) { if (error instanceof DomainError && error.status === 403) return false; throw error }
  }

  const load = async (sql: GraphTransactionSql, signal: AbortSignal, executionId?: string): Promise<ScopeFacts[]> => {
    const source = captures()
    if (!source.length || executionId && !source.some(capture => capture.execution.id === executionId)) return []
    const observed = input.registry.snapshot().launches
    const roots = new Map(source.map(capture => [capture, new Set(observed.filter(value => !('binding' in capture) && value.owner === capture.nativeOwner && value.bootId === captureHost(capture)?.bootId)
      .flatMap(value => [value.guardian, value.provider].flatMap(process => process ? [`${value.bootId}:${process.pid}:${process.startTicks}`] : [])
        .concat(value.boundary ? [`boundary:${value.bootId}:${value.boundary.device}:${value.boundary.inode}`] : [])))]))
    const related = (a: CapturedTelemetryNativeOwner, b: CapturedTelemetryNativeOwner) => telemetryCanonical(captureHost(a)) === telemetryCanonical(captureHost(b))
      && (a.nativeOwner === b.nativeOwner || [...roots.get(a)!].some(key => roots.get(b)!.has(key)))
    const selected = executionId ? source.filter(value => value.execution.id === executionId) : source
    const group = executionId ? source.filter(value => selected.some(own => related(own, value))) : source
    if (group.length === 0) return []
    const result: Array<{ capture: CapturedTelemetryNativeOwner; scope: ScopeFacts | null }> = []
    for (const capture of group) result.push({ capture, scope: await readTelemetryScope(sql, capture, observed, signal,
      { mainContext: () => input.mainContext(), captureHost, currentCapture, computerAllowed }) })
    for (const value of result) if (value.scope && (Date.parse(value.scope.leaseExpiresAt) <= Date.now()
      || !currentCapture(value.capture) || telemetryCanonical(value.scope.host) !== telemetryCanonical(captureHost(value.capture)))) value.scope = null
    return result.flatMap(({ capture, scope }) => {
      if (!scope || result.some(other => related(capture, other.capture) && !other.scope)) return []
      scope.sharedOwners = result.filter(other => other.scope && other.capture.execution.id !== capture.execution.id && related(capture, other.capture)).map(other => other.scope!.owner)
      return !executionId || capture.execution.id === executionId ? [scope] : []
    })
  }
  const computerAllowed = async (sql: GraphTransactionSql, target: Extract<TelemetrySelectorTarget, { scope: 'computer' }>) => {
    const host = localHost()
    if (!host || target.mainId !== host.hostRef.mainId) return false
    if (target.hostRef.kind === 'main') return telemetryCanonical(target.hostRef) === telemetryCanonical(host.hostRef)
    const rows = await sql.query<{ record: unknown; credential_expires_at: Date }>('select record,credential_expires_at from device_registrations where id=$1 and main_id=$2', [target.hostRef.deviceId, target.mainId])
    const registration = DeviceRegistrationSchema.safeParse(rows.rows[0]?.record), observed = input.presence(target.hostRef.deviceId)
    return rows.rows.length === 1 && registration.success && registration.data.status === 'paired'
      && registration.data.mainId === target.mainId && registration.data.deviceId === target.hostRef.deviceId
      && !!observed && observed.binding.mainId === target.mainId && observed.binding.deviceId === target.hostRef.deviceId
      && registration.data.workerInstallationId === observed.binding.workerInstallationId && registration.data.keyRevision === observed.binding.keyRevision
      && registration.data.authorizationRevision === observed.binding.authorizationRevision
      && !!rows.rows[0]!.credential_expires_at && rows.rows[0]!.credential_expires_at.getTime() > Date.now()
      && registration.data.scopes.includes('connect') && registration.data.scopes.includes('heartbeat')
      && registration.data.scopes.includes('metrics:report')
  }
  const targets: TelemetryTargetAuthority = {
    allowTarget: (principal, target, signal) => withSql(signal, async sql => await authorized(sql, principal, target)
      && (target.scope !== 'computer' || await computerAllowed(sql, target))),
    resolveOwned: (principal, target, signal) => withSql(signal, async sql => {
      if (!await authorized(sql, principal, target)) return { kind: 'denied' }
      // No genuine captured chat writer or OCI owner getter exists yet; do not infer one.
      if (target.target.kind !== 'workflow-execution') return { kind: 'unavailable' }
      const reference = target.target
      const scopes = await load(sql, signal, reference.executionId)
      const scope = scopes.length === 1 ? scopes[0] : undefined
      const owner = scope?.owner
      if (!scope || !owner || owner.kind !== 'workflow-execution' || scope.host.hostRef.mainId !== target.mainId
        || owner.workspaceId !== reference.workspaceId || owner.workflowId !== reference.workflowId
        || owner.runId !== reference.runId || owner.nodeId !== reference.nodeId) return { kind: 'unavailable' }
      return { kind: 'owned', facts: { owner: scope.owner, host: scope.host, attributionRef: scope.attributionRef, attributionRevision: scope.attributionRevision } }
    }),
  }
  const reads: TelemetryReadAuthority = {
    allow: (principal, selector, signal) => targets.allowTarget(principal, selector.scope === 'computer'
      ? { schemaVersion: 1, scope: 'computer', mainId: selector.mainId, hostRef: selector.host.hostRef }
      : ownerTarget(selector.mainId, selector.owner), signal),
    allowSharedOwner: (principal, owner, signal) => {
      const context = input.mainContext()
      return context ? targets.allowTarget(principal, ownerTarget(context.mainId, owner), signal) : Promise.resolve(false)
    },
  }
  const ownership: TelemetryOwnershipReader = { resolve: (selector, signal) => withSql(signal, async sql => {
    if (selector.owner.kind !== 'workflow-execution') return null
    const scopes = await load(sql, signal, selector.owner.executionId)
    const scope = scopes.length === 1 ? scopes[0] : undefined
    if (!scope) return null
    const exact = TelemetrySelectorSchema.parse({ schemaVersion: 1, scope: 'owned', mainId: scope.host.hostRef.mainId,
      host: { ...scope.host, collectorGeneration: selector.host.collectorGeneration }, owner: scope.owner,
      attributionRef: scope.attributionRef, attributionRevision: scope.attributionRevision }) as OwnedSelector
    return telemetrySelectorKey(exact) === telemetrySelectorKey(selector) ? { selector: exact, state: scope.state, sharedOwners: scope.sharedOwners, sharedOwnersComplete: scope.host.hostRef.kind === 'main' } : null
  }) }
  const sessions: TelemetrySessionReader = {
    active: async (context, signal) => {
      signal.throwIfAborted()
      if (!input.mainActive() || !input.mainContext() || context.capability !== 'resource-telemetry/v1') return false
      if (context.kind === 'main-local') return telemetryCanonical(context) === telemetryCanonical(input.mainContext())
      return withSql(signal, async sql => {
      const binding = context.binding, current = input.deviceBinding(binding.deviceId), observed = input.presence(binding.deviceId)
      if (binding.mainId !== input.mainContext()!.mainId || !observed || telemetryCanonical(observed.binding) !== telemetryCanonical(binding)) return false
      if (current && (telemetryCanonical(current) !== telemetryCanonical(binding)
        || !input.deviceCapabilities(binding.deviceId).some(value => value.namespace === 'resource-telemetry' && value.version === 1 && value.mainCanRequest))) return false
      if (!current && observed.phase !== 'offline') return false
      const allowed = await computerAllowed(sql, { schemaVersion: 1, scope: 'computer', mainId: binding.mainId,
        hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId } })
      return allowed && input.mainActive() && input.mainContext()?.mainId === binding.mainId
        && telemetryCanonical(input.presence(binding.deviceId)?.binding) === telemetryCanonical(binding)
        && (!input.deviceBinding(binding.deviceId) || telemetryCanonical(input.deviceBinding(binding.deviceId)) === telemetryCanonical(binding))
      })
    },
    presence: async (context, signal) => {
      signal.throwIfAborted()
      return context.kind === 'main-local' ? input.mainActive() ? 'online' : 'offline'
        : input.presence(context.binding.deviceId)?.phase === 'ready' && input.deviceBinding(context.binding.deviceId) ? 'online' : 'offline'
    },
  }
  const nativeScopes = (identity: TelemetryIdentity): TrustedNativeScopes => {
    let projection = signature([])
    let snapshotVersion = 0
    const revision = () => signature({ owners: captures().map(captureKey), context: input.mainContext(), active: input.mainActive(), projection })
    const readSnapshot = async (signal: AbortSignal): Promise<readonly TrustedNativeScope[]> => {
      signal.throwIfAborted()
      const expected = localHost()
      if (!expected || telemetryCanonical(expected) !== telemetryCanonical(withoutGeneration(identity.host)) || identity.mainId !== expected.hostRef.mainId) {
        projection = signature([]); return []
      }
      if (!captures().length) {
        projection = signature([])
        return []
      }
      const scopes = await withSql(signal, sql => load(sql, signal))
      projection = signature(scopes)
      return scopes.filter(scope => telemetryCanonical(scope.host) === telemetryCanonical(expected)).map(scope => ({ selector: TelemetrySelectorSchema.parse({ schemaVersion: 1, scope: 'owned', mainId: identity.mainId,
        host: identity.host, owner: scope.owner, attributionRef: scope.attributionRef, attributionRevision: scope.attributionRevision }) as OwnedSelector,
        leaseId: scope.leaseId, nativeOwner: scope.nativeOwner, observedDeviceId: identity.host.deviceId,
        observedInstallationId: identity.host.applicationInstallationId, shared: scope.sharedOwners.length > 0, lifecycle: scope.state }))
    }
    const snapshot = async (signal: AbortSignal) => {
      const scopes = await readSnapshot(signal)
      snapshotVersion++
      return scopes
    }
    return { revision, snapshot, async *changes(afterRevision, signal) {
      let previous = afterRevision
      let observedSnapshot = -1
      while (!signal.aborted) {
        // Reuse this interval's sampler refresh. A standalone watcher still
        // reloads persisted facts, including grants and lease expiry.
        if (observedSnapshot === snapshotVersion || observedSnapshot === -1) await snapshot(signal)
        observedSnapshot = snapshotVersion
        const current = revision()
        if (current !== previous) { previous = current; yield { revision: current, gap: true } }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
          const timer = setTimeout(finish, TELEMETRY_LIMITS.intervalMs)
          signal.addEventListener('abort', finish, { once: true }); if (signal.aborted) finish()
        })
      }
    } }
  }
  return { sessions, ownership, reads, targets, nativeScopes }
}

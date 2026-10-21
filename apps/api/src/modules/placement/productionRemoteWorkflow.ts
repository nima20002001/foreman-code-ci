import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { NativeSessionReferenceSchema } from '@foreman-code/contracts'
import { RemoteOperationStatusSchema, remoteActiveNative } from '@foreman-code/contracts/remote-execution'
import { hasPositiveRemoteEntryClosure, hasPositiveRemoteNonEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { readRemoteReceiptResponse } from '../runs/remote/installedWorkflowResponsePages.js'
import type { CapturedRemoteTelemetryNativeOwner } from '../resource-telemetry/productionAuthority.js'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import { sameWorkflowValue, canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readAcceptedPlacement, readAcceptedPlacements, readDispatchIntent, readNativePlacement } from './persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from './executionBinding.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import { interactionConnection } from '../interactions/connection.js'
import { assertRemoteExecutionAuthority } from './executionAuthority.js'
import { VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import { remoteNativeManager, type MainWorkerCarrier } from './workerCarrier.js'
import { deviceEndpointCarrier } from './deviceEndpointCarrier.js'
import { OwnedRemoteReceiptCommit, reserveRemoteDispatchOrigin } from './remoteReceiptCommit.js'
import { createRemoteNativeSourceChannel, assertRemoteNativeSourcesLocked, type RemoteNativeSourceEvidence, type VerifiedRemoteOriginalSource } from './remoteNativeSource.js'
import { createRemoteWorkflowPhysicalVerification, type PreparedRemoteWorkflowPhysical } from '../runs/remote/workflowPhysicalVerification.js'
import { remoteWorkflowSourceDigest } from '../runs/remote/workflowPhysicalReadout.js'
import type { WorkflowOriginalNativeSource, WorkflowNativeCapture, WorkflowNativeCaptureInput } from '../interactions/workflowNativeCapture.js'
import { didGraphTransactionCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { WorkflowNativeProofRecord } from '../runs/workflowNativeProof.js'
import type { WorkflowPhysicalArtifactsPort } from '../runs/remote/workflowPhysicalArtifacts.js'
import { DomainError } from '../errors.js'
import { admitRemoteOwnerControl, authorizeReservedRemoteResponse,
  readAdmittedRemoteOwnerControl } from '../runs/remote/ownerControlAdmission.js'
import { readOriginalInteractionDeliveryClaim } from '../interactions/originalDeliveryClaim.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { assertRemoteReviewerReceipt } from './remoteReviewerAuthority.js'
import type { CapturedReviewNativeSource } from '../interactions/reviewNativeCapture.js'
import { deviceRequestTimeoutMs, retryDeviceRequest } from '../devices/deviceRequestRetry.js'
import { preparationStop } from '../runs/remote/preparationCleanup.js'

interface ProductionRemoteWorkflowInput {
  pool: pg.Pool
  locations: WorkspaceLocationService
  endpoint(): DeviceEndpoint
  producer(): AgentPlacementProducer | undefined
  execution(id: string): Promise<HarnessExecution | undefined>
  artifacts?: WorkflowPhysicalArtifactsPort
  workerExecution?: WorkerExecutionPolicy
  preparationTimeoutMs?: number
}
interface RetainedRemoteWorkflowSource {
  source: WorkflowOriginalNativeSource
  prepared: PreparedRemoteWorkflowPhysical
  evidence?: RemoteNativeSourceEvidence
  acknowledgment?: 'sent' | 'obsolete'
  capture?: WorkflowNativeCapture
}
type RemoteWorkflowPhysicalVerification = ReturnType<typeof createRemoteWorkflowPhysicalVerification>
type RemoteWorkflowAuthority = (sql: GraphTransactionSql, binding: AcceptedExecutionBinding,
  connection: DeviceConnectionIdentity, action: 'start' | 'read' | 'control' | 'stop') => ReturnType<typeof assertRemoteExecutionAuthority>

function sourceKey(source: WorkflowOriginalNativeSource) { return remoteWorkflowSourceDigest(source) }

/** One Main owner and its actual authenticated worker sources. Allocation is
 * IO-free; preparation/prefetch runs before the existing canonical transaction. */
export function createProductionRemoteWorkflow(input: ProductionRemoteWorkflowInput) {
  const bindings = new Map<string, AcceptedExecutionBinding | null>()
  const channel = createRemoteNativeSourceChannel()
  const physical = createRemoteWorkflowPhysicalVerification({ endpoint: input.endpoint,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}) })
  const acknowledgments = new Set<VerifiedRemoteOriginalSource>()
  const companions = new WeakMap<WorkflowNativeCapture, RemoteNativeSourceEvidence>()
  const reviewCompanions = new WeakMap<CapturedReviewNativeSource, RemoteNativeSourceEvidence>()
  const reviewAcknowledgments = new Map<string, Map<VerifiedRemoteOriginalSource, GraphTransactionSql>>()
  const artifactTerminals = new WeakMap<WorkflowNativeCapture, VerifiedRemoteOriginalSource>()
  const latest = new Map<string, string>()
  const retained = new Map<string, Map<string, RetainedRemoteWorkflowSource>>()
  const releaseExecution = (executionId: string) => {
    retained.delete(executionId)
    bindings.delete(executionId)
    latest.delete(executionId)
    reviewAcknowledgments.delete(executionId)
    for (const original of acknowledgments) {
      if (original.verified.receipt.intent.executionId === executionId) acknowledgments.delete(original)
    }
    channel.release(executionId)
  }
  const requireProducer = () => {
    const producer = input.producer()
    if (!producer) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual placement producer is unavailable.', 503)
    return producer
  }
  const authority = (sql: GraphTransactionSql, binding: AcceptedExecutionBinding, connection: DeviceConnectionIdentity, action: 'start' | 'read' | 'control' | 'stop') =>
    assertRemoteExecutionAuthority(sql, input.locations, { version: 1, intent: binding.intent, placement: binding.placement, action }, connection, requireProducer())
  const carrier = deviceEndpointCarrier(() => input.endpoint())
  const prepare = (executionId: string) => prepareRemoteWorkflowBinding(input, bindings, executionId)
  return {
    prepare,
    async confirmClosedExecution(executionId: string, signal: AbortSignal, owner: RunOwnership): Promise<boolean> {
      const closed = await confirmRemoteWorkflowClosedExecution(input, prepare, physical, authority, executionId, signal, owner)
      if (closed) releaseExecution(executionId)
      return closed
    },
    binding(executionId: string) { return bindings.get(executionId) },
    async prepareContext(context: NativeManagerResolutionContext): Promise<NativeManagerResolutionContext> {
      const binding = await prepare(context.executionId)
      return binding ? { ...context, acceptedPlacement: binding.placement } : context
    },
    isRemote(executionId: string) { return bindings.get(executionId)?.placement.hostRef.kind === 'device' },
    manager(context: NativeManagerResolutionContext, getOwner: () => RunOwnership | undefined) {
      return createRemoteWorkflowManager(input, { bindings, carrier, authority, physical, channel, retained, latest }, context, getOwner)
    },
    captureReview(capture: CapturedReviewNativeSource) {
      if (bindings.get(capture.execution.id)?.placement.hostRef.kind !== 'device') return
      if (!capture.owner) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original reviewer Run owner is required.', 409)
      let source: WorkflowOriginalNativeSource = { type: 'boundary' }
      if (capture.source.type === 'event') source = { type: 'event', event: { ...capture.source.event, executionId: capture.execution.id } }
      if (capture.source.type === 'history') source = { type: 'history', history: capture.source.history }
      const entry = retained.get(capture.execution.id)?.get(sourceKey(source))
      if (!entry) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The authenticated review source is unavailable.', 409)
      const evidence = channel.capture(capture.execution.id, source)
      entry.evidence = evidence
      physical.bind(channel.verify.read(evidence), entry.prepared, capture.owner, {
        execution: capture.execution, session: capture.session, lifetimeGeneration: capture.lifetimeGeneration,
        closureGeneration: capture.closureGeneration, lane: capture.lane,
        review: { jobId: capture.job.id, correlationId: capture.job.correlationId }, assertCurrent: capture.assertCurrent,
      })
      reviewCompanions.set(capture, evidence)
    },
    async assertReviewPhysical(sql: GraphTransactionSql, capture: CapturedReviewNativeSource) {
      const evidence = reviewCompanions.get(capture)
      if (!capture.owner || !evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original review physical source is unavailable.', 409)
      await physical.assertOriginal(sql, capture.owner, channel.verify.read(evidence))
      const pending = reviewAcknowledgments.get(capture.execution.id) ?? new Map()
      pending.set(channel.verify.read(evidence), sql)
      reviewAcknowledgments.set(capture.execution.id, pending)
    },
    async afterReviewCommit(executionId: string) {
      const pending = reviewAcknowledgments.get(executionId)
      if (!pending) return
      let attempts = 0
      for (const [original, sql] of [...pending]) {
        if (attempts >= 32) break
        pending.delete(original)
        if (!didGraphTransactionCommit(sql)) continue
        try {
          if (await acknowledgeRemoteWorkflowSource(physical, original)) {
            releaseExecution(executionId)
            return
          }
          retained.get(executionId)?.delete(original.sourceDigest)
        } catch (error) {
          if (error instanceof DomainError && error.code === 'REMOTE_NATIVE_ACK_OBSOLETE') {
            retained.get(executionId)?.delete(original.sourceDigest)
            continue
          }
          pending.set(original, sql)
        }
        attempts++
      }
      if (!pending.size) reviewAcknowledgments.delete(executionId)
    },
    capture(inputCapture: WorkflowNativeCaptureInput, capture: WorkflowNativeCapture) {
      const binding = bindings.get(capture.execution.id)
      if (binding?.placement.hostRef.kind !== 'device') return
      const entries = retained.get(capture.execution.id)
      const entry = entries?.get(sourceKey(capture.source))
      if (!entry || !capture.closureGeneration) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The authenticated original remote source is unavailable at the actual native lifetime boundary.', 409)
      if (!entry.evidence) {
        entry.evidence = channel.capture(capture.execution.id, entry.source)
        const original = channel.verify.read(entry.evidence)
        physical.bind(original, entry.prepared, inputCapture.owner, { execution: capture.execution, session: capture.session,
          lifetimeGeneration: capture.lifetimeGeneration, closureGeneration: capture.closureGeneration, lane: capture.lane,
          assertCurrent: capture.assertCurrent })
      }
      entry.capture = capture
      companions.set(capture, entry.evidence)
    },
    async artifactTerminalContext(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture, proof: WorkflowNativeProofRecord) {
      const evidence = companions.get(capture)
      if (!evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original artifact terminal has no authenticated physical companion.', 409)
      const original = channel.verify.read(evidence)
      const context = await physical.artifactTerminalContext(sql, owner, original, capture, proof)
      artifactTerminals.set(capture, original)
      return context
    },
    assertArtifactTerminal(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture, proof: WorkflowNativeProofRecord) {
      return physical.assertArtifactTerminal(sql, owner, capture, proof)
    },
    assertAdoptedArtifacts(sql: GraphTransactionSql, owner: RunOwnership, capture: WorkflowNativeCapture) {
      const original = artifactTerminals.get(capture)
      if (!original) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original artifact terminal companion is unavailable.', 409)
      return physical.assertAdoptedArtifacts(sql, owner, original)
    },
    fileTransferContext(capture: WorkflowNativeCapture) {
      if (bindings.get(capture.execution.id)?.placement.hostRef.kind !== 'device') return undefined
      const evidence = companions.get(capture)
      const original = evidence && channel.verify.read(evidence)
      if (!original) throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical file publisher is unavailable.', 409)
      const captured = physical.passiveNativeOwner(original)
      if (!captured) return undefined // Closed native observations cannot admit a live file publisher.
      capture.assertCurrent(); captured.assertCurrent()
      return transferContextForBinding(captured.binding)
    },
    getRemoteNativeOwners(): readonly CapturedRemoteTelemetryNativeOwner[] {
      const owners: CapturedRemoteTelemetryNativeOwner[] = []
      for (const [executionId, entries] of retained) {
        const entry = entries.get(latest.get(executionId) ?? '')
        const capture = entry?.capture
        if (!entry?.evidence || !capture?.lane) continue
        let physicalOwner: ReturnType<typeof physical.passiveNativeOwner>
        try { physicalOwner = physical.passiveNativeOwner(channel.verify.read(entry.evidence)) }
        catch (error) { logIgnoredError('harness', 'verify remote telemetry owner', error); continue }
        if (!physicalOwner) continue
        const assertCurrent = () => {
          if (retained.get(executionId)?.get(latest.get(executionId) ?? '') !== entry || entry.capture !== capture)
            throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED', 'The original remote telemetry lifetime changed.', 409)
          capture.assertCurrent(); physicalOwner.assertCurrent()
        }
        try { assertCurrent() }
        catch (error) { logIgnoredError('harness', 'check remote telemetry owner', error); continue }
        owners.push({ execution: structuredClone(capture.execution), session: structuredClone(capture.session),
          writer: { id: capture.lane.id, token: capture.lane.token, connectionGeneration: capture.lane.connectionGeneration },
          ...physicalOwner, assertCurrent })
      }
      return owners
    },
    afterCommit: (capture: WorkflowNativeCapture) => acknowledgeRemoteWorkflowSources({
      bindings, retained, latest, acknowledgments, companions, channel, physical, releaseExecution,
    }, capture),
    assertPhysical: (sql: GraphTransactionSql, owner: RunOwnership,
      captures: WorkflowNativeCapture | readonly WorkflowNativeCapture[]) =>
      assertWorkflowPhysicalBatch(sql, owner, captures, companions, channel.verify, physical),
  }
}

async function acknowledgeRemoteWorkflowSource(physical: RemoteWorkflowPhysicalVerification,
  original: VerifiedRemoteOriginalSource): Promise<boolean> {
  await physical.acknowledge(original)
  try { await physical.acknowledgeReply(original) }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'
      || error.details?.reason !== 'uncommitted_history') throw error
  }
  return physical.releaseExecution(original)
}

async function acknowledgeRemoteWorkflowSources(dependencies: {
  bindings: Map<string, AcceptedExecutionBinding | null>
  retained: Map<string, Map<string, RetainedRemoteWorkflowSource>>
  latest: Map<string, string>
  releaseExecution(executionId: string): void
  acknowledgments: Set<VerifiedRemoteOriginalSource>
  companions: WeakMap<WorkflowNativeCapture, RemoteNativeSourceEvidence>
  channel: ReturnType<typeof createRemoteNativeSourceChannel>
  physical: RemoteWorkflowPhysicalVerification
}, capture: WorkflowNativeCapture): Promise<void> {
  const { bindings, retained, latest, releaseExecution, acknowledgments, companions, channel, physical } = dependencies
  if (!bindings.has(capture.execution.id)) return
  const evidence = companions.get(capture)
  if (!evidence) return
  acknowledgments.add(channel.verify.read(evidence))
  // Obsolete observations do not consume the network retry budget.
  let attempts = 0
  for (const original of [...acknowledgments]) {
    if (attempts >= 32) break
    acknowledgments.delete(original)
    const executionId = original.verified.receipt.intent.executionId
    if (!bindings.has(executionId)) continue
    const entries = retained.get(executionId)
    const entry = entries?.get(original.sourceDigest)
    try {
      const settled = await acknowledgeRemoteWorkflowSource(physical, original)
      if (entry) entry.acknowledgment = 'sent'
      if (settled) releaseExecution(executionId)
    } catch (error) {
      if (!bindings.has(executionId)) continue
      if (error instanceof DomainError && error.code === 'REMOTE_NATIVE_ACK_OBSOLETE') {
        if (entry) entry.acknowledgment = 'obsolete'
        if (latest.get(executionId) !== original.sourceDigest) entries?.delete(original.sourceDigest)
        continue
      }
      // Move a transient failure behind observations that have not had a turn.
      acknowledgments.add(original)
    }
    attempts++
    if (entry?.acknowledgment === 'sent' && latest.get(executionId) !== original.sourceDigest) {
      entries?.delete(original.sourceDigest)
    }
  }
}

async function assertWorkflowPhysicalBatch(sql: GraphTransactionSql, owner: RunOwnership,
  input: WorkflowNativeCapture | readonly WorkflowNativeCapture[],
  companions: WeakMap<WorkflowNativeCapture, RemoteNativeSourceEvidence>,
  verification: ReturnType<typeof createRemoteNativeSourceChannel>['verify'],
  physical: RemoteWorkflowPhysicalVerification): Promise<void> {
  const captures = Array.isArray(input) ? input : [input as WorkflowNativeCapture]
  for (const capture of captures) {
    capture.assertCurrent()
    if (capture.execution.runId !== owner.runId) throw new DomainError(
      'RUN_OWNERSHIP_LOST', 'The native capture belongs to another Run.', 409)
  }
  const placements = await readAcceptedPlacements(sql, owner.runId,
    captures.map(capture => capture.execution.workflowNodeId))
  const remote = []
  for (const capture of captures) {
    if (placements.get(capture.execution.workflowNodeId)?.hostRef.kind !== 'device') continue
    const evidence = companions.get(capture)
    if (!evidence) throw new DomainError('REMOTE_NATIVE_SOURCE_NOT_CAPTURED',
      'A local native capture cannot authorize a remote placement.', 409)
    remote.push({ execution: capture.execution, source: capture.source, evidence })
  }
  await assertRemoteNativeSourcesLocked(sql, owner, remote, verification, physical)
}

async function prepareRemoteWorkflowBinding(input: ProductionRemoteWorkflowInput,
  bindings: Map<string, AcceptedExecutionBinding | null>, executionId: string): Promise<AcceptedExecutionBinding | null> {
  const execution = await input.execution(executionId)
  if (!execution) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The actual execution is unavailable.', 409)
  const sql = interactionConnection.getStore() ?? input.pool
  const original = await readDispatchIntent(sql, executionId)
  const placement = await readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId)
  if (!!original !== !!placement) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The actual placed execution has no exact dispatch.', 409)
  let binding: AcceptedExecutionBinding | null = null
  if (original && placement) {
    const intent = await readReconciledDispatchIntent(sql, original.operationId)
    const rawNative = await readNativePlacement(sql, executionId)
    if (!intent || !rawNative) throw new DomainError('PLACEMENT_PREPARATION_REQUIRED', 'The original materialized execution binding is required.', 409)
    const executionPlacement = readNativeExecutionBinding(placement, intent, rawNative)
    if (execution.workingDirectory !== executionPlacement.workingTree.canonicalCwd || intent.runId !== execution.runId
      || intent.nodeId !== execution.workflowNodeId || intent.technicalAttempt !== execution.attempt) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The original native execution directory or attempt changed.', 409)
    binding = { intent, placement, executionPlacement }
  }
  const previous = bindings.get(executionId)
  // Source lifecycle and audited owner renewals can change without changing placement.
  let comparable = previous
  if (previous && binding) {
    comparable = { ...previous, intent: { ...previous.intent, owner: binding.intent.owner } }
    if (previous.executionPlacement && binding.executionPlacement) {
      comparable.executionPlacement = { ...previous.executionPlacement,
        materialization: { ...previous.executionPlacement.materialization,
          state: binding.executionPlacement.materialization.state } }
    }
  }
  if (bindings.has(executionId) && !sameWorkflowValue(comparable, binding)) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The original native placement cannot change after preparation.', 409)
  bindings.set(executionId, binding)
  return binding
}

async function confirmRemoteWorkflowClosedExecution(input: ProductionRemoteWorkflowInput,
  prepare: (executionId: string) => Promise<AcceptedExecutionBinding | null>,
  physical: RemoteWorkflowPhysicalVerification, authority: RemoteWorkflowAuthority,
  executionId: string, signal: AbortSignal, owner: RunOwnership): Promise<boolean> {
  owner.assertOwned()
  const binding = await prepare(executionId)
  if (!binding || binding.placement.hostRef.kind !== 'device') return false
  if (owner.runId !== binding.intent.runId) throw new DomainError(
    'REMOTE_RUN_OWNER_CONFLICT', 'The Run owner does not match native cleanup.', 409)
  const captured = input.endpoint().captureRequest(binding.placement.hostRef.deviceId, 'execution-v1')
  if (!captured) return false
  const { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision,
    connectionGeneration } = captured.binding
  const authenticated = DeviceConnectionIdentitySchema.parse({ mainId, deviceId, workerInstallationId,
    bootId, keyRevision, authorizationRevision, connectionGeneration })
  const request = (payload: unknown) => retryDeviceRequest(() => captured.request(payload,
    { signal, timeoutMs: deviceRequestTimeoutMs }), { retry: 'idempotent', signal })
  const readStatus = async (payload: unknown) => {
    const reply = await request(payload)
    if (reply.bytes !== undefined) throw new DomainError('REMOTE_CLOSURE_INVALID',
      'Closure readback cannot contain binary data.', 409)
    const raw = await readRemoteReceiptResponse(reply.payload, binding.intent, async continuation => {
      const next = await request({ method: 'receipt-continuation', intent: binding.intent,
        placement: binding.placement, ...continuation,
        ...(captured.stopReadAdmission ? { forStop: true } : {}) })
      return next.payload
    }, signal)
    return RemoteOperationStatusSchema.parse(raw)
  }
  let status = await readStatus({ method: 'status', intent: binding.intent, placement: binding.placement,
    ...(captured.stopReadAdmission ? { forStop: true } : {}) })
  if (status.status === 'known' && sameWorkflowValue(status.receipt.intent, binding.intent)
    && !status.receipt.native && !status.receipt.terminal) {
    // Entry may have started without acknowledging a session; Stop still needs positive closure below.
    owner.assertOwned()
    const intent = binding.intent
    status = await readStatus({ method: 'control', intent, placement: binding.placement,
      command: preparationStop(intent) })
  } else if (status.status === 'known' && sameWorkflowValue(status.receipt.intent, binding.intent)
    && !status.receipt.terminal) {
    const native = remoteActiveNative(status.receipt)
    if (native) {
      const receipt = status.receipt
      const reconciled = await VerifiedRemoteEvidence.commit(receipt, authenticated,
        new OwnedRemoteReceiptCommit(owner, receipt, authenticated, {
          async assertCurrent(sql, intent, placement, connection) {
            signal.throwIfAborted()
            await authority(sql, { intent, placement }, connection, 'stop')
            await assertRemoteReviewerReceipt(sql, receipt)
          },
          async publishNative() {
            signal.throwIfAborted()
          },
        }))
      if (reconciled === 'rejected') throw new DomainError('REMOTE_CLOSURE_RECEIPT_REJECTED',
        'The remote cleanup status was rejected by its canonical owner.', 409)
      const command = await owner.oneShotConnection().transaction(async sql => {
        await authority(sql, binding, authenticated, 'stop')
        return admitRemoteOwnerControl(sql, owner, binding, { kind: 'stop', native })
      })
      signal.throwIfAborted()
      status = await readStatus({ method: 'control', intent: binding.intent, placement: binding.placement, command })
    }
  }
  if (status.status !== 'known' || !sameWorkflowValue(status.receipt.intent, binding.intent)
    || !status.receipt.terminal) return false
  const receipt = status.receipt
  const row = (await input.pool.query<{ reference: unknown }>(
    'select reference from execution_native_sessions where execution_id=$1', [executionId])).rows[0]
  const session = row ? NativeSessionReferenceSchema.parse(row.reference) : null
  const original = receipt.native
    ? await physical.prefetch(receipt, binding.placement, { type: 'boundary' }, signal)
    : undefined
  const confirmedClosed = () => original ? physical.confirmedClosed(original, session)
    : session === null && (hasPositiveRemoteEntryClosure(receipt)
      || hasPositiveRemoteNonEntryClosure(receipt))
  if (!confirmedClosed()) return false
  const committed = await VerifiedRemoteEvidence.commit(receipt, authenticated,
    new OwnedRemoteReceiptCommit(owner, receipt, authenticated, {
      async assertCurrent(sql, intent, placement, connection) {
        await authority(sql, { intent, placement }, connection, 'read')
        const current = (await sql.query<{ reference: unknown }>(
          'select reference from execution_native_sessions where execution_id=$1 for share', [executionId])).rows[0]
        if (!sameWorkflowValue(current?.reference ?? null, session) || !confirmedClosed()) throw new DomainError(
          'REMOTE_CLOSURE_INVALID', 'The original physical closure changed during recovery.', 409)
      },
      async publishNative() {
        if (!confirmedClosed()) throw new DomainError(
          'REMOTE_CLOSURE_INVALID', 'The original physical closure changed during publication.', 409)
      },
    }))
  if (committed === 'rejected') throw new DomainError('REMOTE_CLOSURE_RECEIPT_REJECTED',
    'The original closure receipt was rejected by its canonical owner.', 409)
  if (original) await physical.acknowledgeClosed(original)
  return true
}

function createRemoteWorkflowManager(input: ProductionRemoteWorkflowInput, dependencies: {
  bindings: Map<string, AcceptedExecutionBinding | null>
  carrier: MainWorkerCarrier
  authority: RemoteWorkflowAuthority
  physical: RemoteWorkflowPhysicalVerification
  channel: ReturnType<typeof createRemoteNativeSourceChannel>
  retained: Map<string, Map<string, RetainedRemoteWorkflowSource>>
  latest: Map<string, string>
}, context: NativeManagerResolutionContext, getOwner: () => RunOwnership | undefined) {
  const { bindings, carrier, authority, physical, channel, retained, latest } = dependencies
  const binding = bindings.get(context.executionId)
  if (!binding || binding.placement.hostRef.kind !== 'device') return undefined
  const requireOwner = () => {
    const owner = getOwner()
    if (!owner || owner.runId !== binding.intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original native Run owner is required.', 409)
    owner.assertOwned(); return owner
  }
  const verifiedReceipts = new Map<string, { verified: VerifiedRemoteEvidence; assertCurrent(): void }>()
  return remoteNativeManager(context, binding, { carrier,
    ...(input.preparationTimeoutMs ? { preparationTimeoutMs: input.preparationTimeoutMs } : {}),
    ...(input.workerExecution ? { workerExecution: input.workerExecution } : {}),
    beforePrepare: (intent, _placement, connection) => {
      const owner = requireOwner()
      return owner.oneShotConnection().transaction(sql => reserveRemoteDispatchOrigin(sql, owner, intent, connection,
        { assertCurrent: async (sql, current, pin, authenticated) => {
          await authority(sql, { intent: current, placement: pin }, authenticated, 'start')
        } }))
    },
    commit: (receipt, authenticated) => {
      const owner = requireOwner()
      const assertCurrent = () => { requireOwner(); const current = input.endpoint().currentBinding(authenticated.deviceId)
        if (!current || current.mainId !== authenticated.mainId || current.workerInstallationId !== authenticated.workerInstallationId
          || current.bootId !== authenticated.bootId || current.connectionGeneration !== authenticated.connectionGeneration
          || current.keyRevision !== authenticated.keyRevision || current.authorizationRevision !== authenticated.authorizationRevision)
          throw new DomainError('REMOTE_CONNECTION_CONFLICT', 'The original authenticated native response connection changed.', 409) }
      return new OwnedRemoteReceiptCommit(owner, receipt, authenticated, {
        async assertCurrent(sql, intent, placement, connection) {
          await authority(sql, { intent, placement }, connection, 'read')
          await assertRemoteReviewerReceipt(sql, receipt)
        },
        async publishNative(_sql, _owner, verified) {
          // Receipt handling cannot mint the coordinator's not-yet-created
          // Main session/lane. Only retain the authenticated original source.
          const key = canonicalGraphJson(receipt)
          if (!verifiedReceipts.has(key) && verifiedReceipts.size >= 32) verifiedReceipts.delete(verifiedReceipts.keys().next().value!)
          verifiedReceipts.set(key, { verified, assertCurrent })
        },
      })
    },
    observeOriginalSource: async (receipt, source, signal) => {
      const verified = verifiedReceipts.get(canonicalGraphJson(receipt))
      if (!verified) throw new DomainError('REMOTE_OBSERVATION_NOT_AUTHENTICATED', 'Original native source requires its authenticated committed receipt.', 403)
      verified.assertCurrent()
      const prepared = await physical.prefetch(receipt, binding.placement, source, signal)
      verified.assertCurrent()
      channel.observe(verified.verified, source, verified.assertCurrent)
      const entries = retained.get(receipt.intent.executionId) ?? new Map()
      const key = sourceKey(source)
      if (!entries.has(key) && entries.size >= 1024) throw new DomainError('REMOTE_NATIVE_SOURCE_BACKPRESSURE', 'The original remote source window is full.', 503)
      for (const [oldKey, old] of entries) {
        if (oldKey === key) continue
        const uncapturedHistory = source.type === 'history' && old.source.type === 'history' && !old.evidence
        if (!old.acknowledgment && !uncapturedHistory) continue
        if (!old.acknowledgment) {
          try {
            await physical.discard(old.prepared)
          } catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'REMOTE_NATIVE_ACK_OBSOLETE') throw error
            // The old lifetime cannot ACK; release its local source so the fresh observation can replace it.
          }
          channel.forget(receipt.intent.executionId, old.source)
        }
        entries.delete(oldKey)
      }
      entries.set(key, { source, prepared })
      retained.set(receipt.intent.executionId, entries)
      latest.set(receipt.intent.executionId, key)
    },
    controlFor: async command => {
      if (interactionConnection.getStore()) throw new DomainError('REMOTE_CONTROL_TRANSACTION_UNAVAILABLE', 'Remote native response delivery requires an admitted effect outside the Main delivery transaction.', 409)
      const owner = requireOwner()
      return owner.oneShotConnection().transaction(sql => admitRemoteOwnerControl(sql, owner, binding, command, readOriginalInteractionDeliveryClaim()))
    },
    readResponseControl: async () => {
      const claim = readOriginalInteractionDeliveryClaim()
      if (!claim) return undefined
      const owner = requireOwner()
      return owner.oneShotConnection().transaction(sql => readAdmittedRemoteOwnerControl(sql, owner, binding, claim))
    },
    authorizeResponseRetry: async command => {
      const claim = readOriginalInteractionDeliveryClaim()
      if (!claim || interactionConnection.getStore()) {
        throw new DomainError('REMOTE_CONTROL_ORIGINAL_CLAIM_REQUIRED', 'Response recovery requires its active delivery claim.', 409)
      }
      const owner = requireOwner()
      await owner.oneShotConnection().transaction(sql => authorizeReservedRemoteResponse(sql, owner, binding, claim, command))
    },
  })
}

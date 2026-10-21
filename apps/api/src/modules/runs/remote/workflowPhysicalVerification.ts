import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { RemoteNativeIdentity } from '@foreman-code/contracts/remote-execution'
import { isDeepStrictEqual } from 'node:util'
import { REMOTE_NATIVE_SOURCE_LIMIT } from '@foreman-code/contracts/remote-workflow-physical'
import { HarnessExecutionSchema, NativeSessionReferenceSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { RemoteWorkflowPhysicalAckSchema, type RemoteWorkflowPhysicalReadout,type RemoteWorkflowPhysicalAck } from '@foreman-code/contracts/remote-workflow-physical'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { deviceRequestTimeoutMs, waitForDeviceRetry } from '../../devices/deviceRequestRetry.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { isDeviceLinkDrop, waitForDeviceReconnect } from '../../devices/deviceReconnect.js'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import type { WorkflowOriginalNativeSource, WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import type { RemoteNativeBatchPhysicalVerification, VerifiedRemoteOriginalSource } from '../../placement/remoteNativeSource.js'
import { readAcceptedPlacement, readNativePlacement } from '../../placement/persistence.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { assertGraphTransaction,didGraphTransactionCommit,beforeGraphCommit,isGraphTransactionFinalizing,poisonGraphTransaction, type GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { repeatExecutionIdentity,repeatDigest } from '../repeatResolution.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { matchesWorkflowNativeTerminalLocked } from '../workflowCoordinationTerminal.js'
import { remoteWorkflowProcessDigest, remoteWorkflowSourceDigest, remoteWorkflowNativeHistory,
  readPhysicalReadout, hasNativeClosure } from './workflowPhysicalReadout.js'
import { DomainError } from '../../errors.js'
import { assertRemoteReviewerReceipt } from '../../placement/remoteReviewerAuthority.js'
import { readRetainedRemoteReviewer } from '../../interactions/retainedRemoteReviewer.js'
import type { ReviewNativeProofRecord } from '../../interactions/reviewNativeProof.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import type { TransferContext } from '@foreman-code/contracts/byte-transfer'
import { assertRepeatCanonicalReceiptLocked,requireRepeatCanonicalReceiptBeforeCommit } from '../../run-graph/repeatReceipts.js'
import type { WorkflowPhysicalArtifactsPort } from './workflowPhysicalArtifacts.js'
import { readWorkflowNativeEntryLocked,workflowNativeReservation,type WorkflowNativeReservation,type WorkflowNativeEntryRecord } from '../workflowNativeEntry.js'
import { canonicalRepeatEffectReceipt } from '../../run-graph/repeatPublication.js'
import { workflowNativeSourceId, readWorkflowTerminalSource } from '../workflowNativeSource.js'
import { assertOriginalWorkflowTerminal } from '../../interactions/workflowTerminalSource.js'

export interface RemoteWorkflowMainLifetime {
  execution: HarnessExecution
  session: NativeSessionReference
  lifetimeGeneration: number
  closureGeneration: string
  lane: { id: string; token: string; connectionGeneration: number; providerId: string | null } | null
  review?: { jobId: string; correlationId: string }
  assertCurrent(): void
}
/** Descriptor only: the producer's private WeakMap is the authority. */
export interface PreparedRemoteWorkflowPhysical { readonly kind: 'original-remote-physical' }
export interface PassiveRemoteNativeOwner {
  nativeOwner: string; native: RemoteNativeIdentity; binding: Readonly<DeviceSessionBinding>; assertCurrent(): void
}
interface Prepared {
  signal: AbortSignal | undefined
  isExpired(): boolean
  binding: Readonly<DeviceSessionBinding>
  readout: RemoteWorkflowPhysicalReadout
  placement: AcceptedNodePlacement
  source: WorkflowOriginalNativeSource
  assertCurrent(): void
  assertAcknowledgmentCurrent(): void
  acknowledge(sourceDigest:string, options?: { retire: true }):Promise<RemoteWorkflowPhysicalAck>
}
interface Bound extends Prepared {
  owner: RunOwnership
  lifetime: RemoteWorkflowMainLifetime
  processingSql?: GraphTransactionSql
  publications: Set<GraphTransactionSql>
  replyPublications: Set<GraphTransactionSql>
  terminalPublications: Set<GraphTransactionSql>
  terminalCapture?: WorkflowNativeCapture
}
interface WorkflowPhysicalTerminal {
  original: VerifiedRemoteOriginalSource
  capture: Bound
  proof: WorkflowNativeProofRecord
  sql: GraphTransactionSql
}
const unavailable = (reason: string): never => {
  throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE',
    `Remote native verification failed (${reason}).`, 409, { reason })
}
function same(left: unknown, right: unknown) { return isDeepStrictEqual(left, right) }
function assertSource(readout: RemoteWorkflowPhysicalReadout, source: WorkflowOriginalNativeSource,
  placement: AcceptedNodePlacement) {
  const { receipt, session, launch, observation } = readout
  if (placement.payload.kind !== 'agent' || session.harness !== placement.payload.driverId) {
    return unavailable('harness_binding')
  }
  const launchIntent = readout.launchIntent ?? receipt.intent
  if (!same({ ...launchIntent, owner: receipt.intent.owner }, receipt.intent)) return unavailable('launch_binding')
  if (!receipt.native || receipt.native.sessionId !== session.nativeSessionId
    || launch.owner !== `execution:${receipt.intent.executionId}` || launch.bootId !== receipt.connection.bootId
    || launch.lifecycle !== 'active' || remoteWorkflowProcessDigest(receipt.connection, launchIntent, launch) !== receipt.native.processIdentityDigest
    || observation.launchId !== launch.launchId || observation.owner !== launch.owner || observation.bootId !== launch.bootId
    || !same(observation.guardian, launch.guardian) || !same(observation.provider, launch.provider) || !same(observation.boundary, launch.boundary)) return unavailable('process_identity')
  if (source.type === 'session_created' && !same(source.session, session)) return unavailable('session_identity')
  if (source.type === 'history' && !same(source.history, readout.history)) return unavailable('history_identity')
  if (source.type === 'event' && (!readout.history || !readout.history.events.some(event => same({...event,executionId:receipt.intent.executionId}, source.event)))) return unavailable('event_identity')
  if (receipt.terminal) {
    const terminal = readout.history?.terminalTurn
    if (!readout.closure || !hasNativeClosure(observation)
      || !same(readout.closure.launch, observation) || !readout.closure.ownerClosed
      || receipt.terminal.kind === 'not_started'
      || receipt.terminal.closureEvidenceDigest !== commandInputHash({ intent:receipt.intent,native:receipt.native,
        launch,physicalOwnerClosed:true }).slice('sha256:'.length)) return unavailable('terminal_closure')
    if (receipt.terminal.result) {
      if (!terminal || terminal.correlationId !== receipt.turnInput?.correlationId || terminal.providerId !== receipt.native.turnId
        || readout.history?.nativeTurnId !== receipt.native.turnId || !same(terminal.result, receipt.terminal.result)
        || !readout.output || !same(readout.output.result, terminal.result)
        || receipt.terminal.resultDigest !== commandInputHash(terminal.result).slice('sha256:'.length)
        || receipt.terminal.kind !== (terminal.result.outcome==='succeeded'?'completed':terminal.result.outcome==='failed'?'failed':'cancelled')) return unavailable('terminal_result')
      if(readout.output.kind==='text-only'&&(receipt.terminal.artifactDigests?.length??0)!==0)return unavailable('text_artifacts')
      if (readout.output.kind === 'invalid-artifacts') {
        if (!same(readout.output.failure, receipt.terminal.artifactValidationError)
          || (receipt.terminal.artifactDigests?.length ?? 0) !== 0) return unavailable('artifact_validation')
      } else if (receipt.terminal.artifactValidationError) return unavailable('artifact_validation')
    } else if(receipt.terminal.kind!=='cancelled'||!receipt.stopFence||readout.output||(receipt.terminal.artifactDigests?.length??0)!==0)return unavailable('cancellation_closure')
  } else {
    if (readout.output || (readout.closure
      ? !hasNativeClosure(observation) || !same(readout.closure.launch,observation)
      : observation.lifecycle !== 'active')) return unavailable('running_process')
  }
}
interface RemoteWorkflowPhysicalVerificationInput {
  endpoint(): Pick<DeviceEndpoint, 'captureRequest' | 'currentBinding'>
  artifacts?: WorkflowPhysicalArtifactsPort
}

/** Network and real worker observations occur only in prefetch. bind() attaches
 * its opaque result to this exact private original-source object. SQL verification
 * reads retained evidence and original Main rows; it never performs native IO. */
export function createRemoteWorkflowPhysicalVerification(input: RemoteWorkflowPhysicalVerificationInput): RemoteNativeBatchPhysicalVerification & {
  passiveNativeOwner(original: VerifiedRemoteOriginalSource): PassiveRemoteNativeOwner | undefined
  confirmedClosed(prepared: PreparedRemoteWorkflowPhysical, session: NativeSessionReference | null): boolean
  prefetch(receipt: RemoteOperationReceipt, placement: AcceptedNodePlacement, source: WorkflowOriginalNativeSource, signal?: AbortSignal): Promise<PreparedRemoteWorkflowPhysical>
  /** Releases a superseded source Main did not capture for publication. */
  discard(prepared: PreparedRemoteWorkflowPhysical): Promise<RemoteWorkflowPhysicalAck>
  bind(original: VerifiedRemoteOriginalSource, prepared: PreparedRemoteWorkflowPhysical, owner: RunOwnership, lifetime: RemoteWorkflowMainLifetime): void
  /** Caller invokes only after durable canonical publication, outside G1. */
  acknowledge(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
  releaseExecution(original: VerifiedRemoteOriginalSource): boolean
  /** Retires a physical observation after its cold closure receipt has committed on Main. */
  acknowledgeClosed(prepared: PreparedRemoteWorkflowPhysical): Promise<RemoteWorkflowPhysicalAck>
  /** Requires every original event in this reply to have durably published. */
  acknowledgeReply(original:VerifiedRemoteOriginalSource):Promise<RemoteWorkflowPhysicalAck>
  artifactTerminalContext(sql:GraphTransactionSql,owner:RunOwnership,original:VerifiedRemoteOriginalSource,capture:WorkflowNativeCapture,proof:WorkflowNativeProofRecord):Promise<TransferContext>
  assertArtifactTerminal(sql:GraphTransactionSql,owner:RunOwnership,capture:WorkflowNativeCapture,proof:WorkflowNativeProofRecord):Promise<void>
  assertAdoptedArtifacts(sql:GraphTransactionSql,owner:RunOwnership,original:VerifiedRemoteOriginalSource):Promise<void>
} {
  const prepared = new WeakMap<object, Prepared>(), bound = new WeakMap<object, Bound>()
  const histories = new Map<string, Prepared>()
  const terminals = new WeakMap<WorkflowNativeCapture, WorkflowPhysicalTerminal>()
  const assertBound = (sql: GraphTransactionSql, owner: RunOwnership,
    original: VerifiedRemoteOriginalSource, retained: boolean) =>
    assertRemoteWorkflowBinding(sql, owner, original, retained, bound, input)
  const assertTerminal = (sql: GraphTransactionSql, owner: RunOwnership,
    captured: WorkflowNativeCapture, retained: WorkflowPhysicalTerminal, committed: boolean) =>
    assertRemoteWorkflowTerminal(sql, owner, captured, retained, committed, bound, input)
  return {
    async discard(value) {
      const capture = prepared.get(value)
      if (!capture) return unavailable('uncaptured_source')
      const ack = await capture.acknowledge(remoteWorkflowSourceDigest(capture.source))
      prepared.delete(value)
      const operationId = capture.readout.receipt.intent.operationId
      if (histories.get(operationId)?.readout === capture.readout) histories.delete(operationId)
      return ack
    },
    confirmedClosed(value, session) {
      const captured = prepared.get(value)
      if (!captured) return unavailable('uncaptured_closure')
      captured.assertCurrent()
      const { readout } = captured
      return (session === null || same(readout.session, session)) && readout.closure?.ownerClosed === true
        && hasNativeClosure(readout.observation) && same(readout.closure.launch, readout.observation)
    },
    async prefetch(receipt, placement, source, signal) {
      if (placement.hostRef.kind !== 'device') return unavailable('remote_placement')
      const deviceId = placement.hostRef.deviceId
      const original = input.endpoint().currentBinding(deviceId) ?? receipt.connection
      for (let reconnects = 0; ; reconnects++) {
        const attempted = input.endpoint().currentBinding(deviceId)
        try {
          return await prefetchRemoteWorkflowPhysical(input, prepared, histories, receipt, placement, source, signal)
        } catch (error) {
          if (!physicalReadoutLinkDropped(error, attempted, input.endpoint().currentBinding(deviceId))
            || reconnects >= 3) throw error
          await waitForDeviceReconnect({ original, failure: error, signal,
            live: () => input.endpoint().currentBinding(deviceId) })
        }
      }
    },
    bind(original, proof, owner, lifetime) {
      const capture = prepared.get(proof)
      if (!capture || original.verified.receipt.intent.runId !== owner.runId
        || !same(original.verified.receipt, capture.readout.receipt) || !same(original.source, capture.source)
        || original.sourceDigest !== remoteWorkflowSourceDigest(capture.source)
        || lifetime.execution.id !== capture.readout.receipt.intent.executionId || lifetime.execution.runId !== owner.runId
        || !same(lifetime.session, capture.readout.session) || lifetime.lifetimeGeneration < 1
        || !Number.isSafeInteger(lifetime.lifetimeGeneration) || !/^[1-9][0-9]*$/.test(lifetime.closureGeneration)) return unavailable('main_lifetime')
      owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); lifetime.assertCurrent()
      const previous = bound.get(original)
      if (previous) {
        if(previous.owner!==owner||!same(previous.readout,capture.readout)||previous.lifetime.lifetimeGeneration!==lifetime.lifetimeGeneration
          ||previous.lifetime.closureGeneration!==lifetime.closureGeneration||!same(previous.lifetime.session,lifetime.session)
          ||!same(previous.lifetime.lane,lifetime.lane)||!same(repeatExecutionIdentity(previous.lifetime.execution),repeatExecutionIdentity(lifetime.execution)))return unavailable('main_lifetime_changed')
        previous.lifetime.assertCurrent();return
      }
      bound.set(original, { ...capture, owner, lifetime:{...lifetime,execution:structuredClone(lifetime.execution),session:structuredClone(lifetime.session),
        lane:lifetime.lane?structuredClone(lifetime.lane):null},publications:new Set(),replyPublications:new Set(),terminalPublications:new Set() })
    },
    passiveNativeOwner(original) {
      const capture = bound.get(original)
      if (!capture || !capture.lifetime.lane || !capture.readout.receipt.native || capture.readout.receipt.terminal
        || capture.readout.observation.lifecycle !== 'active' || capture.readout.closure) return undefined
      const assertCurrent = () => {
        if (bound.get(original) !== capture) return unavailable('passive_owner')
        if (Date.parse(capture.readout.expiresAt) <= Date.now()) return unavailable('connection_expired')
        capture.owner.assertOwned(); original.assertCurrent(); capture.assertCurrent(); capture.lifetime.assertCurrent()
        assertSource(capture.readout, original.source, capture.placement)
      }
      try { assertCurrent() } catch { return undefined }
      return { nativeOwner: capture.readout.launch.owner, native: structuredClone(capture.readout.receipt.native),
        binding: Object.freeze(structuredClone(capture.binding)), assertCurrent }
    },
    async acknowledge(original) {
      const capture=bound.get(original)
      if(!capture||![...capture.publications].some(didGraphTransactionCommit))return unavailable('uncommitted_publication')
      capture.assertAcknowledgmentCurrent()
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(original.sourceDigest,
        [...capture.terminalPublications].some(didGraphTransactionCommit) ? { retire: true } : undefined)
    },
    async acknowledgeClosed(value) {
      const capture = prepared.get(value)
      if (!capture?.readout.receipt.terminal || !capture.readout.closure?.ownerClosed
        || !hasNativeClosure(capture.readout.observation)
        || !same(capture.readout.closure.launch, capture.readout.observation)) return unavailable('uncaptured_closure')
      capture.assertAcknowledgmentCurrent()
      const ack = await capture.acknowledge(remoteWorkflowSourceDigest({ type: 'boundary' }))
      histories.delete(capture.readout.receipt.intent.operationId)
      return ack
    },
    releaseExecution(original) {
      const capture = bound.get(original)
      if (!capture?.readout.receipt.terminal
        || ![...capture.terminalPublications].some(didGraphTransactionCommit)) return false
      const terminalReplyAcknowledged = original.source.type === 'boundary' || original.source.type === 'history'
        || [...capture.replyPublications].some(didGraphTransactionCommit)
      if (!terminalReplyAcknowledged) return false
      histories.delete(capture.readout.receipt.intent.operationId)
      return true
    },
    async acknowledgeReply(original) {
      const capture=bound.get(original)
      if(!capture?.readout.history||![...capture.replyPublications].some(didGraphTransactionCommit))return unavailable('uncommitted_history')
      capture.assertAcknowledgmentCurrent()
      original.assertCurrent();capture.assertCurrent()
      return capture.acknowledge(remoteWorkflowSourceDigest({type:'history',history:remoteWorkflowNativeHistory(capture.readout.history)}),
        [...capture.terminalPublications].some(didGraphTransactionCommit) ? { retire: true } : undefined)
    },
    async artifactTerminalContext(sql,owner,original,capture,proof) {
      assertGraphTransaction(sql)
      try {
        const actual=bound.get(original)
        if(!actual||actual.owner!==owner||!same(actual.lifetime.session,capture.session)
          ||!same(repeatExecutionIdentity(actual.lifetime.execution),repeatExecutionIdentity(capture.execution))
          ||actual.lifetime.lifetimeGeneration!==capture.lifetimeGeneration||actual.lifetime.closureGeneration!==capture.closureGeneration
          ||!same(actual.lifetime.lane,capture.lane)
          ||actual.readout.output?.kind!=='published-artifacts'||!actual.readout.closure
          ||capture.source.type!=='history'||proof.original.type!=='history'
          ||capture.owner!==owner||!same(capture.source,original.source)||!same(proof.original,capture.source)
          ||!same(proof.execution,repeatExecutionIdentity(capture.execution))||!same(proof.session,capture.session)
          ||!same(proof.lane,capture.lane)||proof.lifetimeGeneration!==capture.lifetimeGeneration
          ||proof.closureGeneration!==capture.closureGeneration||proof.commandId!==`execution:${capture.execution.id}`
          ||proof.scope.runId!==owner.runId||proof.ref.nodeId!==capture.execution.workflowNodeId
          ||proof.inputDigest!==repeatDigest(capture.execution.input))return unavailable('terminal_capture')
        // Establish this capability while the genuine private producer still owns the capture.
        actual.assertCurrent();capture.assertCurrent()
        await assertBound(sql,owner,original,false)
        const previous=terminals.get(capture)
        if(previous&&(!same(previous.proof,proof)||previous.original!==original||previous.capture!==actual))return unavailable('terminal_capture_changed')
        const retained={original,capture:actual,proof:structuredClone(proof),sql}
        await assertTerminal(sql,owner,capture,retained,false)
        terminals.set(capture,retained)
        actual.terminalCapture=capture
        requireRepeatCanonicalReceiptBeforeCommit(sql,{scope:proof.scope,evidence:{sourceKind:'native_event',sourceId:proof.proofId,sourceRevision:'1'},
          sourceDigest:repeatDigest(proof,REMOTE_NATIVE_SOURCE_LIMIT),effect:null})
        beforeGraphCommit(sql,()=>assertTerminal(sql,owner,capture,retained,false))
        return transferContextForBinding(actual.binding)
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    async assertArtifactTerminal(sql,owner,capture,proof) {
      assertGraphTransaction(sql)
      try {
        const retained=terminals.get(capture)
        if(!retained||!didGraphTransactionCommit(retained.sql)||!same(retained.proof,proof))return unavailable('uncommitted_terminal')
        await assertTerminal(sql,owner,capture,retained,true)
        beforeGraphCommit(sql,()=>assertTerminal(sql,owner,capture,retained,true))
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    async assertAdoptedArtifacts(sql,owner,original) {
      assertGraphTransaction(sql)
      try {
        const capture=bound.get(original)
        const terminal=capture?.terminalCapture&&terminals.get(capture.terminalCapture)
        if(!capture?.terminalCapture||!terminal||terminal.original!==original||!didGraphTransactionCommit(terminal.sql)
          ||![...capture.publications].some(didGraphTransactionCommit)||!input.artifacts)return unavailable('artifact_publication')
        await assertTerminal(sql,owner,capture.terminalCapture,terminal,true)
        await input.artifacts.assertAdopted(sql,capture.readout,capture.binding)
        beforeGraphCommit(sql,async()=>{await assertTerminal(sql,owner,capture.terminalCapture!,terminal,true);await input.artifacts!.assertAdopted(sql,capture.readout,capture.binding)})
      }catch(error){poisonGraphTransaction(sql);throw error}
    },
    assertOriginal: (sql: GraphTransactionSql, owner: RunOwnership, original: VerifiedRemoteOriginalSource) => assertBound(sql, owner, original, false),
    async assertOriginals(sql, owner, originals) {
      const proofs = await readRemotePublicationProofs(sql, owner, originals, bound)
      for (const original of originals) {
        await assertRemoteWorkflowBinding(sql, owner, original, false, bound, input, proofs)
      }
    },
  }

}

async function prefetchRemoteWorkflowPhysical(input: RemoteWorkflowPhysicalVerificationInput,
  prepared: WeakMap<object, Prepared>, histories: Map<string, Prepared>, receipt: RemoteOperationReceipt,
  placement: AcceptedNodePlacement, source: WorkflowOriginalNativeSource,
  signal?: AbortSignal): Promise<PreparedRemoteWorkflowPhysical> {
  signal?.throwIfAborted()
  if (placement.hostRef.kind !== 'device' || !placement.registration || !receipt.native) return unavailable('remote_placement')
  const endpoint = input.endpoint(), captured = endpoint.captureRequest(placement.hostRef.deviceId, 'execution-v1')
  if (!captured) throw new DeviceConnectionError('transport')
  const retained = histories.get(receipt.intent.operationId)
  const retainedSource = retained && (source.type === 'history'
    ? same(source.history, retained.readout.history)
    : source.type === 'event' && retained.readout.history?.events.some(event =>
      same({ ...event, executionId: receipt.intent.executionId }, source.event)))
  if (retained && retained.signal === signal && retainedSource && same(retained.readout.receipt, receipt)
    && same(retained.placement, placement) && same(retained.binding, captured.binding)
    && !retained.isExpired()) {
    retained.assertCurrent()
    assertSource(retained.readout, source, placement)
    const result = Object.freeze({ kind: 'original-remote-physical' as const })
    prepared.set(result, { ...retained, source: structuredClone(source) })
    return result
  }
  // Network waits have their own deadline; freshness comes from the returned Worker observation.
  let rebootClosed = false
  const assertRegisteredConnection = () => {
    signal?.throwIfAborted()
    const current = endpoint.currentBinding(placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : '')
    if (!current || !same(current, captured.binding)
      || !same(DeviceConnectionIdentitySchema.parse({mainId:current.mainId,deviceId:current.deviceId,
        workerInstallationId:current.workerInstallationId,keyRevision:current.keyRevision,authorizationRevision:current.authorizationRevision,
        bootId:receipt.connection.bootId,connectionGeneration:receipt.connection.connectionGeneration}), receipt.connection)) return unavailable('connection_expired')
  }
  const assertCurrent = () => {
    assertRegisteredConnection()
    if (captured.binding.bootId !== receipt.connection.bootId && !rebootClosed) return unavailable('boot_changed')
  }
  const request = async (payload: unknown) => {
    let ordinaryFailures = 0
    for (let attempt = 0; ; attempt++) {
      assertRegisteredConnection()
      try {
        const response = await captured.request(payload,
          { ...(signal ? { signal } : {}), timeoutMs: deviceRequestTimeoutMs })
        assertRegisteredConnection()
        return response
      } catch (error) {
        if (physicalReadoutLinkDropped(error, captured.binding,
          input.endpoint().currentBinding(captured.binding.deviceId))) throw error
        assertRegisteredConnection()
        const failure = deviceApplicationFailure(error)
        if (!failure.retryable || ['transport', 'DEVICE_LINK_DROPPED', 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE',
          'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED']
          .includes(failure.code)) throw error
        // Only an identified Main database timeout leaves the ordinary RPC budget untouched.
        if (failure.code !== 'DATABASE_READ_TIMEOUT' && ordinaryFailures++ >= 4) throw error
        await waitForDeviceRetry(Math.min(2_000, 250 * 2 ** attempt), signal)
      }
    }
  }
  let readout: RemoteWorkflowPhysicalReadout
  for (let attempt = 0; ; attempt++) {
    assertRegisteredConnection()
    try {
      const reply = await request({ method: 'physical-readout', intent: receipt.intent, placement,
        receiptSequence: receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(source) })
      if (reply.bytes !== undefined) return unavailable('readout_binary')
      readout = await readPhysicalReadout(reply.payload, async metadata => {
        assertRegisteredConnection()
        const next = await request({ method: 'physical-readout', intent: receipt.intent, placement,
          receiptSequence: receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(source), metadata })
        assertRegisteredConnection()
        if (next.bytes !== undefined) return unavailable('readout_binary')
        return next.payload
      }, signal)
      break
    } catch (error) {
      // Older Workers omit the reason on the wire. Refresh the operation; its next readout still needs full verification.
      if (error instanceof DeviceApplicationError && error.code === 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE') {
        throw new DeviceApplicationError('REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', undefined, { cause: error })
      }
      // Expired pages require a fresh observation; bytes from different snapshots cannot be combined.
      if (deviceApplicationFailure(error).code !== 'transfer-expired' || attempt >= 4) throw error
    }
  }
  const expiresAt = Math.min(Date.now() + 60_000, Date.parse(readout.expiresAt))
  if (!same(readout.receipt, receipt)) return unavailable('readout_receipt')
  assertSource(readout, source, placement)
  rebootClosed = Boolean(receipt.terminal && readout.closure?.ownerClosed
    && readout.observation.closureEvidence === 'linux_boot_changed'
    && same(readout.closure.launch, readout.observation))
  if (expiresAt <= Date.now()) return unavailable('connection_expired')
  assertCurrent()
  const assertAcknowledgmentCurrent = () => {
    const current = endpoint.currentBinding(captured.binding.deviceId)
    // ACK retires a committed reply, so Main's publication time cannot expire it.
    if (signal?.aborted || current && !same(current, captured.binding)) {
      throw new DomainError('REMOTE_NATIVE_ACK_OBSOLETE',
        'The captured physical observation can no longer authorize an acknowledgment.', 409)
    }
    assertCurrent()
  }
  const result = Object.freeze({ kind: 'original-remote-physical' as const })
  const observation: Prepared = {
    signal,
    isExpired: () => expiresAt <= Date.now(),
    binding: Object.freeze(structuredClone(captured.binding)),
    readout,
    placement: structuredClone(placement),
    source: structuredClone(source),
    assertCurrent,
    assertAcknowledgmentCurrent,
    acknowledge: async (sourceDigest, options) => {
      assertAcknowledgmentCurrent()
      const reply = await request({ method: 'physical-ack', intent: receipt.intent, placement,
        receiptSequence: receipt.sequence, sourceDigest, ...options })
      if(reply.bytes!==undefined)return unavailable('ack_binary')
      const ack=RemoteWorkflowPhysicalAckSchema.parse(reply.payload)
      assertAcknowledgmentCurrent()
      if(ack.operationId!==receipt.intent.operationId||ack.receiptSequence!==receipt.sequence||ack.sourceDigest!==sourceDigest)return unavailable('ack_identity')
      return ack
    } }
  prepared.set(result, observation)
  if (readout.history) {
    // Events already present in one authenticated history share its bounded
    // physical observation; every publication still checks its original lease.
    histories.delete(receipt.intent.operationId)
    histories.set(receipt.intent.operationId, observation)
    if (histories.size > 16) histories.delete(histories.keys().next().value!)
  }
  return result
}

function physicalReadoutLinkDropped(error: unknown, previous: Readonly<DeviceSessionBinding> | undefined,
  current: Readonly<DeviceSessionBinding> | undefined): boolean {
  const unanswered = error instanceof DeviceConnectionError && ['timeout', 'backpressure'].includes(error.code)
  if (unanswered && previous && same(previous, current)) return false
  return isDeviceLinkDrop(error) || deviceApplicationFailure(error).code === 'DEVICE_LINK_DROPPED'
}

/** Facts one remote binding check read from the Run's rows; shared by every original of the same capture. */
interface RemoteBindingRows { execution: HarnessExecution; sessionStored: boolean }
interface SharedBindingCheck {
  readout: RemoteWorkflowPhysicalReadout; placement: AcceptedNodePlacement; binding: Readonly<DeviceSessionBinding>
  owner: RunOwnership; retained: boolean; lifetime: unknown; rows: RemoteBindingRows
}
const sharedBindingChecks = new WeakMap<GraphTransactionSql, { finalizing: boolean; checks: SharedBindingCheck[] }>()
const lifetimeFacts = (lifetime: RemoteWorkflowMainLifetime) => ({ execution: lifetime.execution, session: lifetime.session,
  lifetimeGeneration: lifetime.lifetimeGeneration, closureGeneration: lifetime.closureGeneration, lane: lifetime.lane,
  review: lifetime.review })

/** Every original of one history shares its capture, so the Run-locked binding reads run once per transaction
 * phase instead of once per event. The COMMIT phase always reads again: by then this transaction's own writes are
 * done, and the rows it locked cannot change before COMMIT. */
async function sharedRemoteBindingRows(sql: GraphTransactionSql, owner: RunOwnership, capture: Bound, retained: boolean,
  input: RemoteWorkflowPhysicalVerificationInput): Promise<RemoteBindingRows> {
  const finalizing = isGraphTransactionFinalizing(sql)
  let shared = sharedBindingChecks.get(sql)
  if (!shared || shared.finalizing !== finalizing) sharedBindingChecks.set(sql, shared = { finalizing, checks: [] })
  const lifetime = lifetimeFacts(capture.lifetime)
  const found = shared.checks.find(check => check.readout === capture.readout && check.placement === capture.placement
    && check.binding === capture.binding && check.owner === owner && check.retained === retained && same(check.lifetime, lifetime))
  if (found) return found.rows
  const rows = await readRemoteBindingRows(sql, capture, retained, input)
  shared.checks.push({ readout: capture.readout, placement: capture.placement, binding: capture.binding, owner, retained, lifetime, rows })
  return rows
}

/** Closed output uses its committed terminal as readback authority after credentials end. */
async function isCommittedTerminalReplay(sql: GraphTransactionSql, execution: HarnessExecution,
  source: WorkflowOriginalNativeSource, session: NativeSessionReference): Promise<boolean> {
  if (execution.state !== 'completed' || source.type !== 'history' || !source.history.terminalTurn
    || source.history.pendingInteraction || source.history.pendingInteractions.length) return false
  const proof = await readWorkflowTerminalSource(sql, execution)
  if (!proof || proof.original.type !== 'history' || !same(proof.session, session)
    || !same(proof.original.history.terminalTurn, source.history.terminalTurn)) return false
  assertOriginalWorkflowTerminal(execution, session, source.history, source.history.terminalTurn.correlationId)
  return true
}

async function readRemoteBindingRows(sql: GraphTransactionSql, capture: Bound, retained: boolean,
  input: RemoteWorkflowPhysicalVerificationInput): Promise<RemoteBindingRows> {
  const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
  const published=readout.output?.kind==='published-artifacts'
  const invalidArtifacts = readout.output?.kind === 'invalid-artifacts'
  const current = await readReconciledDispatchIntent(sql, intent.operationId, true)
  if (readout.launchIntent) {
    const originalDispatch = (await sql.query<{ record: unknown }>(
      'select record from execution_dispatch_intents where operation_id=$1 for share', [intent.operationId])).rows[0]
    if (!originalDispatch || !same(originalDispatch.record, readout.launchIntent)) return unavailable('launch_dispatch')
  }
  if (lifetime.review) await assertRemoteReviewerReceipt(sql, receipt)
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  const rawNative = await readNativePlacement(sql, intent.executionId)
  if (!current || !placement || !rawNative || !same(current, intent) || !same(placement, capture.placement)) return unavailable('dispatch_binding')
  const native = readNativeExecutionBinding(placement, intent, rawNative)
  if (sourceMaterializationDigest(native.materialization) !== sourceMaterializationDigest(readout.source.record)
    || !same(native.workingTree, readout.source.workingTree) || readout.runtimeLeaf.bindingHash !== native.bindingHash
    || readout.runtimeLeaf.executionId !== intent.executionId || readout.runtimeLeaf.attemptId !== intent.attemptId
    || readout.runtimeLeaf.operationId !== intent.operationId || readout.runtimeLeaf.materializationId !== native.materialization.receipt.materializationId
    || readout.runtimeLeaf.materializationDigest !== native.workingTree.materializationDigest
    || readout.runtimeLeaf.canonicalRuntimeDirectory !== lifetime.execution.runtimeDirectory) return unavailable('runtime_binding')
  const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [intent.operationId])).rows[0]
  if (!origin || !same(DeviceConnectionIdentitySchema.parse(origin.connection), receipt.connection)) return unavailable('dispatch_connection')
  // accepted marks terminal result acceptance, after physical proof/adoption.
  const executionRow = (await sql.query<{ record: unknown; authorized: boolean }>(`select e.record,
    (e.worker_credentials_closed_at is null or $3='reviewer') and exists(
      select 1 from worker_credential_bindings b join management_principals p on p.id=b.principal_id
      where b.execution_id=e.id and b.run_id=e.run_id and b.agent_id=e.agent_id and b.purpose=$3
        and b.revoked_at is null and p.revoked_at is null and p.expires_at>clock_timestamp()
        and p.audience='worker' and p.agent_id=b.agent_id) as authorized
    from harness_executions e where e.id=$1 and e.run_id=$2 for share of e`,
  [intent.executionId, intent.runId, lifetime.review ? 'reviewer' : 'workflow'])).rows[0]
  const execution = HarnessExecutionSchema.safeParse(executionRow?.record)
  // Finalizing a completed workflow promotes its original process credential for reviews.
  const reviewer = !executionRow?.authorized && !lifetime.review && receipt.retainedReviewer && !receipt.terminal
    && execution.success && execution.data.state === 'completed'
    && same(execution.data.result, receipt.retainedReviewer.result)
    ? await readRetainedRemoteReviewer(sql, execution.data) : undefined
  const reviewerAuthorized = reviewer?.generation === lifetime.closureGeneration && same(reviewer?.session, readout.session)
  const committedPublication = retained && [...capture.publications].some(didGraphTransactionCommit)
  const completedReplay = !committedPublication && !executionRow?.authorized && !reviewerAuthorized
    && execution.success && !lifetime.review && receipt.outputValidationComplete
    && (receipt.terminal?.kind === 'completed' || receipt.terminal?.kind === 'failed')
    && await isCommittedTerminalReplay(sql, execution.data, capture.source, readout.session)
  if (!committedPublication && !completedReplay && !receipt.stopFence && !executionRow?.authorized && !reviewerAuthorized) {
    return unavailable('execution_authorization')
  }
  if (!execution.success || execution.data.id !== lifetime.execution.id
    || execution.data.agentId !== lifetime.execution.agentId || execution.data.attempt !== intent.technicalAttempt
    || execution.data.workflowNodeId !== intent.nodeId || execution.data.workingDirectory !== native.workingTree.canonicalCwd
    || execution.data.nativeSessionId !== undefined && execution.data.nativeSessionId !== readout.session.nativeSessionId) return unavailable('execution_binding')
  if(published){
    if(execution.data.runId!==lifetime.execution.runId||!same(repeatExecutionIdentity(execution.data),repeatExecutionIdentity(lifetime.execution))
      ||execution.data.runtimeDirectory!==lifetime.execution.runtimeDirectory||!same(execution.data.input,lifetime.execution.input)
      ||execution.data.createdAt!==lifetime.execution.createdAt
      ||execution.data.result!==undefined&&!await matchesWorkflowNativeTerminalLocked(sql,execution.data,readout.output?.result))return unavailable('published_execution')
    const saved=(await sql.query<{receipt:unknown}>('select receipt from remote_execution_receipts where operation_id=$1 for share',[intent.operationId])).rows[0]
    if(!saved||!same(saved.receipt,receipt))return unavailable('published_receipt')
  }
  await assertRemoteNativeEntry(sql, intent, execution.data, published)
  const sessionRow = (await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share', [intent.executionId])).rows[0]
  if (sessionRow && !same(NativeSessionReferenceSchema.parse(sessionRow.reference), readout.session)) return unavailable('stored_session')
  const closure = await assertRemoteNativeClosure(sql, capture, execution.data, published || invalidArtifacts)
  if (lifetime.lane) await assertRemoteWriterLane(sql, capture, execution.data, retained && closure.closed)
  if(published || invalidArtifacts){if(!input.artifacts)return unavailable('artifact_verifier');await input.artifacts.assertPublications(sql,readout,capture.binding)}
  return { execution: execution.data, sessionStored: sessionRow !== undefined }
}

async function assertRemoteNativeEntry(sql: GraphTransactionSql, intent: RemoteOperationReceipt['intent'],
  execution: HarnessExecution, published: boolean): Promise<void> {
  const entry = (await sql.query<{ phase: string; source_id: string | null; source_digest: string | null;
    reservation: WorkflowNativeReservation; transition: WorkflowNativeEntryRecord }>(
    'select phase,source_id,source_digest,reservation,transition from workflow_native_entries where execution_id=$1 and run_id=$2 for share', [intent.executionId, intent.runId])).rows[0]
  if (!entry || entry.phase !== 'entered' || entry.transition?.phase !== 'entered' || !entry.transition.launchDigest || !entry.source_id || !entry.source_digest
    || entry.reservation?.scope?.runId !== intent.runId || !same(entry.reservation.execution, repeatExecutionIdentity(execution))
    || !same(entry.transition.reservation,entry.reservation)) return unavailable('native_entry')
  if(!published) return
  const reservation=workflowNativeReservation(entry.reservation.scope,entry.reservation.ref,execution,repeatDigest(execution.input,4*1024*1024))
  const admitted=await readWorkflowNativeEntryLocked(sql,reservation)
  if(admitted.phase!=='entered'||!same(admitted.transition,entry.transition)||admitted.source_id!==entry.source_id
    ||admitted.source_digest!==entry.source_digest||entry.source_digest!==repeatDigest(entry.transition,8*1024*1024)
    ||(reservation.ref.occurrence?.occurrenceId??null)!==intent.occurrenceId
    ||(reservation.ref.occurrence?.occurrenceIndex??0)!==intent.occurrenceIndex)return unavailable('published_native_entry')
  await assertRepeatCanonicalReceiptLocked(sql,{scope:reservation.scope,
    evidence:{sourceKind:'execution',sourceId:entry.source_id,sourceRevision:'1'},sourceDigest:entry.source_digest,effect:null})
  const effects=await sql.query<{payload_digest:string}>(
    "select payload_digest from run_repeat_effects where run_id=$1 and effect_kind='input.bind' and entity_id=$2 for share",
    [intent.runId,intent.executionId])
  if(effects.rows.length!==1||!effects.rows[0])return unavailable('input_binding')
  const inputReceipt=canonicalRepeatEffectReceipt(reservation.scope,{kind:'input.bind',entityId:intent.executionId,digest:effects.rows[0].payload_digest})
  await assertRepeatCanonicalReceiptLocked(sql,inputReceipt)
  requireRepeatCanonicalReceiptBeforeCommit(sql,inputReceipt)
}

async function assertRemoteNativeClosure(sql: GraphTransactionSql, capture: Bound, execution: HarnessExecution,
  withOutput: boolean): Promise<{ closed: boolean }> {
  const { readout, lifetime } = capture
  const closure = (await sql.query<{ generation: string; expected_reference: unknown; closed_reference:unknown; closed: boolean; detached:boolean;
    closed_without_session:boolean; execution_identity:unknown }>(`select generation::text,expected_reference,closed_reference,execution_identity,closed_without_session,
    closed_at is not null as closed,detached_at is not null as detached from execution_native_closures where execution_id=$1 order by generation desc limit 1 for share`, [readout.receipt.intent.executionId])).rows[0]
  if (!closure || closure.generation !== lifetime.closureGeneration || closure.detached
    || closure.expected_reference !== null && !same(closure.expected_reference, readout.session)) return unavailable('closure_generation')
  if(closure.closed){
    const e=execution
    const identity={id:e.id,runId:e.runId,workflowNodeId:e.workflowNodeId,agentId:e.agentId,
      agentConfigurationVersionId:e.agentConfigurationVersionId,attempt:e.attempt,
      ...(e.workingDirectory?{workingDirectory:e.workingDirectory}:{}),...(e.runtimeDirectory?{runtimeDirectory:e.runtimeDirectory}:{})}
    if(!withOutput||!readout.closure||closure.closed_without_session||!same(closure.closed_reference,readout.session)
      ||!same(closure.execution_identity,identity))return unavailable('stored_closure')
  }
  return { closed: closure.closed }
}

async function assertRemoteWriterLane(sql: GraphTransactionSql, capture: Bound, execution: HarnessExecution,
  closedAfterRetention: boolean): Promise<void> {
  const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
  const lane = (await sql.query<{ owner_agent_id: string; harness: string; native_session_id: string; generation: string;
    token: string | null; correlation: string | null; provider_id: string | null; held: boolean }>(`select owner_agent_id,harness,native_session_id,
    record->>'connectionGeneration' as generation,record->>'leaseToken' as token,record->>'correlationId' as correlation,
    record->>'currentTurnOrMessageId' as provider_id,coalesce((record->>'leaseExpiresAt')::timestamptz>clock_timestamp(),false) as held
    from native_session_lanes where id=$1 for share`, [lifetime.lane!.id])).rows[0]
  if (!lane) return unavailable('writer_lane_missing')
  const releasedAfterClosure = closedAfterRetention && lane.token === null
  if (!lane.held && !releasedAfterClosure) return unavailable('writer_lane_expired')
  if (lane.owner_agent_id !== execution.agentId || lane.harness !== readout.session.harness
    || lane.native_session_id !== readout.session.nativeSessionId) return unavailable('writer_lane_session')
  if (lane.token !== lifetime.lane!.token && !releasedAfterClosure) return unavailable('writer_lane_token')
  if (lane.generation !== String(lifetime.lane!.connectionGeneration)) return unavailable('writer_lane_generation')
  const correlation = lifetime.review?.correlationId ?? receipt.turnInput?.correlationId ?? `execution:${intent.executionId}`
  const providerId = lifetime.review
    ? receipt.reviewTurns?.find(turn => turn.assignment.jobId === lifetime.review!.jobId)?.providerId : receipt.native?.turnId
  if (lane.correlation !== correlation) return unavailable('writer_lane_correlation')
  if (providerId !== undefined && lane.provider_id !== providerId) {
    return unavailable('writer_lane_receipt_turn')
  }
  if (lifetime.lane!.providerId !== null && lane.provider_id !== lifetime.lane!.providerId) {
    return unavailable('writer_lane_captured_turn')
  }
}

async function assertRemoteWorkflowBinding(sql: GraphTransactionSql, owner: RunOwnership,
  original: VerifiedRemoteOriginalSource, retained: boolean, bound: WeakMap<object, Bound>,
  input: RemoteWorkflowPhysicalVerificationInput,
  proofs?: readonly WorkflowNativeProofRecord[]): Promise<void> {
  assertGraphTransaction(sql)
  const capture = bound.get(original)
  if (!capture || capture.owner !== owner) return unavailable('unbound_owner')
  const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
  const published=readout.output?.kind==='published-artifacts'
  const check = () => {
    owner.assertOwned()
    // An admitted operation may finish slow Main work; later operations need fresh evidence.
    if (!retained && capture.processingSql !== sql) {
      if (capture.processingSql && capture.isExpired()) return unavailable('connection_expired')
      capture.processingSql = sql
    }
    if(retained){
      if(!published||!readout.closure||!same(input.endpoint().currentBinding(capture.binding.deviceId),capture.binding)
        ||!same(original.verified.receipt,receipt)||!same(original.source,capture.source)
        ||original.sourceDigest!==remoteWorkflowSourceDigest(capture.source))return unavailable('published_capture')
    }else{original.assertCurrent();capture.assertCurrent();lifetime.assertCurrent()}
    assertSource(readout,original.source,capture.placement)
  }
  check()
  // During COMMIT checks the rows are final: a second check of the same original repeats only the in-memory checks.
  const finalized = isGraphTransactionFinalizing(sql) ? finalizedOriginals(sql, retained) : undefined
  if (finalized?.has(original)) return
  const rows = await sharedRemoteBindingRows(sql, owner, capture, retained, input)
  if (!rows.sessionStored && original.source.type !== 'session_created') {
    // The shared check may predate this transaction's own session insert; read it again for this original.
    const sessionRow = (await sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share', [intent.executionId])).rows[0]
    if (!sessionRow || !same(NativeSessionReferenceSchema.parse(sessionRow.reference), readout.session)) return unavailable('stored_session')
  }
  if (!lifetime.lane && (original.source.type === 'history' || original.source.type === 'event')) return unavailable('missing_writer_lane')
  check()
  await recordRemotePublications(sql, original, capture, rows.execution, proofs)
  check()
  finalized?.add(original)
}
const finalizedChecks = new WeakMap<GraphTransactionSql, Map<boolean, WeakSet<VerifiedRemoteOriginalSource>>>()
function finalizedOriginals(sql: GraphTransactionSql, retained: boolean): WeakSet<VerifiedRemoteOriginalSource> {
  let byMode = finalizedChecks.get(sql)
  if (!byMode) finalizedChecks.set(sql, byMode = new Map())
  let originals = byMode.get(retained)
  if (!originals) byMode.set(retained, originals = new WeakSet())
  return originals
}

/** Fetch every source needed for publication acknowledgments once for this boundary. */
async function readRemotePublicationProofs(sql: GraphTransactionSql, owner: RunOwnership,
  originals: readonly VerifiedRemoteOriginalSource[], bound: WeakMap<object, Bound>): Promise<WorkflowNativeProofRecord[]> {
  assertGraphTransaction(sql)
  const ids = new Set<string>()
  const settledExecutions = new Set<string>()
  for (const original of originals) {
    const capture = bound.get(original)
    if (!capture || capture.owner !== owner) return unavailable('unbound_owner')
    const executionId = capture.readout.receipt.intent.executionId
    if (original.source.type !== 'boundary') ids.add(workflowNativeSourceId(executionId, original.source))
    if (original.source.type === 'history' && capture.readout.receipt.terminal) settledExecutions.add(executionId)
    for (const event of capture.readout.history?.events ?? []) {
      ids.add(workflowNativeSourceId(executionId, { type: 'event', event: { ...event, executionId } }))
    }
  }
  if (!ids.size) return []
  const rows = await sql.query<{ record: WorkflowNativeProofRecord }>(
    `select record from workflow_native_proofs where run_id=$1
      and (proof_id=any($2::text[]) or execution_id=any($3::text[]) and record ? 'settlementOf')`,
    [owner.runId, [...ids], [...settledExecutions]])
  return rows.rows.map(row => row.record)
}

/** Publication is acknowledged only after this exact original was retained by the existing canonical writer AND
 * its owning transaction committed. A boundary observation is never retained as a source, so it has no proof. */
async function recordRemotePublications(sql: GraphTransactionSql, original: VerifiedRemoteOriginalSource,
  capture: Bound, execution: HarnessExecution, retainedProofs?: readonly WorkflowNativeProofRecord[]): Promise<void> {
  const { readout, lifetime } = capture, receipt = readout.receipt, intent = receipt.intent
  const matching = retainedProofs?.filter(record => record.scope.runId === intent.runId
    && record.execution.executionId === intent.executionId)
  const settledHistory = original.source.type === 'history' && !!receipt.terminal
  let proofs: { rows: { record: WorkflowNativeProofRecord }[] }
  if (matching) {
    proofs = { rows: matching.filter(record => original.source.type !== 'boundary'
      && (record.proofId === workflowNativeSourceId(intent.executionId, original.source)
        || settledHistory && record.settlementOf)).map(record => ({ record })) }
  } else if (original.source.type === 'boundary') {
    proofs = { rows: [] }
  } else {
    proofs = await sql.query<{ record: WorkflowNativeProofRecord }>(`select record from workflow_native_proofs
      where execution_id=$1 and run_id=$2 and (proof_id=$3 or $4::boolean and record ? 'settlementOf')`,
    [intent.executionId, intent.runId, workflowNativeSourceId(intent.executionId, original.source), settledHistory])
  }
  if(proofs.rows.some(row=>row.record.execution.executionId===intent.executionId&&same(row.record.session,readout.session)
    &&same(row.record.original,original.source)))capture.publications.add(sql)
  if (lifetime.review) {
    const records = await sql.query<{ record: ReviewNativeProofRecord }>(`select record from review_native_proofs
      where execution_id=$1 and run_id=$2 and job_id=$3`, [intent.executionId, intent.runId, lifetime.review.jobId])
    const matches = records.rows.some(({ record }) => {
      let source: WorkflowOriginalNativeSource = { type: 'boundary' }
      if (record.original.type === 'event') source = { type: 'event', event: { ...record.original.event, executionId: intent.executionId } }
      if (record.original.type === 'history') source = { type: 'history', history: record.original.history }
      return record.job.correlationId === lifetime.review!.correlationId
        && same(record.session, readout.session) && same(source, original.source)
    })
    if (matches) capture.publications.add(sql)
  }
  // Source publication may precede the execution's terminal update. Only
  // the transaction that sees the matching saved result may retire the Worker.
  if (capture.publications.has(sql) && execution.state === 'completed' && receipt.terminal
    && (receipt.terminal.result ? await matchesWorkflowNativeTerminalLocked(sql, execution, receipt.terminal.result)
      : receipt.terminal.kind === 'cancelled' && (execution.result?.outcome === 'canceled'
        || lifetime.review && receipt.retainedReviewer && same(execution.result, receipt.retainedReviewer.result)))) {
    capture.terminalPublications.add(sql)
  }
  if(readout.history && capture.publications.has(sql)) {
    const sources:WorkflowOriginalNativeSource[]=readout.history.events.map(event=>({type:'event',event:{...event,executionId:intent.executionId}}))
    const sourceIds = new Set(sources.map(source => workflowNativeSourceId(intent.executionId, source)))
    const events = matching ? { rows: matching.filter(record => sourceIds.has(record.proofId))
      .map(record => ({ original: record.original })) }
      : await sql.query<{original:WorkflowOriginalNativeSource}>(`select record->'original' as original from workflow_native_proofs
      where execution_id=$1 and run_id=$2 and proof_id=any($3::text[])`,
      [intent.executionId,intent.runId,sources.map(source=>workflowNativeSourceId(intent.executionId,source))])
    if(sources.every(source=>events.rows.some(row=>same(row.original,source))))capture.replyPublications.add(sql)
  }
}


async function assertRemoteWorkflowTerminal(sql: GraphTransactionSql, owner: RunOwnership,
  captured: WorkflowNativeCapture, retained: WorkflowPhysicalTerminal, committed: boolean,
  bound: WeakMap<object, Bound>, input: RemoteWorkflowPhysicalVerificationInput): Promise<void> {
  try {
    if(retained.capture.owner!==owner||captured.owner!==owner||bound.get(retained.original)!==retained.capture)return unavailable('terminal_owner')
    if(!committed)retained.capture.assertCurrent()
    const proof=retained.proof
    const fence=await owner.readOneShotFence(sql)
    if(fence.ownerId!==proof.ownerId||fence.fence!==proof.ownerFence)return unavailable('terminal_run_owner')
    const row=(await sql.query<{record:WorkflowNativeProofRecord;source_digest:string}>(
      'select record,source_digest from workflow_native_proofs where proof_id=$1 and run_id=$2 and execution_id=$3 for share',
      [proof.proofId,proof.scope.runId,captured.execution.id])).rows[0]
    if(!row||!same(row.record,proof)||row.source_digest!==repeatDigest(proof,REMOTE_NATIVE_SOURCE_LIMIT))return unavailable('terminal_proof')
    await assertRemoteWorkflowBinding(sql, owner, retained.original, true, bound, input)
    if(committed){
      const execution=(await sql.query<{record:unknown}>('select record from harness_executions where id=$1 and run_id=$2 for share',
        [captured.execution.id,owner.runId])).rows[0]
      const saved=HarnessExecutionSchema.safeParse(execution?.record)
      if(!saved.success||saved.data.state!=='completed'||!same(saved.data.result,retained.capture.readout.output?.result))return unavailable('terminal_execution')
      await assertRepeatCanonicalReceiptLocked(sql,{scope:proof.scope,
        evidence:{sourceKind:'native_event',sourceId:proof.proofId,sourceRevision:'1'},sourceDigest:row.source_digest,effect:null})
    }
  }catch(error){poisonGraphTransaction(sql);throw error}
}

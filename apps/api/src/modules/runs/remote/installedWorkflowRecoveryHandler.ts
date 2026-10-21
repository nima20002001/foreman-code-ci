import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import type { NativeHistory } from '../../harnesses/port.js'
import type { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import { pageNativeHistory, startNativeHistoryDownload, nativeHistoryPageSource } from './nativeHistoryPage.js'
import { assertOriginalPhysicalDirectories, matchingOriginalRegistryLaunch,
  type InstalledWorkflowPhysicalReadouts } from './workflowPhysicalReadout.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import { pagePhysicalReadout, remoteWorkflowSourceDigest, remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { hasPositiveRemoteNonEntryClosure, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { randomUUID } from 'node:crypto'

async function closedEntryReply(frame: RemoteExecutionRpcRequest, journal: RemoteOperationJournal) {
  const status = await journal.status(frame.intent.operationId)
  if (status.status !== 'known' || !status.receipt.terminal || status.receipt.native) {
    throw new Error('Original sessionless entry closure is unavailable')
  }
  if (frame.method === 'prepare' || frame.method === 'reattach') return { payload: { status } }
  if (frame.method === 'control-delivery') {
    return { payload: { phase: await journal.controlDelivery(frame.command) ?? 'unknown', status } }
  }
  if (frame.method === 'history' || frame.method === 'reconcile-response') {
    const history: NativeHistory = { events: [], pendingInteractions: [] }
    const metadata = frame.method === 'history' ? frame.metadata : undefined
    const afterSequence = frame.method === 'history' ? frame.afterSequence : undefined
    const reply = metadata ? pageNativeHistory(history, afterSequence, metadata)
      : startNativeHistoryDownload(history, { afterSequence, downloadId: frame.downloadId })
    return { payload: { ...reply, status } }
  }
  if (frame.method === 'pending') return { payload: null }
  return { payload: status }
}

export async function recoverInstalledWorkflowReply(input: {
  frame: RemoteExecutionRpcRequest
  binding: Readonly<DeviceSessionBinding>
  journal: RemoteOperationJournal
  recovery: InstalledWorkflowRecovery
  registry: NativeProcessRegistry
  physical: InstalledWorkflowPhysicalReadouts
  signal: AbortSignal
  lifetimeSignal: AbortSignal
  assertCurrent(): void
  authorize(action: 'read' | 'stop' | 'control'): Promise<void>
}): Promise<{ payload: unknown } | undefined> {
  const { frame, journal, binding } = input
  if (await journal.isRetired(frame.intent.operationId) && frame.method !== 'status'
    && frame.method !== 'physical-readout') return undefined
  let state = await journal.status(frame.intent.operationId)
  let orphanedEntry = false
  if (state.status !== 'known') {
    const entry = input.recovery.readEntry(frame.intent.operationId)
    if (!entry) return undefined
    if (!isDeepStrictEqual(entry.intent, frame.intent) || entry.connection.mainId !== binding.mainId
      || entry.connection.deviceId !== binding.deviceId || entry.connection.workerInstallationId !== binding.workerInstallationId
      || entry.connection.keyRevision !== binding.keyRevision
      || entry.connection.authorizationRevision !== binding.authorizationRevision) {
      throw new Error('Original unentered workflow capture changed')
    }
    await input.authorize('read')
    input.assertCurrent()
    const receipt = await journal.accept(entry.intent, entry.connection, randomUUID())
    state = { status: 'known', receipt }
    orphanedEntry = true
  }
  const recorded = input.recovery.readEntry(frame.intent.operationId)
  const accountBinding = frame.placement.payload.kind === 'agent' ? frame.placement.payload.accountBinding : undefined
  const savedBinding = recorded?.accountBinding ?? input.recovery.read(state.receipt)?.accountBinding
  if (savedBinding && !isDeepStrictEqual(savedBinding, accountBinding)) {
    throw new Error('Original workflow account binding changed')
  }
  let receipt = state.receipt
  const renewed = frame.method === 'renew-owner'
    && isDeepStrictEqual({ ...receipt.intent, owner: frame.transition.nextOwner }, frame.intent)
  if ((!isDeepStrictEqual(receipt.intent, frame.intent) && !renewed) || frame.placement.bindingHash !== frame.intent.bindingHash
    || frame.placement.hostRef.kind !== 'device' || frame.placement.hostRef.deviceId !== binding.deviceId
    || frame.placement.mainId !== binding.mainId || receipt.connection.workerInstallationId !== binding.workerInstallationId
    || receipt.connection.keyRevision !== binding.keyRevision
    || receipt.connection.authorizationRevision !== binding.authorizationRevision) {
    throw new Error('Original workflow recovery ownership changed')
  }
  if (frame.method === 'renew-owner') {
    if (!isDeepStrictEqual(frame.transition.native, receipt.native)
      || frame.transition.operationId !== frame.intent.operationId
      || !isDeepStrictEqual(frame.transition.nextOwner, frame.intent.owner)) {
      throw new Error('Original workflow renewal ownership changed')
    }
    await input.authorize('control')
    input.assertCurrent()
    receipt = await journal.reconcileOwner(frame.transition)
  }
  if (frame.method === 'control-delivery' && (frame.command.operationId !== frame.intent.operationId
    || frame.command.executionId !== frame.intent.executionId || frame.command.attemptId !== frame.intent.attemptId
    || frame.command.bindingHash !== frame.intent.bindingHash
    || !isDeepStrictEqual(frame.command.owner, frame.intent.owner)
      && !receipt.controls.some(command => isDeepStrictEqual(command, frame.command)))) {
    throw new Error('Original workflow control delivery ownership changed')
  }
  let action: 'read' | 'stop' | 'control' = 'read'
  if (frame.method === 'control') action = frame.command.action.kind === 'stop' ? 'stop' : 'control'
  await input.authorize(action)
  input.assertCurrent()
  if (frame.method === 'history' && frame.metadata) {
    return { payload: input.recovery.historyPages.read(frame) }
  }
  if (!receipt.native) {
    if (!receipt.entryAttempted && receipt.terminal) {
      if (!hasPositiveRemoteNonEntryClosure(receipt)) throw new Error('Original preparation closure changed')
      if (frame.method === 'control') await journal.control(frame.command)
      return closedEntryReply(frame, journal)
    }
    if (!receipt.entryAttempted) {
      if (orphanedEntry || frame.method === 'control' && frame.command.action.kind === 'stop') {
        const owner = `execution:${frame.intent.executionId}`
        if (input.registry.snapshot().launches.some(launch => launch.owner === owner)
          && !await input.registry.closeOwner(owner, input.signal)) throw new Error('Original preparation owner closure is unconfirmed')
        if (frame.method === 'control') await journal.control(frame.command)
        else await journal.revokeFence(frame.intent.operationId)
        await journal.terminal(frame.intent.operationId, { kind: 'not_started',
          closureEvidenceDigest: remoteNonEntryClosureDigest(receipt.intent) })
        input.assertCurrent()
        return closedEntryReply(frame, journal)
      }
      if (frame.method === 'status') return { payload: state }
      return undefined
    }
    const capture = input.recovery.read(receipt)
    if (!capture) {
      if (frame.method === 'control') await journal.control(frame.command)
      await input.recovery.closePendingEntry(receipt, journal, input.signal)
      input.assertCurrent()
      return closedEntryReply(frame, journal)
    }
    receipt = await journal.acknowledgeStart(frame.intent.operationId, capture.native)
  }
  if (frame.method === 'control') await journal.control(frame.command)
  const recovered = await input.recovery.reconcile(receipt, journal, input.signal)
  input.assertCurrent()
  const status = await journal.status(frame.intent.operationId)
  if (status.status !== 'known') throw new Error('Original workflow recovery receipt is missing')
  if (frame.method === 'control-delivery') {
    return { payload: { phase: await journal.controlDelivery(frame.command) ?? 'unknown', status } }
  }
  const capture = recovered.capture
  const result = status.receipt.terminal?.result
  const output = result ? await input.recovery.readOutput(frame.intent.operationId) : undefined
  if (result && !output) throw new Error('Original workflow recovery output is missing')
  if (output && !isDeepStrictEqual(output.result, result)) throw new Error('Original workflow recovery result changed')
  const history: NativeHistory = { events: [], pendingInteractions: [],
    ...(status.receipt.native?.turnId ? { nativeTurnId: status.receipt.native.turnId } : {}),
    ...(status.receipt.turnInput ? { correlationId: status.receipt.turnInput.correlationId } : {}),
    ...(result && status.receipt.turnInput && status.receipt.native?.turnId ? {
      terminalResult: result, terminalTurn: { correlationId: status.receipt.turnInput.correlationId,
        providerId: status.receipt.native.turnId, result },
    } : {}) }
  // Both history replies retain the exact paged source that Main verifies by digest.
  const historyReply = frame.method === 'history' || frame.method === 'reconcile-response'
    ? startNativeHistoryDownload(history, { afterSequence: frame.method === 'history' ? frame.afterSequence : undefined,
      downloadId: frame.downloadId }) : undefined
  if (capture && frame.method !== 'physical-readout' && frame.method !== 'physical-ack') {
    let source: WorkflowOriginalNativeSource = { type: 'boundary' }
    if (historyReply) source = { type: 'history', history: nativeHistoryPageSource(historyReply)! }
    else if (frame.method === 'prepare' || frame.method === 'reattach') {
      source = { type: 'session_created', session: capture.session }
    }
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const readout = RemoteWorkflowPhysicalReadoutSchema.parse({ version: 1, expiresAt,
      launchIntent: capture.intent,
      receipt: status.receipt, session: capture.session, launch: recovered.original, observation: recovered.closed,
      runtimeLeaf: capture.runtimeLeaf, source: capture.source,
      ...(historyReply || result ? { history: historyReply ? nativeHistoryPageSource(historyReply) : history } : {}),
      closure: { ownerClosed: true, launch: recovered.closed },
      ...(result ? { output } : {}) })
    const assertOwnerCurrent = async () => {
      input.assertCurrent()
      await input.authorize('read')
      const current = await journal.status(frame.intent.operationId)
      if (current.status !== 'known' || !isDeepStrictEqual(current.receipt, status.receipt)) {
        throw new Error('Original workflow recovery receipt changed')
      }
      input.assertCurrent()
    }
    // A recovered process is already closed: its replies confirm closure, so they are cleanup replies.
    input.physical.remember({ readout, placement: frame.placement, source, leaseExpiresAt: expiresAt, cleanup: true,
      assertOwnerCurrent, assertCurrent: () => assertOriginalPhysicalDirectories({
        source: capture.source, runtimeLeaf: capture.runtimeLeaf, placement: frame.placement,
        approvedRoots: capture.approvedRoots, signal: input.lifetimeSignal,
        assertCurrent: input.assertCurrent, authorize: assertOwnerCurrent,
      }), observe: () => matchingOriginalRegistryLaunch(input.registry, recovered.original),
      closure: () => recovered.closed })
  }
  if (frame.method === 'physical-readout') {
    return { payload: pagePhysicalReadout(await input.physical.read(frame), frame.metadata) }
  }
  if (frame.method === 'physical-ack') {
    const readout = frame.retire ? await input.physical.read(frame, input.signal) : undefined
    const terminalSource = frame.sourceDigest === remoteWorkflowSourceDigest({ type: 'boundary' })
      || readout?.history && frame.sourceDigest === remoteWorkflowSourceDigest({
        type: 'history', history: remoteWorkflowNativeHistory(readout.history),
      })
    const ack = await input.physical.ack(frame)
    if (frame.retire && terminalSource && status.receipt.terminal && readout?.closure?.ownerClosed
      && ack.status === 'retired' && status.receipt.sequence === frame.receiptSequence) {
      await journal.retireSettled(frame.intent, frame.receiptSequence)
      input.physical.purge(frame.intent.operationId)
    }
    return { payload: ack }
  }
  if (historyReply) {
    return { payload: input.recovery.historyPages.remember({ ...historyReply, status }, frame.intent, frame.placement) }
  }
  if (frame.method === 'pending') return { payload: null }
  if (frame.method === 'prepare' || frame.method === 'reattach') {
    if (frame.request.executionId !== frame.intent.executionId || frame.request.runId !== frame.intent.runId
      || frame.request.workflowNodeId !== frame.intent.nodeId
      || commandInputHash(frame.request.input) !== frame.intent.inputDigest
      || frame.placement.payload.kind !== 'agent'
      || frame.request.configuration.id !== frame.placement.payload.agentConfigurationVersionId
      || frame.request.configuration.agentId !== frame.placement.payload.agentId
      || capture && (frame.request.workingDirectory !== capture.source.workingTree.canonicalCwd
        || frame.request.runtimeDirectory !== capture.runtimeLeaf.canonicalRuntimeDirectory
        || frame.request.configuration.harness.harness !== capture.session.harness
        || frame.method === 'reattach' && !isDeepStrictEqual(frame.session, capture.session))) {
      throw new Error('Original workflow recovery request changed')
    }
    return { payload: { ...(capture ? { session: capture.session } : {}), status } }
  }
  return { payload: status }
}

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { negotiateDeviceExtensions, type DeviceExtensionDescriptor } from '@foreman-code/contracts/device-application'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { DeviceApplicationChannel, extensionDescriptors } from '../../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../src/modules/devices/deviceWire.js'
import { deriveDispatch, freezePlacement } from '../../src/modules/placement/binding.js'
import { InstalledWorkflowResponsePages } from '../../src/modules/runs/remote/installedWorkflowResponsePages.js'
import { startNativeHistoryDownload } from '../../src/modules/runs/remote/nativeHistoryPage.js'
import type { RemoteCommitFacts, RemoteResultCommitPort } from '../../src/modules/runs/remote/resultBridge.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: string[] = []
  send(text: string) {
    this.frames.push(text)
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

export async function flushChannel() {
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

export function remoteStopChannel(options: { paged?: boolean; legacy?: boolean } = {}) {
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const binding = { ...connection, connectionEpoch: randomUUID() }
  const digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace',
    version: 1, prompt: { system: 'Observe the original session.' }, assignedSkills: [],
    harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: digest, createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId: connection.mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
    registration: { workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'installation', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent, connection,
    workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
    turnEntryAttempted: true, turnInput: { correlationId: 'execution:execution', promptDigest: digest },
    stopFence: false, controls: [], native: { sessionId: session.nativeSessionId, turnId: 'native-turn',
      processIdentityDigest: digest }, ...(options.paged ? { retainedReviewer: { agentId: 'agent',
      expiresAt: new Date(Date.now() + 600_000).toISOString(), workflowTurnId: 'native-turn',
      result: { outcome: 'succeeded', output: { text: 'retained result '.repeat(90_000) } } } } : {}) })
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const releases: Array<() => void> = []
  const requests: Array<ReturnType<typeof RemoteExecutionRpcRequestSchema.parse>> = []
  const pages = new InstalledWorkflowResponsePages()
  const handle = async (raw: unknown) => {
    if (raw === 'occupied') {
      await new Promise<void>(resolve => { releases.push(resolve) })
      return { payload: null }
    }
    if (options.legacy && raw && typeof raw === 'object' && 'forStop' in raw) {
      throw new Error('Older Worker rejects unknown RPC fields')
    }
    const frame = RemoteExecutionRpcRequestSchema.parse(raw)
    requests.push(frame)
    if (frame.method === 'receipt-continuation') return { payload: pages.read(frame, binding) }
    if (frame.method === 'control') {
      receipt.sequence++
      receipt.controls.push(frame.command)
      receipt.stopFence = true
      receipt.phase = 'confirmed_terminal'
      receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) }
      delete receipt.retainedReviewer
    }
    const status = { status: 'known', receipt: structuredClone(receipt) }
    let response: unknown = status
    if (frame.method === 'prepare' || frame.method === 'reattach') response = { session, status }
    if (frame.method === 'history') response = {
      ...startNativeHistoryDownload({ events: [], pendingInteractions: [] }, {}), status }
    return { payload: pages.page(response, frame, binding) }
  }
  const registration = { namespace: 'execution-v1', version: 1, role: 'duplex' as const,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576, handle }
  const descriptors = extensionDescriptors([registration])
  const peer: DeviceExtensionDescriptor[] = descriptors.map(value => {
    const { stopReadAdmission: _stopReads, ...ordinary } = value as typeof value & { stopReadAdmission?: true }
    void _stopReads
    return options.legacy ? ordinary : value
  })
  const extensions = negotiateDeviceExtensions(descriptors, peer)
  const parent = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: parent.signal,
    extensions, registrations: [registration] })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: parent.signal,
    extensions, registrations: [registration] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 2000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 1000)]
  for (const task of tasks) void task.catch(() => {
    // ignore: close joins both carrier tasks with allSettled.
  })
  const facts: RemoteCommitFacts = { intent, placement, originalConnection: connection,
    originalIncarnationId: receipt.workerIncarnationId, grantIsLive: true, lastSequence: 0,
    lastReceipt: null, native: null, terminal: null }
  const commit: RemoteResultCommitPort = { transaction: async (_id, work) => work({
    authority: async () => facts, reject: async () => { throw new Error('Original receipt rejected') },
    accept: async evidence => {
      facts.lastSequence = evidence.receipt.sequence
      facts.lastReceipt = evidence.receipt
      facts.native = evidence.receipt.native ?? null
      facts.terminal = evidence.receipt.terminal ?? null
    }, retain: async () => {} }) }
  const endpoint = { captureRequest: () => main.captureRequest('execution-v1'),
    currentBinding: () => binding, isRevoked: () => false }
  return { connection, binding, placement, intent, configuration, session, receipt, main, requests,
    endpoint, commit, facts, rawMain,
    async occupy() {
      const busy = Array.from({ length: 8 }, () => main.request('execution-v1', 'occupied'))
      await flushChannel()
      return { busy, releases }
    },
    async close() {
      for (const release of releases) release()
      parent.abort()
      main.close()
      worker.close()
      await Promise.allSettled(tasks)
    } }
}

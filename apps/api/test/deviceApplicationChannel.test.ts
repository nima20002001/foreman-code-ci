import { EventEmitter } from 'node:events'
import { DEVICE_BUFFER_BYTES } from '@foreman-code/contracts/device-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_APPLICATION_BUFFER_BYTES, DEVICE_APPLICATION_CHUNK_WINDOW, DEVICE_APPLICATION_JSON_BYTES,
  DEVICE_APPLICATION_BINARY_BYTES, DEVICE_APPLICATION_STOP_BYTES, negotiateDeviceExtensions,
} from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration } from '../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'
import { deriveDispatch, freezePlacement } from '../src/modules/placement/binding.js'
import { DomainError } from '../src/modules/errors.js'
import { agentFileReader } from '../src/modules/ci-host/agentFileReader.js'
import { AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE } from '@foreman-code/contracts/source-materialization'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { RemoteNativeSessionManager } from '../src/modules/runs/remote/nativeManagerProxy.js'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { startNativeHistoryDownload } from '../src/modules/runs/remote/nativeHistoryPage.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  frames: string[] = []
  latencyMs = 0
  send(text: string) {
    this.frames.push(text)
    const deliver = () => { if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false) }
    if (this.latencyMs) setTimeout(deliver, this.latencyMs)
    else queueMicrotask(deliver)
  }
  close() { if (this.closed) return; this.closed = true; this.emit('close'); this.peer?.close() }
}
const binding = {
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1,
  bootId: 'boot', connectionEpoch: 'epoch', connectionGeneration: 1,
}
function stopRequest() {
  const digest = 'a'.repeat(64)
  const placement = freezePlacement({
    schemaVersion: 1, mainId: binding.mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
    registration: { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: {
      canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest,
    },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: {
      kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [],
    },
  })
  const intent = deriveDispatch(placement, {
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' },
  })
  const command = {
    schemaVersion: 1 as const, protocolVersion: 1 as const, commandId: 'stop', operationId: intent.operationId,
    attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: intent.bindingHash, owner: intent.owner,
    native: { sessionId: 'native-session', turnId: 'native-turn', processIdentityDigest: digest },
    action: { kind: 'stop' as const },
  }
  return { method: 'control' as const, intent, placement, command }
}
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve() }
function setup(handler: NonNullable<DeviceExtensionRegistration['handle']>, limits = { maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576 }, heartbeatMs = 1000, mainHandler?: NonNullable<DeviceExtensionRegistration['handle']>, namespace = 'execution-v1') {
  const rawMain = new Socket(), rawWorker = new Socket(); rawMain.peer = rawWorker; rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain), workerSocket = adaptDeviceSocket(rawWorker)
  const mainRegistration: DeviceExtensionRegistration = { namespace, version: 1, role: mainHandler ? 'duplex' : 'client', ...limits, ...(mainHandler ? { handle: mainHandler } : {}) }
  const workerRegistration: DeviceExtensionRegistration = { ...mainRegistration, role: mainHandler ? 'duplex' : 'server', handle: handler }
  const extensions = negotiateDeviceExtensions(extensionDescriptors([mainRegistration]), extensionDescriptors([workerRegistration]))
  const parent = new AbortController(), revalidate = vi.fn(async () => {})
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket, signal: parent.signal, extensions, registrations: [mainRegistration], revalidate })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket, signal: parent.signal, extensions, registrations: [workerRegistration] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), heartbeatMs * 2), worker.run(workerSocket.messages[Symbol.asyncIterator](), heartbeatMs)]
  for (const task of tasks) void task.catch(() => {
    // ignore: close aborts these carrier tasks and joins their results with allSettled.
  })
  return { main, worker, rawMain, rawWorker, revalidate, close: async () => { parent.abort(); main.close(); worker.close(); await Promise.allSettled(tasks) } }
}
afterEach(() => vi.useRealTimers())
describe('authenticated namespace carrier mechanics', () => {
  it('admits the native Stop status refresh while ordinary requests occupy every slot', async () => {
    const stop = stopRequest()
    const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
    const receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent: stop.intent,
      connection: { mainId: binding.mainId, deviceId: binding.deviceId,
        workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
        authorizationRevision: binding.authorizationRevision, connectionGeneration: binding.connectionGeneration,
        bootId: '44444444-4444-4444-8444-444444444444' },
      workerIncarnationId: '55555555-5555-4555-8555-555555555555', sequence: 1, phase: 'running',
      native: stop.command.native, entryAttempted: true, turnEntryAttempted: true,
      turnInput: { correlationId: 'execution:execution', promptDigest: 'a'.repeat(64) },
      stopFence: false, controls: [],
    })
    const configuration: AgentConfigurationVersion = {
      id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
      prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex,
      contentHash: 'fixture', createdAt: '2026-10-01T00:00:00.000Z',
    }
    const releases: Array<() => void> = []
    const methods: string[] = []
    const pair = setup(async payload => {
      if (payload === 'occupied') {
        await new Promise<void>(resolve => { releases.push(resolve) })
        return { payload: null }
      }
      const frame = RemoteExecutionRpcRequestSchema.parse(payload)
      methods.push(frame.method)
      const status = { status: 'known', receipt: structuredClone(receipt) }
      if (frame.method === 'prepare') return { payload: { session, status } }
      if (frame.method === 'status') return { payload: status }
      if (frame.method === 'control') {
        receipt.sequence++
        receipt.stopFence = true
        receipt.phase = 'confirmed_terminal'
        receipt.controls.push(frame.command)
        receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'b'.repeat(64) }
        return { payload: { status: 'known', receipt: structuredClone(receipt) } }
      }
      if (frame.method === 'history') return { payload: {
        ...startNativeHistoryDownload({ events: [], pendingInteractions: [] }, {}), status,
      } }
      throw new Error('Unexpected remote request')
    })
    const proxy = new RemoteNativeSessionManager({ intent: stop.intent, placement: stop.placement,
      harness: 'codex', configuration, controlFor: async input => ({ ...stop.command, native: input.native }),
      observeReceipt: async () => {},
      transport: { request: async (_method, payload) => (await pair.main.request('execution-v1', payload)).payload },
    })
    const occupied: Array<Promise<unknown>> = []
    let cancellation: Promise<boolean> | undefined
    try {
      await proxy.createSession({ correlationId: 'execution:execution', request: {
        executionId: stop.intent.executionId, runId: stop.intent.runId, workflowNodeId: stop.intent.nodeId,
        workspaceId: 'workspace', workingDirectory: '/project', runtimeDirectory: '/runtime', configuration, input: {},
      } })
      occupied.push(...Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'occupied')))
      await flush()
      expect(releases).toHaveLength(8)
      cancellation = proxy.cancel(session)
      await flush()
      expect(methods).toContain('control')
      await expect(cancellation).resolves.toBe(true)
      expect(releases).toHaveLength(8)
      const opens = pair.rawMain.frames.map(frame => JSON.parse(frame))
        .filter(frame => frame.type === 'application-open' && frame.admission === 'stop')
      expect(opens).toHaveLength(2)
    } finally {
      for (const release of releases) release()
      await pair.close()
      await Promise.allSettled([...occupied, ...(cancellation ? [cancellation] : [])])
    }
  })

  it('dispatches conversation cancellation through reserved stop capacity on a saturated link', async () => {
    const releases: Array<() => void> = []
    const handled = vi.fn(async (payload: unknown) => {
      if (payload === 'occupied') await new Promise<void>(resolve => { releases.push(resolve) })
      return { payload }
    })
    const pair = setup(handled)
    const occupied = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'occupied'))
    const f = workerConversationFixture()
    const target = { ...f.binding, profile: { ...f.binding.profile, target: { ...f.binding.profile.target,
      hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId } } }
    let cancellation: Promise<unknown> | undefined
    try {
      await flush()
      expect(releases).toHaveLength(8)
      const request = { method: 'conversation.cancel', binding: target, session: f.session, nativeTurnId: 'active-turn' }
      cancellation = pair.main.request('execution-v1', request)
      await flush()
      expect(handled.mock.calls.map(([payload]) => payload)).toContainEqual(request)
      await expect(cancellation).resolves.toEqual({ payload: request })
      expect(pair.rawMain.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === 'application-open'
        && frame.admission === 'stop')).toHaveLength(1)
    } finally {
      for (const release of releases) release()
      await pair.close()
      await Promise.allSettled([...occupied, ...(cancellation ? [cancellation] : [])])
    }
  })
  it('distinguishes an evicted physical reply from an unavailable native process across the channel', async () => {
    const pair = setup(async () => {
      throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical reply is no longer retained.',
        409, { reason: 'not_retained' })
    })
    try {
      await expect(pair.main.request('execution-v1', { method: 'physical-readout' })).rejects.toMatchObject({
        code: 'REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', class: 'transient', retryable: true,
      })
      expect(pair.rawMain.closed).toBe(false)
    } finally { await pair.close() }
  })

  it('queues foreground work behind occupied slots while Stop remains available', async () => {
    const releases: Array<() => void> = []
    const handled = vi.fn(async (payload: unknown) => {
      if (payload === 'occupied') await new Promise<void>(resolve => { releases.push(resolve) })
      return { payload }
    })
    const pair = setup(handled)
    const occupied = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'occupied'))
    const queued = pair.main.request('execution-v1', 'queued')
    try {
      await flush()
      expect(releases).toHaveLength(8)
      expect(handled).toHaveBeenCalledTimes(8)
      const stop = stopRequest()
      await expect(pair.main.request('execution-v1', stop)).resolves.toEqual({ payload: stop })
      expect(handled).toHaveBeenCalledTimes(9)
      releases[0]!()
      await expect(queued).resolves.toEqual({ payload: 'queued' })
      expect(handled.mock.calls.filter(([payload]) => payload === 'queued')).toHaveLength(1)
      expect(pair.rawMain.closed).toBe(false)
    } finally {
      for (const release of releases) release()
      await pair.close()
      await Promise.allSettled([...occupied, queued])
    }
  })

  it('waits for transient socket backpressure without entering the handler twice', async () => {
    vi.useFakeTimers()
    const handled = vi.fn(async () => ({ payload: 'started' }))
    const pair = setup(handled)
    pair.rawMain.bufferedAmount = DEVICE_BUFFER_BYTES
    try {
      const response = pair.main.request('execution-v1', { operationId: 'start' }, { timeoutMs: 120_000 })
      const checked = expect(response).resolves.toEqual({ payload: 'started' })
      void checked.catch(() => {
        // ignore: the original assertion is awaited after the socket drains.
      })
      await vi.advanceTimersByTimeAsync(250)
      expect(handled).not.toHaveBeenCalled()
      pair.rawMain.bufferedAmount = 0
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(2_000)])
      await checked
      expect(handled).toHaveBeenCalledOnce()
    } finally { await pair.close() }
  })

  it('honors the longer request budget when a chunk receipt takes more than ten seconds', async () => {
    vi.useFakeTimers()
    const handled = vi.fn(async () => ({ payload: 'started' }))
    const pair = setup(handled)
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    pair.rawWorker.send = text => {
      if (JSON.parse(text).type === 'application-ack') setTimeout(() => send(text), 12_000)
      else send(text)
    }
    try {
      const response = pair.main.request('execution-v1', { operationId: 'start' }, { timeoutMs: 120_000 })
      const checked = expect(response).resolves.toEqual({ payload: 'started' })
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(25_000)])
      await checked
      expect(handled).toHaveBeenCalledOnce()
      expect(pair.rawMain.closed).toBe(false)
    } finally { await pair.close(); await vi.runOnlyPendingTimersAsync() }
  })

  it('transfers multi-megabyte agent snapshots without enlarging other namespace limits', async () => {
    const maxJsonBytes = Math.ceil(32 * 1024 * 1024 / 3) * 4 + 1024
    const limits = { maxJsonBytes, maxBinaryBytes: 0 }
    expect(() => extensionDescriptors([{ namespace: 'execution-v1', version: 1, role: 'client', ...limits }]))
      .toThrow('Invalid device extension')
    const payload = { commit: 'a'.repeat(40), bundleBase64: Buffer.alloc(8 * 1024 * 1024).toString('base64') }
    const pair = setup(async () => ({ payload }), limits, 1000, undefined, 'agent-snapshot-v1')
    try {
      const response = await pair.main.request('agent-snapshot-v1', { path: '/project/tree', baseCommit: 'b'.repeat(40) })
      expect(response.payload).toEqual(payload)
      expect(pair.rawWorker.frames.every(frame => Buffer.byteLength(frame) <= 16_384)).toBe(true)
    } finally { await pair.close() }
  })
  it('requires actual server handler and exact role/version-compatible negotiation', () => {
    expect(() => extensionDescriptors([{ namespace: 'execution-v1', version: 1, role: 'server', maxJsonBytes: 1024, maxBinaryBytes: 0 }])).toThrow('actual domain handler')
    const client = { namespace: 'execution-v1', version: 1, role: 'client' as const, maxJsonBytes: 1024, maxBinaryBytes: 0 }
    expect(negotiateDeviceExtensions([client], [{ ...client, role: 'server', version: 2 }])).toEqual([])
    expect(negotiateDeviceExtensions([client], [client])).toEqual([])
    expect(negotiateDeviceExtensions([client], [{ ...client, role: 'server' }])).toEqual([{ namespace: 'execution-v1', version: 1, mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 1024, maxBinaryBytes: 0 }])
  })
  it('correlates bounded chunked JSON plus full 1MiB binary with actual handler receipt', async () => {
    const bytes = Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 256), observed = vi.fn()
    const pair = setup(async (payload, context) => { observed(context); return { payload, ...(context.bytes ? { bytes: context.bytes } : {}) } })
    try {
      const response = await pair.main.request('execution-v1', { text: 'payload'.repeat(20_000) }, { bytes })
      expect(response.payload).toEqual({ text: 'payload'.repeat(20_000) }); expect(Buffer.from(response.bytes!).equals(Buffer.from(bytes))).toBe(true)
      expect(observed.mock.calls[0]![0].binding).toEqual(binding); expect(Object.isFrozen(observed.mock.calls[0]![0].binding)).toBe(true)
      expect(pair.rawMain.frames.every((frame) => Buffer.byteLength(frame) <= 16_384)).toBe(true)
      expect(pair.revalidate).toHaveBeenCalled()
    } finally { await pair.close() }
  })
  it('keeps the connection lifetime alive after a short request and aborts it on disconnect', async () => {
    let requestSignal: AbortSignal | undefined
    let connectionSignal: AbortSignal | undefined
    const pair = setup(async (_payload, context) => {
      requestSignal = context.signal
      connectionSignal = context.connectionSignal
      return { payload: { initiated: true } }
    })
    try {
      expect((await pair.main.request('execution-v1', { start: true })).payload).toEqual({ initiated: true })
      await flush()
      expect(requestSignal?.aborted).toBe(true)
      expect(connectionSignal?.aborted).toBe(false)
      await pair.close()
      expect(connectionSignal?.aborted).toBe(true)
    } finally { await pair.close() }
  })
  it('chunk ACK is not execution acceptance or completion', async () => {
    let release!: () => void; const entered = vi.fn()
    const pair = setup(async () => { entered(); await new Promise<void>((resolve) => { release = resolve }); return { payload: { accepted: true } } })
    try {
      let settled = false; const result = pair.main.request('execution-v1', { dispatch: true }).then((value) => { settled = true; return value })
      await flush(); expect(entered).toHaveBeenCalled(); expect(settled).toBe(false)
      release(); expect((await result).payload).toEqual({ accepted: true })
    } finally { await pair.close() }
  })
  it('transfers a bounded window at 50ms round-trip latency without resending packet bytes', async () => {
    vi.useFakeTimers()
    const bytes = new Uint8Array(262_144)
    const received = vi.fn()
    const pair = setup(async (_payload, context) => {
      received(context.bytes)
      return { payload: 'received' }
    })
    pair.rawMain.latencyMs = 25
    pair.rawWorker.latencyMs = 25
    try {
      let settled = false
      const startedAt = Date.now()
      const response = pair.main.request('execution-v1', {}, { bytes }).then(value => {
        settled = true
        return value
      })
      await flush()
      await vi.advanceTimersByTimeAsync(75)
      const chunks = pair.rawMain.frames.map(frame => JSON.parse(frame) as { type: string })
        .filter(frame => frame.type === 'application-chunk')
      expect(chunks).toHaveLength(DEVICE_APPLICATION_CHUNK_WINDOW)
      expect(received).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(725)
      expect(settled).toBe(true)
      expect(await response).toEqual({ payload: 'received' })
      expect(Date.now() - startedAt).toBeLessThan(1000)
      expect(Buffer.from(received.mock.calls[0]![0]).equals(Buffer.from(bytes))).toBe(true)
      const sentBytes = pair.rawMain.frames.map(frame => JSON.parse(frame) as { type: string; data?: string })
        .filter(frame => frame.type === 'application-chunk')
        .reduce((total, frame) => total + Buffer.from(frame.data!, 'base64').byteLength, 0)
      expect(sentBytes).toBe(bytes.byteLength + Buffer.byteLength('{}'))
      expect(pair.rawMain.frames.reduce((total, frame) => total + Buffer.byteLength(frame), 0)).toBeLessThan(370_000)
    } finally { await pair.close(); await vi.runOnlyPendingTimersAsync() }
  })
  it('bounds unacknowledged chunks across simultaneous uploads', async () => {
    const pair = setup(async payload => ({ payload }))
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    pair.rawWorker.send = text => {
      const frame = JSON.parse(text) as { type: string; offset?: number }
      if (frame.type !== 'application-ack' || frame.offset === 0) send(text)
    }
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'x'.repeat(65_536)))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    try {
      await flush()
      const chunks = pair.rawMain.frames.filter(frame => JSON.parse(frame).type === 'application-chunk')
      expect(chunks).toHaveLength(DEVICE_APPLICATION_CHUNK_WINDOW)
      expect(chunks.reduce((total, frame) => total + Buffer.byteLength(frame), 0)).toBeLessThan(65_536)
    } finally { await pair.close(); await Promise.allSettled(requests) }
  })
  it('domain handler denies insufficient scoped grants without acquiring authority', async () => {
    const launched = vi.fn()
    const pair = setup(async (payload) => { if ((payload as { grant?: string }).grant !== 'exact-operation') throw { code: 'forbidden' }; launched(); return { payload: 'receipt' } })
    try {
      await expect(pair.main.request('execution-v1', { grant: 'device-heartbeat-only' })).rejects.toThrow('forbidden')
      expect(launched).not.toHaveBeenCalled()
      await expect(pair.main.request('execution-v1', { grant: 'exact-operation' })).resolves.toEqual({ payload: 'receipt' })
      expect(launched).toHaveBeenCalledOnce()
    } finally { await pair.close() }
  })
  it.each([
    ['PLACEMENT_BINDING_CONFLICT', false],
    ['REMOTE_AUTHORITY_DENIED', false],
    ['AUTH_REVOKED', false],
    ['AUTH_RUN_ENDED', false],
    ['REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', true],
    ['REMOTE_NATIVE_PHYSICAL_REPLY_EXPIRED', true],
    ['REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', true],
    ['NATIVE_ARTIFACT_CONTEXT_PENDING', true],
    ['NATIVE_ARTIFACT_AUTHORITY_DENIED', false],
    ['WORKER_WORKFLOW_UNAVAILABLE', true],
    ['WORKER_RUNTIME_DRAINING', true],
    ['backpressure', true],
    ['job-publication-pending', true],
    ['source-repository-uncertain', false],
    ['source-reconciliation-unconfirmed', true],
    ['SOURCE_RECLAMATION_UNCONFIRMED', false],
    ['SOURCE_EXECUTION_UNCERTAIN', true],
    ['SOURCE_PREPARATION_ACTIVE', true],
    ['SOURCE_PREPARATION_RECONCILED', false],
    ['SOURCE_QUOTA_MISSING', false],
    ['SOURCE_ROOT_CHANGED', false],
    ['SOURCE_CLAIM_INVALID', false],
    ['SOURCE_CLAIM_CONFLICT', false],
  ] as const)('preserves supported %s and safe retryability from worker to Main', async (code, retryable) => {
    const secret = 'private-token-and-process-path'
    const pair = setup(async () => {
      throw new DomainError(code, secret, 409, { reason: secret, token: secret, retryable: !retryable })
    })
    try {
      await expect(pair.main.request('execution-v1', {})).rejects.toMatchObject({ code, retryable })
      const chunks = pair.rawWorker.frames.map(frame => JSON.parse(frame) as { type: string; data?: string })
        .filter(frame => frame.type === 'application-chunk')
      const reply = JSON.parse(Buffer.concat(chunks.map(frame => Buffer.from(frame.data!, 'base64'))).toString())
      expect(reply).toEqual({ code, class: retryable ? 'transient' : 'permanent', retryable })
      expect(JSON.stringify(reply)).not.toContain(secret)
      expect(pair.rawMain.closed).toBe(false)
    } finally { await pair.close() }
  })
  it('returns Main cleanup authorization failures to the Worker without exposing private details', async () => {
    const pair = setup(async () => ({ payload: {} }),
      { maxJsonBytes: 1_048_576, maxBinaryBytes: 1_048_576 }, 1000, async () => {
        throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'private reservation and filesystem details', 403)
      })
    try {
      await expect(pair.worker.request('execution-v1', { operation: 'sources.reclamation-authorize' }))
        .rejects.toMatchObject({ code: 'SOURCE_RECLAMATION_UNCONFIRMED', retryable: false })
      const chunks = pair.rawMain.frames.map(frame => JSON.parse(frame) as { type: string; data?: string })
        .filter(frame => frame.type === 'application-chunk')
      const reply = JSON.parse(Buffer.concat(chunks.map(frame => Buffer.from(frame.data!, 'base64'))).toString())
      expect(reply).toEqual({ code: 'SOURCE_RECLAMATION_UNCONFIRMED', class: 'permanent', retryable: false })
    } finally { await pair.close() }
  })
  it.each([
    { error: { code: 'private_secret_token', message: 'secret', retryable: true },
      reply: { code: 'unavailable', class: 'transient', retryable: true } },
    { error: { code: 'UNKNOWN_PROVIDER_FAILURE', details: { token: 'secret' } },
      reply: { code: 'extension-rejected', class: 'permanent', retryable: false } },
    { error: new Error('secret'), reply: { code: 'extension-rejected', class: 'permanent', retryable: false } },
  ])('redacts unsupported exception codes and contents but keeps their class %#', async ({ error, reply: expected }) => {
    const pair = setup(async () => { throw error })
    try {
      await expect(pair.main.request('execution-v1', {})).rejects.toMatchObject(expected)
      const chunks = pair.rawWorker.frames.map(frame => JSON.parse(frame) as { type: string; data?: string })
        .filter(frame => frame.type === 'application-chunk')
      const reply = JSON.parse(Buffer.concat(chunks.map(frame => Buffer.from(frame.data!, 'base64'))).toString())
      expect(reply).toEqual(expected)
    } finally { await pair.close() }
  })
  it('validates received error codes instead of trusting arbitrary worker error payloads', async () => {
    const pair = setup(async () => { throw { code: 'forbidden' } })
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    pair.rawWorker.send = text => {
      const frame = JSON.parse(text) as { type: string; data?: string }
      if (frame.type === 'application-chunk') {
        const payload = Buffer.from(frame.data!, 'base64').toString().replace('forbidden', 'sensitive')
        frame.data = Buffer.from(payload).toString('base64')
      }
      send(JSON.stringify(frame))
    }
    try {
      await expect(pair.main.request('execution-v1', {})).rejects.toMatchObject({
        code: 'extension-rejected', retryable: false,
      })
      expect(pair.rawMain.closed).toBe(false)
    } finally { await pair.close() }
  })
  it('cancellation fences a late noncooperative handler response and releases its slot', async () => {
    let finish!: (value: { payload: unknown }) => void; let handlerSignal!: AbortSignal
    const pair = setup(async (payload, context) => { if (payload === 'slow') { handlerSignal = context.signal; return new Promise((resolve) => { finish = resolve }) }; return { payload } })
    try {
      const abort = new AbortController()
      const result = pair.main.request('execution-v1', 'slow', { signal: abort.signal })
      void result.catch(() => {
        // ignore: attach before cancellation; the original rejection is asserted below.
      })
      await flush(); abort.abort(); await expect(result).rejects.toThrow('cancelled'); await flush(); expect(handlerSignal.aborted).toBe(true)
      finish({ payload: 'stale' }); await flush()
      expect(await pair.main.request('execution-v1', 'fresh')).toEqual({ payload: 'fresh' })
    } finally { await pair.close() }
  })
  it('joins the raw domain promise after cancellation has settled its transport wrapper', async () => {
    let finish!: (result: { payload: unknown }) => void
    const pair = setup(async () => new Promise((resolve) => { finish = resolve }))
    const pending = pair.main.request('execution-v1', {})
    void pending.catch(() => {
      // ignore: attach before channel cancellation; the original rejection is asserted below.
    })
    await flush()
    await pair.close()
    await expect(pending).rejects.toThrow()
    let joined = false; const drain = pair.worker.join().then(() => { joined = true }); await flush(); expect(joined).toBe(false)
    finish({ payload: 'late-and-fenced' }); await drain; expect(joined).toBe(true); await pair.main.join()
  })
  it('connection revocation rejects pending requests and fences handler generations', async () => {
    let handlerSignal!: AbortSignal
    const pair = setup(async (_payload, context) => { handlerSignal = context.signal; return new Promise(() => {}) })
    const result = pair.main.request('execution-v1', 'pending')
    void result.catch(() => {
      // ignore: attach before channel cancellation; the original rejection is asserted below.
    })
    await flush(); await pair.close(); await expect(result).rejects.toThrow(); expect(handlerSignal.aborted).toBe(true)
    await expect(pair.main.request('execution-v1', 'stale')).rejects.toThrow()
  })
  it('rejects oversized request and reply explicitly without truncation or losing heartbeat', async () => {
    const handler = vi.fn(async (payload: unknown) => ({ payload: payload === 'large-reply' ? 'x'.repeat(2000) : payload }))
    const pair = setup(handler, { maxJsonBytes: 1024, maxBinaryBytes: 0 })
    try {
      await expect(pair.main.request('execution-v1', 'x'.repeat(2000))).rejects.toThrow('payload-too-large'); expect(handler).not.toHaveBeenCalled()
      await expect(pair.main.request('execution-v1', 'large-reply')).rejects.toThrow('payload-too-large')
      expect(await pair.main.request('execution-v1', 'small')).toEqual({ payload: 'small' })
      await expect(pair.main.request('unknown-v1', {})).rejects.toThrow('unavailable')
      await expect(pair.worker.request('execution-v1', {})).rejects.toThrow('unavailable')
    } finally { await pair.close() }
  })
  it('keeps heartbeat/control progress independent from a blocked domain handler', async () => {
    vi.useFakeTimers(); let release!: () => void
    const pair = setup(async () => { await new Promise<void>((resolve) => { release = resolve }); return { payload: null } }, undefined, 100)
    try {
      const result = pair.main.request('execution-v1', 'pending'); await flush()
      await vi.advanceTimersByTimeAsync(450)
      expect(pair.rawMain.frames.filter((frame) => JSON.parse(frame).type === 'pong').length).toBeGreaterThan(3)
      release(); expect(await result).toEqual({ payload: null })
    } finally { await pair.close(); expect(vi.getTimerCount()).toBe(0) }
  })
  it('times out a slow chunk reader without mistaking queued bytes for handler admission', async () => {
    vi.useFakeTimers(); const handler = vi.fn(async () => ({ payload: 'receipt' })), pair = setup(handler)
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    pair.rawWorker.send = (text) => { if (JSON.parse(text).type !== 'application-ack') send(text) }
    try {
      const pending = pair.main.request('execution-v1', { dispatch: true }, { timeoutMs: 10_000 })
      void pending.catch(() => {
        // ignore: attach before advancing timers; the original timeout rejection is asserted below.
      })
      await flush(); await vi.advanceTimersByTimeAsync(10_001); await expect(pending).rejects.toThrow('timeout')
      expect(handler).not.toHaveBeenCalled(); await flush(); pair.rawWorker.send = send
      expect(await pair.main.request('execution-v1', { dispatch: true })).toEqual({ payload: 'receipt' })
    } finally { await pair.close(); expect(vi.getTimerCount()).toBe(0) }
  })
  it('bounds background admission even across awaited live authorization', async () => {
    const pair = setup(async () => new Promise(() => {}))
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', {}))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    await flush()
    await expect(pair.main.request('execution-v1', {}, { priority: 'background' })).rejects.toThrow('backpressure')
    await pair.close()
    await Promise.allSettled(requests)
  })
  it('delivers exact-owner Stop with all ordinary outgoing slots occupied', async () => {
    const releases: Array<() => void> = []
    const stopped = vi.fn()
    const pair = setup(async payload => {
      if (payload === 'slow') {
        await new Promise<void>(resolve => { releases.push(resolve) })
        return { payload: 'released' }
      }
      stopped(payload)
      return { payload: 'stopped' }
    })
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'slow'))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    try {
      await flush()
      expect(releases).toHaveLength(8)
      await expect(pair.main.request('execution-v1', 'ordinary', { priority: 'background' })).rejects.toThrow('backpressure')
      const stop = stopRequest()
      await expect(pair.main.request('execution-v1', stop)).resolves.toEqual({ payload: 'stopped' })
      expect(stopped).toHaveBeenCalledExactlyOnceWith(stop)
      expect(pair.rawMain.closed).toBe(false)
      for (const release of releases) release()
      await Promise.all(requests)
    } finally { for (const release of releases) release(); await pair.close(); await Promise.allSettled(requests) }
  })
  it('times out noncooperative handlers then delivers Stop without closing the channel or admitting more work', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const releases: Array<() => void> = []
    const entered = vi.fn()
    const pair = setup(async (payload, context) => {
      entered(payload)
      if (payload !== 'slow') return { payload: 'stopped' }
      signals.push(context.signal)
      await new Promise<void>(resolve => { releases.push(resolve) })
      return { payload: 'late' }
    })
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'slow', { timeoutMs: 20 }))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    try {
      await flush()
      expect(signals).toHaveLength(8)
      const abandonedIds = new Set(pair.rawMain.frames.map(frame => JSON.parse(frame) as { type: string; id?: string })
        .filter(frame => frame.type === 'application-open').map(frame => frame.id))
      await vi.advanceTimersByTimeAsync(21)
      for (const request of requests) await expect(request).rejects.toThrow('timeout')
      expect(signals.every(signal => signal.aborted)).toBe(true)
      await expect(pair.main.request('execution-v1', 'ordinary', { priority: 'background' })).rejects.toThrow('backpressure')
      await expect(pair.main.request('execution-v1', stopRequest())).resolves.toEqual({ payload: 'stopped' })
      expect(entered).toHaveBeenCalledTimes(9)
      expect(pair.rawMain.closed).toBe(false)
      for (const release of releases) release()
      await flush()
      await expect(pair.main.request('execution-v1', 'fresh')).resolves.toEqual({ payload: 'stopped' })
      const lateReplies = pair.rawWorker.frames.map(frame => JSON.parse(frame) as { type: string; id?: string })
        .filter(frame => frame.type === 'application-open' && abandonedIds.has(frame.id))
      expect(lateReplies).toHaveLength(0)
    } finally { for (const release of releases) release(); await pair.close(); expect(vi.getTimerCount()).toBe(0) }
  })
  it('keeps Stop admission bounded and applies the domain grant and native-owner checks', async () => {
    let release!: () => void
    const delivered = vi.fn()
    const pair = setup(async payload => {
      const frame = payload as ReturnType<typeof stopRequest>
      if (frame.command.owner.grantId !== 'grant' || frame.command.native.sessionId !== 'native-session') {
        throw { code: 'forbidden' }
      }
      delivered()
      await new Promise<void>(resolve => { release = resolve })
      return { payload: 'stopped' }
    })
    try {
      const stop = stopRequest()
      const denied = { ...stop, intent: { ...stop.intent, owner: { grantId: 'revoked', epoch: '1' } },
        command: { ...stop.command, owner: { grantId: 'revoked', epoch: '1' } } }
      await expect(pair.main.request('execution-v1', denied)).rejects.toThrow('forbidden')
      await flush()
      await expect(pair.main.request('execution-v1', { ...stop,
        command: { ...stop.command, native: { ...stop.command.native, sessionId: 'foreign-session' } } })).rejects.toThrow('forbidden')
      await flush()
      expect(delivered).not.toHaveBeenCalled()
      const pending = pair.main.request('execution-v1', stop)
      await flush()
      await expect(pair.main.request('execution-v1', stop)).rejects.toThrow('backpressure')
      expect(delivered).toHaveBeenCalledOnce()
      release()
      await expect(pending).resolves.toEqual({ payload: 'stopped' })
    } finally { release?.(); await pair.close() }
  })
  it('refuses to reserve Stop capacity for a mismatched command owner', async () => {
    const pair = setup(async () => new Promise(() => {}))
    const requests = Array.from({ length: 8 }, () => pair.main.request('execution-v1', {}))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    try {
      await flush()
      const stop = stopRequest()
      await expect(pair.main.request('execution-v1', { ...stop,
        command: { ...stop.command, owner: { ...stop.command.owner, epoch: '2' } },
      }, { priority: 'background' })).rejects.toThrow('backpressure')
    } finally { await pair.close(); await Promise.allSettled(requests) }
  })
  it('delivers Stop with every declared output key at its admitted size while ordinary requests are full', async () => {
    const base = stopRequest()
    if (base.placement.payload.kind !== 'agent') throw new Error('Expected Agent placement')
    const placement = freezePlacement({ ...base.placement, payload: { ...base.placement.payload, artifactOutputs: {
      version: 1, outputKeys: Array.from({ length: 64 }, (_, index) => `${index}:`.padEnd(500, 'x')),
    } } })
    const stop = { ...base, placement, intent: { ...base.intent, bindingHash: placement.bindingHash },
      command: { ...base.command, bindingHash: placement.bindingHash } }
    expect(Buffer.byteLength(JSON.stringify(stop))).toBeGreaterThan(16_384)
    const pair = setup(async payload => {
      if (typeof payload === 'string') return new Promise(() => {})
      expect(payload).toEqual(stop)
      return { payload: 'stopped' }
    })
    const ordinary = Array.from({ length: 8 }, () => pair.main.request('execution-v1', 'occupied'))
    for (const request of ordinary) void request.catch(() => {
      // ignore: these occupied requests are canceled and joined in the finally block.
    })
    try {
      await flush()
      await expect(pair.main.request('execution-v1', stop)).resolves.toEqual({ payload: 'stopped' })
    } finally {
      await pair.close()
      await Promise.allSettled(ordinary)
    }
  })
  it('revalidates the Stop envelope before invoking a handler for a claimed reserved slot', async () => {
    const handler = vi.fn(async () => ({ payload: null }))
    const pair = setup(handler)
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const stop = stopRequest()
    const bytes = Buffer.from(JSON.stringify({ ...stop,
      command: { ...stop.command, executionId: 'foreign-execution' } }))
    try {
      pair.rawMain.send(JSON.stringify({ type: 'application-open', id, namespace: 'execution-v1',
        version: 1, kind: 'request', jsonBytes: bytes.byteLength, binaryBytes: 0, admission: 'stop' }))
      await flush()
      pair.rawMain.send(JSON.stringify({ type: 'application-chunk', id, offset: 0, data: bytes.toString('base64') }))
      await flush()
      expect(handler).not.toHaveBeenCalled()
      expect(pair.rawMain.closed).toBe(false)
      await expect(pair.main.request('execution-v1', stop)).resolves.toEqual({ payload: null })
      expect(handler).toHaveBeenCalledOnce()
    } finally { await pair.close() }
  })
  it('delivers Stop while the ordinary chunk window is waiting for receipts', async () => {
    const pair = setup(async payload => ({ payload: typeof payload === 'object' ? 'stopped' : 'uploaded' }))
    const send = pair.rawWorker.send.bind(pair.rawWorker)
    const ordinaryIds = new Set<string>()
    const sendMain = pair.rawMain.send.bind(pair.rawMain)
    pair.rawMain.send = text => {
      const frame = JSON.parse(text) as { type: string; id: string; admission?: string }
      if (frame.type === 'application-open' && frame.admission !== 'stop') ordinaryIds.add(frame.id)
      sendMain(text)
    }
    pair.rawWorker.send = text => {
      const frame = JSON.parse(text) as { type: string; id: string; offset?: number }
      if (frame.type !== 'application-ack' || frame.offset === 0 || !ordinaryIds.has(frame.id)) send(text)
    }
    const upload = pair.main.request('execution-v1', 'x'.repeat(65_536))
    void upload.catch(() => {
      // ignore: this blocked upload is canceled and joined in the finally block.
    })
    try {
      await flush()
      await expect(pair.main.request('execution-v1', stopRequest())).resolves.toEqual({ payload: 'stopped' })
      expect(pair.rawMain.closed).toBe(false)
    } finally { await pair.close(); await Promise.allSettled([upload]) }
  })
  it.each(['main', 'worker'] as const)('delivers duplex replies on %s with all inbound request slots occupied', async (side) => {
    const entered = vi.fn(), releases: Array<() => void> = []
    const slow: NonNullable<DeviceExtensionRegistration['handle']> = async () => {
      entered(); await new Promise<void>((resolve) => { releases.push(resolve) }); return { payload: 'released' }
    }
    const fast: NonNullable<DeviceExtensionRegistration['handle']> = async (payload) => {
      if (payload === 'deny') throw { code: 'forbidden' }
      return { payload: 'reply' }
    }
    const pair = setup(side === 'worker' ? slow : fast, undefined, 1000, side === 'main' ? slow : fast)
    const occupied = side === 'main' ? pair.main : pair.worker, caller = side === 'main' ? pair.worker : pair.main
    const requests = Array.from({ length: 8 }, () => caller.request('execution-v1', {}))
    for (const request of requests) void request.catch(() => {
      // ignore: the original requests are awaited below or joined after channel cancellation.
    })
    try {
      await flush(); expect(entered).toHaveBeenCalledTimes(8)
      await expect(caller.request('execution-v1', {}, { priority: 'background' })).rejects.toThrow('backpressure')
      await expect(occupied.request('execution-v1', {})).resolves.toEqual({ payload: 'reply' })
      await expect(occupied.request('execution-v1', 'deny')).rejects.toThrow('forbidden')
      expect(pair.rawMain.closed).toBe(false); expect(pair.rawWorker.closed).toBe(false)
      for (const release of releases) release()
      expect(await Promise.all(requests)).toEqual(Array.from({ length: 8 }, () => ({ payload: 'released' })))
    } finally { await pair.close(); await Promise.allSettled(requests) }
  })
  it.each(['main', 'worker'] as const)(
    'queues duplex replies on saturated %s without losing heartbeat, Stop, or reusable capacity',
    async side => {
      vi.useFakeTimers()
      const handled = vi.fn(async (payload: unknown) => {
        if (payload === 'deny') throw new DomainError('forbidden', 'Denied', 403)
        if (payload === 'large-reply') return { payload: 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES + 1) }
        if (typeof payload === 'object') return { payload: 'stopped' }
        return { payload: 'reply' }
      })
      const pair = setup(handled, undefined, 100, handled)
      const uploader = side === 'main' ? pair.main : pair.worker
      const caller = side === 'main' ? pair.worker : pair.main
      const rawUploader = side === 'main' ? pair.rawMain : pair.rawWorker
      const rawReceiver = side === 'main' ? pair.rawWorker : pair.rawMain
      const uploadIds = new Set<string>()
      const sendUpload = rawUploader.send.bind(rawUploader)
      const sendReceipt = rawReceiver.send.bind(rawReceiver)
      rawUploader.send = text => {
        const frame = JSON.parse(text) as { type: string; id: string; kind?: string; jsonBytes?: number }
        if (frame.type === 'application-open' && frame.kind === 'request'
          && frame.jsonBytes === DEVICE_APPLICATION_JSON_BYTES) uploadIds.add(frame.id)
        sendUpload(text)
      }
      rawReceiver.send = text => {
        const frame = JSON.parse(text) as { type: string; id: string }
        if (frame.type !== 'application-ack' || !uploadIds.has(frame.id)) sendReceipt(text)
      }
      const abort = new AbortController()
      const payload = 'x'.repeat(DEVICE_APPLICATION_JSON_BYTES - 2)
      const uploads = [
        uploader.request('execution-v1', payload, {
          signal: abort.signal, bytes: new Uint8Array(DEVICE_APPLICATION_BINARY_BYTES),
        }),
        uploader.request('execution-v1', payload, { signal: abort.signal }),
      ]
      for (const upload of uploads) void upload.catch(() => {
        // ignore: attach before aborting; the original upload rejections are asserted below.
      })
      try {
        await flush()
        expect(uploadIds.size).toBe(2)
        const opens = rawUploader.frames.map(text => JSON.parse(text) as {
          type: string; id: string; jsonBytes: number; binaryBytes: number
        }).filter(frame => frame.type === 'application-open' && uploadIds.has(frame.id))
        expect(opens.reduce((total, frame) => total + frame.jsonBytes + frame.binaryBytes, 0))
          .toBe(DEVICE_APPLICATION_BUFFER_BYTES - DEVICE_APPLICATION_STOP_BYTES)
        await expect(uploader.request('execution-v1', 'overflow', { priority: 'background' })).rejects.toThrow('backpressure')
        const replies = Promise.allSettled(['reply', 'deny', 'large-reply']
          .map(request => caller.request('execution-v1', request)))
        let settled = false
        void replies.then(() => { settled = true })
        await flush()
        expect(handled.mock.calls.map(([request]) => request)).toEqual(['reply', 'deny', 'large-reply'])
        expect(settled).toBe(false)
        expect(rawUploader.frames.filter(text => JSON.parse(text).type === 'application-reject')).toHaveLength(0)
        const pongs = pair.rawMain.frames.filter(text => JSON.parse(text).type === 'pong').length
        await vi.advanceTimersByTimeAsync(450)
        expect(pair.rawMain.frames.filter(text => JSON.parse(text).type === 'pong').length).toBeGreaterThan(pongs)
        const stop = stopRequest()
        await expect(pair.main.request('execution-v1', stop)).resolves.toEqual({ payload: 'stopped' })
        expect(handled).toHaveBeenCalledWith(stop, expect.any(Object))
        expect(pair.rawMain.closed).toBe(false)
        expect(pair.rawWorker.closed).toBe(false)
        abort.abort()
        for (const upload of uploads) await expect(upload).rejects.toThrow('cancelled')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await replies).toEqual([
          { status: 'fulfilled', value: { payload: 'reply' } },
          { status: 'rejected', reason: expect.objectContaining({ code: 'forbidden' }) },
          { status: 'rejected', reason: expect.objectContaining({ code: 'payload-too-large' }) },
        ])
        expect(handled.mock.calls.filter(([request]) => request === 'reply')).toHaveLength(1)
        await expect(caller.request('execution-v1', 'recovered')).resolves.toEqual({ payload: 'reply' })
        await expect(uploader.request('execution-v1', 'recovered')).resolves.toEqual({ payload: 'reply' })
      } finally {
        abort.abort()
        await pair.close()
        await Promise.allSettled(uploads)
        expect(vi.getTimerCount()).toBe(0)
      }
    },
  )
  it.each([
    ['request slots', 8, 2, 0],
    ['total bytes', 1, 1_048_576, 1_048_576],
  ] as const)('retains the inbound %s limit before acknowledging another packet', async (_name, admitted, jsonBytes, binaryBytes) => {
    const handler = vi.fn(async () => ({ payload: null })), pair = setup(handler)
    const open = (index: number) => pair.rawMain.send(JSON.stringify({ type: 'application-open', id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, namespace: 'execution-v1', version: 1, kind: 'request', jsonBytes, binaryBytes }))
    try {
      for (let index = 0; index < admitted; index++) open(index)
      await flush(); expect(pair.rawWorker.closed).toBe(false)
      expect(pair.rawWorker.frames.filter((frame) => JSON.parse(frame).type === 'application-ack')).toHaveLength(admitted)
      open(admitted); await flush(); expect(pair.rawWorker.closed).toBe(false)
      expect(pair.rawWorker.frames.filter((frame) => JSON.parse(frame).type === 'application-ack')).toHaveLength(admitted)
      expect(pair.rawWorker.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === 'application-reject'))
        .toEqual([{ type: 'application-reject', id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(admitted).padStart(12, '0')}`, code: 'backpressure' }])
      expect(handler).not.toHaveBeenCalled()
    } finally { await pair.close() }
  })
  it('rejects malformed offsets after upgrade without admitting a handler', async () => {
    const handler = vi.fn(async () => ({ payload: null })), pair = setup(handler)
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    pair.rawMain.send(JSON.stringify({ type: 'application-open', id, namespace: 'execution-v1', version: 1, kind: 'request', jsonBytes: 2, binaryBytes: 0 })); await flush()
    pair.rawMain.send(JSON.stringify({ type: 'application-chunk', id, offset: 1, data: Buffer.from('{}').toString('base64') })); await flush()
    expect(handler).not.toHaveBeenCalled(); expect(pair.rawWorker.closed).toBe(true); await pair.close()
  })
})


it('cancels a captured request during bundle checking before any request reaches the socket', async () => {
  let releaseCheck!: () => void
  const checking = new Promise<void>(resolve => { releaseCheck = resolve })
  const beforeRequest = vi.fn(() => checking)
  const raw = new Socket()
  const parent = new AbortController()
  const caller = new AbortController()
  const registration = { namespace: 'execution-v1', version: 1, role: 'client' as const,
    maxJsonBytes: 1024, maxBinaryBytes: 0 }
  const extensions = negotiateDeviceExtensions([registration], [{ ...registration, role: 'server' }])
  const channel = new DeviceApplicationChannel({ side: 'main', binding, socket: adaptDeviceSocket(raw),
    signal: parent.signal, extensions, registrations: [registration], beforeRequest })
  const request = channel.captureRequest('execution-v1').request({ method: 'start' }, { signal: caller.signal })
    .catch((error: unknown) => error)
  try {
    await flush()
    expect(beforeRequest).toHaveBeenCalledOnce()
    caller.abort()
    releaseCheck()
    await flush()
    expect(raw.frames.map(text => JSON.parse(text)).filter(frame => frame.type === 'application-open')).toEqual([])
    expect(await request).toMatchObject({ code: 'cancelled' })
  } finally {
    releaseCheck()
    channel.close()
    await request
    await channel.join()
  }
})

it('retrieves a remote Agent snapshot taking longer than thirty seconds within its application budget', async () => {
  vi.useFakeTimers()
  const commit = 'a'.repeat(40)
  const bundleBase64 = 'YWFh'.repeat(10 * 1024 * 1024 / 4)
  const pair = setup(async () => ({ payload: { commit, bundleBase64 } }),
    { maxJsonBytes: AGENT_SNAPSHOT_JSON_BYTES, maxBinaryBytes: 0 }, 600_000, undefined, AGENT_SNAPSHOT_NAMESPACE)
  pair.rawMain.latencyMs = 50
  pair.rawWorker.latencyMs = 50
  const read = agentFileReader(() => ({
    capabilities: () => pair.main.capabilities(),
    request: (_deviceId, namespace, payload, options) => pair.main.request(namespace, payload, options),
  }))
  try {
    const result = read({ kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, '/project', commit)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(40_000)
    const snapshot = await result as Awaited<ReturnType<typeof read>>
    expect(snapshot).not.toBeInstanceOf(Error)
    expect(snapshot).toEqual({ commit, bundle: expect.any(Buffer) })
    expect(snapshot.bundle?.equals(Buffer.from(bundleBase64, 'base64'))).toBe(true)
    expect(pair.rawMain.closed).toBe(false)
  } finally { await pair.close() }
})

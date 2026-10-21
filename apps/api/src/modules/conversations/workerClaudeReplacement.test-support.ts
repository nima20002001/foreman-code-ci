import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeSessionStart } from '../harnesses/port.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../harnesses/claudeSdk/runner.js'
import { createClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import type { NativeLaunchObservation } from '../harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { createWorkerClaudeAuthority } from './workerClaudeAuthority.js'
import { createWorkerClaudeOwner } from './workerClaudeOwner.js'
import { WorkerConversationHost, type WorkerConversationAllocation, type WorkerConversationHostPorts } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge, type WorkerConversationChannel } from './workerBridge.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { recoverWorkerConversation } from './recoverWorkerConversation.js'

function recordedConnection(f: ReturnType<typeof workerConversationFixture>) {
  let state: 'connected' | 'unavailable' | 'transport' | 'stalled' | 'reattaching' = 'connected'
  const waiting = new Set<() => void>()
  return {
    available: () => state !== 'unavailable',
    disconnect: (next: Exclude<typeof state, 'connected'> = 'transport') => { state = next },
    reconnect: () => { state = 'connected'; for (const resume of waiting) resume() },
    hasWaiter: () => waiting.size > 0,
    holdReconnect() {
      f.connection = { ...f.connection, connectionGeneration: f.connection.connectionGeneration + 1,
        connectionEpoch: randomUUID() }
      state = 'reattaching'
    },
    async before(request: WorkerConversationRpcRequest, signal?: AbortSignal) {
      if (state === 'transport') throw new DeviceConnectionError('transport')
      const pending = state === 'stalled' && request.method === 'conversation.pending'
      const attaching = state === 'reattaching' && request.method === 'conversation.open' && request.mode === 'attach'
      if (!pending && !attaching) return
      let resume!: () => void
      const waitingForWorker = new Promise<void>((resolve, reject) => {
        resume = resolve
        const abort = () => reject(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
        resume = () => { signal?.removeEventListener('abort', abort); resolve() }
        if (signal?.aborted) abort()
      })
      waiting.add(resume)
      try { await waitingForWorker } finally { waiting.delete(resume) }
    },
  }
}

interface RecordedObservers {
  all: WorkerConversationManager[]
  current?: WorkerConversationManager
}

function createRecordedObserver(f: ReturnType<typeof workerConversationFixture>, bridge: MainWorkerConversationBridge,
  observers: RecordedObservers, connected: () => boolean, request: WorkerConversationChannel['request']) {
  const channel = () => ({ binding: f.connection, request })
  const observer = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    observeSession: async () => { observers.current = observer },
    current: async () => {
      if (!connected()) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The selected paired worker channel is unavailable.', 409)
    }, channel: channel(), currentChannel: channel })
  observers.all.push(observer)
  return observer
}

async function sendRecordedMessage(manager: WorkerConversationManager, journal: RemoteOperationJournal,
  binding: ReturnType<typeof workerConversationFixture>['binding'], start: (id: string) => NativeSessionStart,
  correlationId: string) {
  const record = await journal.conversations.read(binding)
  if (!manager.startInitialTurn) throw new Error('The Claude fixture requires atomic initial message admission.')
  const input = { prompt: correlationId, clientCorrelationId: correlationId, sessionMode: 'regular' as const,
    onMessageSubmitted: async () => {} }
  const stream = record?.session ? manager.startTurn(record.session, input)
    : manager.startInitialTurn(start(correlationId), { ...input, onSessionObserved: async () => {} })
  for await (const event of stream) void event
  return (await journal.conversations.read(binding))!.session!
}

function recordedProcessRegistry(launches: NativeLaunchObservation[]) {
  return {
    snapshot: () => ({ revision: 'recorded', launches }),
    closedRegistration: (_owner: string, id: string) =>
      launches.find(launch => launch.launchId === id && launch.lifecycle === 'closed'),
    closeOwner: async (owner: string) => launches.filter(launch => launch.owner === owner)
      .every(launch => launch.lifecycle === 'closed' && Boolean(launch.closureEvidence)),
  }
}

function recordedClaudeRuntime(input: {
  fixture: ReturnType<typeof workerConversationFixture>
  profilePath: string
  sdk: ClaudeSdkClient
  journal: RemoteOperationJournal
  registry: ReturnType<typeof recordedProcessRegistry>
  source(): WorkerConversationRpcRequest
}) {
  const { fixture: f, profilePath, sdk, journal, registry, source } = input
  const owners = createWorkerClaudeOwner({
    binding: f.binding, owner: `conversation:${f.binding.owner.conversationId}`,
    registry,
    journal: journal.conversations, current: () => f.connection })
  const native = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
    scope: { deviceId: f.connection.deviceId, profilePath, configRevision: 'recorded', cwd: f.binding.workingDirectory },
    sdkOptions: {}, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: true },
    messageSubmitted: async correlationId => Boolean((await journal.conversations.read(f.binding))?.turns
      .find(turn => turn.correlationId === correlationId)?.nativeSubmission) })
  if (f.configuration.harness.harness !== 'claude') throw new Error('Claude configuration required')
  const configuration = f.configuration.harness
  const authority = createWorkerClaudeAuthority({ configuration, version: '2.1.284',
      source, signal: AbortSignal.timeout(120_000),
      callbackJournal: journal.conversations.claudeCallbackJournal(f.binding),
      ...owners, request: async (request, action) => action.phase === 'admission'
        ? { ownerPrincipalId: 'recorded-sender', attemptId: 'correlationId' in request ? request.correlationId : 'recorded-request' }
        : { authorized: true } })
  authority.bind(native)
  return { owners, native }
}

/** Recorded provider output; no native process or paid model is launched. */
export async function workerClaudeReplacementFixture(f = workerConversationFixture('operator', 'claude')) {
  const root = await mkdtemp(join(tmpdir(), 'worker-claude-replacement-'))
  const journalPath = join(root, 'operations.json')
  let journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  const launches: NativeLaunchObservation[] = []
  const offers: ClaudeSdkUserMessage[] = []
  const resumes: unknown[] = []
  const recoveries: { inputsBefore: number; inputsAfter: number }[] = []
  let source: WorkerConversationRpcRequest
  const connection = recordedConnection(f)
  let denied = false
  let failStartup = false
  let failMode = false
  let failResume = false
  let closureConfirmed = true
  let releaseResume: (() => void) | undefined
  let holdResume = false
  let releaseClosure: (() => void) | undefined
  let holdClosure = false
  const nativeId = f.session.nativeSessionId
  const profilePath = join(root, 'profile')
  const transcriptDirectory = join(profilePath, 'projects', 'recorded')
  await mkdir(transcriptDirectory, { recursive: true })
  const transcriptPath = join(transcriptDirectory, `${nativeId}.jsonl`)
  await writeFile(transcriptPath, '')
  const historyPath = join(root, 'sdk-messages.jsonl')
  await writeFile(historyPath, '')
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async (_sessionId, options) => {
      const rows = (await readFile(historyPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown)
      const offset = options.offset ?? 0
      return rows.slice(offset, offset + (options.limit ?? 256))
    },
    forkSession: async () => { throw new Error('This fixture does not fork.') },
    query(input) {
      if (failStartup || input.options.resume && failResume) {
        failStartup = false
        failResume = false
        throw new Error('Recorded SDK startup failed')
      }
      resumes.push(input.options.resume)
      let launch: NativeLaunchObservation = { owner: `conversation:${f.binding.owner.conversationId}`,
        launchId: randomUUID(), bootId: f.connection.bootId, lifecycle: 'active',
        guardian: { pid: 100 + launches.length, startTicks: String(100 + launches.length) },
        provider: { pid: 200 + launches.length, startTicks: String(200 + launches.length) },
        boundary: { kind: 'cgroup-v2', path: `/recorded/cgroup/${launches.length}`, device: '1', inode: String(launches.length) } }
      const index = launches.length
      launches.push(launch)
      const frames = new ClaudeBoundedQueue<unknown>(32)
      const consume = (async () => {
        for await (const message of input.prompt) {
          offers.push(message)
          await appendFile(historyPath, JSON.stringify({ ...message, session_id: nativeId }) + '\n')
          await frames.offer({ type: 'system', subtype: 'init', session_id: nativeId,
            claude_code_version: '2.1.284', cwd: f.binding.workingDirectory, slash_commands: ['compact'] })
          if (message.message.content === '/compact') {
            await appendFile(transcriptPath, JSON.stringify({ type: 'system', subtype: 'compact_boundary',
              cwd: f.binding.workingDirectory, sessionId: nativeId, uuid: randomUUID(),
              compactMetadata: { trigger: 'manual', preTokens: 100 }, timestamp: new Date().toISOString() }) + '\n')
            await frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: nativeId,
              uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 100 } })
            await frames.offer({ type: 'result', session_id: nativeId, uuid: randomUUID(),
              user_message_uuid: message.uuid, subtype: 'success', is_error: false, local_command: 'compact', result: 'Compacted' })
          } else {
            await frames.offer({ type: 'assistant', session_id: nativeId, uuid: randomUUID(),
              user_message_uuid: message.uuid, parent_tool_use_id: null,
              message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Recorded answer' }] } })
            await frames.offer({ type: 'result', session_id: nativeId, uuid: randomUUID(),
              user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Recorded answer' })
          }
        }
      })()
      return {
        [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        initializationResult: async () => {
          if (input.options.resume && holdResume) await new Promise<void>(resolve => { releaseResume = resolve })
          return { models: [], account: {} }
        },
        setPermissionMode: async () => { if (failMode) { failMode = false; throw new Error('Recorded mode failure') } },
        interrupt: async () => ({}),
        close() {
          launch = { ...launch, lifecycle: closureConfirmed ? 'closed' : 'closure-unconfirmed',
            ...(closureConfirmed ? { closureEvidence: 'native_exit_removed_cgroup' as const } : {}) }
          launches[index] = launch
          frames.close()
        },
        joinClosed: async () => { await consume },
      }
    },
  }
  const registry = recordedProcessRegistry(launches)
  const createRuntime = () => recordedClaudeRuntime({ fixture: f, profilePath, sdk, journal, registry,
    source: () => source })
  let runtime = createRuntime()
  let allocationClosed = false
  const bridge = new MainWorkerConversationBridge()
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async payload => ({
      payload: await bridge.handle(payload, f.connection, AbortSignal.timeout(1000)),
    }) }) })
  const start = (correlationId: string): NativeSessionStart => {
    const owner = f.binding.owner
    if (owner.kind === 'operator' && 'operatorId' in f.configuration) return {
      kind: 'operator', configuration: f.configuration, correlationId, workingDirectory: f.binding.workingDirectory,
    }
    if (owner.kind === 'agent' && 'agentId' in f.configuration) return {
      kind: 'agent-chat', configuration: f.configuration, correlationId, workingDirectory: f.binding.workingDirectory,
      conversationId: owner.conversationId, workflowId: owner.workflowId, workflowNodeId: owner.workflowNodeId,
      instructionsDelivered: false,
    }
    throw new Error('The fixture configuration and owner differ.')
  }
  const createAllocation = (): WorkerConversationAllocation => {
    const current = runtime
    return { manager: current.native, start: async ({ correlationId, instructionsDelivered }) => {
      const input = start(correlationId)
      if (input.kind === 'agent-chat') return { ...input, instructionsDelivered }
      return input
    },
      nativeOwner: current.owners.nativeOwner, close: async () => {
        if (holdClosure) await new Promise<void>(resolve => { releaseClosure = resolve })
        await current.native.dispose?.()
        if (runtime === current) allocationClosed = true
      } }
  }
  let allocation = createAllocation()
  const liveAllocation = () => {
    if (allocationClosed) {
      runtime = createRuntime()
      allocation = createAllocation()
      allocationClosed = false
    }
    return allocation
  }
  const authorize: WorkerConversationHostPorts['authorize'] =
    async (request, connection, signal) => {
      if (denied) throw new Error('Main denied the caller')
      await callbacks.authorize(request, connection, signal)
    }
  const createHost = () => new WorkerConversationHost({
    ...callbacks, currentBinding: () => f.connection, journal: journal.conversations,
    allocate: async () => liveAllocation(),
    authorize,
    recover: async (record, configuration, connection, signal, request) => {
      const inputsBefore = offers.length
      const recovered = await recoverWorkerConversation({ record, configuration, connection, signal, request,
        registry, journal: journal.conversations, allocate: async () => liveAllocation(),
        assertCurrent: () => authorize(request, connection, signal) })
      recoveries.push({ inputsBefore, inputsAfter: offers.length })
      return recovered
    },
  })
  let host = createHost()
  const observers: RecordedObservers = { all: [] }
  const createManager = () => createRecordedObserver(f, bridge, observers, connection.available, async (payload, options) => {
    const request = WorkerConversationRpcRequestSchema.parse(payload)
    await connection.before(request, options?.signal)
    if (request.method === 'conversation.initial-turn' || request.method === 'conversation.start-turn') source = request
    return { payload: await host.handle(request, f.connection, options?.signal) }
  })
  let manager = createManager()
  const send = (correlationId: string) => sendRecordedMessage(manager, journal, f.binding, start, correlationId)
  return { ...f, get journal() { return journal }, get manager() { return manager }, createManager,
    get native() { return runtime.native }, get owners() { return runtime.owners },
    launches, offers, resumes, recoveries, send, start,
    disconnect: connection.disconnect, reconnect: connection.reconnect,
    holdReconnect: connection.holdReconnect, hasReconnectWaiter: connection.hasWaiter,
    get observer() { return observers.current },
    async coldRestart() {
      for (const observer of observers.all) await observer.dispose()
      await host.shutdown()
      await journal.close()
      journal = await RemoteOperationJournal.open(journalPath)
      runtime = createRuntime()
      allocation = createAllocation()
      allocationClosed = false
      host = createHost()
      manager = createManager()
    },
    deny: () => { denied = true }, failStartup: () => { failStartup = true }, failMode: () => { failMode = true },
    failResume: () => { failResume = true }, holdResume: () => { holdResume = true },
    releaseResume: () => { holdResume = false; releaseResume?.() },
    hasResumeWaiter: () => Boolean(releaseResume), unconfirmedClosure: () => { closureConfirmed = false },
    holdClosure: () => { holdClosure = true }, hasClosureWaiter: () => Boolean(releaseClosure),
    releaseClosure: () => { holdClosure = false; releaseClosure?.(); releaseClosure = undefined },
    async close() {
      releaseResume?.()
      holdClosure = false
      releaseClosure?.()
      for (const observer of observers.all) await observer.dispose()
      await host.shutdown()
      await journal.close()
      await rm(root, { recursive: true, force: true })
    } }
}

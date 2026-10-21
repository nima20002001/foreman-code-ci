import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExecutionResult, SessionPreferences } from '@foreman-code/contracts'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import { WorkerConversationHost, type WorkerConversationHostPorts } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationSessionStart } from './workerConversationStart.js'

/** Real Main/Worker admission and disk journal; only the provider and paired wire are controlled ports. */
export async function workerDeliveryFixture() {
  const f = workerConversationFixture('operator', 'codex')
  if (!('operatorId' in f.configuration)) throw new Error('Expected Operator configuration.')
  const configuration = f.configuration, binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const root = await mkdtemp(join(tmpdir(), 'worker-delivery-'))
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  const bridge = new MainWorkerConversationBridge()
  const histories = new Map<string, NativeHistory>()
  const inputs: Array<{ correlationId: string; prompt: string; mode?: 'regular' | 'plan'; preferences?: SessionPreferences }> = []
  const frames: WorkerConversationRpcRequest[] = []
  const credentials: string[] = []
  const releases = new Map<string, () => void>()
  let creates = 0, closed = false, hold = false, liveInputs = 0, maximumInputs = 0
  let denyAfterBind = false, dropSessionCallback = false, preferences: SessionPreferences | null = null
  // Claude semantics: creation settings are accepted only before a native runtime opens.
  let openSessionSettingsRejected = false
  const native: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: async () => { throw new Error('No installation qualification in a provider fixture.') },
    inspectMcp: async () => { throw new Error('No installation inspection in a provider fixture.') },
    createSession: async () => { creates++; return f.session }, attachSession: async () => f.session,
    configureSessionPreferences: async next => {
      if (openSessionSettingsRejected && creates > 0) throw new Error('These settings require a safe resume or a new session.')
      preferences = structuredClone(next)
    },
    appliedSessionPreferences: () => preferences,
    async *startTurn(_session, input, signal) {
      liveInputs++; maximumInputs = Math.max(maximumInputs, liveInputs)
      inputs.push({ correlationId: input.clientCorrelationId, prompt: input.prompt,
        ...(input.sessionMode ? { mode: input.sessionMode } : {}), ...(input.sessionPreferences ? { preferences: input.sessionPreferences } : {}) })
      const id = `turn-${inputs.length}`
      const history: NativeHistory = { correlationId: input.clientCorrelationId, nativeTurnId: id, events: [], pendingInteractions: [] }
      histories.set(input.clientCorrelationId, history)
      try {
        await input.onSubmitted?.(id)
        await input.onSettingsApplied?.()
        if (hold) await new Promise<void>(resolve => {
          const release = () => { signal?.removeEventListener('abort', release); releases.delete(input.clientCorrelationId); resolve() }
          releases.set(input.clientCorrelationId, release)
          signal?.addEventListener('abort', release, { once: true })
          if (signal?.aborted) release()
        })
        history.terminalResult ??= { outcome: 'succeeded', output: { text: input.prompt } }
        history.terminalTurn = { correlationId: input.clientCorrelationId, providerId: id, result: history.terminalResult }
        yield { sequence: inputs.length, type: 'turn.completed', occurredAt: new Date().toISOString(), payload: {} }
      } finally { liveInputs-- }
    },
    history: async () => [...histories.values()].at(-1) ?? { events: [], pendingInteractions: [] },
    reconcile: async (_session, correlationId) => histories.get(correlationId) ?? { events: [], pendingInteractions: [] },
    pending: async () => undefined, respond: async () => {}, cancel: async () => false, close: async () => {},
  }
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection,
    capture: () => ({ binding: f.connection, request: async payload => ({ payload: await bridge.handle(payload, f.connection, new AbortController().signal) }) }) })
  const ports: WorkerConversationHostPorts = { ...callbacks, journal: journal.conversations, currentBinding: () => f.connection,
    authorize: async (request, connection, signal) => {
      if (denyAfterBind && (await journal.conversations.read(binding))?.session) throw new Error('Original owner authority ended after session bind.')
      await callbacks.authorize(request, connection, signal)
    },
    observeSession: async (...args) => { if (dropSessionCallback) throw new Error('Main lost its session callback.'); await callbacks.observeSession(...args) },
    allocate: async () => ({ manager: native, nativeOwner: async () => f.nativeOwner, close: async () => {},
      start: async options => {
        if (options.applicationAccess) credentials.push(options.applicationAccess.token)
        return workerConversationSessionStart(binding, configuration, options.applicationAccess
          ? { agentId: configuration.operatorId, variables: { FOREMAN_CODE_MCP_TOKEN: options.applicationAccess.token } } : undefined, options)
      },
      refreshApplicationAccess: async token => { credentials.push(token) },
    }),
  }
  const host = new WorkerConversationHost(ports)
  const managers: WorkerConversationManager[] = []
  const manager = () => {
    const value = new WorkerConversationManager({ binding, configuration, bridge, current: async () => {},
      channel: { binding: f.connection, request: async raw => {
        frames.push(WorkerConversationRpcRequestSchema.parse(raw))
        return { payload: await host.handle(raw, f.connection) }
      } } })
    managers.push(value)
    return value
  }
  const start = (correlationId: string, token = 'token-one'): NativeSessionStart => ({ kind: 'operator', configuration,
    correlationId, workingDirectory: binding.workingDirectory,
    environment: { agentId: configuration.operatorId, variables: { FOREMAN_CODE_MCP_TOKEN: token } } })
  return { ...f, binding, configuration, journal, bridge, host, ports, inputs, frames, credentials, manager, start,
    creates: () => creates, maximumInputs: () => maximumInputs,
    control: (next: { hold?: boolean; denyAfterBind?: boolean; dropSessionCallback?: boolean; openSessionSettingsRejected?: boolean }) => {
      hold = next.hold ?? hold; denyAfterBind = next.denyAfterBind ?? denyAfterBind; dropSessionCallback = next.dropSessionCallback ?? dropSessionCallback
      openSessionSettingsRejected = next.openSessionSettingsRejected ?? openSessionSettingsRejected
    },
    finish: (correlationId: string, result: ExecutionResult = { outcome: 'succeeded', output: { text: 'Original result' } }) => {
      const history = histories.get(correlationId)
      if (history) history.terminalResult = result
      releases.get(correlationId)?.()
    },
    close: async () => {
      if (closed) return; closed = true
      for (const release of releases.values()) release()
      await Promise.all(managers.map(value => value.dispose()))
      await host.shutdown(); await bridge.close(); await journal.close(); await rm(root, { recursive: true, force: true })
    },
  }
}

import { RECORDED_CODEX_VERSION } from '../fixtures/codex-version.js'
import { createHash, randomUUID } from 'node:crypto'
import type { CodexSessionDependencies, CodexTransport } from '../../src/modules/harnesses/codexAppServer.js'
import { CodexRpcError, type JsonObject, type RpcRequest } from '../../src/modules/harnesses/codexStdioTransport.js'
import { appLauncherPath } from '../../src/modules/harnesses/appMcpLauncher.js'
import type { ProductionHarnessInfrastructure } from '../../src/modules/harnesses/productionInfrastructure.js'
import { fixtureProtocol } from '../fixtures/codex-test-helpers.js'

interface Turn extends JsonObject { id: string; status: string; items: JsonObject[] }
interface Thread extends JsonObject { id: string; turns: Turn[]; settings: JsonObject; ephemeral: boolean }
interface Channel { connected: boolean; request(request: RpcRequest): Promise<void>; notify(method: string, payload: JsonObject): void; disconnect(error: Error): void }
const outcome = (stdout: string, exitCode = 0) => ({ exitCode, exitSignal: null, stdout, stderr: '' })

/** Hand-authored Codex 0.154.0 protocol scenarios. Injected below the actual production adapter;
 * no provider binary, login, model call, ambient credential or private service object is used. */
export class ActivityProductionReplay {
  readonly appTokens = new Map<string, string>()
  readonly threads = new Map<string, Thread>()
  readonly channels = new Map<string, Channel>()
  readonly starts: Array<{ sessionId: string; nativeTurnId: string; correlationId: string; promptDigest: string }> = []
  readonly toolReplies = new Map<string | number, JsonObject>()
  readonly responses: Array<{ sessionId: string; rpcId: string | number }> = []
  readonly calls: Array<{ method: string; sessionId?: string }> = []
  readonly closes: string[] = []
  readonly requests = new Map<string | number, string>()
  private readonly fileReplyWaiters = new Map<string | number, (response: JsonObject) => void>()
  private counter = 0
  private readonly inFlight = new Set<Promise<void>>()
  private readonly auxiliary = new Set<string>()
  nextResponse: 'acknowledged' | 'uncertain' | 'unacknowledged' = 'acknowledged'
  nextStart: 'active' | 'complete' | 'approval' | 'reject' | 'uncertain' = 'active'
  nextCompletionText = 'recorded workflow final'

  constructor(private readonly threadIdPrefix = 'recorded-thread',
    private readonly qualifiedModels: readonly string[] = ['test-model']) {}

  private transport: NonNullable<Extract<CodexSessionDependencies, { mode: 'replay' }>['transport']> = (
    _binary, _cwd, _environment, _protocol, onRequest, onNotification, onDisconnect, _timeoutMs, _recovery, disabledMcpServerNames = [],
  ): CodexTransport => {
    let sessionId: string | undefined
    const channel: Channel = { connected: true, request: onRequest, notify: onNotification, disconnect: onDisconnect }
    const bind = (thread: Thread) => { sessionId = thread.id; this.channels.set(thread.id, channel) }
    const threadResponse = (thread: Thread, params: JsonObject) => ({ thread: { id: thread.id, turns: thread.turns, ephemeral: thread.ephemeral }, ...this.settings(params) })
    return {
      isConnected: () => channel.connected,
      start: async () => {},
      request: async (method, params = {}) => {
        this.calls.push({ method, ...(sessionId ? { sessionId } : {}) })
        if (method === 'thread/start' || method === 'thread/fork') {
          const original = method === 'thread/fork' ? this.threads.get(String(params.threadId)) : undefined
          if (method === 'thread/fork' && !original) throw new Error('Replay fork must identify the exact source session.')
          const thread: Thread = { id: `${this.threadIdPrefix}-${++this.counter}`, turns: original ? structuredClone(original.turns) : [],
            settings: this.settings(params), ephemeral: params.ephemeral === true }
          this.threads.set(thread.id, thread); bind(thread)
          const token = _environment?.FOREMAN_CODE_MCP_TOKEN ?? _environment?.GRAPHQL_MCP_TOKEN
          if (token) this.appTokens.set(thread.id, token)
          return threadResponse(thread, params)
        }
        if (method === 'thread/resume') {
          const thread = this.threads.get(String(params.threadId))
          if (!thread) throw new Error('Replay cannot replace an unknown native session.')
          bind(thread); return threadResponse(thread, params)
        }
        const thread = sessionId ? this.threads.get(sessionId) : this.threads.get(String(params.threadId))
        if (method === 'thread/read') {
          if (!thread || thread.id !== params.threadId) throw new Error('Replay history must retain exact native session.')
          return { thread: { ...structuredClone(thread), turns: params.includeTurns ? structuredClone(thread.turns) : [] } }
        }
        if (method === 'thread/turns/list') {
          if (!thread || thread.id !== params.threadId) throw new Error('Replay page scope changed.')
          return { data: [...structuredClone(thread.turns)].reverse(), nextCursor: null, prevCursor: null }
        }
        if (method === 'turn/start') {
          if (!thread || params.threadId !== thread.id || !Array.isArray(params.input)) throw new Error('Replay turn admission is unscoped.')
          const mode = this.nextStart; this.nextStart = 'active'
          const completionText = this.nextCompletionText
          this.nextCompletionText = 'recorded workflow final'
          if (mode === 'reject') throw new CodexRpcError(method, 'recorded-rejection', false, 'CODEX_REQUEST_FAILED')
          const turn: Turn = { id: `recorded-turn-${thread.turns.length + 1}`, status: 'inProgress', itemsView: 'full',
            error: null, startedAt: 1, completedAt: null, durationMs: null,
            items: [{ id: `recorded-user-${thread.turns.length + 1}`, clientId: params.clientUserMessageId ?? null,
              type: 'userMessage', content: params.input }] }
          thread.turns.push(turn)
          this.starts.push({ sessionId: thread.id, nativeTurnId: turn.id, correlationId: String(params.clientUserMessageId),
            promptDigest: createHash('sha256').update(JSON.stringify(params.input)).digest('hex') })
          if (mode === 'uncertain') {
            throw new CodexRpcError(method, 'recorded-uncertainty', true, 'CODEX_REQUEST_UNCERTAIN')
          }
          if (mode === 'complete' || mode === 'approval') {
            const task = new Promise<void>((resolve, reject) => setImmediate(() => {
              if (mode === 'complete') { this.complete(thread.id, turn.id, completionText); resolve() }
              else this.ask(thread.id, turn.id).then(resolve, reject)
            }))
            this.inFlight.add(task); void task.finally(() => this.inFlight.delete(task)).catch(() => { /* ignore: disposal awaits the original recorded task; this observer only removes it from the in-flight set. */ })
          }
          return { turn: structuredClone(turn) }
        }
        if (method === 'turn/interrupt') {
          if (!thread) throw new Error('Replay interrupt has no native owner.')
          const turn = thread.turns.find((entry) => entry.id === params.turnId)
          if (!turn || turn.status !== 'inProgress') return {}
          turn.status = 'interrupted'; turn.completedAt = 2
          channel.notify('turn/completed', { threadId: thread.id, turn: structuredClone(turn) }); return {}
        }
        if (method === 'config/read') return { config: { approval_policy: 'on-request',
          mcp_servers: { graphql: { enabled: !disabledMcpServerNames.includes('graphql'), required: true } } }, origins: {}, layers: [] }
        if (method === 'mcpServerStatus/list') return { data: [{ name: 'graphql',
          runtimeStatus: disabledMcpServerNames.includes('graphql') ? 'disabled' : 'connected', toolsError: null,
          tools: { context_get: { name: 'context_get', inputSchema: { type: 'object' } } },
          resources: [], resourceTemplates: [], authStatus: 'bearerToken' }], nextCursor: null }
        if (method === 'model/list') return { data: this.qualifiedModels.map(id => ({ id })), nextCursor: null }
        if (method === 'config/mcpServer/reload') return {}
        throw new Error(`Unrecorded replay operation: ${method}`)
      },
      respond: async (rpcId, _method, result) => {
        if (!sessionId || !channel.connected || this.requests.get(rpcId) !== sessionId) throw new Error('Replay response lost its exact callback.')
        this.responses.push({ sessionId, rpcId }); this.requests.delete(rpcId)
        if (result && typeof result === 'object' && !Array.isArray(result)) this.toolReplies.set(rpcId, result as JsonObject)
        if (this.nextResponse === 'uncertain') {
          this.nextResponse = 'acknowledged'
          throw new CodexRpcError('native/respond', rpcId, true, 'CODEX_RESPONSE_UNCERTAIN')
        }
        const fileReply = this.toolReplies.get(rpcId)
        if (fileReply) this.fileReplyWaiters.get(rpcId)?.(fileReply)
        if (this.nextResponse === 'unacknowledged') {
          this.nextResponse = 'acknowledged'
          return
        }
        // Recorded provider confirmation is distinct from writing the transport reply.
        channel.notify('serverRequest/resolved', { threadId: sessionId, requestId: rpcId })
      },
      reject: async () => { throw new Error('Unexpected automatic native rejection in manual replay.') },
      close: async () => { if (channel.connected && sessionId) this.closes.push(sessionId); channel.connected = false },
    }
  }

  private settings(params: JsonObject): JsonObject {
    const config = params.config && typeof params.config === 'object' ? params.config as JsonObject : {}
    return { model: params.model ?? 'test-model', modelProvider: 'openai', cwd: params.cwd,
      reasoningEffort: config.model_reasoning_effort ?? 'low', serviceTier: params.serviceTier === 'fast' ? 'fast' : null,
      approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
      sandbox: params.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: (config.sandbox_workspace_write as JsonObject)?.writable_roots ?? [],
        networkAccess: (config.sandbox_workspace_write as JsonObject)?.network_access ?? false, excludeTmpdirEnvVar: (config.sandbox_workspace_write as JsonObject)?.exclude_tmpdir_env_var ?? false, excludeSlashTmp: (config.sandbox_workspace_write as JsonObject)?.exclude_slash_tmp ?? false }
        : { type: 'readOnly', networkAccess: false } }
  }
  append(sessionId: string, nativeTurnId: string, text: string, itemId = 'recorded-answer') {
    this.channels.get(sessionId)!.notify('item/agentMessage/delta', { threadId: sessionId, turnId: nativeTurnId, itemId, delta: text })
  }
  complete(sessionId: string, nativeTurnId: string, text: string, itemId = 'recorded-answer') {
    const thread = this.threads.get(sessionId)!, turn = thread.turns.find((entry) => entry.id === nativeTurnId)!
    const item = { type: 'agentMessage', id: itemId, text, phase: 'final_answer' }
    turn.items = [...turn.items.filter((entry) => entry.id !== itemId), item]
    turn.status = 'completed'; turn.completedAt = 2
    const channel = this.channels.get(sessionId)!
    channel.notify('item/completed', { threadId: sessionId, turnId: nativeTurnId, item })
    channel.notify('turn/completed', { threadId: sessionId, turn: structuredClone(turn) })
  }
  finalText(sessionId: string, nativeTurnId: string, text: string, itemId = 'recorded-answer') {
    const thread = this.threads.get(sessionId)!, turn = thread.turns.find((entry) => entry.id === nativeTurnId)!
    const item = { type: 'agentMessage', id: itemId, text, phase: 'final_answer' }
    turn.items = [...turn.items.filter((entry) => entry.id !== itemId), item]
    this.channels.get(sessionId)!.notify('item/completed', { threadId: sessionId, turnId: nativeTurnId, item })
  }
  async fileTool(sessionId: string, nativeTurnId: string, tool: string, arguments_: Record<string, unknown>, callId: string = randomUUID()) {
    const rpcId = `recorded-file-rpc-${++this.counter}`
    this.requests.set(rpcId, sessionId)
    let reject!: (error: Error) => void
    const pending = new Promise<JsonObject>((resolve, fail) => {
      this.fileReplyWaiters.set(rpcId, resolve); reject = fail
    })
    const timer = setTimeout(() => reject(new Error('Native file tool returned no qualified response.')), 30_000)
    try {
      // Production dispatch returns before async file I/O and the exact transport reply.
      const [, response] = await Promise.all([this.channels.get(sessionId)!.request({ id: rpcId, method: 'item/tool/call',
        params: { threadId: sessionId, turnId: nativeTurnId, callId, tool, arguments: arguments_ } }), pending])
      return { response, callId }
    } finally { clearTimeout(timer); this.fileReplyWaiters.delete(rpcId) }
  }
  commandRunning(sessionId: string, nativeTurnId: string) {
    const thread = this.threads.get(sessionId)!, turn = thread.turns.find((entry) => entry.id === nativeTurnId)!
    const item = { type: 'commandExecution', id: 'recorded-command', command: 'recorded readonly command',
      cwd: thread.settings.cwd, status: 'inProgress', aggregatedOutput: '' }
    turn.items = [...turn.items.filter((entry) => entry.id !== item.id), item]
    this.channels.get(sessionId)!.notify('item/started', { threadId: sessionId, turnId: nativeTurnId, item })
  }
  commandCompleted(sessionId: string, nativeTurnId: string) {
    const thread = this.threads.get(sessionId)!, turn = thread.turns.find((entry) => entry.id === nativeTurnId)!
    const item = { type: 'commandExecution', id: 'recorded-command', command: 'recorded readonly command',
      cwd: thread.settings.cwd, status: 'completed', exitCode: 0, aggregatedOutput: '' }
    turn.items = [...turn.items.filter((entry) => entry.id !== item.id), item]
    this.channels.get(sessionId)!.notify('item/completed', { threadId: sessionId, turnId: nativeTurnId, item })
  }
  async ask(sessionId: string, nativeTurnId: string, rpcId: string | number = `recorded-ask-${++this.counter}`) {
    this.requests.set(rpcId, sessionId)
    await this.channels.get(sessionId)!.request({ id: rpcId, method: 'item/commandExecution/requestApproval',
      params: { threadId: sessionId, turnId: nativeTurnId, itemId: 'recorded-command', command: 'recorded readonly command',
        cwd: this.threads.get(sessionId)!.settings.cwd } })
  }
  disconnect(sessionId: string) {
    const channel = this.channels.get(sessionId)!
    channel.connected = false; channel.disconnect(new Error('Recorded connection loss after commit.'))
  }
  async drain() { await Promise.allSettled([...this.inFlight]) }

  infrastructure(processRegistryRoot = '/recorded-no-process-registry'): ProductionHarnessInfrastructure {
    const command: Extract<CodexSessionDependencies, { mode: 'replay' }>['runCommand'] = async (_binary, args) => {
      if (args[0] === 'mcp' && args[1] === 'get') {
        if (args[2] !== 'graphql') return { ...outcome('', 1),
          stderr: `Error: No MCP server named '${args[2]}' found.` }
        return outcome(JSON.stringify({ name: 'graphql', enabled: true, required: true,
          transport: { type: 'stdio', command: process.execPath, args: [appLauncherPath()], env_vars: ['GRAPHQL_MCP_TOKEN'] } }))
      }
      if (args[0] === 'mcp' && args[1] === 'list') return outcome(JSON.stringify([{ name: 'graphql',
        transport: { type: 'stdio', command: process.execPath, args: [appLauncherPath()], env_vars: ['GRAPHQL_MCP_TOKEN'] } }]))
      if (args[0] === 'debug' && args[1] === 'models') return outcome(JSON.stringify({ models: this.qualifiedModels.map(slug => ({
        slug, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], additional_speed_tiers: ['fast'],
      })) }))
      throw new Error(`Unexpected replay CLI operation: ${args.join(' ')}`)
    }
    const qualify: Extract<CodexSessionDependencies, { mode: 'replay' }>['qualify'] = async (binary) => {
      if (binary !== '/recorded-no-native-codex') throw new Error('Unrecorded replay qualification binary.')
      return { binary,
        identity: 'recorded-launcher', protocol: fixtureProtocol, providerVersion: RECORDED_CODEX_VERSION,
        schemaManifestSha256: 'synthetic-recorded-schema', stableSchemaGitBlob: 'synthetic-stable', referenceSchemaManifestSha256: 'synthetic-reference' }
    }
    const environment: Extract<CodexSessionDependencies, { mode: 'replay' }>['environment'] = (input, stripped = []) => {
      const values: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(input?.variables ?? {})) if (!stripped.includes(key)) values[key] = value
      return values
    }
    const operations = { qualify, assertUnchanged: async () => {}, environment, runCommand: command,
      qualifyModel: async (configuration: Parameters<NonNullable<CodexSessionDependencies['qualifyModel']>>[0]) => {
        if (!this.qualifiedModels.includes(configuration.model)) throw new Error('Unrecorded replay model qualification.')
      } }
    const codex: Extract<CodexSessionDependencies, { mode: 'replay' }> = { mode: 'replay', ...operations,
      transport: this.transport, id: randomUUID, now: () => new Date('2026-10-01T00:00:00Z'), schedule: setTimeout,
      cancelTimer: clearTimeout, withDiagnostics: async (_pin, run) => run(operations) }
    const unavailable = async (): Promise<never> => { throw new Error('Unrecorded auxiliary replay operation.') }
    return { mode: 'replay', codex,

      // Synthetic inventory enables the real defaults gate against recorded ports only.
      // These facts are protocol-fixture data, never installed/native qualification evidence.
      inventoryDiscovery: { launcher: async (requested, environment, _payloadPaths, signal) => {
        signal?.throwIfAborted()
        if (requested === '/recorded-no-native-codex') return { requested, environment,
          resolvedLauncher: requested, fingerprint: createHash('sha256').update('activity-protocol-replay-v1').digest('hex'),
          status: 'installed', interpreter: null,
          diagnostics: ['Synthetic activity protocol replay inventory; no installed provider was inspected or qualified.'],
          checkedAt: '2026-10-01T00:00:00.000Z' }
        return { requested, environment, resolvedLauncher: null, fingerprint: null, status: 'missing',
          interpreter: null, diagnostics: ['Activity protocol replay does not inspect installed providers.'],
          checkedAt: '2026-10-01T00:00:00.000Z' }
      }, payloads: async (driver, launcher) => {
        if (driver !== 'codex' || launcher !== '/recorded-no-native-codex') throw new Error('Unrecorded auxiliary replay operation.')
        return { complete: true, paths: [] }
      } },
      auxiliary: { command, recovery: { scope: (owner) => ({ root: processRegistryRoot, owner }),
        reserveLaunch: async (owner) => {
          const launchId = randomUUID()
          this.auxiliary.add(launchId)
          return { root: processRegistryRoot, owner, launchId }
        },
        abandonReservedLaunch: async (scope) => { if (!scope.launchId) return false; return this.auxiliary.delete(scope.launchId) },
        closeOwner: async () => true }, plugins: { recoveryIdentity: '', list: unavailable, detail: unavailable, change: unavailable },
        mcp: { codex: { read: unavailable, apply: unavailable } },
        compatibility: { probe: { inspect: unavailable, probe: unavailable, assertUnchanged: unavailable },
          cache: { load: async () => null, save: async () => {} } } } }
  }
}

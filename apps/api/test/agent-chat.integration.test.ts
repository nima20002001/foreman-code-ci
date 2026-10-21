import { readUntil } from './helpers/observableCondition.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { mkdtemp } from 'node:fs/promises'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentConfigurationVersionSchema, CODEX_APPROVAL_OPTIONS_FIXTURE, NativeHarnessEventSchema,
  type AgentConfigurationVersion, type CompactionState, type ExecutionResult, type HarnessExecution, type NativeSessionReference,
} from '@foreman-code/contracts'
import { AgentChatControlsStateSchema, AgentChatHistoryPageSchema, AgentChatStateSchema, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { qualifiedAgentChatSteer } from '../src/modules/conversations/chatSteerQualification.js'
import { prepareAgentChatInput } from '../src/modules/collaboration/chatInputPreparation.js'
import { HarnessExecutionError, NativeDeliveryError, NativeTurnNotActiveError } from '../src/modules/harnesses/errors.js'
import { DomainError } from '../src/modules/errors.js'
import type { NativeCompactInput, NativeHarnessSessionManager, NativeHistory, NativeInitialTurnInput, NativeSessionStart, NativeSteerInput, NativeTurnInput } from '../src/modules/harnesses/port.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { workspaceRootHostScope } from '../src/modules/sources/rootPolicies.js'
import { AgentManagementService } from '../src/modules/workspaces/agents.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { AgentMutationResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { sessionStartConfiguration } from '../src/modules/harnesses/sessionStart.js'

const claudeConfiguration = {
  harness: 'claude', model: 'fixture-model', effort: 'medium', authMode: 'subscription',
  configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {},
} satisfies ClaudeHarnessConfiguration

const connectionString = process.env.TEST_DATABASE_URL!

/** Only provider I/O is fake. Migrations, SQL, receipts, authorization, HTTP and MCP are real. */
class FakeNative implements NativeHarnessSessionManager {
  static all: FakeNative[] = []
  created: NativeSessionStart[] = []; attached: NativeSessionStart[] = []; forked: Array<{ source: string; input: NativeSessionStart }> = []
  modes: Array<string | undefined> = []
  prompts: string[] = []; steers: NativeSteerInput[] = []; cancels = 0
  hold = false
  deferCancelTerminal = false
  private turn = 0
  private readonly histories = new Map<string, NativeHistory>()
  private active: { id: string; correlation: string; release: () => void } | undefined
  constructor(readonly harness: 'codex' | 'claude') { FakeNative.all.push(this) }
  async capabilities() {
    return { provider: this.harness, providerVersion: 'fixture-1', persistentSessions: true, reconnect: true, sameRequestResponses: true,
      cancellation: true, history: true, configurationInspection: false, mcpDetection: false, supportedInteractionKinds: [] }
  }
  inspectMcp(): ReturnType<NativeHarnessSessionManager['inspectMcp']> { throw new Error('unused') }
  async createSession(input: NativeSessionStart): Promise<NativeSessionReference> {
    this.created.push(input)
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: `native-${randomUUID()}` }
  }
  async attachSession(session: NativeSessionReference, input: NativeSessionStart) { this.attached.push(input); return session }
  async forkSession(source: NativeSessionReference, input: NativeSessionStart): Promise<NativeSessionReference> {
    this.forked.push({ source: source.nativeSessionId, input })
    return { harness: this.harness, providerVersion: 'fixture-1', nativeSessionId: `fork-${randomUUID()}` }
  }
  async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    this.prompts.push(input.prompt)
    this.modes.push(input.sessionMode)
    await input.onSettingsApplied?.()
    const id = `turn-${++this.turn}`
    const history: NativeHistory = { correlationId: input.clientCorrelationId, events: [], pendingInteractions: [] }
    this.histories.set(input.clientCorrelationId, history)
    if (this.harness === 'claude') {
      history.nativeSubmission = { kind: 'message', nativeSessionId: session.nativeSessionId,
        nativeMessageId: id, clientCorrelationId: input.clientCorrelationId }
      await input.onMessageSubmitted?.(history.nativeSubmission)
    } else {
      history.nativeTurnId = id
      await input.onSubmitted?.(id)
    }
    const itemId = `answer-${randomUUID()}`
    const text = `reply to ${input.prompt.slice(-20)}`
    if (this.harness === 'claude') {
      yield NativeHarnessEventSchema.parse({ sequence: this.turn * 10, type: 'claude.text',
        occurredAt: new Date().toISOString(), payload: {
          itemId, messageId: id, text, operation: 'replace', final: true,
          nativeSessionId: session.nativeSessionId, clientCorrelationId: input.clientCorrelationId,
          nativeGeneration: 'fixture', source: { eventId: `answer-${id}`, sequence: String(this.turn * 10) },
        } })
    } else {
      yield NativeHarnessEventSchema.parse({ sequence: this.turn * 10, type: 'item.completed',
        occurredAt: new Date().toISOString(), payload: {
          turnId: id, item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' },
        } })
    }
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.active = { id, correlation: input.clientCorrelationId, release: resolve }
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      // A process shutdown aborts the stream without any native terminal evidence.
      if (signal?.aborted) throw new Error('stream aborted by shutdown')
    }
    this.active = undefined
    history.terminalResult ??= { outcome: 'succeeded', output: { text: 'done' } }
    if (history.nativeSubmission) history.terminalTurn = { correlationId: input.clientCorrelationId,
      providerId: history.nativeSubmission.nativeMessageId, result: history.terminalResult }
  }
  get activeTurn() { return this.active?.id }
  finish(result: ExecutionResult = { outcome: 'succeeded' }) {
    const active = this.active
    if (!active) throw new Error('no active turn')
    this.histories.get(active.correlation)!.terminalResult = result
    active.release()
  }
  async steerTurn(_session: NativeSessionReference, input: NativeSteerInput) {
    if (!this.active || this.active.id !== input.expectedTurnId) throw new NativeTurnNotActiveError()
    this.steers.push(input)
    return { nativeTurnId: this.active.id }
  }
  async cancel() {
    this.cancels++
    if (!this.active) return false
    if (!this.deferCancelTerminal) this.finish({ outcome: 'canceled' })
    return true
  }
  async pending() { return undefined }
  async respond() {}
  async history() { return { events: [], pendingInteractions: [] } }
  async reconcile(_session: NativeSessionReference, correlationId: string) {
    return this.histories.get(correlationId) ?? { events: [], pendingInteractions: [] }
  }
  async close() {}
}

let pool: pg.Pool
let access: PostgresAccessService
let writer: ManagementPrincipal
let readOnlyToken: string
let writerToken: string
let root: string
let fixture: ReturnType<typeof makeCurrentWorkflowFixture>
let codexNode: { id: string; agentId: string }
let claudeNode: { id: string; agentId: string }
let runExecutions: HarnessExecution[] = []
let runState = 'completed'
let runSourceFixture: ReturnType<typeof makeCurrentWorkflowFixture>
const runReads: string[] = []

function makeService(options: { native?: (harness: 'codex' | 'claude') => FakeNative;
  recoverCompaction?: AgentChatManagerFactory['recoverCompaction'] } = {}) {
  const managers = new Map<string, FakeNative>()
  const factory = Object.assign((id: string, configuration: { harness: { harness: 'codex' | 'claude' } }) => {
    const harness = configuration.harness.harness
    const manager = managers.get(id) ?? (options.native ? options.native(harness) : new FakeNative(harness))
    managers.set(id, manager)
    return manager
  }, { release: (id: string) => { managers.delete(id) },
    // Production composes the same input preparation and steering qualification ports.
    prepareInput: prepareAgentChatInput(pool), qualifiedSteer: qualifiedAgentChatSteer,
    ...(options.recoverCompaction ? { recoverCompaction: options.recoverCompaction } : {}) })
  const runs = {
    // Read-only fake Run store for the Run-origin path. The service has no write port to it.
    getForWorkspace: async (_workspaceId: string, runId: string) => {
      runReads.push(runId)
      return { ...runSourceFixture.run, id: runId, executionState: runState, workflowVersionId: runSourceFixture.version.id } as never
    },
    async *executionPages() { yield runExecutions },
    getExecution: async (id: string) => runExecutions.find(execution => execution.id === id),
  }
  const service = new AgentChatService(pool, new PostgresAgentChatRepository(pool), new PostgresOperatorConversationRepository(pool),
    new PostgresWorkflowRepository(pool), runs, factory as never, root)
  return { service, managers }
}

async function settled(service: AgentChatService, state: () => Promise<AgentChatState>, until: (value: AgentChatState) => boolean = (value) =>
  !value.activeTurn && !value.turns.some((turn) => ['queued', 'submitting'].includes(turn.delivery))) {
  void service
  return readUntil(state, until, { timeoutMs: 30_000, description: 'chat settlement' })
}

function request(node: { id: string; agentId: string }, content: string, expectedConversationId: string | null,
  extra: Partial<SendAgentChatMessageRequest> = {}): SendAgentChatMessageRequest {
  return { requestId: randomUUID(), content, intent: 'next_turn', expectedConversationId,
    context: { workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }, ...extra }
}
const query = (node: { id: string; agentId: string }, runId?: string) =>
  ({ workflowId: fixture.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId, ...(runId ? { runId } : {}) })

beforeAll(async () => {
  pool = new pg.Pool({ connectionString, max: 8 })
  await applyApplicationMigrations(pool)
  root = await mkdtemp(join(tmpdir(), 'agent-chat-test-'))
  fixture = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
  fixture.configurations = fixture.configurations.map((configuration, index) => AgentConfigurationVersionSchema.parse({ ...configuration,
    ...(index === 1 ? { harness: { ...claudeConfiguration, model: 'fixture-model' } } : {}),
    prompt: { system: `SYSTEM-${index}` } }))
  fixture = await seedAgent3(pool, root, fixture, { run: false })
  codexNode = fixture.version.definition.nodes[0]!
  claudeNode = fixture.version.definition.nodes[1]!
  access = new PostgresAccessService(pool)
  const issued = await access.issue({ name: 'agent chat writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  writer = issued.principal; writerToken = issued.token
  const ro = await access.issue({ name: 'agent chat reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ManagementActionSchema.options.filter((action) => action.endsWith(':read')), scope: {} }] })
  readOnlyToken = ro.token
})
afterAll(async () => {
  await pool?.end()
  if (root) await removeFixtureDirectory(root)
})
beforeEach(async () => {
  await pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [fixture.scope.workspaceId])
  FakeNative.all = []; runExecutions = []; runState = 'completed'; runSourceFixture = fixture; runReads.length = 0
})

describe('selected-Agent chat service', { timeout: 60_000 }, () => {
  async function settingsTransport(service: AgentChatService) {
    const commands = new PostgresCommandCoordinator(pool)
    const agents = new AgentManagementService(pool)
    const mutations = new OperatorAgentMutationService(pool, commands, {
      qualifyConfiguration: async configuration => ({
        harness: configuration.harness, version: 'fixture', authenticated: true, ready: true,
        structuredEvents: true, supportsResume: true, supportsCancellation: true,
        supportsWorkingDirectory: true, supportsStartupPrompt: true,
        supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [],
      }),
    })
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: service, commands, agents,
        extensions: { agents: mutations } } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'chat-settings', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    return { connect, close: async () => {
      for (const client of clients) await client.close()
      await app.close()
    } }
  }

  it.each(['reconnect', 'restart'] as const)(
    'settles a Run-derived Claude replacement after a lost initial response and %s without resend', async recovery => {
      const seeded = await seedAgent3(pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
      seeded.run = { ...seeded.run, executionState: 'completed', outcome: 'succeeded', finishedAt: seeded.createdAt }
      await pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
        [seeded.run.id, 'completed', JSON.stringify(seeded.run)])
      runSourceFixture = seeded
      const node = seeded.version.definition.nodes[0]!
      const workspaceId = seeded.scope.workspaceId
      const execution: HarnessExecution = { id: randomUUID(), runId: seeded.run.id, workflowNodeId: node.id,
        agentId: node.agentId, agentConfigurationVersionId: seeded.version.agentConfigurationVersionIds[node.agentId]!,
        attempt: 1, nativeSessionId: 'source-native-session', workingDirectory: root, input: {}, state: 'completed',
        result: { outcome: 'succeeded' }, createdAt: seeded.createdAt, finishedAt: seeded.createdAt }
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`,
      [execution.id, execution.runId, node.id, node.agentId, JSON.stringify(execution)])
      runExecutions = [execution]
      const sourceRows = () => pool.query(`select
        (select record from runs where id=$1) as run,
        (select record from harness_executions where id=$2) as execution`, [execution.runId, execution.id])
      const sourceBefore = (await sourceRows()).rows
      const native = new FakeNative('claude')
      let observed: NativeSessionReference | undefined
      let available = false
      let detached = 0
      Object.assign(native, {
        dispose: async () => { detached++ },
        startInitialTurn: async function* (start: NativeSessionStart, input: NativeInitialTurnInput) {
          observed = await native.createSession(start)
          const events = []
          for await (const event of native.startTurn(observed, {
            prompt: input.prompt, clientCorrelationId: input.clientCorrelationId,
          })) events.push(event)
          const history = await native.reconcile(observed, input.clientCorrelationId)
          history.events = [...history.events, ...events]
          yield* []
          throw new Error('The Worker completed the message, but its response was lost.')
        },
        reconcileSessionCreation: async () => {
          if (!available) throw new Error('The Worker is disconnected.')
          return observed!
        },
      })
      const options = { native: (harness: 'codex' | 'claude') => harness === 'claude' ? native : new FakeNative(harness) }
      let { service } = makeService(options)
      let transport = await settingsTransport(service)
      const repository = new PostgresAgentChatRepository(pool)
      const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId,
        runId: execution.runId }
      try {
        let client = await transport.connect(writerToken)
        const firstRequest = { requestId: randomUUID(), context, expectedConversationId: null,
          intent: 'next_turn', content: 'Remember the launch color is amber.' }
        await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: firstRequest } })
        const first = await settled(service, () => service.read(writer, workspaceId, context))
        const id = first.conversation!.id
        const before = ManagedAgentDetailSchema.parse(decodeMcpToolResult(await client.callTool({
          name: 'agent_get', arguments: { workspaceId, agentId: node.agentId },
        })))
        const update = await client.callTool({ name: 'agent_update', arguments: { workspaceId, agentId: node.agentId,
          commandId: randomUUID(), expectedRevision: before.metadataRevision,
          expectedConfigurationVersionId: before.agent.configurationVersionId, configuration: claudeConfiguration } })
        expect(update.isError, JSON.stringify(update)).not.toBe(true)
        const message = { requestId: randomUUID(), context, expectedConversationId: id,
          intent: 'next_turn', content: 'Finish in Claude.' }
        const sent = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: message } })
        expect(sent.isError).not.toBe(true)
        await readUntil(() => repository.turn(id, message.requestId), turn => turn?.delivery === 'unknown',
          { timeoutMs: 30_000, description: 'unconfirmed Claude creation after response loss' })
        expect((await repository.get(id))?.native_session_id).toBeNull()
        expect(native.created).toHaveLength(1)
        expect(native.prompts).toHaveLength(1)
        expect(native.prompts[0]).toContain(firstRequest.content)
        if (recovery === 'restart') {
          await service.shutdown()
          expect(detached).toBe(1)
          await transport.close()
          service = makeService(options).service
          transport = await settingsTransport(service)
          client = await transport.connect(writerToken)
        }
        available = true
        await service.recover()
        const turn = await repository.turn(id, message.requestId)
        expect(turn?.delivery).toBe('completed')
        expect(turn?.nativeSubmission).toMatchObject({ kind: 'message', nativeSessionId: observed!.nativeSessionId,
          clientCorrelationId: agentChatCorrelation(id, message.requestId) })
        const recovered = await service.read(writer, workspaceId, context)
        expect(recovered.conversation).toMatchObject({ id, harness: 'claude', origin: { kind: 'run_execution' },
          nativeSession: { nativeSessionId: observed!.nativeSessionId, providerVersion: observed!.providerVersion } })
        expect(recovered.lastResult?.outcome).toBe('succeeded')
        expect(recovered.messages.filter(message => message.role === 'assistant').at(-1)?.content).toContain('Finish in Claude.')
        const replay = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: message } })
        expect(replay.isError).not.toBe(true)
        expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true })
        expect(native.created).toHaveLength(1)
        expect(native.prompts).toHaveLength(1)
        expect((await sourceRows()).rows).toEqual(sourceBefore)
      } finally { await transport.close(); await service.shutdown() }
    },
  )

  it.each(['resident', 'unloaded'] as const)(
    'recovers dispatched compaction on the applied profile after a settings save with a %s session', async residency => {
      const seeded = await seedAgent3(pool, root,
        makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'), { run: false })
      const node = seeded.version.definition.nodes[0]!
      const workspaceId = seeded.scope.workspaceId
      const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
      const appliedConfiguration = seeded.configurations[0]!
      const native = new FakeNative('codex')
      let finished = false
      let dispatched = 0
      let reconciled = 0
      const recoveredProfiles: string[] = []
      const completion = (state: CompactionState): CompactionState => finished
        ? { ...state, status: 'completed', nativeOperationId: 'original-compaction', observedAt: new Date().toISOString() }
        : state
      Object.assign(native, {
        requiresSettledDisposal: () => true,
        sessionControlCapabilities: async () => ({ ...unavailableSessionControls('fixture'),
          compact: { supported: true, reason: null } }),
        compactSession: async (_session: NativeSessionReference, input: NativeCompactInput) => {
          dispatched++
          expect(input.onDispatch).toBeTypeOf('function')
          await input.onDispatch!()
          throw new Error('The dispatched compaction response was lost.')
        },
        reconcileCompaction: async (_session: NativeSessionReference, state: CompactionState) => {
          reconciled++
          return completion(state)
        },
      })
      const options = { native: () => native,
        recoverCompaction: async (configuration: AgentConfigurationVersion, _id: string,
          session: NativeSessionReference, _start: NativeSessionStart, state: CompactionState) => {
          expect(session.nativeSessionId).toBe(state.nativeSessionId)
          recoveredProfiles.push(configuration.id)
          return completion(state)
        } }
      let { service } = makeService(options)
      let transport = await settingsTransport(service)
      let retired: AgentChatService | undefined
      try {
        let client = await transport.connect(writerToken)
        await service.send(writer, workspaceId, { requestId: randomUUID(), context, expectedConversationId: null,
          intent: 'next_turn', content: 'Initial task.' })
        const first = await settled(service, () => service.read(writer, workspaceId, context))
        const id = first.conversation!.id
        const target = { workspaceId, conversationId: id }
        const controls = AgentChatControlsStateSchema.parse(decodeMcpToolResult(await client.callTool({
          name: 'agent_chat_controls_get', arguments: target,
        })))
        const requestId = randomUUID()
        const compact = await client.callTool({ name: 'agent_chat_controls_update', arguments: { ...target,
          request: { kind: 'compact', requestId, expectedRevision: controls.revision } } })
        expect(compact.isError).not.toBe(true)
        expect(decodeMcpToolResult(compact)).toMatchObject({ compaction: {
          requestId, status: 'uncertain', dispatchPhase: 'dispatched',
        } })
        const before = ManagedAgentDetailSchema.parse(decodeMcpToolResult(await client.callTool({
          name: 'agent_get', arguments: { workspaceId, agentId: node.agentId },
        })))
        const updated = await client.callTool({ name: 'agent_update', arguments: { workspaceId, agentId: node.agentId,
          commandId: randomUUID(), expectedRevision: before.metadataRevision,
          expectedConfigurationVersionId: before.agent.configurationVersionId,
          configuration: { ...appliedConfiguration.harness, model: 'saved-after-compaction' } } })
        expect(updated.isError).not.toBe(true)
        const saved = AgentMutationResultSchema.parse(decodeMcpToolResult(updated))
        const blocked = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
          request: { requestId: randomUUID(), context, expectedConversationId: id,
            intent: 'next_turn', content: 'Blocked while compaction is uncertain.' } } })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('SESSION_COMPACT_UNCONFIRMED')
        expect(native.prompts).toHaveLength(1)
        if (residency === 'unloaded') {
          await expect(service.shutdown()).rejects.toThrow('cleanup was incomplete')
          retired = service
          await transport.close()
          service = makeService(options).service
          transport = await settingsTransport(service)
          client = await transport.connect(writerToken)
        }
        finished = true
        reconciled = 0
        const read = await client.callTool({ name: 'agent_chat_controls_get', arguments: target })
        expect(read.isError, JSON.stringify(read)).not.toBe(true)
        expect(decodeMcpToolResult(read)).toMatchObject({ profileKey: appliedConfiguration.id,
          compaction: { requestId, status: 'completed', nativeSessionId: first.conversation!.nativeSession!.nativeSessionId },
          configuration: { versionId: saved.value.agent.configurationVersionId,
            harness: { model: 'saved-after-compaction' } } })
        expect(dispatched).toBe(1)
        expect(reconciled).toBe(0)
        expect(recoveredProfiles).toEqual([appliedConfiguration.id])
        if (retired) await retired.shutdown()
        const sent = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId,
          request: { requestId: randomUUID(), context, expectedConversationId: id,
            intent: 'next_turn', content: 'Continue after recovered compaction.' } } })
        expect(sent.isError).not.toBe(true)
        const result = await settled(service, () => service.read(writer, workspaceId, context))
        expect(result.conversation).toMatchObject({ id, nativeSession: first.conversation!.nativeSession,
          agentConfigurationVersionId: saved.value.agent.configurationVersionId })
        expect(native.prompts).toEqual(['Initial task.', 'Continue after recovered compaction.'])
        expect(dispatched).toBe(1)
      } finally {
        await transport.close()
        await service.shutdown()
        if (retired) await retired.shutdown()
      }
    },
  )

  it.each(['model and effort', 'account', 'harness'] as const)(
    'applies a saved %s change on the next turn of the same conversation', async change => {
      const seeded = await seedAgent3(pool, root,
        makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'), { run: false })
      const node = seeded.version.definition.nodes[0]!
      const workspaceId = seeded.scope.workspaceId
      const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
      const { service } = makeService()
      const transport = await settingsTransport(service)
      try {
        const client = await transport.connect(writerToken)
        const read = () => service.read(writer, workspaceId, context)
        const send = async (content: string, conversationId: string | null) => {
          await service.send(writer, workspaceId, { requestId: randomUUID(), context,
            expectedConversationId: conversationId, intent: 'next_turn', content })
          return settled(service, read)
        }
        const first = await send('Remember the launch color is amber', null)
        const conversation = first.conversation!
        const get = await client.callTool({ name: 'agent_get', arguments: { workspaceId, agentId: node.agentId } })
        const before = ManagedAgentDetailSchema.parse(decodeMcpToolResult(get))
        const configuration = change === 'harness' ? claudeConfiguration
          : { ...seeded.configurations[0]!.harness, model: 'changed-model', reasoningEffort: 'high',
            ...(change === 'account' ? { accountId: randomUUID() } : {}) }
        const result = await client.callTool({ name: 'agent_update', arguments: {
          workspaceId, agentId: node.agentId, commandId: randomUUID(), expectedRevision: before.metadataRevision,
          expectedConfigurationVersionId: before.agent.configurationVersionId, configuration,
        } })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        const saved = AgentMutationResultSchema.parse(decodeMcpToolResult(result))
        const second = await send('What is the launch color?', conversation.id)
        expect(second.conversation!.id).toBe(conversation.id)
        expect(second.turns.at(-1)?.delivery).toBe('completed')
        expect(second.conversation!.agentConfigurationVersionId).toBe(saved.value.agent.configurationVersionId)
        const native = FakeNative.all.at(-1)!
        if (change === 'model and effort') {
          expect(second.conversation!.nativeSession!.nativeSessionId).toBe(conversation.nativeSession!.nativeSessionId)
          expect(native.attached).toHaveLength(1)
          expect(sessionStartConfiguration(native.attached[0]!).harness).toMatchObject(configuration)
        } else {
          expect(second.conversation!.nativeSession!.nativeSessionId).not.toBe(conversation.nativeSession!.nativeSessionId)
          expect(native.created).toHaveLength(1)
          expect(sessionStartConfiguration(native.created[0]!).harness).toMatchObject(configuration)
          expect(native.prompts[0]).toContain('Remember the launch color is amber')
          expect(native.prompts[0]).toContain(first.messages.find(message => message.role === 'assistant')!.content)
          expect(native.prompts[0]).toContain('What is the launch color?')
        }
        expect(second.messages.filter(message => message.role === 'user').map(message => message.content))
          .toEqual(['Remember the launch color is amber', 'What is the launch color?'])
      } finally { await transport.close(); await service.shutdown() }
    },
  )

  it('updates and reads back Agent configuration through authenticated chat controls and denies a reader', async () => {
    const seeded = await seedAgent3(pool, root,
      makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'), { run: false })
    const node = seeded.version.definition.nodes[0]!
    const workspaceId = seeded.scope.workspaceId
    const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const { service } = makeService()
    const transport = await settingsTransport(service)
    try {
      const client = await transport.connect(writerToken)
      const reader = await transport.connect(readOnlyToken)
      const target = { workspaceId, context }
      const get = await client.callTool({ name: 'agent_get', arguments: { workspaceId, agentId: node.agentId } })
      const before = ManagedAgentDetailSchema.parse(decodeMcpToolResult(get))
      const configuration = { ...seeded.configurations[0]!.harness, model: 'chat-selected-model', reasoningEffort: 'high' }
      const control = { ...target, request: { kind: 'configuration', requestId: randomUUID(),
        expectedRevision: before.metadataRevision, expectedConfigurationVersionId: before.agent.configurationVersionId,
        configuration } }
      await expectMcpAccessDenied(reader.callTool({ name: 'agent_chat_controls_update', arguments: control }))
      const saved = await client.callTool({ name: 'agent_chat_controls_update', arguments: control })
      expect(saved.isError).not.toBe(true)
      const replay = await client.callTool({ name: 'agent_chat_controls_update', arguments: control })
      expect(replay.isError).not.toBe(true)
      const persisted = await client.callTool({ name: 'agent_chat_controls_get', arguments: target })
      expect(decodeMcpToolResult(persisted)).toMatchObject({ configuration: {
        harness: configuration, metadataRevision: before.metadataRevision + 1,
      } })
      const agent = ManagedAgentDetailSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'agent_get', arguments: { workspaceId, agentId: node.agentId },
      })))
      expect(agent.agent.harnessConfiguration).toMatchObject(configuration)
      expect(agent.metadataRevision).toBe(before.metadataRevision + 1)
      await expectMcpAccessDenied(reader.callTool({ name: 'agent_chat_controls_update', arguments: {
        ...control, request: { ...control.request, requestId: randomUUID(),
          expectedRevision: agent.metadataRevision, expectedConfigurationVersionId: agent.agent.configurationVersionId,
          configuration: { ...configuration, model: 'denied-model' } },
      } }))
      expect(decodeMcpToolResult(await client.callTool({ name: 'agent_chat_controls_get', arguments: target })))
        .toMatchObject({ configuration: { harness: configuration, metadataRevision: agent.metadataRevision } })
    } finally { await transport.close(); await service.shutdown() }
  })

  it('binds an authenticated reader before checking a completed native session through HTTP and MCP', async () => {
    const { service } = makeService()
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: service,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'completed-chat-reader', version: '1' })
    try {
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'Complete one native turn', null))
      const done = await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const reader = await access.authenticate(readOnlyToken)
      let caller: string | undefined
      const pending = vi.fn(async () => {
        if (caller !== reader.id) throw new HarnessExecutionError('WORKER_CONVERSATION_UNAVAILABLE',
          'The original conversation caller changed.')
        return undefined
      })
      const native = FakeNative.all[0]!
      Object.assign(native, { pending, setSessionControlPrincipal: (id: string) => { caller = id } })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const url = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat?${new URLSearchParams(query(codexNode))}`
      const http = await app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(http.statusCode).toBe(200)
      expect(AgentChatStateSchema.parse(http.json()).messages).toEqual(done.messages)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => readOnlyToken } }))
      const target = { workspaceId: fixture.scope.workspaceId, query: query(codexNode) }
      const mcp = await client.callTool({ name: 'agent_chat_read', arguments: target })
      expect(mcp.isError).not.toBe(true)
      expect(AgentChatStateSchema.parse(decodeMcpToolResult(mcp)).messages).toEqual(done.messages)
      expect(pending).toHaveBeenCalledTimes(2)
      await expectMcpAccessDenied(client.callTool({ name: 'agent_chat_send', arguments: {
        workspaceId: fixture.scope.workspaceId,
        request: request(codexNode, 'The reader must not send', done.conversation!.id),
      } }))
      const denied = await access.issue({ name: 'denied completed-chat reader', audience: 'operator', grants: [],
        expiresAt: new Date(Date.now() + 600_000) })
      expect((await app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      expect(pending).toHaveBeenCalledTimes(2)
      expect(native.prompts).toHaveLength(1)
      const persisted = await new PostgresAgentChatRepository(pool).get(done.conversation!.id)
      expect(persisted?.native_session_id).toBe(done.conversation?.nativeSession?.nativeSessionId)
    } finally {
      await client.close()
      await app.close()
      await service.shutdown()
    }
  })

  it.each(['NATIVE_MANAGER_DISPOSED', 'WORKER_CONVERSATION_CALLBACK_DENIED'] as const)(
    'reads saved Agent controls when a retiring pending-interaction read fails with %s', async code => {
    const { service } = makeService()
    const workspaceId = fixture.scope.workspaceId
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: service,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'retiring-chat-reader', version: '1' })
    const deniedClient = new Client({ name: 'denied-retiring-chat-reader', version: '1' })
    let finishCleanup!: () => void
    let releasePendingRead = () => {}
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    try {
      await service.send(writer, workspaceId, request(codexNode, 'Complete a native turn', null))
      const done = await settled(service, () => service.read(writer, workspaceId, query(codexNode)))
      const conversationId = done.conversation!.id
      const native = FakeNative.all[0]!
      const capabilities = { ...unavailableSessionControls('fixture'), model: 'fixture-model',
        plan: { supported: true, reason: null } }
      Object.assign(native, { sessionControlCapabilities: async () => capabilities })
      const discovered = await service.readSessionControls(writer, workspaceId, conversationId)
      const saved = await service.changeSessionControls(writer, workspaceId, conversationId, {
        kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: discovered.revision,
      })
      let pendingStarted!: () => void
      const pendingRead = new Promise<void>(resolve => { pendingStarted = resolve })
      let ownerRetired!: () => void
      const retirement = new Promise<void>(resolve => { ownerRetired = resolve; releasePendingRead = resolve })
      let firstPending = true
      let disposed = false
      const disposedError = new DomainError(code, 'The native allocation is disposed.', 409)
      const pending = vi.fn(async () => {
        if (firstPending) {
          firstPending = false
          pendingStarted()
          await retirement
          throw disposedError
        }
        if (disposed) throw disposedError
        return undefined
      })
      Object.assign(native, { pending, dispose: async () => {
        disposed = true
        ownerRetired()
        await cleanup
      } })
      vi.spyOn(native, 'startTurn').mockImplementation(async function* () {
        await Promise.reject(new NativeDeliveryError('turn_submission', 'not_sent', new Error('Native submission rejected')))
        yield* []
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const url = `/api/workspaces/${workspaceId}/agent-chat/conversations/${conversationId}/session-controls`
      const httpRead = app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${readOnlyToken}` } }).then(response => response)
      await pendingRead
      await service.send(writer, workspaceId, request(codexNode, 'Rejected before native submission', conversationId))
      const http = await httpRead
      expect(http.statusCode).toBe(200)
      expect(SessionControlStateSchema.parse(http.json())).toMatchObject({ desiredMode: 'plan',
        revision: saved.revision, capabilities, nativeSessionId: saved.nativeSessionId, nativeStatus: 'resume-required' })
      const callsAfterRetirement = pending.mock.calls.length
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => readOnlyToken } }))
      const target = { workspaceId, conversationId }
      const mcp = await client.callTool({ name: 'agent_chat_controls_get', arguments: target })
      expect(mcp.isError).not.toBe(true)
      expect(SessionControlStateSchema.parse(decodeMcpToolResult(mcp))).toMatchObject({ desiredMode: 'plan',
        capabilities, nativeSessionId: saved.nativeSessionId, nativeStatus: 'resume-required' })
      const denied = await access.issue({ name: 'denied retiring-chat reader', audience: 'operator', grants: [],
        expiresAt: new Date(Date.now() + 600000) })
      expect((await app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => denied.token } }))
      await expectMcpAccessDenied(deniedClient.callTool({ name: 'agent_chat_controls_get', arguments: target }))
      expect(pending).toHaveBeenCalledTimes(callsAfterRetirement)
      const persisted = await pool.query<{ record: unknown }>(
        'select record from conversation_session_controls where conversation_id=$1', [conversationId])
      expect(SessionControlStateSchema.parse(persisted.rows[0]!.record)).toMatchObject({ desiredMode: 'plan', capabilities })
      expect(native.prompts).toHaveLength(1)
      expect(native.created).toHaveLength(1)
    } finally {
      releasePendingRead()
      finishCleanup()
      await Promise.all([client.close(), deniedClient.close()])
      await app.close()
      await service.shutdown()
    }
  })

  it('preserves a live Worker callback denial during the pending-interaction read', async () => {
    const { service } = makeService()
    const workspaceId = fixture.scope.workspaceId
    try {
      await service.send(writer, workspaceId, request(codexNode, 'Complete a native turn', null))
      await settled(service, () => service.read(writer, workspaceId, query(codexNode)))
      const denial = new DomainError('WORKER_CONVERSATION_CALLBACK_DENIED', 'The live callback was denied.', 403)
      Object.assign(FakeNative.all[0]!, { pending: async () => { throw denial } })
      await expect(service.read(writer, workspaceId, query(codexNode))).rejects.toMatchObject({
        code: 'WORKER_CONVERSATION_CALLBACK_DENIED', message: 'The live callback was denied.', status: 403,
      })
    } finally { await service.shutdown() }
  })

  it.each(['codex', 'claude'] as const)('reads saved %s Agent controls through HTTP and MCP after unload and restart', async harness => {
    const configuration = harness === 'claude' ? {
      harness: 'claude' as const, model: 'fixture-model', authMode: 'subscription' as const,
      configDirectory: '/fixture/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
      tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } : fixture.configurations.find(value => value.harness.harness === harness)!.harness
    const controlFixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    controlFixture.configurations = controlFixture.configurations.map(value =>
      AgentConfigurationVersionSchema.parse({ ...value, harness: configuration }))
    const seeded = await seedAgent3(pool, root, controlFixture, { run: false })
    let { service } = makeService()
    const node = seeded.version.definition.nodes[0]!
    const workspaceId = seeded.scope.workspaceId
    const selector = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    await service.send(writer, workspaceId, { requestId: randomUUID(), content: 'Complete a native turn',
      intent: 'next_turn', expectedConversationId: null, context: selector })
    const done = await settled(service, () => service.read(writer, workspaceId, selector))
    const conversationId = done.conversation!.id
    const native = FakeNative.all[0]!
    let unloaded = false
    const capabilities = { ...unavailableSessionControls('fixture'), model: 'fixture-model',
      plan: { supported: true, reason: null }, compact: { supported: true, reason: null } }
    const nativeCapabilities = vi.fn(async () => {
      const code = { codex: 'CODEX_SESSION_UNAVAILABLE', claude: 'CLAUDE_SESSION_UNAVAILABLE' }[harness]
      if (unloaded) throw new HarnessExecutionError(code, 'Native runtime unloaded')
      return capabilities
    })
    Object.assign(native, { sessionControlCapabilities: nativeCapabilities,
      contextSnapshot: (session: NativeSessionReference) => ({
        nativeSessionId: session.nativeSessionId, model: 'fixture-model', generation: 'connection', sequence: 1,
        source: harness, accuracy: 'native', usedTokens: 100, capacityTokens: 200000, lifetimeTokens: 100,
        cost: null, observedAt: new Date().toISOString(), stale: false,
      }) })
    const discovered = await service.readSessionControls(writer, workspaceId, conversationId)
    const saved = await service.changeSessionControls(writer, workspaceId, conversationId, {
      kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: discovered.revision,
    })
    const denied = await access.issue({ name: 'denied Agent control reader', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600000) })
    unloaded = true

    async function checkReads() {
      const services = {
        agentChat: service, commands: new PostgresCommandCoordinator(pool),
      } as unknown as OperatorServices
      const app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      const client = new Client({ name: 'saved-Agent-controls-reader', version: '1' })
      const deniedClient = new Client({ name: 'denied-saved-Agent-controls-reader', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const url = `/api/workspaces/${workspaceId}/agent-chat/conversations/${conversationId}/session-controls`
        const http = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${writerToken}` } })
        expect(http.statusCode).toBe(200)
        expect(SessionControlStateSchema.parse(http.json())).toMatchObject({ desiredMode: 'plan',
          revision: saved.revision, capabilities, nativeStatus: 'resume-required',
          nativeSessionId: saved.nativeSessionId, context: { usedTokens: 100, stale: true } })
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => writerToken } }))
        const target = { workspaceId, conversationId }
        const mcp = await client.callTool({ name: 'agent_chat_controls_get', arguments: target })
        expect(mcp.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(mcp))).toEqual(SessionControlStateSchema.parse(http.json()))
        const context = await client.callTool({ name: 'agent_chat_controls_get',
          arguments: { workspaceId, context: selector } })
        expect(context.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(context)).desiredMode).toBe('plan')
        expect((await app.inject({ method: 'GET', url,
          headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
        await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => denied.token } }))
        await expectMcpAccessDenied(deniedClient.callTool({ name: 'agent_chat_controls_get', arguments: target }))
        expect((await service.read(writer, workspaceId, selector)).messages).toEqual(done.messages)
        const persisted = await pool.query<{ record: unknown }>(
          'select record from conversation_session_controls where conversation_id=$1', [conversationId])
        expect(SessionControlStateSchema.parse(persisted.rows[0]!.record)).toMatchObject({ desiredMode: 'plan', capabilities })
      } finally {
        await client.close()
        await deniedClient.close()
        await app.close()
      }
    }

    try {
      await checkReads()
      await service.shutdown()
      service = makeService().service
      const nativeReads = nativeCapabilities.mock.calls.length
      await checkReads()
      expect(nativeCapabilities).toHaveBeenCalledTimes(nativeReads)
      expect(native.prompts).toHaveLength(1)
      expect(FakeNative.all).toHaveLength(1)
    } finally {
      await service.shutdown()
    }
  })

  it('keeps later accepted-turn reconciliation idempotent while preserving the initial startup receipt', async () => {
    const { service } = makeService()
    const first = request(codexNode, 'first', null)
    const initial = await service.send(writer, fixture.scope.workspaceId, first)
    const id = initial.state.conversation!.id
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    try {
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later', id))
      const active = await settled(service, read, state => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
      const repository = new PostgresAgentChatRepository(pool)
      const before = (await repository.get(id))!
      expect(before.record.startupReceipt).toEqual({ requestId: first.requestId, nativeSessionId: before.native_session_id })
      expect(active.activeTurn!.requestId).not.toBe(first.requestId)
      for (let observation = 0; observation < 2; observation++) {
        expect(await repository.accepted(id, active.activeTurn!.requestId, active.activeTurn!.nativeTurnId!)).toBe(false)
      }
      const after = (await repository.get(id))!
      expect(after.revision).toBe(before.revision)
      expect(after.updated_at).toEqual(before.updated_at)
      expect(after.record.startupReceipt).toEqual(before.record.startupReceipt)
      expect((await repository.turn(id, active.activeTurn!.requestId))?.delivery).toBe('accepted')
      expect(native.prompts).toHaveLength(2)
    } finally {
      if (native.activeTurn) native.finish({ outcome: 'canceled' })
      await service.shutdown()
    }
  })

  it('admits a saved node directory through authenticated MCP and retains it before the first message', async () => {
    const nativeFixture = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'single')
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    const deviceId = randomUUID()
    const installationId = randomUUID()
    const instanceId = randomUUID()
    const baseId = randomUUID()
    const rootPolicyId = randomUUID()
    const hostRef = { kind: 'device' as const, mainId, deviceId }
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    const configuration = AgentConfigurationVersionSchema.parse({ ...nativeFixture.configurations[0]!,
      harnessProfileSelection: { instanceId, instanceRevision: '1', target: { hostRef,
        applicationInstallationId: installationId, harnessInstallationId: 'recorded-installation', installationFingerprint: 'recorded-bytes' } } })
    nativeFixture.configurations = [configuration]
    const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef,
      rootPolicyId, rootPolicyRevision: '1', locationRevision: '1', projectRoot: '/worker/saved-project',
      cwdPolicy: 'project-subdirectory', relativeCwd: 'src', instanceId, instanceRevision: '1',
      harnessInstallationId: 'recorded-installation' })
    nativeFixture.version.definition.nodes[0]!.placement = placement
    const seeded = await seedAgent3(pool, root, nativeFixture, { run: false })
    const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef,
      applicationInstallationId: installationId, configurationRevision: '1',
      bases: [{ baseId, canonicalPath: '/worker', filesystem, accessModes: ['read-only'] }],
      managedRuntimeRoot: '/worker/runtime', runtimeFilesystem: filesystem })
    const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId, rootPolicyRevision: '1',
      workspaceId: seeded.scope.workspaceId, hostRef, applicationInstallationId: installationId,
      registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 },
      locationRevision: '1', ownerPrincipalId: writer.id, allowedBaseId: baseId, configurationRevision: '1',
      relativePath: 'saved-project', accessMode: 'read-only', canonicalProjectRoot: placement.projectRoot,
      filesystem, directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot: approved.managedRuntimeRoot,
      runtimeFilesystem: filesystem, attestationId: randomUUID(), attestationDigest: 'b'.repeat(64) })
    const hostScope = workspaceRootHostScope(hostRef)
    await pool.query(`insert into workspace_root_host_configurations
      (host_scope,configuration_revision,main_id,application_installation_id,record,digest) values($1,1,$2,$3,$4::jsonb,$5)`,
    [hostScope, mainId, installationId, JSON.stringify(approved), 'recorded-root-digest'])
    await pool.query('insert into workspace_root_host_configuration_heads(host_scope,configuration_revision) values($1,1)', [hostScope])
    await pool.query(`insert into workspace_root_policies
      (root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record) values($1,1,$2,$3,1,$4::jsonb)`,
    [rootPolicyId, seeded.scope.workspaceId, hostScope, JSON.stringify(policy)])
    const { service } = makeService()
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'node-directory-writer', version: '1' })
    const reader = new Client({ name: 'node-directory-reader', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => writerToken } }))
      await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => readOnlyToken } }))
      const node = seeded.version.definition.nodes[0]!
      const context = { workflowId: seeded.scope.workflowId,
        workflowNodeId: node.id, agentId: configuration.agentId }
      const target = { workspaceId: seeded.scope.workspaceId, context }
      const control = { ...target, request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: 0 } }
      const updated = await client.callTool({ name: 'agent_chat_controls_update', arguments: control })
      expect(updated.isError).not.toBe(true)
      const controls = SessionControlStateSchema.parse(decodeMcpToolResult(updated))
      expect(controls.conversationId).toBeTruthy()
      expect(controls.nativeSessionId).toBeNull()
      expect(FakeNative.all).toHaveLength(0)
      const row = await new PostgresAgentChatRepository(pool).get(controls.conversationId!)
      expect(row?.record).toMatchObject({ workingDirectory: '/worker/saved-project/src',
        directoryBinding: { workflowVersionId: seeded.version.id, placement, policy } })
      const denied = await reader.callTool({ name: 'agent_chat_controls_update', arguments: {
        ...control, request: { ...control.request, requestId: randomUUID(), mode: 'regular', expectedRevision: controls.revision } } })
      expect(denied.isError).toBe(true)
      const persisted = SessionControlStateSchema.parse(decodeMcpToolResult((await reader.callTool({
        name: 'agent_chat_controls_get', arguments: target }))))
      expect(persisted.desiredMode).toBe('plan')
      expect(persisted.conversationId).toBe(controls.conversationId)
    } finally {
      await Promise.all([client.close(), reader.close()])
      await app.close()
      await service.shutdown()
    }
  })
  it('opens a fresh chat for an unplaced node on its Agent’s paired computer instead of Main’s workspace folder', async () => {
    const nativeFixture = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'single')
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    const installationId = randomUUID()
    const instanceId = randomUUID()
    const baseId = randomUUID()
    const rootPolicyId = randomUUID()
    const hostRef = { kind: 'device' as const, mainId, deviceId: randomUUID() }
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    const configuration = AgentConfigurationVersionSchema.parse({ ...nativeFixture.configurations[0]!,
      harnessProfileSelection: { instanceId, instanceRevision: '1', target: { hostRef,
        applicationInstallationId: installationId, harnessInstallationId: 'recorded-installation', installationFingerprint: 'recorded-bytes' } } })
    nativeFixture.configurations = [configuration]
    expect(nativeFixture.version.definition.nodes[0]!.placement).toBeUndefined()
    const seeded = await seedAgent3(pool, root, nativeFixture, { run: false })
    const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef,
      applicationInstallationId: installationId, configurationRevision: '1',
      bases: [{ baseId, canonicalPath: '/worker', filesystem, accessModes: ['read-only'] }],
      managedRuntimeRoot: '/worker/runtime', runtimeFilesystem: filesystem })
    const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId, rootPolicyRevision: '1',
      workspaceId: seeded.scope.workspaceId, hostRef, applicationInstallationId: installationId,
      registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 },
      locationRevision: '1', ownerPrincipalId: writer.id, allowedBaseId: baseId, configurationRevision: '1',
      relativePath: 'device-project', accessMode: 'read-only', canonicalProjectRoot: '/worker/device-project',
      filesystem, directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot: approved.managedRuntimeRoot,
      runtimeFilesystem: filesystem, attestationId: randomUUID(), attestationDigest: 'b'.repeat(64) })
    const hostScope = workspaceRootHostScope(hostRef)
    await pool.query(`insert into workspace_root_host_configurations
      (host_scope,configuration_revision,main_id,application_installation_id,record,digest) values($1,1,$2,$3,$4::jsonb,$5)`,
    [hostScope, mainId, installationId, JSON.stringify(approved), 'recorded-root-digest'])
    await pool.query('insert into workspace_root_host_configuration_heads(host_scope,configuration_revision) values($1,1)', [hostScope])
    await pool.query(`insert into workspace_root_policies
      (root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record) values($1,1,$2,$3,1,$4::jsonb)`,
    [rootPolicyId, seeded.scope.workspaceId, hostScope, JSON.stringify(policy)])
    await pool.query(`insert into workspace_root_policy_heads(workspace_id,host_scope,root_policy_id,root_policy_revision)
      values($1,$2,$3,1)`, [seeded.scope.workspaceId, hostScope, rootPolicyId])
    const { service } = makeService()
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'device-node-writer', version: '1' })
    const reader = new Client({ name: 'device-node-reader', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => writerToken } }))
      await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => readOnlyToken } }))
      const node = seeded.version.definition.nodes[0]!
      const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: configuration.agentId }
      const target = { workspaceId: seeded.scope.workspaceId, context }
      const opened = decodeMcpToolResult(await client.callTool({ name: 'agent_chat_read',
        arguments: { workspaceId: seeded.scope.workspaceId, query: context } })) as { availability: { canSend: boolean; message?: string } }
      expect(opened.availability).toMatchObject({ canSend: true })
      expect(opened.availability.message ?? '').not.toContain('another execution host')
      const control = { ...target, request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: 0 } }
      const denied = await reader.callTool({ name: 'agent_chat_controls_update', arguments: control })
      expect(denied.isError).toBe(true)
      const updated = await client.callTool({ name: 'agent_chat_controls_update', arguments: control })
      expect(updated.isError).not.toBe(true)
      const controls = SessionControlStateSchema.parse(decodeMcpToolResult(updated))
      expect(controls.conversationId).toBeTruthy()
      expect(FakeNative.all).toHaveLength(0)
      const row = await new PostgresAgentChatRepository(pool).get(controls.conversationId!)
      expect(row?.record).toMatchObject({ workingDirectory: '/worker/device-project',
        directoryBinding: { workflowVersionId: seeded.version.id, policy, placement: { hostRef, rootPolicyId,
          projectRoot: '/worker/device-project', cwdPolicy: 'project-root', relativeCwd: '', instanceId } } })
      const persisted = SessionControlStateSchema.parse(decodeMcpToolResult(await reader.callTool({
        name: 'agent_chat_controls_get', arguments: target })))
      expect(persisted.conversationId).toBe(controls.conversationId)
      expect(persisted.desiredMode).toBe('plan')
    } finally {
      await Promise.all([client.close(), reader.close()])
      await app.close()
      await service.shutdown()
    }
  })

  it('creates only an application conversation for fresh control admission and applies Plan on the first message', async () => {
    const { service } = makeService()
    const context = { workspaceId: fixture.scope.workspaceId, ...query(codexNode) }
    try {
      const preview = await service.readContextControls(writer, context)
      expect(preview.conversationId).toBeNull()
      expect(FakeNative.all).toHaveLength(0)
      const admitted = await service.changeContextControls(writer, context,
        { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: 0 })
      expect(admitted.conversationId).toBeTruthy()
      expect(admitted.nativeSessionId).toBeNull()
      expect(FakeNative.all).toHaveLength(0)
      const state = await service.read(writer, context.workspaceId, query(codexNode))
      expect(state.messages).toHaveLength(0)
      expect(state.turns).toHaveLength(0)
      const noop = await service.changeContextControls(writer, context,
        { kind: 'compact', requestId: randomUUID(), expectedRevision: admitted.revision })
      expect(noop.compaction?.status).toBe('no-op')
      await service.send(writer, context.workspaceId, request(codexNode, 'First planned task', state.conversation!.id))
      await settled(service, () => service.read(writer, context.workspaceId, query(codexNode)))
      expect(FakeNative.all[0]!.modes).toEqual(['plan'])
      expect(FakeNative.all[0]!.prompts).toEqual(['First planned task'])
    } finally { await service.shutdown() }
  })

  it('creates the stored conversation for a first attachment without a native session and refuses a read-only caller', async () => {
    const { service } = makeService()
    const workspaceId = fixture.scope.workspaceId
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const url = `/api/workspaces/${workspaceId}/agent-chat/conversation`
    const post = (token: string) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` },
      payload: { context: query(codexNode) } })
    try {
      expect((await post(readOnlyToken)).statusCode).toBe(403)
      expect((await service.read(writer, workspaceId, query(codexNode))).conversation).toBeNull()
      const created = await post(writerToken)
      expect(created.statusCode).toBe(200)
      const state = AgentChatStateSchema.parse(created.json().state)
      expect(state.conversation).toMatchObject({ workspaceId, agentId: codexNode.agentId, workflowNodeId: codexNode.id, nativeSession: null })
      expect(FakeNative.all).toHaveLength(0)
      expect(AgentChatStateSchema.parse((await post(writerToken)).json().state).conversation?.id).toBe(state.conversation!.id)
      expect((await service.read(writer, workspaceId, query(codexNode))).conversation?.id).toBe(state.conversation!.id)
      await service.send(writer, workspaceId, request(codexNode, 'First message after the attachment', state.conversation!.id))
      await settled(service, () => service.read(writer, workspaceId, query(codexNode)))
      expect(FakeNative.all[0]!.prompts).toEqual(['First message after the attachment'])
    } finally { await app.close(); await service.shutdown() }
  })

  it('isolates native controls for two nodes using the same Agent and enforces authenticated MCP grants', async () => {
    const twin = makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential')
    const firstNode = twin.version.definition.nodes[0]!
    const secondNode = twin.version.definition.nodes[1]!
    secondNode.agentId = firstNode.agentId
    twin.configurations = twin.configurations.filter(configuration => configuration.agentId === firstNode.agentId)
    twin.version.agentConfigurationVersionIds = { [firstNode.agentId]: twin.configurations[0]!.id }
    const seeded = await seedAgent3(pool, root, twin, { run: false })
    const { service, managers } = makeService()
    const context = (nodeId: string) => ({ workflowId: seeded.scope.workflowId, workflowNodeId: nodeId, agentId: firstNode.agentId })
    const read = (nodeId: string) => service.read(writer, seeded.scope.workspaceId, context(nodeId))
    try {
      for (const node of [firstNode, secondNode]) {
        await service.send(writer, seeded.scope.workspaceId, { requestId: randomUUID(), content: 'Seed this node',
          context: context(node.id), expectedConversationId: null, intent: 'next_turn' })
        await settled(service, () => read(node.id))
      }
      const first = (await read(firstNode.id)).conversation!
      const second = (await read(secondNode.id)).conversation!
      expect(first.id).not.toBe(second.id)
      expect(first.nativeSession!.nativeSessionId).not.toBe(second.nativeSession!.nativeSessionId)
      for (const manager of managers.values()) Object.assign(manager, { async sessionControlCapabilities() {
        return { ...unavailableSessionControls('fixture'), plan: { supported: true, reason: null } }
      } })
      const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
      const client = new Client({ name: 'node-session-controls', version: '1' })
      const reader = new Client({ name: 'node-session-controls-reader', version: '1' })
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => writerToken } }))
        await reader.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => readOnlyToken } }))
        const target = { workspaceId: seeded.scope.workspaceId, conversationId: first.id }
        const before = SessionControlStateSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_chat_controls_get', arguments: target }))))
        const result = await client.callTool({ name: 'agent_chat_controls_update', arguments: { ...target,
          request: { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: before.revision } } })
        expect(result.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(result)).desiredMode).toBe('plan')
        expect((await service.readSessionControls(writer, seeded.scope.workspaceId, second.id)).desiredMode).toBe('regular')
        const denied = await app.inject({ method: 'POST',
          url: `/api/workspaces/${seeded.scope.workspaceId}/agent-chat/conversations/${first.id}/session-controls`,
          headers: { authorization: `Bearer ${readOnlyToken}` },
          payload: { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: before.revision + 1 } })
        expect(denied.statusCode).toBe(403)
        const refusal = await reader.callTool({ name: 'agent_chat_controls_update', arguments: { ...target,
          request: { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: before.revision + 1 } } })
        expect(refusal.isError).toBe(true)
        expect((await service.readSessionControls(writer, seeded.scope.workspaceId, first.id)).desiredMode).toBe('plan')
      } finally { await client.close(); await reader.close(); await app.close() }
    } finally { await service.shutdown() }
  })

  it('creates exactly one native session on first send and continues it after completion', async () => {
    const { service } = makeService()
    const empty = await service.read(writer, fixture.scope.workspaceId, query(codexNode))
    expect(empty).toMatchObject({ conversation: null, sessionState: 'none', availability: { canSend: true } })
    const first = request(codexNode, 'hello', null)
    const [a, b] = await Promise.all([service.send(writer, fixture.scope.workspaceId, first), service.send(writer, fixture.scope.workspaceId, first)])
    expect([a.replayed, b.replayed].sort()).toEqual([false, true])
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    const done = await settled(service, read)
    const native = FakeNative.all[0]!
    expect(FakeNative.all).toHaveLength(1)
    expect(native.created).toHaveLength(1)
    expect(done.turns.map((turn) => turn.delivery)).toEqual(['completed'])
    expect(done.conversation?.nativeSession?.nativeSessionId).toMatch(/^native-/)
    // Startup system prompt is native developer instructions for Codex, never repeated in the user prompt.
    expect(native.created[0]).toMatchObject({ instructionsDelivered: false })
    expect(native.prompts[0]).toBe('hello')
    await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'again', done.conversation!.id))
    const second = await settled(service, read)
    expect(native.created).toHaveLength(1)
    expect(second.turns.map((turn) => turn.delivery)).toEqual(['completed', 'completed'])
    expect(second.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(AgentChatStateSchema.parse(second).conversation?.id).toBe(done.conversation!.id)
  })

  it('queues next turns FIFO, cancels a queued turn and runs interrupt-and-send once ahead of the queue', async () => {
    const { service } = makeService()
    const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    const workspace = fixture.scope.workspaceId
    const first = await service.send(writer, workspace, request(codexNode, 'long', null))
    const conversationId = first.state.conversation!.id
    await settled(service, read, (value) => value.turns[0]?.delivery === 'completed')
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, workspace, request(codexNode, 'hold me', conversationId))
    await settled(service, read, (value) => Boolean(value.activeTurn?.nativeTurnId)
      && native.activeTurn === value.activeTurn?.nativeTurnId && value.activeTurn?.requestId !== first.turn.requestId)
    const queuedA = await service.send(writer, workspace, request(codexNode, 'queued A', conversationId))
    const queuedB = await service.send(writer, workspace, request(codexNode, 'queued B', conversationId))
    expect(queuedA.turn.delivery).toBe('queued')
    await service.cancelQueued(writer, workspace, conversationId, queuedB.turn.requestId, { requestId: randomUUID() })
    native.hold = false
    const urgent = await service.send(writer, workspace, request(codexNode, 'urgent', conversationId, { intent: 'interrupt_and_send' }))
    const done = await settled(service, read)
    const byId = new Map(done.turns.map((turn) => [turn.requestId, turn.delivery]))
    expect(byId.get(queuedB.turn.requestId)).toBe('canceled')
    expect(byId.get(urgent.turn.requestId)).toBe('completed')
    expect(byId.get(queuedA.turn.requestId)).toBe('completed')
    expect(native.cancels).toBe(1)
    // The interrupted turn is never replayed and urgent input is submitted exactly once, before queued A.
    expect(native.prompts).toEqual(['long', 'hold me', 'urgent', 'queued A'])
    expect(done.turns.find((turn) => turn.intent === 'next_turn' && turn.delivery === 'canceled' && turn.nativeTurnId)).toBeDefined()
  })

  it('steers only the exact active Codex turn and leaves no receipt for a rejected steer', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    const read = () => service.read(writer, workspace, query(codexNode))
    const first = await service.send(writer, workspace, request(codexNode, 'warm', null))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, workspace, request(codexNode, 'work', first.state.conversation!.id))
    const active = await settled(service, read, (value) => Boolean(value.activeTurn?.nativeTurnId) && native.activeTurn === value.activeTurn?.nativeTurnId)
    const steer = await service.send(writer, workspace, request(codexNode, 'focus', active.conversation!.id,
      { intent: 'steer', expectedNativeTurnId: active.activeTurn!.nativeTurnId! }))
    expect(steer.turn).toMatchObject({ intent: 'steer', delivery: 'accepted', targetNativeTurnId: active.activeTurn!.nativeTurnId })
    await expect(service.send(writer, workspace, request(codexNode, 'stale', active.conversation!.id,
      { intent: 'steer', expectedNativeTurnId: 'turn-old' }))).rejects.toMatchObject({ code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
    native.finish()
    const done = await settled(service, read)
    expect(native.steers.map((entry) => entry.prompt)).toEqual(['focus'])
    expect(done.turns.find((turn) => turn.requestId === steer.turn.requestId)?.delivery).toBe('completed')
    expect(done.messages.some((message) => message.content === 'stale')).toBe(false)
  })

  it.each(['/plan Inspect the repository', 'Inspect the repository'])(
    'queues one explicitly selected Plan turn after a regular turn for %s', async content => {
      const { service } = makeService()
      const workspace = fixture.scope.workspaceId
      const read = () => service.read(writer, workspace, query(codexNode))
      try {
        const first = await service.send(writer, workspace, request(codexNode, 'warm', null))
        await settled(service, read)
        const native = FakeNative.all[0]!
        native.hold = true
        await service.send(writer, workspace, request(codexNode, 'regular work', first.state.conversation!.id))
        const active = await settled(service, read, value => Boolean(value.activeTurn?.nativeTurnId))
        const input = request(codexNode, content, active.conversation!.id,
          { intent: 'next_turn', sessionMode: 'plan' })
        const accepted = await service.send(writer, workspace, input)
        expect(accepted.turn).toMatchObject({ intent: 'next_turn', delivery: 'queued' })
        expect((await service.send(writer, workspace, input)).replayed).toBe(true)
        expect(native.steers).toHaveLength(0)
        native.hold = false
        native.finish()
        await settled(service, read)
        expect(native.modes).toHaveLength(3)
        expect(native.modes.at(-1)).toBe('plan')
        expect(native.modes.slice(0, 2)).not.toContain('plan')
        expect(native.prompts.filter(prompt => prompt.includes('Inspect the repository'))).toHaveLength(1)
      } finally { await service.shutdown() }
    })

  it('replays an identical request, rejects a conflicting one and a stale conversation expectation', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    const first = request(codexNode, 'same', null)
    const accepted = await service.send(writer, workspace, first)
    await settled(service, () => service.read(writer, workspace, query(codexNode)))
    const replay = await service.send(writer, workspace, first)
    expect(replay).toMatchObject({ replayed: true, turn: { requestId: first.requestId, delivery: 'completed' } })
    await expect(service.send(writer, workspace, { ...first, content: 'different' })).rejects.toMatchObject({ code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    await expect(service.send(writer, workspace, request(codexNode, 'stale', null))).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    expect(FakeNative.all[0]!.prompts).toEqual(['same'])
    expect(accepted.state.conversation?.id).toBeTruthy()
  })

  it('keeps concurrent Agent conversations isolated', async () => {
    const { service } = makeService()
    const workspace = fixture.scope.workspaceId
    await Promise.all([service.send(writer, workspace, request(codexNode, 'for codex', null)),
      service.send(writer, workspace, request(claudeNode, 'for claude', null))])
    const [codex, claude] = await Promise.all([settled(service, () => service.read(writer, workspace, query(codexNode))),
      settled(service, () => service.read(writer, workspace, query(claudeNode)))])
    expect(codex.conversation!.id).not.toBe(claude.conversation!.id)
    expect(codex.conversation!.nativeSession!.nativeSessionId).not.toBe(claude.conversation!.nativeSession!.nativeSessionId)
    expect(codex.messages.map((message) => message.content)).not.toContain('for claude')
    expect(claude.messages.map((message) => message.content)).not.toContain('for codex')
  })

  it('blocks chat for an active Run and forks a finished Run session without writing the Run', async () => {
    const { service } = makeService()
    // Real Run and execution rows of the chat's own workflow (the conversation references them); reads still go through the fake read port.
    const runFixture = await seedAgent3(pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
    runSourceFixture = runFixture
    const workspace = runFixture.scope.workspaceId
    const node = runFixture.version.definition.nodes[0]!
    const agentConfigurationVersionId = runFixture.version.agentConfigurationVersionIds[node.agentId]!
    const runId = runFixture.run.id
    const context = (selectedRunId?: string) => ({ workflowId: runFixture.scope.workflowId, workflowNodeId: node.id,
      agentId: node.agentId, ...(selectedRunId ? { runId: selectedRunId } : {}) })
    const executionId = `exec-${randomUUID()}`
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)`,
      [executionId, runId, node.id, node.agentId,
        JSON.stringify({ id: executionId, runId, workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId,
          attempt: 1, input: {}, state: 'queued', createdAt: runFixture.createdAt })])
    runState = 'running'
    const blocked = await service.read(writer, workspace, context(runId))
    expect(blocked.availability).toMatchObject({ canSend: false, reason: 'run_active' })
    await expect(service.send(writer, workspace, { ...request(node, 'x', null), context: context(runId) }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    runState = 'completed'
    const missing = await service.read(writer, workspace, context(runId))
    expect(missing.availability).toMatchObject({ canSend: false, reason: 'native_session_missing' })
    runExecutions = [{ id: executionId, runId, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId, attempt: 1,
      nativeSessionId: 'run-thread-1', workingDirectory: root, input: {}, state: 'completed', result: { outcome: 'succeeded' },
      createdAt: runFixture.createdAt, finishedAt: runFixture.createdAt }]
    const before = await pool.query(`select (select record::text from runs where id=$1) as run,
      (select record::text from harness_executions where id=$2) as execution`, [runId, executionId])
    await service.send(writer, workspace, { ...request(node, 'what did you do?', null), context: context(runId) })
    const done = await settled(service, () => service.read(writer, workspace, context(runId)))
    const native = FakeNative.all[0]!
    expect(native.forked).toEqual([expect.objectContaining({ source: 'run-thread-1' })])
    expect(native.forked[0]!.input).toMatchObject({ instructionsDelivered: true })
    expect(native.created).toHaveLength(0)
    expect(done.conversation).toMatchObject({ origin: { kind: 'run_execution', runId, sourceNativeSessionId: 'run-thread-1' } })
    expect(done.conversation!.nativeSession!.nativeSessionId).not.toBe('run-thread-1')
    expect(native.prompts).toEqual(['what did you do?'])
    expect((await pool.query(`select (select record::text from runs where id=$1) as run,
      (select record::text from harness_executions where id=$2) as execution`, [runId, executionId])).rows[0]).toEqual(before.rows[0])
    // The same Agent without a Run is a different, isolated conversation.
    expect((await service.read(writer, workspace, context())).conversation).toBeNull()
  })

  it('A-R07 never resends an in-flight turn after restart and fences queued work until terminal evidence', async () => {
    const first = makeService()
    const workspace = fixture.scope.workspaceId
    const read = (service: AgentChatService) => () => service.read(writer, workspace, query(codexNode))
    const warm = await first.service.send(writer, workspace, request(codexNode, 'warm', null))
    await settled(first.service, read(first.service))
    FakeNative.all[0]!.hold = true
    Object.assign(FakeNative.all[0]!, { requiresSettledDisposal: () => true })
    const inflight = await first.service.send(writer, workspace, request(codexNode, 'inflight', warm.state.conversation!.id))
    await settled(first.service, read(first.service), (value) => Boolean(value.activeTurn?.nativeTurnId))
    const queued = await first.service.send(writer, workspace, request(codexNode, 'after restart', warm.state.conversation!.id))
    await expect(first.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    const restarted = makeService()
    await restarted.service.recover()
    const unknown = await read(restarted.service)()
    const byId = new Map(unknown.turns.map((turn) => [turn.requestId, turn.delivery]))
    expect(byId.get(inflight.turn.requestId), JSON.stringify(unknown.turns)).toBe('unknown')
    expect(byId.get(queued.turn.requestId)).toBe('queued')
    expect(unknown.activeTurn?.requestId).toBe(inflight.turn.requestId)
    // Native storage becomes readable later. The periodic repair must not need another restart or send.
    const resumed = FakeNative.all.at(-1)!
    const previousReconcile = resumed.reconcile.bind(resumed)
    const correlationId = agentChatCorrelation(warm.state.conversation!.id, inflight.turn.requestId)
    resumed.reconcile = async (session, correlation) => correlation === correlationId
      ? { correlationId, nativeTurnId: unknown.activeTurn!.nativeTurnId!, events: [], pendingInteractions: [], terminalResult: { outcome: 'succeeded' } }
      : previousReconcile(session, correlation)
    const done = await settled(restarted.service, read(restarted.service))
    for (const turn of done.turns) byId.set(turn.requestId, turn.delivery)
    expect(byId.get(inflight.turn.requestId)).toBe('completed')
    expect(byId.get(queued.turn.requestId), JSON.stringify(done.turns)).toBe('completed')
    expect(FakeNative.all.flatMap((native) => native.prompts).filter((prompt) => prompt === 'inflight')).toHaveLength(1)
    await first.service.shutdown()
    await restarted.service.shutdown()
  })

  it('A-R09/A-R10/A-R20 recovers the exact Codex answer once through HTTP history/state and MCP', async () => {
    const repository = new PostgresAgentChatRepository(pool)
    const workspaceId = fixture.scope.workspaceId
    const input = request(codexNode, 'answer before the crash', null)
    const context = { workspaceId, ...input.context }
    const admitted = await repository.admit({ key: agentChatKey(context), request: input, context, delivery: 'queued', create: {
      context, agentConfigurationVersionId: fixture.configurations[0]!.id, harness: 'codex', origin: { kind: 'fresh' },
      workingDirectory: root, runtimeDirectory: '',
    } })
    const id = admitted.conversationId
    expect(await repository.claim(id, input.requestId)).toBe(true)
    expect(await repository.beginSessionCreation(id, input.requestId)).toBe(true)
    const nativeSessionId = `recovered-session-${randomUUID()}`
    await repository.bindSession(id, 'fixture-1', nativeSessionId)
    await repository.accepted(id, input.requestId, 'recovered-turn')
    // Model the old acknowledgement-boundary crash: the provider accepted, but the app saved no answer/startup flag.
    await pool.query(`update operator_conversations set record=record-'startupDelivered'-'startupReceipt' where id=$1`, [id])
    const { service, managers } = makeService()
    const native = new FakeNative('codex')
    const correlationId = agentChatCorrelation(id, input.requestId)
    native.reconcile = async (_session, correlation) => correlation === correlationId
      ? { correlationId, nativeTurnId: 'recovered-turn', nativeMessageId: 'recovered-answer', events: [], pendingInteractions: [],
          terminalResult: { outcome: 'succeeded', output: { text: 'RECOVERED-EXACT-ANSWER\nsecond line' } } }
      : { events: [], pendingInteractions: [] }
    managers.set(id, native)
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const client = new Client({ name: 'agent-chat-f2-recovery', version: '1' })
    try {
      await service.recover()
      await service.recover()
      expect(native.attached).toHaveLength(1)
      expect(native.attached[0]).toMatchObject({ nativeTurnId: 'recovered-turn', instructionsDelivered: true })
      expect(native.created).toHaveLength(0)
      expect(native.prompts).toHaveLength(0)
      expect((await repository.get(id))!.record).toMatchObject({ startupDelivered: true,
        startupReceipt: { requestId: input.requestId, nativeSessionId } })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const base = `/api/workspaces/${workspaceId}/agent-chat`
      const stateReply = await app.inject({ method: 'GET', url: `${base}?workflowId=${fixture.scope.workflowId}&workflowNodeId=${codexNode.id}&agentId=${codexNode.agentId}`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(stateReply.statusCode).toBe(200)
      const state = AgentChatStateSchema.parse(stateReply.json())
      expect(state.turns[0]).toMatchObject({ requestId: input.requestId, delivery: 'completed', nativeTurnId: 'recovered-turn' })
      const answers = state.messages.filter((message) => message.role === 'assistant')
      expect(answers).toHaveLength(1)
      expect(answers[0]).toMatchObject({ nativeMessageId: 'recovered-answer', content: 'RECOVERED-EXACT-ANSWER\nsecond line' })
      const historyReply = await app.inject({ method: 'GET', url: `${base}/conversations/${id}/history?limit=100`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(historyReply.statusCode).toBe(200)
      expect(AgentChatHistoryPageSchema.parse(historyReply.json()).messages).toEqual(state.messages)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => readOnlyToken } }))
      const read = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query: query(codexNode) } })
      expect(AgentChatStateSchema.parse(decodeMcpToolResult(read)).messages).toEqual(state.messages)
      const denied = await app.inject({ method: 'POST', url: `${base}/messages`, headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: request(codexNode, 'must not send', id) })
      expect(denied.statusCode).toBe(403)
      await expectMcpAccessDenied(client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: request(codexNode, 'must not send via mcp', id) } }))
      expect((await repository.state(id))!.messages).toEqual(state.messages)
      expect(native.prompts).toHaveLength(0)
    } finally {
      await client.close().catch(() => /* ignore: the client may already be closed; app and service shutdown still run. */ undefined)
      await app.close()
      await service.shutdown()
    }
  })

  it('rejects mode-changing steering through HTTP and authenticated MCP without admitting another turn', async () => {
    const { service } = makeService()
    const transport = await f4Transport(service)
    try {
      const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'Seed chat', null))
      const id = initial.state.conversation!.id
      const read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
      await settled(service, read)
      const native = FakeNative.all[0]!
      native.hold = true
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'Active regular turn', id))
      await vi.waitFor(() => expect(native.activeTurn).toBeTruthy())
      const mcp = await transport.connect(writerToken)
      const reader = await transport.connect(readOnlyToken)
      const url = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat/messages`
      for (const content of ['Plan steering task', '/plan Plan steering task']) {
        const input = request(codexNode, content, id, { intent: 'steer', sessionMode: 'plan',
          expectedNativeTurnId: native.activeTurn! })
        const http = await transport.app.inject({ method: 'POST', url,
          headers: { authorization: `Bearer ${writerToken}` }, payload: input })
        expect(http.statusCode, http.body).toBe(422)
        expect(http.json().error.code).toBe('SESSION_STEER_MODE_UNSUPPORTED')
        const result = await mcp.callTool({ name: 'agent_chat_send', arguments: {
          workspaceId: fixture.scope.workspaceId, request: { ...input, requestId: randomUUID() } } })
        expect(result.isError).toBe(true)
        expect(JSON.stringify(result)).toContain('SESSION_STEER_MODE_UNSUPPORTED')
        await expectMcpAccessDenied(reader.callTool({ name: 'agent_chat_send', arguments: {
          workspaceId: fixture.scope.workspaceId, request: { ...input, requestId: randomUUID() } } }))
      }
      expect(native.steers).toEqual([])
      const persisted = AgentChatStateSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'agent_chat_read', arguments: {
        workspaceId: fixture.scope.workspaceId, query: query(codexNode) } }))))
      expect(persisted.turns).toHaveLength(2)
      expect(persisted.messages.filter(message => message.role === 'user').map(message => message.content))
        .toEqual(['Seed chat', 'Active regular turn'])
      native.finish()
      await settled(service, read)
    } finally { await transport.close() }
  })

  it('serves HTTP and Operator MCP on the same service with scope checks and persisted readback', async () => {
    const { service } = makeService()
    const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const url = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
      const denied = await app.inject({ method: 'POST', url: `${url}/messages`, headers: { authorization: `Bearer ${readOnlyToken}` },
        payload: request(codexNode, 'nope', null) })
      expect(denied.statusCode, denied.body).toBe(403)
      const sent = await app.inject({ method: 'POST', url: `${url}/messages`, headers: { authorization: `Bearer ${writerToken}` },
        payload: request(codexNode, 'via http', null) })
      expect(sent.statusCode).toBe(202)
      const connect = async (token: string) => {
        const client = new Client({ name: 'agent-chat-test', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const mcp = await connect(writerToken)
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['agent_chat_read', 'agent_chat_send', 'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_respond']))
      const reader = await connect(readOnlyToken)
      expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_chat_send')
      await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: fixture.scope.workspaceId, query: query(codexNode) } })
      const state = AgentChatStateSchema.parse(decodeMcpToolResult(read))
      const sendResult = await mcp.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId,
        request: request(codexNode, 'via mcp', state.conversation!.id) } })
      expect(sendResult.isError).not.toBe(true)
      // A read-only caller does not get the write tool at all; calling it is refused.
      await expectMcpAccessDenied(reader.callTool({ name: 'agent_chat_send', arguments: { workspaceId: fixture.scope.workspaceId,
        request: request(codexNode, 'denied mcp', state.conversation!.id) } }))
      const final = await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const readback = await app.inject({ method: 'GET', url: `${url}?workflowId=${fixture.scope.workflowId}&workflowNodeId=${codexNode.id}&agentId=${codexNode.agentId}`,
        headers: { authorization: `Bearer ${readOnlyToken}` } })
      expect(readback.statusCode).toBe(200)
      const persisted = AgentChatStateSchema.parse(readback.json())
      expect(persisted.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(['via http', 'via mcp'])
      expect(persisted.turns).toEqual(final.turns)
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      await app.close()
    }
  })
})

/** F4 regressions: authenticated transports and durable SQL are real; native/Run
 * read ports retain this suite's fakes. Real native/Run proof lives in the opt-in
 * agent-chat-run-native.acceptance.test.ts, not in these tests.
 */
async function f4Transport(service: AgentChatService) {
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { agentChat: service, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  return { app, address, async connect(token: string) {
    const client = new Client({ name: 'f4-regression', version: '1' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }, async close() { await Promise.allSettled(clients.map((client) => client.close())); await app.close(); await service.shutdown() } }
}
async function f4Rows(id: string) {
  return (await pool.query(`select
    (select to_jsonb(c) from operator_conversations c where id=$1) as conversation,
    (select jsonb_agg(to_jsonb(t) order by request_id) from operator_conversation_turns t where conversation_id=$1) as turns,
    (select jsonb_agg(to_jsonb(m) order by sequence) from operator_conversation_messages m where conversation_id=$1) as messages,
    (select jsonb_agg(to_jsonb(r) order by command_id) from management_command_receipts r
      where operation='agent_chat_control' and target_key=$1) as controls`, [id])).rows[0]
}

describe('F4 authenticated transport / persistence regressions', { timeout: 60_000 }, () => {
  for (const dimension of ['workspaceIds', 'workflowIds', 'runIds'] as const) {
    it(`A-R02 ${dimension}: HTTP/SSE/MCP matching scope works, mismatch has no effect`, async () => {
      const { service } = makeService()
      let runId: string | undefined
      let scopedNode = codexNode
      let scopedWorkspaceId = fixture.scope.workspaceId
      let scopedWorkflowId = fixture.scope.workflowId
      if (dimension === 'runIds') {
        const origin = await seedAgent3(pool, root, makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
        runSourceFixture = origin
        runId = origin.run.id
        scopedNode = origin.version.definition.nodes[0]!
        scopedWorkspaceId = origin.scope.workspaceId
        scopedWorkflowId = origin.scope.workflowId
        const executionId = `f4-execution-${randomUUID()}`
        const record: HarnessExecution = { id: executionId, runId, workflowNodeId: scopedNode.id, agentId: scopedNode.agentId,
          agentConfigurationVersionId: origin.version.agentConfigurationVersionIds[scopedNode.agentId]!, attempt: 1,
          nativeSessionId: 'f4-source', workingDirectory: root, input: {}, state: 'completed',
          result: { outcome: 'succeeded' }, createdAt: origin.createdAt, finishedAt: origin.createdAt }
        await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,1,$5::jsonb)',
          [executionId, runId, scopedNode.id, scopedNode.agentId, JSON.stringify(record)])
        runExecutions = [record]
      }
      const context = { ...query(scopedNode, runId), workflowId: scopedWorkflowId }
      const input = request(scopedNode, 'scoped conversation', null, { context })
      const first = await service.send(writer, scopedWorkspaceId, input)
      const id = first.state.conversation!.id
      await settled(service, () => service.read(writer, scopedWorkspaceId, context))
      const f = await f4Transport(service)
      const path = `/api/workspaces/${scopedWorkspaceId}/agent-chat`
      const resource = dimension === 'workspaceIds' ? scopedWorkspaceId : dimension === 'workflowIds' ? scopedWorkflowId : runId!
      try {
        for (const matching of [true, false]) {
          const credential = await access.issue({ name: `F4 ${dimension} ${matching}`, audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
            grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'], scope: { [dimension]: [matching ? resource : 'other'] } }] })
          const headers = { authorization: `Bearer ${credential.token}` }
          const before = await f4Rows(id)
          for (const url of [`${path}?${new URLSearchParams(Object.entries(context).filter((entry): entry is [string, string] => entry[1] !== undefined))}`, `${path}/conversations/${id}/history`]) {
            const response = await f.app.inject({ method: 'GET', url, headers })
            expect(response.statusCode, response.body).toBe(matching ? 200 : 403)
          }
          const replay = await f.app.inject({ method: 'POST', url: `${path}/messages`, headers, payload: input })
          expect(replay.statusCode, replay.body).toBe(matching ? 200 : 403)
          const mcp = await f.connect(credential.token)
          expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['agent_chat_read', 'agent_chat_send',
            'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_respond']))
          const read = await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId: scopedWorkspaceId, query: context } })
          expect(read.isError === true).toBe(!matching)
          if (matching) expect(AgentChatStateSchema.parse(decodeMcpToolResult(read)).conversation?.id).toBe(id)
          const controller = new AbortController()
          // Advance only the heartbeat interval; network I/O and credential clocks stay real.
          vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
          try {
            const stream = await fetch(`${f.address}${path}/conversations/${id}/events`, { headers,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) })
            expect(stream.status).toBe(matching ? 200 : 403)
            if (matching) {
              const reader = stream.body!.getReader()
              try {
                let frames = ''
                await vi.advanceTimersByTimeAsync(5_000)
                while (!frames.includes(': heartbeat')) {
                  const chunk = await reader.read()
                  if (chunk.done) throw new Error('Scoped stream closed before its reauthorized heartbeat.')
                  frames += new TextDecoder().decode(chunk.value)
                }
                expect(frames).toContain('event: snapshot')
              } finally { await reader.cancel() }
            } else { await stream.text() }
          } finally {
            controller.abort()
            vi.useRealTimers()
          }
          expect(await f4Rows(id)).toEqual(before)
        }
      } finally { await f.close() }
    }, 30_000)
  }

  it('A-R03 action-only callers cannot disclose command state or mutate before a denied response, over HTTP and MCP', async () => {
    const { service } = makeService()
    const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'protected transcript', null))
    const id = initial.state.conversation!.id
    await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
    const f = await f4Transport(service)
    const path = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat`
    try {
      const native = FakeNative.all[0]!
      for (const action of ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'] as const) {
        const credential = await access.issue({ name: `F4 ${action}`, audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
          grants: [{ actions: [action], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
        const headers = { authorization: `Bearer ${credential.token}` }
        const before = await f4Rows(id), calls = { prompts: native.prompts.length, cancels: native.cancels }
        const commands = [
          { tool: 'agent_chat_send', suffix: '/messages', body: request(codexNode, 'denied', id) },
          { tool: 'agent_chat_interrupt', suffix: `/conversations/${id}/interrupt`, body: { requestId: randomUUID() } },
          { tool: 'agent_chat_cancel_queued', suffix: `/conversations/${id}/turns/${initial.turn.requestId}/cancel`, body: { requestId: randomUUID() } },
          { tool: 'agent_chat_respond', suffix: `/conversations/${id}/responses`, body: { requestId: randomUUID(), nativeRequestId: 'approval', optionId: 'accept' } },
        ]
        const mcp = await f.connect(credential.token)
        const available = (await mcp.listTools()).tools.map((tool) => tool.name)
        for (const command of commands) {
          const response = await f.app.inject({ method: 'POST', url: `${path}${command.suffix}`, headers, payload: command.body })
          expect(response.statusCode, response.body).toBe(403)
          expect(response.body).not.toContain('protected transcript')
          expect(available).not.toContain(command.tool)
          await expectMcpAccessDenied(mcp.callTool({ name: command.tool, arguments: { workspaceId: fixture.scope.workspaceId, conversationId: id,
            ...(command.tool === 'agent_chat_send' ? { request: command.body } : command.body) } }))
        }
        const history = await f.app.inject({ method: 'GET', url: `${path}/conversations/${id}/history`, headers })
        expect(history.statusCode).toBe(action === 'agent_chat:read' ? 200 : 403)
        expect(await f4Rows(id)).toEqual(before)
        expect({ prompts: native.prompts.length, cancels: native.cancels }).toEqual(calls)
      }
    } finally { await f.close() }
  })

  it('A-R12 lost cancel/respond/interrupt responses replay original SQL receipts across HTTP/MCP and conflict before native effects', async () => {
    const { service } = makeService()
    const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'warm', null))
    const id = initial.state.conversation!.id, read = () => service.read(writer, fixture.scope.workspaceId, query(codexNode))
    await settled(service, read)
    const native = FakeNative.all[0]!
    native.hold = true
    await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'active', id))
    const active = await settled(service, read, (state) => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
    const queued = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'queued', id))
    const f = await f4Transport(service), mcp = await f.connect(writerToken)
    const path = `/api/workspaces/${fixture.scope.workspaceId}/agent-chat/conversations/${id}`
    const headers = { authorization: `Bearer ${writerToken}` }
    const http = (suffix: string, body: Record<string, unknown>) => f.app.inject({ method: 'POST', url: `${path}${suffix}`, headers, payload: body })
    const replay = (name: string, body: Record<string, unknown>) => mcp.callTool({ name, arguments: { workspaceId: fixture.scope.workspaceId, conversationId: id, ...body } })
    const receipt = async (commandId: string) => (await pool.query(`select target_key,input_hash,result from management_command_receipts
      where principal_id=$1 and operation='agent_chat_control' and command_id=$2`, [writer.id, commandId])).rows[0]
    const conflict = async (suffix: string, name: string, body: Record<string, unknown>, addressing = {}) => {
      const response = await http(suffix, body)
      expect(response.statusCode, response.body).toBe(409)
      expect(response.body).toContain('AGENT_CHAT_REQUEST_CONFLICT')
      const result = await replay(name, { ...addressing, ...body })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('AGENT_CHAT_REQUEST_CONFLICT')
    }
    try {
      const cancel = { requestId: randomUUID() }, cancelPath = `/turns/${queued.turn.requestId}/cancel`
      const canceled = await http(cancelPath, cancel)
      expect(canceled.statusCode, canceled.body).toBe(200)
      const cancelReceipt = await receipt(cancel.requestId)
      const later = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later queued', id))
      expect(decodeMcpToolResult((await replay('agent_chat_cancel_queued', { ...cancel, turnRequestId: queued.turn.requestId }))))
        .toEqual({ state: await service.readConversation(writer, fixture.scope.workspaceId, id) })
      expect(await receipt(cancel.requestId)).toEqual(cancelReceipt)
      expect(cancelReceipt.result).toMatchObject({ status: 'completed', state: { conversation: { id },
        turns: expect.arrayContaining([expect.objectContaining({ requestId: queued.turn.requestId, delivery: 'canceled' })]) } })
      await conflict(`/turns/${later.turn.requestId}/cancel`, 'agent_chat_cancel_queued', cancel, { turnRequestId: later.turn.requestId })
      expect((await read()).turns.find((turn) => turn.requestId === later.turn.requestId)?.delivery).toBe('queued')
      let responses = 0
      native.respond = async () => { responses++ }
      const repository = new PostgresAgentChatRepository(pool)
      const pending = { session: { harness: 'codex' as const, providerVersion: 'fixture-1', nativeSessionId: active.conversation!.nativeSession!.nativeSessionId },
        turn: { nativeTurnId: active.activeTurn!.nativeTurnId!, nativeRequestId: 'approval-one' }, nativeRequestType: 'approval', request: {},
        responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
      await repository.pending(id, active.activeTurn!.requestId, pending)
      const respond = { requestId: randomUUID(), nativeRequestId: 'approval-one', optionId: 'codex-approve-once' }
      const responded = await http('/responses', respond)
      expect(responded.statusCode, responded.body).toBe(200)
      const respondReceipt = await receipt(respond.requestId)
      await repository.pending(id, active.activeTurn!.requestId, { ...pending, turn: { ...pending.turn, nativeRequestId: 'approval-two' } })
      expect(decodeMcpToolResult((await replay('agent_chat_respond', respond)))).toEqual({ state: await service.readConversation(writer, fixture.scope.workspaceId, id) })
      expect(await receipt(respond.requestId)).toEqual(respondReceipt)
      expect(respondReceipt.result).toMatchObject({ status: 'completed', acceptedControl: { modelRequestId: active.activeTurn!.requestId,
        native: { sessionId: pending.session.nativeSessionId, turnId: pending.turn.nativeTurnId, requestId: 'approval-one' } } })
      await conflict('/responses', 'agent_chat_respond', { ...respond, optionId: 'codex-reject' })
      expect(responses).toBe(1)
      expect((await read()).pendingInteraction?.turn.nativeRequestId).toBe('approval-two')
      native.deferCancelTerminal = true
      const cancelDelivery = vi.spyOn(native, 'cancel')
        .mockRejectedValueOnce(new Error('Cancel transport disconnected before acknowledgment'))
        .mockResolvedValueOnce(false)
      const interrupt = { requestId: randomUUID() }
      const interrupted = await http('/interrupt', interrupt)
      expect(interrupted.statusCode, interrupted.body).toBe(200)
      const interruptReceipt = await receipt(interrupt.requestId)
      await service.recover()
      await service.recover()
      await service.recover()
      expect(cancelDelivery).toHaveBeenCalledTimes(3)
      expect(native.cancels).toBe(1)
      expect((await read()).activeTurn?.requestId).toBe(active.activeTurn!.requestId)
      expect(native.prompts).toHaveLength(2)
      native.finish({ outcome: 'canceled' })
      native.deferCancelTerminal = false
      await settled(service, read)
      await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'later active', id))
      const next = await settled(service, read, (state) => Boolean(state.activeTurn?.nativeTurnId && native.activeTurn))
      await vi.waitFor(async () => {
        expect(decodeMcpToolResult((await replay('agent_chat_interrupt', interrupt)))).toEqual({ state: await service.readConversation(writer, fixture.scope.workspaceId, id) })
      })
      expect(await receipt(interrupt.requestId)).toEqual(interruptReceipt)
      expect(interruptReceipt.result).toMatchObject({ status: 'completed', state: { conversation: { id },
        turns: expect.arrayContaining([expect.objectContaining({ requestId: active.activeTurn!.requestId, nativeTurnId: active.activeTurn!.nativeTurnId })]) } })
      await conflict('/interrupt', 'agent_chat_interrupt', { ...interrupt, expectedNativeTurnId: next.activeTurn!.nativeTurnId! })
      expect(native.cancels).toBe(1)
      expect((await read()).activeTurn?.requestId).toBe(next.activeTurn?.requestId)
      const receipts = (await pool.query<{ result: { status: string } }>(`select result from management_command_receipts
        where principal_id=$1 and operation='agent_chat_control' and target_key=$2 and command_id=any($3::text[])`,
      // Earlier tests reuse this deterministic conversation id; count only this test's three commands.
      [writer.id, id, [cancel.requestId, respond.requestId, interrupt.requestId]])).rows
      expect(receipts.map((row) => row.result.status)).toEqual(['completed', 'completed', 'completed'])
    } finally {
      if (native.activeTurn) native.finish({ outcome: 'canceled' })
      await f.close()
    }
  })

  it('A-R17 keeps snapshots byte bounded while HTTP history returns every oversized message intact and advances', async () => {
    const { service } = makeService()
    try {
      const initial = await service.send(writer, fixture.scope.workspaceId, request(codexNode, 'before large history', null))
      const id = initial.state.conversation!.id
      await settled(service, () => service.read(writer, fixture.scope.workspaceId, query(codexNode)))
      const huge = '界'.repeat(3 * 1024 * 1024), hugeId = randomUUID()
      for (const [messageId, content] of [[hugeId, huge], [randomUUID(), 'newest message']]) {
        const record = { id: messageId, conversationId: id, role: 'assistant', content, createdAt: new Date().toISOString() }
        await pool.query(`insert into operator_conversation_messages(id,conversation_id,role,content,record) values($1,$2,'assistant',$3,$4::jsonb)`,
          [messageId, id, content, JSON.stringify(record)])
      }
      const state = await service.read(writer, fixture.scope.workspaceId, query(codexNode))
      expect(Buffer.byteLength(JSON.stringify(state.messages))).toBeLessThan(256 * 1024)
      expect(state.hasEarlierMessages).toBe(true)
      expect(state.messages.map((message) => message.content)).toEqual(['newest message'])
      const messages: AgentChatState['messages'] = [], cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await service.history(writer, fixture.scope.workspaceId, id, cursor, 100)
        messages.push(...page.messages)
        cursor = page.nextCursor ?? undefined
        if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor) }
      } while (cursor)
      expect(messages.find((message) => message.id === hugeId)?.content === huge).toBe(true)
      expect(messages).toHaveLength(4)
      expect(new Set(messages.map((message) => message.id)).size).toBe(4)
    } finally { await service.shutdown() }
  })
})

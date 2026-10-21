import { omitProperties } from '../../shared/omitProperties.js'
import { randomUUID } from 'node:crypto'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, type NativeSessionReference,
  type SessionPreferences } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ExecutionChatPort } from '../collaboration/ports.js'
import { workflowChatMigration } from '../../infrastructure/workflowChatMigration.js'
import { PostgresAccessService } from '../access/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { PostgresOperatorRepository } from '../operators/postgres.js'
import { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { pendingSessionControls } from '../harnesses/sessionControlDefaults.js'
import type { NativeHarnessSessionManager, NativeInitialTurnInput, NativeSessionStart, NativeSteerInput,
  NativeTurnInput } from '../harnesses/port.js'
import { agent3Database, seedAgent3 } from '../../../test/helpers/wave25Agent3.js'
import { ChatManager } from '../../../test/helpers/operatorChatFixture.js'
import { AgentChatService, type AgentChatManagerFactory } from './agentChat.js'
import { OperatorChatService, type NativeManagerResolver, type OperatorChatAuthority } from './operatorChat.js'
import { PostgresAgentChatRepository } from './agentChatRepository.js'
import { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import type { ConversationFeatureContext } from './conversationFeatureSubject.js'
import { createWorkflowChatFeature } from '../workflow-chat/feature.js'

/** Only native I/O and the parallel engine port are fake; admission, auth, queues and recovery use production SQL/services. */
export class DeliveryNativeFixture extends ChatManager {
  inputs: Array<{ correlationId: string; prompt: string; mode?: NativeTurnInput['sessionMode']; preferences?: SessionPreferences }> = []
  steers: NativeSteerInput[] = []
  cancelCalls = 0
  lostInitialObservation = false
  loseTurnObservation = false
  pauseBeforeInput = false
  lastSession: NativeSessionReference | undefined
  preferences: SessionPreferences | undefined
  caller: string | undefined
  override async capabilities(): ReturnType<NativeHarnessSessionManager['capabilities']> {
    return { provider: this.harness, providerVersion: 'fixture', persistentSessions: true, reconnect: true,
      sameRequestResponses: true, cancellation: true, history: true, configurationInspection: false,
      mcpDetection: false, supportedInteractionKinds: [] }
  }
  async sessionControlCapabilities() {
    return { ...pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex), plan: { supported: true, reason: null } }
  }
  setSessionControlPrincipal(id: string) { this.caller = id }
  async configureSessionPreferences(preferences: SessionPreferences) { this.preferences = structuredClone(preferences) }
  appliedSessionPreferences() { return this.preferences ?? null }
  override async createSession() { this.lastSession = await super.createSession(); return this.lastSession }
  async reconcileSessionCreation() {
    if (!this.lastSession) throw new Error('No native creation has been observed.')
    return this.lastSession
  }
  override async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    if (this.pauseBeforeInput) await new Promise<void>(resolve => {
      const stop = () => { signal?.removeEventListener('abort', stop); resolve() }
      signal?.addEventListener('abort', stop, { once: true })
      if (signal?.aborted) stop()
    })
    if (signal?.aborted) return
    this.inputs.push({ correlationId: input.clientCorrelationId, prompt: input.prompt,
      ...(input.sessionMode ? { mode: input.sessionMode } : {}),
      ...(input.sessionPreferences ? { preferences: structuredClone(input.sessionPreferences) } : {}) })
    if (input.sessionPreferences) this.preferences = structuredClone(input.sessionPreferences)
    for await (const event of super.startTurn(session, input, signal)) {
      yield event
      if (this.loseTurnObservation) {
        this.loseTurnObservation = false
        throw new Error('Observation transport failed after the original native submission.')
      }
    }
  }
  async *startInitialTurn(_start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal) {
    const session = await this.createSession()
    if (this.lostInitialObservation) {
      this.lostInitialObservation = false
      const accepted = omitProperties(input, ['onSubmitted', 'onMessageSubmitted', 'onSettingsApplied',
        'onSessionObserved', 'onTerminal'])
      for await (const event of this.startTurn(session, accepted, signal)) void event
      throw new Error('The original native input completed while its Main observation transport was lost.')
    }
    await input.onSessionObserved(session)
    yield* this.startTurn(session, input, signal)
  }
  async steerTurn(_session: NativeSessionReference, input: NativeSteerInput) {
    this.steers.push(structuredClone(input))
    return { nativeTurnId: input.expectedTurnId }
  }
  override async cancel(session: NativeSessionReference) { this.cancelCalls++; return super.cancel(session) }
}

export async function conversationDeliveryFixture() {
  const database = await agent3Database()
  if (!(await database.pool.query("select to_regclass('workflow_chat_posts') as table_name")).rows[0]?.table_name) {
    await database.pool.query(workflowChatMigration.sql)
  }
  const definition = makeCurrentWorkflowFixture(`conversation-${randomUUID()}`, 'single')
  definition.configurations = definition.configurations.map(configuration => AgentConfigurationVersionSchema.parse({
    ...configuration, harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'fixture', reasoningEffort: 'low',
      sandbox: 'read-only', serviceTier: 'standard' },
  }))
  const saved = await seedAgent3(database.pool, database.directory, definition, { run: false })
  const node = saved.version.definition.nodes[0]!
  const query = { workflowId: saved.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
  const scope = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId }
  const access = new PostgresAccessService(database.pool)
  const owner = (await access.issue({ name: 'Conversation owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
    grants: [{ scope: {}, actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond',
      'operator_chat:read', 'operator_chat:write', 'operator_chat:cancel', 'operator_chat:respond', 'settings:update', 'harnesses:read'] }] })).principal
  const operators = new PostgresOperatorRepository(database.pool)
  const managers = new Map<string, DeliveryNativeFixture>()
  const contexts: ConversationFeatureContext[] = []
  const native = (id: string) => {
    let manager = managers.get(id)
    if (!manager) { manager = new DeliveryNativeFixture(); managers.set(id, manager) }
    return manager
  }
  const factory: AgentChatManagerFactory = (id, _configuration, _directory, _source, context) => {
    if (context) contexts.push(structuredClone(context))
    return native(id)
  }
  factory.prepareInput = async input => ({ prompt: input.prompt })
  factory.qualifiedSteer = async () => true
  const resolver: NativeManagerResolver = (_configuration, id) => native(id)
  resolver.prepareInput = async input => ({ prompt: input.prompt })
  resolver.qualifiedSteer = async () => true
  const authority: OperatorChatAuthority = { current: id => access.currentOperator(id), assertConfiguration() {},
    setup: async manager => ({ harness: manager.harness, status: 'configured', endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
    setupConfiguration: async (_principal, configuration) => ({ harness: configuration.harness.harness, status: 'configured',
      endpoint: 'http://127.0.0.1/mcp', checkedAt: new Date().toISOString() }),
    prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }), release: async () => {} }
  const execution: ExecutionChatPort = {
    deliver: async () => { throw new Error('This fixture has no Run owner.') },
    read: async () => { throw new Error('This fixture has no Run owner.') },
    stop: async () => { throw new Error('This fixture has no Run owner.') },
    cancel: async () => { throw new Error('This fixture has no Run owner.') },
  }
  const createServices = () => {
    const agentRepository = new PostgresAgentChatRepository(database.pool)
    const operatorRepository = new PostgresOperatorConversationRepository(database.pool)
    const agent = new AgentChatService(database.pool, agentRepository, operatorRepository, new PostgresWorkflowRepository(database.pool), {
      getForWorkspace: async () => { throw new Error('No Run is created by this fixture.') },
      getExecution: async () => { throw new Error('No execution is created by this fixture.') },
      executionPages: () => { throw new Error('No execution is created by this fixture.') },
    }, factory, database.directory)
    const operator = new OperatorChatService(operatorRepository, operators, resolver, database.directory, authority)
    return { agent, operator, agentRepository, operatorRepository }
  }
  const services = () => {
    const { agent, operator, agentRepository, operatorRepository } = createServices()
    const feature = createWorkflowChatFeature({ pool: database.pool, agent, agentRepository, operator, execution,
      access: { resolve: async (principal, action, selected) => {
        requireAuthorization(principal, action, selected)
        requireAuthorization(await access.currentOperator(principal.id), action, selected)
        return { principal }
      }, restore: id => access.currentOperator(id) },
      targets: { resolve: async (principal, workspaceId, context) => {
        const read = await agent.read(principal, workspaceId, context)
        if (!read.deliveryTarget) throw new Error('No exact outside-run target was resolved.')
        return read.deliveryTarget
      } },
      qualifyExecutionLocked: async () => { throw new Error('No execution is created by this fixture.') },
      authorizeExecutionTarget: async () => { throw new Error('No execution is created by this fixture.') },
      assertCardLinksLocked: async (_tx, _principal, _scope, ids) => { if (ids.length) throw new Error('No board cards in this fixture.') },
      runReplies: { read: async () => undefined },
      bindConversationScope: async input => { contexts.push(structuredClone(input.context)) },
    })
    return { agent, operator, feature, agentRepository, operatorRepository }
  }
  let current = services()
  return { database, access, owner, scope, query, saved, native, contexts, createServices,
    get agentRepository() { return current.agentRepository }, get operatorRepository() { return current.operatorRepository },
    get agent() { return current.agent }, get operator() { return current.operator }, get feature() { return current.feature },
    restart: async () => { await current.agent.shutdown(); await current.operator.shutdown(); current = services() },
    close: async () => { await current.agent.shutdown(); await current.operator.shutdown(); await database.close() },
  }
}

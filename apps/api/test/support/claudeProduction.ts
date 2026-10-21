import { sessionStartConfiguration, sessionStartDirectory } from '../../src/modules/harnesses/sessionStart.js'
import { isDeepStrictEqual } from 'node:util'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentFileToolService } from '../../src/modules/files/tools/service.js'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { workspaceTools } from '../../src/mcp/operator/tools/workspaces.js'
import { registerOperatorToolGroup } from '../../src/mcp/operator/server.js'
import type { OperatorRequestContext } from '../../src/mcp/operator/types.js'
import { vi } from 'vitest'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, OperatorConfigurationVersionSchema, type CoordinatorConsultationBinding } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { AcceptedClaudeProfileAdmission } from '../../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import type { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import type { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../../src/modules/harnesses/installationRegistry.js'
import type { ProductionHarnessRegistry } from '../../src/modules/harnesses/productionRegistry.js'
import { NativeHarnessFactories } from '../../src/modules/harnesses/runtimeFactory.js'
import { productionClaudeManager } from '../../src/modules/harnesses/claudeSdk/production.js'
import { ClaudeBoundedQueue } from '../../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeDomainBinding } from '../../src/modules/harnesses/claudeSdk/domainAuthority.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../../src/modules/harnesses/claudeSdk/port.js'
import type { NativeSessionStart } from '../../src/modules/harnesses/port.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'
import { PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { rejectableDeferred } from '../helpers/deferred.js'

const createdAt = '2026-10-01T00:00:00.000Z'
/** Synthetic installed/profile records and redacted SDK frames. Exercises actual
 * admission/domain/factory/manager classes without native or PostgreSQL claims. */
export function productionClaudeFixture(surface: 'workflow' | 'operator' | 'agent' | 'selected-run', sharedFactories?: NativeHarnessFactories, endpoint = 'http://127.0.0.1:3000/mcp', fileService?: AgentFileToolService,
  runtime?: { database: pg.Pool; binding: ClaudeDomainBinding; start: NativeSessionStart; sdk: ClaudeSdkClient },
  workflowOptions?: { coordinator?: boolean; consultation?: CoordinatorConsultationBinding }) {
  const kind = surface === 'selected-run' ? 'agent' : surface
  const selection = runtime ? sessionStartConfiguration(runtime.start).harnessProfileSelection : undefined
  const target = selection?.target ?? { hostRef: { kind: 'main' as const, mainId: '77d29f00-408e-4000-8000-000000000001' },
    applicationInstallationId: '77d29f00-408e-4000-8000-000000000001', harnessInstallationId: 'recorded-cli', installationFingerprint: 'recorded-payload' }
  const defaultHarness = { harness: 'claude' as const, model: 'recorded-model', authMode: 'subscription' as const,
    configDirectory: '/recorded/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
    tools: ['mcp__graphql__workspace_list', 'mcp__graphql-files__files.read'], permissionRules: [], instructions: 'Pinned fixture instructions', mcpServers: { graphql: { type: 'http' as const, url: endpoint } } }
  const harness = runtime
    ? sessionStartConfiguration(runtime.start).harness
    : defaultHarness
  if (harness.harness !== 'claude') throw new Error('The production fixture requires a Claude configuration.')
  const override: HostHarnessOverride = { instanceId: selection?.instanceId ?? 'recorded-profile',
    instanceRevision: selection?.instanceRevision ?? 'profile-1', revision: 1,
    target, presetId: 'recorded', enabled: true, driverId: 'claude', configuration: harness, configurationFingerprint: 'recorded-config', qualification: 'qualified' }
  const pin = { sdkVersion: '0.3.284', sdkIntegrity: 'recorded-integrity', cliVersion: '2.1.284', executableSha256: 'a'.repeat(64),
    profilePath: harness.configDirectory, configRevision: 'profile-1' }
  const proof: HostHarnessProfileEvidence = { target, instanceRevision: override.instanceRevision, configurationFingerprint: override.configurationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: 'recorded-protocol', suiteRevision: 'recorded-suite', environmentGeneration: 'recorded-env',
    connectionGeneration: 'recorded-connection', authenticated: true, compatible: true, qualified: true, checkedAt: createdAt,
    claudeProof: { pin, observedTools: harness.tools.filter(tool => !tool.startsWith('mcp__')), checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check => [check, { state: 'passed' as const,
      source: 'native_scenario' as const, evidenceId: `synthetic:${check}`, evidenceSha256: 'b'.repeat(64) }])) } }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId: override.instanceId, instanceRevision: override.instanceRevision, driverId: 'claude', enabled: true, configuration: harness }])
  const installations = new HarnessInstallationRegistry(instances)
  const launcher = { requested: '/recorded/claude', resolvedLauncher: '/recorded/claude', fingerprint: target.installationFingerprint,
    status: 'installed' as const, interpreter: null, diagnostics: [], environment: { generation: 'recorded-env', provenance: 'terminal' as const, cwd: '/recorded', path: '/recorded' }, checkedAt: createdAt }
  installations.refresh([{ hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId, installationFingerprint: target.installationFingerprint,
    driverId: 'claude', driverRevision: '1', protocolRevision: proof.protocolRevision, environmentGeneration: proof.environmentGeneration,
    connectionGeneration: proof.connectionGeneration, launcher, observedVersion: pin.cliVersion, installed: true, authenticated: null, compatible: null, qualified: null }])
  const binding = installations.pin({ instanceId: override.instanceId, hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    environmentGeneration: proof.environmentGeneration, connectionGeneration: proof.connectionGeneration })
  const client = {} as pg.PoolClient
  const profiles = new AcceptedClaudeProfileAdmission<ClaudeDomainBinding>(
    { readAuthorized: async <T>(read: (sql: pg.PoolClient) => Promise<T>) => read(client),
      latest: async () => override,
      savedRevision: async (_client: pg.ClientBase, instanceId: string, instanceRevision: string,
        options?: { target: HostHarnessOverride['target'] }) => {
        if (instanceId !== override.instanceId || instanceRevision !== override.instanceRevision
          || options && !isDeepStrictEqual(options.target, override.target)) return null
        return override
      },
      lockRevision: async () => {} } as unknown as HarnessInstanceSettingsRepository,
    { latest: async () => proof } as unknown as HostHarnessProfileEvidenceRepository,
    { authorize: async () => {}, current: async () => ({ registry: binding, applicationInstallationId: target.applicationInstallationId, suiteRevision: proof.suiteRevision, pin }), assertCurrent: value => installations.assertCurrent(value) })
  const agent = AgentConfigurationVersionSchema.parse({ id: 'configuration-1', workspaceId: 'workspace', agentId: 'agent', productRole: workflowOptions?.coordinator ? 'orchestrator' : 'coder', version: 1,
    harness, prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const operator = OperatorConfigurationVersionSchema.parse({ id: 'configuration-1', operatorId: 'operator', version: 1, harness, contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  const version = WorkflowVersionV3Schema.parse({ id: 'version', workspaceId: 'workspace', workflowId: 'workflow', version: 1, executionSemanticsVersion: 3,
    entryNodeId: 'node', approval: { handler: 'user' }, agentConfigurationVersionIds: { agent: agent.id }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
    definition: { id: 'workflow', workspaceId: 'workspace', name: 'Synthetic replay', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node', approval: { handler: 'user' },
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, nodes: [{ id: 'node', agentId: 'agent', name: 'Agent' }], edges: [] } })
  const run = WorkflowRunV3Schema.parse({ id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: version.id, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: version.approval, executionCondition: { kind: 'manual' }, executionState: 'running', outcome: 'pending', input: {}, createdAt })
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: agent.id, attempt: 1, state: 'starting', input: {}, createdAt })
  const workflow = { run, version, execution, configuration: agent, consultation: workflowOptions?.consultation }
  const row = { kind, owner_principal_id: 'sender', workspace_id: 'workspace', workflow_id: 'workflow', origin_run_id: surface === 'selected-run' ? 'selected-run' : null,
    active_request_id: 'request-1', native_session_id: null as string | null, provider_version: null as string | null, cancel_requested: false, deleted_at: null, record: { status: 'open' }, payload: { ownerPrincipalId: 'sender', nativeSubmission: undefined as { kind: 'message'; nativeSessionId: string; nativeMessageId: string; clientCorrelationId: string } | undefined },
    pending_interaction: null as unknown, response_delivery: 'offered' }
  let receipts: unknown[] = []
  const callbacks = new Map<string, Record<string, unknown>>()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('from run_coordinator_consultations c')) {
      const consultation = workflow.consultation
      const matches = consultation && values[0] === consultation.consultationId && values[1] === run.id
        && isDeepStrictEqual(JSON.parse(String(values[2])), consultation) && values[3] === execution.nativeSessionId
      return { rows: matches ? [{ binding: consultation, execution, run_id: run.id, workspace_id: run.workspaceId,
        workflow_id: run.workflowId, source_execution_id: execution.id, agent: { workspaceId: run.workspaceId,
          workflowId: run.workflowId, workflowNodeId: execution.workflowNodeId, agentId: execution.agentId,
          configurationVersionId: agent.id, productRole: agent.productRole, displayName: 'Coordinator' } }] : [] }
    }
    if (sql.includes('claude_callback_receipts')) {
      const key = JSON.stringify(values.slice(0, 2))
      if (sql.includes('insert into')) {
        callbacks.set(key, JSON.parse(String(values[3])) as Record<string, unknown>)
        return { rows: [{ callback_key: values[1] }], rowCount: 1 }
      }
      if (sql.includes('callback_key=$2')) return { rows: callbacks.has(key) ? [{ record: callbacks.get(key) }] : [] }
      const rows = [...callbacks.values()].filter(record => {
        const identity = record.identity as Record<string, unknown>
        return identity.nativeSessionId === values[1] && (sql.includes('toolUseId')
          ? identity.nativeMessageId === values[2] && identity.generation === values[3] && identity.toolUseId === values[4]
          : record.acknowledged === true && record.retired !== true)
      })
      return { rows: rows.map(record => ({ record: structuredClone(record) })) }
    }
    if (sql.includes("payload#>>'{nativeSubmission,clientCorrelationId}'")) {
      const submitted = row.payload.nativeSubmission?.clientCorrelationId === values[1]
      return { rows: submitted ? [{ submitted: true }] : [], rowCount: submitted ? 1 : 0 }
    }
    if (sql.includes('set pending_interaction=')) {
      row.pending_interaction = values[2] ? JSON.parse(String(values[2])) : null
      return { rows: [], rowCount: 1 }
    }
    if (sql === 'select active_request_id from operator_conversations where id=$1') {
      return { rows: [{ active_request_id: row.active_request_id }] }
    }
    if (sql === 'select * from operator_conversations where id=$1') {
      return { rows: [row] }
    }
    if (sql.includes('m.id as message_id')) return { rows: [{ ...row, sender_id: 'sender',
      message_id: 'user-message', native_submission: row.payload.nativeSubmission }] }
    if (sql.includes('select kind,id,owner_principal_id,operator_id')) return { rows: [{ ...row, id: surface, agent_id: 'agent' }] }
    if (sql.includes('select principal_id,result from management_command_receipts')
      || sql.includes('select result from management_command_receipts')) return { rows: receipts }
    const rows = sql.includes('e.record as execution') ? [{ run, version, execution, configuration: agent, attempt: 1, stopped: false,
      execution_closed: false, native_reference: null, finalized: false, generation: null, native_owner: null, budget_active: true }]
      : sql.includes("record->>'authorizationPrincipalId'") ? [{ principal_id: 'sender' }]
        : sql.includes('from management_principals where id=') ? [{ id: 'sender', name: 'Recorded sender', audience: 'operator', grants: [{ actions: ['runs:start', 'operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write', 'operator_chat:respond', 'agent_chat:respond'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]
          : sql.includes('join operator_conversation_turns t') ? [row] : undefined
    if (!rows) throw new Error('Unexpected SQL in fixture: ' + sql.slice(0, 80))
    return { rows }
  })
  const pool = runtime?.database ?? { query } as unknown as pg.Pool
  const owner = { runId: 'run', client: pool, assertOwned: () => {}, readOneShotFence: async () => ({ ownerId: 'recorded-owner', fence: 'recorded-fence' }) } as unknown as RunOwnership
  const domain: ClaudeDomainBinding = runtime?.binding ?? (kind === 'workflow' ? { kind, runId: 'run', executionId: 'execution', attempt: 1, getOwner: () => owner }
    : kind === 'operator' ? { kind, conversationId: surface, repository: new PostgresOperatorConversationRepository(pool) }
      : { kind: 'agent', conversationId: surface, workspaceId: 'workspace', repository: new PostgresAgentChatRepository(pool) })
  const start: NativeSessionStart = runtime?.start ?? (kind === 'operator' ? { kind: 'operator', correlationId: `${surface}:request-1`, configuration: operator, workingDirectory: '/recorded/work' }
    : { kind: 'workflow', correlationId: `${surface}:request-1`, request: { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/recorded/work', runtimeDirectory: '/recorded/runtime', configuration: agent, input: {} } })
  const queries: { frames: ClaudeBoundedQueue<unknown>; messages: AsyncIterator<ClaudeSdkUserMessage> }[] = []
  const initialFrames = new ClaudeBoundedQueue<unknown>(64)
  const ready = rejectableDeferred<AsyncIterator<ClaudeSdkUserMessage>>()
  const setMcpServers = vi.fn<(servers: Readonly<Record<string, unknown>>) =>
    Promise<{ added: string[]; removed: string[]; errors: Record<string, never> }>>(
    async () => ({ added: ['graphql'], removed: [], errors: {} }))
  const sdkQuery = vi.fn<ClaudeSdkClient['query']>(options => {
    const frames = queries.length ? new ClaudeBoundedQueue<unknown>(64) : initialFrames
    const incoming = options.prompt[Symbol.asyncIterator]()
    const first = incoming.next()
    let firstRead = false
    const messages: AsyncIterator<ClaudeSdkUserMessage> = { next() {
      if (firstRead) return incoming.next()
      firstRead = true
      return first
    } }
    queries.push({ frames, messages })
    // An inspection query can stay empty; readiness belongs to the SDK query that consumes the input.
    void first.then(value => { if (!value.done) ready.resolve(messages) }, error => ready.reject(error))
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(), interrupt: async () => undefined,
      initializationResult: async () => ({}), setMcpServers,
      mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', config: { type: 'http', url: harness.mcpServers.graphql!.url }, tools: [] }] }
  })
  const sdk: ClaudeSdkClient = { sdkVersion: pin.sdkVersion, query: sdkQuery, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'recorded-fork' }) }
  const loadClient = vi.fn(async () => runtime?.sdk ?? sdk)
  const factories = sharedFactories ?? new NativeHarnessFactories({ codexBinary: '/forbidden-codex', instances, installations,
    installationDiscovery: async () => launcher })
  const result = productionClaudeManager({ pool, factories, registry: { pinOverride: () => binding } as unknown as ProductionHarnessRegistry,
    profiles, selector: { instanceId: override.instanceId, instanceRevision: override.instanceRevision, target }, binding: domain,
    ...(workflowOptions?.consultation ? { consultation: workflowOptions.consultation } : {}),
    role: kind === 'agent' ? 'agent-chat' : kind, configuration: harness, workingDirectory: sessionStartDirectory(start), ownerAgentId: surface,
    recovery: { root: '/forbidden-native-recovery', owner: surface }, appMcpAccess: kind === 'agent' ? 'none' : 'scoped', mode: 'replay',
    inspectionStart: async () => start, loadClient,
    ...(fileService ? { files: { service: () => fileService, sdk: async () => ({ createSdkMcpServer, tool }) } } : {}) })
  const claim = (session: { nativeSessionId: string; providerVersion: string }, nativeRequestId: string, toolUseId: string) => {
    const identity = result.manager.nativeCallbackContext(session.nativeSessionId, toolUseId)!
    row.response_delivery = 'submitted'
    receipts = [{ principal_id: 'sender', result: { status: 'pending', acceptedControl: {
      modelRequestId: 'request-1', conversationId: surface,
      scope: { kind: kind === 'operator' ? 'operator_chat' : 'agent_chat', conversationId: surface, workspaceId: 'workspace', workflowId: 'workflow' },
      native: { harness: 'claude', providerVersion: session.providerVersion, sessionId: session.nativeSessionId,
        messageId: identity.nativeMessageId, generation: identity.generation, requestId: nativeRequestId, requestType: 'can_use_tool' },
      choice: { optionId: 'allow_once', semantic: 'approve_once' },
    } } }]
  }
  return { ...result, row, claim, start, profiles, proof, ready, queries, workflow,
    get frames() { return queries.at(-1)?.frames ?? initialFrames },
    sdkQuery, loadClient, query, factories, setMcpServers, harness, binding, installations, launcher }
}

export async function managementEndpoint(token: string | readonly string[] = 'synthetic-scoped-token') {
  // MCP client close aborts fetch without joining its socket shutdown.
  const app = Fastify({ forceCloseConnections: true })
  const list = vi.fn(async () => ({ items: [], pageInfo: { nextCursor: null } }))
  const principal = { id: 'sender', name: 'Sender', audience: 'operator' as const,
    grants: [{ actions: ['workspaces:read' as const], scope: {} }], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  app.post('/mcp', async (request, reply) => {
    if (!(typeof token === 'string' ? [token] : token).some(value => request.headers.authorization === `Bearer ${value}`)) return reply.code(401).send()
    const server = new McpServer({ name: 'graphql', version: '1.0.0' })
    registerOperatorToolGroup(server, { principal, services: { workspaces: { list } } } as unknown as OperatorRequestContext, workspaceTools)
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    reply.raw.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(request.raw, reply.raw, request.body)
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  return { app, list, url: `${address}/mcp` }
}

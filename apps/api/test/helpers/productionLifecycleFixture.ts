import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './testResources.js'
import { randomUUID } from 'node:crypto'
import { agentWorkflowVersion } from './agentWorkflowFixture.js'

import { CODEX_APPROVAL_OPTIONS_FIXTURE, type ExecutionResult, type NativeHarnessEvent, type NativeSessionReference, type PendingNativeInteraction } from '@foreman-code/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import pg from 'pg'
import { afterEach, beforeEach, expect, vi } from 'vitest'

import { loadConfig } from '../../src/config.js'
import { createDatabase } from '../../src/infrastructure/database.js'
import { createCheckpointStore } from '../../src/infrastructure/checkpoints.js'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { seedAgent3 } from './wave25Agent3.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import type { NativeHistory, WorkflowNativeSessionStart } from '../../src/modules/harnesses/port.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { ReviewerDispatcher } from '../../src/modules/interactions/reviewer.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { approvalFixture } from './wave25ApprovalFixture.js'
import { buildProductionApp } from '../../src/production.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

const connectionString = process.env.TEST_DATABASE_URL!
let schema: string
let root: string
let fileRoot: string
export let project: string
export let address: string
let admin: pg.Pool
export let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
export let production: ReturnType<typeof buildProductionApp>
let config: ReturnType<typeof loadConfig>
export let runs: PostgresRunRepository
export let interactions: PostgresInteractionRepository
export let access: PostgresAccessService
const success: ExecutionResult = { outcome: 'succeeded', output: { text: 'workflow result' } }
type ProviderSession = { input: WorkflowNativeSessionStart; pending: PendingNativeInteraction[]; turns: Map<string, ExecutionResult | undefined>; asks: number }
type Connection = { id: string; events: NativeHarnessEvent[]; token: string; sessionId: string }
let sessions: Map<string, ProviderSession>, connections: WeakMap<object, Connection>
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 })
let repeatedApproval = false
let reviewNoDecision = false
export let native: { starts: string[]; attaches: number; responses: number; inspections: number; closes: number }

function event(manager: object, type: string, payload: Record<string, unknown>) {
  const local = connections.get(manager)!
  const value = { connectionId: local.id, sequence: local.events.length, type, payload, occurredAt: new Date().toISOString() }
  local.events.push(value)
  return value
}
function ask(reference: NativeSessionReference, suffix: number): PendingNativeInteraction {
  const saved = sessions.get(reference.nativeSessionId)!
  const turnId = [...saved.turns.keys()][0]!
  return { session: reference, turn: { nativeTurnId: turnId, nativeRequestId: `ask-${reference.nativeSessionId}-${suffix}` },
    nativeRequestType: 'item/commandExecution/requestApproval', request: {
      itemId: `item-${reference.nativeSessionId}-${suffix}`, turnId, threadId: reference.nativeSessionId,
      command: 'test', cwd: saved.input.request.workingDirectory,
    }, responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE }
}
export function runtime() { return Reflect.get(production.engine, 'nativeExecutions') as ApprovalExecutionCoordinator }
export async function mcp(token: string, input: Record<string, unknown>) {
  const client = new Client({ name: 'production-review', version: '1.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return await client.callTool({ name: 'interaction_respond', arguments: input })
  } finally { await client.close() }
}
export function registerProductionLifecycleFixture() {
  beforeEach(async () => {
    schema = `production_lifecycle_${randomUUID().replaceAll('-', '')}`
    root = await privateFixtureDirectory('pr15-runtime-')
    project = await privateFixtureDirectory('pr15-project-')
    fileRoot = await privateFixtureDirectory('lifecycle-files-')
    admin = new pg.Pool({ connectionString })
    await createFixtureSchema(admin, schema)
    await createFixtureSchema(admin, `${schema}_checkpoints`)
    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schema}`)
    config = loadConfig({ DATABASE_URL: url.toString(), DATABASE_POOL_MAX: '1', DATABASE_QUERY_TIMEOUT_MS: '5000', HARNESS_WORKSPACE_ROOT: root, HARNESS_TIMEOUT_MS: '30000', PORT: '4100' })
    config.workspaceStorageRoot = project
    config.fileStorageRoot = fileRoot
    database = createDatabase(config.database)
    await database.migrate()
    checkpoints = createCheckpointStore(config.database.connectionString, `${schema}_checkpoints`, config.database)
    await checkpoints.setup()
    access = new PostgresAccessService(database.pool)
    sessions = new Map(); connections = new WeakMap(); repeatedApproval = false; reviewNoDecision = false
    native = { starts: [], attaches: 0, responses: 0, inspections: 0, closes: 0 }
    // Only the native provider transport is doubled. Credentials, ownership,
    // lanes, delivery, budgets, checkpoints, HTTP and MCP use production wiring.
    vi.spyOn(CodexAppServerSessionManager.prototype, 'inspectMcpConfiguration').mockImplementation(async (cwd) => {
      native.inspections++
      return { providerVersion: '0.154.0', binary: 'fixture', cwd, serverName: 'foreman-code', inspectionScope: 'effective_config', configured: {
        enabled: true, required: true, transport: 'streamable_http', url: 'http://127.0.0.1:4100/mcp',
        bearerTokenEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN', enabledTools: null, disabledTools: [], defaultToolsApprovalMode: null, tools: {},
      } }
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async function (this: CodexAppServerSessionManager, input) {
      if (!isWorkflowStart(input)) throw new Error('Unexpected Operator launch')
      const reference = { harness: this.harness, providerVersion: '0.154.0', nativeSessionId: `session-${input.request.executionId}` }
      sessions.set(reference.nativeSessionId, { input, pending: [], turns: new Map(), asks: 0 })
      connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.FOREMAN_CODE_MCP_TOKEN!, sessionId: reference.nativeSessionId })
      return reference
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession').mockImplementation(async function (this: CodexAppServerSessionManager, reference, input) {
      native.attaches++
      if (!sessions.has(reference.nativeSessionId)) throw new Error('Cannot replace a native session')
      connections.set(this, { id: randomUUID(), events: [], token: input.environment!.variables.FOREMAN_CODE_MCP_TOKEN!, sessionId: reference.nativeSessionId })
      event(this, 'thread.attached', { threadId: reference.nativeSessionId })
      return reference
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (this: CodexAppServerSessionManager, reference, input) {
      native.starts.push(input.clientCorrelationId)
      const turnId = input.clientCorrelationId
      const saved = sessions.get(reference.nativeSessionId)!
      saved.turns.set(input.clientCorrelationId, undefined)
      await input.onSubmitted?.(turnId)
      yield event(this, 'turn.started', { threadId: reference.nativeSessionId, turnId, clientCorrelationId: input.clientCorrelationId })
      if (input.clientCorrelationId.startsWith('review-')) {
        const interactionId = /interaction (\S+)\./.exec(input.prompt)![1]!
        const interaction = (await interactions.get(interactionId))!
        if (!reviewNoDecision) await mcp(connections.get(this)!.token, {
          interactionId, optionId: interaction.responseOptions[0]!.optionId, expectedRevision: interaction.revision,
        })
        saved.turns.set(input.clientCorrelationId, { outcome: 'succeeded', output: { text: 'review result' } })
      } else if (saved.input.request.workflowNodeId === 'orchestrator') saved.turns.set(input.clientCorrelationId, success)
      else {
        saved.pending = [ask(reference, ++saved.asks)]
        yield event(this, 'interaction.pending', { nativeRequestId: saved.pending[0]!.turn.nativeRequestId,
          nativeRequestType: saved.pending[0]!.nativeRequestType, turnId })
        return
      }
      yield event(this, 'turn.completed', { threadId: reference.nativeSessionId, turnId })
    })
    const history = function (manager: CodexAppServerSessionManager, reference: NativeSessionReference, correlationId?: string): NativeHistory {
      const saved = sessions.get(reference.nativeSessionId)!
      const result = correlationId ? saved.turns.get(correlationId) : undefined
      if (correlationId) event(manager, 'thread.reconciled', { thread: { id: reference.nativeSessionId,
        status: saved.pending.length ? 'active' : 'idle', turns: [...saved.turns].map(([id, value]) => ({ id: id, clientUserMessageId: id, status: value ? 'completed' : 'inProgress' })) } })

      return { events: [...connections.get(manager)!.events], pendingInteractions: [...saved.pending],
        ...(result && correlationId ? { correlationId, nativeTurnId: correlationId,
          terminalResult: result, terminalTurn: { correlationId, providerId: correlationId, result } } : {}) }
    }
    vi.spyOn(CodexAppServerSessionManager.prototype, 'history').mockImplementation(async function (this: CodexAppServerSessionManager, reference) { return history(this, reference) })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcileResponse').mockImplementation(async function (this: CodexAppServerSessionManager, reference) {
      return history(this, reference, `execution:${sessions.get(reference.nativeSessionId)!.input.request.executionId}`)
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async function (this: CodexAppServerSessionManager, reference, correlation) { return history(this, reference, correlation) })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'pending').mockImplementation(async function (_reference) {
      return sessions.get(_reference.nativeSessionId)?.pending[0]
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'respond').mockImplementation(async function (this: CodexAppServerSessionManager, reference, requestId, option) {
      const saved = sessions.get(reference.nativeSessionId)!
      const pending = saved.pending.find((item) => item.turn.nativeRequestId === requestId)
      expect(pending).toBeDefined()
      native.responses++
      event(this, 'interaction.submitted', { nativeRequestId: requestId, optionId: option.optionId, semantic: option.semantic })
      event(this, 'interaction.resolved', { nativeRequestId: requestId, submittedOptionId: option.optionId,
        evidence: 'serverRequest/resolved' })
      event(this, 'item.completed', { threadId: reference.nativeSessionId, turnId: pending!.turn.nativeTurnId,
        item: { id: (pending!.request as { itemId: string }).itemId, type: 'commandExecution', status: 'completed',
          command: 'test', cwd: (pending!.request as { cwd: string }).cwd, exitCode: 0 } })
      if (repeatedApproval && saved.input.request.workflowNodeId === 'worker-a' && saved.asks < 2) {
        saved.pending = [ask(reference, ++saved.asks)]
      } else {
        saved.pending = []
        saved.turns.set(`execution:${saved.input.request.executionId}`, success)
      }
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockImplementation(async () => { native.closes++ })
    vi.spyOn(ReviewerDispatcher.prototype, 'reconcile').mockResolvedValue() // manually drive the real dispatcher between crash boundaries
    production = buildProductionApp(config, database, checkpoints, false)
    production.registerFileStorage()
    runs = Reflect.get(production.engine, 'runs') as PostgresRunRepository
    interactions = Reflect.get(runtime(), 'interactions') as PostgresInteractionRepository
    await production.initialize()
    address = await production.app.listen({ host: '127.0.0.1', port: 0 })
  })

  afterEach(async () => {
    await production?.shutdown()
    await production?.app.close()
    await checkpoints?.close(); await database?.close()
    await (admin ? dropFixtureSchema(admin, schema) : Promise.resolve())
    await (admin ? dropFixtureSchema(admin, `${schema}_checkpoints`) : Promise.resolve())
    await admin?.end()
    await removeFixtureDirectory(root); await removeFixtureDirectory(project); await removeFixtureDirectory(fileRoot)
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })
}

export async function start(handler: 'user' | 'orchestrator', twoWorkers = false) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const workspaceId = 'workspace-1'
  const nodes = [{ id: 'orchestrator', agentId: 'agent-researcher', name: 'Orchestrator' },
    { id: 'worker-a', agentId: 'agent-reviewer', name: 'Worker A' },
    ...(twoWorkers ? [{ id: 'worker-b', agentId: 'agent-worker-b', name: 'Worker B' }] : [])]
  fixture.scope.workspaceId = workspaceId
  fixture.run.workspaceId = workspaceId
  fixture.configurations = nodes.map((node, index) => ({ ...fixture.configurations[index === 0 ? 0 : 1]!,
    id: `cfg-${node.agentId}`, workspaceId, agentId: node.agentId,
    productRole: index === 0 ? 'orchestrator' as const : 'coder' as const,
    harness: index === 0 && handler === 'orchestrator'
      ? structuredClone(approvalFixture().configurations[0]!.harness)
      : fixture.configurations[1]!.harness,
  }))
  const approval = { handler, ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'agent-researcher' } : {}) }
  fixture.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...fixture.version, workspaceId, approval, entryNodeId: 'orchestrator',
    agentConfigurationVersionIds: Object.fromEntries(fixture.configurations.map((item) => [item.agentId, item.id])),
    definition: { ...fixture.version.definition, workspaceId, nodes, entryNodeId: 'orchestrator', approval,
      edges: [ ...nodes.slice(1).map((node, index) => ({ id: `edge-${index}`, kind: 'execution', source: nodes[index]!.id, target: node.id })),
        ...(handler === 'orchestrator' ? nodes.slice(1).map((node) => ({ id: `approval-${node.id}`, kind: 'approval', source: 'orchestrator', target: node.id })) : []) ],
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: nodes.length },
    },
  }))
  await seedAgent3(database.pool, project, fixture, { run: false })
  const issuer = await access.issue({ name: 'Run owner', audience: 'operator', grants: [{ actions: ['runs:start', 'runs:stop', 'workspace_locations:read', 'workspace_locations:update', 'interactions:read', 'interactions:respond'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
  const locations = new WorkspaceLocationService(database.pool, new PostgresCommandCoordinator(database.pool), root)
  const location = await locations.set(issuer.principal, 'http', { workspaceId, commandId: randomUUID(),
    expectedLocationRevision: 1, runnerId: 'runner-local', rootPath: project })
  const version = fixture.version
  const saved = { id: fixture.scope.workflowId }
  const revision = Number((await database.pool.query('select revision from workflows where id=$1', [saved.id])).rows[0].revision)
  const accepted = await production.app.inject({ method: 'POST',
    url: `/api/management/workspaces/workspace-1/workflows/${saved.id}/runs`,
    headers: { authorization: `Bearer ${issuer.token}` },
    payload: { executionSemanticsVersion: 3, workflowVersionId: version.id, expectedWorkflowRevision: revision,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: location.value.locationRevision, commandId: randomUUID(), input: {} },
  })
  expect(accepted.statusCode, accepted.body).toBe(202)
  const run = accepted.json().run as NonNullable<Awaited<ReturnType<PostgresRunRepository['get']>>>
  try { await vi.waitFor(async () => expect((await runs.get(run.id))?.executionState).toBe('waiting'), { timeout: 60_000, interval: 10 }) }
  catch (error) {
    const facts = await database.pool.query('select record from harness_executions where run_id=$1', [run.id])
    throw new Error(JSON.stringify({ executions: facts.rows, activity: await runs.listActivity(run.id) }), { cause: error })
  }
  return { run, issuer, pending: (await interactions.list({ runId: run.id, status: 'pending', limit: 10 }))[0]! }
}


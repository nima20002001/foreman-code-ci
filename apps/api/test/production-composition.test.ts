import { CiListOutputSchema, CiRunRecordSchema, CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_HARNESS_DEFAULTS, DEFAULT_STUCK_EXECUTION_IDLE_MS, DurableInteractionSchema, type AgentConfigurationVersion, type DurableInteraction } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagementPrincipalSchema, type ManagementAction, type ManagementScope } from '@foreman-code/contracts/management'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresCommandReceiptRetention } from '../src/modules/commands/receiptRetention.js'
import { BugReportService } from '../src/modules/bug-reports/service.js'
import { DomainError } from '../src/modules/errors.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'

import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { buildProductionApp } from '../src/production.js'
import { randomUUID } from 'node:crypto'
import * as nativeRetention from '../src/modules/harnesses/installedNativeQualificationRetention.js'
import { ProductionDeviceRuntime } from '../src/modules/devices/productionRuntime.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { requireAuthorization } from '../src/modules/access/policy.js'

vi.mock('../src/app.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app.js')>()
  return { ...actual, buildApp: vi.fn(actual.buildApp) }
})

const config = loadConfig({ DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_composition' })
const scope = { workspaceIds: ['workspace-1'], workflowIds: ['workflow-1'], runIds: ['run-1'] }
function operator(actions: ManagementAction[] = ['interactions:read', 'interactions:respond'], grantScope: ManagementScope = scope) {
  return ManagementPrincipalSchema.parse({
    id: 'operator-1', name: 'Composition test Operator', audience: 'operator',
    grants: [{ actions, scope: grantScope }], revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
}
function interaction(overrides: Partial<DurableInteraction> = {}): DurableInteraction {
  return DurableInteractionSchema.parse({
    id: 'interaction-1', revision: 0, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: 'run-1', executionId: 'execution-1', requestingAgentId: 'agent-1', harness: 'codex',
    providerVersion: 'codex-cli 0.154.0', nativeSessionId: 'native-session-1', nativeRequestId: 'native-request-1',
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'run-1',
    request: { command: ['true'] }, approval: { handler: 'user' },
    responseOptions: CODEX_APPROVAL_OPTIONS_FIXTURE, status: 'pending', deliveryState: 'not_started',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  })
}

let principal = operator()
let current = interaction()
let database: ReturnType<typeof createDatabase>
let checkpoints: ReturnType<typeof createCheckpointStore>
let production: ReturnType<typeof buildProductionApp>
const list = vi.fn<InteractionService['list']>()
const get = vi.fn<InteractionService['get']>()
const respond = vi.fn<InteractionService['respond']>()

it('production recovery drains every delivery page and coalesces concurrent ticks', async () => {
  const recover = vi.spyOn(InteractionService.prototype, 'recover')
    .mockResolvedValueOnce({ nextCursor: 'next-interaction', errors: [] })
    .mockResolvedValueOnce({ nextCursor: null, errors: [] })
  vi.spyOn(production.engine, 'reconcile').mockResolvedValue()
  const report = vi.fn()
  const first = production.reconcile(report)
  const second = production.reconcile(report)
  expect(second).toBe(first)
  await Promise.all([first, second])
  expect(BugReportService.prototype.detectStuckExecutions)
    .toHaveBeenCalledExactlyOnceWith(DEFAULT_STUCK_EXECUTION_IDLE_MS)
  expect(recover.mock.calls).toEqual([[{ limit: 100 }], [{ limit: 100, afterId: 'next-interaction' }]])
  expect(RunWorktrees.prototype.cleanup).toHaveBeenCalledExactlyOnceWith(report)
  expect(PostgresCommandReceiptRetention.prototype.prune).toHaveBeenCalledExactlyOnceWith()
  expect(report).not.toHaveBeenCalled()
})

it('production shutdown closes recovery admission and waits for the in-flight pass', async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  vi.spyOn(production.engine, 'reconcile').mockImplementation(() => pending)
  vi.spyOn(production.engine, 'shutdown').mockResolvedValue()
  const recover = vi.spyOn(InteractionService.prototype, 'recover')
  const running = production.reconcile(vi.fn())
  const stopping = production.shutdown()
  finish()
  await Promise.all([running, stopping])
  await production.reconcile(vi.fn())
  expect(recover).not.toHaveBeenCalled()
  expect(BugReportService.prototype.detectStuckExecutions)
    .toHaveBeenCalledExactlyOnceWith(DEFAULT_STUCK_EXECUTION_IDLE_MS)
})

beforeEach(() => {
  principal = operator()
  current = interaction()
  list.mockReset().mockImplementation(async () => ({ items: [current], nextCursor: null }))
  get.mockReset().mockImplementation(async () => current)
  respond.mockReset().mockImplementation(async () => ({ interaction: current, replayed: false }))
  vi.spyOn(InteractionService.prototype, 'list').mockImplementation(list)
  vi.spyOn(InteractionService.prototype, 'get').mockImplementation(get)
  vi.spyOn(InteractionService.prototype, 'respond').mockImplementation(respond)
  vi.spyOn(PostgresCommandCoordinator.prototype, 'recordDenied').mockResolvedValue(undefined)
  vi.spyOn(RunWorktrees.prototype, 'cleanup').mockResolvedValue(undefined)
  vi.spyOn(PostgresCommandReceiptRetention.prototype, 'prune').mockResolvedValue(0)
  vi.spyOn(BugReportService.prototype, 'detectStuckExecutions').mockResolvedValue(0)
  vi.spyOn(PostgresAccessService.prototype, 'authenticate').mockImplementation(async (token, audience) => {
    const allowed = Array.isArray(audience) ? audience.includes(principal.audience) : principal.audience === audience
    if (token !== 'test-operator' || !allowed) throw new DomainError('AUTH_REQUIRED', 'Authentication required.', 401)
    return principal
  })
  vi.mocked(buildApp).mockClear()
  // These are the production infrastructure constructors. No test assembles a
  // separate service graph, and no query/native process is needed for these checks.
  database = createDatabase(config.database)
  checkpoints = createCheckpointStore(config.database.connectionString, 'composition_checkpoints', config.database)
  production = buildProductionApp(config, database, checkpoints, false)
})

afterEach(async () => {
  await production.app.close()
  await production.engine.shutdown()
  await Promise.all([database.close(), checkpoints.close()])
  vi.restoreAllMocks()
})

it('completes authenticated MCP discovery without delayed socket cleanup errors', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const response = await production.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: 'Bearer test-operator',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
    expect(response.statusCode, response.body).toBe(200)
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    expect(message).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'interaction_get' })]) },
    })
    // Run deferred response cleanup while this request still belongs to the test.
    await vi.advanceTimersByTimeAsync(1_000)
  } finally {
    vi.useRealTimers()
  }
})

it('serves parsed MCP discovery over Node HTTP and rejects an unauthenticated caller', async () => {
  const address = await production.app.listen({ host: '127.0.0.1', port: 0 })
  const call = (token: string) => fetch(`${address}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'socket-discovery', method: 'tools/list' }),
  })
  const response = await call('test-operator')
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const message = JSON.parse(body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
  expect(message).toMatchObject({
    jsonrpc: '2.0',
    id: 'socket-discovery',
    result: { tools: expect.arrayContaining([expect.objectContaining({ name: 'interaction_get' })]) },
  })
  const denied = await call('invalid-operator')
  expect(denied.status).toBe(401)
  expect(await denied.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } })
})

it('serves the Board and Operator CI list after production initializes CI, with scoped read access', async () => {
  const services = vi.mocked(buildApp).mock.calls.at(-1)![0].operator!.services
  const url = '/api/management/workspaces/workspace-1/ci?runId=run-1'
  const headers = { authorization: 'Bearer test-operator' }
  principal = operator([...CI_GET_ACTIONS, 'runs:read'], { workspaceIds: ['workspace-1'] })
  const starting = await production.app.inject({ method: 'GET', url, headers })
  expect(starting.statusCode).toBe(503)
  expect(starting.json().error.code).toBe('CI_UNAVAILABLE')

  const record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace-1',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'unit', part: 'unit-api',
    scope: 'affected', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'passed', computer: { hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'github', slot: 0 },
      label: 'GitHub Actions 1' }, step: 'unit-api', exitCode: 0, message: null,
    queuedAt: '2026-10-12T00:00:00.000Z', startedAt: '2026-10-12T00:00:01.000Z',
    finishedAt: '2026-10-12T00:00:10.000Z', initiator: { principalId: 'worker-1', executionId: 'execution-1' },
  })
  const tests = { passed: 10, failed: 0, skipped: 1 }
  const pool = { query: vi.fn(async () => ({ rows: [{ workflow_id: 'workflow-1', record, tests,
    execution_id: 'execution-1', agent_id: 'agent-1', node_id: 'node-1', node_name: 'Checker' }], rowCount: 1,
    command: 'SELECT', oid: 0, fields: [] })) } as unknown as typeof database.pool
  const endpoint: HostCiEndpoint = {
    computers: vi.fn(async () => []),
    request: vi.fn(async () => { throw new Error('CI reads must use stored tickets') }),
  }
  services.ci = new HostCiService(pool, new PostgresCommandCoordinator(pool), {
    resolve: async (caller, workspaceId, actions) => {
      for (const action of actions) requireAuthorization(caller, action, { workspaceId: workspaceId! })
      return { principal: caller, workspaceId: workspaceId! }
    },
  }, {} as CiCommits, endpoint)
  const response = await production.app.inject({ method: 'GET', url, headers })
  expect(response.statusCode).toBe(200)
  const listed = CiListOutputSchema.parse(response.json())
  expect(listed).toMatchObject({ runId: 'run-1', truncated: false, jobs: [{ ticketId: record.id,
    ci: { state: 'passed' }, placement: 'github', requester: { nodeId: 'node-1', agentId: 'agent-1' }, tests }] })
  const mcp = () => production.app.inject({ method: 'POST', url: '/mcp',
    headers: { ...headers, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ci_list', arguments: { workspaceId: 'workspace-1', runId: 'run-1' } } },
  })
  const readback = await mcp()
  expect(readback.statusCode, readback.body).toBe(200)
  const message = JSON.parse(readback.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
  expect(CiListOutputSchema.parse(decodeMcpToolResult(message.result))).toEqual(listed)
  principal = { ...principal, grants: [] }
  expect((await production.app.inject({ method: 'GET', url, headers })).statusCode).toBe(403)
  expect((await mcp()).body).toContain('ACCESS_DENIED')
  principal = operator(CI_GET_ACTIONS, { workspaceIds: ['workspace-1'] })
  expect((await production.app.inject({ method: 'GET', url, headers })).statusCode).toBe(403)
  principal = operator([...CI_GET_ACTIONS, 'runs:read'], { workspaceIds: ['other-workspace'] })
  expect((await production.app.inject({ method: 'GET', url, headers })).statusCode).toBe(403)
  expect(endpoint.request).not.toHaveBeenCalled()
})

it('retains Worker qualification against the outgoing profile-check channel', async () => {
  await production.app.close()
  const retained = vi.spyOn(nativeRetention, 'createInstalledNativeQualificationRetention')
  const binding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1, keyRevision: 1, authorizationRevision: 1 }
  const captureRequest = vi.fn(() => ({ binding, request: vi.fn() }))
  const currentBinding = vi.fn(() => undefined)
  vi.spyOn(ProductionDeviceRuntime.prototype, 'endpointForDomains').mockReturnValue(
    { captureRequest, currentBinding } as unknown as DeviceEndpoint)
  const run = vi.fn(async () => { throw new Error('Construction must not qualify a native runtime') })
  production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, { codex: { harness: 'codex', revision: 'fixture', run } })
  expect(retained.mock.calls[0]![0].currentBinding(binding.deviceId)).toEqual(binding)
  expect(captureRequest).toHaveBeenCalledExactlyOnceWith(binding.deviceId, 'host-harness-check-v1')
  expect(currentBinding).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it.each(['codex'] as const)('constructs separate native %s managers for each accepted execution', (harness) => {
  const approvals: object = Reflect.get(production.engine, 'nativeExecutions') as object
  const managers = Reflect.get(approvals, 'managers') as NativeSessionManagerResolver
  // The factory consumes the harness portion; the execution coordinator validates
  // the complete durable configuration before it calls this factory.
  const configuration = {
    id: 'config-1', agentId: 'agent-1',
    harness: DEFAULT_HARNESS_DEFAULTS.codex,
  } as AgentConfigurationVersion
  const context = { executionId: 'execution-1', agentId: 'agent-1', workingDirectory: '/accepted/project', harness, configuration }
  const first = managers.resolve(context)
  expect(first.manager).toBeInstanceOf(CodexAppServerSessionManager)
  expect(first.processState).toBe('needs_start')

  expect(managers.resolve(context)).toMatchObject({ manager: first.manager, processState: 'needs_start', lifecycle: 'allocated' })
  const second = managers.resolve({ ...context, executionId: 'execution-2' })
  expect(second.manager).not.toBe(first.manager)
  expect(() => managers.resolve({ ...context, workingDirectory: '/unaccepted' })).toThrow()
})

it('does not register the removed Operator approval HTTP routes', async () => {
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions' })).toBe(false)
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions/:interactionId' })).toBe(false)
  expect(production.app.hasRoute({ method: 'POST', url: '/api/interactions/:interactionId/respond' })).toBe(false)
})

it('exposes Run-owned chat over authenticated HTTP and MCP in production', async () => {
  principal = operator(['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'])
  const discovery = await production.app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: 'Bearer test-operator', accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 'execution-chat-discovery', method: 'tools/list' },
  })
  expect(discovery.statusCode, discovery.body).toBe(200)
  const message = JSON.parse(discovery.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
  expect(message.result.tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'agent_chat_cancel_all_queued' }),
  ]))
  const target = { kind: 'workflow_execution',
    agent: { workspaceId: 'workspace-1', workflowId: 'workflow-1', workflowNodeId: 'node-1', agentId: 'agent-1' },
    execution: { runId: 'run-1', workflowVersionId: 'version-1', executionId: 'execution-1', attempt: 1 } }
  const denied = await production.app.inject({ method: 'POST',
    url: '/api/workspaces/workspace-1/workflows/workflow-1/execution-chat/read',
    headers: { authorization: 'Bearer invalid-operator' }, payload: { target } })
  expect(denied.statusCode, denied.body).toBe(401)
})

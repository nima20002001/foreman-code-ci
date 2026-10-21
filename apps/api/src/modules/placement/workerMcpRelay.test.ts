import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Socket } from 'node:net'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { freezePlacement, deriveDispatch } from './binding.js'
import Fastify from 'fastify'
import { MainWorkerMcpRelay, selectedMainMcpForward, type SelectedMainMcpForward } from './workerMcpRelay.js'
import { isAuthorized } from '../access/policy.js'
import { createWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import { prepareWorkerApplicationAccess } from '../runs/remote/workerApplicationAccess.js'
import { encodeWorkerMcpResult, decodeWorkerMcpResult, WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { rejectableDeferred } from '../../../test/helpers/deferred.js'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from '@foreman-code/contracts/source-materialization'

const responseBudget = 2 * SOURCE_MATERIALIZATION_RECORD_MAX_BYTES

const ports = vi.hoisted(() => ({ intent: vi.fn(), placement: vi.fn(), host: vi.fn(), owner: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: ports.intent }))
vi.mock('./persistence.js', () => ({ readAcceptedPlacement: ports.placement }))
vi.mock('../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: ports.host }))
vi.mock('../access/runAuthority.js', () => ({ currentOperatorAuthority: ports.owner }))

const originalScope = { kind: 'temporary' as const, chat: { kind: 'agent' as const, conversationId: 'conversation',
  workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', executionId: 'execution', agentId: 'agent' } }
const declarationsPolicy = { agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'] as ['create', 'append', 'seal', 'publish'] }
function fixture(nativeOutputs?: import('./workerMcpRelay.js').WorkerNativeOutputAuthorizationPort) {
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', mainInstallationId: 'main-installation',
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [], artifactOutputs: { version: 1, outputKeys: ['result'] } } })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const principal: ManagementPrincipal = { id: 'worker-principal', name: 'Workflow worker', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
  const binding = { execution_id: 'execution', run_id: 'run', workspace_id: 'workspace', workflow_id: 'workflow', agent_id: 'agent',
    purpose: 'workflow', revoked_at: null as Date | null, execution_state: 'running', run_state: 'running', authorization_principal_id: 'owner', stopped: false, cleanup: false }
  const state = { receipt: undefined as unknown, contextReady: false }
  const query = vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    let rows: Record<string, unknown>[] = []
    if (sql.includes('from worker_credential_bindings')) rows = [binding]
    if (sql.includes('from remote_execution_receipts') && state.receipt) rows = [{ receipt: state.receipt }]
    if (sql.includes('from operator_conversations') && state.contextReady) rows = [{ id: 'conversation' }]
    return { rows, rowCount: rows.length }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  ports.intent.mockResolvedValue(intent); ports.placement.mockResolvedValue(placement)
  ports.host.mockResolvedValue({ keyRevision: 1, authorizationRevision: 1 })
  ports.owner.mockResolvedValue({ principal: { id: 'owner', name: 'Owner', audience: 'operator', grants: [{ actions: ['runs:start'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }], expiresAt: principal.expiresAt, revokedAt: null } })
  const forward = vi.fn<SelectedMainMcpForward['request']>(async () => ({
    statusCode: 200, contentType: 'application/json', body: '{"ok":true}',
  }))
  const createRelay = () => new MainWorkerMcpRelay(mainId, pool,
    { authenticate: async () => principal }, { request: forward }, nativeOutputs)
  const relay = createRelay()
  const applicationAccess = { kind: 'scoped-worker-mcp' as const, token: 'original-worker-bearer', executionId: intent.executionId,
    agentId: 'agent', operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash }
  const request = { version: 1, operation: 'worker-mcp.authorize', intent, placement, applicationAccess }
  const connection = { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  return { relay, createRelay, principal, binding, request, connection, forward, query, state }
}
describe('Main worker MCP relay with original binding doubles and real worker scope policy', () => {
  it('waits for the original native ACK and admitted file context without granting a mutation', async () => {
    const authorize = vi.fn(async () => structuredClone(originalScope))
    const f = fixture({ authorize, authorizeDeclarations: async () => declarationsPolicy })
    const request = { ...f.request, operation: 'worker-mcp.native-output-readiness',
      nativeSessionId: 'original-session', turnId: 'original-turn' }
    expect(await f.relay.handle(request, f.connection)).toMatchObject({ ready: false })
    f.state.receipt = { schemaVersion: 1, intent: f.request.intent, connection: f.connection,
      workerIncarnationId: randomUUID(), sequence: 1, phase: 'running', entryAttempted: true,
      turnEntryAttempted: true, stopFence: false, controls: [],
      native: { sessionId: request.nativeSessionId, turnId: request.turnId, processIdentityDigest: 'a'.repeat(64) } }
    expect(await f.relay.handle(request, f.connection)).toMatchObject({ ready: false })
    f.state.contextReady = true
    expect(await f.relay.handle(request, f.connection)).toMatchObject({ ready: true })
    expect(authorize).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
    await expect(f.relay.handle({ ...request, turnId: 'another-turn' }, f.connection))
      .rejects.toMatchObject({ code: 'WORKER_MCP_SCOPE_CONFLICT' })
    f.binding.revoked_at = new Date()
    await expect(f.relay.handle(request, f.connection)).rejects.toMatchObject({ code: 'WORKER_MCP_LEASE_UNAVAILABLE' })
  })

  it('keeps the original authenticated worker endpoint through Main restart and owner reconciliation', async () => {
    const f = fixture()
    const root = await privateFixtureDirectory('worker-mcp-restart-')
    let intent = f.request.intent
    let selectedMain = f.relay
    let main = Fastify()
    let endpoint: Awaited<ReturnType<typeof createWorkerMcpEndpoint>> | undefined
    const openMain = async () => {
      main.post('/mcp', (request, reply) => {
        if (request.headers.authorization !== `Bearer ${f.request.applicationAccess.token}`) {
          return reply.code(401).send({ error: 'Worker credential denied' })
        }
        return { jsonrpc: '2.0', id: 1, result: { tools: [] } }
      })
      await main.listen({ host: '127.0.0.1', port: 0 })
      f.forward.mockImplementation(selectedMainMcpForward(main).request)
    }
    try {
      await openMain()
      const relay = await prepareWorkerApplicationAccess({ request: async (_namespace, raw, options) => ({
        payload: await selectedMain.handle(raw, f.connection, options?.signal),
      }) }, f.request.intent, f.request.placement, f.request.applicationAccess,
      new AbortController().signal, { currentIntent: () => intent })
      const environment = relay.environment
      endpoint = await createWorkerMcpEndpoint({ relay, launcher: join(root, 'graphql-mcp.mjs'),
        signal: new AbortController().signal })
      const originalEndpoint = endpoint.endpoint
      const requestWorker = (token = f.request.applicationAccess.token) => fetch(endpoint!.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect((await requestWorker()).status).toBe(200)

      await main.close()
      const renewed = { ...intent, owner: { grantId: 'replacement-owner-grant', epoch: '2' } }
      ports.intent.mockResolvedValue(renewed)
      selectedMain = f.createRelay()
      main = Fastify()
      await openMain()
      await expect(endpoint.refreshLease()).rejects.toMatchObject({ code: 'WORKER_MCP_SCOPE_CONFLICT' })
      intent = renewed
      await endpoint.refreshLease()
      const recovered = await requestWorker()
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({ result: { tools: [] } })
      expect(relay.environment).toBe(environment)
      expect(environment.variables.GRAPHQL_MCP_TOKEN).toBe(f.request.applicationAccess.token)
      expect(endpoint.endpoint).toBe(originalEndpoint)
      const repeated = await requestWorker()
      expect(repeated.status).toBe(200)
      expect(await repeated.json()).toMatchObject({ result: { tools: [] } })

      f.forward.mockClear()
      expect((await requestWorker('foreign-worker-token')).status).toBe(401)
      expect(f.forward).not.toHaveBeenCalled()
      f.principal.grants = []
      await expect(endpoint.refreshLease()).rejects.toMatchObject({ status: 403 })
      expect((await requestWorker()).status).toBe(502)
      expect(f.forward).not.toHaveBeenCalled()
    } finally {
      await endpoint?.close()
      await main.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not infer native mutation permission from a valid application lease', async () => {
    const f = fixture()
    await expect(f.relay.handle({ ...f.request, operation: 'worker-mcp.authorize-native-output', outputOperation: 'create',
      nativeSessionId: 'original-session', turnId: 'original-turn' }, f.connection)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
    expect(f.forward).not.toHaveBeenCalled()
  })
  it('denies a completed reviewer even with a valid scoped application lease', async () => {
    const authorize = vi.fn(async () => structuredClone(originalScope)), f = fixture({ authorize, authorizeDeclarations: async () => declarationsPolicy })
    f.binding.purpose = 'reviewer'; f.binding.execution_state = 'completed'
    await expect(f.relay.handle({ ...f.request, operation: 'worker-mcp.authorize-native-output', outputOperation: 'create',
      nativeSessionId: 'original-session', turnId: 'original-turn' }, f.connection)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_DENIED' })
    expect(authorize).not.toHaveBeenCalled()
  })
  it.each(['create', 'append', 'seal', 'publish'] as const)('requires the mounted original authority for each %s operation and retry', async outputOperation => {
    const authorize = vi.fn(async () => structuredClone(originalScope))
    const f = fixture({ authorize, authorizeDeclarations: async () => declarationsPolicy })
    const request = { ...f.request, operation: 'worker-mcp.authorize-native-output', outputOperation,
      nativeSessionId: 'original-session', turnId: 'original-turn' }
    for (let i = 0; i < 2; i++) expect(await f.relay.handle(request, f.connection)).toMatchObject({
      outputOperation, nativeSessionId: request.nativeSessionId, turnId: request.turnId, scope: originalScope,
    })
    expect(authorize).toHaveBeenCalledTimes(2)
    authorize.mockRejectedValueOnce(new Error('permission withdrawn'))
    await expect(f.relay.handle(request, f.connection)).rejects.toThrow('permission withdrawn')
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('rollback')
  })

  it('checks declaration permission without native session or turn facts', async () => {
    const authorize = vi.fn(async () => structuredClone(originalScope))
    const authorizeDeclarations = vi.fn(async () => declarationsPolicy)
    const f = fixture({ authorize, authorizeDeclarations })
    const request = { ...f.request, operation: 'worker-mcp.authorize-native-output-declarations' }
    expect(await f.relay.handle(request, f.connection)).toMatchObject(declarationsPolicy)
    expect(authorizeDeclarations).toHaveBeenCalledWith(request, f.connection, expect.objectContaining({ query: f.query }))
    expect(authorize).not.toHaveBeenCalled()
    expect(f.forward).not.toHaveBeenCalled()
    await expect(f.relay.handle({ ...request, nativeSessionId: 'fabricated', turnId: 'fabricated' }, f.connection)).rejects.toThrow()
    authorizeDeclarations.mockResolvedValueOnce({ ...declarationsPolicy, agentConfigurationVersionId: 'foreign' })
    await expect(f.relay.handle(request, f.connection)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_DENIED' })
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('rollback')
  })
  it('rejects a foreign provider scope before committing authorization', async () => {
    const f = fixture({ authorize: async () => ({ ...originalScope, chat: { ...originalScope.chat, workspaceId: 'foreign' } }),
      authorizeDeclarations: async () => declarationsPolicy })
    await expect(f.relay.handle({ ...f.request, operation: 'worker-mcp.authorize-native-output', outputOperation: 'create',
      nativeSessionId: 'original-session', turnId: 'original-turn' }, f.connection)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_DENIED' })
    expect(f.query.mock.calls.at(-1)?.[0]).toBe('rollback')
  })

  it('admits a complete workflow scope without granting the worker Operator policy access', async () => {
    const f = fixture()
    expect(isAuthorized(f.principal, 'interactions:read', { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run' })).toBe(false)
    expect(await f.relay.handle(f.request, f.connection)).toMatchObject({ audience: 'worker', principalId: f.principal.id, executionId: 'execution' })
    expect(f.forward).not.toHaveBeenCalled()
    expect(f.query.mock.calls.some(([sql]) => sql.includes("he.record->>'state' as execution_state"))).toBe(true)
    expect(await f.relay.handle({ ...f.request, operation: 'worker-mcp.request', body: { method: 'tools/list' } }, f.connection)).toMatchObject({ statusCode: 200 })
    expect(f.forward).toHaveBeenCalledWith({ method: 'tools/list' }, 'original-worker-bearer', undefined, undefined)
  })
  it.each(['foreign-workspace', 'foreign-workflow', 'foreign-run', 'split-grants', 'expired', 'revoked'] as const)('denies %s without forwarding', async reason => {
    const f = fixture()
    if (reason === 'foreign-workspace') f.principal.grants[0]!.scope.workspaceIds = ['foreign']
    if (reason === 'foreign-workflow') f.principal.grants[0]!.scope.workflowIds = ['foreign']
    if (reason === 'foreign-run') f.principal.grants[0]!.scope.runIds = ['foreign']
    if (reason === 'split-grants') f.principal.grants = [
      { actions: ['interactions:read'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['foreign'] } },
      { actions: ['interactions:read'], scope: { workspaceIds: ['foreign'], workflowIds: ['workflow'], runIds: ['run'] } },
    ]
    if (reason === 'expired') f.principal.expiresAt = new Date(0).toISOString()
    if (reason === 'revoked') f.principal.revokedAt = new Date().toISOString()
    await expect(f.relay.handle({ ...f.request, operation: 'worker-mcp.request', body: {} }, f.connection)).rejects.toMatchObject({ status: 403 })
    expect(f.forward).not.toHaveBeenCalled()
  })
  it.each(['wrong-purpose', 'ended-workflow', 'wrong-agent', 'stopped', 'cleanup', 'revoked-binding'] as const)('retains %s original binding denial', async reason => {
    const f = fixture()
    if (reason === 'wrong-purpose') f.binding.purpose = 'unknown'
    if (reason === 'ended-workflow') f.binding.execution_state = 'completed'
    if (reason === 'wrong-agent') f.binding.agent_id = 'foreign'
    if (reason === 'stopped') f.binding.stopped = true
    if (reason === 'cleanup') f.binding.cleanup = true
    if (reason === 'revoked-binding') f.binding.revoked_at = new Date()
    await expect(f.relay.handle(f.request, f.connection)).rejects.toMatchObject({ code: 'WORKER_MCP_LEASE_UNAVAILABLE' })
    expect(f.forward).not.toHaveBeenCalled()
  })
})

it('passes cancellation of the authenticated worker request to the original Main call', async () => {
  const f = fixture()
  const entered = rejectableDeferred<AbortSignal>()
  f.forward.mockImplementation(async (_body, _token, _protocol, signal) => new Promise<never>((_resolve, reject) => {
    if (!signal) throw new Error('Missing original request signal')
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    entered.resolve(signal)
  }))
  const controller = new AbortController()
  const cause = new Error('Worker request cancelled')
  const pending = f.relay.handle({ ...f.request, operation: 'worker-mcp.request', body: { method: 'tools/list' } },
    f.connection, controller.signal)
  const rejected = expect(pending).rejects.toBe(cause)
  expect(await entered.promise).toBe(controller.signal)
  controller.abort(cause)
  await rejected
  expect(f.forward).toHaveBeenCalledWith({ method: 'tools/list' }, 'original-worker-bearer', undefined, controller.signal)
})

it('rejects an already cancelled request before forwarding any worker effect', async () => {
  const f = fixture()
  const cause = new Error('Worker request cancelled')
  await expect(f.relay.handle({ ...f.request, operation: 'worker-mcp.request', body: {} },
    f.connection, AbortSignal.abort(cause))).rejects.toBe(cause)
  expect(f.forward).not.toHaveBeenCalled()
})

describe('selected Main fixed artifact tool routing', () => {
  it('closes the authenticated Main HTTP request when its worker request is cancelled', async () => {
    const app = Fastify()
    const entered = rejectableDeferred<void>()
    const disconnected = rejectableDeferred<void>()
    app.post('/mcp', (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer original-worker-bearer')
      reply.hijack()
      reply.raw.once('close', () => disconnected.resolve())
      entered.resolve()
    })
    const controller = new AbortController()
    const cause = new Error('Worker request cancelled')
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const pending = selectedMainMcpForward(app).request({ method: 'tools/list' },
        'original-worker-bearer', '2025-03-26', controller.signal)
      const rejected = expect(pending).rejects.toBe(cause)
      await entered.promise
      controller.abort(cause)
      await rejected
      await disconnected.promise
    } finally {
      controller.abort(cause)
      app.server.closeAllConnections()
      await app.close()
    }
  })
  it.each([
    ['files.admit_transferred_result', '/mcp/artifact-transfers'],
    ['files.read_edge_input', '/mcp/artifact-inputs'],
    ['files.publish_transferred_result', '/mcp/artifact-publications'],
    ['interaction_list', '/mcp'],
    ['/mcp/artifact-publications', '/mcp'],
  ])('forwards %s to its fixed path with the original worker bearer', async (name, expected) => {
    const app = Fastify()
    for (const url of ['/mcp', '/mcp/artifact-transfers', '/mcp/artifact-inputs', '/mcp/artifact-publications']) app.post(url, request => {
      expect(request.raw.socket).toBeInstanceOf(Socket)
      expect(typeof request.raw.socket.destroySoon).toBe('function')
      return { path: request.url, authorization: request.headers.authorization, protocolVersion: request.headers['mcp-protocol-version'] }
    })
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const response = await selectedMainMcpForward(app).request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} }, destination: '/caller-selected' }, 'original-worker-bearer', '2025-03-26')
      expect(JSON.parse(response.body)).toEqual({ path: expected, authorization: 'Bearer original-worker-bearer', protocolVersion: '2025-03-26' })
    } finally { await app.close() }
  })
  it('keeps ordinary discovery on the common MCP endpoint', async () => {
    const app = Fastify(); app.post('/mcp', () => ({ common: true }))
    try {
      await app.listen({ host: '127.0.0.1', port: 0 })
      expect(JSON.parse((await selectedMainMcpForward(app).request({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { name: 'files.read_edge_input' } }, 'original-worker-bearer')).body)).toEqual({ common: true })
    } finally { await app.close() }
  })
  it('refuses an unavailable listener and oversized responses', async () => {
    const app = Fastify()
    app.post('/mcp', (_request, reply) => reply.type('application/json').send('x'.repeat(responseBudget + 1)))
    const forward = selectedMainMcpForward(app)
    try {
      await expect(forward.request({}, 'worker-token')).rejects.toMatchObject({ code: 'WORKER_MCP_UNAVAILABLE' })
      await app.listen({ host: '127.0.0.1', port: 0 })
      await expect(forward.request({}, 'worker-token')).rejects.toMatchObject({ code: 'WORKER_MCP_RESPONSE_INVALID' })
    } finally { await app.close() }
  })
})

it('relays a quote-heavy authenticated CI read within the complete device envelope without replay', async () => {
  const f = fixture()
  const app = Fastify()
  const result = { jsonrpc: '2.0', id: 1, result: { structuredContent: {
    ticketId: 'ticket', state: 'passed', testStatus: { message: '\\"'.repeat(220_000) },
  } } }
  const body = JSON.stringify(result)
  expect(Buffer.byteLength(body)).toBeLessThan(1_000_000)
  expect(Buffer.byteLength(JSON.stringify({ statusCode: 200, contentType: 'application/json', body })))
    .toBeGreaterThan(WORKER_MCP_EXTENSION.maxJsonBytes)
  let calls = 0
  app.post('/mcp', (request, reply) => {
    expect(request.headers.authorization).toBe(`Bearer ${f.request.applicationAccess.token}`)
    calls++
    return reply.type('application/json').send(body)
  })
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    f.forward.mockImplementation(selectedMainMcpForward(app).request)
    const relay = await prepareWorkerApplicationAccess({ request: async (_namespace, raw, options) => {
      const carrier = encodeWorkerMcpResult(await f.relay.handle(raw, f.connection, options?.signal))
      expect(Buffer.byteLength(JSON.stringify(carrier.payload))).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxJsonBytes)
      expect(carrier.bytes?.byteLength ?? 0).toBeLessThanOrEqual(WORKER_MCP_EXTENSION.maxBinaryBytes)
      return carrier
    } }, f.request.intent, f.request.placement, f.request.applicationAccess)
    const response = await relay.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ci_get', arguments: { ticketId: 'ticket', testStatus: true } } })
    expect(response).toEqual({ statusCode: 200, contentType: 'application/json', body })
    expect(calls).toBe(1)
    f.principal.revokedAt = new Date().toISOString()
    await expect(relay.request({ method: 'tools/list' })).rejects.toMatchObject({ status: 403 })
    expect(calls).toBe(1)
  } finally { await app.close() }
})

it('preserves binary response boundaries, SSE and HTTP status and rejects altered carrier lengths', () => {
  const response = { statusCode: 409, contentType: 'text/event-stream' as const,
    body: '"'.repeat(responseBudget) }
  const carrier = encodeWorkerMcpResult(response)
  expect(carrier.bytes?.byteLength).toBe(responseBudget)
  expect(decodeWorkerMcpResult(carrier)).toEqual(response)
  expect(() => decodeWorkerMcpResult({ ...carrier, bytes: carrier.bytes!.subarray(1) })).toThrow()
  expect(() => encodeWorkerMcpResult({ ...response, body: '"'.repeat(responseBudget + 1) })).toThrow()
})

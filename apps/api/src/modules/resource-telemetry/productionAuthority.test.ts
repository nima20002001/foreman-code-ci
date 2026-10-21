import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import type pg from 'pg'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import type { HarnessExecution, NativeSessionLane, NativeSessionReference } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DevicePresence, DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { DeviceNegotiatedExtension } from '@foreman-code/contracts/device-application'
import { TELEMETRY_LIMITS, TelemetrySelectorResultSchema, TelemetryReadResultSchema, type TelemetryCollectedBatch, type TelemetryIdentity, type TelemetrySelectorTarget, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { freezePlacement, deriveDispatch } from '../placement/binding.js'
import { ResourceTelemetryService } from './ingestion/service.js'
import { ResourceTelemetrySelectors, RESOURCE_TELEMETRY_SELECTOR_ROUTE, RESOURCE_TELEMETRY_SELECTOR_TOOL } from './readback/selector.js'
import { RESOURCE_TELEMETRY_READ_ROUTE, RESOURCE_TELEMETRY_READ_TOOL } from './readback/adapters.js'
import { registerResourceTelemetryRoutes } from '../../routes/resourceTelemetry.js'
import { registerResourceTelemetrySelectorRoutes } from '../../routes/resourceTelemetrySelector.js'
import { registerResourceTelemetryTools } from '../../mcp/operator/resourceTelemetry.js'
import { registerResourceTelemetrySelectorTools } from '../../mcp/operator/resourceTelemetrySelector.js'
import { createPassiveTelemetryAuthorities, type CapturedTelemetryNativeOwner, type CapturedRemoteTelemetryNativeOwner } from './productionAuthority.js'
import type { NativeLaunchObservation } from './collector/registryAdapter.js'
const mainId = '11111111-1111-4111-8111-111111111111', bootId = '33333333-3333-4333-8333-333333333333'
const context: Extract<TrustedTelemetryContext, { kind: 'main-local' }> = { kind: 'main-local', mainId, deviceId: mainId,
  applicationInstallationId: mainId, bootId, runtimeEpoch: 'actual-pg-backend-start', capability: 'resource-telemetry/v1' }
const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null, expiresAt: '2099-01-01T00:00:00Z',
  grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['workspace-1'], workflowIds: ['workflow-1'], runIds: ['run-1'] } }] }
const target: Extract<TelemetrySelectorTarget, { scope: 'owned' }> = { schemaVersion: 1, scope: 'owned', mainId,
  target: { kind: 'workflow-execution', workspaceId: 'workspace-1', workflowId: 'workflow-1', runId: 'run-1', nodeId: 'node-1', executionId: 'execution-1' } }
const computer: TelemetrySelectorTarget = { schemaVersion: 1, scope: 'computer', mainId, hostRef: { kind: 'main', mainId } }
const signal = () => new AbortController().signal

it.each(['runs', 'native_session_lanes', 'execution_dispatch_intents'] as const)(
  'resolves passive telemetry while a publisher holds %s', async table => {
    const s = setup(table)
    await expect(s.authorities.targets.resolveOwned(principal, target, signal()))
      .resolves.toMatchObject({ kind: 'owned', facts: { owner: { executionId: 'execution-1' } } })
    expect(s.sources[0]!.lane.revision).toBe(4)
  },
)

it('keeps one coherent owner epoch per passive read and observes a later renewal on the next read', async () => {
  const s = setup()
  s.afterLane(() => {
    const original = s.sources[0]!
    original.intent = { ...original.intent, owner: { ...original.intent.owner, epoch: '4' } }
  })
  await expect(s.authorities.targets.resolveOwned(principal, target, signal()))
    .resolves.toMatchObject({ kind: 'owned', facts: { owner: { owner: { epoch: '3' } } } })
  await expect(s.authorities.targets.resolveOwned(principal, target, signal()))
    .resolves.toMatchObject({ kind: 'owned', facts: { owner: { owner: { epoch: '4' } } } })
})

function source(index = 1) {
  const execution: HarnessExecution = { id: `execution-${index}`, runId: `run-${index}`, workflowNodeId: `node-${index}`, agentId: `agent-${index}`,
    agentConfigurationVersionId: `configuration-${index}`, attempt: 7, nativeSessionId: `native-${index}`, input: {}, state: 'running',
    createdAt: '2026-10-01T00:00:00Z', startedAt: '2026-10-01T00:00:01Z' }
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'captured-version', nativeSessionId: execution.nativeSessionId! }
  const capture: CapturedTelemetryNativeOwner = { execution, session, writer: { id: `lane-${index}`, token: `private-writer-token-${index}`, connectionGeneration: 3 }, nativeOwner: `captured-recovery-owner-${index}` }
  const lane: NativeSessionLane = { id: capture.writer.id, harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
    leaseOwner: 'actual-runner-owner', leaseToken: capture.writer.token, leaseExpiresAt: '2099-01-01T00:00:00Z', observedStatus: 'busy',
    connectionGeneration: 3, correlationId: `execution:${execution.id}`, observedAt: '2026-10-01T00:00:01Z', revision: 4 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: execution.runId, nodeId: execution.workflowNodeId,
    hostRef: { kind: 'main', mainId }, mainInstallationId: mainId, registration: null,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/managed', directoryIdentityHash: 'a'.repeat(64),
      rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: 'b'.repeat(64) },
    source: { revisionId: 'source', manifestDigest: 'c'.repeat(64), materializationId: 'materialization', materializationDigest: 'd'.repeat(64) },
    payload: { kind: 'agent', agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId, driverId: 'driver', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'installation', installationFingerprint: 'fingerprint', runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: execution.id, occurrenceId: null, occurrenceIndex: 0, technicalAttempt: execution.attempt,
    attemptId: `actual-attempt-uuid-${index}`, operationId: `actual-operation-${index}`, owner: { grantId: `actual-grant-${index}`, epoch: '3' }, inputDigest: `sha256:${'e'.repeat(64)}` })
  const run = AcceptedWorkflowRunV3Schema.parse({ id: execution.runId, workspaceId: `workspace-${index}`, workflowId: `workflow-${index}`,
    workflowVersionId: `version-${index}`, executionSemanticsVersion: 3, agentConfigurationVersionIds: { [execution.agentId]: execution.agentConfigurationVersionId },
    approval: { handler: 'user' }, executionCondition: { kind: 'manual' }, executionState: 'running', outcome: 'pending', input: {},
    createdAt: execution.createdAt, authorizationPrincipalId: 'actual-principal',
    executionLocation: { runnerId: 'actual-runner', rootPath: '/project', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } })
  return { capture, lane, run, session, placement, intent, workspaceId: `workspace-${index}`, workflowId: `workflow-${index}`, accepted: true, grantLive: true }
}
function setup(contendedTable?: 'runs' | 'native_session_lanes' | 'execution_dispatch_intents') {
  const sources = [source()]
  let remoteOwner: CapturedRemoteTelemetryNativeOwner | null = null, receipt: RemoteOperationReceipt | null = null
  let live = structuredClone(principal), revoked = false, active = true, mainContext: typeof context | null = { ...context }
  let binding: DeviceSessionBinding | null = null, presence: DevicePresence | null = null, registration: DeviceRegistration | null = null
  let capabilities: DeviceNegotiatedExtension[] = [], credentialExpires = new Date('2099-01-01T00:00:00Z')
  let afterLaneRead: (() => void) | undefined, afterExecutionRead: (() => void) | undefined
  const launches: NativeLaunchObservation[] = [{ owner: sources[0]!.capture.nativeOwner, launchId: 'actual-launch-1', bootId,
    provider: { pid: 321, startTicks: '12' }, lifecycle: 'active' }]
  const getNativeOwners = vi.fn(() => remoteOwner ? [] : sources.map(value => structuredClone(value.capture)))
  let snapshot = sources
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.startsWith('begin')) {
      snapshot = /repeatable read/i.test(text) ? structuredClone(sources) : sources
    }
    // Model PostgreSQL's row-lock conflict while another session is publishing.
    if (contendedTable && text.includes(contendedTable) && /for (share|update)/i.test(text)) {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    }
    let rows: unknown[] = []
    if (text.startsWith('select id from runs where id=any')) {
      const ids = values[0] as string[]
      rows = snapshot.filter(value => ids.includes(value.capture.execution.runId))
        .map(value => ({ id: value.capture.execution.runId }))
    } else if (text.startsWith('select id from harness_executions where id=any')) {
      const ids = values[0] as string[]
      rows = snapshot.filter(value => ids.includes(value.capture.execution.id))
        .map(value => ({ id: value.capture.execution.id }))
    } else if (text.includes('from management_principals')) rows = [{ id: live.id, name: live.name, audience: live.audience, grants: live.grants,
      expires_at: new Date(live.expiresAt), revoked_at: revoked ? new Date() : null, delegated_from: null }]
    else if (text.includes('from native_session_lanes')) {
      const found = snapshot.find(value => value.lane.id === values[0] && value.lane.leaseToken === values[1])
      if (found && Date.parse(found.lane.leaseExpiresAt!) > Date.now()) rows = [{ id: found.lane.id, revision: String(found.lane.revision), record: structuredClone(found.lane) }]
      afterLaneRead?.(); afterLaneRead = undefined
    } else if (text.includes('from harness_executions e join runs')) {
      const found = snapshot.find(value => value.capture.execution.id === values[0] && value.capture.execution.runId === values[1])
      if (found) rows = [{ id: found.capture.execution.id, run_id: found.capture.execution.runId, workflow_node_id: found.capture.execution.workflowNodeId,
        agent_id: found.capture.execution.agentId, attempt: found.capture.execution.attempt, accepted: found.accepted, record: structuredClone(found.capture.execution),
        workspace_id: found.workspaceId, workflow_id: found.workflowId, workflow_version_id: found.run.workflowVersionId, run_record: structuredClone(found.run) }]
      afterExecutionRead?.(); afterExecutionRead = undefined
    } else if (text.includes('from execution_dispatch_owner_grants')) {
      const found = snapshot.find(value => value.capture.execution.id === values[0] && value.intent.operationId === values[1]
        && value.intent.owner.grantId === values[2] && value.intent.owner.epoch === values[3]); if (found?.grantLive) rows = [{}]
    } else if (text.includes('from remote_dispatch_origins')) {
      if (receipt) rows = [{ connection: receipt.connection }]
    } else if (text.includes('from remote_execution_receipts')) {
      if (receipt && receipt.intent.operationId === values[0]) rows = [{ receipt: structuredClone(receipt) }]
    } else if (text.includes('from execution_native_sessions')) {
      const found = snapshot.find(value => value.capture.execution.id === values[0]); if (found) rows = [{ reference: found.session }]
    } else if (text.includes('from execution_dispatch_intents where execution_id')) {
      const found = snapshot.find(value => value.intent.executionId === values[0])
      if (found) rows = [{ operation_id: found.intent.operationId, execution_id: found.intent.executionId, run_id: found.intent.runId, node_id: found.intent.nodeId,
        binding_hash: found.intent.bindingHash, attempt_id: found.intent.attemptId, record: structuredClone(found.intent) }]
    } else if (text.includes('from execution_dispatch_intents where operation_id')) {
      const found = snapshot.find(value => value.intent.operationId === values[0]); if (found) rows = [{ record: structuredClone(found.intent) }]
    } else if (text.includes('from run_node_placements')) {
      const found = snapshot.find(value => value.placement.runId === values[0] && value.placement.nodeId === values[1]); if (found) rows = [{ record: structuredClone(found.placement) }]
    } else if (text.includes('from device_registrations') && registration && registration.deviceId === values[0] && registration.mainId === values[1]) {
      rows = [{ record: structuredClone(registration), credential_expires_at: credentialExpires }]
    } else if (!text.startsWith('begin') && !['commit', 'rollback'].includes(text)
      && !text.includes('remote_execution_owner_reconciliations')) throw new Error(`Unexpected read: ${text}`)
    return { rows, rowCount: rows.length }
  })
  const release = vi.fn()
  const pool = { connect: async () => Object.assign(new EventEmitter(), { query, release }) } as unknown as pg.Pool
  const registry = { revision: () => 'registry-real-1',
    snapshot: vi.fn(() => ({ revision: 'registry-real-1', launches })), changes: async function* () {} }
  const authorities = createPassiveTelemetryAuthorities({ pool, getNativeOwners, getRemoteNativeOwners: () => remoteOwner ? [remoteOwner] : [], mainContext: () => mainContext, mainActive: () => active,
    deviceBinding: () => binding, presence: () => presence, deviceCapabilities: () => capabilities,
    registry })
  return { sources, launches, registry,
    remoteOriginal(value: CapturedRemoteTelemetryNativeOwner, originalReceipt: RemoteOperationReceipt) { remoteOwner = value; receipt = originalReceipt }, authorities, query, release, getNativeOwners,
    live(value: ManagementPrincipal) { live = value }, revoked(value: boolean) { revoked = value }, active(value: boolean) { active = value },
    main(value: typeof context | null) { mainContext = value }, afterLane(work: () => void) { afterLaneRead = work }, afterExecution(work: () => void) { afterExecutionRead = work },
    remote(value: DeviceSessionBinding) {
      binding = value; presence = { binding: value, phase: 'ready', dispatch: true, transfer: true, appVersion: 'actual-worker-version', protocolVersion: 1, lastSeenAt: new Date().toISOString() }
      registration = { mainId: value.mainId, deviceId: value.deviceId, workerInstallationId: value.workerInstallationId, keyRevision: value.keyRevision,
        authorizationRevision: value.authorizationRevision, status: 'paired', scopes: ['connect', 'heartbeat', 'metrics:report'], publicKeyFingerprint: 'a'.repeat(64) }
      capabilities = [{ namespace: 'resource-telemetry', version: 1, mainCanRequest: true, workerCanRequest: false, maxJsonBytes: 65536, maxBinaryBytes: 0 }]
    }, offline() { binding = null; presence!.phase = 'offline' }, denyCapability() { capabilities = [] },
    metrics(value: boolean) { registration!.scopes = value ? ['connect', 'heartbeat', 'metrics:report'] : ['connect', 'heartbeat'] },
    revokeDevice() { registration!.authorizationRevision++ }, expireCredential() { credentialExpires = new Date(0) } }
}
const binding: DeviceSessionBinding = { mainId, deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '66666666-6666-4666-8666-666666666666', bootId, keyRevision: 1, authorizationRevision: 2, connectionGeneration: 3,
  connectionEpoch: '88888888-8888-4888-8888-888888888888' }
function remoteSetup() {
  const s = setup(), original = s.sources[0]!
  s.remote(binding)
  const { bindingHash: _hash, ...placement } = original.placement
  void _hash
  original.placement = freezePlacement({ ...placement, hostRef: { kind: 'device', mainId, deviceId: binding.deviceId },
    registration: { workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision } })
  original.intent = deriveDispatch(original.placement, original.intent)
  const capture: CapturedRemoteTelemetryNativeOwner = { ...original.capture, writer: { ...original.capture.writer, connectionGeneration: original.lane.connectionGeneration }, binding, native: { sessionId: original.session.nativeSessionId,
    turnId: 'actual-native-turn', processIdentityDigest: 'f'.repeat(64) }, assertCurrent: vi.fn() }
  original.lane.currentTurnOrMessageId = capture.native.turnId
  const { connectionEpoch: _epoch, ...connection } = binding
  void _epoch
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent: original.intent, connection, workerIncarnationId: '99999999-9999-4999-8999-999999999999',
    sequence: 1, phase: 'running', native: capture.native, entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
  s.remoteOriginal(capture, receipt)
  return { ...s, capture, receipt, original }
}
describe('genuine passive telemetry production authorities', () => {
  it('does no SQL or registry scan for empty ownership and immediately loads new owners', async () => {
    const s = setup()
    const original = s.sources.pop()!
    const service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: Date.now } })
    try {
      const identity = await service.handshake(context, 'collector', signal())
      const reader = s.authorities.nativeScopes(identity)
      expect(await reader.snapshot(signal())).toEqual([])
      expect(await reader.snapshot(signal())).toEqual([])
      expect(s.query).not.toHaveBeenCalled()
      expect(s.registry.snapshot).not.toHaveBeenCalled()
      s.sources.push(original)
      expect(await reader.snapshot(signal())).toHaveLength(1)
      original.grantLive = false
      expect(await reader.snapshot(signal())).toEqual([])
      original.grantLive = true
      expect(await reader.snapshot(signal())).toHaveLength(1)
      original.lane.leaseExpiresAt = new Date(0).toISOString()
      expect(await reader.snapshot(signal())).toEqual([])
    } finally { await service.close() }
  })
  it('reuses a sampler refresh in the polling watcher and closes its timer', async () => {
    vi.useFakeTimers()
    const s = setup()
    const service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: Date.now } })
    const controller = new AbortController()
    try {
      const identity = await service.handshake(context, 'collector', signal())
      const reader = s.authorities.nativeScopes(identity)
      const iterator = reader.changes('before-first-snapshot', controller.signal)[Symbol.asyncIterator]()
      expect((await iterator.next()).value?.gap).toBe(true)
      await reader.snapshot(signal())
      const queries = s.query.mock.calls.length
      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(TELEMETRY_LIMITS.intervalMs)
      expect(s.query).toHaveBeenCalledTimes(queries)
      controller.abort()
      expect((await pending).done).toBe(true)
      await iterator.return?.()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.abort()
      await service.close()
      vi.useRealTimers()
    }
  })
  it('joins captured writer/recovery facts with actual W08 records and resolves a complete first selector', async () => {
    const s = setup(), service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: Date.now } })
    const identity = await service.handshake(context, 'actual-collector-generation', signal())
    const result = TelemetrySelectorResultSchema.parse(await new ResourceTelemetrySelectors(service, s.authorities.targets).resolve(principal, target, signal()))
    expect(result.kind).toBe('selector')
    if (result.kind !== 'selector' || result.selector.scope !== 'owned') throw new Error('owned selector')
    expect(result.selector.host).toEqual(identity.host)
    expect(result.selector.attributionRef).toBe(s.sources[0]!.lane.id); expect(result.selector.attributionRevision).toBe('4')
    expect(result.selector.owner.kind === 'workflow-execution' && result.selector.owner.attemptId).toBe('actual-attempt-uuid-1')
    expect(result.selector.owner.kind === 'workflow-execution' && result.selector.owner.owner).toEqual(s.sources[0]!.intent.owner)
    expect(JSON.stringify(result)).not.toContain('private-writer-token'); expect(JSON.stringify(result)).not.toContain('captured-recovery-owner')
    const views = await s.authorities.nativeScopes(identity).snapshot(signal())
    expect(views[0]?.nativeOwner).toBe(s.sources[0]!.capture.nativeOwner)
    expect(views[0]?.leaseId).toBe(s.sources[0]!.lane.id); expect(views[0]?.selector).toEqual(result.selector)
    expect((await service.read(principal, result.selector, signal())).kind).toBe('no-sample')
    expect(s.sources[0]!.lane.revision).toBe(4)
    expect(s.sources[0]!.grantLive).toBe(true)
    await service.close()
  })
  it('reads an ingested genuine scope through authenticated HTTP/MCP and denies callers with no private values', async () => {
    const frozenWall = Date.now(), s = setup(), service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: () => frozenWall } })
    await service.handshake(context, 'actual-collector', signal())
    const selectors = new ResourceTelemetrySelectors(service, s.authorities.targets)
    const discovered = await selectors.resolve(principal, target, signal())
    if (discovered.kind !== 'selector') throw new Error('selector')
    const challenge = (await service.challenge(context, signal()))!
    const batch: TelemetryCollectedBatch = { schemaVersion: 1, identity: challenge.identity, challengeId: challenge.challengeId,
      sequence: '1', collectedAtUnixMs: challenge.issuedAtUnixMs, challengeReceivedMonoNs: '1', captureStartMonoNs: '1', captureEndMonoNs: '1001', logicalCpuCount: 8,
      host: null, owned: [{ selector: discovered.selector, coverage: { boundary: 'partial', shared: false, reasons: ['process-tree-partial'] },
        cpu: { state: 'warmup', reason: 'warmup' }, memory: { state: 'ok', value: { kind: 'rss-sum', bytes: 4096, totalBytes: null,
          availableBytes: null, sharedPagesMayDoubleCount: true } } }], diagnostics: [], truncated: false }
    await service.ingest(context, JSON.stringify(batch), signal())
    const audits: string[] = [], audit = { record: async (id: string, from: 'http' | 'mcp') => { audits.push(`${from}:${id}`) } }
    const app = Fastify()
    app.addHook('onRequest', async (request, reply) => {
      const bearer = request.headers.authorization
      if (bearer !== 'Bearer reader' && bearer !== 'Bearer denied') return reply.code(401).send({ error: 'AUTH_REQUIRED' })
      request.operatorPrincipal = bearer === 'Bearer reader' ? principal : { ...principal, id: 'denied', grants: [] }
    })
    registerResourceTelemetryRoutes(app, service, audit); registerResourceTelemetrySelectorRoutes(app, selectors, audit)
    app.post('/mcp', async (request, reply) => {
      const server = new McpServer({ name: 'production-telemetry-adapter-test', version: '1.0.0' })
      registerResourceTelemetryTools(server, request.operatorPrincipal!, service, audit)
      registerResourceTelemetrySelectorTools(server, request.operatorPrincipal!, selectors, audit)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      reply.raw.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    try {
      for (const credential of ['reader', 'denied']) for (const request of [
        { route: RESOURCE_TELEMETRY_SELECTOR_ROUTE, tool: RESOURCE_TELEMETRY_SELECTOR_TOOL, input: target },
        { route: RESOURCE_TELEMETRY_READ_ROUTE, tool: RESOURCE_TELEMETRY_READ_TOOL, input: discovered.selector },
      ]) {
        const http = await app.inject({ method: 'POST', url: request.route, headers: { authorization: `Bearer ${credential}` }, payload: request.input })
        const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${credential}`,
          accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: request.tool, arguments: request.input } } })
        expect(decodeMcpToolResult(mcp.json().result)).toEqual(http.json())
        if (credential === 'denied') {
          expect(http.statusCode).toBe(403); expect(mcp.json().result.isError).toBe(true)
          expect(http.json().sample).toBeUndefined(); expect(http.json().lastKnown).toBeUndefined()
          if (request.tool === RESOURCE_TELEMETRY_SELECTOR_TOOL) expect(http.json()).toEqual({ kind: 'denied' })
        } else {
          expect(http.statusCode).toBe(200)
          if (request.tool === RESOURCE_TELEMETRY_READ_TOOL) {
            const read = TelemetryReadResultSchema.parse(http.json())
            expect(read.kind === 'sample' && read.sample.memory.value?.bytes).toBe(4096)
            expect(read.kind === 'sample' && read.lastKnown!.memory.value?.bytes).toBe(4096)
          }
        }
      }
      expect((await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_READ_ROUTE, payload: discovered.selector })).statusCode).toBe(401)
      expect(audits.sort()).toEqual(['http:denied', 'http:denied', 'mcp:denied', 'mcp:denied'])
    } finally { await app.close(); await service.close() }
  })
  it('requires live exact Run grants and a separate explicit global computer grant', async () => {
    const s = setup()
    expect(await s.authorities.targets.allowTarget(principal, computer, signal())).toBe(false)
    expect(await s.authorities.targets.resolveOwned({ ...principal, grants: [] }, target, signal())).toEqual({ kind: 'denied' })
    expect(s.getNativeOwners).not.toHaveBeenCalled()
    const deviceReader: ManagementPrincipal = { ...principal, grants: [{ actions: ['devices:metrics:read' as const], scope: {} }] }
    s.live(deviceReader); expect(await s.authorities.targets.allowTarget(deviceReader, computer, signal())).toBe(true)
    const scoped = { ...deviceReader, grants: [{ actions: ['devices:metrics:read' as const], scope: { workspaceIds: ['workspace-1'] } }] }
    s.live(scoped); expect(await s.authorities.targets.allowTarget(scoped, computer, signal())).toBe(false)
    s.live(principal); s.revoked(true)
    expect(await s.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'denied' })
    expect(s.getNativeOwners).not.toHaveBeenCalled()
  })
  it.each(['expired-writer', 'changed-writer', 'wrong-session', 'not-accepted', 'wrong-installation', 'missing-dispatch', 'wrong-correlation', 'wrong-lane-generation', 'wrong-run-pin', 'wrong-run-version', 'wrong-original-session', 'revoked-owner'] as const)('returns unavailable for %s without inventing attribution', async defect => {
    const s = setup(), current = s.sources[0]!
    if (defect === 'expired-writer') current.lane.leaseExpiresAt = '1970-01-01T00:00:00Z'
    if (defect === 'changed-writer') current.lane.leaseToken = 'different-writer-token'
    if (defect === 'wrong-session') current.lane.nativeSessionId = 'other-native-session'
    if (defect === 'not-accepted') current.accepted = false
    if (defect === 'wrong-installation') s.main({ ...context, applicationInstallationId: 'other-installation' })
    if (defect === 'missing-dispatch') current.intent = { ...current.intent, executionId: 'other-execution' }
    if (defect === 'wrong-correlation') current.lane.correlationId = 'conversation:unrelated'
    if (defect === 'wrong-lane-generation') current.lane.connectionGeneration++
    if (defect === 'wrong-run-pin') current.run.agentConfigurationVersionIds[current.capture.execution.agentId] = 'other-config'
    if (defect === 'wrong-run-version') current.run.workflowVersionId = ''
    if (defect === 'revoked-owner') current.grantLive = false
    if (defect === 'wrong-original-session') current.session = { ...current.session, providerVersion: 'other-original-version' }
    expect(await s.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'unavailable' })
  })
  it('fences changes to the captured guard or main runtime during asynchronous facts reads', async () => {
    const s = setup()
    s.afterLane(() => { s.sources[0]!.capture.writer.token = 'new-captured-token' })
    expect(await s.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'unavailable' })
    const reset = setup(); reset.afterLane(() => reset.main({ ...context, runtimeEpoch: 'new-actual-pg-owner' }))
    expect(await reset.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'unavailable' })
  })
  it('does not publish a writer lease that expires while its exact W08 facts are being read', async () => {
    vi.useFakeTimers()
    const s = setup(), now = Date.now()
    try {
      s.sources[0]!.lane.leaseExpiresAt = new Date(now + 100).toISOString()
      s.afterExecution(() => vi.setSystemTime(now + 101))
      expect(await s.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'unavailable' })
      expect(s.sources[0]!.lane.leaseExpiresAt).toBe(new Date(now + 100).toISOString())
    } finally { vi.useRealTimers() }
  })
  it('recomputes real lane revision and marks shared captured process values as privately co-owned', async () => {
    const s = setup(), other = source(2); s.sources.push(other)
    s.launches.push({ owner: other.capture.nativeOwner, launchId: 'actual-launch-2', bootId, provider: { pid: 321, startTicks: '12' }, lifecycle: 'active' })
    const identity: TelemetryIdentity = { mainId, host: { hostRef: computer.hostRef, deviceId: context.deviceId,
      applicationInstallationId: context.applicationInstallationId, bootId, runtimeEpoch: context.runtimeEpoch,
      keyRevision: null, authorizationRevision: null, connectionGeneration: null, collectorGeneration: 'collector-real' } }
    const reader = s.authorities.nativeScopes(identity)
    const before = await reader.snapshot(signal()); const revision = reader.revision()
    expect(before).toHaveLength(2); expect(before.every(value => value.shared)).toBe(true)
    const owned = await s.authorities.ownership.resolve(before[0]!.selector, signal())
    expect(owned?.sharedOwners).toHaveLength(1)
    expect(await s.authorities.reads.allowSharedOwner(principal, owned!.sharedOwners[0]!, signal())).toBe(false)
    s.sources[0]!.lane.revision++
    const after = await reader.snapshot(signal())
    expect(reader.revision()).not.toBe(revision); expect(after[0]!.selector.attributionRevision).toBe('5')
    expect(await s.authorities.ownership.resolve(before[0]!.selector, signal())).toBeNull()
    other.lane.leaseExpiresAt = '1970-01-01T00:00:00Z'
    expect(await reader.snapshot(signal())).toEqual([])
  })
  it('uses actual W07 authorization/capability and keeps authorized offline bindings distinct from revocation', async () => {
    const s = setup(), binding: DeviceSessionBinding = { mainId, deviceId: '22222222-2222-4222-8222-222222222222',
      workerInstallationId: '66666666-6666-4666-8666-666666666666', bootId, keyRevision: 1, authorizationRevision: 2, connectionGeneration: 3,
      connectionEpoch: '88888888-8888-4888-8888-888888888888' }
    const remote: TrustedTelemetryContext = { kind: 'remote', binding, capability: 'resource-telemetry/v1' }
    s.remote(binding); expect(await s.authorities.sessions.active(remote, signal())).toBe(true)
    expect(await s.authorities.sessions.presence(remote, signal())).toBe('online')
    s.denyCapability(); expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
    s.remote(binding); s.offline()
    expect(await s.authorities.sessions.active(remote, signal())).toBe(true)
    expect(await s.authorities.sessions.presence(remote, signal())).toBe('offline')
    s.revokeDevice(); expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
    s.remote(binding); s.expireCredential(); expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
    s.remote({ ...binding, connectionGeneration: 4 }); expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
    s.active(false); expect(await s.authorities.sessions.active(context, signal())).toBe(false)
  })
  it('requires explicit reporting scope independently of connection and reader authority', async () => {
    const s = setup(), remote: TrustedTelemetryContext = { kind: 'remote', binding, capability: 'resource-telemetry/v1' }
    s.remote(binding); s.metrics(false)
    expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
    const reader: ManagementPrincipal = { ...principal, grants: [{ actions: ['devices:metrics:read' as const], scope: {} }] }
    s.live(reader)
    const target: TelemetrySelectorTarget = { schemaVersion: 1, scope: 'computer', mainId, hostRef: { kind: 'device', mainId, deviceId: binding.deviceId } }
    expect(await s.authorities.targets.allowTarget(reader, target, signal())).toBe(false)
    s.metrics(true)
    expect(await s.authorities.sessions.active(remote, signal())).toBe(true)
    expect(await s.authorities.targets.allowTarget(reader, target, signal())).toBe(true)
    const deviceReader = { ...reader, grants: [{ actions: ['devices:read' as const], scope: {} }] }
    s.live(deviceReader)
    expect(await s.authorities.targets.allowTarget(deviceReader, target, signal())).toBe(false)
    s.metrics(false)
    expect(await s.authorities.sessions.active(remote, signal())).toBe(false)
  })
  it('joins original remote session/receipt/accepted Run without attributing it to the Main collector', async () => {
    const s = remoteSetup(), remote: TrustedTelemetryContext = { kind: 'remote', binding, capability: 'resource-telemetry/v1' }
    const service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: Date.now } })
    try {
      const local = await service.handshake(context, 'local-collector', signal())
      const identity = await service.handshake(remote, 'remote-collector', signal())
      const result = await new ResourceTelemetrySelectors(service, s.authorities.targets).resolve(principal, target, signal())
      expect(result.kind).toBe('selector')
      if (result.kind !== 'selector' || result.selector.scope !== 'owned') throw new Error('selector')
      expect(result.selector.host).toEqual(identity.host)
      expect(await s.authorities.nativeScopes(local).snapshot(signal())).toEqual([])
      expect(await s.authorities.ownership.resolve(result.selector, signal())).toMatchObject({ selector: result.selector, state: 'active' })
      s.original.lane.connectionGeneration++
      expect(await s.authorities.ownership.resolve(result.selector, signal())).toBeNull()
    } finally { await service.close() }
  })
  it('keeps remote host freshness separate from online presence and clears values when reporting scope is revoked', async () => {
    const s = setup(), remote: TrustedTelemetryContext = { kind: 'remote', binding, capability: 'resource-telemetry/v1' }
    const reader: ManagementPrincipal = { ...principal, grants: [{ actions: ['devices:metrics:read' as const], scope: {} }] }
    s.remote(binding); s.live(reader)
    let mono = 0
    const wall = Date.now(), service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => mono, unixMs: () => wall + mono } })
    try {
      const identity = await service.handshake(remote, 'remote-collector', signal())
      const challenge = (await service.challenge(remote, signal()))!
      const selector = { schemaVersion: 1 as const, scope: 'computer' as const, ...identity }
      const batch: TelemetryCollectedBatch = { schemaVersion: 1, identity, challengeId: challenge.challengeId, sequence: '1',
        collectedAtUnixMs: wall, challengeReceivedMonoNs: '1', captureStartMonoNs: '1', captureEndMonoNs: '1001', logicalCpuCount: 8,
        host: { selector, coverage: { boundary: 'complete-boundary', shared: false, reasons: [] }, cpu: { state: 'warmup', reason: 'warmup' },
          memory: { state: 'ok', value: { kind: 'host-used-estimate', bytes: 1024, totalBytes: 8192, availableBytes: 7168, sharedPagesMayDoubleCount: false } } },
        owned: [], diagnostics: [], truncated: false }
      await service.ingest(remote, JSON.stringify(batch), signal())
      mono = 5999
      expect(await service.read(reader, selector, signal())).toMatchObject({ kind: 'sample', sample: { presence: 'online', memory: { value: { bytes: 1024 } } } })
      mono = 6000
      expect(await service.read(reader, selector, signal())).toMatchObject({ kind: 'sample', sample: { presence: 'online', memory: { value: null, reason: 'stale' } } })
      s.offline()
      expect(await service.read(reader, selector, signal())).toMatchObject({ kind: 'sample', sample: { presence: 'offline', memory: { value: null } }, lastKnown: { memory: { value: { bytes: 1024 } } } })
      s.metrics(false)
      expect(await service.read(reader, selector, signal())).toEqual({ kind: 'denied', selectorKey: expect.any(String) })
      await expect(service.handshake(remote, 'other-collector', signal())).rejects.toThrow('authorization')
    } finally { await service.close() }
  })
  it.each(['wrong-native-digest', 'wrong-receipt-host', 'wrong-attempt', 'wrong-registration-revision', 'expired-original', 'missing-metrics'] as const)(
    'leaves remote %s unavailable', async defect => {
      const s = remoteSetup()
      if (defect === 'wrong-native-digest') s.receipt.native = { ...s.capture.native, processIdentityDigest: 'e'.repeat(64) }
      if (defect === 'wrong-receipt-host') s.receipt.connection = { ...s.receipt.connection, workerInstallationId: mainId }
      if (defect === 'wrong-attempt') s.receipt.intent = { ...s.receipt.intent, attemptId: 'other-attempt' }
      if (defect === 'wrong-registration-revision') {
        const { bindingHash: _hash, ...pins } = s.original.placement
        void _hash
        s.original.placement = freezePlacement({ ...pins, registration: { ...pins.registration!, authorizationRevision: 99 } })
        s.original.intent = deriveDispatch(s.original.placement, s.original.intent)
        s.receipt.intent = s.original.intent
      }
      if (defect === 'expired-original') s.capture.assertCurrent = () => { throw new Error('Original lifetime retired') }
      if (defect === 'missing-metrics') s.metrics(false)
      expect(await s.authorities.targets.resolveOwned(principal, target, signal())).toEqual({ kind: 'unavailable' })
    })
  it('leaves chat and CI unavailable without genuine captured writers or OCI ownership', async () => {
    const s = setup(), reader: ManagementPrincipal = { ...principal, grants: [{ actions: ['agent_chat:read', 'operator_chat:read', 'jobs:read'], scope: {} }] }
    s.live(reader)
    for (const publicTarget of [{ kind: 'operator-conversation' as const, conversationId: 'existing-chat' },
      { kind: 'agent-conversation' as const, workspaceId: 'workspace-1', workflowId: 'workflow-1', nodeId: 'node-1', agentId: 'agent-1', conversationId: 'existing-chat' },
      { kind: 'ci-job' as const, workspaceId: 'workspace-1', jobExecutionId: 'existing-job', attemptId: 'actual-job-attempt' }]) {
      expect(await s.authorities.targets.resolveOwned(reader, { schemaVersion: 1, scope: 'owned', mainId, target: publicTarget }, signal())).toEqual({ kind: 'unavailable' })
    }
    expect(s.getNativeOwners).not.toHaveBeenCalled()
  })
  it('bounds source scans and joins polling invalidation cleanup without inventing owners', async () => {
    vi.useFakeTimers()
    const s = setup(), service = new ResourceTelemetryService({ ...s.authorities, clock: { monotonicMs: () => 0, unixMs: Date.now } })
    const identity = await service.handshake(context, 'real-collector', signal()), reader = s.authorities.nativeScopes(identity), controller = new AbortController()
    try {
      await reader.snapshot(signal())
      const iterator = reader.changes(reader.revision(), controller.signal)[Symbol.asyncIterator]()
      s.sources[0]!.lane.revision++
      const change = await iterator.next(); expect(change.value?.gap).toBe(true)
      controller.abort(); await iterator.return?.(); expect(vi.getTimerCount()).toBe(0)
      s.sources.push(...Array.from({ length: 65 }, (_, index) => source(index + 2)))
      expect(await reader.snapshot(signal())).toEqual([])
    } finally { await service.close(); vi.useRealTimers() }
  })
})

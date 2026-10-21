import Fastify from 'fastify'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { localHumanPrincipal } from '../../access/localHuman.js'
import { Wave25InteractionRepository } from '../../interactions/wave25/repository.js'
import { OperatorInteractionService } from '../../interactions/operator.js'
import { registerGraphqlMcp } from '../../../mcp/unified/transport.js'
import type { OperatorServices } from '../../../mcp/operator/types.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, CODEX_APPROVAL_OPTIONS_FIXTURE,
  type AgentConfigurationVersion, type DurableInteraction, type PendingNativeInteraction } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { inspectNativeResponse, unavailableNativeResponse } from '../../harnesses/responseAvailability.js'
import { InteractionService } from '../../interactions/service.js'
import { registerOperatorHttpSecurity } from '../../access/http.js'
import type { PostgresAccessService } from '../../access/postgres.js'
import { registerUserInteractions } from '../../../routes/userInteractions.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from './executionHost.js'

const roots: string[] = []
const journals: RemoteOperationJournal[] = []
const hosts: RemoteExecutionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.drain()))
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'remote-approvals-'))
  roots.push(root)
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true })
  journals.push(journal)
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = {
    id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex,
    contentHash: 'sha256:test', createdAt: '2026-10-01T00:00:00.000Z',
  }
  const placement = freezePlacement({
    schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] },
  })
  const input = { value: 'accepted' }
  const inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(input)).digest('hex')}`
  const intent = deriveDispatch(placement, {
    executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: 'attempt', operationId: 'operation', inputDigest, owner: { grantId: 'grant', epoch: '1' },
  })
  const request = { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node',
    workingDirectory: '/project', runtimeDirectory: '/runtime/execution', configuration, input }
  const state = { starts: 0, turns: 0, cancels: 0, responds: 0, allowed: true }
  const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex',
    capabilities: async () => { throw new Error('unused') },
    inspectMcp: async () => { throw new Error('unused') },
    createSession: async () => {
      state.starts++
      return session
    },
    attachSession: async () => session,
    startTurn: async function* (_session, turn) {
      state.turns++
      await turn.onSubmitted?.('native-turn')
      yield { sequence: 1, type: 'event', occurredAt: '2026-10-01T00:00:00.000Z', payload: {} }
    },
    pending: async () => undefined,
    respond: async () => { state.responds++ },
    cancel: async () => {
      state.cancels++
      return false
    },
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    close: async () => {},
  }
  const managers = new ExecutionScopedNativeSessionManagerResolver(() => manager)
  const ports: RemoteExecutionHostPorts = {
    journal, managers, incarnationId: randomUUID(),
    connection: { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, connectionGeneration: 1 },
    authorize: async () => { if (!state.allowed) throw new Error('revoked') },
    attestRuntimeLeaf: async (intent, placement, request) => ({
      executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId,
      bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory,
      directoryIdentityHash: digest, materializationId: placement.source.materializationId!,
      materializationDigest: placement.source.materializationDigest!,
    }),
    preflight: async () => undefined,
    nativeEvidence: async () => ({ sessionId: 'native-session', processIdentityDigest: digest }),
    settle: async () => null,
  }
  const host = new RemoteExecutionHost(ports)
  hosts.push(host)
  return { host, manager, session, journal, intent, placement, request, state, ports }
}

async function pendingApprovals() {
  const f = await setup()
  const pending: PendingNativeInteraction[] = ['first', 'second'].map(nativeRequestId => ({
    session: f.session, turn: { nativeTurnId: 'native-turn', nativeRequestId },
    nativeRequestType: 'item/commandExecution/requestApproval', request: {},
    responseOptions: [CODEX_APPROVAL_OPTIONS_FIXTURE[0]!],
  }))
  f.manager.pending = async () => pending[0]
  f.manager.history = async () => ({ events: [], pendingInteractions: [...pending] })
  f.manager.inspectResponseAvailability = async (session, query) => {
    const found = pending.find(value => value.turn.nativeRequestId === query.nativeRequestId)
    if (!found) return unavailableNativeResponse(session, query, 'request_consumed')
    return { nativeSessionId: session.nativeSessionId, nativeRequestId: found.turn.nativeRequestId!,
      nativeRequestType: found.nativeRequestType, nativeTurnId: 'native-turn', generation: 'worker-runtime',
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }
  }
  const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
    harness: 'codex', configuration: f.request.configuration,
    transport: { request: async (_method, payload) => f.host.handle(payload) },
    observeReceipt: async () => undefined,
    controlFor: async () => { throw new Error('Inspection must not create a response command') },
  })
  const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution' })
  await f.host.startTurn(f.intent.operationId, 'prompt', 'execution:execution')
  await f.host.drain()
  return { ...f, proxy, session, pending }
}

it('reports a live remote approval as answerable through human and authenticated MCP reads without changing Worker state', async () => {
  const f = await pendingApprovals()
  const current = f.pending[1]!
  const interaction: DurableInteraction = {
    id: 'interaction', revision: 0, workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
    executionId: 'execution', requestingAgentId: 'agent', harness: f.session.harness,
    providerVersion: f.session.providerVersion, nativeSessionId: f.session.nativeSessionId,
    nativeRequestId: current.turn.nativeRequestId!, nativeRequestType: current.nativeRequestType,
    graphThreadId: 'run', request: {}, approval: { handler: 'user' }, responseOptions: current.responseOptions,
    status: 'pending', deliveryState: 'not_started',
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const app = Fastify()
  const reader = { ...localHumanPrincipal, id: 'reader', grants: [{ actions: ['interactions:read' as const], scope: {} }] }
  const access = { authenticate: async (token: string) => token === 'reader' ? reader : localHumanPrincipal } as unknown as PostgresAccessService
  const pool = { query: async () => ({ rows: [{ record: interaction }] }) } as unknown as pg.Pool
  const repository = new Wave25InteractionRepository(pool)
  type ServiceArgs = ConstructorParameters<typeof InteractionService>
  const interactions = new InteractionService(repository, {} as ServiceArgs[1], {} as ServiceArgs[2],
    async () => undefined, undefined, async record => {
      const result = await inspectNativeResponse(f.proxy, f.session, {
        nativeRequestId: record.nativeRequestId, nativeRequestType: record.nativeRequestType,
      }, { isCurrent: () => true })
      return { response: {
        authorized: false, qualified: result.qualified, usable: result.state === 'available', path: result.path,
        identity: { interactionId: record.id, revision: record.revision, sessionId: record.nativeSessionId,
          requestId: record.nativeRequestId, executionId: record.executionId },
      } }
    })
  registerOperatorHttpSecurity(app, access)
  registerUserInteractions(app, interactions)
  registerGraphqlMcp(app, { access, operator: { interactions: new OperatorInteractionService(interactions),
    commands: { recordDenied: async () => undefined } } as unknown as OperatorServices })
  const clients: Client[] = []
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const readMcp = async (token: string) => {
    const client = new Client({ name: 'remote-approval-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return decodeMcpToolResult(await client.callTool({ name: 'interaction_get',
      arguments: { interactionId: interaction.id } }))
  }
  const before = await f.journal.status(f.intent.operationId)
  const authorize = vi.spyOn(f.ports, 'authorize')
  try {
    const response = await app.inject({ method: 'GET', url: '/api/user/interactions/interaction',
      headers: { host: '127.0.0.1:4100', origin: 'http://127.0.0.1:5173' } })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ canRespond: true,
      activity: { response: { available: true, path: 'live_callback' } } })
    expect(await readMcp('operator')).toMatchObject({ canRespond: true,
      activity: { response: { available: true, path: 'live_callback' } } })
    expect(await readMcp('reader')).toMatchObject({ canRespond: false,
      activity: { response: { available: false, reason: 'unauthorized' } } })
    f.pending.splice(1, 1)
    expect(await readMcp('operator')).toMatchObject({ canRespond: false })
    expect(await f.journal.status(f.intent.operationId)).toEqual(before)
    expect(authorize.mock.calls.length).toBeGreaterThan(0)
    expect(authorize.mock.calls.every(call => call[2] === 'read')).toBe(true)
    expect(f.state).toMatchObject({ starts: 1, turns: 1, responds: 0, cancels: 0 })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
  }
})

it('delivers the second concurrent approval to its own callback and leaves the first pending', async () => {
  const f = await pendingApprovals()
  const status = await f.journal.status(f.intent.operationId)
  if (status.status !== 'known') throw new Error('Missing native receipt')
  const delivered: string[] = []
  f.manager.respond = async (session, requestId, option) => {
    expect(session).toEqual(f.session)
    expect(option).toEqual(f.pending[1]!.responseOptions[0])
    delivered.push(requestId)
    f.pending.splice(f.pending.findIndex(value => value.turn.nativeRequestId === requestId), 1)
  }
  const command = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    commandId: 'second-response', operationId: f.intent.operationId, attemptId: f.intent.attemptId,
    executionId: f.intent.executionId, bindingHash: f.intent.bindingHash, owner: f.intent.owner,
    native: status.receipt.native, action: { kind: 'respond', interactionId: 'second-interaction',
      interactionRevision: '1', nativeInteractionId: 'second', response: f.pending[1]!.responseOptions[0] },
  })
  await f.host.handle({ method: 'control', intent: f.intent, placement: f.placement, command })
  expect(delivered).toEqual(['second'])
  expect((await f.manager.pending(f.session))?.turn.nativeRequestId).toBe('first')
  await f.host.handle({ method: 'control', intent: f.intent, placement: f.placement, command })
  expect(delivered).toEqual(['second'])
})


it('rejects remote inspection for a stale session or revoked caller', async () => {
  const f = await pendingApprovals()
  const query = { nativeRequestId: 'second', nativeRequestType: f.pending[1]!.nativeRequestType,
    expectedNativeTurnId: 'native-turn', expectedGeneration: 'worker-runtime' }
  expect(await inspectNativeResponse(f.proxy, f.session, query, { isCurrent: () => true }))
    .toMatchObject({ state: 'available', nativeRequestId: 'second', generation: 'worker-runtime' })
  for (const mismatch of [{ expectedNativeTurnId: 'other-turn' }, { expectedGeneration: 'other-runtime' },
    { nativeRequestType: 'other-type' }, { expectedNativeMessageId: 'other-message' }]) {
    expect(await inspectNativeResponse(f.proxy, f.session, { ...query, ...mismatch }, { isCurrent: () => true }))
      .toMatchObject({ state: 'unavailable', reason: 'identity_mismatch' })
  }
  f.state.allowed = false
  expect(await inspectNativeResponse(f.proxy, f.session, query, { isCurrent: () => true }))
    .toMatchObject({ state: 'unavailable' })
  expect(f.state.responds).toBe(0)
})

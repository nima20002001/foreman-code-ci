import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { WorkerConversationAllocation } from '../src/modules/conversations/workerHost.js'
import type { NativeSessionStart } from '../src/modules/harnesses/port.js'
import type { NativeLaunchObservation } from '../src/modules/harnesses/recovery/processRegistry.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationManager } from '../src/modules/conversations/workerManager.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { recoverWorkerConversation } from '../src/modules/conversations/recoverWorkerConversation.js'
import { workerConversationProcessDigest } from '../src/modules/conversations/workerNativeOwner.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { f, source, makeManager, useCodexFixture, wire } from './codex-app-server.test-support.js'

useCodexFixture()

it('recovers scoped Operator creation without credentials and requires fresh credentials before another turn', async () => {
  const facts = workerConversationFixture('operator')
  const configuration = OperatorConfigurationVersionSchema.parse({ ...facts.configuration,
    harness: source.request.configuration.harness })
  const binding = { ...facts.binding, appMcpAccess: 'scoped' as const, workingDirectory: f.directory,
    owner: { ...facts.binding.owner, configurationHash: commandInputHash(configuration) } }
  const start: NativeSessionStart = { kind: 'operator', configuration,
    correlationId: 'original-create', workingDirectory: f.directory }
  const original = makeManager()
  const session = await original.createSession({ ...start, environment: {
    agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: 'original-credential' },
  } })
  await original.shutdown()
  const launch: NativeLaunchObservation = { owner: `conversation:${binding.owner.conversationId}`,
    launchId: randomUUID(), bootId: facts.connection.bootId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
    guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
    boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' } }
  const owner = { sessionId: session.nativeSessionId, processIdentityDigest: workerConversationProcessDigest(binding, launch) }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  await journal.receive(binding, facts.connection)
  await journal.reserveCreation(binding, start.correlationId!,
    commandInputHash({ mode: 'create', source: null, preferences: null }))
  await journal.bindSession(binding, session, owner)
  const connection = { ...facts.connection, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
  const launches = [launch]
  let native = makeManager()
  const allocate = async (): Promise<WorkerConversationAllocation> => {
    native = makeManager()
    const current = native
    const process: NativeLaunchObservation = { ...launch, launchId: randomUUID(), lifecycle: 'active',
      bootId: connection.bootId }
    launches.push(process)
    return { manager: current,
      start: async options => ({ ...structuredClone(start), ...(options.applicationAccess ? { environment: {
        agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: options.applicationAccess.token },
      } } : {}) }),
      close: async () => {
        await current.shutdown()
        launches[launches.indexOf(process)] = { ...process, lifecycle: 'closed' }
      },
      refreshApplicationAccess: async () => {},
      nativeOwner: async () => ({ sessionId: session.nativeSessionId,
        processIdentityDigest: workerConversationProcessDigest(binding, process) }) }
  }
  const host = new WorkerConversationHost({ journal, currentBinding: () => connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => { throw new Error('Recovery cannot create another native session') },
    recover: (record, selected, current, signal, request) => recoverWorkerConversation({
      record, configuration: selected, connection: current, signal, request, journal,
      allocate, assertCurrent: async () => {},
      registry: { snapshot: () => ({ revision: 'fixture', launches }), closeOwner: async () => true },
    }) })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding, configuration, bridge, current: async () => {},
    channel: { binding: connection, request: async raw => ({ payload: await host.handle(raw, connection) }) } })
  try {
    await expect(manager.reconcileSessionCreation(start)).resolves.toEqual(session)
    expect((await journal.read(binding))?.session).toEqual(session)
    expect((await journal.read(binding))?.creation?.operationId).toBe(start.correlationId)
    const config = await native.inspectConfiguration(session)
    expect(config).toMatchObject({ config: { mcp_servers: { graphql: { enabled: false } } } })
    const send = async () => {
      for await (const event of native.startTurn(session, { prompt: 'Continue', clientCorrelationId: 'next-input' })) void event
    }
    await expect(send()).rejects.toMatchObject({ result: { error: { code: 'CODEX_OBSERVATION_ONLY' } } })
    await expect(native.compactSession(session, { requestId: 'new-compact',
      clientCorrelationId: 'new-compact-input', onProgress: async () => {} }))
      .rejects.toMatchObject({ result: { error: { code: 'CODEX_OBSERVATION_ONLY' } } })
    expect(await wire('thread/compact/start')).toHaveLength(0)
    expect(await wire('turn/start')).toHaveLength(0)
    expect(await wire('thread/start')).toHaveLength(1)
    expect(await wire('thread/resume')).toHaveLength(1)
    await native.refreshProcessEnvironment(session, {
      agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: 'refreshed-credential' },
    })
    expect(await native.inspectConfiguration(session))
      .toMatchObject({ config: { mcp_servers: { graphql: { enabled: true } } } })
    await expect(manager.attachSession(session, { ...start, environment: {
      agentId: configuration.operatorId, variables: { GRAPHQL_MCP_TOKEN: 'fresh-credential' },
    } })).resolves.toEqual(session)
    expect((await journal.read(binding))?.ownerTransitions).toHaveLength(2)
    expect(await wire('thread/start')).toHaveLength(1)
    expect(await wire('turn/start')).toHaveLength(0)
    expect(await native.inspectConfiguration(session))
      .toMatchObject({ config: { mcp_servers: { graphql: { enabled: true } } } })
  } finally {
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
  }
})

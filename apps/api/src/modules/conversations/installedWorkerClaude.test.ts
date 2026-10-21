import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkerConversationMcpRequestSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { ClaudeSdkClient } from '../harnesses/claudeSdk/port.js'
import { ClaudeBoundedQueue } from '../harnesses/claudeSdk/queue.js'
import { allocateInstalledWorkerClaude } from './installedWorkerClaude.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationCallbacks } from './workerCallbacks.js'

const provider = vi.hoisted(() => ({ client: undefined as ClaudeSdkClient | undefined }))
vi.mock('./installedConversationDirectory.js', () => ({
  installedConversationDirectory: async () => ({ assertCurrent: async () => {} }),
}))
vi.mock('./installedClaudeConversationProfile.js', () => ({
  createInstalledClaudeConversationProfile: () => ({ capture: async () => ({
    installation: { launcher: { resolvedLauncher: '/recorded/claude' } }, sdk: { entrypoint: '/recorded/sdk' },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'revision' } } },
  }) }),
}))
vi.mock('../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: { mcpServers: unknown }) => ({
    configuration, mcpServers: configuration.mcpServers, env: {},
    qualification: { basicTurns: true, resume: true, fork: true, history: true,
      policy: { alwaysAppliedToolHook: true } },
  }),
}))
vi.mock('../harnesses/claudeSdk/official.js', () => ({
  loadOfficialClaudeSdk: async () => provider.client,
}))

it('prepares fresh scoped Claude credentials with a persisted session and no resident SDK runtime', async () => {
  const f = workerConversationFixture('operator', 'claude')
  if (f.configuration.harness.harness !== 'claude') throw new Error('Claude fixture required')
  const binding = { ...f.binding, appMcpAccess: 'scoped' as const }
  const configuration = { ...f.configuration, harness: { ...f.configuration.harness,
    mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3000/mcp' } } } }
  const source: WorkerConversationRpcRequest = { method: 'conversation.refresh-mcp', binding,
    configuration, admissionId: randomUUID(), applicationAccess: { kind: 'operator-chat-mcp', token: 'fresh-token' } }
  let servers: Readonly<Record<string, unknown>> = {}
  const query = vi.fn<ClaudeSdkClient['query']>(input => {
    const frames = new ClaudeBoundedQueue<unknown>(16)
    servers = input.options.mcpServers as typeof servers
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
      initializationResult: async () => ({ models: [], account: {} }),
      mcpServerStatus: async () => [{ name: 'graphql', status: 'connected', source: 'dynamic', config: servers.graphql }],
      setMcpServers: async value => { servers = value; return { added: ['graphql'], removed: [], errors: {} } },
      interrupt: async () => ({}), close: () => frames.close(),
    }
  })
  provider.client = { sdkVersion: '0.3.284', query, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => { throw new Error('No fork expected') } }
  const record = { binding, connection: f.connection, session: f.session, nativeOwner: f.nativeOwner,
    creation: { operationId: 'original', inputHash: 'original-input' },
    revision: 1, closed: false, closing: false, runtimeReleased: true,
    turns: [], compactions: [], desiredPreferences: null, appliedPreferences: null }
  const journal = new WorkerConversationJournal({ read: async () => [structuredClone(record)],
    change: async (_id, apply) => apply([record]) }, 8)
  const signal = new AbortController().signal
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'worker-claude-credentials-'))
  const callbacks = workerConversationCallbacks({ currentBinding: () => f.connection, capture: () => undefined })
  const allocation = await allocateInstalledWorkerClaude({ binding, configuration, connection: f.connection,
    purpose: 'preparation', stateDirectory: directory, selection: null, launcher: join(directory, 'launcher.mjs'),
    current: () => f.connection, source: () => source, callbacks, signal, journal,
    approvedRoots: async () => { throw new Error('Recorded directory admission supplied') },
    registry: { scope: (owner: string) => ({ owner, root: '/recorded/processes' }),
      reserveLaunch: async () => ({ launchId: 'prepared-launch' }),
      abandonReservedLaunch: async () => {}, closeOwner: async () => true,
    } as unknown as NativeProcessRegistry,
    request: async (_namespace, raw) => {
      const call = WorkerConversationMcpRequestSchema.parse(raw)
      expect(call.token).toBe('fresh-token')
      if (call.operation === 'conversation-mcp.authorize') return {
        payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }
      const body = call.body as { id?: number; method: string }
      if (body.id === undefined) return { payload: { statusCode: 202, contentType: 'empty', body: '' } }
      const result = body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'recorded', version: '1' } }
        : { tools: [] }
      return { payload: { statusCode: 200, contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) } }
    },
  })
  try {
    await expect(allocation.deliverClaudeCredential!('fresh-token', signal)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(1)
    expect(servers.graphql).toMatchObject({ headers: { Authorization: 'Bearer fresh-token' } })
    const start = await allocation.start({ correlationId: `inspection:${binding.owner.conversationId}`,
      instructionsDelivered: true, applicationAccess: { kind: 'operator-chat-mcp', token: 'fresh-token' } })
    await expect(allocation.manager.attachSession(f.session, start, signal)).resolves.toEqual(f.session)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls.at(-1)![0].options.resume).toBe(f.session.nativeSessionId)
    expect(servers.graphql).toMatchObject({ headers: { Authorization: 'Bearer fresh-token' } })
    expect((await journal.read(binding))?.session).toEqual(f.session)
    expect((await journal.read(binding))?.runtimeReleased).toBe(true)
  } finally {
    await allocation.close()
    await rm(directory, { recursive: true, force: true })
  }
})

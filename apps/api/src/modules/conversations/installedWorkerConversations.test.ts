import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { appLauncherPath, installAppLauncher } from '../harnesses/appMcpLauncher.js'
import { WorkerConversationMcpRequestSchema } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { WorkerConversationHostPorts, WorkerConversationAllocation } from './workerHost.js'
import { createInstalledWorkerConversations } from './installedWorkerConversations.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const selection = vi.hoisted(() => ({ appMcpLauncher: '/fixture/mcp-launcher' }))
const roots: string[] = []
async function temporaryDirectory() {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'installed-conversation-'))
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  selection.appMcpLauncher = '/fixture/mcp-launcher'
  vi.unstubAllEnvs()
})

vi.mock('../runs/remote/installedWorkflowConfiguration.js', () => ({
  readInstalledWorkflowConfiguration: async () => selection,
}))
vi.mock('./installedConversationDirectory.js', () => ({
  installedConversationDirectory: async () => ({ assertCurrent: async () => {} }),
}))
vi.mock('./installedNativeProfile.js', () => ({
  createInstalledConversationNativeReader: () => ({ repository: {}, capture: async () => ({
    inspection: { installation: { launcher: { resolvedLauncher: '/fixture/codex' } } },
    qualification: { version: 'fixture-codex' },
  }) }),
}))
vi.mock('./installedClaudeConversationProfile.js', () => ({
  createInstalledClaudeConversationProfile: () => ({ capture: async () => ({
    installation: { launcher: { resolvedLauncher: '/fixture/claude' } }, sdk: { entrypoint: '/fixture/sdk' },
    accepted: { currentBinding: { pin: { sdkVersion: '0.3.284', cliVersion: '2.1.284', configRevision: 'revision' } } },
  }) }),
}))
vi.mock('../harnesses/claudeSdk/configuration.js', () => ({
  compileClaudeConfiguration: (configuration: unknown) => ({ configuration, mcpServers: {}, env: {},
    qualification: { basicTurns: true, resume: true, fork: true, history: true,
      policy: { alwaysAppliedToolHook: true } } }),
}))
vi.mock('./workerHost.js', () => ({
  WorkerConversationHost: class {
    private readonly allocations: WorkerConversationAllocation[] = []
    constructor(private readonly ports: WorkerConversationHostPorts) {}
    async handle(request: Extract<WorkerConversationRpcRequest, {
      method: 'conversation.capabilities' | 'conversation.inspect-mcp'
    }>, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
      const allocation = await this.ports.prepare!(request.binding, request.configuration, connection, signal)
      this.allocations.push(allocation)
      return allocation.start({ correlationId: 'first-message', instructionsDelivered: false,
        ...(request.binding.appMcpAccess === 'scoped'
          ? { applicationAccess: { kind: 'operator-chat-mcp' as const, token: 'scoped-operator-credential' } } : {}) })
    }
    async shutdown() {
      await Promise.all(this.allocations.map(allocation => allocation.close()))
    }
  },
}))

it.each([
  ['codex', 'agent'], ['claude', 'agent'], ['codex', 'operator'], ['claude', 'operator'],
] as const)('builds the installed %s %s native startup with its accepted prompt policy', async (harness, role) => {
  const f = workerConversationFixture(role, harness)
  const systemPrompt = { value: { text: 'Accepted app instructions' }, revision: 3, versionId: 'prompt-version-3' }
  const binding = role === 'agent' ? { ...f.binding, systemPrompt } : f.binding
  const stateDirectory = await temporaryDirectory()
  roots.push(stateDirectory)
  const registry = {
    scope: (owner: string) => ({ owner, root: join(stateDirectory, 'processes') }),
    reserveLaunch: async () => ({ launchId: 'fixture-launch' }),
    abandonReservedLaunch: async () => {}, closeOwner: async () => true,
  } as unknown as NativeProcessRegistry
  const journal = { conversations: { inspectBinding: async () => undefined,
    claudeCallbackJournal: () => undefined } } as unknown as RemoteOperationJournal
  const host = await createInstalledWorkerConversations({
    stateDirectory, configuration: null, registry, journal: async () => journal,
    current: () => f.connection, capture: () => undefined,
    request: async () => { throw new Error('Startup composition must not send a remote request') },
    approvedRoots: async () => { throw new Error('Directory admission is supplied by this fixture') },
    codexSuiteRevision: 'fixture-suite', signal: new AbortController().signal,
  })
  expect(host).not.toBeNull()
  try {
    const startup = await host!.handle({ method: 'conversation.capabilities', binding, configuration: f.configuration },
      f.connection, new AbortController().signal)
    expect(startup).toMatchObject({ kind: role === 'agent' ? 'agent-chat' : 'operator',
      configuration: f.configuration, workingDirectory: binding.workingDirectory })
    if (role === 'agent') expect(startup).toHaveProperty('systemPrompt', systemPrompt)
    else expect(startup).not.toHaveProperty('systemPrompt')
  } finally {
    await host!.close()
  }
})


async function callManagedLauncher(token: string) {
  const child = spawn(process.execPath, [appLauncherPath()], {
    env: { ...process.env, FOREMAN_CODE_MCP_TOKEN: token, GRAPHQL_MCP_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(5_000),
  })
  const lines = createInterface({ input: child.stdout })
  const closed = once(child, 'close')
  try {
    const response = once(lines, 'line')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
    const [line] = await response
    return JSON.parse(line as string) as unknown
  } finally {
    lines.close()
    child.stdin.end()
    await closed
  }
}

it('routes Worker Operator MCP calls through the managed launcher and removes the route on close', async () => {
  const f = workerConversationFixture('operator', 'codex')
  const binding = { ...f.binding, appMcpAccess: 'scoped' }
  const stateDirectory = await temporaryDirectory()
  roots.push(stateDirectory)
  selection.appMcpLauncher = join(stateDirectory, 'release', 'artifacts', 'graphql-mcp.mjs')
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(stateDirectory, 'managed-mcp'))
  await installAppLauncher()
  const registry = {
    scope: (owner: string) => ({ owner, root: join(stateDirectory, 'processes') }),
    abandonReservedLaunch: async () => {}, closeOwner: async () => true,
  } as unknown as NativeProcessRegistry
  const journal = { conversations: { inspectBinding: async () => undefined } } as unknown as RemoteOperationJournal
  const tools = [{ name: 'context_get', inputSchema: { type: 'object' } }]
  const forwarded = vi.fn()
  const host = await createInstalledWorkerConversations({
    stateDirectory, configuration: null, registry, journal: async () => journal,
    current: () => f.connection, capture: () => undefined,
    request: async (_namespace, payload) => {
      const call = WorkerConversationMcpRequestSchema.parse(payload)
      expect(call.token).toBe('scoped-operator-credential')
      if (call.operation === 'conversation-mcp.authorize') return {
        payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() },
      }
      forwarded(call.body)
      return { payload: { statusCode: 200, contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }) } }
    },
    approvedRoots: async () => { throw new Error('Directory admission is supplied by this fixture') },
    codexSuiteRevision: 'fixture-suite', signal: new AbortController().signal,
  })
  expect(host).not.toBeNull()
  try {
    await host!.handle({ method: 'conversation.capabilities', binding, configuration: f.configuration,
      admissionId: randomUUID() }, f.connection, new AbortController().signal)
    expect(await callManagedLauncher('scoped-operator-credential'))
      .toEqual({ jsonrpc: '2.0', id: 1, result: { tools } })
    expect(forwarded).toHaveBeenCalledExactlyOnceWith({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(await callManagedLauncher('unissued-credential')).toMatchObject({
      error: { data: { kind: 'route_unavailable' } },
    })
    expect(forwarded).toHaveBeenCalledOnce()
  } finally { await host!.close() }
  expect(await callManagedLauncher('scoped-operator-credential')).toMatchObject({
    error: { data: { kind: 'route_unavailable' } },
  })
})

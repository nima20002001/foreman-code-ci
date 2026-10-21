import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'

import type { WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { runCommand, spawnOwnedStdioProcess } from '../src/modules/harnesses/process.js'

// In-memory native wire fixtures. No executable, provider, database, or network is used.
// The actual managers AND transports run; only process I/O and qualification are substituted.
vi.mock('../src/modules/harnesses/process.js', () => ({ PROCESS_SHUTDOWN_GRACE_MS: 1, runCommand: vi.fn(), spawnOwnedStdioProcess: vi.fn() }))
vi.mock('../src/modules/harnesses/codexQualification.js', () => ({ qualifyNativeCodexModel: vi.fn(async () => {}) }))
vi.mock('../src/modules/harnesses/codexProtocol.js', () => ({
  canonical: JSON.stringify,
  qualifyCodex: vi.fn(async () => ({ binary: 'not-executed', providerVersion: 'codex-cli 0.154.0', protocol: {
    request() {}, notification() {}, response() {}, serverRequest() {}, serverResponse() {},
  } })), assertCodexUnchanged: vi.fn(async () => {}),
}))

type Obj = Record<string, unknown>
const cleanups: Array<() => Promise<void>> = []
const calls: Array<{ method: string; params: Obj }> = []
let ignoreOverride = false
let configured = true
let codexServers: string[] = ['graphql']
const object = (value: unknown) => value as Obj
function errorCode(expected: string) {
  return (error: unknown) => error instanceof HarnessExecutionError && error.result.error?.code === expected
}
function input(): WorkflowNativeSessionStart {
  const fixture = makeCurrentWorkflowFixture('h2-native', 'single')
  const configuration = structuredClone(fixture.configurations[0]!)
  {
    assert.equal(configuration.harness.harness, 'codex')
    if (configuration.harness.harness !== 'codex') throw new Error('The fixture must select Codex.')
    configuration.harness.sandbox = 'read-only'
    configuration.harness.advanced = structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION)
    if (configured) configuration.harness.advanced.mcpServers = {
      graphql: { enabled: true, required: true, disabledTools: [], tools: {} },
      docs: { enabled: true, required: false, disabledTools: [], tools: {} },
    }
  }
  return { kind: 'workflow', correlationId: 'h2-chat', request: {
    executionId: 'agent-chat:h2', runId: 'agent-chat:h2', workspaceId: configuration.workspaceId,
    workflowNodeId: fixture.version.definition.nodes[0]!.id, workingDirectory: '/h2-fixture', runtimeDirectory: '/h2-fixture', configuration, input: {},
  } }
}
function childProcess(onWrite?: (text: string) => void) {
  return Object.assign(new EventEmitter(), { pid: 123456789, exitCode: null, signalCode: null,
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, done) { onWrite?.(String(chunk)); done() } }),
  }) as EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null;
    stdout: PassThrough; stderr: PassThrough; stdin: Writable }
}
function closeChild(child: ReturnType<typeof childProcess>) {
  child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0)
}
function installCodexWire() {
  vi.mocked(spawnOwnedStdioProcess).mockImplementation(async (options) => {
    const servers: Obj = { docs: { enabled: true }, disabled: { enabled: false } }
    for (const name of codexServers) servers[name] = { enabled: ignoreOverride || !options.args.includes(`mcp_servers.${name}.enabled=false`) }
    let resolveClosed!: (exit: Awaited<Awaited<ReturnType<typeof spawnOwnedStdioProcess>>['closed']>) => void
    const closed = new Promise<Awaited<Awaited<ReturnType<typeof spawnOwnedStdioProcess>>['closed']>>((resolve) => { resolveClosed = resolve })
    const child = childProcess((text) => {
      const request = object(JSON.parse(text)), method = String(request.method), params = object(request.params ?? {})
      calls.push({ method, params })
      if (request.id === undefined) { assert.equal(method, 'initialized'); return }
      let result: unknown
      if (method === 'initialize') result = {}
      else if (method === 'config/read') result = { config: { mcp_servers: servers } }
      else if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) result = {
        thread: { id: method === 'thread/resume' ? params.threadId : 'chat-child', turns: [] },
        model: params.model, reasoningEffort: object(params.config).model_reasoning_effort,
        cwd: params.cwd, serviceTier: params.serviceTier, approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'readOnly' },
      }
      else if (method === 'thread/read') result = { thread: { id: params.threadId, turns: [] } }
      else if (method === 'thread/turns/list') result = { data: [], nextCursor: null }
      else throw new Error(`Unexpected Codex method ${method}`)
      queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'))
    })
    return { child: child as unknown as ChildProcessWithoutNullStreams, closed,
      close: async () => { closeChild(child); resolveClosed({ exitCode: 0, exitSignal: null }) } }
  })
}
beforeEach(() => {
  vi.resetAllMocks(); calls.length = 0; ignoreOverride = false; configured = true; codexServers = ['graphql']
  vi.stubEnv('GRAPHQL_MCP_TOKEN', 'must-never-reach-chat')
  vi.stubEnv('DATABASE_URL', 'must-never-reach-chat')
  vi.mocked(runCommand).mockImplementation(async (_binary, args) => {
    const launcher = appLauncherConnection()
    if (args[0] === 'mcp' && args[1] === 'list') {
      const entries = codexServers.map(name => ({
        name,
        transport: { type: 'stdio', command: launcher.executable,
          args: launcher.arguments, env_vars: launcher.environmentVariables },
      }))
      return { exitCode: 0, stdout: JSON.stringify(entries), stderr: '' }
    }
    assert.deepEqual(args.slice(0, 2), ['mcp', 'get'])
    if (!codexServers.includes(args[2]!) && args[2] !== 'docs') return { exitCode: 1, stdout: '',
      stderr: `Error: No MCP server named '${args[2]}' found.` }
    return { exitCode: 0, stdout: JSON.stringify({ name: args[2], enabled: true, required: args[2] === 'graphql',
      transport: { type: 'stdio', command: launcher.executable, args: launcher.arguments, env_vars: launcher.environmentVariables } }), stderr: '' }
  })
})
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})

describe('H2 A-R01: chat-only App MCP exclusion, real adapters with in-memory native I/O', () => {
  for (const operation of ['create', 'attach', 'fork'] as const) {
    for (const harness of ['codex'] as const) {
      it(`${harness} ${operation}: enabled accepted App entry works without credentials and preserves other settings`, async () => {
        const start = input(), before = structuredClone(start)
        const source: NativeSessionReference = { harness, nativeSessionId: 'run-source', providerVersion: 'codex-cli 0.154.0' }
        installCodexWire()
        const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
        cleanups.push(() => manager.dispose())
        const session = operation === 'create' ? await manager.createSession(start)
          : operation === 'attach' ? await manager.attachSession(source, { ...start, instructionsDelivered: true }) : await manager.forkSession(source, start)
        assert.equal(session.nativeSessionId, operation === 'attach' ? 'run-source' : 'chat-child')
        assert.deepEqual(start, before); assert.equal(start.environment, undefined)
        const launched = vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0]
        assert.deepEqual(launched.args, ['app-server', '--stdio',
          '-c', `mcp_servers.graphql.command=${JSON.stringify(appLauncherConnection().executable)}`,
          '-c', 'mcp_servers.graphql.enabled=false'])
        assert.equal(launched.environment?.GRAPHQL_MCP_TOKEN, undefined); assert.equal(launched.environment?.DATABASE_URL, undefined)
        const method = operation === 'create' ? 'thread/start' : operation === 'attach' ? 'thread/resume' : 'thread/fork'
        const request = calls.find((call) => call.method === method)!
        assert.equal(request.params.model, start.request.configuration.harness.model)
        assert.equal(object(request.params.config)['mcp_servers.graphql.enabled'], false)
        assert.equal(object(request.params.config)['mcp_servers.graphql.command'], appLauncherConnection().executable)
        assert.equal(object(request.params.config)['features.apps'], undefined)
        assert.deepEqual(object(request.params.config).shell_environment_policy, {
          inherit: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.inherit,
          ignore_default_excludes: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.ignoreDefaultExcludes,
          filters: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.filters, set: DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment.set,
        })
        assert.equal(calls.filter((call) => call.method === method).length, 1)
        assert.ok(calls.findIndex((call) => call.method === 'config/read') < calls.indexOf(request))
        if (operation !== 'create') assert.equal(request.params.developerInstructions, undefined)
        assert.ok(!calls.some((call) => ['turn/start', 'turn/interrupt', 'config/value/write'].includes(call.method)))
      })
    }
  }

  for (const operation of ['create', 'attach', 'fork'] as const) {
    for (const harness of ['codex'] as const) {
      it(`${harness} ${operation}: an ignored launch override fails closed before session access`, async () => {
        ignoreOverride = true
        const start = input()
        installCodexWire()
        const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
        cleanups.push(() => manager.dispose())
        const source = { harness, nativeSessionId: 'run-source', providerVersion: 'codex-cli 0.154.0' }
        const result = operation === 'create' ? manager.createSession(start)
          : operation === 'attach' ? manager.attachSession(source, start) : manager.forkSession(source, start)
        await assert.rejects(result, errorCode(`${harness.toUpperCase()}_APP_MCP_UNAVAILABLE`))
        assert.ok(!calls.some((call) => call.method.startsWith('thread/')))

      })
    }
  }

  it('Codex: incomplete MCP inspection fails before launching or accessing a session', async () => {
    configured = false
    installCodexWire()
    vi.mocked(runCommand).mockResolvedValueOnce({ exitCode: 0, stdout: '[{"name":"graphql"}]', stderr: '' })
    const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
    cleanups.push(() => manager.dispose())
    await assert.rejects(manager.createSession(input()), errorCode('CODEX_MCP_INSPECTION_FAILED'))
    assert.equal(vi.mocked(spawnOwnedStdioProcess).mock.calls.length, 0)
    assert.equal(calls.length, 0)
  })

  it('Codex: an installation without App MCP still starts without inventing a transport-less server entry', async () => {
    configured = false; codexServers = []; installCodexWire()
    const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
    cleanups.push(() => manager.dispose())
    await manager.createSession(input())
    assert.deepEqual(vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0].args, ['app-server', '--stdio'])
    assert.ok(calls.some((call) => call.method === 'config/read'))
    assert.equal(object(calls.find((call) => call.method === 'thread/start')!.params.config)['mcp_servers.graphql.enabled'], undefined)
  })

  for (const [layout, names] of ([
    ['legacy only', ['graphql-app', 'graphql-operator']],
    ['unified only', ['graphql']],
    ['neither', []],
    ['both', ['graphql', 'graphql-app', 'graphql-operator']],
  ] satisfies Array<[string, string[]]>)) {
    it(`Codex: ${layout} config disables only present App MCP entries`, async () => {
      codexServers = [...names]; configured = names.includes('graphql'); installCodexWire()
      const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
      cleanups.push(() => manager.dispose())
      await manager.createSession(input())
      const transports = names.flatMap(name =>
        ['-c', `mcp_servers.${name}.command=${JSON.stringify(appLauncherConnection().executable)}`])
      const expected = names.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])
      assert.deepEqual(vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0].args,
        ['app-server', '--stdio', ...transports, ...expected])
      const config = object(calls.find((call) => call.method === 'thread/start')!.params.config)
      for (const name of ['graphql', 'graphql-app', 'graphql-operator']) {
        assert.equal(config[`mcp_servers.${name}.enabled`], names.includes(name) ? false : undefined)
      }
    })
  }

  it('Codex: ordinary workflow mode still requires its scoped credential and has no chat override', async () => {
    installCodexWire()
    const start = input(), manager = new CodexAppServerSessionManager('not-executed')
    cleanups.push(() => manager.dispose())
    await assert.rejects(manager.createSession(start), errorCode('CODEX_SCOPED_ENVIRONMENT_REQUIRED'))
    assert.equal(vi.mocked(spawnOwnedStdioProcess).mock.calls.length, 0)
    await manager.createSession({ ...start, environment: { agentId: start.request.configuration.agentId, variables: { GRAPHQL_MCP_TOKEN: 'scoped-workflow-fixture' } } })
    const launch = vi.mocked(spawnOwnedStdioProcess).mock.calls[0]![0]
    assert.deepEqual(launch.args, ['app-server', '--stdio']); assert.equal(launch.environment?.GRAPHQL_MCP_TOKEN, 'scoped-workflow-fixture')
    assert.ok(!calls.some((call) => call.method === 'config/read'))
    assert.equal(object(calls.find((call) => call.method === 'thread/start')!.params.config)['mcp_servers.graphql.enabled'], undefined)
  })

  it('Codex: reopening a retained session re-verifies the chat launch override', async () => {
    installCodexWire()
    const start = input(), manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, 'none')
    cleanups.push(() => manager.dispose())
    const session = await manager.createSession(start)
    await manager.closeForRestart(session)
    await manager.attachSession(session, { ...start, instructionsDelivered: true })
    assert.equal(vi.mocked(spawnOwnedStdioProcess).mock.calls.length, 2)
    for (const [options] of vi.mocked(spawnOwnedStdioProcess).mock.calls) {
      assert.deepEqual(options.args, ['app-server', '--stdio',
        '-c', `mcp_servers.graphql.command=${JSON.stringify(appLauncherConnection().executable)}`,
        '-c', 'mcp_servers.graphql.enabled=false'])
      assert.equal(options.environment?.GRAPHQL_MCP_TOKEN, undefined)
    }
    assert.equal(calls.filter((call) => call.method === 'config/read').length, 2)
    assert.equal(calls.filter((call) => call.method === 'thread/start').length, 1)
    assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1)
  })

})

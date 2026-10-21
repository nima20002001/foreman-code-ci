import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { CodexAppServerSessionManager, type CodexSessionDependencies, type CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

function replay() {
  const calls: string[] = []
  let cleanupFailures = 0
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay',
    environment: () => ({}),
    qualify: async (binary) => {
      calls.push('qualify')
      return { binary, identity: 'recorded-launcher', protocol: fixtureProtocol, providerVersion: RECORDED_CODEX_VERSION,
        schemaManifestSha256: 'recorded-schema', stableSchemaGitBlob: 'recorded-stable', referenceSchemaManifestSha256: 'recorded-reference' }
    },
    assertUnchanged: async () => { calls.push('assertUnchanged') },
    runCommand: async (_binary, args) => {
      calls.push(args.join(' '))
      return { stdout: args[1] === 'list' ? '[]' : '',
        stderr: args[1] === 'get' ? `Error: No MCP server named '${args[2]}' found.` : '',
        exitCode: args[1] === 'get' ? 1 : 0, exitSignal: null }
    },
    qualifyModel: async () => { calls.push('qualifyModel') },
    id: () => 'recorded-connection', now: () => new Date('2026-10-01T00:00:00Z'),
    schedule: setTimeout, cancelTimer: clearTimeout,
    withDiagnostics: async (_pin, run) => run(dependencies),
    transport: (binary, cwd) => {
      calls.push(`transport:${binary}:${cwd}`)
      const transport: CodexTransport = {
        start: async () => { calls.push('start') },
        close: async () => { calls.push('close'); if (cleanupFailures-- > 0) throw new Error('cleanup failed') },
        respond: async () => { throw new Error('Unexpected response') }, reject: async () => { throw new Error('Unexpected rejection') },
        request: async (method, params) => {
          calls.push(method)
          if (method !== 'thread/start') throw new Error(`Unexpected method ${method}`)
          const config = params?.config as JsonObject
          return { thread: { id: 'recorded-native-thread', turns: [], ephemeral: params?.ephemeral },
            model: params?.model, modelProvider: 'openai', cwd: params?.cwd, reasoningEffort: config.model_reasoning_effort,
            serviceTier: null, approvalPolicy: params?.approvalPolicy, approvalsReviewer: params?.approvalsReviewer,
            sandbox: { type: 'readOnly', networkAccess: false } }
        },
      }
      return transport
    },
  }
  return { dependencies, calls, failCleanup: () => { cleanupFailures = 1 } }
}

describe('Codex production/replay dependency boundary', () => {
  it('refuses incomplete replay before starting any native work', () => {
    assert.throws(() => new CodexAppServerSessionManager('/missing', undefined, undefined, undefined, undefined, undefined,
      { mode: 'replay' } as CodexSessionDependencies), /every native IO boundary/)
  })

  it('uses the complete injected boundary, deduplicates native creation and retries failed cleanup', async () => {
    const fixture = replay()
    const manager = new CodexAppServerSessionManager('/nonexistent-recorded-codex', undefined, undefined, undefined, undefined, undefined, fixture.dependencies)
    const source = input('/nonexistent-recorded-workspace')
    delete source.environment
    const first = await manager.createSession(source)
    assert.equal(first.nativeSessionId, 'recorded-native-thread')
    assert.deepEqual(await manager.createSession(source), first)
    assert.equal(fixture.calls.filter((value) => value === 'thread/start').length, 1)
    assert(fixture.calls.includes('assertUnchanged'))
    assert(fixture.calls.includes('qualifyModel'))
    const history = await manager.history(first)
    assert.equal(history.events[0]?.connectionId, 'recorded-connection')
    assert.equal(history.events[0]?.occurredAt, '2026-10-01T00:00:00.000Z')
    fixture.failCleanup()
    await assert.rejects(manager.shutdown(), /cleanup failed/)
    await manager.shutdown()
    assert(fixture.calls.filter((value) => value === 'close').length >= 2)
  })
})

describe('Codex native model discovery', () => {
  it('keeps an empty validated native catalog after diagnostics report a failed remote refresh', async () => {
    const f = replay()
    f.dependencies.transport = (...args) => ({
      start: async () => { args[10]?.() }, close: async () => undefined,
      respond: async () => undefined, reject: async () => undefined,
      request: async method => {
        assert.equal(method, 'model/list')
        return { data: [], nextCursor: null }
      },
    })
    const manager = new CodexAppServerSessionManager('/recorded-codex',
      undefined, undefined, undefined, undefined, undefined, f.dependencies)
    try {
      assert.deepEqual(await manager.discoverModels('/recorded-workspace'), { providerVersion: RECORDED_CODEX_VERSION, models: [] })
      assert(!f.calls.includes('thread/start'))
    } finally { await manager.shutdown() }
  })

  it('publishes native model and effort capabilities from a metadata-only inspection', async () => {
    const f = replay()
    f.dependencies.transport = () => ({
      start: async () => undefined, close: async () => undefined,
      respond: async () => undefined, reject: async () => undefined,
      request: async method => {
        assert.equal(method, 'model/list')
        return { data: [{ model: 'recorded-model', displayName: 'Recorded model', hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], additionalSpeedTiers: ['fast'] }], nextCursor: null }
      },
    })
    const manager = new CodexAppServerSessionManager('/recorded-codex',
      undefined, undefined, undefined, undefined, undefined, f.dependencies)
    try {
      assert.deepEqual((await manager.discoverModels('/recorded-workspace')).models, [{
        id: 'recorded-model', name: 'Recorded model', defaultPriority: 0,
        reasoningEfforts: ['medium'], variants: [], serviceTiers: ['standard', 'priority'],
      }])
      assert(!f.calls.includes('thread/start'))
    } finally { await manager.shutdown() }
  })
})

describe('Codex original placed inspection directory', () => {
  it.each(APP_MCP_SERVER_NAMES.flatMap(serverName => [undefined, '/actual-admitted-source/src']
    .map(workingDirectory => ({ serverName, workingDirectory }))))(
    'qualifies and reads a disabled $serverName entry in the accepted directory with option $workingDirectory',
    async ({ serverName, workingDirectory }) => {
      const f = replay()
      const qualified: string[] = []
      const commands: Array<{ args: string[]; cwd: string }> = []
      const qualify = f.dependencies.qualify
      f.dependencies.qualify = async (...args) => {
        qualified.push(args[1])
        return qualify(...args)
      }
      f.dependencies.runCommand = async (_binary, args, cwd) => {
        commands.push({ args, cwd })
        if (args[2] !== serverName) return { stdout: '',
          stderr: `Error: No MCP server named '${args[2]}' found.`, exitCode: 1 }
        assert.deepEqual(args, ['mcp', 'get', serverName, '--json'])
        return { stdout: JSON.stringify({ name: serverName, enabled: false, transport: { type: 'stdio' } }),
          stderr: '', exitCode: 0 }
      }
      const manager = new CodexAppServerSessionManager('/nonexistent-recorded-codex', undefined, undefined,
        undefined, undefined, undefined, f.dependencies, workingDirectory ? { workingDirectory } : {})
      try {
        await manager.capabilities()
        const detected = await manager.inspectMcp()
        await manager.qualificationEvidence()
        const cwd = workingDirectory ?? process.cwd()
        assert.deepEqual(qualified, [cwd, cwd, cwd])
        assert.deepEqual(commands, ['foreman-code', 'graphql'].map(name => ({ args: ['mcp', 'get', name, '--json'], cwd })))
        assert.equal(detected.serverName, serverName)
        assert.equal(detected.state, 'disabled')
        assert(!f.calls.includes('start'))
        assert(!f.calls.includes('qualifyModel'))
      } finally { await manager.shutdown() }
    })
  for (const serverName of [undefined, 'foreman-code', 'graphql']) {
    it.each([undefined, '/actual-admitted-source/src'])(
      `qualifies and inspects ${serverName ?? 'absent'} MCP in the accepted directory with option %s`,
      async (workingDirectory) => {
        const f = replay()
        const qualified: string[] = []
        const commands: Array<{ args: string[]; cwd: string }> = []
        const qualify = f.dependencies.qualify
        f.dependencies.qualify = async (...args) => {
          qualified.push(args[1])
          return qualify(...args)
        }
        f.dependencies.runCommand = async (_binary, args, cwd) => {
          commands.push({ args, cwd })
          if (args[0] === 'mcp' && args[1] === 'list') return {
            stdout: JSON.stringify(serverName ? [{ name: serverName }] : []),
            stderr: '', exitCode: 0, exitSignal: null,
          }
          if (args[1] === 'get' && args[2] !== serverName) return { stdout: '',
            stderr: `Error: No MCP server named '${args[2]}' found.`, exitCode: 1, exitSignal: null }
          assert.deepEqual(args, ['mcp', 'get', serverName, '--json'])
          return { stdout: JSON.stringify({ enabled: true, transport: { type: 'streamable_http',
            url: 'http://127.0.0.1:3000/mcp', bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' } }),
          stderr: '', exitCode: 0, exitSignal: null }
        }
        const manager = new CodexAppServerSessionManager('/nonexistent-recorded-codex', undefined, undefined,
          undefined, undefined, undefined, f.dependencies, workingDirectory ? { workingDirectory } : {})
        try {
          await manager.capabilities()
          const detected = await manager.inspectMcp()
          await manager.qualificationEvidence()
          const cwd = workingDirectory ?? process.cwd()
          assert.deepEqual(qualified, [cwd, cwd, cwd])
          const expected = ['foreman-code', 'graphql'].map((name) => ({ args: ['mcp', 'get', name, '--json'], cwd }))
          assert.deepEqual(commands, expected)
          assert.equal(detected.serverName, serverName ?? 'foreman-code')
          assert.equal(detected.state, serverName ? 'status_unavailable' : 'not_detected')
          assert.equal(detected.credentialEnvironmentVariable, serverName ? 'FOREMAN_CODE_MCP_TOKEN' : null)
          assert(!f.calls.includes('start'))
          assert(!f.calls.includes('qualifyModel'))
        } finally { await manager.shutdown() }
      },
    )
  }
})

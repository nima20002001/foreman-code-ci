import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager, type CodexDiagnosticPin, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function fixture(appMcpAccess: 'scoped' | 'none' = 'scoped') {
  const source = input('/recorded-workspace')
  if (appMcpAccess === 'none') delete source.environment
  else source.environment = { ...source.environment!, variables: { ...source.environment!.variables, CUSTOM_APP_BEARER: 'writer-fixture' } }
  const ambient = { CUSTOM_APP_BEARER: 'ambient-fixture', GRAPHQL_MCP_TOKEN: 'ambient-standard',
    FOREMAN_CODE_MCP_TOKEN: 'ambient-current', HOST_ONLY: 'host-config' }
  const requests: string[] = []
  const pins: CodexDiagnosticPin[] = []
  const diagnosticEnvironments: NodeJS.ProcessEnv[] = []
  const workFinished = gate()
  let cleanup: ReturnType<typeof gate> | undefined
  let closes = 0
  let disconnect: (() => void) | undefined
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay',
    environment: (scope, excluded = []) => ({ ...Object.fromEntries(Object.entries(ambient)
      .filter(([name]) => name !== 'GRAPHQL_MCP_TOKEN' && name !== 'FOREMAN_CODE_MCP_TOKEN'
        && !excluded.includes(name))), ...scope?.variables }),
    qualify: async (binary) => ({ binary, identity: 'recorded-identity', protocol: fixtureProtocol,
      providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'recorded-schema',
      stableSchemaGitBlob: 'recorded-stable', referenceSchemaManifestSha256: 'recorded-reference' }),
    assertUnchanged: async () => undefined, qualifyModel: async () => undefined,
    runCommand: async (_binary, args) => args[1] === 'get' && args[2] !== 'graphql'
      ? { stdout: '', stderr: `Error: No MCP server named '${args[2]}' found.`, exitCode: 1 }
      : ({ stdout: args[1] === 'list' ? JSON.stringify([{ name: 'graphql',
        transport: { type: 'streamable_http', url: 'http://127.0.0.1:3000/mcp/app',
          bearer_token_env_var: 'CUSTOM_APP_BEARER' } }])
      : JSON.stringify({ enabled: true, transport: { type: 'streamable_http',
        url: 'http://127.0.0.1:3000/mcp/app', bearer_token_env_var: 'CUSTOM_APP_BEARER' } }), stderr: '', exitCode: 0 }),
    id: () => 'recorded-connection', now: () => new Date('2026-10-01T00:00:00Z'),
    schedule: setTimeout, cancelTimer: clearTimeout,
    transport: (...args) => {
      disconnect = () => args[6](new Error('fixture transport disconnected'))
      let closed = false
      return {
        start: async () => undefined,
        close: async () => {
          if (!closed) closes += 1
          closed = true
        },
        respond: async () => undefined, reject: async () => undefined,
        request: async (method, params) => {
          requests.push(method)
          if (method === 'config/read') return { config: { mcp_servers: { graphql: { enabled: false } } } }
          if (method === 'config/mcpServer/reload') return {}
          assert.ok(method === 'thread/start' || method === 'thread/resume')
          const config = params!.config as Record<string, unknown>
          return { thread: { id: 'recorded-thread', turns: [], ephemeral: params!.ephemeral },
            model: params!.model, modelProvider: 'openai', cwd: params!.cwd,
            reasoningEffort: config.model_reasoning_effort, serviceTier: null,
            approvalPolicy: params!.approvalPolicy, approvalsReviewer: params!.approvalsReviewer,
            sandbox: { type: 'readOnly', networkAccess: false } }
        },
      }
    },
    withDiagnostics: async (pin, run) => {
      pins.push(pin)
      // Match the factory contract: its immutable environment ignores the writer
      // input and strips the provider's credential-name pin before any native IO.
      const environment = dependencies.environment(undefined, pin.scopedCredentialVariables)
      const result = await run({ ...dependencies,
        environment: (_scope, excluded = []) => Object.fromEntries(Object.entries(environment).filter(([name]) => !excluded.includes(name))),
        qualify: async (...args) => { diagnosticEnvironments.push({ ...environment }); return dependencies.qualify(...args) },
        runCommand: async (...args) => { diagnosticEnvironments.push({ ...environment }); return dependencies.runCommand(...args) },
        qualifyModel: async (...args) => { diagnosticEnvironments.push({ ...environment }); return dependencies.qualifyModel(...args) },
      })
      workFinished.release()
      // Physical cleanup may finish after a caller abort or native disconnect.
      await cleanup?.promise
      return result
    },
  }
  const manager = new CodexAppServerSessionManager('/recorded-codex', undefined, undefined, undefined, appMcpAccess, undefined, dependencies)
  return { source, manager, pins, requests, ambient, diagnosticEnvironments, workFinished,
    holdCleanup: () => { cleanup = gate(); return cleanup },
    closes: () => closes, disconnect: () => disconnect!() }
}

describe('idle diagnostic credential and control-dispatch fences', () => {
  it('Agent chat pins the previously stripped custom App bearer even without a scoped environment', async () => {
    const f = fixture('none')
    try {
      const session = await f.manager.createSession(f.source)
      await f.manager.reloadNativeMcp(session)
      assert.ok(f.pins[0]!.scopedCredentialVariables.includes('FOREMAN_CODE_MCP_TOKEN'))
      assert.ok(f.pins[0]!.scopedCredentialVariables.includes('GRAPHQL_MCP_TOKEN'))
      assert.ok(f.pins[0]!.scopedCredentialVariables.includes('CUSTOM_APP_BEARER'))
      assert.ok(f.diagnosticEnvironments.length > 0)
      assert.ok(f.diagnosticEnvironments.every((environment) => environment.CUSTOM_APP_BEARER === undefined
        && environment.GRAPHQL_MCP_TOKEN === undefined && environment.FOREMAN_CODE_MCP_TOKEN === undefined))
      assert.equal(f.ambient.CUSTOM_APP_BEARER, 'ambient-fixture')
      assert.equal(f.source.environment, undefined)
      assert.equal(f.closes(), 0)
    } finally { await f.manager.shutdown() }
  })

  for (const operation of ['reload', 'refresh'] as const) {
    for (const ending of ['caller-abort', 'disconnect', 'manager-shutdown'] as const) it(`${operation} does not dispatch after ${ending} during diagnostic cleanup`, async () => {
      const f = fixture()
      const controller = new AbortController()
      const cleanup = f.holdCleanup()
      let shutdown: Promise<void> | undefined
      try {
        const session = await f.manager.createSession(f.source)
        const running = operation === 'reload' ? f.manager.reloadNativeMcp(session, controller.signal)
          : f.manager.refreshProcessEnvironment(session, f.source.environment!, controller.signal)
        const rejected = assert.rejects(running)
        await f.workFinished.promise
        if (ending === 'caller-abort') controller.abort(new Error('fixture caller canceled'))
        else if (ending === 'disconnect') f.disconnect()
        else shutdown = f.manager.shutdown()
        const shutdownCloses = f.closes()
        cleanup.release()
        await rejected
        await shutdown
        assert.equal(f.requests.filter((method) => method === 'config/mcpServer/reload' || method === 'thread/resume').length, 0)
        assert.equal(f.closes(), shutdownCloses)
      } finally {
        cleanup.release()
        await f.manager.shutdown()
      }
    })
  }
})

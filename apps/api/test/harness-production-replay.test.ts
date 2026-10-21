import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { afterEach, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import type { CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import type { ProductionHarnessInfrastructure } from '../src/modules/harnesses/productionInfrastructure.js'
import { buildProductionApp } from '../src/production.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'
import { StrictProtocolReplay } from './support/harnessReplay.js'
import { ProviderAccountsService } from '../src/modules/provider-accounts/service.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const composition = vi.hoisted(() => ({ resolvers: [] as ExecutionScopedNativeSessionManagerResolver[] }))
vi.mock('../src/modules/interactions/runtimePorts.js', async original => {
  const actual = await original<typeof import('../src/modules/interactions/runtimePorts.js')>()
  return { ...actual, ExecutionScopedNativeSessionManagerResolver: class extends actual.ExecutionScopedNativeSessionManagerResolver {
    constructor(...args: ConstructorParameters<typeof actual.ExecutionScopedNativeSessionManagerResolver>) {
      super(...args)
      composition.resolvers.push(this)
    }
  } }
})
afterEach(() => { composition.resolvers.splice(0); vi.restoreAllMocks() })

it('replays native creation through production construction and the real manager with no native fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-replay-'))
  const source = input('/nonexistent-recorded-workspace')
  delete source.environment
  const draft = source.request.configuration.harness
  if (draft.harness !== 'codex') throw new Error('Expected Codex fixture.')
  const advanced = draft.advanced!
  const replay = new StrictProtocolReplay({ schemaVersion: 1, provider: 'codex',
    protocolRevision: 'codex-0.154.0-synthetic', redacted: true, steps: [
      ...['foreman-code', 'graphql'].map((name) => ({ operation: 'command', input: ['mcp', 'get', name, '--json'],
        result: { exitCode: 1, stdout: '', stderr: `Error: No MCP server named '${name}' found.`, exitSignal: null } })),
      { operation: 'thread/start', input: {
        model: 'test-model', serviceTier: 'default', cwd: source.request.workingDirectory,
        runtimeWorkspaceRoots: [source.request.workingDirectory], sandbox: 'read-only',
        approvalPolicy: advanced.approvalPolicy, approvalsReviewer: advanced.approvalsReviewer,
        config: { model_reasoning_effort: 'medium', web_search: advanced.webSearch,
          shell_environment_policy: { inherit: advanced.shellEnvironment.inherit,
            ignore_default_excludes: advanced.shellEnvironment.ignoreDefaultExcludes,
            filters: advanced.shellEnvironment.filters, set: advanced.shellEnvironment.set } },
        developerInstructions: 'Test the native transport.', ephemeral: false,
      }, result: { thread: { id: 'recorded-native-thread', turns: [], ephemeral: false },
        model: 'test-model', modelProvider: 'openai', cwd: source.request.workingDirectory,
        reasoningEffort: 'medium', serviceTier: null, approvalPolicy: advanced.approvalPolicy,
        approvalsReviewer: advanced.approvalsReviewer, sandbox: { type: 'readOnly', networkAccess: false } } },
    ] })
  let transportCloses = 0
  const codex: CodexSessionDependencies = {
    mode: 'replay', environment: () => ({}),
    withDiagnostics: async () => { throw new Error('Unexpected diagnostic replay operation.') },
    qualify: async (binary) => ({ binary, identity: 'recorded-launcher', protocol: fixtureProtocol,
      providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'recorded-schema',
      stableSchemaGitBlob: 'recorded-stable', referenceSchemaManifestSha256: 'recorded-reference' }),
    assertUnchanged: async () => undefined, qualifyModel: async () => undefined,
    runCommand: async (_binary, args) => await replay.call('command', args) as Awaited<ReturnType<NonNullable<CodexSessionDependencies['runCommand']>>>,
    id: () => 'recorded-connection', now: () => new Date('2026-10-01T00:00:00Z'),
    schedule: (() => { throw new Error('This replay expects no timers.') }) as unknown as typeof setTimeout, cancelTimer: clearTimeout,
    transport: () => ({ start: async () => undefined, close: async () => { transportCloses++ },
      request: (operation, params) => replay.call(operation, params),
      respond: async () => { throw new Error('Unexpected native response.') },
      reject: async () => { throw new Error('Unexpected native rejection.') } }),
  }
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected auxiliary replay operation.') }
  const infrastructure: ProductionHarnessInfrastructure = { mode: 'replay', codex,
    inventoryDiscovery: { launcher: async () => { throw new Error('Unexpected replay inventory discovery.') },
      payloads: async () => { throw new Error('Unexpected replay payload discovery.') } },

    auxiliary: { recovery: { scope: (owner) => ({ root: join(directory, 'registry'), owner }),
      reserveLaunch: async (owner) => ({ root: join(directory, 'registry'), owner, launchId: 'recorded-launch' }),
      abandonReservedLaunch: async () => true,
      closeOwner: async () => true }, command: unavailable, plugins: { recoveryIdentity: '', list: unavailable, detail: unavailable, change: unavailable },
      mcp: { codex: { read: unavailable, apply: unavailable } },
      compatibility: { probe: { inspect: unavailable, probe: unavailable, assertUnchanged: unavailable },
        cache: { load: async () => null, save: async () => undefined } } },
  }
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/replay',
    CODEX_BINARY: '/nonexistent-recorded-codex' })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'replay', config.database)
  vi.spyOn(ProviderAccountsService.prototype, 'resolve').mockResolvedValue(null)
  const production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
  try {
    const resolver = composition.resolvers[0]!
    const allocation = resolver.resolve({ executionId: source.request.executionId,
      agentId: source.request.configuration.agentId, harness: 'codex',
      workingDirectory: source.request.workingDirectory, configuration: source.request.configuration })
    const session = await allocation.manager.createSession(source)
    expect(session.nativeSessionId).toBe('recorded-native-thread')
    expect(await allocation.manager.createSession(source)).toEqual(session)
    const history = await allocation.manager.history(session)
    expect(history.events[0]?.occurredAt).toBe('2026-10-01T00:00:00.000Z')
    replay.finish()
  } finally {
    await production.app.close()
    await Promise.all([database.close(), checkpoints.close()])
    await rm(directory, { recursive: true, force: true })
  }
  expect(transportCloses).toBeGreaterThan(0)
})

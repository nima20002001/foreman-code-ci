import { afterEach, expect, it, vi } from 'vitest'
import { CodexAppServerSessionManager, type CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { fixtureProtocol } from './fixtures/codex-test-helpers.js'

const context = { harness: 'codex' as const, runnerId: 'runner-local', workingDirectory: '/workspace' }
const endpoint = 'http://127.0.0.1:3040/mcp'
const phases = ['version', 'authentication', 'schema', 'foreman-code', 'graphql']
afterEach(() => vi.useRealTimers())

function fixture(commandDelay = 15_000) {
  const active = new Set<string>()
  const events: { phase: string; kind: 'start' | 'close'; at: number }[] = []
  let schemaCached = false
  const phase = async (name: string, duration: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    active.add(name)
    events.push({ phase: name, kind: 'start', at: Date.now() })
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const timer = setTimeout(finish, duration)
        const abort = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          reject(signal?.reason)
        }
        signal?.addEventListener('abort', abort, { once: true })
      })
    } finally {
      active.delete(name)
      events.push({ phase: name, kind: 'close', at: Date.now() })
    }
  }
  const forbidden = () => { throw new Error('Inspection cannot run a model or start a session') }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', environment: () => ({}),
    qualify: async (binary, _cwd, _environment, _authenticate, signal) => {
      await phase('version', 29_000, signal)
      await phase('authentication', 29_000, signal)
      if (!schemaCached) {
        await phase('schema', 29_000, signal)
        schemaCached = true
      }
      return { binary, identity: 'recorded', protocol: fixtureProtocol, providerVersion: RECORDED_CODEX_VERSION,
        schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded', referenceSchemaManifestSha256: 'recorded' }
    },
    runCommand: async (_binary, args, _cwd, signal) => {
      const name = args[2]!
      await phase(name, commandDelay, signal)
      if (name === 'graphql') return { exitCode: 1, stdout: '', stderr: "Error: No MCP server named 'graphql' found." }
      return { exitCode: 0, stderr: '', stdout: JSON.stringify({ name, enabled: true,
        transport: { type: 'streamable_http', url: endpoint, bearer_token_env_var: 'FOREMAN_CODE_MCP_TOKEN' } }) }
    },
    assertUnchanged: forbidden, qualifyModel: forbidden, transport: forbidden, withDiagnostics: forbidden,
    id: () => 'recorded', now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
  }
  const manager = new CodexAppServerSessionManager('/recorded-codex', undefined, 'foreman-code',
    undefined, undefined, undefined, dependencies)
  const detection = new McpDetectionService(codexMcpInspectorAdapter(manager), endpoint)
  return { manager, detection, active, events }
}

it('finishes healthy cold and warm inspection under the aggregate deadline with no four-second startup cutoff', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    for (const duration of [117_000, 88_000]) {
      const start = Date.now()
      const pending = f.detection.preflight(context)
      const assertion = expect(pending).resolves.toMatchObject({ detection: { state: 'status_unavailable' } })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(f.active.size).toBe(1)
      await vi.advanceTimersByTimeAsync(duration - 4_000)
      await assertion
      expect(Date.now() - start).toBe(duration)
      expect(f.active.size).toBe(0)
    }
    expect(f.events.filter(event => event.kind === 'start').map(event => event.phase))
      .toEqual([...phases, 'version', 'authentication', 'foreman-code', 'graphql'])
  } finally {
    await f.manager.dispose()
  }
})

it('fires the shared deadline while the final lookup is active and settles every phase', async () => {
  vi.useFakeTimers()
  const f = fixture(17_000)
  try {
    const start = Date.now()
    const pending = f.detection.preflight(context)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(119_999)
    expect([...f.active]).toEqual(['graphql'])
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(Date.now() - start).toBe(120_000)
    expect(f.active.size).toBe(0)
    expect(f.events.at(-1)).toEqual({ phase: 'graphql', kind: 'close', at: Date.now() })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.events.filter(event => event.kind === 'start')).toHaveLength(5)
  } finally {
    await f.manager.dispose()
  }
})

it.each(phases)('cancels during %s without starting a later phase', async selected => {
  vi.useFakeTimers()
  const f = fixture()
  const controller = new AbortController()
  try {
    const pending = f.detection.inspect({ ...context, signal: controller.signal })
    const index = phases.indexOf(selected)
    const durations = [29_000, 29_000, 29_000, 15_000, 15_000]
    await vi.advanceTimersByTimeAsync(durations.slice(0, index).reduce((sum, value) => sum + value, 0) + 1)
    expect([...f.active]).toEqual([selected])
    controller.abort(new Error('Caller canceled inspection'))
    expect((await pending).nativeFilters.diagnostics).toContain('NATIVE_MCP_INSPECTION_CANCELED')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.active.size).toBe(0)
    await vi.advanceTimersByTimeAsync(150_000)
    expect(f.events.filter(event => event.kind === 'start').map(event => event.phase)).toEqual(phases.slice(0, index + 1))
  } finally {
    controller.abort()
    await f.manager.dispose()
  }
})

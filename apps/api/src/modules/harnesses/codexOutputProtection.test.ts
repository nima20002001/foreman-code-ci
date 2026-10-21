import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { QualifiedCodex } from './codexProtocol.js'
import { qualifyCodexOutputProtection } from './codexOutputProtection.js'

const provider = vi.hoisted(() => ({
  padding: '',
  launches: [] as unknown[][],
  threadStarts: [] as Record<string, unknown>[],
}))

vi.mock('./codexProtocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexProtocol.js')>(),
  assertCodexUnchanged: vi.fn(),
}))

vi.mock('./codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    constructor(...args: unknown[]) {
      provider.launches.push(args)
      this.notify = args[5] as (method: string, params: Record<string, unknown>) => void
    }
    private readonly notify: (method: string, params: Record<string, unknown>) => void
    async start() {}
    async close() {}
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'thread/start') {
        provider.threadStarts.push(params)
        const config = params.config as { sandbox_workspace_write: Record<string, unknown> }
        const policy = config.sandbox_workspace_write
        return { thread: { id: 'probe-thread' }, cwd: params.cwd, sandbox: {
          type: 'workspaceWrite', writableRoots: policy.writable_roots,
          networkAccess: policy.network_access, excludeTmpdirEnvVar: policy.exclude_tmpdir_env_var,
          excludeSlashTmp: policy.exclude_slash_tmp,
        } }
      }
      if (method !== 'turn/start') throw new Error('Unexpected probe request')
      const turn = { id: 'probe-turn', status: 'failed', error: {
        message: `Model unavailable opm_${'a'.repeat(43)}${provider.padding}`, codexErrorInfo: 'modelNotFound',
      } }
      this.notify('turn/completed', { threadId: 'probe-thread', turn })
      return { turn }
    }
  },
}))

const directories: string[] = []
afterEach(async () => {
  provider.launches.length = 0
  provider.threadStarts.length = 0
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const configuredServers = [
  { name: 'foreman-code', transport: { type: 'stdio', command: '/fixture/foreman-code' } },
  { name: 'slack', transport: { type: 'streamable_http', url: 'https://slack.example/mcp' } },
  { name: 'plugin_calendar', transport: { type: 'stdio', command: '/fixture/calendar' } },
  { name: 'codex_apps', transport: { type: 'streamable_http', url: 'https://apps.example/mcp' } },
]

it.each([
  { label: 'short', padding: '', servers: [] },
  { label: 'long', padding: 'x'.repeat(4096), servers: [] },
  { label: 'configured tools', padding: '', servers: configuredServers },
])(
  'isolates tools, reports $label failed turn diagnostics and closes its owned actor', async ({ padding, servers }) => {
    provider.padding = padding
    const directory = await mkdtemp(join(tmpdir(), 'native-probe-error-'))
    directories.push(directory)
    const workspace = join(directory, 'workspace')
    const protectedDirectory = join(directory, 'private')
    await mkdir(workspace)
    await mkdir(protectedDirectory)
    const recovery = { root: directory, owner: 'probe-owner' }
    const registry = { reserveLaunch: vi.fn(async () => recovery), abandonReservedLaunch: vi.fn(),
      closeOwner: vi.fn(async () => true) }
    const qualified = { binary: '/fixture/codex', identity: 'fixture-identity',
      schemaManifestSha256: 'fixture-schema', providerVersion: 'codex-cli 0.154.0',
    } as QualifiedCodex
    const probe = qualifyCodexOutputProtection({ qualification: {
      configuration: { harness: 'codex', model: 'fixture-model', reasoningEffort: 'medium',
        sandbox: 'workspace-write', serviceTier: 'standard' },
      binary: qualified.binary, binaryIdentity: qualified.identity, providerVersion: qualified.providerVersion,
      schemaIdentity: qualified.schemaManifestSha256,
      expectedSandbox: { cwd: workspace, writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: process.env.TMPDIR },
    }, protectedDirectory, registry, qualify: async () => qualified,
    command: async () => ({ exitCode: 0, stdout: JSON.stringify(servers), stderr: '' }),
    assertCurrent: async () => {}, signal: new AbortController().signal,
    })
    await expect(probe).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_PROTECTION_FAILED', details: {
      terminalStatus: 'failed',
      terminalError: expect.stringContaining('Model unavailable [REDACTED]'),
      commands: [],
    } })
    if (padding) await expect(probe).rejects.toHaveProperty('details.terminalError.length', 2048)
    expect(registry.abandonReservedLaunch).toHaveBeenCalledWith(recovery)
    expect(registry.closeOwner).toHaveBeenCalledWith(recovery.owner)
    expect(provider.launches).toHaveLength(1)
    expect(provider.launches[0]![9]).toEqual(servers.map(server => server.name))
    expect(provider.launches[0]![11]).toMatchObject({ nativeApps: false, nativePlugins: false })
    const config = provider.threadStarts[0]!.config
    expect(config).toMatchObject({ 'features.apps': false, 'features.plugins': false })
    for (const server of servers) {
      expect(config).toHaveProperty(`mcp_servers.${server.name}.enabled`, false)
    }
    if (servers.length === 0) expect(config).not.toHaveProperty('mcp_servers.codex_apps.enabled')
    else {
      expect(config).toMatchObject({
        'mcp_servers.foreman-code.command': '/fixture/foreman-code',
        'mcp_servers.slack.url': 'https://slack.example/mcp',
        'mcp_servers.plugin_calendar.command': '/fixture/calendar',
      })
    }
  })

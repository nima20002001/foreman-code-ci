import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { CodexMcpConnections } from '../src/modules/harnesses/codexMcpConnections.js'
import { WorkerManagedMcp } from '../src/modules/harnesses/workerManagedMcp.js'
import { createRemoteReviewProvider } from './helpers/remoteReviewProvider.js'

afterEach(() => vi.unstubAllEnvs())

it('exposes user MCP ownership and persists managed changes through the native fixture', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'remote-review-native-mcp-'))
  const home = join(directory, 'codex-home')
  const launcher = join(directory, 'mcp', 'launcher.mjs')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'config.toml'), '')
  vi.stubEnv('CODEX_HOME', home)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(directory, 'mcp'))
  try {
    const provider = await createRemoteReviewProvider(join(directory, 'provider'), launcher)
    const adapter = new CodexMcpConnections(provider.binary, directory, undefined, async () => {})
    const worker = new WorkerManagedMcp({ directory,
      adapters: { codex: adapter, claude: adapter }, installLauncher: async () => {} })
    const signal = AbortSignal.timeout(20_000)
    const snapshot = await adapter.read(signal)
    expect(snapshot.user['foreman-code']).toMatchObject({ args: [launcher], enabled: true })
    expect(snapshot.ownership?.['foreman-code']).toBe(true)
    await worker.ensureReady(['codex'], { signal })
    const disabled = await worker.apply({ harness: 'codex', preset: 'graphql', enabled: false,
      commandId: 'disable-fixture-mcp' }, 'operator', signal)
    expect(disabled.status).toBe('applied')
    expect((await worker.list('codex', signal)).presets.graphql).toBe('disabled')
    const enabled = await worker.apply({ harness: 'codex', preset: 'graphql', enabled: true,
      commandId: 'enable-fixture-mcp' }, 'operator', signal)
    expect(enabled.status).toBe('applied')
    expect((await worker.list('codex', signal)).presets.graphql).toBe('installed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

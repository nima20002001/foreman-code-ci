import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeMcpConnections } from './claudeMcpConnections.js'
import { WorkerManagedMcp } from './workerManagedMcp.js'

it('writes the managed Claude entry through a user-owned symlink and preserves other connections and settings', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'claude-managed-mcp-'))
  try {
    const file = join(directory, '.claude.json')
    const target = join(directory, 'native-settings.json')
    const original = { theme: 'dark', mcpServers: { example: { type: 'http', url: 'https://example.test/mcp' } } }
    await writeFile(target, JSON.stringify(original), { mode: 0o600 })
    await symlink(target, file)
    const adapter = new ClaudeMcpConnections(file)
    const worker = new WorkerManagedMcp({ directory, adapters: { codex: adapter, claude: adapter }, installLauncher: async () => {} })
    const plan = await worker.apply({ harness: 'claude', preset: 'graphql', installed: true, commandId: 'claude-install' },
      'operator', AbortSignal.timeout(5000))
    expect(plan.status).toBe('applied')
    const settings = JSON.parse(await readFile(target, 'utf8'))
    expect(settings).toMatchObject(original)
    expect(settings.mcpServers['foreman-code']).toMatchObject({ type: 'stdio', command: process.execPath,
      env: { FOREMAN_CODE_MCP_TOKEN: '${FOREMAN_CODE_MCP_TOKEN}' }, enabled: true })
    expect((await worker.list('claude', AbortSignal.timeout(5000))).presets.graphql).toBe('installed')
    await worker.apply({ harness: 'claude', preset: 'graphql', enabled: false, commandId: 'claude-disable' },
      'operator', AbortSignal.timeout(5000))
    await worker.ensureReady(['claude'])
    expect((await worker.list('claude', AbortSignal.timeout(5000))).presets.graphql).toBe('disabled')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

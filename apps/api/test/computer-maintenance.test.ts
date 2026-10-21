import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComputerMaintenance, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { syncableServers } from '../src/modules/computers/fleet.js'

type Run = { binary: string; args: string[] }
function ports(overrides: { versions?: Record<string, string | null>; sudo?: boolean; apt?: string; afterUpgrade?: string; files?: Record<string, string>;
  codexMcp?: string[]; oauthMcp?: string[]; plugins?: string[]; marketplaces?: string[]; fail?: (run: Run) => boolean;
  /** The computer runs an installer-pinned Codex, so npm installs the update elsewhere. */ pinnedCodex?: boolean } = {}) {
  const marketplaces = [...overrides.marketplaces ?? ['openai']], plugins = [...overrides.plugins ?? []]
  const codexMcp = [...overrides.codexMcp ?? []]
  const codexDefinitions = new Map<string, unknown>()
  let aptOutput = overrides.apt ?? '2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'
  const runs: Run[] = []
  const written: Record<string, string> = {}
  const later: Array<() => void> = []
  const versions: Record<string, string | null> = { codex: 'codex-cli 0.160.0', claude: '2.1.19 (Claude Code)', ...overrides.versions }
  const value: MaintenancePorts = {
    environment: { HOME: '/home/owner' },
    find: async name => {
      if (name in versions && versions[name] === null) return null
      return ['codex', 'claude', 'npm', 'apt-get', 'npx'].includes(name) ? `/usr/bin/${name}` : null
    },
    run: async (binary, args) => {
      runs.push({ binary, args })
      if (overrides.fail?.({ binary, args })) return { code: 1, stdout: '', stderr: 'boom' }
      const name = binary.split('/').at(-1)!
      if (args[0] === '--version') return { code: 0, stdout: versions[name] ?? '', stderr: '' }
      if (name === 'npm' && args[0] === 'view') return { code: 0, stdout: args[1] === '@openai/codex' ? '0.161.0\n' : '2.1.294\n', stderr: '' }
      if (name === 'npm' && args[0] === 'install') { if (!overrides.pinnedCodex) versions.codex = 'codex-cli 0.161.0'; return { code: 0, stdout: 'added 1 package', stderr: '' } }
      if (name === 'claude' && args[0] === 'update') { versions.claude = '2.1.294 (Claude Code)'; return { code: 0, stdout: 'updated', stderr: '' } }
      if (name === 'apt-get') return { code: 0, stdout: aptOutput, stderr: '' }
      if (binary === 'sudo' && args[1] === 'true') return { code: overrides.sudo === false ? 1 : 0, stdout: '', stderr: overrides.sudo === false ? 'sudo: a password is required' : '' }
      if (binary === 'sudo' && args.includes('upgrade')) {
        aptOutput = overrides.afterUpgrade ?? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.'
        return { code: 0, stdout: '2 upgraded, 0 newly installed', stderr: '' }
      }
      if (name === 'codex' && args[0] === 'mcp' && args[1] === 'list') return { code: 0,
        stdout: JSON.stringify(codexMcp.map(name => ({ name, transport: codexDefinitions.get(name) }))), stderr: '' }
      if (name === 'codex' && args[0] === 'mcp' && args[1] === 'add') {
        codexMcp.push(args[2]!)
        const separator = args.indexOf('--')
        codexDefinitions.set(args[2]!, separator >= 0
          ? { type: 'stdio', command: args[separator + 1], args: args.slice(separator + 2) }
          : { type: 'streamable_http', url: args[args.indexOf('--url') + 1],
            bearer_token_env_var: args.includes('--bearer-token-env-var')
              ? args[args.indexOf('--bearer-token-env-var') + 1] : null })
        // Codex saves an OAuth server, then fails when nobody completes the browser sign-in.
        if (overrides.oauthMcp?.includes(args[2]!)) return { code: 1, stdout: 'Added global MCP server.\nDetected OAuth support.', stderr: 'timed out waiting for OAuth callback' }
      }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'list') return { code: 0, stdout: JSON.stringify({ installed: plugins.map(pluginId => ({ pluginId, installed: true })) }), stderr: '' }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'marketplace') {
        if (args[2] === 'list') return { code: 0, stdout: JSON.stringify({ marketplaces: marketplaces.map(name => ({ name, marketplaceSource: { sourceType: 'git', source: name } })) }), stderr: '' }
        marketplaces.push(args[3]!.split('/').at(-1)!.replace(/\.git$/u, ''))
        return { code: 0, stdout: '', stderr: '' }
      }
      if (name === 'codex' && args[0] === 'mcp' && args[1] === 'remove') { codexMcp.splice(codexMcp.indexOf(args[2]!), 1); return { code: 0, stdout: '', stderr: '' } }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'remove') { plugins.splice(plugins.indexOf(args[2]!), 1); return { code: 0, stdout: '', stderr: '' } }
      if (name === 'codex' && args[0] === 'plugin' && args[1] === 'add') {
        if (!marketplaces.includes(args[2]!.split('@')[1]!)) return { code: 1, stdout: '', stderr: 'plugin was not found in marketplace' }
        plugins.push(args[2]!)
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    exists: async path => path === '/var/run/reboot-required' && Boolean(overrides.files?.[path]),
    readText: async path => written[path] ?? overrides.files?.[path] ?? null,
    writePrivateText: async (path, text) => { written[path] = text },
    disk: async () => ({ freeBytes: 50, totalBytes: 100 }),
    later: fn => { later.push(fn) },
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  }
  return { value, runs, later, versions, written, codexMcp, plugins }
}
async function settle(maintenance: ComputerMaintenance) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await maintenance.status(AbortSignal.timeout(1000))
    if (status.tasks.every(task => task.state !== 'running')) return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish')
}

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('computer maintenance', () => {
  it('reports harness versions against the latest release, OS updates, restart, sudo and disk', async () => {
    const fake = ports({ files: { '/var/run/reboot-required': '1' } })
    const status = await new ComputerMaintenance(fake.value).status(AbortSignal.timeout(1000))
    expect(status.harnesses).toEqual([
      { harness: 'codex', installed: true, version: '0.160.0', latest: '0.161.0' },
      { harness: 'claude', installed: true, version: '2.1.19', latest: '2.1.294' },
    ])
    expect(status.system).toEqual({ packageUpdates: 2, rebootRequired: true, sudo: true, disk: { path: '/home/owner', freeBytes: 50, totalBytes: 100 } })
  })

  it('updates Codex through npm in the user prefix and Claude through its own updater', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    expect((await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex', 'claude'] })).state).toBe('running')
    const status = await settle(maintenance)
    expect(status.tasks[0]).toMatchObject({ kind: 'update-harnesses', state: 'succeeded', summary: 'Codex 0.160.0 → 0.161.0 · Claude 2.1.19 → 2.1.294' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/npm', args: ['install', '--global', '--include=optional',
      '--prefix', '/home/owner/.local', '@openai/codex@latest'] })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/claude', args: ['update'] })
  })

  it.each([false, true])('retries a Codex staging rename once and persists the result (fails again: %s)', async failsAgain => {
    const home = await mkdtemp(join(tmpdir(), 'maintenance-staging-'))
    homes.push(home)
    const scope = join(home, '.local', 'lib', 'node_modules', '@openai')
    await mkdir(join(scope, '.codex-stale123'), { recursive: true })
    await writeFile(join(scope, '.codex-stale123', 'package.json'), '{}')
    await mkdir(join(scope, 'codex'))
    const fake = ports()
    fake.value.environment.HOME = home
    const run = fake.value.run
    let installs = 0
    fake.value.run = async (binary, args, options) => {
      if (args[0] === 'install') {
        installs++
        if (installs === 1 || failsAgain) return { code: 217, stdout: '',
          stderr: `npm error ENOTEMPTY: directory not empty, rename '${scope}/codex' -> '${scope}/.codex-stale123'` }
        expect(await readdir(scope)).toEqual(['codex'])
      }
      return run(binary, args, options)
    }
    const maintenance = new ComputerMaintenance(fake.value)
    const started = await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    const task = (await settle(maintenance)).tasks.find(task => task.id === started.id)
    expect(installs).toBe(2)
    expect(await readdir(scope)).toEqual(['codex'])
    expect(task?.state).toBe(failsAgain ? 'failed' : 'succeeded')
    if (failsAgain) expect(task?.summary).toContain('failed after stale npm staging cleanup and one retry')
    else expect(task?.summary).toBe('Codex 0.160.0 → 0.161.0')
    expect(task?.outputTail).toContain('retry after stale npm staging cleanup')
    const persisted = await new ComputerMaintenance(fake.value).status(AbortSignal.timeout(1000))
    expect(persisted.tasks.find(task => task.id === started.id)).toEqual(task)
  })

  it('does not retry an unrelated npm failure', async () => {
    const fake = ports()
    const run = fake.value.run
    let installs = 0
    fake.value.run = async (binary, args, options) => {
      if (args[0] === 'install') {
        installs++
        return { code: 1, stdout: '', stderr: 'npm error EACCES permission denied' }
      }
      return run(binary, args, options)
    }
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    expect((await settle(maintenance)).tasks[0]?.state).toBe('failed')
    expect(installs).toBe(1)
  })

  it('runs a non-interactive sudo apt upgrade and refuses OS work without passwordless sudo', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'update-system' })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: '2 packages upgraded · no pending updates' })
    const upgrade = fake.runs.find(run => run.binary === 'sudo' && run.args.includes('upgrade'))!
    expect(upgrade.args).toEqual(expect.arrayContaining(['-n', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', '-y', 'Dpkg::Options::=--force-confold', '--with-new-pkgs']))
    const locked = new ComputerMaintenance(ports({ sudo: false }).value)
    await locked.start({ kind: 'restart' })
    expect((await settle(locked)).tasks[0]).toMatchObject({ state: 'failed', summary: 'This computer needs passwordless sudo for OS updates and restarts.' })
  })

  it('keeps deferred and held packages visible instead of reporting up to date', async () => {
    const fake = ports({ apt: '0 upgraded, 0 newly installed, 0 to remove and 23 not upgraded.' })
    expect((await new ComputerMaintenance(fake.value).status(AbortSignal.timeout(1000))).system.packageUpdates).toBe(23)
  })

  it('reads package state after an upgrade and reports deferred updates still pending', async () => {
    const maintenance = new ComputerMaintenance(ports({
      afterUpgrade: '0 upgraded, 0 newly installed, 0 to remove and 23 not upgraded.',
    }).value)
    await maintenance.start({ kind: 'update-system' })
    const result = await settle(maintenance)
    expect(result.system.packageUpdates).toBe(23)
    expect(result.tasks[0]).toMatchObject({ state: 'succeeded',
      summary: '2 packages upgraded · 23 updates pending (deferred or held by APT)' })
  })

  it('does not claim verified success when installable packages remain or readback fails', async () => {
    for (const afterUpgrade of ['1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', 'unreadable']) {
      const maintenance = new ComputerMaintenance(ports({ afterUpgrade }).value)
      const commandId = randomUUID()
      await maintenance.start({ kind: 'update-system' }, commandId)
      await maintenance.drain()
      expect(await maintenance.start({ kind: 'update-system' }, commandId)).toMatchObject({
        id: commandId, state: 'failed',
        summary: expect.stringContaining(afterUpgrade === 'unreadable' ? 'invalid output' : '1 installable updates remain'),
      })
    }
    await expect(new ComputerMaintenance(ports({ apt: 'unreadable' }).value).status(AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'COMPUTER_PACKAGE_UPDATES_UNAVAILABLE' })
  })

  it('does not report a harness current when its updater left the old binary in place', async () => {
    const fake = ports()
    const run = fake.value.run
    fake.value.run = async (binary, args, options) => args[0] === 'install'
      ? { code: 0, stdout: 'updated', stderr: '' } : run(binary, args, options)
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed',
      summary: 'Codex is still 0.160.0; latest published version is 0.161.0.' })
  })

  it.each([
    { code: 'EDQUOT', errno: -122 },
    { code: 'Unknown system error -122', errno: -122 },
    { code: 'ENOSPC', errno: -28 },
  ])('reports actionable storage errors after npm succeeds: %j', async details => {
    const fake = ports()
    fake.value.selectInstalledCodex = async () => {
      throw Object.assign(new Error('Unknown system error'), details)
    }
    const maintenance = new ComputerMaintenance(fake.value)
    const started = await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    const task = (await settle(maintenance)).tasks.find(task => task.id === started.id)
    expect(task).toMatchObject({ state: 'failed', summary: expect.stringContaining('then retry maintenance') })
    expect(task?.summary).toContain(details.errno === -122 ? 'Disk quota reached' : 'out of disk space')
    expect(task?.summary).not.toContain('Unknown system error')
    const persisted = await new ComputerMaintenance(fake.value).status(AbortSignal.timeout(1000))
    expect(persisted.tasks.find(task => task.id === started.id)).toEqual(task)
    expect(fake.runs.some(run => run.binary.endsWith('npm') && run.args[0] === 'install')).toBe(true)
  })

  it('moves the Worker pinned Codex selection to the installed update before verifying it', async () => {
    const pinned = ports({ pinnedCodex: true })
    const unmoved = new ComputerMaintenance(pinned.value)
    await unmoved.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    expect((await settle(unmoved)).tasks[0]).toMatchObject({ state: 'failed',
      summary: 'Codex is still 0.160.0; latest published version is 0.161.0.' })
    const fake = ports({ pinnedCodex: true })
    const selections: string[] = []
    const maintenance = new ComputerMaintenance({ ...fake.value, async selectInstalledCodex() {
      selections.push('/home/owner/.local/lib/node_modules/@openai/codex/native/codex')
      fake.versions.codex = 'codex-cli 0.161.0'
      return selections.at(-1)!
    } })
    await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex'] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex 0.160.0 → 0.161.0' })
    expect(selections).toHaveLength(1)
  })

  it('updates Claude even when the Codex update fails, and reports both results', async () => {
    const fake = ports({ fail: run => run.binary.endsWith('npm') && run.args[0] === 'install' })
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'update-harnesses', harnesses: ['codex', 'claude'] })
    const task = (await settle(maintenance)).tasks[0]!
    expect(task.state).toBe('failed')
    expect(task.summary).toContain('Claude 2.1.19 → 2.1.294')
    expect(task.summary).toContain('npm install @openai/codex@latest failed')
    expect(fake.runs.some(run => run.binary.endsWith('claude') && run.args[0] === 'update')).toBe(true)
  })

  it('answers before restarting and never starts the same kind twice at once', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    const first = await maintenance.start({ kind: 'restart' })
    expect((await maintenance.start({ kind: 'restart' })).id).toBe(first.id)
    await expect.poll(() => fake.later.length).toBe(1)
    expect((await maintenance.status(AbortSignal.timeout(1000))).tasks[0]?.state).toBe('running')
    expect(fake.runs.some(run => run.args.includes('reboot'))).toBe(false)
    fake.later.forEach(run => run())
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded',
      summary: 'Restart command accepted. Waiting for this computer to reconnect.' })
    expect(fake.runs).toContainEqual({ binary: 'sudo', args: ['-n', 'systemctl', 'reboot'] })
  })

  it('adds only missing MCP servers and plugins and leaves an absent harness pending', async () => {
    const fake = ports({ versions: { claude: null }, codexMcp: ['docs'], plugins: ['pdf@openai'] })
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null },
        { transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] }],
      claude: [{ transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed',
      summary: 'Claude is not installed; MCP sync remains pending. · Codex: Added search' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/codex', args: ['mcp', 'add', 'search', '--', 'npx', 'search-mcp'] })
    await maintenance.start({ kind: 'sync-plugins', claudePlugins: [], claudeMarketplaces: [], plugins: ['pdf@openai', 'documents@openai'], marketplaces: [] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex: Installed documents@openai · Claude: Nothing to sync' })
  })

  it('adds a missing Git marketplace before its plugins, and one plugin that cannot install does not stop the others', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'sync-plugins', claudePlugins: [], claudeMarketplaces: [], plugins: ['skill-creator@claude-plugins-official', 'lost@elsewhere', 'pdf@openai'],
      marketplaces: [{ name: 'claude-plugins-official', source: 'https://github.com/anthropics/claude-plugins-official.git' }] })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed',
      summary: 'Codex: Installed skill-creator@claude-plugins-official, pdf@openai · Could not install lost@elsewhere · Claude: Nothing to sync' })
    expect(fake.runs).toContainEqual({ binary: '/usr/bin/codex', args: ['plugin', 'marketplace', 'add', 'https://github.com/anthropics/claude-plugins-official.git'] })
  })
})

describe('fleet MCP sync with OAuth servers', () => {
  it('keeps an OAuth server that Codex saved, continues with the rest, and asks for sign-in on that computer', async () => {
    const fake = ports({ versions: { claude: null }, oauthMcp: ['linear'] })
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'sync-mcp', servers: {
      codex: [{ transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: null },
        { transport: 'http', name: 'docs', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }], claude: [] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'succeeded', summary: 'Codex: Added linear (sign in on this computer), docs' })
  })

  it('fails when Codex could not save the server', async () => {
    const fake = ports({ fail: run => run.args[1] === 'add' })
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'sync-mcp', servers: { codex: [{ transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] }], claude: [] } })
    expect((await settle(maintenance)).tasks[0]).toMatchObject({ state: 'failed', summary: 'codex mcp add search failed.' })
  })
})

describe('fleet MCP sync source', () => {
  it('removes servers and plugins Main removed, but never ones the computer has on its own', async () => {
    const fake = ports({ codexMcp: ['own-local'], plugins: ['own@openai'] })
    const maintenance = new ComputerMaintenance(fake.value)
    const server = (name: string) => ({ name, transport: 'http' as const, url: `https://${name}.example/mcp`, bearerTokenEnvVar: null })
    const sync = async (servers: string[], plugins: string[]) => {
      await maintenance.start({ kind: 'sync-mcp', servers: { codex: servers.map(server), claude: [] } })
      await settle(maintenance)
      await maintenance.start({ kind: 'sync-plugins', plugins, marketplaces: [], claudePlugins: [], claudeMarketplaces: [] })
      return settle(maintenance)
    }
    await sync(['docs', 'linear'], ['shared@openai'])
    expect(fake.codexMcp.sort()).toEqual(['docs', 'linear', 'own-local'])
    expect(fake.plugins.sort()).toEqual(['own@openai', 'shared@openai'])
    const status = await sync(['docs'], [])
    expect(fake.codexMcp.sort()).toEqual(['docs', 'own-local'])
    expect(fake.plugins).toEqual(['own@openai'])
    expect(status.tasks.find(task => task.kind === 'sync-mcp')?.summary).toContain('Removed linear')
    expect(status.tasks.find(task => task.kind === 'sync-plugins')?.summary).toContain('Removed shared@openai')
    // The computer remembers what Main gave it, privately, across restarts of the maintenance owner.
    const restarted = new ComputerMaintenance(fake.value)
    await restarted.start({ kind: 'sync-mcp', servers: { codex: [], claude: [] } })
    await settle(restarted)
    expect(fake.codexMcp).toEqual(['own-local'])
  })

  it('records both MCP and plugin syncs when they run at the same time', async () => {
    const fake = ports()
    const maintenance = new ComputerMaintenance(fake.value)
    await maintenance.start({ kind: 'sync-mcp', servers: { codex: [{ name: 'docs', transport: 'http', url: 'https://docs.example/mcp', bearerTokenEnvVar: null }], claude: [] } })
    await maintenance.start({ kind: 'sync-plugins', plugins: ['shared@openai'], marketplaces: [], claudePlugins: [], claudeMarketplaces: [] })
    await settle(maintenance)
    const restarted = new ComputerMaintenance(fake.value)
    await Promise.all([
      restarted.start({ kind: 'sync-mcp', servers: { codex: [], claude: [] } }),
      restarted.start({ kind: 'sync-plugins', plugins: [], marketplaces: [], claudePlugins: [], claudeMarketplaces: [] }),
    ])
    await settle(restarted)
    expect(fake.codexMcp).toEqual([])
    expect(fake.plugins).toEqual([])
  })

  it('copies servers without inline secrets and never the app MCP', () => {
    expect(syncableServers({
      'foreman-code': { command: 'foreman-mcp' }, graphql: { url: 'http://127.0.0.1:3000/mcp' },
      linear: { url: 'https://mcp.linear.app/mcp', bearer_token_env_var: 'LINEAR_TOKEN' },
      search: { command: 'npx', args: ['search-mcp'] },
      secret: { command: 'npx', args: ['x'], env: { API_KEY: 'value' } },
      querySecret: { url: 'https://example.test/mcp?token=secret' },
      argumentSecret: { command: 'npx', args: ['x', '--token', 'secret'] },
      claude: { type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
    })).toEqual([
      { transport: 'http', name: 'linear', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: 'LINEAR_TOKEN' },
      { transport: 'stdio', name: 'search', command: 'npx', args: ['search-mcp'], envVars: [] },
    ])
  })
})

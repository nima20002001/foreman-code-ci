import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ComputerMaintenance, installedPlugins, pluginMarketplaces, systemMaintenancePorts } from '../src/modules/computers/maintenance.js'
import type { MaintenancePorts } from '../src/modules/computers/maintenancePorts.js'

async function marketplace(root: string, versions: Record<string, string>) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'fixture-tools', owner: { name: 'Fixture author' },
    plugins: Object.keys(versions).map(name => ({ name, source: `./${name}`, description: 'Local test plugin' })),
  }))
  for (const name of Object.keys(versions)) {
    await mkdir(join(root, name, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, name, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name, version: versions[name], description: 'Local test plugin',
    }))
  }
}

it.each(['regular file', 'relative symlink'] as const)(
  'refreshes stale native Codex catalogs with a %s manifest without upgrading independent installations', async manifest => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const home = await mkdtemp(join(cache, 'native-plugin-source-'))
  const binary = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  const original = join(home, '.codex', '.tmp', 'marketplaces', 'fixture-tools')
  const acquired = join(home, 'acquired')
  let available = original
  const environment = { HOME: home, CODEX_HOME: join(home, '.codex'),
    XDG_CACHE_HOME: join(home, 'cache'), PATH: process.env.PATH ?? '' }
  const native = systemMaintenancePorts(environment, { codex: binary })
  const signal = AbortSignal.timeout(25_000)
  const run = async (args: string[]) => {
    const result = await native.run(binary, args, { signal, timeoutMs: 20_000 })
    expect(result, result.stderr).toMatchObject({ code: 0 })
  }
  let maintenance: ComputerMaintenance | undefined
  try {
    await mkdir(environment.CODEX_HOME, { recursive: true })
    await marketplace(original, { notes: '1.0.0', independent: '0.5.0' })
    await marketplace(acquired, { notes: '2.0.0', independent: '9.0.0', calendar: '1.0.0' })
    if (manifest === 'relative symlink') {
      const path = join(acquired, '.claude-plugin', 'marketplace.json')
      await rename(path, join(acquired, 'catalog.json'))
      await symlink('../catalog.json', path)
    }
    // Seed a Worker's previously fetched Git snapshot; acquisition below supplies the newly published tree.
    await writeFile(join(environment.CODEX_HOME, 'config.toml'),
      '[marketplaces.fixture-tools]\nsource_type = "git"\nsource = "https://github.com/owner/fixture-tools.git"\n')
    await run(['plugin', 'add', 'independent@fixture-tools', '--json'])
    const ports: MaintenancePorts = {
      ...native,
      find: async name => {
        if (name === 'codex') return binary
        if (name === 'npm') return '/fixture/npm'
        return null
      },
      run: async (command, args, options) => {
        if (command === '/fixture/npm') return { code: 0, stdout: '0.154.0', stderr: '' }
        if (command === 'sudo') return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
        const stagedHome = options.environment?.CODEX_HOME
        if (stagedHome && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
          const root = join(stagedHome, 'marketplace')
          await cp(available, root, { recursive: true, verbatimSymlinks: true })
          return native.run(command, [...args.slice(0, 3), root, ...args.slice(4)],
            { ...options, signal: AbortSignal.any([signal, options.signal]) })
        }
        return native.run(command, args, { ...options, signal: AbortSignal.any([signal, options.signal]) })
      },
    }
    maintenance = new ComputerMaintenance(ports)
    await maintenance.start({ kind: 'sync-plugins', plugins: ['notes@fixture-tools'],
      pluginVersions: { 'notes@fixture-tools': '1.0.0' },
      marketplaces: [{ name: 'fixture-tools', source: 'owner/fixture-tools' }] })
    await maintenance.drain()
    const initial = await maintenance.status(signal)
    expect(initial.tasks[0], initial.tasks[0]?.summary).toMatchObject({ state: 'succeeded' })
    expect(await installedPlugins(native, binary, signal))
      .toContainEqual({ pluginId: 'notes@fixture-tools', version: '1.0.0' })
    available = acquired
    await maintenance.start({ kind: 'sync-plugins', plugins: ['notes@fixture-tools', 'calendar@fixture-tools'],
      pluginVersions: { 'notes@fixture-tools': '2.0.0', 'calendar@fixture-tools': '1.0.0' },
      marketplaces: [{ name: 'fixture-tools', source: 'owner/fixture-tools' }] })
    await maintenance.drain()
    const status = await maintenance.status(signal)
    expect(status.tasks[0], status.tasks[0]?.summary).toMatchObject({ state: 'succeeded' })
    const installed = await installedPlugins(native, binary, signal)
    expect(installed).toContainEqual({ pluginId: 'notes@fixture-tools', version: '2.0.0' })
    expect(installed).toContainEqual({ pluginId: 'calendar@fixture-tools', version: '1.0.0' })
    expect(installed).toContainEqual({ pluginId: 'independent@fixture-tools', version: '0.5.0' })
    expect(await pluginMarketplaces(native, binary, signal)).toContainEqual({ name: 'fixture-tools',
      gitSource: 'https://github.com/owner/fixture-tools.git', local: false })
  } finally {
    await maintenance?.drain()
    await rm(home, { recursive: true, force: true })
  }
  },
)

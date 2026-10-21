import { homedir } from 'node:os'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readClaudePlugins } from '../../src/modules/computers/claudePlugins.js'
import { installedPlugins } from '../../src/modules/computers/maintenance.js'
import { fakeComputer } from './fleetSync.js'

export const fleetPluginId = 'notes@official'

/** Native installs read a local marketplace snapshot until a refresh fetches the published catalog. */
export function versionedComputer() {
  const computer = fakeComputer()
  computer.ports.environment.XDG_CACHE_HOME = join(homedir(), '.cache')
  const versions = { codex: new Map<string, string>(), claude: new Map<string, string>() }
  const snapshots = { codex: '1.0.0', claude: '1.0.0' }
  const knownMarketplaces = { codex: new Set(['official']), claude: new Set<string>() }
  const staging = new Map<string, { snapshot: string; installed: Map<string, string> }>()
  computer.ports.refreshCodexMarketplace = async (_binary, _name, acquiredRoot) => {
    await access(acquiredRoot)
    const acquired = [...staging].find(([home]) => join(home, 'marketplace') === acquiredRoot)?.[1]
    if (!acquired) throw new Error('Acquired marketplace is unavailable')
    snapshots.codex = acquired.snapshot
  }
  let published = '1.0.0'
  let retainVersion = false
  let acquisitionFailure = false
  let activationFault: 'failure' | 'different-release' | undefined
  Object.assign(computer.ports, { backupPlugin: async (harness: 'codex' | 'claude', pluginId: string) => {
    const version = versions[harness].get(pluginId)
    const enabled = computer.claudePlugins.get(pluginId)
    return {
      restore: async () => {
        if (version !== undefined) versions[harness].set(pluginId, version)
        if (harness === 'codex') computer.codexPlugins.add(pluginId)
        else if (enabled !== undefined) computer.claudePlugins.set(pluginId, enabled)
      },
      discard: async () => undefined,
    }
  } })
  const run = computer.ports.run
  computer.ports.run = async (binary, suppliedArgs, options) => {
    let commandIndex = 0
    const marketplaceOverrides = new Map<string, Record<string, unknown>>()
    while (suppliedArgs[commandIndex] === '-c') {
      const setting = suppliedArgs[commandIndex + 1]!
      const separator = setting.indexOf('=')
      const key = setting.slice(0, separator)
      if (key === 'marketplaces') {
        const table = /^\{\s*("(?:\\.|[^"\\])*")\s*=\s*\{(.*)\}\s*\}$/u.exec(setting.slice(separator + 1))
        if (!table) throw new Error('Unsupported native marketplace override')
        const fields: Record<string, unknown> = {}
        for (const field of table[2]!.matchAll(/\b(source_type|source)\s*=\s*("(?:\\.|[^"\\])*")/gu)) {
          fields[field[1]!] = JSON.parse(field[2]!) as unknown
        }
        marketplaceOverrides.set(JSON.parse(table[1]!) as string, fields)
      } else {
        // Native Codex splits override paths literally, including quotes in a path segment.
        const segments = key.split('.')
        if (segments.length === 3 && segments[0] === 'marketplaces') {
          const fields = marketplaceOverrides.get(segments[1]!) ?? {}
          fields[segments[2]!] = JSON.parse(setting.slice(separator + 1)) as unknown
          marketplaceOverrides.set(segments[1]!, fields)
        }
      }
      commandIndex += 2
    }
    const args = suppliedArgs.slice(commandIndex)
    const configured = marketplaceOverrides.get(args[2]?.split('@').at(-1) ?? '')
    const sourceRoot = configured?.source_type === 'local' && typeof configured.source === 'string'
      ? configured.source : undefined
    const harness = binary.endsWith('codex') ? 'codex' : 'claude'
    const environment = (options as typeof options & { environment?: NodeJS.ProcessEnv }).environment
    const stagingHome = environment?.CODEX_HOME ?? environment?.CLAUDE_CONFIG_DIR
    if (stagingHome && args[0] === 'plugin') {
      computer.calls.push({ binary, args })
      let state = staging.get(stagingHome)
      if (!state) {
        state = { snapshot: published, installed: new Map() }
        staging.set(stagingHome, state)
        await mkdir(join(stagingHome, 'marketplace'), { recursive: true })
      }
      if (['add', 'install'].includes(args[1]!)) {
        if (acquisitionFailure) return { code: 1, stdout: '', stderr: 'Artifact download failed' }
        state.installed.set(args[2]!, retainVersion ? '1.0.0' : state.snapshot)
      }
      let value: unknown = { outcome: 'ok' }
      if (args[1] === 'list') value = { installed: [...state.installed].map(([pluginId, version]) => harness === 'codex'
        ? { pluginId, version, installed: true } : { id: pluginId, version, enabled: true, scope: 'user' }), available: [] }
      if (args[1] === 'marketplace' && args[2] === 'list') value = harness === 'codex'
        ? { marketplaces: [{ name: 'official', root: join(stagingHome, 'marketplace'),
          marketplaceSource: { sourceType: 'git', source: 'owner/official' } }] }
        : [{ name: 'official', repo: 'owner/official' }]
      return { code: 0, stdout: JSON.stringify(value), stderr: '' }
    }
    if (args[0] === 'plugin' && ['add', 'install', 'update'].includes(args[1]!) && acquisitionFailure) {
      computer.calls.push({ binary, args })
      return { code: 1, stdout: '', stderr: 'Artifact download failed' }
    }
    const result = await run(binary, suppliedArgs, options)
    if (args[0] !== 'plugin' || result.code !== 0) return result
    if (args[1] === 'marketplace') {
      if (['add', 'upgrade', 'update'].includes(args[2]!)) snapshots[harness] = published
      if (harness === 'codex' && args[2] === 'upgrade') {
        for (const pluginId of computer.codexPlugins) versions.codex.set(pluginId, published)
      }
      if (args[2] === 'add') knownMarketplaces[harness].add('official')
      if (args[2] === 'list' && harness === 'claude') {
        return { ...result, stdout: JSON.stringify([...knownMarketplaces.claude].map(name => ({ name, repo: 'owner/official' }))) }
      }
    }
    if (args[1] === 'list') {
      const listed = JSON.parse(result.stdout) as { installed: Record<string, unknown>[] }
      listed.installed = listed.installed.map(plugin => ({
        ...plugin, version: versions[harness].get(String(plugin.pluginId ?? plugin.id)) ?? null,
      }))
      return { ...result, stdout: JSON.stringify(listed) }
    }
    if (['add', 'install', 'update'].includes(args[1]!) && !retainVersion) {
      const selected = sourceRoot === undefined ? undefined
        : [...staging].find(([home]) => join(home, 'marketplace') === sourceRoot)?.[1]
      if (sourceRoot !== undefined && !selected) return { code: 1, stdout: '', stderr: 'Staged marketplace is unavailable' }
      if (sourceRoot !== undefined) await access(sourceRoot)
      versions[harness].set(args[2]!, selected?.snapshot ?? snapshots[harness])
      if (activationFault === 'different-release') versions[harness].set(args[2]!, '9.0.0')
      if (activationFault === 'failure') return { code: 1, stdout: '', stderr: 'Activation failed after replacing the cache' }
    }
    if (['remove', 'uninstall'].includes(args[1]!) && !retainVersion) versions[harness].delete(args[2]!)
    return result
  }
  return {
    ...computer, versions,
    publish: (version: string) => { published = version },
    retainInstalledVersion: () => { retainVersion = true },
    failAcquisition: (fail = true) => { acquisitionFailure = fail },
    failActivation: (fault: typeof activationFault) => { activationFault = fault },
    sources: {
      codexPlugins: () => installedPlugins(computer.ports, '/fake/codex', AbortSignal.timeout(1000)),
      codexMarketplaces: async () => [{ name: 'official', source: 'owner/official' }],
      claudePlugins: async () => ({ ...await readClaudePlugins(computer.ports, AbortSignal.timeout(1000)),
        marketplaces: [{ name: 'official', source: 'owner/official' }] }),
    },
  }
}

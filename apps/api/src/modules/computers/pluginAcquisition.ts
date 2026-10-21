import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import type { MaintainedHarness, SyncedMarketplace } from '@foreman-code/contracts/computer-maintenance'
import { readClaudePlugins, claudeCliResult } from './claudePlugins.js'
import type { MaintenancePorts } from './maintenancePorts.js'

export interface AcquiredPluginRelease {
  installArguments: string[]
  marketplaceRoot: string | undefined
  discard(): Promise<void>
}

/** Acquire in a separate native home so a missing or mismatched release cannot replace a working installation. */
export async function verifyPluginRelease(ports: MaintenancePorts, input: {
  harness: MaintainedHarness; binary: string; pluginId: string; version: string; marketplace: SyncedMarketplace | undefined
}, signal: AbortSignal): Promise<AcquiredPluginRelease> {
  const { harness, binary, pluginId, version, marketplace } = input
  if (!marketplace) throw new Error(`Cannot acquire ${pluginId} ${version}: its Git marketplace source is unavailable.`)
  const cache = ports.environment.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  const root = join(cache, 'foreman-code', 'plugin-acquisition')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, `${harness}-`))
  const environment = harness === 'codex' ? { CODEX_HOME: directory } : { CLAUDE_CONFIG_DIR: directory }
  const staged: MaintenancePorts = { ...ports, run: (command, args, options) =>
    ports.run(command, args, { ...options, environment: { ...options.environment, ...environment } }) }
  const run = async (args: string[]) => {
    const result = await staged.run(binary, args, { signal, timeoutMs: 120_000 })
    if (result.code !== 0 || (harness === 'claude' && claudeCliResult(result.stdout)?.outcome !== 'ok')) {
      throw new Error(`Could not acquire ${pluginId} ${version}: ${result.stderr.slice(-1200) || result.stdout.slice(-1200)}`)
    }
  }
  try {
    await run(['plugin', 'marketplace', 'add', marketplace.source, '--json'])
    await run(['plugin', harness === 'codex' ? 'add' : 'install', pluginId,
      ...(harness === 'claude' ? ['--scope', 'user'] : []), '--json'])
    let acquired: string | null | undefined
    if (harness === 'claude') {
      acquired = (await readClaudePlugins(staged, signal)).plugins.find(plugin => plugin.pluginId === pluginId && plugin.installed)?.version
    } else {
      const result = await staged.run(binary, ['plugin', 'list', '--json'], { signal, timeoutMs: 120_000 })
      if (result.code !== 0) throw new Error(`Could not verify acquired plugin ${pluginId}.`)
      const catalog = z.object({ installed: z.array(z.object({ pluginId: z.string(), version: z.string().nullish() })) })
        .parse(JSON.parse(result.stdout))
      acquired = catalog.installed.find(plugin => plugin.pluginId === pluginId)?.version
    }
    if (acquired !== version) {
      throw new Error(`Requested ${pluginId} ${version}, but the acquired release is ${acquired ?? 'unknown'}. `
        + 'The existing installation was preserved.')
    }
    const installArguments: string[] = []
    let marketplaceRoot: string | undefined
    if (harness === 'codex') {
      const result = await staged.run(binary, ['plugin', 'marketplace', 'list', '--json'], { signal, timeoutMs: 120_000 })
      if (result.code !== 0) throw new Error(`Could not read the acquired marketplace for ${pluginId}.`)
      const catalog = z.object({ marketplaces: z.array(z.object({ name: z.string(), root: z.string() })) })
        .parse(JSON.parse(result.stdout))
      const acquiredRoot = catalog.marketplaces.find(item => item.name === marketplace.name)?.root
      const path = acquiredRoot === undefined ? undefined : relative(directory, acquiredRoot)
      const outside = path === undefined || path.split(/[/\\]/u)[0] === '..' || isAbsolute(path)
      if (!acquiredRoot || !isAbsolute(acquiredRoot) || outside) {
        throw new Error(`The acquired marketplace for ${pluginId} is outside its staging directory.`)
      }
      const source = `{ source_type="local", source=${JSON.stringify(acquiredRoot)} }`
      installArguments.push('-c', `marketplaces={${JSON.stringify(marketplace.name)}=${source}}`)
      marketplaceRoot = acquiredRoot
    }
    return { installArguments, marketplaceRoot, discard: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

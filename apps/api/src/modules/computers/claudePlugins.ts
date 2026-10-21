import { z } from 'zod'
import type { ClaudePluginMarketplace, ClaudePluginSummary } from '@foreman-code/contracts/management'
import type { MaintenancePorts } from './maintenancePorts.js'
import { DomainError } from '../errors.js'

const InstalledSchema = z.array(z.object({
  id: z.string(), version: z.string().nullish(), scope: z.string().nullish(), enabled: z.boolean().nullish(),
}).passthrough())
const AvailableSchema = z.object({
  installed: InstalledSchema,
  available: z.array(z.object({
    pluginId: z.string(), name: z.string(), description: z.string().nullish(), marketplaceName: z.string(),
    installCount: z.number().int().nonnegative().nullish(),
  }).passthrough()),
}).passthrough()
const MarketplacesSchema = z.array(z.object({
  name: z.string(), source: z.string().nullish(), repo: z.string().nullish(), url: z.string().nullish(),
}).passthrough())
const ResultSchema = z.object({
  outcome: z.string(), message: z.string().nullish(),
  shownCommand: z.object({
    sha256: z.string(), command: z.string().nullish(), text: z.string().nullish(),
  }).passthrough().nullish(),
}).passthrough()

export type PluginPorts = Pick<MaintenancePorts, 'find' | 'run'>
export type ClaudePluginCatalog = { plugins: ClaudePluginSummary[]; marketplaces: ClaudePluginMarketplace[] }

export async function readClaudePlugins(ports: PluginPorts, signal: AbortSignal): Promise<ClaudePluginCatalog> {
  const claude = await claudeBinary(ports)
  const [listed, marketplaces] = await Promise.all([
    ports.run(claude, ['plugin', 'list', '--json', '--available'], { signal, timeoutMs: 120_000 }),
    ports.run(claude, ['plugin', 'marketplace', 'list', '--json'], { signal, timeoutMs: 60_000 }),
  ])
  if (listed.code !== 0 || marketplaces.code !== 0) {
    throw new DomainError('CLAUDE_PLUGIN_CATALOG_UNAVAILABLE', 'Claude Code could not list its plugins.', 503)
  }
  try {
    const native = AvailableSchema.parse(JSON.parse(listed.stdout))
    const available = new Map(native.available.map(item => [item.pluginId, item]))
    const installed = native.installed.filter(item => (item.scope ?? 'user') === 'user')
    const installedIds = new Set(installed.map(item => item.id))
    const summary = (pluginId: string, entry?: (typeof installed)[number]): ClaudePluginSummary => {
      const known = available.get(pluginId)
      const [name = pluginId, marketplaceName = ''] = pluginId.split('@')
      return {
        pluginId, name: known?.name ?? name, marketplaceName: known?.marketplaceName ?? marketplaceName,
        description: known?.description ?? null, version: entry?.version ?? null,
        installed: Boolean(entry), enabled: entry ? entry.enabled !== false : false,
        installCount: known?.installCount ?? null,
      }
    }
    return {
      plugins: [
        ...installed.map(entry => summary(entry.id, entry)),
        ...native.available.filter(item => !installedIds.has(item.pluginId)).map(item => summary(item.pluginId)),
      ],
      marketplaces: MarketplacesSchema.parse(JSON.parse(marketplaces.stdout)).map(item => ({
        name: item.name,
        source: item.repo ?? (item.source === 'git' || item.source === 'url' ? item.url ?? null : null),
      })),
    }
  } catch {
    throw new DomainError('CLAUDE_PLUGIN_CATALOG_INVALID', 'Claude Code returned an unreadable plugin list.', 502)
  }
}

export async function claudeBinary(ports: Pick<MaintenancePorts, 'find'>): Promise<string> {
  const binary = await ports.find('claude')
  if (!binary) throw new DomainError('CLAUDE_CLI_UNAVAILABLE', 'Claude Code is not installed on this computer.', 503)
  return binary
}

/** Claude prints progress before its final JSON result. */
export function claudeCliResult(stdout: string) {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  try {
    return ResultSchema.parse(JSON.parse(line))
  } catch {
    return null
  }
}


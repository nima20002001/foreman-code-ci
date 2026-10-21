import { asRecord } from '../../shared/records.js'
import { pluginHash, pluginCanonical, pluginSourceIdentities, pluginCatalogRevision,
  type NativePluginCatalog, type PluginConfiguration } from './codexPluginIdentity.js'
import { CodexPluginSummarySchema, type CodexPluginSummary } from '@foreman-code/contracts/management'

export { pluginHash, pluginCanonical } from './codexPluginIdentity.js'
export { NativePluginCatalogSchema, type NativePluginCatalog, type PluginConfiguration } from './codexPluginIdentity.js'
export type PluginEvidence = { artifactIdentity: string; sourceIdentity: string }
export type CodexPluginCatalog = {
  installed: CodexPluginSummary[]; available: CodexPluginSummary[]; revision: string
  catalogStatus: 'complete' | 'partial'; inventoryStatus: 'complete' | 'unknown'
  evidence: Record<string, PluginEvidence>; configuration: PluginConfiguration
}
export function unrelatedPluginConfiguration(config: PluginConfiguration, pluginId: string): string {
  const plugins = { ...asRecord(config.userConfig.plugins) }
  delete plugins[pluginId]
  const user = { ...config.userConfig }
  delete user.plugins
  // An absent table and the empty table left by native removal are equivalent.
  return pluginHash([config.file, { ...user, plugins }])
}
export function pluginConfigurationHas(config: PluginConfiguration, pluginId: string): boolean {
  return Object.hasOwn(asRecord(config.userConfig.plugins), pluginId)
}

/** Full source data stays private, but URL/path/ref/SHA/remote ID/marketplace changes remain significant. */
export function normalizeCodexPluginCatalog(native: NativePluginCatalog, configuration: PluginConfiguration,
  catalogStatus: 'complete' | 'partial', cachedIds: readonly string[] = []): CodexPluginCatalog {
  const identities: Record<string, PluginEvidence> = Object.create(null)
  const raw = [...native.installed, ...native.available].map((entry) => ({ ...entry, version: entry.version ?? null }))
  if (native.installed.some((entry) => !entry.installed) || native.available.some((entry) => entry.installed)) throw new Error('Inconsistent native plugin inventory.')
  const groups = new Map<string, typeof raw>()
  for (const entry of raw) {
    if (entry.pluginId !== `${entry.name}@${entry.marketplaceName}`) throw new Error('Invalid native plugin selector.')
    const group = groups.get(entry.pluginId) ?? []
    group.push(entry); groups.set(entry.pluginId, group)
  }
  const installed: CodexPluginSummary[] = []
  const available: CodexPluginSummary[] = []
  for (const [pluginId, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...entries].sort((a, b) => pluginCanonical(a).localeCompare(pluginCanonical(b)))
    const entry = ordered.find((item) => item.installed) ?? ordered[0]!
    identities[pluginId] = pluginSourceIdentities(entry)
    // Identical duplicate rows are harmless; distinct matches cannot be resolved by `plugin add SELECTOR`.
    const ambiguous = new Set(ordered.map(pluginCanonical)).size > 1
    const item = CodexPluginSummarySchema.parse({ pluginId, name: entry.name, marketplaceName: entry.marketplaceName,
      version: entry.version, installed: entry.installed, enabled: entry.enabled,
      sourceType: ['local', 'git', 'git-subdir', 'remote'].includes(entry.source.source) ? entry.source.source : 'other',
      installPolicy: entry.installPolicy, authPolicy: entry.authPolicy, verification: 'catalog',
      ...(configuration.verified === false ? { unavailableReason: 'Codex has not exposed a verifiable user configuration. Create the native user configuration and refresh before changing plugins.' } : ambiguous ? { unavailableReason: 'More than one native artifact matches this selector. Codex cannot safely select one here.' }
        : catalogStatus === 'partial' && !entry.installed ? { unavailableReason: 'Catalog discovery is incomplete. Refresh successfully before installing.' } : {}),
    })
    ;(item.installed ? installed : available).push(item)
  }
  const configured = Object.keys(asRecord(configuration.userConfig.plugins))
  const hints = [...new Set([...configured, ...cachedIds])].sort()
  for (const pluginId of hints) {
    if (installed.some((item) => item.pluginId === pluginId)) continue
    const [name, marketplaceName] = pluginId.split('@')
    const candidate = CodexPluginSummarySchema.safeParse({ pluginId, name, marketplaceName, version: null,
      installed: true, enabled: false, sourceType: 'other', installPolicy: 'NOT_AVAILABLE', authPolicy: 'ON_USE', verification: 'unverified',
      unavailableReason: 'A local or configuration record exists, but Codex discovery did not verify its installation. Inspect it in Codex and refresh; no write is offered from this record.' })
    if (!candidate.success) continue
    const index = available.findIndex((item) => item.pluginId === pluginId)
    if (index >= 0) available.splice(index, 1)
    installed.push(candidate.data)
    identities[pluginId] = { sourceIdentity: pluginHash(['unverified', pluginId]), artifactIdentity: pluginHash(['unverified', pluginId]) }
  }
  installed.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
  // Sort before hashing. Keep ALL native identities, not the presentation deduplication.
  return { installed, available, evidence: identities, configuration, catalogStatus,
    // The qualified CLI has no authoritative full remote installed-inventory command.
    inventoryStatus: 'unknown', revision: pluginCatalogRevision(native, hints, configuration, catalogStatus) }
}

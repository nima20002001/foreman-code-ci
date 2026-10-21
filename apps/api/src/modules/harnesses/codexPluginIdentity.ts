import { createHash } from 'node:crypto'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { z } from 'zod'

const NativeEntry = z.object({ pluginId: z.string(), name: z.string(), marketplaceName: z.string(),
  version: z.string().nullable().optional(), installed: z.boolean(), enabled: z.boolean(),
  source: z.object({ source: z.string() }).passthrough(), marketplaceSource: z.unknown().optional(),
  installPolicy: z.string(), authPolicy: z.string() }).passthrough()
export const NativePluginCatalogSchema = z.object({ installed: z.array(NativeEntry).max(10_000), available: z.array(NativeEntry).max(10_000) }).passthrough()
export type NativePluginCatalog = z.infer<typeof NativePluginCatalogSchema>
export type PluginConfiguration = { file: string; userConfig: Record<string, unknown>; verified?: boolean }

/** Persisted plugin identities depend on the frozen numeric-keys-first legacy form. */
export const pluginCanonical: (value: unknown) => string = canonicalJsonNumericKeysFirstLegacy
export const pluginHash = (value: unknown): string => `sha256:${createHash('sha256').update(pluginCanonical(value)).digest('hex')}`
export function pluginCatalogRevision(native: NativePluginCatalog, hints: readonly string[], configuration: PluginConfiguration, status: 'complete' | 'partial'): string {
  const normalized = [...native.installed, ...native.available].map((entry) => ({ ...entry, version: entry.version ?? null }))
    .sort((a, b) => pluginCanonical(a).localeCompare(pluginCanonical(b)))
  return pluginHash([normalized, [...new Set(hints)].sort(), configuration, status])
}
export function pluginSourceIdentities(entry: NativePluginCatalog['installed'][number]) {
  const source = { pluginId: entry.pluginId, name: entry.name, marketplaceName: entry.marketplaceName,
    source: entry.source, marketplaceSource: entry.marketplaceSource ?? null,
    installPolicy: entry.installPolicy, authPolicy: entry.authPolicy }
  return { sourceIdentity: pluginHash(source), artifactIdentity: pluginHash({ ...source, version: entry.version ?? null }) }
}

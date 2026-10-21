import { expect, it } from 'vitest'
import { normalizeCodexPluginCatalog, type NativePluginCatalog, unrelatedPluginConfiguration } from '../src/modules/harnesses/codexPluginCatalog.js'
import { validatePluginMutation } from '../src/modules/harnesses/codexPlugins.js'

const entry = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1', installed: false, enabled: false,
  source: { source: 'git', url: 'https://example.test/private?token=secret', ref: 'main', sha: 'abc', path: 'plugins/notes', id: 'remote-1' },
  marketplaceSource: { sourceType: 'git', source: 'https://example.test/market' }, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }
const config = { file: '/profile/config.toml', userConfig: { mcp_servers: { retained: { enabled_tools: ['read'] } } } }
const catalog = (value: NativePluginCatalog, status: 'complete' | 'partial' = 'complete', cached: string[] = []) => normalizeCodexPluginCatalog(value, config, status, cached)
it.each(['url', 'path', 'ref', 'sha', 'id'])('invalidates review when native source %s changes', (key) => {
  const before = catalog({ installed: [], available: [entry] })
  const after = catalog({ installed: [], available: [{ ...entry, source: { ...entry.source, [key]: 'changed' } }] })
  expect(after.revision).not.toBe(before.revision)
  expect(after.evidence[entry.pluginId]?.artifactIdentity).not.toBe(before.evidence[entry.pluginId]?.artifactIdentity)
  expect(JSON.stringify(before.available)).not.toContain('secret')
})
it('includes marketplace source, version and policy in the reviewed identity', () => {
  const before = catalog({ installed: [], available: [entry] })
  for (const next of [{ ...entry, marketplaceSource: { sourceType: 'local', source: '/other' } },
    { ...entry, version: '2' }, { ...entry, installPolicy: 'NOT_AVAILABLE' }, { ...entry, authPolicy: 'ON_INSTALL' }]) {
    expect(catalog({ installed: [], available: [next] }).revision).not.toBe(before.revision)
  }
})
it('canonicalizes all permutations without dropping source identity', () => {
  const two = { ...entry, name: 'second', pluginId: 'second@trusted' }
  const three = { ...entry, name: 'third', pluginId: 'third@trusted' }
  const permutations = [[entry, two, three], [entry, three, two], [two, entry, three], [two, three, entry], [three, entry, two], [three, two, entry]]
  expect(new Set(permutations.map((available) => catalog({ installed: [], available }).revision)).size).toBe(1)
})
it('disables duplicate selectors instead of inventing native version selection', () => {
  const next = catalog({ installed: [], available: [entry, { ...entry, version: '2', source: { ...entry.source, id: 'remote-2' } }] })
  expect(next.available).toHaveLength(1)
  expect(next.available[0]?.unavailableReason).toMatch(/More than one/)
})
it('retains installed-but-unlisted evidence as explicitly unverified, not removed', () => {
  const next = catalog({ installed: [], available: [] }, 'partial', ['notes@trusted'])
  expect(next.installed).toMatchObject([{ pluginId: 'notes@trusted', verification: 'unverified' }])
  expect(next.catalogStatus).toBe('partial')
  expect(next.inventoryStatus).toBe('unknown')
})
it('fingerprints all unrelated configuration while allowing only the target plugin entry to change', () => {
  expect(unrelatedPluginConfiguration(config, entry.pluginId)).toBe(unrelatedPluginConfiguration({ ...config,
    userConfig: { ...config.userConfig, plugins: { [entry.pluginId]: { enabled: true } } } }, entry.pluginId))
  expect(unrelatedPluginConfiguration(config, entry.pluginId)).not.toBe(unrelatedPluginConfiguration({ ...config,
    userConfig: { mcp_servers: {} } }, entry.pluginId))
})
it('requires the qualified native JSON acknowledgement for the exact mutation', () => {
  expect(validatePluginMutation({ pluginId: entry.pluginId, name: entry.name, marketplaceName: entry.marketplaceName }, entry.pluginId, 'remove'))
    .toEqual({ acknowledged: true, version: null })
  expect(() => validatePluginMutation({}, entry.pluginId, 'remove')).toThrow()
  expect(() => validatePluginMutation({ pluginId: 'other@trusted', name: 'other', marketplaceName: 'trusted' }, entry.pluginId, 'remove')).toThrow()
  expect(() => validatePluginMutation({ pluginId: entry.pluginId, name: entry.name, marketplaceName: entry.marketplaceName }, entry.pluginId, 'install')).toThrow()
})

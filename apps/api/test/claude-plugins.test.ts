import { describe, expect, it } from 'vitest'
import { ClaudePluginMarketplaceAddInputSchema } from '@foreman-code/contracts/management'
import { ComputerMaintenance } from '../src/modules/computers/maintenance.js'
import { readClaudePlugins } from '../src/modules/computers/claudePlugins.js'
import { claudePluginPorts } from './helpers/claudePluginPorts.js'
import { randomUUID } from 'node:crypto'

const syncRequest = {
  kind: 'sync-plugins' as const, plugins: [], marketplaces: [],
  claudePlugins: [{ pluginId: 'notes@official', enabled: false }, { pluginId: 'review@official', enabled: true }],
  claudeMarketplaces: [{ name: 'official', source: 'owner/official' }],
}
async function settled(maintenance: ComputerMaintenance) {
  for (let i = 0; i < 50; i++) {
    const result = await maintenance.status(AbortSignal.timeout(1000))
    if (result.tasks[0]?.state !== 'running') return result.tasks[0]
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Plugin sync did not finish')
}

describe('Claude plugin catalog and fleet sync', () => {
  it('refreshes a known marketplace by alias while preserving its repository source', async () => {
    const fake = claudePluginPorts()
    fake.marketplaces.set('official', 'owner/official')
    const commands: string[][] = []
    const maintenance = new ComputerMaintenance({ ...fake.ports, run: async (binary, args, options) => {
      commands.push([...args])
      return fake.ports.run(binary, args, options)
    } })
    await maintenance.start({ ...syncRequest, claudePlugins: [{ pluginId: 'review@official', enabled: true }] })
    expect(await settled(maintenance)).toMatchObject({ state: 'succeeded' })
    expect(commands).toContainEqual(['plugin', 'marketplace', 'update', 'official', '--json'])
    expect(commands).not.toContainEqual(['plugin', 'marketplace', 'add', 'owner/official', '--json'])
    expect((await readClaudePlugins(fake.ports, AbortSignal.timeout(1000))).marketplaces)
      .toContainEqual({ name: 'official', source: 'owner/official' })
    expect(fake.installed.has('review@official')).toBe(true)
  })

  it('reads installed state, available plugins and shareable marketplaces', async () => {
    const fake = claudePluginPorts()
    fake.installed.set('notes@official', { version: '1.0.0', enabled: false })
    fake.marketplaces.set('official', 'owner/official')
    const catalog = await readClaudePlugins(fake.ports, AbortSignal.timeout(1000))
    expect(catalog.plugins.find(item => item.pluginId === 'notes@official')).toMatchObject({ installed: true, enabled: false })
    expect(catalog.plugins.find(item => item.pluginId === 'review@official')).toMatchObject({ installed: false })
    expect(catalog.marketplaces).toEqual([{ name: 'official', source: 'owner/official' }])
  })

  it('reports absent Claude and invalid native output', async () => {
    const { ports } = claudePluginPorts()
    await expect(readClaudePlugins({ ...ports, find: async () => null }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'CLAUDE_CLI_UNAVAILABLE' })
    await expect(readClaudePlugins({ ...ports, run: async () => ({ code: 0, stdout: '{}', stderr: '' }) }, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'CLAUDE_PLUGIN_CATALOG_INVALID' })
  })

  it('syncs marketplaces, missing plugins and managed enabled state, then reads back the result', async () => {
    const fake = claudePluginPorts()
    const maintenance = new ComputerMaintenance(fake.ports)
    await maintenance.start({ ...syncRequest, claudePlugins: [{ pluginId: 'review@official', enabled: true }] })
    expect(await settled(maintenance)).toMatchObject({ state: 'succeeded' })
    fake.installed.set('review@official', { version: '1.0.0', enabled: false })
    await maintenance.start(syncRequest)
    expect(await settled(maintenance)).toMatchObject({ state: 'succeeded' })
    const catalog = await readClaudePlugins(fake.ports, AbortSignal.timeout(1000))
    expect(catalog.plugins.filter(item => item.installed).map(item => ({ pluginId: item.pluginId, enabled: item.enabled })))
      .toEqual(expect.arrayContaining(syncRequest.claudePlugins))
    expect(catalog.marketplaces).toContainEqual({ name: 'official', source: 'owner/official' })
    const count = fake.changes.length
    await maintenance.start(syncRequest)
    expect(await settled(maintenance)).toMatchObject({ state: 'succeeded' })
    expect(fake.changes.slice(count)).not.toContain('install:notes@official')
  })

  it('continues past a command requiring approval without running it', async () => {
    const fake = claudePluginPorts()
    const maintenance = new ComputerMaintenance(fake.ports)
    await maintenance.start({ ...syncRequest, claudePlugins: [
      { pluginId: 'command@official', enabled: true }, { pluginId: 'review@official', enabled: true },
    ] })
    expect(await settled(maintenance)).toMatchObject({ state: 'failed', summary: expect.stringContaining('command@official') })
    expect(fake.installed.has('review@official')).toBe(true)
    expect(fake.installed.has('command@official')).toBe(false)
  })

  it('rejects machine-specific marketplace paths', () => {
    for (const source of ['/tmp/plugins', '../plugins', '~/plugins', '--help']) {
      expect(ClaudePluginMarketplaceAddInputSchema.safeParse({ source, commandId: randomUUID(), expectedRevision: 'a'.repeat(64) }).success).toBe(false)
    }
  })
})

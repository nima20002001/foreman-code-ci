import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { systemMaintenancePorts } from './maintenance.js'

it.each(['codex', 'claude'] as const)('restores the %s cache and scoped native state while keeping unrelated changes', async harness => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const home = await mkdtemp(join(cache, 'plugin-restore-'))
  const nativeHome = join(home, `.${harness}`)
  const pluginRoot = join(nativeHome, 'plugins', 'cache', 'official', 'notes')
  const installedFile = join(nativeHome, 'plugins', 'installed_plugins.json')
  const settingsFile = join(nativeHome, 'settings.json')
  const ports = systemMaintenancePorts({ HOME: home, XDG_CACHE_HOME: join(home, 'cache') })
  try {
    await mkdir(join(pluginRoot, '1.0.0'), { recursive: true })
    await writeFile(join(pluginRoot, '1.0.0', 'payload.txt'), 'working plugin')
    if (harness === 'claude') {
      await ports.writePrivateText(installedFile, JSON.stringify({ version: 2, plugins: {
        'notes@official': [{ scope: 'user', version: '1.0.0' }, { scope: 'project', version: '0.1.0' }],
      } }))
      await ports.writePrivateText(settingsFile, JSON.stringify({ enabledPlugins: { 'notes@official': false } }))
    }
    const backup = await ports.backupPlugin!(harness, 'notes@official')
    await rm(pluginRoot, { recursive: true })
    await mkdir(join(pluginRoot, '2.0.0'), { recursive: true })
    await writeFile(join(pluginRoot, '2.0.0', 'payload.txt'), 'broken activation')
    if (harness === 'claude') {
      await ports.writePrivateText(installedFile, JSON.stringify({ version: 2, plugins: {
        'notes@official': [{ scope: 'user', version: '2.0.0' }, { scope: 'project', version: '0.2.0' }],
        'other@official': [{ scope: 'user', version: '5.0.0' }],
      } }))
      await ports.writePrivateText(settingsFile, JSON.stringify({ enabledPlugins: {
        'notes@official': true, 'other@official': false,
      }, unrelated: 'keep' }))
    }
    await backup.restore()
    expect(await ports.readText(join(pluginRoot, '1.0.0', 'payload.txt'))).toBe('working plugin')
    expect(await ports.exists(join(pluginRoot, '2.0.0'))).toBe(false)
    if (harness === 'claude') {
      expect(JSON.parse(await ports.readText(installedFile) ?? '{}')).toEqual({ version: 2, plugins: {
        'notes@official': [{ scope: 'project', version: '0.2.0' }, { scope: 'user', version: '1.0.0' }],
        'other@official': [{ scope: 'user', version: '5.0.0' }],
      } })
      expect(JSON.parse(await ports.readText(settingsFile) ?? '{}')).toEqual({ enabledPlugins: {
        'notes@official': false, 'other@official': false,
      }, unrelated: 'keep' })
    }
    await backup.discard()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

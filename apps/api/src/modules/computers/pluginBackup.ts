import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { MaintainedHarness } from '@foreman-code/contracts/computer-maintenance'
import { safePluginPart } from '../harnesses/boundedPluginFiles.js'
import type { MaintenancePluginBackup, MaintenancePorts } from './maintenancePorts.js'

const InstalledRecordSchema = z.object({
  plugins: z.record(z.string(), z.array(z.object({ scope: z.string() }).passthrough())),
}).passthrough()
const SettingsSchema = z.object({ enabledPlugins: z.record(z.string(), z.unknown()).optional() }).passthrough()

/** Only this plugin's cache and user-scope record are restored; other installations keep their changes. */
export async function backupPluginInstallation(ports: Pick<MaintenancePorts, 'environment' | 'readText' | 'writePrivateText'>,
  harness: MaintainedHarness, pluginId: string): Promise<MaintenancePluginBackup> {
  const [name = '', marketplace = ''] = pluginId.split('@')
  if (!safePluginPart(name) || !safePluginPart(marketplace)) throw new Error('Invalid plugin cache selector.')
  const home = ports.environment.HOME ?? homedir()
  const nativeHome = harness === 'codex' ? ports.environment.CODEX_HOME ?? join(home, '.codex')
    : ports.environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
  const pluginRoot = join(nativeHome, 'plugins', 'cache', marketplace, name)
  const root = dirname(pluginRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, `.${name}-backup-`))
  const backup = join(directory, 'cache')
  const installedFile = join(nativeHome, 'plugins', 'installed_plugins.json')
  const settingsFile = join(nativeHome, 'settings.json')
  let previous: z.infer<typeof InstalledRecordSchema>['plugins'][string] | undefined
  let previousEnabled: unknown
  let hadEnabled = false
  try {
    if (harness === 'claude') {
      const record = InstalledRecordSchema.parse(JSON.parse(await ports.readText(installedFile) ?? '{}'))
      previous = record.plugins[pluginId]?.filter(installation => installation.scope === 'user')
      if (!previous?.length) throw new Error(`No user installation record for ${pluginId}.`)
      const settings = SettingsSchema.parse(JSON.parse(await ports.readText(settingsFile) ?? '{}'))
      hadEnabled = Object.hasOwn(settings.enabledPlugins ?? {}, pluginId)
      previousEnabled = settings.enabledPlugins?.[pluginId]
    }
    await cp(pluginRoot, backup, { recursive: true, preserveTimestamps: true })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return {
    async restore() {
      const rejected = join(directory, 'rejected')
      // Both trees share the native filesystem, so rollback never copies plugin bytes.
      try { await rename(pluginRoot, rejected) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try { await rename(backup, pluginRoot) }
      catch (error) {
        throw new Error(`Plugin restoration failed; the previous cache is retained at ${backup}.`, { cause: error })
      }
      if (harness === 'claude') {
        const record = InstalledRecordSchema.parse(JSON.parse(await ports.readText(installedFile) ?? '{}'))
        record.plugins[pluginId] = [
          ...record.plugins[pluginId]?.filter(installation => installation.scope !== 'user') ?? [], ...previous ?? [],
        ]
        await ports.writePrivateText(installedFile, `${JSON.stringify(record)}\n`)
        const settings = SettingsSchema.parse(JSON.parse(await ports.readText(settingsFile) ?? '{}'))
        settings.enabledPlugins ??= {}
        if (hadEnabled) settings.enabledPlugins[pluginId] = previousEnabled
        else delete settings.enabledPlugins[pluginId]
        await ports.writePrivateText(settingsFile, `${JSON.stringify(settings)}\n`)
      }
    },
    discard: () => rm(directory, { recursive: true, force: true }),
  }
}

export async function replacePluginWithBackup(ports: MaintenancePorts, harness: MaintainedHarness, pluginId: string,
  replace: () => Promise<void>): Promise<void> {
  if (!ports.backupPlugin) throw new Error(`Cannot safely update ${pluginId}: plugin backup storage is unavailable.`)
  const backup = await ports.backupPlugin(harness, pluginId)
  try {
    await replace()
  } catch (error) {
    try { await backup.restore() }
    catch (restoreError) {
      throw new AggregateError([error, restoreError], `Could not restore ${pluginId}; its plugin backup was retained.`, { cause: restoreError })
    }
    await backup.discard()
    throw error
  }
  await backup.discard()
}

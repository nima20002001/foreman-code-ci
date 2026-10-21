import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { safePluginPart } from '../harnesses/boundedPluginFiles.js'
import type { MaintenancePorts } from './maintenancePorts.js'

/** Publish only the acquired catalog; Codex's marketplace upgrader also reinstalls unrelated plugins. */
export async function refreshCodexMarketplaceSnapshot(ports: Pick<MaintenancePorts, 'environment' | 'run'>,
  binary: string, name: string, acquiredRoot: string, signal: AbortSignal): Promise<void> {
  if (!safePluginPart(name)) throw new Error('Invalid marketplace name.')
  const result = await ports.run(binary, ['plugin', 'marketplace', 'list', '--json'], { signal, timeoutMs: 60_000 })
  if (result.code !== 0) throw new Error('Could not inspect the destination marketplace snapshot.')
  const catalog = z.object({ marketplaces: z.array(z.object({ name: z.string(), root: z.string(),
    marketplaceSource: z.object({ sourceType: z.string() }).optional(),
  })) }).parse(JSON.parse(result.stdout))
  const marketplace = catalog.marketplaces.find(item => item.name === name)
  const home = ports.environment.CODEX_HOME ?? join(ports.environment.HOME ?? homedir(), '.codex')
  const destination = join(home, '.tmp', 'marketplaces', name)
  if (marketplace?.marketplaceSource?.sourceType !== 'git' || marketplace.root !== destination) {
    throw new Error(`Cannot refresh ${name}: its destination is not a native Git marketplace snapshot.`)
  }
  const directory = await mkdtemp(join(dirname(destination), `.${name}-refresh-`))
  const snapshot = join(directory, 'snapshot')
  const backup = join(directory, 'previous')
  let retainBackup = false
  try {
    await cp(acquiredRoot, snapshot, { recursive: true, verbatimSymlinks: true })
    signal.throwIfAborted()
    await rename(destination, backup)
    try { await rename(snapshot, destination) }
    catch (error) {
      try { await rename(backup, destination) }
      catch (restoreError) {
        retainBackup = true
        throw new AggregateError([error, restoreError], `Could not restore ${name}; the previous snapshot is retained at ${backup}.`,
          { cause: restoreError })
      }
      throw error
    }
  } finally {
    if (!retainBackup) await rm(directory, { recursive: true, force: true })
  }
}

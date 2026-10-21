import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'
import type { buildProductionApp } from '../../src/production.js'
import type { ActivityProductionReplay } from './activityProductionReplay.js'

/** Private fixture bytes live outside shared temporary/native workspaces. */
export async function createActivityReplayFileStorage(): Promise<string> {
  return privateFixtureDirectory('activity-replay-files-')
}

type Production = Pick<ReturnType<typeof buildProductionApp>, 'initialize' | 'shutdown'> & {
  registerFileStorage(): void
  app: { listen(options: { host: string; port: number }): Promise<string> }
}

/** Register the exact instance before any startup boundary can fail, including restarts. */
export async function startActivityReplayProduction(production: Production, replay: Pick<ActivityProductionReplay, 'drain'>,
  closes: Array<() => Promise<void>>, port: number): Promise<string> {
  closes.push(async () => {
    try { await replay.drain() } finally { await production.shutdown() }
  })
  production.registerFileStorage()
  await production.initialize()
  return production.app.listen({ host: '127.0.0.1', port })
}

/** Layout supplied to the real production workspace admission service. */
export async function createActivityReplayWorkspace(directory: string) {
  const workspaceStorageRoot = join(directory, 'projects'), workingDirectory = join(workspaceStorageRoot, 'replay')
  const harnessWorkspaceRoot = join(directory, 'runtime')
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 })
  await mkdir(harnessWorkspaceRoot, { recursive: true, mode: 0o700 })
  return { workingDirectory, workspaceStorageRoot, harnessWorkspaceRoot }
}

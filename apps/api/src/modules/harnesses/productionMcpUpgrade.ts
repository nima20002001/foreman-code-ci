import { lstat, readdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  installManagedLauncher,
  readLauncherInstallation,
  writeLauncherInstallation,
} from './appMcpLauncher.js'

const launcherSource = new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url)

async function existingPath(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function managedInstallation(directory: string) {
  const launcher = join(directory, 'launcher.mjs')
  const installation = readLauncherInstallation(launcher)
  if (!(await existingPath(directory))?.isDirectory() || !installation?.executables.length
    || !(await existingPath(launcher))?.isFile()) {
    throw new Error('The production MCP launcher has no valid managed installation record.')
  }
  return installation
}

async function registerPreviousLauncher(launcher: string, directory: string, alias: string): Promise<void> {
  const installation = await managedInstallation(directory)
  await installManagedLauncher(launcherSource, launcher)
  await writeLauncherInstallation(launcher, {
    version: 1,
    executables: installation.executables,
    launcherAliases: [alias],
  })
}

async function refreshSharedLauncher(directory: string): Promise<void> {
  const launcher = join(directory, 'launcher.mjs')
  if (!(await existingPath(launcher))) return
  await managedInstallation(directory)
  await installManagedLauncher(launcherSource, launcher)
}

/** Called under the production installation lock while the old API is stopped. */
export async function upgradeProductionMcpLauncher(desktopHome: string): Promise<void> {
  const previous = join(desktopHome, '.local/state/graphql-production/mcp')
  const destination = join(desktopHome, '.local/share/graphql/mcp')
  const launcher = join(destination, 'launcher.mjs')
  const alias = join(previous, 'launcher.mjs')
  const retained = `${previous}.previous`
  const previousState = await existingPath(previous)
  const retainedState = await existingPath(retained)
  if (!previousState && !retainedState) {
    await refreshSharedLauncher(destination)
    return
  }
  if (previousState?.isDirectory() && !retainedState) {
    const entries = await readdir(previous)
    const routes = join(previous, 'routes')
    // Older installers create this directory even when no native launcher is installed.
    if (!entries.length || entries.length === 1 && entries[0] === 'routes'
      && (await existingPath(routes))?.isDirectory() && !(await readdir(routes)).length) {
      await refreshSharedLauncher(destination)
      return
    }
  }
  if (previousState?.isSymbolicLink()) {
    const installation = readLauncherInstallation(launcher)
    if (await realpath(previous) !== await realpath(destination)) {
      throw new Error('The previous production MCP directory is linked to an unmanaged installation.')
    }
    if (installation?.launcherAliases?.includes(alias)) {
      await installManagedLauncher(launcherSource, launcher)
    } else if (retainedState?.isDirectory()) {
      await registerPreviousLauncher(launcher, retained, alias)
    } else {
      throw new Error('The previous production MCP directory is linked to an unmanaged installation.')
    }
    return
  }
  if (previousState && retainedState) {
    throw new Error('Both the previous production MCP directory and its upgrade backup exist.')
  }
  const sourceDirectory = previousState ? previous : retained
  await registerPreviousLauncher(launcher, sourceDirectory, alias)
  const pending = `${previous}.${randomUUID()}.tmp`
  try {
    await symlink(destination, pending)
    if (previousState) await rename(previous, retained)
    await rename(pending, previous)
  } finally {
    await rm(pending, { force: true })
  }
}

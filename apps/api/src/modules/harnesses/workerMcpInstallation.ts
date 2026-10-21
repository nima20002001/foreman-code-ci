import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installManagedLauncher, writeLauncherInstallation } from './appMcpLauncher.js'

async function installedFile(path: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o022)) return undefined
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Register installer-owned interpreters before the Worker inspects native MCP configuration. */
export async function registerWorkerMcpInstallation(input: {
  home: string; stateDirectory: string; releaseDirectory: string
}): Promise<void> {
  const { home, stateDirectory, releaseDirectory } = input
  const root = join(home, '.local/lib/graphql-worker')
  const launcher = join(home, '.local/share/graphql/mcp/launcher.mjs')
  const installed = await installedFile(launcher)
  if (!installed) return
  const sourcePath = join(releaseDirectory, 'artifacts/graphql-mcp.mjs')
  const source = await readFile(sourcePath)
  // A custom launcher must not acquire managed ownership from its location alone.
  if (!installed.equals(source)) {
    const previous = await installedFile(join(root, 'previous/artifacts/graphql-mcp.mjs'))
    if (!previous || !installed.equals(previous)) return
    await installManagedLauncher(pathToFileURL(sourcePath), launcher)
  }
  const executables = [{ path: process.execPath, realpath: await realpath(process.execPath) }]
  const services = [join(root, 'graphql-worker.service'), join(root, 'graphql-worker.service.previous'),
    join(home, '.config/systemd/user/graphql-worker.service')]
  for (const path of services) {
    const service = await installedFile(path)
    if (!service) continue
    const starts = [...service.toString('utf8').matchAll(/^ExecStart=(\S+) (\S+) run --state (\S+)$/gm)]
    if (starts.length !== 1 || service.toString('utf8').match(/^ExecStart=/gm)?.length !== 1) continue
    const [, node, entrypoint, state] = starts[0]!
    if (!node || !isAbsolute(node) || state !== stateDirectory
      || entrypoint !== join(root, 'current/src/cli.mjs') && entrypoint !== join(releaseDirectory, 'src/cli.mjs')) continue
    try {
      executables.push({ path: node, realpath: await realpath(node) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await writeLauncherInstallation(launcher, { version: 1, executables })
}

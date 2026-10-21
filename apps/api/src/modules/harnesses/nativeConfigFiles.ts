import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DomainError } from '../errors.js'

function requireOwnedConfig(metadata: { uid: number }) {
  if (metadata.uid !== process.getuid?.()) {
    throw new DomainError('MCP_CONFIG_FILE_UNSAFE', 'Native configuration must belong to the current user.', 409)
  }
}

export async function resolveNativeUserFile(file: string): Promise<string> {
  const directory = await realpath(dirname(file))
  requireOwnedConfig(await lstat(dirname(file)))
  requireOwnedConfig(await lstat(directory))
  let target = join(directory, basename(file))
  let metadata
  try { metadata = await lstat(target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (metadata) {
    requireOwnedConfig(metadata)
    target = await realpath(target)
    requireOwnedConfig(await lstat(target))
    requireOwnedConfig(await lstat(dirname(target)))
  }
  const sensitive = target.split(sep).some(part =>
    ['.ssh', '.aws', '.gnupg', '.kube', 'auth.json', 'credentials', 'credentials.json'].includes(part)
    || /^\.env(?:\.|$)|^id_(?:rsa|ed25519|ecdsa)(?:\.|$)|\.(?:pem|key)$/.test(part))
  if (sensitive) {
    throw new DomainError('MCP_CONFIG_FILE_UNSAFE', 'Native configuration cannot target credential storage.', 409)
  }
  return target
}

export async function readNativeUserFile(file: string, options: {
  whenMissing?: string
  requireDirectory?: boolean
} = {}): Promise<string> {
  let target: string
  try { target = await resolveNativeUserFile(file) }
  catch (error) {
    if (options.whenMissing !== undefined && !options.requireDirectory
      && (error as NodeJS.ErrnoException).code === 'ENOENT') return options.whenMissing
    throw error
  }
  try {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      requireOwnedConfig(stat)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1_048_576) {
        throw new DomainError('MCP_CONFIG_FILE_UNSAFE', 'The native configuration must be a single regular file under 1 MiB.', 409)
      }
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (options.whenMissing !== undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return options.whenMissing
    }
    throw error
  }
}
export async function backupNativeUserFile(file: string, source: string): Promise<void> {
  const handle = await open(`${file}.graphql-mcp-${randomUUID()}.bak`, 'wx', 0o600)
  try {
    await handle.writeFile(source)
    await handle.sync()
  } finally {
    await handle.close()
  }
  // The backup name must survive a crash before the native writer replaces the config.
  await syncNativeConfigDirectory(file)
}
export async function syncNativeConfigDirectory(file: string): Promise<void> {
  const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY)
  try { await directory.sync() } finally { await directory.close() }
}

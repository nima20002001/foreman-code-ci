import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { DomainError } from '../errors.js'
import { verifyApprovedRootAllowlist } from './rootAttestation.js'

/** Server-selected installation file only. HTTP/MCP never supplies this path. */
export async function readInstalledRootConfiguration(path: string) {
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)
    || await realpath(dirname(path)) !== dirname(path))
    throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'The approved root configuration directory must be private and owned.', 409)
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DomainError('ROOT_CONFIGURATION_MISSING', 'Install the original human-approved approved-roots.json before adopting roots.', 409, undefined, { cause: error })
    throw error
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.size > 128 * 1024)
      throw new DomainError('ROOT_CONFIGURATION_UNAVAILABLE', 'The approved root configuration must be a bounded private owner file.', 409)
    const bytes = Buffer.alloc(128 * 1024 + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const after = await file.stat(), named = await lstat(path)
    if (bytesRead !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.isSymbolicLink() || named.ino !== after.ino || named.dev !== after.dev)
      throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The original approved configuration changed during adoption.', 409)
    const configuration = ApprovedRootAllowlistSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')))
    await verifyApprovedRootAllowlist(configuration)
    return configuration
  } finally { await file.close() }
}

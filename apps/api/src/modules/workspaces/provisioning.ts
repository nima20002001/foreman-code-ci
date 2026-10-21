import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, mkdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DomainError } from '../errors.js'

/** Only a server-owner-configured root can be provisioned. No caller-selected path. */
export async function provisionWorkspaceDirectory(configuredRoot: string, workspaceId: string): Promise<string> {
  if (typeof process.getuid !== 'function' || typeof constants.O_NOFOLLOW !== 'number') {
    throw new DomainError('PROVISIONING_PLATFORM_UNSUPPORTED','Controlled provisioning requires POSIX ownership and no-follow file operations.',503)
  }
  if (!isAbsolute(configuredRoot) || configuredRoot.includes('\0')) throw new DomainError('PROVISIONING_ROOT_INVALID','The provisioning root must be an absolute configured directory.',503)
  const root = await realpath(configuredRoot)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || (rootStat.mode & 0o022) !== 0 || (process.getuid && rootStat.uid !== process.getuid())) {
    throw new DomainError('PROVISIONING_ROOT_UNSAFE','The configured provisioning root must be a runner-owned directory without group/world write access.',503)
  }
  const name = `workspace-${createHash('sha256').update(workspaceId).digest('hex')}`
  const directory = join(root,name)
  let created = false
  try { await mkdir(directory,{mode:0o700}); created = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const directoryStat = await lstat(directory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0
    || directoryStat.uid !== rootStat.uid || await realpath(directory) !== directory) {
    throw new DomainError('PROVISIONING_TARGET_UNSAFE','The reserved workspace directory has unexpected ownership, permissions, or links.',409)
  }
  const marker = join(directory,'.graphql-workspace.json')
  const expected = JSON.stringify({format:1,workspaceId})
  if (created) {
    const handle = await open(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try { await handle.writeFile(expected,'utf8'); await handle.sync() } finally { await handle.close() }
  } else {
    let handle
    try { handle = await open(marker,constants.O_RDONLY|constants.O_NOFOLLOW) }
    catch { throw new DomainError('PROVISIONING_OWNERSHIP_UNKNOWN','The reserved directory has no readable ownership marker; it was not adopted or deleted.',409) }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 4096 || await handle.readFile('utf8') !== expected) {
        throw new DomainError('PROVISIONING_OWNERSHIP_UNKNOWN','The reserved directory belongs to an unknown owner; it was not adopted or deleted.',409)
      }
    } finally { await handle.close() }
  }
  const after = await lstat(root)
  const childAfter = await lstat(directory)
  if (after.dev !== rootStat.dev || after.ino !== rootStat.ino || childAfter.dev !== directoryStat.dev || childAfter.ino !== directoryStat.ino) {
    throw new DomainError('PROVISIONING_DIRECTORY_CHANGED','The provisioning directory changed during creation.',409)
  }
  return directory
}

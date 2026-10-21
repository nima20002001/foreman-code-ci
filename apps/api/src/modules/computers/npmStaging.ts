import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const stagingName = /^\.codex-[A-Za-z0-9]+$/u

export function isCodexStagingRenameError(output: string, scope: string): boolean {
  const rename = output.match(/ENOTEMPTY[^\n]*rename '([^']+)' -> '([^']+)'/u)
  return rename !== null && rename[1] === join(scope, 'codex')
    && dirname(rename[2]!) === scope && stagingName.test(basename(rename[2]!))
}

export async function removeCodexStagingDirectories(scope: string): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Cannot verify npm staging directory ownership on this platform.')
  let parent
  try {
    parent = await lstat(scope)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // Do not follow a scope symlink into another installation.
  if (!parent.isDirectory() || parent.uid !== uid) {
    throw new Error('The npm @openai directory must be a directory owned by the maintenance user.')
  }
  for (const name of await readdir(scope)) {
    if (!stagingName.test(name)) continue
    const target = join(scope, name)
    try {
      const entry = await lstat(target)
      if (entry.isDirectory() && entry.uid === uid) await rm(target, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

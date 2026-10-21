import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DomainError } from '../errors.js'

export type MirrorGit = (args: string[], env?: Record<string, string>) => Promise<string>

async function gitExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, 'git')
    try {
      await access(path, constants.X_OK)
      return await realpath(path)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  throw new DomainError('CI_CLOUD_FAILED', 'Git could not be found for a complete mirror push.', 502)
}

/** send-pack excludes advertised haves even with --no-thin. Remove only those pack revisions;
 * the ref update commands keep their original object IDs and remote concurrency checks. */
export async function pushFullMirrorPack(git: MirrorGit, args: string[]): Promise<string> {
  const executable = await gitExecutable()
  const execPath = (await git(['--exec-path'])).trim()
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(root, 'mirror-full-pack-'))
  try {
    await writeFile(join(directory, 'git'), `#!${process.execPath}
const { readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
let args = process.argv.slice(2)
const packing = args[0] === 'pack-objects' && args.includes('--revs') && args.includes('--stdout')
let input
if (packing) {
  args = args.filter(argument => argument !== '--thin')
  input = readFileSync(0, 'utf8').split('\\n').filter(line => !line.startsWith('^')).join('\\n')
}
const result = spawnSync(${JSON.stringify(executable)}, args, {
  stdio: packing ? ['pipe', 'inherit', 'inherit'] : 'inherit',
  ...(packing ? { input } : {}),
})
if (result.error) console.error(result.error.message)
if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
`, { mode: 0o700 })
    return await git(args, { GIT_EXEC_PATH: directory, PATH: [execPath, process.env.PATH ?? ''].join(delimiter) })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

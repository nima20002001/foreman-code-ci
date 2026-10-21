import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { DomainError } from '../errors.js'
import { BrowserCdpConnection } from './cdp.js'
import type { BrowserRuntimeDirectory } from '../../../../worker/src/browserRuntimeInstall.mjs'

export interface BrowserProcessIdentity {
  pid: number; generation: number; token: string; executable: string; directory: string
  headless: boolean; endpoint: string | null
  birthId: string | null
  runtimeDirectory?: BrowserRuntimeDirectory | null
}

export function browserProcessBirthId(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`
  } catch { return null /* A disappeared process has no birth identity. */ }
}

export function browserProcessAlive(pid: number, birthId?: string | null): boolean {
  try {
    process.kill(pid, 0)
    return !birthId || browserProcessBirthId(pid) === birthId
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function readBrowserProcessIdentity(directory: string): Promise<BrowserProcessIdentity | undefined> {
  const path = join(directory, 'foreman-process.json')
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || process.getuid && info.uid !== process.getuid()) throw new Error('Unsafe process receipt')
    const value = JSON.parse(await readFile(path, 'utf8')) as BrowserProcessIdentity
    if (value.directory !== directory || !Number.isSafeInteger(value.pid) || value.pid < 1
      || !Number.isSafeInteger(value.generation) || value.generation < 1 || !/^[a-f0-9-]{36}$/.test(value.token)) {
      throw new Error('Invalid process receipt')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new DomainError('BROWSER_PROCESS_OWNERSHIP', 'Browser process ownership could not be verified.', 503, undefined, { cause: error })
  }
}

export async function writeBrowserProcessIdentity(value: BrowserProcessIdentity): Promise<void> {
  const path = join(value.directory, 'foreman-process.json'), temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
  const parent = await open(dirname(path), 'r')
  try { await parent.sync() } finally { await parent.close() }
}

export async function verifyBrowserProcess(connection: BrowserCdpConnection, identity: BrowserProcessIdentity): Promise<void> {
  const result = await connection.send('Browser.getBrowserCommandLine') as { arguments?: unknown }
  const args = result.arguments
  if (!Array.isArray(args) || !args.includes(`--foreman-browser-owner=${identity.token}`)
    || !args.includes(`--user-data-dir=${identity.directory}`) || !args.includes('--enable-automation')
    || !browserProcessAlive(identity.pid, identity.birthId)) {
    throw new DomainError('BROWSER_PROCESS_OWNERSHIP', 'The live browser does not match this host’s persisted process identity.', 503)
  }
}

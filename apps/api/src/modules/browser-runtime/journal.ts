import { mkdir, open, readFile, rename, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { browserInputHash } from '../browser-profiles/identity.js'
import type { BrowserRuntimeJournal, BrowserRuntimeReceipt, BrowserRuntimeSessionRecord } from './types.js'

export async function atomicBrowserPrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || process.getuid && info.uid !== process.getuid()) throw new Error('Browser journal directory is not private')
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  await rename(temporary, join(directory, name))
  const parent = await open(directory, 'r')
  try { await parent.sync() } finally { await parent.close() }
}

async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Only private host metadata is written here. Raw input/credentials/frames never enter this journal. */
export function createBrowserRuntimeJournal(root: string): BrowserRuntimeJournal {
  const receipts = join(root, 'receipts'), sessions = join(root, 'sessions')
  const tails = new Map<string, Promise<void>>()
  const write = (directory: string, key: string, value: unknown) => {
    const snapshot = structuredClone(value), name = `${browserInputHash(key)}.json`, identity = `${directory}/${name}`
    const prior = tails.get(identity) ?? Promise.resolve()
    const task = prior.then(() => atomicBrowserPrivateJson(directory, name, snapshot), () => atomicBrowserPrivateJson(directory, name, snapshot))
    tails.set(identity, task)
    void task.finally(() => { if (tails.get(identity) === task) tails.delete(identity) })
      .catch(() => { /* ignore: the returned write reports its durable failure. */ })
    return task
  }
  return {
    read: key => readPrivateJson<BrowserRuntimeReceipt>(join(receipts, `${browserInputHash(key)}.json`)),
    write: (key, value) => write(receipts, key, value),
    saveSession: value => write(sessions, value.session.id, value),
    async loadSessions() {
      await mkdir(sessions, { recursive: true, mode: 0o700 })
      const result: BrowserRuntimeSessionRecord[] = []
      for (const name of await readdir(sessions)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const value = await readPrivateJson<BrowserRuntimeSessionRecord>(join(sessions, name))
        if (value) result.push(value)
      }
      return result
    },
  }
}

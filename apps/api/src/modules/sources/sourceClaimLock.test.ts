import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { chmod, readdir, readFile, rm } from 'node:fs/promises'
import { afterEach, expect, it } from 'vitest'
import { withClaimLock } from './materialization.js'
import { openPrivateRoot } from './privateFilesystem.js'
import { deferred } from '../../../test/helpers/deferred.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function children(): Promise<string[]> {
  const tasks = await readdir('/proc/self/task')
  const records = await Promise.all(tasks.map(task => readFile(`/proc/self/task/${task}/children`, 'utf8')
    .catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })))
  return [...new Set(records.flatMap(record => record.trim().split(/\s+/).filter(Boolean)))]
}
async function newChild(previous: string[]): Promise<string | null> {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const child = (await children()).find(pid => !previous.includes(pid))
    if (child) return child
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return null
}
async function settlement<T>(promise: Promise<T>): Promise<T | 'still waiting'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<'still waiting'>(resolve => {
      timer = setTimeout(() => resolve('still waiting'), 1000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

it('cancels and joins only its own blocking lock waiter, then releases its guard before rejecting', async () => {
  const path = await privateFixtureDirectory('source-claim-lock-')
  roots.push(path)
  await chmod(path, 0o700)
  const ownerRoot = await openPrivateRoot(path)
  const waiterRoot = await openPrivateRoot(path)
  const entered = deferred(), release = deferred()
  let ownerClosed = false
  let waiterEntered = false
  const owner = withClaimLock(ownerRoot, async () => { entered.resolve(); await release.promise })
    .finally(() => { ownerClosed = true })
  await entered.promise
  const controller = new AbortController()
  const reason = new DOMException('Original cleanup deadline elapsed.', 'TimeoutError')
  const originalChildren = await children()
  const waiter = withClaimLock(waiterRoot, async () => { waiterEntered = true }, { signal: controller.signal })
  const rejected = waiter.then(() => null, error => error)
  const waiterPid = await newChild(originalChildren)
  controller.abort(reason)
  try {
    expect(waiterPid).not.toBeNull()
    expect(await settlement(rejected)).toBe(reason)
    expect(waiterEntered).toBe(false)
    expect(ownerClosed).toBe(false)
    expect(await children()).not.toContain(waiterPid)
    await expect(withClaimLock(waiterRoot, async () => {}, { nonBlocking: true }))
      .rejects.toMatchObject({ code: 'SOURCE_CLAIM_LOCK_FAILED' })
  } finally {
    release.resolve()
    await owner
    await rejected
    await ownerRoot.close()
    await waiterRoot.close()
  }
  const restarted = await openPrivateRoot(path)
  try {
    expect(await withClaimLock(restarted, async () => 'available', { nonBlocking: true })).toBe('available')
    expect(waiterEntered).toBe(false)
  } finally { await restarted.close() }
})

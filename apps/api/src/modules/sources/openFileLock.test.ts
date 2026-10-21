import { open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { lockOpenFile, openPrivateRoot, withPrivateDirectoryLock } from './privateFilesystem.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await privateFixtureDirectory('open-file-lock-')
  roots.push(root)
  return root
}

it('keeps an open file locked after flock exits and makes contention nonblocking', async () => {
  const root = await fixture()
  const path = join(root, 'reservation')
  await writeFile(path, 'owner', { mode: 0o600 })
  const owner = await open(path, 'r')
  const contender = await open(path, 'r')
  try {
    expect(await lockOpenFile(owner)).toBe(true)
    expect(await lockOpenFile(contender, { nonBlocking: true })).toBe(false)
    await owner.close()
    expect(await lockOpenFile(contender, { nonBlocking: true })).toBe(true)
  } finally {
    await owner.close()
    await contender.close()
  }
})

it('preserves directory contention errors and releases the guard after a failed operation', async () => {
  const root = await openPrivateRoot(await fixture())
  const failure = new Error('Operation failed')
  try {
    await expect(withPrivateDirectoryLock(root, async () => {
      await expect(withPrivateDirectoryLock(root, async () => 'unreachable', { nonBlocking: true }))
        .rejects.toMatchObject({ code: 'SOURCE_CLAIM_LOCK_FAILED' })
      throw failure
    })).rejects.toBe(failure)
    expect(await withPrivateDirectoryLock(root, async () => 'released', { nonBlocking: true })).toBe('released')
  } finally {
    await root.close()
  }
})

it('preserves the original abort reason without entering the directory operation', async () => {
  const root = await openPrivateRoot(await fixture())
  const reason = new Error('Lock canceled')
  const controller = new AbortController()
  controller.abort(reason)
  let entered = false
  try {
    await expect(lockOpenFile(root, { signal: controller.signal })).rejects.toBe(reason)
    await expect(withPrivateDirectoryLock(root, async () => { entered = true }, { signal: controller.signal }))
      .rejects.toBe(reason)
    expect(entered).toBe(false)
    expect(await withPrivateDirectoryLock(root, async () => 'available', { nonBlocking: true })).toBe('available')
  } finally {
    await root.close()
  }
})

it('joins an aborted blocking waiter while preserving the owner lock', async () => {
  const root = await fixture()
  const path = join(root, 'reservation')
  await writeFile(path, 'owner', { mode: 0o600 })
  const owner = await open(path, 'r')
  const waiter = await open(path, 'r')
  const probe = await open(path, 'r')
  const controller = new AbortController()
  const reason = new Error('Waiting canceled')
  try {
    expect(await lockOpenFile(owner)).toBe(true)
    const waiting = lockOpenFile(waiter, { signal: controller.signal })
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(await lockOpenFile(probe, { nonBlocking: true })).toBe(false)
    await owner.close()
    expect(await lockOpenFile(probe, { nonBlocking: true })).toBe(true)
  } finally {
    await owner.close()
    await waiter.close()
    await probe.close()
  }
})

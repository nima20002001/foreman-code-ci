import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { materializationDirectory } from './materialization.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const path = await mkdtemp(join(persistentFixtureRoot, 'materialization-directory-'))
  roots.push(path)
  const root = await openPrivateRoot(path)
  const filesystem = await identity(root)
  const materializationId = randomUUID()
  const quota = {
    namespace: randomUUID(),
    projectId: 1,
    hardLimitBytes: 4096,
    hardInodes: 16,
    filesystem,
  }
  return { path, root, filesystem, materializationId, quota }
}

it.each(['direct', 'quota'])('returns an owned %s directory while keeping the qualified root open', async kind => {
  const f = await fixture()
  const receipt: Pick<MaterializationReceipt, 'materializationId' | 'quota'> = {
    materializationId: f.materializationId,
    ...(kind === 'quota' ? { quota: f.quota } : {}),
  }
  const path = join(f.path, ...(receipt.quota ? [receipt.quota.namespace] : []), receipt.materializationId)
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const directory = await materializationDirectory(f.root, receipt)
    try {
      const filesystem = await identity(directory)
      expect(filesystem.inode).not.toBe(f.filesystem.inode)
      expect(filesystem.device).toBe(f.filesystem.device)
      expect(filesystem.mountId).toBe(f.filesystem.mountId)
    } finally {
      await directory.close()
    }
    expect(await identity(f.root)).toEqual(f.filesystem)
    const reopened = await materializationDirectory(f.root, receipt)
    await reopened.close()
  } finally {
    await f.root.close()
  }
})

it.each(['direct', 'quota'])('keeps the qualified root usable after a missing %s directory', async kind => {
  const f = await fixture()
  const receipt = {
    materializationId: f.materializationId,
    ...(kind === 'quota' ? { quota: f.quota } : {}),
  }
  const parent = join(f.path, ...(receipt.quota ? [receipt.quota.namespace] : []))
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await expect(materializationDirectory(f.root, receipt)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await identity(f.root)).toEqual(f.filesystem)
    await mkdir(join(parent, receipt.materializationId), { mode: 0o700 })
    const directory = await materializationDirectory(f.root, receipt)
    await directory.close()
  } finally {
    await f.root.close()
  }
})

it('opens a replacement independently and rejects a later symlink', async () => {
  const f = await fixture()
  const path = join(f.path, f.materializationId)
  const retained = join(f.path, 'retained')
  const receipt = { materializationId: f.materializationId }
  try {
    await mkdir(path, { mode: 0o700 })
    const original = await materializationDirectory(f.root, receipt)
    try {
      const originalIdentity = await identity(original)
      await rename(path, retained)
      await mkdir(path, { mode: 0o700 })
      const replacement = await materializationDirectory(f.root, receipt)
      try {
        expect(await identity(replacement)).not.toEqual(originalIdentity)
      } finally {
        await replacement.close()
      }
      expect(await identity(original)).toEqual(originalIdentity)
      await rm(path, { recursive: true })
      await symlink(retained, path)
      await expect(materializationDirectory(f.root, receipt)).rejects.toThrow()
      expect(await identity(f.root)).toEqual(f.filesystem)
    } finally {
      await original.close()
    }
  } finally {
    await f.root.close()
  }
})

it('rechecks quota-parent permissions after qualifying the root and directory', async () => {
  const f = await fixture()
  const parent = join(f.path, f.quota.namespace)
  try {
    await mkdir(join(parent, f.materializationId), { recursive: true, mode: 0o700 })
    const directory = await materializationDirectory(f.root, f)
    await directory.close()
    await chmod(parent, 0o770)
    await expect(materializationDirectory(f.root, f)).rejects.toMatchObject({
      code: 'SOURCE_DIRECTORY_NOT_PRIVATE',
    })
    expect(await identity(f.root)).toEqual(f.filesystem)
  } finally {
    await f.root.close()
  }
})

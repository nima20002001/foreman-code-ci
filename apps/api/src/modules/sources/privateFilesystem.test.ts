import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { entryParent, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-identity-')); roots.push(root)
  return root
}

it('does not reuse closed handle identity for another open directory', async () => {
  const root = await fixture(), handle = await openPrivateRoot(root)
  const first = await identity(handle)
  await handle.close()
  await expect(identity(handle)).rejects.toThrow()
  await mkdir(join(root, 'other'), { mode: 0o700 })
  const parent = await openPrivateRoot(root)
  try {
    const other = await openChildDirectory(parent, 'other')
    try { expect((await identity(other)).inode).not.toBe(first.inode) } finally { await other.close() }
  } finally { await parent.close() }
})

it('checks current directory permissions even after identity was read', async () => {
  const root = await fixture(); await mkdir(join(root, 'child'), { mode: 0o700 })
  const parent = await openPrivateRoot(root), child = await openChildDirectory(parent, 'child')
  try {
    await identity(parent); await identity(child)
    await chmod(join(root, 'child'), 0o770)
    await expect(openChildDirectory(parent, 'child')).rejects.toMatchObject({ code: 'SOURCE_DIRECTORY_NOT_PRIVATE' })
    await chmod(root, 0o770)
    await expect(openPrivateRoot(root)).rejects.toMatchObject({ code: 'SOURCE_ROOT_NOT_PRIVATE' })
  } finally { await child.close(); await parent.close() }
})

it('qualifies a replacement root independently and still rejects symlinks', async () => {
  const directory = await fixture(), root = join(directory, 'root')
  await mkdir(root, { mode: 0o700 })
  const original = await openPrivateRoot(root)
  try {
    const originalIdentity = await identity(original)
    await rename(root, join(directory, 'retained')); await mkdir(root, { mode: 0o700 })
    const replacement = await openPrivateRoot(root)
    try { expect(await identity(replacement)).not.toEqual(originalIdentity) } finally { await replacement.close() }
    expect(await identity(original)).toEqual(originalIdentity)
    await rm(root, { recursive: true }); await symlink(join(directory, 'retained'), root)
    await expect(openPrivateRoot(root)).rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
  } finally { await original.close() }
})

it('still rejects an entry on another existing filesystem after parent identity is cached', async () => {
  const root = await fixture(), other = await mkdtemp('/dev/shm/source-identity-'); roots.push(other)
  const parent = await openPrivateRoot(root)
  try {
    await identity(parent)
    // Use the existing tmpfs directly; no mount or system configuration is changed.
    await expect(openChildDirectory(parent, relative(root, other))).rejects.toMatchObject({ code: 'SOURCE_MOUNT_CHANGED' })
  } finally { await parent.close() }
})

it.each(['leaf.bin', 'nested/leaf.bin'])('retains the caller root when returning and closing the owned parent for %s', async path => {
  const root = await fixture(), handle = await openPrivateRoot(root)
  try {
    const before = await identity(handle), target = await entryParent(handle, path, true)
    expect(target.leaf).toBe('leaf.bin'); await target.parent.close()
    expect(await identity(handle)).toEqual(before)
    await expect(entryParent(handle, 'missing/leaf.bin', false)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await identity(handle)).toEqual(before)
  } finally { await handle.close() }
})

it('reopens an unchanged qualified root without reopening its ancestors', async () => {
  const root = await fixture()
  const first = await openPrivateRoot(root)
  const expected = await identity(first)
  await first.close()
  vi.mocked(open).mockClear()
  const second = await openPrivateRoot(root)
  try {
    expect(await identity(second)).toEqual(expected)
    expect(open).toHaveBeenCalledTimes(1)
  } finally { await second.close() }
})

it('invalidates root qualification when an ancestor becomes writable', async () => {
  const ancestor = await fixture()
  const root = join(ancestor, 'private')
  await mkdir(root, { mode: 0o700 })
  await (await openPrivateRoot(root)).close()
  await chmod(ancestor, 0o777)
  try {
    await expect(openPrivateRoot(root)).rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
  } finally { await chmod(ancestor, 0o700) }
  const recovered = await openPrivateRoot(root)
  await recovered.close()
})

it('rejects a symlinked ancestor after qualifying the original root', async () => {
  const directory = await fixture()
  const ancestor = join(directory, 'ancestor')
  const root = join(ancestor, 'private')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await (await openPrivateRoot(root)).close()
  const retained = join(directory, 'retained')
  await rename(ancestor, retained)
  await symlink(retained, ancestor)
  await expect(openPrivateRoot(root)).rejects.toMatchObject({ code: 'SOURCE_FILESYSTEM_UNSUPPORTED' })
})

it('keeps public-base qualification separate from private-root qualification', async () => {
  const root = await fixture()
  await chmod(root, 0o755)
  await (await openPrivateRoot(root, false)).close()
  await expect(openPrivateRoot(root)).rejects.toMatchObject({ code: 'SOURCE_ROOT_NOT_PRIVATE' })
  await chmod(root, 0o700)
  await (await openPrivateRoot(root)).close()
})

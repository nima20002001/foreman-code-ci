import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { approvedGitTreePaths, captureGitSource, qualifiedGit } from './capture.js'
import { SOURCE_LIMITS } from './manifest.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repository() {
  const root = await realpath(await mkdtemp(join(persistentFixtureRoot, 'tracked-source-')))
  roots.push(root)
  await qualifiedGit(root, ['init', '--template='])
  return root
}

async function commit(root: string) {
  await qualifiedGit(root, ['add', '.'])
  await qualifiedGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'source'])
  return (await qualifiedGit(root, ['rev-parse', 'HEAD'])).toString().trim()
}

async function capture(root: string, commit: string, executablePolicy: 'strip' | 'preserve-approved' = 'strip') {
  const sink = { write: vi.fn(), commit: vi.fn(), abort: vi.fn() }
  const manifest = await captureGitSource({ root, commit, executablePolicy,
    approvedSourceId: randomUUID(), sink })
  return { manifest, sink }
}

it('approves the pinned commit tree even when HEAD, index and working files change', async () => {
  const root = await repository()
  await writeFile(join(root, 'source.ts'), 'original source\n')
  const pinned = await commit(root)
  await writeFile(join(root, 'source.ts'), 'changed source\n')
  await writeFile(join(root, 'later.ts'), 'later commit\n')
  await commit(root)
  await writeFile(join(root, 'indexed.ts'), 'index only\n')
  await qualifiedGit(root, ['add', 'indexed.ts'])
  await writeFile(join(root, 'untracked.ts'), 'working tree only\n')
  const { manifest, sink } = await capture(root, pinned)
  expect(manifest.git?.commit).toBe(pinned)
  expect(manifest.entries.map(entry => entry.path)).toEqual(['source.ts'])
  expect(sink.write.mock.calls[0]?.[2]).toEqual(Buffer.from('original source\n'))
  expect(sink.commit).toHaveBeenCalledWith(manifest)
})

it.each(['strip', 'preserve-approved'] as const)('keeps the explicit %s executable policy', async executablePolicy => {
  const root = await repository()
  await writeFile(join(root, 'run.sh'), '#!/bin/sh\nexit 0\n')
  await chmod(join(root, 'run.sh'), 0o755)
  const { manifest } = await capture(root, await commit(root), executablePolicy)
  expect(manifest.executablePolicy).toBe(executablePolicy)
  expect(manifest.entries[0]?.executable).toBe(executablePolicy === 'preserve-approved')
})

it('rejects sensitive tracked paths instead of silently excluding them', async () => {
  const root = await repository()
  await writeFile(join(root, '.env'), 'SECRET=fixture\n')
  await expect(capture(root, await commit(root))).rejects.toMatchObject({ code: 'SOURCE_SENSITIVE_PATH' })
})

it('keeps private key content rejection for ordinary tracked filenames', async () => {
  const root = await repository()
  await writeFile(join(root, 'source.txt'), '-----BEGIN PRIVATE KEY-----\nfixture\n')
  await expect(capture(root, await commit(root))).rejects.toMatchObject({ code: 'SOURCE_SECRET_CONTENT' })
})

it('keeps unsupported symlink rejection', async () => {
  const root = await repository()
  await writeFile(join(root, 'source.txt'), 'source\n')
  await symlink('source.txt', join(root, 'alias.txt'))
  await expect(capture(root, await commit(root))).rejects.toMatchObject({ code: 'SOURCE_GIT_TREE_UNSUPPORTED' })
})

it('keeps the per-file byte limit for full-tree approvals', async () => {
  const root = await repository()
  await writeFile(join(root, 'large.bin'), Buffer.alloc(SOURCE_LIMITS.fileBytes + 1))
  await expect(capture(root, await commit(root))).rejects.toMatchObject({ code: 'SOURCE_CAPACITY', status: 413 })
})

it('approves a tracked tree larger than the former 4096-entry limit', async () => {
  const root = await repository()
  for (let index = 0; index < 4200; index++) await writeFile(join(root, `file-${index}.txt`), '')
  expect(await approvedGitTreePaths(root, await commit(root))).toHaveLength(4200)
}, 30_000)

it('rejects inventories exceeding the existing entry limit', async () => {
  const root = await repository()
  for (let index = 0; index <= SOURCE_LIMITS.entries; index++) {
    await writeFile(join(root, `file-${index}.txt`), '')
  }
  const pinned = await commit(root)
  await expect(approvedGitTreePaths(root, pinned)).rejects.toMatchObject({ code: 'SOURCE_CAPACITY', status: 413 })
}, 30_000)

it('refuses mutable Git refs when resolving the tracked inventory', async () => {
  const root = await repository()
  await expect(approvedGitTreePaths(root, 'HEAD')).rejects.toMatchObject({ code: 'SOURCE_GIT_REF_INVALID' })
})

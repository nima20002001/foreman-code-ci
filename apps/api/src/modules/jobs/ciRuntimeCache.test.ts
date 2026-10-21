import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { pruneCiRuntimeCache, readCiRuntimeCache, writeCiRuntimeCache } from './ciRuntimeCache.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const installer = await privateFixtureDirectory('ci-image-cache-')
  directories.push(installer)
  const prepared = {
    commit: 'a'.repeat(40),
    imageId: 'sha256:' + 'b'.repeat(64),
    imageManifestDigest: 'sha256:' + 'c'.repeat(64),
    seedReceiptPath: join(installer, 'seed-receipt.json'),
    contextReceiptPath: join(installer, 'context-receipt.json'),
    qualificationSource: join(installer, 'original-source'),
  }
  await mkdir(prepared.qualificationSource)
  await writeFile(prepared.seedReceiptPath, 'reviewed seed', { mode: 0o600 })
  await writeFile(prepared.contextReceiptPath, 'installed controls', { mode: 0o600 })
  const input = { installer, prepared, inputDigest: 'd'.repeat(64) }
  await writeCiRuntimeCache(input)
  return { ...input, imageExists: vi.fn<(imageId: string) => Promise<boolean>>(async () => true) }
}

it('reuses an immutable image and its verified receipts without claiming source qualification', async () => {
  const f = await fixture()
  await rm(f.prepared.qualificationSource, { recursive: true })
  const cached = await readCiRuntimeCache(f)
  expect(cached).toEqual({
    imageId: f.prepared.imageId,
    imageManifestDigest: f.prepared.imageManifestDigest,
    seedReceiptPath: f.prepared.seedReceiptPath,
    contextReceiptPath: f.prepared.contextReceiptPath,
  })
  expect(f.imageExists).toHaveBeenCalledWith(f.prepared.imageId)
  expect(await readFile(f.prepared.seedReceiptPath, 'utf8')).toBe('reviewed seed')
})

it.each(['dependency-inputs', 'missing-image', 'seed-receipt', 'context-receipt'] as const)(
  'rebuilds after changed or unavailable %s', async change => {
    const f = await fixture()
    if (change === 'dependency-inputs') f.inputDigest = 'e'.repeat(64)
    if (change === 'missing-image') f.imageExists.mockResolvedValue(false)
    if (change === 'seed-receipt') await writeFile(f.prepared.seedReceiptPath, 'changed seed')
    if (change === 'context-receipt') await rm(f.prepared.contextReceiptPath)
    expect(await readCiRuntimeCache(f)).toBeNull()
  })

it('does not read cache artifacts outside the installation', async () => {
  const f = await fixture()
  await expect(writeCiRuntimeCache({ ...f,
    prepared: { ...f.prepared, seedReceiptPath: '/another-installation/seed.json' },
  })).rejects.toThrow('belong to the installed runtime')
})

it('drops records of pruned images and the installer copies only they used', async () => {
  const f = await fixture()
  const pruned = { installer: f.installer, inputDigest: 'e'.repeat(64), prepared: { ...f.prepared,
    imageId: 'sha256:' + 'f'.repeat(64), seedReceiptPath: join(f.installer, 'seed-receipt-' + '1'.repeat(12) + '.json'),
    contextReceiptPath: join(f.installer, 'context-receipt-' + '1'.repeat(12) + '.json') } }
  await writeFile(pruned.prepared.seedReceiptPath, 'old seed', { mode: 0o600 })
  await writeFile(pruned.prepared.contextReceiptPath, 'old controls', { mode: 0o600 })
  await writeFile(join(f.installer, 'codex-' + '2'.repeat(12)), 'refreshed Codex', { mode: 0o700 })
  await writeCiRuntimeCache(pruned)
  f.imageExists.mockImplementation(async imageId => imageId === f.prepared.imageId)
  await pruneCiRuntimeCache(f)
  expect(await readCiRuntimeCache(f)).not.toBeNull()
  expect(await readCiRuntimeCache({ ...f, inputDigest: pruned.inputDigest })).toBeNull()
  expect((await readdir(f.installer)).sort()).toEqual(['context-receipt.json', 'original-source', 'runtime-cache',
    'seed-receipt.json'])
  expect(await readdir(join(f.installer, 'runtime-cache'))).toEqual([f.inputDigest + '.json'])
})

it('keeps installed receipts through cache pruning and removes them after their configuration is retired', async () => {
  const f = await fixture()
  const retained = join(f.installer, 'seed-receipt-' + '1'.repeat(12) + '.json')
  const current = join(f.installer, 'seed-receipt-' + '2'.repeat(64) + '.json')
  const unused = join(f.installer, 'context-receipt-' + '3'.repeat(64) + '.json')
  for (const path of [retained, current, unused]) await writeFile(path, 'protected bytes', { mode: 0o600 })
  await pruneCiRuntimeCache({ ...f, keepPaths: [retained, current] })
  expect(await readFile(retained, 'utf8')).toBe('protected bytes')
  expect(await readFile(current, 'utf8')).toBe('protected bytes')
  await expect(readFile(unused)).rejects.toMatchObject({ code: 'ENOENT' })
  await pruneCiRuntimeCache(f)
  await expect(readFile(retained)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(current)).rejects.toMatchObject({ code: 'ENOENT' })
})

import * as fs from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { binaryCacheIdentity } from './binaryIdentity.js'
import { discoverLauncher } from './hostDiscovery.js'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, createReadStream: vi.fn(original.createReadStream) }
})

const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const image = (content: string) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(content)])

async function fixture() {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, 'binary-identity-'))
  directories.push(directory)
  const launcher = join(directory, 'launcher')
  await writeFile(launcher, image('original'), { mode: 0o700 })
  return { directory, launcher }
}

it('reuses discovery hashes during repeated dispatch verification', async () => {
  const { directory, launcher } = await fixture()
  const first = await binaryCacheIdentity('codex', launcher, directory)
  expect(await binaryCacheIdentity('codex', launcher, directory)).toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)

  const environment = { generation: 'dispatch', provenance: 'worker' as const, cwd: directory, path: directory }
  const checked = await discoverLauncher(launcher, environment)
  expect(checked.status).toBe('installed')
  expect((await discoverLauncher(launcher, environment)).fingerprint).toBe(checked.fingerprint)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
})

it.each(['rewrite', 'replace'] as const)('changes identity after a same-size %s with preserved mtime', async kind => {
  const { directory, launcher } = await fixture()
  await utimes(launcher, new Date(0), new Date(1000))
  const first = await binaryCacheIdentity('codex', launcher, directory)
  const before = await stat(launcher)
  if (kind === 'replace') {
    const replacement = join(directory, 'replacement')
    await writeFile(replacement, image('modified'), { mode: 0o700 })
    await utimes(replacement, before.atime, before.mtime)
    await rename(replacement, launcher)
  } else {
    await writeFile(launcher, image('modified'))
    await utimes(launcher, before.atime, before.mtime)
  }
  expect(await binaryCacheIdentity('codex', launcher, directory)).not.toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('refreshes execute permissions instead of accepting a cached launcher', async () => {
  const { directory, launcher } = await fixture()
  const first = await binaryCacheIdentity('codex', launcher, directory)
  await chmod(launcher, 0o600)
  expect(await binaryCacheIdentity('codex', launcher, directory)).not.toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
  await chmod(launcher, 0o700)
  expect(await binaryCacheIdentity('codex', launcher, directory)).toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('follows replaced launcher symlinks and reports a subsequently missing target', async () => {
  const { directory, launcher } = await fixture()
  const alias = join(directory, 'selected')
  const replacement = join(directory, 'replacement')
  await symlink(launcher, alias)
  const first = await binaryCacheIdentity('codex', alias, directory)
  await writeFile(replacement, image('modified'), { mode: 0o700 })
  await symlink(replacement, `${alias}.replacement`)
  await rename(`${alias}.replacement`, alias)
  const second = await binaryCacheIdentity('codex', alias, directory)
  expect(second).not.toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
  await rm(replacement)
  expect(await binaryCacheIdentity('codex', alias, directory)).not.toBe(second)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rechecks env interpreters and includes changed interpreter bytes in the identity', async () => {
  const { directory, launcher } = await fixture()
  const interpreter = join(directory, 'runtime')
  await writeFile(launcher, '#!/usr/bin/env runtime\nlauncher fixture\n')
  await writeFile(interpreter, image('original'), { mode: 0o700 })
  vi.stubEnv('PATH', directory)
  const first = await binaryCacheIdentity('codex', launcher, directory)
  expect(await binaryCacheIdentity('codex', launcher, directory)).toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
  await writeFile(interpreter, image('modified'))
  const second = await binaryCacheIdentity('codex', launcher, directory)
  expect(second).not.toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(3)
  await chmod(interpreter, 0o600)
  expect(await binaryCacheIdentity('codex', launcher, directory)).not.toBe(second)
  expect(fs.createReadStream).toHaveBeenCalledTimes(3)
})

it('refreshes the target environment without rehashing unchanged executable bytes', async () => {
  const { directory, launcher } = await fixture()
  vi.stubEnv('PATH', directory)
  const first = await binaryCacheIdentity('codex', launcher, directory)
  vi.stubEnv('PATH', `${directory}:/usr/bin`)
  expect(await binaryCacheIdentity('codex', launcher, directory)).not.toBe(first)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
})

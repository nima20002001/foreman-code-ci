import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { addGitWorktree, ensureClone, ensureCommit, systemGitWorktreePorts,
  type GitWorktreePorts } from './gitWorktree.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { fetchingApi, interruptedFetchWriter, makeStale } from '../../../test/helpers/interruptedGitFetch.js'

const disk = vi.hoisted(() => ({ full: false }))
const filesystemRace = vi.hoisted(() => ({ beforeLstat: undefined as
  ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: (async (...args: Parameters<typeof actual.lstat>) => {
    await filesystemRace.beforeLstat?.(String(args[0]))
    return actual.lstat(...args)
  }) as typeof actual.lstat, statfs: async (...args: Parameters<typeof actual.statfs>) => {
    const value = await actual.statfs(...args)
    return disk.full ? { ...value, bavail: typeof value.bavail === 'bigint' ? 0n : 0 } : value
  } }
})
const cacheLimits = vi.hoisted(() => ({ bytes: 16 * 2 ** 20, maximumFileBytes: 2 * 2 ** 20,
  transferBytes: 8 * 2 ** 20, diskMarginBytes: 2 ** 20 }))
vi.mock('@foreman-code/contracts/source-materialization', async original => ({
  ...await original<typeof import('@foreman-code/contracts/source-materialization')>(),
  SOURCE_GIT_CACHE_LIMITS: cacheLimits,
}))
const transfers = vi.hoisted(() => ({ hold: undefined as ((args: string[], cwd?: string) => Promise<void>) | undefined }))
vi.mock('./gitProcess.js', async original => {
  const actual = await original<typeof import('./gitProcess.js')>()
  return { ...actual, runGitProcess: async (...call: Parameters<typeof actual.runGitProcess>) => {
    await transfers.hold?.(call[0], call[1].cwd)
    return actual.runGitProcess(...call)
  } }
})
const roots: string[] = []
afterEach(async () => {
  cacheLimits.bytes = 16 * 2 ** 20
  transfers.hold = undefined
  disk.full = false
  filesystemRace.beforeLstat = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim()

async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-cache-storage-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const home = join(root, 'home')
  await mkdir(origin, { mode: 0o700 })
  await mkdir(home, { mode: 0o700 })
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  await writeFile(join(origin, 'history.bin'), randomBytes(4 * 2 ** 20))
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Large history')
  await rm(join(origin, 'history.bin'))
  await writeFile(join(origin, 'source.txt'), 'approved source')
  git(origin, 'add', '-A')
  git(origin, 'commit', '-qm', 'Small accepted tree')
  const commit = git(origin, 'rev-parse', 'HEAD')
  const system = systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: home })
  const transfers: string[][] = []
  const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory, git: (args, options) => {
    if (['clone', 'fetch'].includes(args[0]!)) transfers.push(args)
    return system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
      ? `file://${origin}` : arg), options)
  } }
  const cache = join(home, '.local', 'share', 'foreman-code', 'git')
  const storage = async () => JSON.parse(await readFile(join(cache, 'storage.json'), 'utf8')) as {
    filesystem: { device: string; inode: string; mountId: string }
    retainedBytes: number; reservedBytes: number; limitBytes: number
  }
  return { root, origin, commit, ports, cache, storage, transfers }
}

it.each(['published', 'removed'] as const)(
  'acquires a clone when another staging directory is %s during cache measurement', async change => {
    const f = await fixture()
    await mkdir(f.cache, { recursive: true, mode: 0o700 })
    const staging = join(f.cache, 'staging')
    const published = join(f.cache, 'published')
    await mkdir(staging, { mode: 0o700 })
    const content = Buffer.alloc(128 * 1024, 1)
    await writeFile(join(staging, 'source.bin'), content)
    let changed = false
    filesystemRace.beforeLstat = async path => {
      if (changed || !path.endsWith('/staging')) return
      changed = true
      if (change === 'published') await rename(staging, published)
      else await rm(staging, { recursive: true })
    }

    const clone = await ensureClone(f.ports, 'fixture/project', AbortSignal.timeout(30_000))
    expect(changed).toBe(true)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(f.commit)
    const stored = await f.storage()
    expect(stored.reservedBytes).toBe(0)
    if (change === 'published') {
      expect(await readFile(join(published, 'source.bin'))).toEqual(content)
      expect(stored.retainedBytes).toBeGreaterThan(content.length)
    } else {
      await expect(readFile(join(staging, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  },
)

it('denies a first clone on the cache filesystem before Git writes any objects', async () => {
  const f = await fixture()
  disk.full = true
  await expect(ensureClone(f.ports, 'fixture/project', AbortSignal.timeout(30_000)))
    .rejects.toMatchObject({ code: 'SOURCE_GIT_CACHE_CAPACITY' })
  expect((await readdir(f.cache)).filter(name => name !== 'storage.json')).toEqual(['fixture'])
  expect(await readdir(join(f.cache, 'fixture'))).toEqual([])
})

it('acquires a tiny accepted tree without its large history and accounts retained objects', async () => {
  const f = await fixture()
  const clone = await ensureCommit(f.ports, 'fixture/project', f.commit, AbortSignal.timeout(30_000))
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(f.commit)
  expect(git(clone, 'rev-list', '--count', 'HEAD')).toBe('1')
  const stored = await f.storage()
  expect(stored).toMatchObject({ reservedBytes: 0, limitBytes: 16 * 2 ** 20 })
  expect(stored.retainedBytes).toBeGreaterThan(0)
  expect(stored.retainedBytes).toBeLessThan(2 * 2 ** 20)
  const handle = await openPrivateRoot(f.cache)
  try { expect(stored.filesystem).toEqual(await identity(handle)) }
  finally { await handle.close() }
})

it('bounds a later fetch, cleans its partial transfer, and preserves active work and result branches', async () => {
  const f = await fixture()
  const path = join(f.root, 'working')
  const signal = AbortSignal.timeout(30_000)
  const first = await addGitWorktree(f.ports, { repository: 'fixture/project', branch: 'foreman/result' },
    f.commit, path, signal)
  await writeFile(join(path, 'result.txt'), 'retained result')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'Retained result')
  const resultCommit = git(path, 'rev-parse', 'HEAD')
  await writeFile(join(path, 'uncommitted.txt'), 'active work')
  await writeFile(join(f.origin, 'expansion.bin'), randomBytes(3 * 2 ** 20))
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Oversized transfer')
  const expansion = git(f.origin, 'rev-parse', 'HEAD')
  await expect(ensureCommit(f.ports, 'fixture/project', expansion, signal)).rejects.toThrow()
  expect((await f.storage()).reservedBytes).toBe(0)
  const clone = f.ports.cloneDirectory('fixture/project')
  expect(git(clone, 'rev-parse', first.branch)).toBe(resultCommit)
  expect(await readFile(join(path, 'uncommitted.txt'), 'utf8')).toBe('active work')
  const packs = join(clone, '.git', 'objects', 'pack')
  const partial = (await readdir(packs)).filter(name => name.startsWith('tmp_'))
  await makeStale(packs, partial)
  await rm(join(f.origin, 'expansion.bin'))
  git(f.origin, 'add', '-A')
  git(f.origin, 'commit', '-qm', 'Small successor')
  const successor = git(f.origin, 'rev-parse', 'HEAD')
  await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
  expect((await readdir(packs)).filter(name => name.startsWith('tmp_'))).toEqual([])
  expect(git(clone, 'rev-parse', first.branch)).toBe(resultCommit)
  expect((await f.storage()).retainedBytes).toBeGreaterThan(0)
})

it('admits a fetch promptly when every cache filesystem call waits on a busy thread pool', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const clone = await ensureCommit(f.ports, 'fixture/project', f.commit, signal)
  // Retained results and object directories make the cache wide, like Main's cache of several repositories.
  for (let directory = 0; directory < 10; directory++) {
    const path = join(f.cache, 'retained', `result-${directory}`)
    await mkdir(path, { recursive: true, mode: 0o700 })
    for (let file = 0; file < 30; file++) await writeFile(join(path, `object-${file}`), 'x', { mode: 0o600 })
  }
  await writeFile(join(f.origin, 'source.txt'), 'released source')
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Release')
  const release = git(f.origin, 'rev-parse', 'HEAD')
  // Each lstat waits as it does behind startup source preparation saturating the libuv pool.
  filesystemRace.beforeLstat = () => new Promise(resolve => setTimeout(resolve, 20))

  const started = performance.now()
  await expect(ensureCommit(f.ports, 'fixture/project', release, signal)).resolves.toBe(clone)
  expect(performance.now() - started).toBeLessThan(5000)
  expect(git(clone, 'cat-file', '-t', release)).toBe('commit')
  expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
  expect((await f.storage()).retainedBytes).toBeGreaterThan(300 * 4096)
}, 30_000)

it('charges previously retained cache bytes before admitting another fetch', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const clone = await ensureCommit(f.ports, 'fixture/project', f.commit, signal)
  await writeFile(join(f.cache, 'retained-result.bin'), randomBytes(9 * 2 ** 20), { mode: 0o600 })
  await writeFile(join(f.origin, 'source.txt'), 'updated source')
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Updated source')
  const successor = git(f.origin, 'rev-parse', 'HEAD')
  await expect(ensureCommit(f.ports, 'fixture/project', successor, signal))
    .rejects.toMatchObject({ code: 'SOURCE_GIT_CACHE_CAPACITY' })
  expect(git(clone, 'rev-parse', 'HEAD')).toBe(f.commit)
  expect((await f.storage()).retainedBytes).toBeGreaterThan(9 * 2 ** 20)
})

it('lets a transfer for one repository proceed while another repository is still transferring', async () => {
  const f = await fixture()
  cacheLimits.bytes = 64 * 2 ** 20
  const signal = AbortSignal.timeout(30_000)
  const other = join(f.root, 'other-origin')
  await mkdir(other, { mode: 0o700 })
  git(other, 'init', '--template=', '-q', '-b', 'main')
  const commitIn = async (origin: string, text: string) => {
    await writeFile(join(origin, 'source.txt'), text)
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', text)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const system = systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: join(f.root, 'home') })
  const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory, git: (args, options) => system.git(
    args.map(arg => arg === 'https://github.com/fixture/project.git' ? `file://${f.origin}`
      : arg === 'https://github.com/fixture/other.git' ? `file://${other}` : arg), options) }
  await ensureCommit(ports, 'fixture/project', f.commit, signal)
  await ensureCommit(ports, 'fixture/other', await commitIn(other, 'first'), signal)
  const slowClone = ports.cloneDirectory('fixture/project')
  const reached = deferred()
  const release = deferred()
  transfers.hold = async (args, cwd) => {
    if (!args.includes('fetch') || cwd !== slowClone) return
    reached.resolve()
    await release.promise
  }
  const slowCommit = await commitIn(f.origin, 'slow successor')
  const slow = ensureCommit(ports, 'fixture/project', slowCommit, signal)
  await reached.promise
  const otherCommit = await commitIn(other, 'other successor')
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    ensureCommit(ports, 'fixture/other', otherCommit, signal).then(() => 'transferred'),
    new Promise<string>(resolve => { timer = setTimeout(() => resolve('waiting'), 5_000) }),
  ])
  clearTimeout(timer)
  release.resolve()
  await slow
  expect(outcome).toBe('transferred')
  expect(git(ports.cloneDirectory('fixture/other'), 'cat-file', '-t', otherCommit)).toBe('commit')
  expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
}, 30_000)

/** A second module instance has its own memory, like a second Worker process sharing the cache directory. */
async function otherProcess() {
  vi.resetModules()
  return import('./gitWorktree.js')
}

async function twoRepositories() {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const other = join(f.root, 'other-origin')
  await mkdir(other, { mode: 0o700 })
  git(other, 'init', '--template=', '-q', '-b', 'main')
  const commitIn = async (origin: string, text: string) => {
    await writeFile(join(origin, 'source.txt'), text)
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', text)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const home = join(f.root, 'home')
  const redirect = (system: GitWorktreePorts): GitWorktreePorts => ({ cloneDirectory: system.cloneDirectory,
    git: (args, options) => system.git(args.map(arg => arg === 'https://github.com/fixture/project.git'
      ? `file://${f.origin}` : arg === 'https://github.com/fixture/other.git' ? `file://${other}` : arg), options) })
  const ports = redirect(systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: home }))
  await ensureCommit(ports, 'fixture/project', f.commit, signal)
  await ensureCommit(ports, 'fixture/other', await commitIn(other, 'first'), signal)
  const slowClone = ports.cloneDirectory('fixture/project')
  const reached = deferred()
  const release = deferred()
  transfers.hold = async (args, cwd) => {
    if (!args.includes('fetch') || cwd !== slowClone) return
    reached.resolve()
    await release.promise
  }
  const slow = ensureCommit(ports, 'fixture/project', await commitIn(f.origin, 'slow successor'), signal)
  await reached.promise
  const otherCommit = await commitIn(other, 'other successor')
  const second = await otherProcess()
  const secondPorts = redirect(second.systemGitWorktreePorts({ ...gitFixtureEnvironment(), HOME: home }))
  return { f, signal, slow, release, otherCommit,
    fetchOther: () => second.ensureCommit(secondPorts, 'fixture/other', otherCommit, signal) }
}

it('counts a transfer reserved by another process against the shared cache budget', async () => {
  const held = await twoRepositories()
  await expect(held.fetchOther()).rejects.toMatchObject({ code: 'SOURCE_GIT_CACHE_CAPACITY' })
  held.release.resolve()
  await held.slow
  await expect(held.fetchOther()).resolves.toBeTruthy()
  expect(await held.f.storage()).toMatchObject({ reservedBytes: 0 })
}, 30_000)

it('keeps a live transfer charged even when its recorded process identity is obsolete', async () => {
  const held = await twoRepositories()
  const reservation = (await readdir(held.f.cache)).find(name => name.endsWith('.reservation'))!
  const path = join(held.f.cache, reservation)
  const gone = spawnSync(process.execPath, ['-e', ''])
  const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number }
  await writeFile(path, JSON.stringify({ ...owner, pid: gone.pid }))
  try {
    await expect(held.fetchOther()).rejects.toMatchObject({ code: 'SOURCE_GIT_CACHE_CAPACITY' })
  } finally {
    held.release.resolve()
    await held.slow
  }
  await expect(held.fetchOther()).resolves.toBeTruthy()
  expect(await held.f.storage()).toMatchObject({ reservedBytes: 0 })
}, 30_000)

it.each(['exited', 'reused-pid'] as const)('reclaims a legacy reservation after its owner is %s', async state => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const clone = await ensureCommit(f.ports, 'fixture/project', f.commit, signal)
  const metadata = await readFile('/proc/self/stat', 'utf8')
  const started = metadata.slice(metadata.lastIndexOf(')') + 2).split(' ')[19]!
  const path = join(f.cache, 'transfer-legacy.reservation')
  await writeFile(path, JSON.stringify({ pid: process.pid, started }))
  await writeFile(join(f.origin, 'source.txt'), 'successor after legacy reservation')
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Successor')
  const commit = git(f.origin, 'rev-parse', 'HEAD')
  await expect(ensureCommit(f.ports, 'fixture/project', commit, signal))
    .rejects.toMatchObject({ code: 'SOURCE_GIT_CACHE_CAPACITY' })
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ pid: process.pid, started })

  const gone = spawnSync(process.execPath, ['-e', ''])
  expect(gone.status).toBe(0)
  const owner = state === 'exited' ? { pid: gone.pid, started } : { pid: process.pid, started: `${started}-old` }
  await writeFile(path, JSON.stringify(owner))
  await expect(ensureCommit(f.ports, 'fixture/project', commit, signal)).resolves.toBe(clone)
  expect(git(clone, 'cat-file', '-t', commit)).toBe('commit')
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
}, 30_000)

it('reclaims a closed fetch’s abandoned packs before checking transfer capacity', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const clone = await ensureCommit(f.ports, 'fixture/project', f.commit, signal)
  const common = join(clone, '.git')
  const path = 'objects/pack/tmp_pack_abandoned'
  await writeFile(join(f.cache, 'retained-result.bin'), randomBytes(7 * 2 ** 20))
  await writeFile(join(common, path), randomBytes(2 * 2 ** 20))
  await makeStale(common, [path])
  const gone = spawnSync(process.execPath, ['-e', ''])
  expect(gone.status).toBe(0)
  const name = 'transfer-interrupted.reservation'
  await writeFile(join(f.cache, name), JSON.stringify({ pid: gone.pid, started: 'closed',
    lifetimeLock: true, fetch: common }))
  await writeFile(join(f.origin, 'source.txt'), 'successor after capacity recovery')
  git(f.origin, 'add', '.')
  git(f.origin, 'commit', '-qm', 'Successor')
  const successor = git(f.origin, 'rev-parse', 'HEAD')

  await expect(ensureCommit(f.ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
  expect(git(clone, 'cat-file', '-t', successor)).toBe('commit')
  await expect(readFile(join(common, path))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(f.cache, name))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
})

it('reclaims another repository’s abandoned fetch packs before refusing a transfer', async () => {
  const f = await fixture()
  const signal = AbortSignal.timeout(30_000)
  const other = join(f.root, 'other-origin')
  await mkdir(other, { mode: 0o700 })
  git(other, 'init', '--template=', '-q', '-b', 'main')
  const commitIn = async (origin: string, text: string) => {
    await writeFile(join(origin, 'source.txt'), text)
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', text)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const environment = { ...gitFixtureEnvironment(), HOME: join(f.root, 'home') }
  const system = systemGitWorktreePorts(environment)
  const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory, git: (args, options) => system.git(
    args.map(arg => arg === 'https://github.com/fixture/project.git' ? `file://${f.origin}`
      : arg === 'https://github.com/fixture/other.git' ? `file://${other}` : arg), options) }
  const clone = await ensureCommit(ports, 'fixture/project', f.commit, signal)
  const otherClone = await ensureCommit(ports, 'fixture/other', await commitIn(other, 'first'), signal)
  const common = join(clone, '.git')
  const pack = 'objects/pack/tmp_pack_abandoned'
  const writer = await interruptedFetchWriter(f.root, common, { [pack]: 2 * 2 ** 20, 'shallow.lock': 41 })
  const api = await fetchingApi(f.root, f.cache, clone, writer.args, environment)
  try {
    const transfer = await writer.started()
    const exited = once(api, 'exit')
    api.kill('SIGKILL')
    await exited
    await transfer.write()
    await transfer.die()
    await makeStale(common, [pack, 'shallow.lock'])
  } finally {
    if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL')
    writer.close()
  }
  await writeFile(join(f.cache, 'retained-result.bin'), randomBytes(7 * 2 ** 20))
  const otherCommit = await commitIn(other, 'other successor')

  await expect(ensureCommit(ports, 'fixture/other', otherCommit, signal)).resolves.toBe(otherClone)
  expect(git(otherClone, 'cat-file', '-t', otherCommit)).toBe('commit')
  await expect(readFile(join(common, pack))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
}, 30_000)

it('reclaims a repository’s stale fetch locks and packs while a snapshot reader keeps it open, admitting transfers',
  async () => {
    const f = await fixture()
    const signal = AbortSignal.timeout(30_000)
    const other = join(f.root, 'other-origin')
    await mkdir(other, { mode: 0o700 })
    git(other, 'init', '--template=', '-q', '-b', 'main')
    const commitIn = async (origin: string, text: string) => {
      await writeFile(join(origin, 'source.txt'), text)
      git(origin, 'add', '-A')
      git(origin, 'commit', '-qm', text)
      return git(origin, 'rev-parse', 'HEAD')
    }
    const environment = { ...gitFixtureEnvironment(), HOME: join(f.root, 'home') }
    const system = systemGitWorktreePorts(environment)
    const ports: GitWorktreePorts = { cloneDirectory: system.cloneDirectory, git: (args, options) => system.git(
      args.map(arg => arg === 'https://github.com/fixture/project.git' ? `file://${f.origin}`
        : arg === 'https://github.com/fixture/other.git' ? `file://${other}` : arg), options) }
    const clone = await ensureCommit(ports, 'fixture/project', f.commit, signal)
    const otherClone = await ensureCommit(ports, 'fixture/other', await commitIn(other, 'first'), signal)
    const common = join(clone, '.git')
    const pack = 'objects/pack/tmp_pack_abandoned'
    const writer = await interruptedFetchWriter(f.root, common, { [pack]: 2 * 2 ** 20, 'shallow.lock': 41 })
    const api = await fetchingApi(f.root, f.cache, clone, writer.args, environment)
    try {
      const transfer = await writer.started()
      const exited = once(api, 'exit')
      api.kill('SIGKILL')
      await exited
      await transfer.write()
      await transfer.die()
      await makeStale(common, [pack, 'shallow.lock'])
    } finally {
      if (api.exitCode === null && api.signalCode === null) api.kill('SIGKILL')
      writer.close()
    }
    // Source capture's exact object reader stays open in the repository whose fetch was abandoned.
    const reader = spawn('git', ['-C', clone, 'cat-file', '--batch'],
      { env: environment, stdio: ['pipe', 'pipe', 'ignore'] })
    try {
      const answered = once(reader.stdout!, 'data')
      reader.stdin!.write(`${f.commit}\n`)
      expect(String((await answered)[0])).toContain(`${f.commit} commit`)
      await writeFile(join(f.cache, 'retained-result.bin'), randomBytes(7 * 2 ** 20))
      const otherCommit = await commitIn(other, 'other successor')

      await expect(ensureCommit(ports, 'fixture/other', otherCommit, signal)).resolves.toBe(otherClone)
      expect(git(otherClone, 'cat-file', '-t', otherCommit)).toBe('commit')
      for (const name of [pack, 'shallow.lock']) {
        await expect(readFile(join(common, name))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(await f.storage()).toMatchObject({ reservedBytes: 0 })
      // The shallow cache's own fetch needs shallow.lock, still beside the open reader.
      await rm(join(f.cache, 'retained-result.bin'))
      await writeFile(join(f.origin, 'source.txt'), 'project successor beside a reader')
      git(f.origin, 'add', '.')
      git(f.origin, 'commit', '-qm', 'Project successor')
      const successor = git(f.origin, 'rev-parse', 'HEAD')
      await expect(ensureCommit(ports, 'fixture/project', successor, signal)).resolves.toBe(clone)
      expect(git(clone, 'cat-file', '-t', successor)).toBe('commit')
    } finally {
      const closed = once(reader, 'exit')
      reader.stdin!.end()
      await closed
    }
  }, 30_000)

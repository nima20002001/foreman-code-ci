import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { interruptedFetchWriter } from '../../../test/helpers/interruptedGitFetch.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { runGitWithCacheStorage } from './gitCacheStorage.js'
import { runGitProcess } from './gitProcess.js'

async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-fetch-retry-'))
  const origin = join(root, 'origin')
  const cache = join(root, 'cache')
  const clone = join(cache, 'repository')
  const environment = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  await mkdir(origin, { mode: 0o700 })
  await mkdir(cache, { mode: 0o700 })
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  const commit = async (content: string) => {
    await writeFile(join(origin, 'source.txt'), content)
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', content)
    return git(origin, 'rev-parse', 'HEAD')
  }
  const first = await commit('first')
  git(cache, 'clone', '--template=', '--depth=1', `file://${origin}`, clone)
  await chmod(clone, 0o700)
  await chmod(join(clone, '.git'), 0o700)
  const successor = await commit('successor')
  return { root, cache, clone, common: join(clone, '.git'), environment, git, first, successor }
}

const destinationRef = 'refs/foreman/ci/fetch/interrupted'
const fetchLocks = ['FETCH_HEAD.lock', `${destinationRef}.lock`]
const temporaryPack = 'objects/pack/tmp_pack_interrupted'

it.each(['cancelled', 'timed out'] as const)(
  'immediately retries a Main fetch that %s while leaving fresh locks', async interruption => {
    const f = await fixture()
    const writer = await interruptedFetchWriter(f.root, f.common,
      Object.fromEntries([...fetchLocks, temporaryPack].map(name => [name, 41])))
    const controller = new AbortController()
    let running: ReturnType<typeof runGitWithCacheStorage> | undefined
    try {
      const shallow = await readFile(join(f.common, 'shallow'))
      running = runGitWithCacheStorage(f.cache, ['fetch', 'origin', `+${f.successor}:${destinationRef}`], {
        cwd: f.clone, signal: controller.signal,
        ...(interruption === 'timed out' ? { timeoutMs: 1500 } : {}),
      }, (args, options) => runGitProcess(args.includes('fetch') ? writer.args : args, options, f.environment))
      const started = await Promise.race([writer.started(), running.then(() => {
        throw new Error('Fetch ended before its writer started.')
      })])
      await started.write()
      for (const name of fetchLocks) {
        expect(Date.now() - (await stat(join(f.common, name))).mtimeMs).toBeLessThan(5 * 60_000)
      }
      if (interruption === 'cancelled') controller.abort()
      await expect(running).resolves.toMatchObject({ code: interruption === 'cancelled' ? 1 : 124 })
      expect(await readFile(join(f.common, 'shallow'))).toEqual(shallow)

      await expect(runGitWithCacheStorage(f.cache, ['fetch', 'origin', f.successor],
        { cwd: f.clone, signal: AbortSignal.timeout(2000) },
        (args, options) => runGitProcess(args, options, f.environment))).resolves.toMatchObject({ code: 0 })
      expect(f.git(f.clone, 'cat-file', '-t', f.successor)).toBe('commit')
      expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.first)
      for (const name of fetchLocks) {
        await expect(readFile(join(f.common, name))).rejects.toMatchObject({ code: 'ENOENT' })
      }
      expect(await readFile(join(f.common, temporaryPack))).toEqual(Buffer.alloc(41, 1))
    } finally {
      controller.abort()
      await running
      writer.close()
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

it('preserves an unrelated fresh lock created before a cancelled Main fetch starts', async () => {
  const f = await fixture()
  const ownLock = 'refs/foreman/ci/fetch/interrupted.lock'
  const unrelatedLock = join(f.common, 'FETCH_HEAD.lock')
  const writer = await interruptedFetchWriter(f.root, f.common, { [ownLock]: 41 })
  const controller = new AbortController()
  let running: ReturnType<typeof runGitWithCacheStorage> | undefined
  try {
    running = runGitWithCacheStorage(f.cache, ['fetch', 'origin', `${f.successor}:${destinationRef}`],
      { cwd: f.clone, signal: controller.signal }, async (args, options) => {
        // A writer can create a lock after admission, before Main launches its fetch.
        if (args.includes('--is-shallow-repository')) await writeFile(unrelatedLock, 'unrelated', { flag: 'wx' })
        return runGitProcess(args.includes('fetch') ? writer.args : args, options, f.environment)
      })
    const started = await Promise.race([writer.started(), running.then(() => {
      throw new Error('Fetch ended before its writer started.')
    })])
    await started.write()
    const before = await stat(unrelatedLock)
    controller.abort()
    await expect(running).resolves.toMatchObject({ code: 1 })
    await expect(readFile(join(f.common, ownLock))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(unrelatedLock, 'utf8')).toBe('unrelated')
    expect((await stat(unrelatedLock)).mtimeMs).toBe(before.mtimeMs)
    expect(Date.now() - before.mtimeMs).toBeLessThan(5 * 60_000)

    await expect(runGitWithCacheStorage(f.cache, ['fetch', 'origin', f.successor],
      { cwd: f.clone, signal: AbortSignal.timeout(1500) },
      (args, options) => runGitProcess(args, options, f.environment))).rejects.toThrow()
    expect(await readFile(unrelatedLock, 'utf8')).toBe('unrelated')
  } finally {
    controller.abort()
    await running
    writer.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

it('keeps concurrent Agent locks while removing only Main’s destination locks before a retry', async () => {
  const f = await fixture()
  const writer = await interruptedFetchWriter(f.root, f.common, { [`${destinationRef}.lock`]: 41 })
  const controller = new AbortController()
  const agentNames = ['refs/remotes/origin/agent.lock', 'packed-refs.lock', 'shallow.lock',
    'refs/foreman/ci/fetch/agent.lock']
  const agentFiles = agentNames.map(name => join(f.common, name))
  let running: ReturnType<typeof runGitWithCacheStorage> | undefined
  try {
    running = runGitWithCacheStorage(f.cache, ['fetch', '--no-write-fetch-head', 'origin',
      `+${f.successor}:${destinationRef}`], { cwd: f.clone, signal: controller.signal },
    (args, options) => runGitProcess(args.includes('fetch') ? writer.args : args, options, f.environment))
    const started = await Promise.race([writer.started(), running.then(() => {
      throw new Error('Fetch ended before its writer started.')
    })])
    await started.write()
    for (const path of agentFiles) await writeFile(path, 'agent', { flag: 'wx' })
    const before = await Promise.all(agentFiles.map(path => stat(path)))
    controller.abort()
    await expect(running).resolves.toMatchObject({ code: 1 })
    await expect(readFile(join(f.common, `${destinationRef}.lock`))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const [index, path] of agentFiles.entries()) {
      expect(await readFile(path, 'utf8')).toBe('agent')
      expect((await stat(path)).mtimeMs).toBe(before[index]!.mtimeMs)
    }
    await expect(runGitWithCacheStorage(f.cache, ['fetch', 'origin', f.successor],
      { cwd: f.clone, signal: AbortSignal.timeout(1500) },
      (args, options) => runGitProcess(args, options, f.environment))).rejects.toThrow()

    // The Agent finishes its writes and releases its locks before Main retries.
    for (const path of agentFiles) await rm(path)
    await expect(runGitWithCacheStorage(f.cache, ['fetch', 'origin', f.successor],
      { cwd: f.clone, signal: AbortSignal.timeout(2000) },
      (args, options) => runGitProcess(args, options, f.environment))).resolves.toMatchObject({ code: 0 })
    expect(f.git(f.clone, 'cat-file', '-t', f.successor)).toBe('commit')
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.first)
  } finally {
    controller.abort()
    await running
    writer.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each(['linked worktree', 'repository outside the cache', 'fetch without writing FETCH_HEAD'] as const)(
  'preserves the common FETCH_HEAD lock for a %s', async place => {
    const f = await fixture()
    let cwd = f.clone
    let cache = f.cache
    if (place === 'linked worktree') {
      cwd = join(f.root, 'linked')
      f.git(f.clone, 'worktree', 'add', '--detach', cwd, f.first)
    } else if (place === 'repository outside the cache') cache = join(f.root, 'other-cache')
    const writer = await interruptedFetchWriter(f.root, f.common,
      Object.fromEntries(fetchLocks.map(name => [name, 41])))
    const controller = new AbortController()
    let running: ReturnType<typeof runGitWithCacheStorage> | undefined
    try {
      running = runGitWithCacheStorage(cache, ['fetch',
        ...(place === 'fetch without writing FETCH_HEAD' ? ['--no-write-fetch-head'] : []),
        'origin', `${f.successor}:${destinationRef}`], { cwd, signal: controller.signal },
      (args, options) => runGitProcess(args.includes('fetch') ? writer.args : args, options, f.environment))
      const started = await Promise.race([writer.started(), running.then(() => {
        throw new Error('Fetch ended before its writer started.')
      })])
      await started.write()
      controller.abort()
      await expect(running).resolves.toMatchObject({ code: 1 })
      expect(await readFile(join(f.common, 'FETCH_HEAD.lock'))).toEqual(Buffer.alloc(41, 1))
      await expect(readFile(join(f.common, `${destinationRef}.lock`))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      controller.abort()
      await running
      writer.close()
      await rm(f.root, { recursive: true, force: true })
    }
  },
)

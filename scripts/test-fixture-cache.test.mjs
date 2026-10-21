import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { cachedTestFixture, cachedWorkerRelease, testFixtureCacheRoot, workerFixtureInputs } from './test-fixture-cache.mjs'

const execute = promisify(execFile)

async function fixtureCache(t) {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'test-fixture-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('setup cache persists across invocation roots and respects an explicit cache location', () => {
  assert.equal(testFixtureCacheRoot({ FOREMAN_CODE_TEST_ROOT: 'first-run' }),
    testFixtureCacheRoot({ FOREMAN_CODE_TEST_ROOT: 'second-run' }))
  assert.equal(testFixtureCacheRoot({ FOREMAN_CODE_TEST_CACHE_ROOT: 'selected-cache' }), 'selected-cache')
})

test('an incomplete release donor warns and reports why the release was rebuilt', async t => {
  const root = await fixtureCache(t)
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'packages/contracts/src'), { recursive: true })
  await writeFile(join(repository, 'packages/contracts/src/used.ts'), 'export const value = 1\n')
  const git = async args => (await execute('git', args, { cwd: repository,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })).stdout.trim()
  await git(['init', '--quiet'])
  const commit = async () => {
    await git(['add', '.'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture input'])
    return git(['rev-parse', 'HEAD'])
  }
  const build = async directory => {
    await mkdir(join(directory, 'release'))
    await writeFile(join(directory, 'release/manifest.json'), JSON.stringify({ sourceSnapshot: { files: [] } }))
  }
  const first = await cachedWorkerRelease(join(root, 'cache'), repository, await commit(), ['target'], build)
  await writeFile(join(first, 'release/manifest.json'), '{')
  await writeFile(join(repository, 'packages/contracts/src/used.ts'), 'export const value = 2\n')
  const reports = []
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    await cachedWorkerRelease(join(root, 'cache'), repository, await commit(), ['target'], build,
      { onCacheStatus: status => reports.push(status) })
  } finally {
    console.warn = original
  }
  assert.equal(reports.at(-1)?.status, 'invalid')
  assert.equal(reports.at(-1)?.lastError, 'Release donor metadata is invalid or incomplete.')
  assert.equal(reports.at(-1)?.rebuildCount, 1)
  assert.equal(reports.at(-1)?.missCount, 1)
  assert.equal(warnings.length, 1)
})

test('Worker output discovers API inputs without registration and rebuilds when their content changes', async t => {
  const root = await fixtureCache(t)
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'scripts'), { recursive: true })
  await mkdir(join(repository, 'apps/worker/src'), { recursive: true })
  await mkdir(join(repository, 'apps/api/src'), { recursive: true })
  await writeFile(join(repository, 'apps/api/src/native.ts'), 'export const native = 1\n')
  await writeFile(join(repository, 'apps/worker/src/worker.mjs'), 'export const worker = 1\n')
  await writeFile(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const git = async args => (await execute('git', args, { cwd: repository,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })).stdout.trim()
  await git(['init', '--quiet'])
  const commit = async () => {
    await git(['add', '.'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture input'])
    return git(['rev-parse', 'HEAD'])
  }
  let builds = 0
  const output = async () => cachedTestFixture(join(root, 'cache'), 'worker',
    [await workerFixtureInputs(repository, await commit())], async directory => {
      builds++
      await writeFile(join(directory, 'payload'), `build ${builds}`)
    })
  const first = await output()
  await writeFile(join(repository, 'unrelated.md'), 'Unrelated documentation\n')
  assert.equal(await output(), first)
  assert.equal(builds, 1)
  await writeFile(join(repository, 'apps/api/src/native.ts'), 'export const native = 2\n')
  const changed = await output()
  assert.notEqual(changed, first)
  assert.equal(await readFile(join(changed, 'payload'), 'utf8'), 'build 2')
  await writeFile(join(repository, 'apps/api/src/helper.ts'), 'export const helper = 1\n')
  const helper = await output()
  assert.notEqual(helper, changed)
  assert.equal(await readFile(join(helper, 'payload'), 'utf8'), 'build 3')
  await writeFile(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n')
  const dependencies = await output()
  assert.notEqual(dependencies, helper)
  assert.equal(await readFile(join(dependencies, 'payload'), 'utf8'), 'build 4')
})

test('a release is reused when only files it did not bundle changed, and rebuilt when a bundled file changes', async t => {
  const root = await fixtureCache(t)
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'scripts'), { recursive: true })
  await mkdir(join(repository, 'packages/contracts/src'), { recursive: true })
  await writeFile(join(repository, 'packages/contracts/src/used.ts'), 'export const used = 1\n')
  await writeFile(join(repository, 'packages/contracts/src/unused.ts'), 'export const unused = 1\n')
  const git = async args => (await execute('git', args, { cwd: repository,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })).stdout.trim()
  await git(['init', '--quiet'])
  const commit = async () => {
    await git(['add', '.'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture input'])
    return git(['rev-parse', 'HEAD'])
  }
  let builds = 0
  const release = async (...identity) => {
    const head = await commit()
    const entry = await cachedWorkerRelease(join(root, 'cache'), repository, head, identity, async directory => {
      builds++
      await mkdir(join(directory, 'release'))
      const blob = await git(['rev-parse', `${head}:packages/contracts/src/used.ts`])
      await writeFile(join(directory, 'release', 'manifest.json'), JSON.stringify({
        sourceSnapshot: { files: [{ path: 'packages/contracts/src/used.ts', gitBlobSha1: blob }] },
      }))
    })
    return entry
  }
  const first = await release('target', 'linux')
  await writeFile(join(repository, 'packages/contracts/src/unused.ts'), 'export const unused = 2\n')
  const reused = await release('target', 'linux')
  assert.notEqual(reused, first)
  assert.equal(builds, 1)
  assert.equal(await release('target', 'linux'), reused)
  assert.equal(builds, 1)
  await release('other-target', 'linux')
  assert.equal(builds, 2)
  await writeFile(join(repository, 'packages/contracts/src/used.ts'), 'export const used = 2\n')
  await release('target', 'linux')
  assert.equal(builds, 3)
})

test('unchanged inputs reuse complete output and changed inputs populate separately', async t => {
  const root = await fixtureCache(t)
  let builds = 0
  const populate = async directory => {
    builds++
    await writeFile(join(directory, 'payload'), `build ${builds}`)
  }
  const first = await cachedTestFixture(root, 'worker', ['commit', Buffer.from('target')], populate)
  const reused = await cachedTestFixture(root, 'worker', ['commit', Buffer.from('target')], populate)
  const changed = await cachedTestFixture(root, 'worker', ['other-commit', Buffer.from('target')], populate)
  assert.equal(first, reused)
  assert.notEqual(first, changed)
  assert.equal(builds, 2)
  assert.equal(await readFile(join(reused, 'payload'), 'utf8'), 'build 1')
  assert.equal(await readFile(join(changed, 'payload'), 'utf8'), 'build 2')
})

test('symlinked cache ancestors return canonical output and reuse the same complete entry', async t => {
  const root = await fixtureCache(t)
  const storage = join(root, 'storage')
  await mkdir(storage, { mode: 0o700 })
  const alias = join(root, 'cache')
  await symlink(storage, alias)
  let builds = 0
  const populate = async directory => {
    builds++
    await writeFile(join(directory, 'payload'), 'complete')
  }
  const first = await cachedTestFixture(alias, 'worker', ['input'], populate)
  assert.equal(first, await realpath(first))
  assert.equal(await cachedTestFixture(storage, 'worker', ['input'], populate), first)
  assert.equal(builds, 1)
  assert.equal(await readFile(join(first, 'payload'), 'utf8'), 'complete')
})

test('cache reuse refuses entries that are no longer private', async t => {
  const root = await fixtureCache(t)
  const populate = async directory => { await writeFile(join(directory, 'payload'), 'complete') }
  const entry = await cachedTestFixture(root, 'worker', ['input'], populate)
  await chmod(entry, 0o755)
  await assert.rejects(cachedTestFixture(root, 'worker', ['input'], populate), /Invalid fixture cache entry/)
})

test('failed population releases the lock without publishing partial output', async t => {
  const root = await fixtureCache(t)
  const failure = new Error('fixture build failed')
  await assert.rejects(cachedTestFixture(root, 'worker', ['input'], async directory => {
    await writeFile(join(directory, 'payload'), 'partial')
    throw failure
  }), error => error === failure)
  const complete = await cachedTestFixture(root, 'worker', ['input'], async directory => {
    await writeFile(join(directory, 'payload'), 'complete')
  })
  assert.equal(await readFile(join(complete, 'payload'), 'utf8'), 'complete')
})

function cacheProcess(t, root, options = {}) {
  const source = `
    import { appendFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { cachedTestFixture } from ${JSON.stringify(new URL('./test-fixture-cache.mjs', import.meta.url).href)};
    const root = process.argv[1];
    const released = new Promise(resolve => process.once('message', resolve));
    process.send({ kind: 'requested' });
    const directory = await cachedTestFixture(root, process.argv[2], [process.argv[3]], async directory => {
      await appendFile(join(root, 'builds'), 'build\\n');
      await writeFile(join(directory, 'partial'), 'in-progress bytes');
      process.send({ kind: 'building' });
      await released;
      await writeFile(join(directory, 'payload'), 'complete');
    });
    process.send({ kind: 'complete', directory });
    if (process.argv[4] === 'hold') await new Promise(resolve => process.once('message', resolve));
    process.disconnect();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, options.namespace ?? 'worker',
    options.input ?? 'shared-input', options.hold ? 'hold' : 'close'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const messages = []
  const waiters = new Map()
  child.on('message', message => {
    messages.push(message)
    waiters.get(message.kind)?.resolve(message)
  })
  const closed = once(child, 'close')
  child.once('close', () => {
    for (const waiter of waiters.values()) waiter.reject(new Error(`Cache process exited: ${stderr}`))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  return {
    child,
    closed,
    message(kind) {
      const found = messages.find(message => message.kind === kind)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => waiters.set(kind, { resolve, reject }))
    },
  }
}

test('independent slots build once and observe only complete output', { timeout: 30_000 }, async t => {
  const root = await fixtureCache(t)
  const first = cacheProcess(t, root)
  await first.message('building')
  const others = Array.from({ length: 3 }, () => cacheProcess(t, root))
  await Promise.all(others.map(process => process.message('requested')))
  first.child.send({ kind: 'release' })
  const processes = [first, ...others]
  const results = await Promise.all(processes.map(process => process.message('complete')))
  const exits = await Promise.all(processes.map(process => process.closed))
  assert.ok(exits.every(([code]) => code === 0))
  assert.equal(new Set(results.map(result => result.directory)).size, 1)
  assert.equal(await readFile(join(root, 'builds'), 'utf8'), 'build\n')
  assert.equal(await readFile(join(results[0].directory, 'payload'), 'utf8'), 'complete')
})

test('an interrupted builder releases its OS lock for the next slot', { timeout: 30_000 }, async t => {
  const root = await fixtureCache(t)
  const interrupted = cacheProcess(t, root)
  await interrupted.message('building')
  interrupted.child.kill('SIGKILL')
  await interrupted.closed
  const complete = await cachedTestFixture(root, 'worker', ['shared-input'], async directory => {
    await appendFile(join(root, 'builds'), 'replacement\n')
    await writeFile(join(directory, 'payload'), 'complete')
  })
  assert.equal(await readFile(join(root, 'builds'), 'utf8'), 'build\nreplacement\n')
  assert.equal(await readFile(join(complete, 'payload'), 'utf8'), 'complete')
  assert.equal((await readdir(join(root, 'worker'))).filter(name => name.includes('.pending-')).length, 0)
})

async function publishCacheEntry(t, root, input, options = {}) {
  const process = cacheProcess(t, root, { ...options, input })
  await process.message('building')
  process.child.send({ kind: 'release' })
  const { directory } = await process.message('complete')
  if (!options.hold) assert.deepEqual(await process.closed, [0, null])
  return { ...process, directory }
}

test('publishing a fixture keeps only the newest two entries of its kind', async t => {
  const root = await fixtureCache(t)
  const other = await publishCacheEntry(t, root, 'other', { namespace: 'schemas' })
  const first = await publishCacheEntry(t, root, 'first')
  await utimes(first.directory, new Date(1000), new Date(1000))
  const second = await publishCacheEntry(t, root, 'second')
  const third = await publishCacheEntry(t, root, 'third')
  await assert.rejects(stat(first.directory), { code: 'ENOENT' })
  for (const entry of [other, second, third]) {
    assert.equal(await readFile(join(entry.directory, 'payload'), 'utf8'), 'complete')
  }
  const entries = await readdir(join(root, 'worker'), { withFileTypes: true })
  assert.equal(entries.filter(entry => entry.isDirectory()).length, 2)
})

test('eviction skips a returned fixture while another process uses it and reclaims it after exit', async t => {
  const root = await fixtureCache(t)
  const first = await publishCacheEntry(t, root, 'first', { hold: true })
  await utimes(first.directory, new Date(1000), new Date(1000))
  await publishCacheEntry(t, root, 'second')
  await publishCacheEntry(t, root, 'third')
  assert.equal(await readFile(join(first.directory, 'payload'), 'utf8'), 'complete')
  first.child.send({ kind: 'finished' })
  assert.deepEqual(await first.closed, [0, null])
  await publishCacheEntry(t, root, 'fourth')
  await assert.rejects(stat(first.directory), { code: 'ENOENT' })
  const entries = await readdir(join(root, 'worker'), { withFileTypes: true })
  assert.equal(entries.filter(entry => entry.isDirectory()).length, 2)
})


test('a new builder reclaims abandoned bytes before population while preserving a live builder', async t => {
  const root = await fixtureCache(t)
  const abandoned = cacheProcess(t, root, { input: 'abandoned' })
  await abandoned.message('building')
  const [orphan] = (await readdir(join(root, 'worker'))).filter(name => name.includes('.pending-'))
  assert.equal(await readFile(join(root, 'worker', orphan, 'partial'), 'utf8'), 'in-progress bytes')
  abandoned.child.kill('SIGKILL')
  await abandoned.closed
  const active = cacheProcess(t, root, { input: 'active' })
  await active.message('building')
  await assert.rejects(stat(join(root, 'worker', orphan)), { code: 'ENOENT' })
  const [working] = (await readdir(join(root, 'worker'))).filter(name => name.includes('.pending-') && name !== orphan)
  await publishCacheEntry(t, root, 'complete')
  await assert.rejects(stat(join(root, 'worker', orphan)), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, 'worker', working, 'partial'), 'utf8'), 'in-progress bytes')
  active.child.send({ kind: 'release' })
  await active.message('complete')
  assert.deepEqual(await active.closed, [0, null])
  assert.equal((await readdir(join(root, 'worker'))).filter(name => name.includes('.pending-')).length, 0)
})

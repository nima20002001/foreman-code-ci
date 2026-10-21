import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export function testFixtureCacheRoot(environment = process.env) {
  return environment.FOREMAN_CODE_TEST_CACHE_ROOT
    ?? fileURLToPath(new URL('../apps/api/node_modules/.cache/fixtures', import.meta.url))
}

/** Git blob identities let unchanged packaging inputs survive unrelated commits. */
export async function workerFixtureInputs(repository, commit) {
  const paths = [
    'apps/api/src', 'apps/worker/src', 'apps/worker/artifacts', 'packages/contracts/src',
    'apps/web/public/graphql.svg', 'scripts/build-worker-artifact.mjs', 'scripts/worker-artifact-files.mjs',
    'scripts/quota-helper-abi.mjs', 'scripts/graphql-mcp.mjs',
    'scripts/worker-snapshot-policy.mjs', 'scripts/ci-watchdog.mjs', 'scripts/ci-progress-reporter.mjs',
    'scripts/ci-test-results.mjs', 'scripts/dense-resources.mjs',
    'scripts/verification-runner.mjs', 'scripts/verify-repository.mjs', 'scripts/verification-reports.mjs',
    'scripts/integration-process.mjs', 'scripts/integration-capabilities.mjs',
    'packages/contracts/package.json', 'apps/worker/package.json', 'package.json',
    'pnpm-workspace.yaml', 'pnpm-lock.yaml',
  ]
  const { stdout } = await execute('git', ['ls-tree', '-r', '-z', commit, '--', ...paths], {
    cwd: repository, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

async function cacheEntryExists(directory) {
  try {
    const entry = await lstat(directory)
    const owned = !process.getuid || entry.uid === process.getuid()
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
      || !owned) throw new Error('Invalid fixture cache entry')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function lockCacheEntry(handle, mode = 'exclusive', nonblocking = false) {
  // The inherited descriptor shares the lock until this parent closes it.
  return new Promise((resolve, reject) => {
    const args = [`--${mode}`, ...(nonblocking ? ['--nonblock', '--conflict-exit-code', '75'] : []), '3']
    const child = spawn('flock', args, {
      stdio: ['ignore', 'ignore', 'inherit', handle.fd],
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve(true)
      else if (nonblocking && code === 75) resolve(false)
      else reject(new Error(`Fixture cache lock failed (${code})`))
    })
  })
}

// Returned paths remain in use for the caller's process lifetime. The OS releases
// these shared locks on exit, including an interrupted test process.
const cacheLeases = new Map()
const cacheRequests = new Map()

async function removePendingEntries(parent, key) {
  for (const name of await readdir(parent)) {
    if (!name.startsWith(`${key}.pending-`)) continue
    const directory = join(parent, name)
    if (await cacheEntryExists(directory)) await rm(directory, { recursive: true, force: true })
  }
}

async function prunePendingEntries(parent) {
  const keys = new Set()
  for (const name of await readdir(parent)) {
    const pending = /^([a-f0-9]{64})\.pending-/.exec(name)
    if (pending) keys.add(pending[1])
  }
  for (const key of keys) {
    const handle = await open(join(parent, `${key}.lock`), 'a', 0o600)
    try {
      if (await lockCacheEntry(handle, 'exclusive', true)) await removePendingEntries(parent, key)
    } finally { await handle.close() }
  }
}

async function pruneFixtureEntries(parent) {
  await prunePendingEntries(parent)
  const entries = []
  for (const name of await readdir(parent)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue
    const directory = join(parent, name)
    try {
      if (await cacheEntryExists(directory)) entries.push({ name, directory, modified: (await lstat(directory)).mtimeMs })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  entries.sort((left, right) => right.modified - left.modified || right.name.localeCompare(left.name))
  for (const entry of entries.slice(2)) {
    const handle = await open(join(parent, `${entry.name}.lock`), 'a', 0o600)
    try {
      if (await lockCacheEntry(handle, 'exclusive', true) && await cacheEntryExists(entry.directory)) {
        await rm(entry.directory, { recursive: true, force: true })
      }
    } finally { await handle.close() }
  }
}

async function acquireFixture(parent, key, populate) {
  const directory = join(parent, key)
  const handle = await open(join(parent, `${key}.lock`), 'a', 0o600)
  let retained = false
  try {
    for (;;) {
      await lockCacheEntry(handle, 'shared')
      if (await cacheEntryExists(directory)) break
      if (!await lockCacheEntry(handle, 'exclusive', true)) continue
      if (!await cacheEntryExists(directory)) {
        await removePendingEntries(parent, key)
        await withTestFixtureCacheLock(parent, 'publication', () => prunePendingEntries(parent))
        const temporary = await mkdtemp(join(parent, `${key}.pending-`))
        try {
          await populate(temporary)
          await withTestFixtureCacheLock(parent, 'publication', async () => {
            await rename(temporary, directory)
            await pruneFixtureEntries(parent)
          })
        } finally {
          await rm(temporary, { recursive: true, force: true })
        }
      }
      await lockCacheEntry(handle, 'shared')
      break
    }
    cacheLeases.set(directory, handle)
    retained = true
    return directory
  } finally {
    if (!retained) await handle.close()
  }
}

/** Serializes fixture builders that also share a dependency tree. */
export async function withTestFixtureCacheLock(root, namespace, work) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const handle = await open(join(root, `${namespace}.lock`), 'a', 0o600)
  try {
    await lockCacheEntry(handle)
    return await work()
  } finally { await handle.close() }
}

/** Only immutable setup output is shared. Rename publishes a complete entry. */
export async function cachedTestFixture(root, namespace, inputs, populate) {
  const hash = createHash('sha256')
  for (const input of inputs) {
    hash.update(String(Buffer.byteLength(input)))
    hash.update(':')
    hash.update(input)
  }
  await mkdir(join(root, namespace), { recursive: true, mode: 0o700 })
  // Cache storage may have a symlinked ancestor; consumers require canonical private roots.
  const parent = await realpath(join(root, namespace))
  const key = hash.digest('hex')
  const directory = join(parent, key)
  if (cacheLeases.has(directory) && await cacheEntryExists(directory)) return directory
  const pending = cacheRequests.get(directory)
  if (pending) return pending
  const request = acquireFixture(parent, key, populate)
  cacheRequests.set(directory, request)
  try { return await request }
  finally { cacheRequests.delete(directory) }
}

/** A cached release is a donor when its recorded source snapshot is still the committed content and it was
 * built for the same target and host. Only the files the release really bundled define it. */
async function releaseDonor(parent, repository, commit, identity, status, temporary) {
  for (const name of await readdir(parent)) {
    if (name.endsWith('.lock') || name.includes('.pending-')) continue
    const directory = join(parent, name)
    const handle = await open(join(parent, `${name}.lock`), 'a', 0o600)
    try {
      await lockCacheEntry(handle, 'shared')
      if ((await readFile(join(directory, 'identity'), 'utf8')) !== identity) continue
      const { sourceSnapshot } = JSON.parse(await readFile(join(directory, 'release', 'manifest.json'), 'utf8'))
      const files = sourceSnapshot.files
      const { stdout } = await execute('git', ['ls-tree', '-r', '-z', commit, '--', ...files.map(file => file.path)], {
        cwd: repository, maxBuffer: 4 * 1024 * 1024,
      })
      const current = new Map(stdout.split('\0').filter(Boolean).map(line => {
        const [meta, path] = line.split('\t')
        return [path, meta.split(' ')[2]]
      }))
      if (files.every(file => current.get(file.path) === file.gitBlobSha1)) {
        await cp(join(directory, 'release'), join(temporary, 'release'), { recursive: true, preserveTimestamps: true })
        return true
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error
      status.status = 'invalid'
      status.lastError = 'Release donor metadata is invalid or incomplete.'
    } finally { await handle.close() }
  }
  return null
}

/** Worker release cache. The exact-input key finds a direct hit; otherwise an earlier release whose bundled
 * files are unchanged is copied under the new key instead of rebuilt, so later jobs hit directly. */
export async function cachedWorkerRelease(root, repository, commit, identityParts, build, options = {}) {
  const inputs = await workerFixtureInputs(repository, commit)
  const identity = createHash('sha256').update(JSON.stringify(identityParts.map(String))).digest('hex')
  const status = { status: 'hit', lastError: null, missCount: 0, rebuildCount: 0 }
  const directory = await cachedTestFixture(root, 'worker-artifacts', [inputs, ...identityParts.map(String)], async temporary => {
    status.status = 'miss'
    status.missCount++
    const parent = await realpath(join(root, 'worker-artifacts'))
    const donor = await releaseDonor(parent, repository, commit, identity, status, temporary)
    status.rebuildCount = donor ? 0 : 1
    options.onCacheStatus?.({ ...status })
    if (status.lastError) console.warn('Release cache unavailable', JSON.stringify(status))
    if (!donor) {
      await build(temporary)
    }
    await writeFile(join(temporary, 'identity'), identity, { mode: 0o600 })
  })
  if (status.status === 'hit') options.onCacheStatus?.({ ...status })
  return directory
}

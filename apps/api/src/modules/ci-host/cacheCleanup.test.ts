import { mkdir, mkdtemp, access, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sweepHostCiCache } from './cacheCleanup.js'
import { withHostCiRunLock } from './runnerLock.js'

it('preserves a cache held by another runner and evicts its oldest entries after the lock is released', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cache-'))
  const cache = join(root, 'cache/fixture/site')
  const oldest = join(cache, 'pnpm-store/old')
  const newest = join(cache, 'pnpm-store/new')
  await mkdir(join(cache, 'pnpm-store'), { recursive: true })
  await writeFile(oldest, 'old bytes')
  await writeFile(newest, 'new bytes')
  await utimes(oldest, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
  await utimes(newest, new Date('2026-10-03T00:00:00Z'), new Date('2026-10-03T00:00:00Z'))
  const options = { budgetBytes: 9, activeRepositories: () => new Set<string>() }
  try {
    await withHostCiRunLock(cache, async () => {
      await expect(sweepHostCiCache(root, options)).resolves.toEqual([])
    })
    await expect(sweepHostCiCache(root, options)).resolves.toEqual([oldest])
    await expect(readFile(newest, 'utf8')).resolves.toBe('new bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('evicts complete contracts snapshots and preserves lock files and cache entries within the budget', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cache-snapshot-'))
  const cache = join(root, 'cache/fixture/site')
  const snapshot = join(cache, 'contracts/snapshot')
  await mkdir(snapshot, { recursive: true })
  await mkdir(join(cache, 'locks'))
  await writeFile(join(snapshot, '.ci-cache-key'), 'key')
  await writeFile(join(snapshot, 'output'), 'built bytes')
  await writeFile(join(cache, 'locks/install.lock'), '')
  try {
    await expect(sweepHostCiCache(root, { budgetBytes: 20, activeRepositories: () => new Set<string>() }))
      .resolves.toEqual([])
    await expect(sweepHostCiCache(root, { budgetBytes: 0, activeRepositories: () => new Set<string>() }))
      .resolves.toEqual([snapshot])
    await expect(access(snapshot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(cache, 'locks/install.lock'), 'utf8')).resolves.toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function repositoryStorage() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-storage-'))
  const clone = join(root, 'git/fixture/site')
  const slot = join(root, 'slots/fixture/site/0')
  const cache = join(root, 'cache/fixture/site')
  await mkdir(join(clone, '.git/objects'), { recursive: true })
  await mkdir(join(slot, 'src/node_modules'), { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(join(clone, '.git/objects/pack'), 'git bytes')
  await writeFile(join(slot, 'src/.git'), `gitdir: ${join(clone, '.git/worktrees/slot')}\n`)
  await writeFile(join(slot, 'src/node_modules/package'), 'installed bytes')
  await writeFile(join(cache, 'recent'), 'recent cache')
  const oldest = new Date('2026-10-01T00:00:00Z')
  for (const file of [join(clone, '.git/objects/pack'), join(slot, 'src/.git'),
    join(slot, 'src/node_modules/package')]) await utimes(file, oldest, oldest)
  return { root, clone, slot, cache }
}

it('counts git objects and persistent checkouts against the cache budget and reclaims idle repository storage', async () => {
  const f = await repositoryStorage()
  try {
    const options = { budgetBytes: Buffer.byteLength('recent cache'), activeRepositories: () => new Set<string>() }
    const removed = await sweepHostCiCache(f.root, options)
    expect(removed).toContain(f.slot)
    await expect(access(join(f.clone, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(f.slot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.cache, 'recent'), 'utf8')).toBe('recent cache')
    // Repository lock waiters keep using the same inode after eviction.
    await expect(withHostCiRunLock(f.clone, async () => 'locked')).resolves.toBe('locked')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it.each(['active', 'preparing', 'running'] as const)('preserves %s repository storage under pressure', async state => {
  const f = await repositoryStorage()
  const options = { budgetBytes: 0,
    activeRepositories: () => new Set(state === 'active' ? ['fixture/site'] : []) }
  try {
    const sweep = () => sweepHostCiCache(f.root, options)
    if (state === 'preparing') await withHostCiRunLock(f.clone, sweep)
    else if (state === 'running') await withHostCiRunLock(f.cache, sweep)
    else await sweep()
    expect(await readFile(join(f.clone, '.git/objects/pack'), 'utf8')).toBe('git bytes')
    expect(await readFile(join(f.slot, 'src/node_modules/package'), 'utf8')).toBe('installed bytes')
    await sweepHostCiCache(f.root, { budgetBytes: 0, activeRepositories: () => new Set<string>() })
    await expect(access(f.slot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(f.clone, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('preserves a checkout admitted by another runner before its native cache lock is acquired', async () => {
  const f = await repositoryStorage()
  const run = join(f.root, 'runs/admitted')
  await mkdir(run, { recursive: true })
  const meta = join(run, 'meta.json')
  const options = { budgetBytes: 0, activeRepositories: () => new Set<string>() }
  try {
    await writeFile(meta, JSON.stringify({ repository: 'fixture/site', state: 'starting', slot: 0 }))
    await sweepHostCiCache(f.root, options)
    expect(await readFile(join(f.slot, 'src/node_modules/package'), 'utf8')).toBe('installed bytes')
    await writeFile(meta, JSON.stringify({ repository: 'fixture/site', state: 'passed', slot: 0 }))
    await sweepHostCiCache(f.root, options)
    await expect(access(f.slot)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it.each(['git', 'slots'] as const)('reclaims idle %s storage even without a cache directory', async kind => {
  const f = await repositoryStorage()
  await rm(f.cache, { recursive: true, force: true })
  if (kind === 'git') await rm(join(f.root, 'slots'), { recursive: true, force: true })
  else await rm(f.clone, { recursive: true, force: true })
  try {
    await sweepHostCiCache(f.root, { budgetBytes: 0, activeRepositories: () => new Set<string>() })
    await expect(access(kind === 'git' ? join(f.clone, '.git') : f.slot))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

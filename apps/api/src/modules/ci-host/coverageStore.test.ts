import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { IntegrationCoverageStore } from './coverageStore.js'
import { expandIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'

it('merges commit artifacts, keeps repositories separate and selects the newest usable ancestor', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'coverage-store-'))
  try {
    const store = new IntegrationCoverageStore(root)
    const first = 'apps/api/test/first.integration.test.ts'
    const second = 'apps/api/test/second.integration.test.ts'
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const report = { version: 1 as const, commit: a, testFiles: [first, second], coverage: { [first]: ['apps/api/src/a.ts'] } }
    await store.record('example/project', a, report)
    const commits = { isAncestor: async (_repository: string, ancestor: string) => ancestor === a || ancestor === b,
      coverageAncestors: async (_repository: string, _commit: string, candidates: string[]) =>
        [b, a].filter(commit => candidates.includes(commit)),
      testTree: async (_repository: string, commit: string) => ({
        blobs: new Map([['apps/api/src/a.ts', commit === a ? 'old' : 'changed']]),
        read: async () => '',
      }) }
    const partial = await store.selection('example/project', b, commits)
    expect(expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(partial.map!, 'base64')).toString())).coverage)
      .toEqual({ [first]: ['apps/api/src/a.ts'] })
    expect(partial.changedFiles).toEqual(['apps/api/src/a.ts'])
    await store.record('example/project', a, { ...report, coverage: { [second]: ['apps/api/src/b.ts'] } })
    const selected = await store.selection('example/project', b, commits)
    expect(expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(selected.map!, 'base64')).toString())).coverage)
      .toEqual({ [first]: ['apps/api/src/a.ts'], [second]: ['apps/api/src/b.ts'] })
    expect(selected?.changedFiles).toEqual(['apps/api/src/a.ts'])
    expect(await store.selection('example/other', b, commits)).toEqual({ changedFiles: [],
      reason: 'No integration coverage artifacts are available.' })
    await store.record('example/project', b, { ...report, commit: b,
      coverage: { [first]: ['apps/api/src/a.ts'], [second]: ['apps/api/src/b.ts'] } })
    const newest = await store.selection('example/project', 'c'.repeat(40), commits)
    expect(expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(newest.map!, 'base64')).toString())).commit).toBe(b)
    const stale = { ...commits, testTree: async (_repository: string, commit: string) => ({
      blobs: new Map([['pnpm-lock.yaml', commit]]), read: async () => '',
    }) }
    expect(await store.selection('example/project', 'c'.repeat(40), stale)).toEqual({ changedFiles: [],
      reason: 'Coverage map predates lockfile or CI infrastructure changes.' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps a repository-sized coverage map within the device limit without dropping dependencies', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'coverage-size-'))
  try {
    const store = new IntegrationCoverageStore(root)
    const commit = 'a'.repeat(40)
    const testFiles = Array.from({ length: 700 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
    const sourceFiles = Array.from({ length: 900 }, (_, index) => `apps/api/src/modules/feature-${index}/implementation.ts`)
    await store.record('example/project', commit, { version: 1, commit, testFiles,
      coverage: Object.fromEntries(testFiles.map(file => [file, sourceFiles])) })
    const commits = {
      isAncestor: async () => true,
      coverageAncestors: async () => [commit],
      testTree: async () => ({ blobs: new Map(), read: async () => '' }),
    }
    const selected = await store.selection('example/project', commit, commits)
    expect(selected?.map).toBeTypeOf('string')
    expect(selected!.map!.length).toBeLessThanOrEqual(700_000)
    const decoded = expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(selected!.map!, 'base64')).toString()))
    expect(Object.keys(decoded.coverage)).toEqual(testFiles)
    for (const file of testFiles) expect(decoded.coverage[file]).toEqual(sourceFiles)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('bounds retained ancestor candidates before loading coverage payloads', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'coverage-retention-'))
  try {
    const store = new IntegrationCoverageStore(root)
    const file = 'apps/api/test/feature.integration.test.ts'
    for (let index = 1; index <= 40; index++) {
      const commit = index.toString(16).padStart(40, '0')
      await store.record('example/project', commit, { version: 1, commit, testFiles: [file], coverage: { [file]: [] } })
    }
    let checked = 0
    const commits = {
      isAncestor: async () => { checked++; return false },
      coverageAncestors: async (_repository: string, _commit: string, candidates: string[]) => {
        checked += candidates.length
        return []
      },
      testTree: async () => { throw new Error('Unrelated maps must not load a source tree') },
    }
    const result = await store.selection('example/project', 'f'.repeat(40), commits)
    expect(result.map).toBeUndefined()
    expect(checked).toBe(32)
    expect(checked).toBeLessThanOrEqual(32)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps the newest ancestor when an older run reports a late coverage fragment', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'coverage-ancestry-'))
  try {
    const store = new IntegrationCoverageStore(root)
    const file = 'apps/api/test/feature.integration.test.ts'
    const history = ['a', 'b', 'c'].map(value => value.repeat(40))
    const [older, newer, head] = history as [string, string, string]
    const report = (commit: string) => ({ version: 1 as const, commit, testFiles: [file],
      coverage: { [file]: ['apps/api/src/feature.ts'] } })
    await store.record('example/project', older, report(older))
    await store.record('example/project', newer, report(newer))
    await store.record('example/project', older, report(older))
    const commits = {
      isAncestor: async (_repository: string, ancestor: string, commit: string) => history.indexOf(ancestor) <= history.indexOf(commit),
      coverageAncestors: async (_repository: string, _commit: string, candidates: string[]) =>
        [...history].reverse().filter(commit => candidates.includes(commit)),
      testTree: async () => ({ blobs: new Map(), read: async () => '' }),
    }
    const result = await store.selection('example/project', head, commits)
    const decoded = expandIntegrationCoverage(JSON.parse(gunzipSync(Buffer.from(result.map!, 'base64')).toString()))
    expect(decoded.commit).toBe(newer)
  } finally { await rm(root, { recursive: true, force: true }) }
})

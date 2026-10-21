import { execFile } from 'node:child_process'
import { cp, glob, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, matchesGlob, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { shellQuote } from '../src/modules/ci-host/warmSetup.js'
import { nativeStoreFixtures, nativeVersion } from './helpers/ciNativeStoreFixture.js'

const execute = promisify(execFile)
const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const fixture = nativeStoreFixtures()

it('uses provisioned pinned pnpm without an inherited npm_execpath', async () => {
  const f = await fixture('packages')
  try {
    expect(f.environment.npm_execpath).toBeUndefined()
    const result = await execute('corepack', ['pnpm', '--version'], { cwd: f.source, env: f.environment })
    expect(result.stdout.trim()).toBe('11.27.0')
  } finally {
    await f.close()
  }
})

for (const entry of ['packages', 'warm setup'] as const) {
  it(`${entry} repairs only the native package when unrelated tarballs have been evicted`, async () => {
    const f = await fixture(entry)
    try {
      await rm(f.store(entry), { recursive: true })
      await f.seedNativeStore()
      const native = join(f.source, 'node_modules/.pnpm', `@openai+codex@${nativeVersion}`)
      await rm(native, { recursive: true })
      await mkdir(join(native, 'node_modules'), { recursive: true })
      f.requests.length = 0
      f.outage()
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.requests).toEqual([])
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} provisions the store even when the installed native payload is healthy`, async () => {
    const f = await fixture(entry)
    try {
      await rm(f.store(entry), { recursive: true })
      f.downloads.length = 0
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toContain(`/codex-${nativeVersion}.tgz`)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} provisions a lockfile-pinned native payload missing from the CI store`, async () => {
    const f = await fixture(entry, 'launcher')
    try {
      await rm(join(f.source, 'node_modules/.pnpm'), { recursive: true })
      await rm(join(f.source, 'node_modules/.modules.yaml'))
      await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
      expect(f.downloads).not.toContain(`/codex-${nativeVersion}.tgz`)
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toContain(`/codex-${nativeVersion}.tgz`)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} repairs an empty virtual-store package from the provisioned store offline`, async () => {
    const f = await fixture(entry)
    try {
      const native = join(f.source, 'node_modules/.pnpm', `@openai+codex@${nativeVersion}`)
      await rm(native, { recursive: true })
      await mkdir(join(native, 'node_modules'), { recursive: true })
      const before = [...f.downloads]
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toEqual(before)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} rejects provisioning a native payload younger than the release-age floor`, async () => {
    const f = await fixture(entry, 'launcher')
    try {
      await rm(join(f.source, 'node_modules/.pnpm'), { recursive: true })
      await rm(join(f.source, 'node_modules/.modules.yaml'))
      await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
      f.recent()
      await rm(f.metadata(entry), { recursive: true, force: true })
      await expect(f.run(entry)).rejects.toMatchObject({ code: 1 })
      expect(f.downloads).not.toContain(`/codex-${nativeVersion}.tgz`)
    } finally {
      await f.close()
    }
  })
}

type CacheStep = { id: string; if?: string; uses?: string; with: { path: string } }

async function copyCache(step: CacheStep, source: string, destination: string) {
  const patterns = step.with.path.trim().split('\n').map(pattern => pattern.trim())
  const exclusions = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const included = (path: string) => !exclusions.some(pattern => matchesGlob(path, pattern)
    || matchesGlob(path, `${pattern}/**`))
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    for await (const path of glob(pattern, { cwd: source })) {
      if (!included(path)) continue
      await mkdir(dirname(join(destination, path)), { recursive: true })
      await cp(join(source, path), join(destination, path), { recursive: true, verbatimSymlinks: true,
        filter: path => included(relative(source, path)) })
    }
  }
}

function cacheStepEnabled(step: CacheStep, hits: Record<string, string>) {
  if (!step.if) return true
  const condition = /^steps\.(\w+)\.outputs\.cache-hit (!=|==) '(true|false)'$/.exec(step.if)
  if (!condition) throw new Error(`Unsupported cache condition: ${step.if}`)
  const [, id, operator, expected] = condition
  return operator === '==' ? hits[id!] === expected : hits[id!] !== expected
}

it('restores GitHub package-hit native store and publication metadata through a registry outage', async () => {
  const f = await fixture('packages')
  try {
    const workflow = parse(await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'))
    const steps = workflow.jobs.ci.steps as (CacheStep & { name?: string; run?: string; env?: Record<string, string> })[]
    const caches = steps.filter(step => ['packages', 'metadata', 'store'].includes(step.id))
    for (const step of caches) await copyCache(step, f.source, join(f.root, 'archives', step.id))
    await rm(join(f.source, 'node_modules'), { recursive: true })
    await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
    await rm(join(f.source, '.logs'), { recursive: true })
    const hits: Record<string, string> = {}
    for (const step of caches) {
      if (!cacheStepEnabled(step, hits)) continue
      await copyCache(step, join(f.root, 'archives', step.id), f.source)
      hits[step.id] = 'true'
    }
    const install = steps.find(step => step.name === 'Install from cached store')!
    const render = (value: string) => value.replace(/\$\{\{ steps\.(\w+)\.outputs\.cache-hit \}\}/g,
      (_match, id: string) => hits[id] ?? '')
    const command = render(install.run!).replace('node scripts/ci-packages.mjs',
      `${shellQuote(process.execPath)} ${shellQuote(join(scripts, 'ci-packages.mjs'))}`)
    const environment = Object.fromEntries(Object.entries(install.env ?? {}).map(([key, value]) => [key, render(value)]))
    f.requests.length = 0
    f.outage()
    await expect(execute('/bin/bash', ['-ec', command], { cwd: f.source,
      env: { ...f.environment, ...environment, BASH_ENV: '' } })).resolves.toMatchObject({ stderr: expect.any(String) })
    expect(f.requests).toEqual([])
    expect(await readFile(join(f.source, '.logs/ci-packages-restored'), 'utf8'))
      .toBe(await readFile(join(f.source, 'node_modules/.ci-packages-key'), 'utf8'))
    await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
  } finally {
    await f.close()
  }
})

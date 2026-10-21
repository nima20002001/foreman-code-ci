import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll } from 'vitest'
import { stringify } from 'yaml'
import { pnpmInstall, shellQuote } from '../../src/modules/ci-host/warmSetup.js'

const execute = promisify(execFile)
const scripts = fileURLToPath(new URL('../../../../scripts/', import.meta.url))
const platform = process.platform === 'android' ? 'linux' : process.platform
const target = `${platform}-${process.arch}`
const version = '0.154.0'
export const nativeVersion = `${version}-${target}`
const nativeName = `@openai/codex-${target}`
const triples: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
}

type Entry = 'packages' | 'warm setup'
type InstalledState = 'ready' | 'launcher'

async function resolveProvisionedPnpm(environment: NodeJS.ProcessEnv) {
  const workspace = JSON.parse(
    await readFile(new URL('../../../../package.json', import.meta.url), 'utf8'),
  ) as { packageManager: string }
  const pinned = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(workspace.packageManager)?.[1]
  if (!pinned) throw new Error('The CI fixture requires an exact pnpm packageManager pin.')
  const cacheHome = environment.COREPACK_HOME ?? join(
    environment.XDG_CACHE_HOME ?? environment.LOCALAPPDATA
      ?? join(homedir(), process.platform === 'win32' ? 'AppData/Local' : '.cache'), 'node', 'corepack')
  // CI uses Corepack versions with both the versioned and unversioned provisioned-cache layouts.
  for (const cache of [join(cacheHome, 'v1'), cacheHome]) {
    const directory = join(cache, 'pnpm', pinned)
    if (!existsSync(join(directory, '.corepack'))) continue
    const manifest = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    ) as { name: string; version: string; bin: string | Record<string, string> }
    if (manifest.name !== 'pnpm' || manifest.version !== pinned) {
      throw new Error('The provisioned pnpm package does not match the repository pin.')
    }
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.pnpm
    if (!bin) throw new Error('The provisioned pnpm package has no executable.')
    const executable = join(directory, bin)
    if (!existsSync(executable)) throw new Error('The provisioned pnpm executable is missing.')
    return executable
  }
  throw new Error(`The pinned pnpm ${pinned} is not provisioned in the Corepack cache.`)
}

async function preparePackageManager() {
  const environment: NodeJS.ProcessEnv = { ...process.env, COREPACK_ENABLE_NETWORK: '0' }
  delete environment.npm_execpath
  const pnpm = await resolveProvisionedPnpm(environment)
  const base = join(homedir(), '.cache/foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'native-store-tools-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  // Use the CI-provisioned pinned CLI; this launcher executes the real package manager without Corepack bootstrap.
  await writeFile(join(bin, 'corepack'), '#!/bin/sh\n[ "$1" = pnpm ] || exit 2\nshift\n'
    + `exec ${shellQuote(process.execPath)} ${shellQuote(pnpm)} "$@"\n`, { mode: 0o755 })
  const prepared = { ...environment, PATH: `${bin}:${environment.PATH ?? ''}`,
    NODE_COMPILE_CACHE: join(root, 'node-compile-cache') }
  const result = await execute(process.execPath, [pnpm, '--version'], { env: prepared })
  if (result.stdout.trim() !== '11.27.0') throw new Error('The CI fixture requires the provisioned pnpm 11.27.0 CLI.')
  return { root, environment: prepared }
}

async function createFixture(environment: NodeJS.ProcessEnv) {
  const base = join(homedir(), '.cache/foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'native-store-'))
  const source = join(root, 'source')
  const downloads: string[] = []
  const requests: string[] = []
  const archives = new Map<string, Buffer>()
  let published = '2020-01-01T00:00:00.000Z'
  let unavailable = false
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '')
    requests.push(url)
    if (unavailable) {
      response.setHeader('Connection', 'close')
      response.writeHead(403)
      response.end('Registry unavailable')
      return
    }
    const tarball = url.slice(url.lastIndexOf('/'))
    if (archives.has(tarball)) {
      downloads.push(tarball)
      response.end(archives.get(tarball))
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ name: '@openai/codex', 'dist-tags': { latest: version },
      time: { [version]: '2020-01-01T00:00:00.000Z', [nativeVersion]: published },
      versions: Object.fromEntries([version, nativeVersion].map(value => [value, {
        name: '@openai/codex', version: value,
        dist: { tarball: `${registry}/codex-${value}.tgz`, integrity: integrity(value) },
        ...(value === version ? { bin: { codex: 'bin/codex.js' },
          optionalDependencies: { [nativeName]: `npm:@openai/codex@${nativeVersion}` } } : {}),
      }])) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Registry did not bind a TCP port.')
  const registry = `http://127.0.0.1:${address.port}`
  const integrity = (value: string) => 'sha512-' + createHash('sha512')
    .update(archives.get(`/codex-${value}.tgz`)!).digest('base64')
  for (const value of [version, nativeVersion]) {
    const directory = join(root, value, 'package')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@openai/codex', version: value,
      ...(value === version ? { bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [nativeName]: `npm:@openai/codex@${nativeVersion}` } } : {}),
    }))
    const executable = value === version ? 'bin/codex.js' : `vendor/${triples[target]}/bin/codex`
    await mkdir(dirname(join(directory, executable)), { recursive: true })
    await writeFile(join(directory, executable), '#!/usr/bin/env node\nconsole.log("native fixture")\n', { mode: 0o755 })
    const archive = join(root, `codex-${value}.tgz`)
    await execute('tar', ['-czf', archive, '-C', dirname(directory), 'package'])
    archives.set(`/codex-${value}.tgz`, await readFile(archive))
  }
  await mkdir(join(source, 'apps/api'), { recursive: true })
  await mkdir(join(source, 'scripts'))
  for (const script of ['ci-native-payloads.mjs', 'ci-package-paths.mjs']) {
    await symlink(join(scripts, script), join(source, 'scripts', script))
  }
  await writeFile(join(source, 'package.json'), '{"private":true,"packageManager":"pnpm@11.27.0"}')
  await writeFile(join(source, 'apps/api/package.json'), JSON.stringify({ dependencies: { '@openai/codex': version } }))
  await writeFile(join(source, '.npmrc'), `registry=${registry}/\n@openai:registry=${registry}/\n`)
  await writeFile(join(source, 'pnpm-workspace.yaml'), stringify({ packages: ['apps/*'],
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false }))
  await writeFile(join(source, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { '.': {}, 'apps/api': { dependencies: { '@openai/codex': { specifier: version, version } } } },
    packages: Object.fromEntries([version, nativeVersion].map(value => [`@openai/codex@${value}`, {
      resolution: { integrity: integrity(value) }, ...(value === version ? { hasBin: true } : {}),
    }])),
    snapshots: { [`@openai/codex@${version}`]: {
      optionalDependencies: { [nativeName]: `@openai/codex@${nativeVersion}` },
    }, [`@openai/codex@${nativeVersion}`]: { optional: true } },
  }))
  const cache = join(root, 'cache')
  const metadata = (entry: string) => entry === 'packages' ? join(source, '.logs/pnpm-metadata')
    : join(cache, 'pnpm-metadata')
  const store = (entry: string) => entry === 'packages' ? join(source, 'node_modules/.pnpm-store')
    : join(cache, 'pnpm-store')
  const seedNativeStore = async (entry: string) => {
    const staging = join(root, 'native-only')
    await mkdir(staging)
    const reference = `@openai/codex@${nativeVersion}`
    const specifier = `npm:${reference}`
    await writeFile(join(staging, 'package.json'), JSON.stringify({ private: true,
      packageManager: 'pnpm@11.27.0', dependencies: { [nativeName]: specifier } }))
    await writeFile(join(staging, '.npmrc'), await readFile(join(source, '.npmrc')))
    await writeFile(join(staging, 'pnpm-workspace.yaml'), stringify({ minimumReleaseAge: 2880,
      minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false }))
    await writeFile(join(staging, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0',
      settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
      importers: { '.': { dependencies: { [nativeName]: { specifier, version: reference } } } },
      packages: { [reference]: { resolution: { integrity: integrity(nativeVersion) } } },
      snapshots: { [reference]: {} },
    }))
    await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', store(entry),
      '--cache-dir', metadata(entry)], { cwd: staging, env: environment })
  }
  const run = async (entry: string) => {
    if (entry === 'packages') return execute(process.execPath, [join(scripts, 'ci-packages.mjs'), 'install', source], {
      cwd: source, env: { ...environment, CI_PNPM_STORE_CACHE_HIT: 'true' },
    })
    const shell = ['finish() { exit "$1"; }', ...await pnpmInstall(source, cache, join(root, 'message'))].join('\n')
    return execute('/bin/bash', ['-ec', shell], { cwd: source, env: { ...environment, BASH_ENV: '' } })
  }
  return { root, source, downloads, requests, run, metadata, store, seedNativeStore, environment,
    outage: () => { unavailable = true }, recent: () => { published = new Date().toISOString() },
    resetRegistry: () => {
      published = '2020-01-01T00:00:00.000Z'
      unavailable = false
      downloads.length = 0
      requests.length = 0
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}


type PreparedFixture = Awaited<ReturnType<typeof createFixture>>

async function copyWorkingTree(source: string, destination: string) {
  for (const directory of ['source', 'cache']) {
    const path = join(source, directory)
    if (existsSync(path)) {
      await cp(path, join(destination, directory), { recursive: true, verbatimSymlinks: true })
    }
  }
}

async function clearWorkingTree(fixture: PreparedFixture) {
  await rm(fixture.source, { recursive: true, force: true })
  await rm(join(fixture.root, 'cache'), { recursive: true, force: true })
}

export function nativeStoreFixtures() {
  let tools: Awaited<ReturnType<typeof preparePackageManager>>
  const prepared = new Map<Entry, PreparedFixture>()
  beforeAll(async () => { tools = await preparePackageManager() }, 20_000)
  for (const entry of ['packages', 'warm setup'] as const) {
    beforeAll(async () => {
      const fixture = await createFixture(tools.environment)
      prepared.set(entry, fixture)
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', fixture.store(entry),
        '--cache-dir', fixture.metadata(entry)], { cwd: fixture.source, env: tools.environment })
      await fixture.run(entry)
      await copyWorkingTree(fixture.root, join(fixture.root, 'snapshots/ready'))
    }, 20_000)
    beforeAll(async () => {
      const fixture = prepared.get(entry)!
      await rm(join(fixture.source, 'node_modules'), { recursive: true })
      await rm(join(fixture.source, 'apps/api/node_modules'), { recursive: true })
      await rm(join(fixture.source, '.logs'), { recursive: true, force: true })
      await rm(join(fixture.root, 'cache'), { recursive: true, force: true })
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--no-optional',
        '--store-dir', fixture.store(entry), '--cache-dir', fixture.metadata(entry)],
      { cwd: fixture.source, env: tools.environment })
      await copyWorkingTree(fixture.root, join(fixture.root, 'snapshots/launcher'))
    }, 20_000)
    beforeAll(async () => {
      const fixture = prepared.get(entry)!
      await rm(fixture.store(entry), { recursive: true })
      await fixture.seedNativeStore(entry)
      await cp(fixture.store(entry), join(fixture.root, 'snapshots/native-store'), { recursive: true })
    }, 20_000)
  }
  afterAll(async () => {
    for (const fixture of prepared.values()) await fixture.close()
    if (tools) await rm(tools.root, { recursive: true, force: true })
  })
  return async (entry: Entry, state: InstalledState = 'ready') => {
    const fixture = prepared.get(entry)!
    await clearWorkingTree(fixture)
    await copyWorkingTree(join(fixture.root, 'snapshots', state), fixture.root)
    fixture.resetRegistry()
    return { ...fixture,
      seedNativeStore: () => cp(join(fixture.root, 'snapshots/native-store'), fixture.store(entry), { recursive: true }),
      close: () => clearWorkingTree(fixture),
    }
  }
}

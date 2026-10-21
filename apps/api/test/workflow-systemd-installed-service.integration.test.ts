import { beforeAll, describe, expect, it, vi } from 'vitest'
import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { deployProductionApi } from '../../../scripts/local-production-runtime.mjs'
import { installedRestartService } from './helpers/installedRestartService.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { useInstalledRestartFixture } from './helpers/installedRestartFixture.js'
import { lockedPackageTarballs, type PackagingLockfile } from './helpers/lockedPackageTarballs.js'

describe('installed Main-local workflows across systemd restart', () => {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const readBuildIdentity = () => fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
    headers: { authorization: `Bearer ${fixture!.writer.token}` },
  })

  const installedFixture = useInstalledRestartFixture()
  beforeAll(() => { fixture = installedFixture() })

  it('starts an installed API on a fresh user service setup', async () => {
    expect(await fixture!.mainService!.state()).toBe('active')
    const pid = await fixture!.mainService!.pid()
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).not.toThrow()
    const health = await fetch(new URL('/health/live', fixture!.origin()))
    expect(health.status).toBe(200)
  })

  it('rejects an invalid credential when reading the packaged build identity', async () => {
    const response = await fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
      headers: { authorization: 'Bearer invalid-fixture-credential' },
    })
    expect(response.status).toBe(401)
  })

  it('serves its packaged build identity without requiring a source checkout', async () => {
    const response = await readBuildIdentity()
    expect(response.status).toBe(200)
    const identity = RuntimeBuildIdentitySchema.parse(await response.json())
    expect(identity).toEqual(createRuntimeBuildIdentity(repository))
  })
})

describe('installed API fixture packaging', () => {
  it.each([
    { age: 'old', modified: '2000-01-01T00:00:00.000Z', publication: undefined, succeeds: true },
    { age: 'recent', modified: new Date().toISOString(), publication: undefined, succeeds: true },
    { age: 'unknown', modified: undefined, publication: undefined, succeeds: true },
    { age: 'too young', modified: new Date().toISOString(), publication: new Date().toISOString(), succeeds: false },
    { age: 'old with an empty store', modified: '2000-01-01T00:00:00.000Z', publication: undefined,
      succeeds: true, emptyStore: true },
  ])('deploys locked packages with $age abbreviated metadata without bypassing release age', async ({
    age, modified, publication, succeeds, emptyStore,
  }) => {
    const directory = await privateFixtureDirectory('locked-packaging-')
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
      storeDir: string
    }
    const lockfile: PackagingLockfile = parse(await readFile(join(repository, 'pnpm-lock.yaml'), 'utf8'))
    const dependency = lockfile.importers['apps/api']!.dependencies.yaml!
    const cache = join(directory, 'metadata')
    const destination = join(directory, 'deployed')
    await mkdir(join(directory, 'scripts'), { recursive: true })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'scripts/require-pnpm.mjs']) {
      await copyFile(join(repository, name), join(directory, name))
    }
    await cp(join(repository, 'patches'), join(directory, 'patches'), { recursive: true })
    for (const name of ['api', 'web', 'worker']) {
      await mkdir(join(directory, 'apps', name), { recursive: true })
      await copyFile(join(repository, 'apps', name, 'package.json'), join(directory, 'apps', name, 'package.json'))
    }
    await cp(join(repository, 'packages/contracts'), join(directory, 'packages/contracts'), {
      recursive: true, filter: path => path !== join(repository, 'packages/contracts/node_modules'),
    })
    const workspace = parse(await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8')) as {
      patchedDependencies: Record<string, string>
    }
    const tarballs = await lockedPackageTarballs({
      lockfile, repository, directory: join(directory, 'tarballs'),
      patches: Object.fromEntries(Object.entries(workspace.patchedDependencies).map(([key, path]) =>
        [key, join(repository, path)])),
    })
    await writeFile(join(directory, 'pnpm-lock.yaml'), stringify(lockfile))
    // Each registry response has locked artifacts and an optional modified date, but no publication-time map.
    const packageVersions = new Map<string, Record<string, {
      name: string; version: string; dist: { integrity: string; tarball: string }
    }>>()
    for (const [key, snapshot] of Object.entries(lockfile.packages) as Array<[
      string, { resolution: { integrity: string } },
    ]>) {
      const separator = key.lastIndexOf('@')
      const name = key.slice(0, separator)
      const version = key.slice(separator + 1)
      const versions = packageVersions.get(name) ?? {}
      versions[version] = {
        name, version,
        dist: { integrity: snapshot.resolution.integrity,
          tarball: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz` },
      }
      packageVersions.set(name, versions)
    }
    let metadataRequests = 0
    let tarballRequests = 0
    const tarballPaths = new Map<string, string>()
    for (const [key, path] of tarballs) {
      const separator = key.lastIndexOf('@')
      const name = key.slice(0, separator)
      const version = key.slice(separator + 1)
      tarballPaths.set(`${name}/-/${name.split('/').at(-1)}-${version}.tgz`, path)
    }
    const registry = createServer((request, response) => {
      const name = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname.slice(1))
      if (name.endsWith('.tgz')) {
        tarballRequests++
        const archive = tarballPaths.get(name)
        if (!archive) {
          response.writeHead(404).end(`Fixture tarball is unavailable: ${name}`)
          return
        }
        response.setHeader('content-type', 'application/octet-stream')
        const stream = createReadStream(archive)
        stream.on('error', error => response.destroy(error))
        stream.pipe(response)
        return
      }
      const versions = packageVersions.get(name)
      if (!versions) {
        response.writeHead(404).end()
        return
      }
      metadataRequests++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        name, modified, versions,
        time: Object.fromEntries(Object.keys(versions).map(version =>
          [version, publication ?? '2000-01-01T00:00:00.000Z'])),
      }))
    })
    await new Promise<void>((resolve, reject) => {
      registry.once('error', reject)
      registry.listen(0, '127.0.0.1', resolve)
    })
    const address = registry.address() as { port: number }
    const registryUrl = `http://127.0.0.1:${address.port}/`
    const metadata = join(cache, `v11/metadata/http%3A+127.0.0.1+${address.port}`)
    try {
      for (const [name, versions] of packageVersions) {
        for (const artifact of Object.values(versions)) {
          artifact.dist.tarball = new URL(new URL(artifact.dist.tarball).pathname.slice(1), registryUrl).href
        }
        const metadataPath = join(metadata, `${name}.jsonl`)
        await mkdir(dirname(metadataPath), { recursive: true })
        await writeFile(metadataPath, `${JSON.stringify({ modified })}\n${JSON.stringify({
          name, modified, versions,
        })}`)
      }
      const execute = promisify(execFile)
      const deploy = deployProductionApi(async (command, args) => {
        // This disposable workspace needs no post-deploy installation restoration.
        if (args.includes('install')) return
        // This disposable copy needs no inode isolation, and hardlinking the store keeps each case fast.
        await execute(command, [...args, '--package-import-method', 'hardlink', '--prefer-offline',
          '--store-dir', emptyStore ? join(directory, 'store') : storeDir,
          '--cache-dir', cache, '--registry', registryUrl, '--fetch-retries', '0'], {
          cwd: directory, env: { ...process.env, CI: 'true' }, timeout: 300_000,
        })
      }, destination)
      if (!succeeds) {
        await expect(deploy).rejects.toMatchObject({
          stdout: expect.stringMatching(/minimumReleaseAge/),
        })
        return
      }
      await deploy
      if (emptyStore) expect(tarballRequests).toBeGreaterThan(0)
      if (age !== 'old') {
        expect(metadataRequests).toBeGreaterThan(0)
      }
      const deployedRequire = createRequire(join(destination, 'package.json'))
      expect(deployedRequire('yaml').parse('installed: true')).toEqual({ installed: true })
      expect(deployedRequire('yaml/package.json').version).toBe(dependency.version)
      const contractsFile = join(destination, 'node_modules/@foreman-code/contracts/dist/index.js')
      const { RuntimeBuildIdentitySchema: deployedSchema } = await import(pathToFileURL(contractsFile).href)
      expect(deployedSchema.safeParse(createRuntimeBuildIdentity(repository)).success).toBe(true)
      expect(deployedSchema.safeParse({}).success).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 360_000)

  it('prefers cached packages and allows missing metadata using the installation store and cache', async () => {
    const directory = await privateFixtureDirectory('installed-packaging-')
    const bin = join(directory, 'bin')
    const calls = join(directory, 'calls.json')
    const repository = fileURLToPath(new URL('../../../', import.meta.url))
    const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
      storeDir: string
    }
    await mkdir(bin)
    await writeFile(join(bin, 'corepack'), `#!${process.execPath}
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)))
console.error('Fixture package store is intentionally empty')
process.exit(1)
`, { mode: 0o700 })
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`)
    vi.stubEnv('npm_config_cache_dir', join(directory, 'metadata'))
    // A separate cache forces deployment even when another installed fixture is already warm.
    vi.stubEnv('FOREMAN_CODE_TEST_CACHE_ROOT', join(directory, 'cache'))
    try {
      await expect(installedRestartService(directory, join(directory, 'config.json'), {}, join(directory, 'runtime')))
        .rejects.toThrow('Fixture package store is intentionally empty')
      const args = JSON.parse(await readFile(calls, 'utf8')) as string[]
      expect(args).toContain('--prefer-offline')
      expect(args).not.toContain('--offline')
      expect(args[args.indexOf('--store-dir') + 1]).toBe(storeDir)
      expect(args[args.indexOf('--cache-dir') + 1]).toBe(join(directory, 'metadata'))
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

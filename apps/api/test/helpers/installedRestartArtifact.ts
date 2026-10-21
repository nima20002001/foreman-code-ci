import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse } from 'yaml'
import { deployProductionApi, pruneApiDependencies } from '../../../../scripts/local-production-runtime.mjs'
import { copyApiRuntime } from '../../../../scripts/copy-api-runtime.mjs'
import { cachedTestFixture, testFixtureCacheRoot, withTestFixtureCacheLock } from '../../../../scripts/test-fixture-cache.mjs'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { measureIntegrationPhase } from './integrationPhase.js'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const serviceUser = userInfo()
const dependencyCacheNamespace = 'installed-api-restart-dependencies'
const workerRequire = createRequire(new URL('../../../worker/package.json', import.meta.url))
const compiler = workerRequire('esbuild') as {
  version: string
  build(options: {
    entryPoints: string[]
    outdir?: string
    outfile?: string
    outbase?: string
    bundle?: boolean
    packages?: 'external'
    plugins?: Array<{
      name: string
      setup(builder: {
        onResolve(options: { filter: RegExp },
          callback: (args: { path: string }) => { path: string; external: boolean }): void
      }): void
    }>
    platform: 'node'
    format: 'esm'
    target: string
    logLevel: 'silent'
  }): Promise<unknown>
}

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) files.push(path)
  }
  return files
}

async function artifactInputs() {
  const inputs: (string | Buffer)[] = [
    process.platform, process.arch, process.version, compiler.version,
    JSON.stringify(createRuntimeBuildIdentity(repository)),
  ]
  const files = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'apps/api/package.json', 'apps/web/package.json', 'apps/worker/package.json',
    'apps/api/test/helpers/testPool.mjs', 'apps/api/test/fixtures/remote-review-main.mjs',
    'apps/api/test/helpers/installedRestartArtifact.ts', 'apps/api/test/helpers/installedRestartService.ts',
    'node_modules/.modules.yaml',
  ]
  // The installer reads an optional workspace policy file when constructing its dependency cache.
  if (existsSync(join(repository, '.npmrc'))) files.push('.npmrc')
  for (const path of files) inputs.push(path, await readFile(join(repository, path)))
  async function append(directory: string) {
    const entries = await readdir(join(repository, directory), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules') continue
      const child = join(directory, entry.name)
      if (entry.isDirectory()) await append(child)
      else inputs.push(child, await readFile(join(repository, child)))
    }
  }
  for (const path of ['scripts', 'patches', 'apps/api/src', 'apps/worker/src',
    'apps/worker/artifacts/ci-runtime', 'packages/contracts']) {
    await append(path)
  }
  return inputs
}

async function buildArtifact(directory: string) {
  const release = join(directory, 'release')
  const api = join(release, 'apps/api')
  await mkdir(dirname(api), { recursive: true, mode: 0o700 })
  await cp(join(repository, 'scripts'), join(release, 'scripts'), { recursive: true })
  await cp(join(repository, 'packages/contracts/src'), join(release, 'packages/contracts/src'), { recursive: true })
  // Package from a disposable workspace so fixture setup cannot change the installed source.
  const deployment = join(directory, 'deployment-source')
  await mkdir(join(deployment, 'scripts'), { recursive: true, mode: 0o700 })
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await copyFile(join(repository, name), join(deployment, name))
  }
  await cp(join(repository, 'patches'), join(deployment, 'patches'), { recursive: true })
  await copyFile(join(repository, 'scripts/require-pnpm.mjs'), join(deployment, 'scripts/require-pnpm.mjs'))
  for (const name of ['api', 'web', 'worker']) {
    await mkdir(join(deployment, 'apps', name), { recursive: true })
    await copyFile(join(repository, 'apps', name, 'package.json'), join(deployment, 'apps', name, 'package.json'))
  }
  await cp(join(repository, 'packages/contracts'), join(deployment, 'packages/contracts'), {
    recursive: true, filter: path => path !== join(repository, 'packages/contracts/node_modules'),
  })
  // The installer's shared dependency tree is deployed once per lockfile, not copied again for every fixture.
  // The installed API's own modules are transformed below.
  await mkdir(join(deployment, 'apps/api/dist'), { recursive: true })
  const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
    storeDir: string
  }
  const ciMetadataCache = join(repository, '.logs/pnpm-metadata')
  // Test homes are private; use the host or cloud install's cache for release-age verification.
  const metadataCache = process.env.npm_config_cache_dir
    || (existsSync(ciMetadataCache) ? ciMetadataCache : join(serviceUser.homedir, '.cache/pnpm'))
  const deploy = async (command: string, args: string[]) => {
    // The disposable deployment workspace is discarded, so it needs no dependency restoration.
    if (args.includes('install')) return
    try {
      // Deploy rechecks release age; allow missing full metadata while reusing installed packages.
      await execute(command, [...args, '--prefer-offline', '--store-dir', storeDir, '--cache-dir', metadataCache], {
        cwd: deployment, maxBuffer: 4 * 1024 * 1024, timeout: 300_000,
        env: { ...process.env, CI: 'true' },
      })
    } catch (error) {
      const output = error as Error & { stdout?: string; stderr?: string; code?: unknown; signal?: unknown }
      throw new Error(`Installed API fixture deployment failed (prefer-offline; 300 s command limit): ${output.message}`
        + ` (code ${output.code}, signal ${output.signal})\n`
        + `${output.stderr ?? ''}\n${output.stdout ?? ''}`, { cause: error })
    }
  }
  await measureIntegrationPhase('Installed API dependencies', () => deployProductionApi(deploy, api, {
    dependencies: { root: join(testFixtureCacheRoot(), dependencyCacheNamespace), source: deployment },
  }))
  await mkdir(join(api, 'test/helpers'), { recursive: true })
  await copyFile(join(repository, 'apps/api/test/helpers/testPool.mjs'), join(api, 'test/helpers/testPool.mjs'))
  const source = join(repository, 'apps/api/src')
  await cp(source, join(api, 'dist'), { recursive: true, filter: path => !path.endsWith('.ts') })
  // Transform the installed modules together without rebuilding a compiler program for each file.
  await compiler.build({
    entryPoints: await sources(source),
    outdir: join(api, 'dist'),
    outbase: source,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
  })
  await copyApiRuntime(repository, join(api, 'dist'))
  await writeFile(join(api, 'dist/runtime-build.json'),
    `${JSON.stringify(createRuntimeBuildIdentity(repository))}\n`, { mode: 0o600 })
  await cp(join(repository, 'apps/worker/src'), join(release, 'apps/worker/src'), { recursive: true })
  await copyFile(join(repository, 'package.json'), join(release, 'package.json'))
  await compiler.build({
    entryPoints: [fileURLToPath(new URL('../fixtures/remote-review-main.mjs', import.meta.url))],
    outfile: join(api, 'dist/restart-fixture.js'),
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'es2022',
    logLevel: 'silent',
    plugins: [{
      name: 'installed-api-imports',
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/\.\.\/src\/.*\.ts$/ }, ({ path }) => ({
          path: path.replace('../../src/', './').replace(/\.ts$/, '.js'),
          external: true,
        }))
      },
    }],
  })
  await rm(join(directory, 'deployment-source'), { recursive: true, force: true })
}

/** Cache only immutable packaging output; each service receives its own release copy. */
export async function installedRestartArtifact() {
  const root = testFixtureCacheRoot()
  return withTestFixtureCacheLock(root, 'installed-api-restart', async () => {
    const inputs = await measureIntegrationPhase('installed restart artifact inputs', artifactInputs)
    const cached = await measureIntegrationPhase('installed restart artifact', () => cachedTestFixture(
      root, 'installed-api-restart', inputs, buildArtifact,
    ))
    const parent = join(root, 'installed-api-restart')
    const entries = await readdir(parent, { withFileTypes: true })
    const releases = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map(entry => join(parent, entry.name, 'release'))
    // A retained release's module symlinks still depend on its shared tree.
    await pruneApiDependencies(join(root, dependencyCacheNamespace), releases)
    return join(cached, 'release')
  })
}

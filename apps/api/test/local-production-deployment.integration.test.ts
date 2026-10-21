import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { compileApiFixture } from './helpers/compiledApiFixture.js'
import { createLocalProductionProject } from './helpers/localProductionProject.js'

const fixtureRoot = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')

it('keeps source development commands usable after successful and failed production deployment', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { deployProductionApi } = await import(script)
  const execute = promisify(execFile)
  await mkdir(fixtureRoot, { recursive: true })
  const directory = await mkdtemp(join(fixtureRoot, 'production-deployment-'))
  const source = join(directory, 'workspace')
  const dependencies = { root: join(directory, 'api-dependencies'), source }
  const api = join(source, 'apps/api')
  const contracts = join(source, 'packages/contracts')
  const destination = join(directory, 'deployed')
  // The repository install already populated the store; registry retries add no deployment coverage.
  const environment: NodeJS.ProcessEnv = { ...process.env, npm_config_offline: 'true' }
  delete environment.CI
  delete environment.NODE_ENV
  const run = (command: string, args: string[]) => execute(command, args, {
    cwd: source, env: environment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  const verifyDevelopment = async () => {
    const { stdout } = await run('corepack', ['pnpm', 'run', 'verify-development'])
    expect(stdout).toContain('development dependency available')
  }
  try {
    await mkdir(join(api, 'dist'), { recursive: true })
    await mkdir(join(contracts, 'dist'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'production-deployment-fixture', private: true, version: '1.0.0',
      packageManager: 'pnpm@11.27.0',
      devDependencies: { '@types/node': '26.5.1' },
      scripts: { 'verify-development': 'node -e "require(\'@types/node/package.json\'); console.log(\'development dependency available\')"' },
    }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages:', '  - apps/*', '  - packages/*', 'sharedWorkspaceLockfile: true', 'autoInstallPeers: false',
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true',
      'minimumReleaseAgeIgnoreMissingTime: false', 'verifyDepsBeforeRun: install',
    ].join('\n') + '\n')
    await writeFile(join(api, 'package.json'), JSON.stringify({
      name: '@foreman-code/api', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: { '@foreman-code/contracts': 'workspace:*' },
    }))
    await writeFile(join(contracts, 'package.json'), JSON.stringify({ name: '@foreman-code/contracts',
      private: true, version: '1.0.0', type: 'module', main: 'dist/index.js', files: ['dist'] }))
    await writeFile(join(contracts, 'dist/index.js'), 'export const contractValue = () => "production API available"\n')
    await writeFile(join(api, 'dist/index.js'),
      'import { contractValue } from "@foreman-code/contracts"; export const deployed = () => contractValue()\n')
    const require = createRequire(new URL('../../worker/package.json', import.meta.url))
    const { parse } = require('yaml') as { parse: (text: string) => Record<string, unknown> }
    const lock = parse(await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8'))
    // This minimal workspace has no patched dependencies.
    delete lock.patchedDependencies
    // Offline installation verifies every locked package against the release-age policy, so keep only the
    // development dependency and its own dependency that this minimal workspace installs.
    const kept = new Set(['@types/node@26.5.1', 'undici-types@8.9.0'])
    for (const section of ['packages', 'snapshots'] as const) {
      lock[section] = Object.fromEntries(Object.entries(lock[section] as Record<string, unknown>)
        .filter(([name]) => kept.has(name)))
    }
    await writeFile(join(source, 'pnpm-lock.yaml'), JSON.stringify({ ...lock, importers: {
      '.': { devDependencies: { '@types/node': { specifier: '26.5.1', version: '26.5.1' } } },
      'apps/api': { dependencies: {
        '@foreman-code/contracts': { specifier: 'workspace:*', version: 'link:../../packages/contracts' },
      } },
      'packages/contracts': {},
    } }))
    await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
    await verifyDevelopment()
    await deployProductionApi(run, destination, { dependencies })
    const deployed = await import(pathToFileURL(join(destination, 'dist/index.js')).href)
    expect(deployed.deployed()).toBe('production API available')
    await writeFile(join(contracts, 'dist/index.js'), 'export const contractValue = () => "rebuilt contracts"\n')
    await writeFile(join(api, 'dist/index.js'), 'export const deployed = () => "rebuilt source API"\n')
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      'const module = await import(process.argv[1]); console.log(module.deployed());',
      pathToFileURL(join(destination, 'dist/index.js')).href])
    expect(stdout.trim()).toBe('production API available')
    await verifyDevelopment()
    const blockedDestination = join(directory, 'occupied')
    await writeFile(blockedDestination, 'occupied')
    await expect(deployProductionApi(run, blockedDestination, { dependencies })).rejects.toThrow()
    await verifyDevelopment()
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)


it('loads the compiled API using only its deployed production dependencies', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { deployProductionApi, copyVerificationRuntime } = await import(script)
  const execute = promisify(execFile)
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  await mkdir(fixtureRoot, { recursive: true })
  const directory = await mkdtemp(join(fixtureRoot, 'production-runtime-dependencies-'))
  const source = join(directory, 'workspace')
  const dependencies = { root: join(directory, 'api-dependencies'), source }
  const release = join(directory, 'release')
  const destination = join(release, 'apps/api')
  // Test homes are private and pnpm 11 ignores npm_config_* settings, so a dependency-cache miss would download
  // every production package into an empty store. Reuse the repository install's store and metadata like the
  // installed restart fixture; hard links keep the miss from copying ~800 MB out of that store.
  const { storeDir } = parse(await readFile(join(repository, 'node_modules/.modules.yaml'), 'utf8')) as {
    storeDir: string
  }
  const ciMetadataCache = join(repository, '.logs/pnpm-metadata')
  const metadataCache = process.env.npm_config_cache_dir
    || (existsSync(ciMetadataCache) ? ciMetadataCache : join(userInfo().homedir, '.cache/pnpm'))
  const packageStore = ['--prefer-offline', '--store-dir', storeDir, '--cache-dir', metadataCache,
    '--package-import-method=hardlink']
  // Every child process is killed after a bounded time and reports the fixture step it was running.
  const child = async (step: string, timeoutMs: number, command: string, args: string[],
    options: { cwd: string, env: NodeJS.ProcessEnv }) => {
    try {
      return await execute(command, args, { ...options, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
    } catch (cause) {
      const failure = cause as ExecFileException
      const detail = failure.killed ? `exceeded ${timeoutMs} ms and was killed: ${failure.message}` : failure.message
      throw new Error(`Production runtime fixture step "${step}" failed: ${detail}`, { cause })
    }
  }
  const run = async (command: string, args: string[]) => {
    // This source is discarded after deployment, so it needs no development dependency restoration.
    if (args.includes('install')) return
    await child(`${command} ${args.join(' ')}`, 45_000, command, [...args, ...packageStore],
      { cwd: source, env: process.env })
  }
  try {
    const prepareSource = async () => {
      await mkdir(join(source, 'scripts'), { recursive: true })
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
        await cp(join(repository, name), join(source, name))
      }
      await cp(join(repository, 'patches'), join(source, 'patches'), { recursive: true })
      await cp(join(repository, 'scripts/require-pnpm.mjs'), join(source, 'scripts/require-pnpm.mjs'))
      for (const project of ['apps/api', 'packages/contracts']) {
        await mkdir(join(source, project), { recursive: true })
        await cp(join(repository, project, 'package.json'), join(source, project, 'package.json'))
      }
      await cp(join(repository, 'packages/contracts/dist'), join(source, 'packages/contracts/dist'), { recursive: true })
    }
    const setup = [compileApiFixture(directory), prepareSource()] as const
    let compiledApi: string
    try {
      const [output] = await Promise.all(setup)
      compiledApi = output
    } catch (error) {
      // Both tasks own fixture files until they settle, including on failure.
      await Promise.allSettled(setup)
      throw error
    }
    await cp(compiledApi, join(source, 'apps/api/dist'), { recursive: true })
    await deployProductionApi(run, destination, { dependencies })
    await copyVerificationRuntime(repository, release)
    await mkdir(join(release, 'apps/worker/src'), { recursive: true })
    for (const name of ['service.mjs', 'diagnostics.mjs', 'harnessPath.mjs']) {
      await cp(join(repository, 'apps/worker/src', name), join(release, 'apps/worker/src', name))
    }
    await mkdir(join(release, 'packages/contracts/src'), { recursive: true })
    await cp(join(repository, 'packages/contracts/src/productEnvironment.mjs'),
      join(release, 'packages/contracts/src/productEnvironment.mjs'))
    const { stdout } = await child('load the deployed production API', 30_000, process.execPath, ['--input-type=module', '-e',
      'const api = await import(process.argv[1]); console.log(typeof api.buildProductionApp);',
      pathToFileURL(join(destination, 'dist/production.js')).href], { cwd: destination, env: process.env })
    expect(stdout.trim()).toBe('function')
    const project = join(directory, 'ci-project')
    const context = join(directory, 'ci-context')
    const { commit: captured, environment: gitEnvironment } = await createLocalProductionProject(project)
    const { stdout: runtimeOutput } = await child('build the CI runtime context', 30_000, process.execPath, ['--input-type=module', '-e', [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const runtime = await import(process.argv[1]);',
      'const repository = process.argv[2];',
      'const output = process.argv[3];',
      'const commit = process.argv[4];',
      'const digest = await runtime.ciRuntimeInputDigest({ repository, commit });',
      'const receipt = await runtime.buildCiRuntimeContext({ repository, commit, output });',
      'const verification = await import(pathToFileURL(join(output, "verification/verification-runner.mjs")).href);',
      'console.log(JSON.stringify({ digest, sourceCommit: receipt.sourceCommit,',
      'finalizeVerification: typeof verification.finalizeVerification,',
      'lock: runtime.parseCiLock(await readFile(join(output, "source-lock/pnpm-lock.yaml"), "utf8")),',
      'containerfile: (await readFile(join(output, "Containerfile"), "utf8")).length,',
      'verification: (await readFile(join(output, "verification/verify-repository.mjs"), "utf8")).length }));',
    ].join('\n'), pathToFileURL(join(destination, 'dist/modules/jobs/ciRuntimeContext.mjs')).href,
    project, context, captured], { cwd: destination, env: gitEnvironment })
    const runtimeResult = JSON.parse(runtimeOutput) as {
      digest: string; sourceCommit: string; lock: unknown; containerfile: number; verification: number
      finalizeVerification: string
    }
    expect(runtimeResult.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(runtimeResult.sourceCommit).toBe(captured)
    expect(runtimeResult.lock).toEqual({ lockfileVersion: 9, packages: {} })
    expect(runtimeResult.containerfile).toBeGreaterThan(0)
    expect(runtimeResult.verification).toBeGreaterThan(0)
    expect(runtimeResult.finalizeVerification).toBe('function')
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)

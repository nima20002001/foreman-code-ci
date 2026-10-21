import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestRoot, removeTestRoot } from '../../../scripts/test-resources.mjs'
import { installedRestartService } from './helpers/installedRestartService.js'

const fixture = vi.hoisted(() => ({
  build: vi.fn(), deploy: vi.fn(), prune: vi.fn(), lockfile: 'locked dependencies', cacheRoot: '',
}))
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (location: string | URL) => {
      const require = actual.createRequire(location)
      return Object.assign((name: string) => name === 'esbuild'
        ? { build: fixture.build, version: 'fixture-compiler' } : require(name), require)
    },
  }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    readdir: vi.fn(async (...args: Parameters<typeof actual.readdir>) => {
      if (fixture.cacheRoot && String(args[0]).startsWith(fixture.cacheRoot)) return actual.readdir(...args)
      return []
    }),
    readFile: vi.fn(async (path: string) => {
      if (String(path).endsWith('.modules.yaml')) return 'storeDir: /fixture-package-store\n'
      if (String(path).endsWith('pnpm-lock.yaml')) return fixture.lockfile
      return 'fixture input'
    }),
  }
})
vi.mock('../../../scripts/copy-api-runtime.mjs', () => ({ copyApiRuntime: vi.fn() }))
vi.mock('../../../scripts/local-production-runtime.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../scripts/local-production-runtime.mjs')>(),
  deployProductionApi: fixture.deploy,
  pruneApiDependencies: fixture.prune,
  apiServiceTemplate: () => '[Service]\nExecStart=apps/api/dist/server.js\n',
  publish: async () => { throw new Error('Stopped before publishing fixture service') },
}))
vi.mock('../../../scripts/test-restart-units.mjs', () => ({ removeRestartUnit: vi.fn() }))

describe('installed restart artifact reuse', () => {
  let root: ReturnType<typeof createTestRoot>

  beforeEach(async () => {
    const parent = join(homedir(), '.cache/foreman-tmp')
    await mkdir(parent, { recursive: true })
    root = createTestRoot(parent, 'restart-cache-')
    vi.stubEnv('FOREMAN_CODE_TEST_ROOT', root.directory)
    vi.stubEnv('FOREMAN_CODE_TEST_OWNER', root.token)
    fixture.cacheRoot = join(root.directory, 'cache')
    vi.stubEnv('FOREMAN_CODE_TEST_CACHE_ROOT', fixture.cacheRoot)
    fixture.lockfile = 'locked dependencies'
    fixture.deploy.mockReset()
    fixture.prune.mockReset()
    fixture.build.mockReset()
    fixture.build.mockImplementation(async (options: { outdir?: string; outfile?: string }) => {
      const output = options.outfile ?? join(options.outdir!, 'compiled.js')
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, 'compiled fixture', { mode: 0o700 })
      if (options.outdir) await symlink('compiled.js', join(options.outdir, 'compiled-link.js'))
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    removeTestRoot(root)
  })

  async function prepare(name: string) {
    const directory = join(root.directory, name)
    await mkdir(directory)
    await expect(installedRestartService(directory, join(directory, 'config.json'), {
      FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY: join(root.directory, 'worker-artifacts'),
    }, join(directory, 'runtime'))).rejects.toThrow('Stopped before publishing fixture service')
    return join(directory, 'installed/current')
  }

  it('packages production dependencies and compiles once for repeated fixtures', async () => {
    await prepare('first')
    await prepare('second')
    expect(fixture.deploy).toHaveBeenCalledOnce()
    expect(fixture.build).toHaveBeenCalledTimes(2)
    const [, , options] = fixture.deploy.mock.calls[0]!
    expect(options.dependencies.root).toBe(join(root.directory, 'cache/installed-api-restart-dependencies'))
  })

  it('preserves dependency bytes used by an independent deployment sharing the fixture cache', async () => {
    const dependencies = join(fixture.cacheRoot, 'api-dependencies', 'a'.repeat(32), 'api')
    await mkdir(dependencies, { recursive: true })
    await writeFile(join(dependencies, 'package.json'), 'independent deployment bytes')
    const modules = join(root.directory, 'independent/node_modules')
    await mkdir(modules, { recursive: true })
    await symlink(dependencies, join(modules, 'dependency'))
    await prepare('restart')
    expect(readFileSync(join(modules, 'dependency/package.json'), 'utf8')).toBe('independent deployment bytes')
  })

  it('rebuilds after a pinned dependency input changes', async () => {
    await prepare('first')
    fixture.lockfile = 'updated dependencies'
    await prepare('second')
    expect(fixture.deploy).toHaveBeenCalledTimes(2)
    expect(fixture.build).toHaveBeenCalledTimes(4)
  })

  it('does not cache failed dependency packaging', async () => {
    fixture.deploy.mockRejectedValueOnce(new Error('fixture deployment failed'))
    const directory = join(root.directory, 'failed')
    await mkdir(directory)
    await expect(installedRestartService(directory, 'config.json', {}, 'runtime'))
      .rejects.toThrow('fixture deployment failed')
    await prepare('retry')
    expect(fixture.deploy).toHaveBeenCalledTimes(2)
    expect(fixture.build).toHaveBeenCalledTimes(2)
  })

  it('reports dependency cache maintenance failures before publishing a service', async () => {
    fixture.prune.mockRejectedValueOnce(new Error('fixture cache maintenance failed'))
    const directory = join(root.directory, 'maintenance-failure')
    await mkdir(directory)
    await expect(installedRestartService(directory, 'config.json', {}, 'runtime'))
      .rejects.toThrow('fixture cache maintenance failed')
    await prepare('retry')
    expect(fixture.deploy).toHaveBeenCalledOnce()
    expect(fixture.build).toHaveBeenCalledTimes(2)
    expect(fixture.prune).toHaveBeenCalledTimes(2)
  })

  it('copies independent releases while preserving relative links and executable modes', async () => {
    const first = await prepare('first')
    await writeFile(join(first, 'apps/api/dist/compiled.js'), 'changed fixture')
    const second = await prepare('second')
    expect(readFileSync(join(second, 'apps/api/dist/compiled.js'), 'utf8')).toBe('compiled fixture')
    expect(readFileSync(join(second, 'apps/api/dist/compiled-link.js'), 'utf8')).toBe('compiled fixture')
    expect(await readlink(join(second, 'apps/api/dist/compiled-link.js'))).toBe('compiled.js')
    expect((await stat(join(second, 'apps/api/dist/compiled.js'))).mode & 0o777).toBe(0o700)
    expect(fixture.build).toHaveBeenCalledTimes(2)
    expect(readFileSync(join(second, 'apps/api/dist/restart-fixture.js'), 'utf8')).toBe('compiled fixture')
  })
})

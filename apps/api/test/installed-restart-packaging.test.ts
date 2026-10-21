import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTestRoot, removeTestRoot } from '../../../scripts/test-resources.mjs'
import { installedRestartService } from './helpers/installedRestartService.js'

const deployment = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [Symbol.for('nodejs.util.promisify.custom')]: deployment.execute,
    }),
  }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => 'storeDir: /fixture-package-store\n'),
  }
})
vi.mock('../../../scripts/local-production-runtime.mjs', () => ({
  deployProductionApi: async (run: (command: string, args: string[]) => Promise<void>, destination: string) => {
    await run('corepack', ['pnpm', 'install', '--frozen-lockfile'])
    await run('corepack', ['pnpm', '--filter', '@foreman-code/api', 'deploy', '--prod', destination])
  },
}))

describe('installed restart dependency packaging', () => {
  let root: ReturnType<typeof createTestRoot>

  beforeEach(async () => {
    const parent = join(homedir(), '.cache/foreman-tmp')
    await mkdir(parent, { recursive: true })
    root = createTestRoot(parent, 'installed-packaging-')
    vi.stubEnv('FOREMAN_CODE_TEST_ROOT', root.directory)
    vi.stubEnv('FOREMAN_CODE_TEST_OWNER', root.token)
    vi.stubEnv('FOREMAN_CODE_TEST_CACHE_ROOT', join(root.directory, 'cache'))
    vi.stubEnv('npm_config_cache_dir', join(root.directory, 'metadata'))
    deployment.execute.mockRejectedValue(Object.assign(new Error('registry metadata unavailable'), {
      code: 1, signal: null, stdout: 'ERR_PNPM_META_FETCH_FAIL', stderr: 'registry connection failed',
    }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    deployment.execute.mockReset()
    removeTestRoot(root)
  })

  async function failedDeployment() {
    return installedRestartService(root.directory, join(root.directory, 'config.json'), {},
      join(root.directory, 'runtime'))
  }

  it('allows missing metadata fetches while reusing the installed store and cache', async () => {
    await expect(failedDeployment()).rejects.toThrow('registry metadata unavailable')
    expect(deployment.execute).toHaveBeenCalledOnce()
    const [command, args, options] = deployment.execute.mock.calls[0]!
    expect(command).toBe('corepack')
    expect(args).toEqual([
      'pnpm', '--filter', '@foreman-code/api', 'deploy', '--prod',
      join(dirname(options.cwd), 'release/apps/api'),
      '--prefer-offline', '--store-dir', '/fixture-package-store',
      '--cache-dir', join(root.directory, 'metadata'),
    ])
    expect(dirname(dirname(options.cwd))).toBe(join(root.directory, 'cache/installed-api-restart'))
    expect(options.cwd.endsWith('/deployment-source')).toBe(true)
    expect(options.env.CI).toBe('true')
  })

  it('gives metadata retrieval a five-minute command limit', async () => {
    await expect(failedDeployment()).rejects.toThrow('registry metadata unavailable')
    expect(deployment.execute.mock.calls[0]![2].timeout).toBe(300_000)
  })

  it('reports the metadata policy, time limit and registry error without retrying', async () => {
    await expect(failedDeployment()).rejects.toThrow(
      /prefer-offline; 300 s command limit.*registry metadata unavailable.*\nregistry connection failed\nERR_PNPM_META_FETCH_FAIL/,
    )
    expect(deployment.execute).toHaveBeenCalledOnce()
  })
})

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTestRoot, removeTestRoot, testAdminUrl, testEnvironment } from './test-resources.mjs'
import { readCiPackagePaths, writeCiPackagePaths } from './ci-package-paths.mjs'

for (const variable of ['PNPM_CONFIG_CACHE_DIR', 'npm_config_cache_dir', null]) {
  test(`preserves the pnpm publication metadata location across isolated test homes (${variable ?? 'XDG cache'})`, t => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = createTestRoot(base, 'package-cache-environment-')
    t.after(() => removeTestRoot(root))
    const resource = { ...root, databaseUrl: testAdminUrl }
    const originalCache = join(root.directory, 'prefetched-metadata')
    const environment = { XDG_CACHE_HOME: join(root.directory, 'original-cache') }
    if (variable) environment[variable] = originalCache
    const expected = variable ? originalCache : join(environment.XDG_CACHE_HOME, 'pnpm')
    writeCiPackagePaths(root.directory, { storeDir: join(root.directory, 'prefetched-store'), cacheDir: expected })
    const isolated = testEnvironment(environment, resource)
    assert.equal(readCiPackagePaths(root.directory, isolated).cacheDir, expected)
    assert.equal(isolated.HOME, join(root.directory, 'home'))
    assert.equal(isolated.XDG_CACHE_HOME, join(root.directory, 'home/.cache'))
    assert.equal(readCiPackagePaths(root.directory, testEnvironment(isolated, resource)).cacheDir, expected)
  })
}

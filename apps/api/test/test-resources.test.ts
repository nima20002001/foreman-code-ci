import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertTestPath, assertTestRoot, createTestRoot, removeTestRoot, requireTestServerUrl,
  completeTestResourceCleanup, registerTestResourceCleanup, testAdminUrl, testEnvironment } from '../../../scripts/test-resources.mjs'
import { removeFixtureDirectory } from './helpers/testResources.js'

describe('disposable test resources', () => {
  it('retains the validated host CI database identity in a minimal child environment', async () => {
    const runId = randomUUID()
    const adminUrl = new URL(testAdminUrl)
    adminUrl.port = '55440'
    vi.stubEnv('FOREMAN_CODE_CI_HOST_RUN_ID', runId)
    vi.stubEnv('FOREMAN_CODE_CI_TEST_ADMIN_URL', adminUrl.toString())
    vi.resetModules()
    const resources = await import('../../../scripts/test-resources.mjs')
    const resource = resources.createTestRoot()
    try {
      const databaseUrl = new URL('/graphql_test_child', resources.testAdminUrl).toString()
      const environment = resources.testEnvironment({ PATH: process.env.PATH }, {
        ...resource, name: 'graphql_test_child', databaseUrl,
      })
      expect(environment.FOREMAN_CODE_CI_TEST_ADMIN_URL).toBe(adminUrl.toString())
      expect(environment.FOREMAN_CODE_CI_HOST_RUN_ID).toBe(runId)
      vi.stubEnv('FOREMAN_CODE_CI_TEST_ADMIN_URL', environment.FOREMAN_CODE_CI_TEST_ADMIN_URL!)
      vi.stubEnv('FOREMAN_CODE_CI_HOST_RUN_ID', environment.FOREMAN_CODE_CI_HOST_RUN_ID!)
      vi.resetModules()
      const childResources = await import('../../../scripts/test-resources.mjs')
      expect(childResources.requireTestServerUrl(environment.TEST_DATABASE_URL!).port).toBe('55440')
    } finally {
      resources.removeTestRoot(resource)
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it.each(['/postgres', '/graphql_test_unit'])(
    'rejects alternate servers, credentials and socket or search-path overrides for %s', pathname => {
    const serverUrl = new URL(pathname, testAdminUrl).toString()
    expect(requireTestServerUrl(serverUrl).port).toBe(new URL(testAdminUrl).port)
    const alternatePortUrl = new URL(serverUrl)
    alternatePortUrl.port = alternatePortUrl.port === '32768' ? '32769' : '32768'
    for (const value of [
      alternatePortUrl.toString(),
      'postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      testAdminUrl.replace('127.0.0.1', 'localhost'),
      testAdminUrl.replace('graphql_test_admin', 'graphql'),
      testAdminUrl + '?host=/tmp/app-postgres',
      testAdminUrl + '?options=-c%20search_path=public',
    ]) expect(() => requireTestServerUrl(value)).toThrow('dedicated disposable')
  })

  it('requires a matching ownership marker before removing a root', async () => {
    const resource = createTestRoot()
    const file = join(resource.directory, 'retained.txt')
    await writeFile(file, 'retained')
    try {
      expect(() => removeTestRoot({ ...resource, token: 'wrong-owner' })).toThrow('ownership')
      expect(await readFile(file, 'utf8')).toBe('retained')
      assertTestRoot(resource.directory, resource.token)
    } finally { removeTestRoot(resource) }
  })

  it('retains recovery files until every registered cleanup is confirmed by its owner', async () => {
    const resource = createTestRoot()
    const first = registerTestResourceCleanup(resource, { kind: 'native-qualification' })
    const second = registerTestResourceCleanup(resource, { kind: 'suite-process-group' })
    const file = join(resource.directory, 'retained.txt')
    await writeFile(file, 'native recovery state')
    expect(() => removeTestRoot(resource)).toThrow('cleanup remains unconfirmed')
    expect(() => completeTestResourceCleanup({ ...resource, token: 'wrong-owner' }, first)).toThrow('ownership')
    completeTestResourceCleanup(resource, first)
    expect(() => removeTestRoot(resource)).toThrow('cleanup remains unconfirmed')
    expect(await readFile(file, 'utf8')).toBe('native recovery state')
    completeTestResourceCleanup(resource, second)
    removeTestRoot(resource)
  })

  it('retains ancestors until a nested invocation finishes cleanup and removes its root', async () => {
    const parent = createTestRoot()
    const home = join(parent.directory, 'home', '.cache')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const child = createTestRoot(home)
    const slot = createTestRoot(child.directory, 'slot-')
    const cleanupId = registerTestResourceCleanup(slot, { kind: 'native-acceptance' })
    const state = join(slot.directory, 'recovery.json')
    await writeFile(state, 'retained native state')
    expect(() => removeTestRoot(parent)).toThrow('cleanup remains unconfirmed')
    expect(() => removeTestRoot(child)).toThrow('cleanup remains unconfirmed')
    expect(() => removeTestRoot(slot)).toThrow('cleanup remains unconfirmed')
    expect(await readFile(state, 'utf8')).toBe('retained native state')
    completeTestResourceCleanup(slot, cleanupId)
    expect(() => removeTestRoot(parent)).toThrow('cleanup remains unconfirmed')
    expect(() => removeTestRoot(child)).toThrow('cleanup remains unconfirmed')
    removeTestRoot(slot)
    removeTestRoot(child)
    removeTestRoot(parent)
  })

  it('rejects fixture cleanup outside the owned root and through escaping symlinks', async () => {
    const outside = createTestRoot(dirname(process.env.FOREMAN_CODE_TEST_ROOT!))
    const file = join(outside.directory, 'retained.txt')
    const link = join(process.env.FOREMAN_CODE_TEST_ROOT!, 'outside-cleanup-link')
    await writeFile(file, 'retained')
    await symlink(outside.directory, link)
    try {
      await expect(removeFixtureDirectory(outside.directory)).rejects.toThrow('owned test root')
      await expect(removeFixtureDirectory(join(link, 'retained.txt'))).rejects.toThrow('escapes')
      expect(await readFile(file, 'utf8')).toBe('retained')
    } finally {
      await removeFixtureDirectory(link)
      removeTestRoot(outside)
    }
  })

  it('validates execution destinations through missing directories and rejects dangling symlinks', async () => {
    const resource = createTestRoot()
    const link = join(resource.directory, 'dangling-location')
    try {
      const destination = join(resource.directory, 'projects', 'nested', 'new-folder')
      expect(assertTestPath(resource, destination)).toBe(destination)
      await symlink('/missing-outside-test-root', link)
      expect(() => assertTestPath(resource, link)).toThrow('symlink')
      expect(() => assertTestPath(resource, join(link, 'new-folder'))).toThrow()
    } finally { removeTestRoot(resource) }
  })

  it.each(['FOREMAN_CODE_', 'GRAPHQL_'])(
    'isolates storage and harness homes and uses only explicit test authentication through %s settings', async prefix => {
    const resource = createTestRoot()
    const auth = join(resource.directory, 'test-auth.json')
    await writeFile(auth, '{"test":"credential"}', { mode: 0o600 })
    try {
      const source = { HOME: '/real/home', CODEX_HOME: '/real/codex', PGHOST: 'app',
        OPENAI_API_KEY: 'real-key',
        FOREMAN_CODE_MCP_TOKEN: 'real-token', LOG_FILE: '/real/log', WORKSPACE_STORAGE_ROOT: '/real/projects',
        FOREMAN_CODE_APP_MCP_DIRECTORY: '/real/mcp', FOREMAN_CODE_WEB_DIST: '/real/web',
        FOREMAN_CODE_PRODUCTION_DB_PASSWORD: 'real-production-password',
        FOREMAN_CODE_API_ENV_FILE: '/real/api.env',
        FOREMAN_CODE_TEST_CODEX_AUTH_FILE: auth, FOREMAN_CODE_TEST_OPENAI_API_KEY: 'test-key',
          }
      const environment = testEnvironment(Object.fromEntries(Object.entries(source).map(([key, value]) =>
        [key.replace(/^FOREMAN_CODE_/, prefix), value])),
      { ...resource, name: 'graphql_test_unit', databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() })
      for (const key of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
        'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'FILE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT', 'LOG_DIR',
        'WORKSPACE_STORAGE_ROOT', 'FOREMAN_CODE_APP_MCP_DIRECTORY']) {
        expect(environment[key]).toMatch(resource.directory + '/')
      }
      expect((await stat(join(environment.HOME!, '.local/share/graphql/mcp/launcher.mjs'))).size).toBeGreaterThan(0)
      expect(environment.PGHOST).toBeUndefined()
      expect(environment.FOREMAN_CODE_MCP_TOKEN).toBeUndefined()
      expect(environment.LOG_FILE).toBeUndefined()
      expect(environment.FOREMAN_CODE_WEB_DIST).toBeUndefined()
      expect(environment.FOREMAN_CODE_PRODUCTION_DB_PASSWORD).toBeUndefined()
      expect(await readFile(environment.FOREMAN_CODE_API_ENV_FILE!, 'utf8')).toBe('')
      expect(environment.TMPDIR).toBe(join(resource.directory, 'tmp'))
      expect(environment.FILE_STORAGE_ROOT!.startsWith(environment.TMPDIR! + '/')).toBe(false)
      expect(environment.OPENAI_API_KEY).toBe('test-key')
      const nested = testEnvironment(environment, { ...resource, name: 'graphql_test_unit',
        databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() })
      expect(nested.OPENAI_API_KEY).toBe('test-key')
      expect(await readFile(join(environment.CODEX_HOME!, 'auth.json'), 'utf8')).toBe('{"test":"credential"}')
      await writeFile(auth, '{"test":"renewed-credential"}')
      expect(await readFile(join(environment.CODEX_HOME!, 'auth.json'), 'utf8')).toBe('{"test":"renewed-credential"}')
    } finally { removeTestRoot(resource) }
  })

  it('rejects conflicting environment aliases before configuring test paths', () => {
    const resource = createTestRoot()
    try {
      expect(() => testEnvironment({ FOREMAN_CODE_APP_MCP_DIRECTORY: '/canonical',
        GRAPHQL_APP_MCP_DIRECTORY: '/legacy' }, { ...resource, name: 'graphql_test_unit',
        databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() })).toThrow('conflicts')
    } finally { removeTestRoot(resource) }
  })

  it('rejects shared authentication files and changed authentication bindings', async () => {
    const resource = createTestRoot()
    const first = join(resource.directory, 'first-auth.json')
    const second = join(resource.directory, 'second-auth.json')
    const database = { ...resource, name: 'graphql_test_unit',
      databaseUrl: new URL('/graphql_test_unit', testAdminUrl).toString() }
    try {
      await writeFile(first, '{}', { mode: 0o644 })
      expect(() => testEnvironment({ FOREMAN_CODE_TEST_CODEX_AUTH_FILE: first }, database))
        .toThrow('private file')
      await chmod(first, 0o600)
      await writeFile(second, '{}', { mode: 0o600 })
      testEnvironment({ FOREMAN_CODE_TEST_CODEX_AUTH_FILE: first }, database)
      expect(() => testEnvironment({ FOREMAN_CODE_TEST_CODEX_AUTH_FILE: second }, database))
        .toThrow('authentication reference changed')
    } finally { removeTestRoot(resource) }
  })
})

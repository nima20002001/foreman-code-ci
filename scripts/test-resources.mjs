import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { resolveProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { createTestPool } from '../apps/api/test/helpers/testPool.mjs'
import { ciTemplateCacheDirectory } from './ci-postgres-cache.mjs'
import { currentTestProcess } from './test-resource-process.mjs'

const defaultTestAdminUrl = 'postgresql://graphql_test_admin:graphql_test_disposable_only@127.0.0.1:55439/postgres'
function hostTestAdminUrl() {
  const value = process.env.FOREMAN_CODE_CI_TEST_ADMIN_URL
  if (value === undefined) return defaultTestAdminUrl
  const url = new URL(value)
  const expected = new URL(defaultTestAdminUrl)
  if (!/^[0-9a-f-]{36}$/.test(process.env.FOREMAN_CODE_CI_HOST_RUN_ID ?? '')
    || url.protocol !== expected.protocol || url.hostname !== expected.hostname
    || url.username !== expected.username || url.password !== expected.password || url.pathname !== '/postgres'
    || !url.port || url.search || url.hash) throw new Error('Invalid host CI disposable database URL')
  return value
}
export const testAdminUrl = hostTestAdminUrl()
const hostCiRunId = process.env.FOREMAN_CODE_CI_TEST_ADMIN_URL === undefined
  ? undefined : process.env.FOREMAN_CODE_CI_HOST_RUN_ID
const serverMarker = 'graphql-disposable-test-server'
const rootMarker = '.graphql-test-owner.json'
const cleanupDirectory = '.graphql-test-cleanup'
const databaseVariables = ['DATABASE_URL', 'TEST_DATABASE_URL', 'SUBAGENT_CORE_ADMIN_DATABASE_URL',
  'HRT_F03_DATABASE_URL', 'HRT_F14_ADMIN_DATABASE_URL', 'JOB_DISPATCH_DATABASE_URL',
  'NIM2691_ADMIN_DATABASE_URL', 'ENG03_A_TEST_DATABASE_URL', 'WAVE25_TEST_DATABASE_URL']

export function requireTestServerUrl(value) {
  const url = new URL(value)
  const expected = new URL(testAdminUrl)
  if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port
    || url.username !== expected.username || url.password !== expected.password || url.search || url.hash) {
    throw new Error(`Tests require the dedicated disposable PostgreSQL server on 127.0.0.1:${expected.port}`)
  }
  return url
}

export function createTestRoot(parent, prefix = 'graphql-test-') {
  if (parent === undefined) {
    parent = join(homedir(), '.cache', 'graphql-disposable-tests')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
  parent = realpathSync(parent)
  const directory = mkdtempSync(join(parent, prefix))
  const token = randomUUID()
  const owner = findParentTestRoot(directory)
  const parentCleanup = owner && { ...owner, id: registerTestResourceCleanup(owner,
    { kind: 'child-invocation', directory, childOwner: token }) }
  writeFileSync(join(directory, rootMarker), JSON.stringify({ directory, token, parentCleanup,
    process: currentTestProcess(), databaseServer: testAdminUrl }),
    { mode: 0o600, flag: 'wx' })
  return { directory, token }
}

function findParentTestRoot(directory) {
  let ancestor = dirname(directory)
  for (;;) {
    const markerPath = join(ancestor, rootMarker)
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      assertTestRoot(ancestor, marker.token)
      return { directory: ancestor, token: marker.token }
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return undefined
    ancestor = parent
  }
}

export function assertTestRoot(directory, token) {
  if (!directory || !/^[0-9a-f-]{36}$/.test(token || '')) throw new Error('Test root ownership is required')
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== resolve(directory)
    || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new Error('Test root must be a private owned directory without symlinks')
  }
  const markerPath = join(directory, rootMarker)
  const markerStat = lstatSync(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o077) !== 0
    || markerStat.uid !== process.getuid()) throw new Error('Test root ownership marker is unsafe')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  if (marker.token !== token || marker.directory !== directory) throw new Error('Test root ownership mismatch')
}

export function removeTestRoot(resource) {
  assertTestRoot(resource.directory, resource.token)
  assertTestResourcesSettled(resource)
  const { parentCleanup } = JSON.parse(readFileSync(join(resource.directory, rootMarker), 'utf8'))
  if (parentCleanup) assertTestRoot(parentCleanup.directory, parentCleanup.token)
  makeTestDirectoriesWritable(resource.directory)
  rmSync(resource.directory, { recursive: true, force: true })
  if (parentCleanup) completeTestResourceCleanup(parentCleanup, parentCleanup.id)
}

function makeTestDirectoriesWritable(directory) {
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  if (stat.uid !== process.getuid()) throw new Error('Test directory cleanup ownership mismatch')
  chmodSync(directory, stat.mode | 0o700)
  for (const name of readdirSync(directory)) makeTestDirectoriesWritable(join(directory, name))
}

export function registerTestResourceCleanup(resource, details) {
  const directory = assertTestPath(resource, join(resource.directory, cleanupDirectory))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({ ...details, id, token: resource.token,
    process: currentTestProcess() }),
    { mode: 0o600, flag: 'wx' })
  return id
}

export function readTestResourceCleanups(resource) {
  const directory = assertTestPath(resource, join(resource.directory, cleanupDirectory))
  return (existsSync(directory) ? readdirSync(directory) : []).map(name => {
    const file = assertTestPath(resource, join(directory, name))
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Test cleanup record is unsafe')
    }
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (!/^[0-9a-f-]{36}$/.test(record.id) || name !== `${record.id}.json` || record.token !== resource.token) {
      throw new Error('Test cleanup ownership mismatch')
    }
    return record
  })
}

export async function recoverAbandonedTestRoots(admin, options = {}) {
  const { recoverAbandonedTestRoots: recover } = await import('./test-resource-recovery.mjs')
  return recover(admin, options)
}

export function completeTestResourceCleanup(resource, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid test cleanup identity')
  const file = assertTestPath(resource, join(resource.directory, cleanupDirectory, `${id}.json`))
  const record = JSON.parse(readFileSync(file, 'utf8'))
  if (record.id !== id || record.token !== resource.token) throw new Error('Test cleanup ownership mismatch')
  rmSync(file)
}

export function assertTestResourcesSettled(resource) {
  const directory = assertTestPath(resource, join(resource.directory, cleanupDirectory))
  if (existsSync(directory) && readdirSync(directory).length) {
    throw new Error(`Test cleanup remains unconfirmed; database and recovery state retained at ${resource.directory}`)
  }
}

export function assertFixtureResourcesSettled(fixtureDirectory) {
  const target = ownedTestPath(fixtureDirectory)
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }
  const directory = assertTestPath(invocation, join(invocation.directory, cleanupDirectory))
  if (!existsSync(directory)) return
  for (const name of readdirSync(directory)) {
    const file = assertTestPath(invocation, join(directory, name))
    const record = JSON.parse(readFileSync(file, 'utf8'))
    if (record.token !== invocation.token || name !== `${record.id}.json`) {
      throw new Error('Test cleanup ownership mismatch')
    }
    const paths = [record.root, record.registryDirectory]
    if (paths.some(path => typeof path === 'string' && (path === target || path.startsWith(`${target}/`)))) {
      throw new Error(`Test cleanup remains unconfirmed; database and recovery state retained at ${target}`)
    }
  }
}

export function testEnvironment(environment, resource) {
  environment = resolveProductEnvironment(environment)
  requireTestServerUrl(resource.databaseUrl)
  assertTestRoot(resource.directory, resource.token)
  const clean = { ...environment }
  if (hostCiRunId) {
    clean.FOREMAN_CODE_CI_TEST_ADMIN_URL = testAdminUrl
    clean.FOREMAN_CODE_CI_HOST_RUN_ID = hostCiRunId
  }
  for (const key of Object.keys(clean)) {
    if (/^PG/.test(key) || (!key.startsWith('FOREMAN_CODE_TEST_') && /(?:_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN)$/.test(key))
      || ['FOREMAN_CODE_MCP_TOKEN', 'LOG_FILE',
        'FOREMAN_CODE_PRODUCTION_DB_PASSWORD', 'FOREMAN_CODE_WEB_DIST', 'NODE_OPTIONS'].includes(key)) delete clean[key]
  }
  for (const key of new Set([...databaseVariables, ...Object.keys(clean).filter(key => key.endsWith('DATABASE_URL'))])) {
    clean[key] = resource.databaseUrl
  }
  const paths = {
    HOME: 'home', CODEX_HOME: 'home/.codex', CLAUDE_CONFIG_DIR: 'home/.claude',
    XDG_CONFIG_HOME: 'home/.config', XDG_DATA_HOME: 'home/.local/share',
    XDG_CACHE_HOME: 'home/.cache', XDG_STATE_HOME: 'home/.local/state', XDG_RUNTIME_DIR: 'xdg-runtime',
    FILE_STORAGE_ROOT: 'app/files',
    WORKSPACE_STORAGE_ROOT: 'app/projects', FOREMAN_CODE_APP_MCP_DIRECTORY: 'home/.local/share/graphql/mcp',
    HARNESS_WORKSPACE_ROOT: 'app/workspaces', LOG_DIR: 'logs', ENG03_A_EVIDENCE_DIR: 'evidence',
    TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp',
  }
  for (const [key, suffix] of Object.entries(paths)) {
    clean[key] = join(resource.directory, suffix)
    mkdirSync(clean[key], { recursive: true, mode: 0o700 })
  }
  const apiEnvFile = join(resource.directory, 'api.env')
  if (existsSync(apiEnvFile)) {
    const stat = lstatSync(apiEnvFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0 || readFileSync(apiEnvFile, 'utf8') !== '') {
      throw new Error('Test API environment file ownership changed')
    }
  } else writeFileSync(apiEnvFile, '', { mode: 0o600, flag: 'wx' })
  clean.FOREMAN_CODE_API_ENV_FILE = apiEnvFile
  clean.SKILLS_EVIDENCE_FILE = join(clean.ENG03_A_EVIDENCE_DIR, 'skills.jsonl')
  clean.A2_QUALIFICATION_REPORT = join(clean.ENG03_A_EVIDENCE_DIR, 'a2-native-qualification.json')
  const launcher = join(clean.HOME, '.local', 'share', 'graphql', 'mcp', 'launcher.mjs')
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 })
  copyFileSync(new URL('./graphql-mcp.mjs', import.meta.url), launcher)
  chmodSync(launcher, 0o600)
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    if (environment[`FOREMAN_CODE_TEST_${key}`]) clean[key] = environment[`FOREMAN_CODE_TEST_${key}`]
  }
  for (const [variable, destination] of [
    ['FOREMAN_CODE_TEST_CODEX_AUTH_FILE', join(clean.CODEX_HOME, 'auth.json')],
  ]) {
    if (!environment[variable]) continue
    referenceTestAuthenticationFile(resource, environment[variable], destination)
  }
  if (environment.FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE) {
    copyTestAuthenticationFile(resource, environment.FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE,
      join(clean.CLAUDE_CONFIG_DIR, '.credentials.json'))
  }
  clean.COREPACK_HOME = environment.COREPACK_HOME || join(homedir(), '.cache', 'node', 'corepack')
  clean.NODE_OPTIONS = `--import=${fileURLToPath(new URL('./test-postgres-guard.mjs', import.meta.url))}`
  if (resource.template) clean.FOREMAN_CODE_TEST_DATABASE_TEMPLATE = JSON.stringify(resource.template)
  else delete clean.FOREMAN_CODE_TEST_DATABASE_TEMPLATE
  return { ...clean, FOREMAN_CODE_TEST_ROOT: resource.directory, FOREMAN_CODE_TEST_OWNER: resource.token,
    NIM2691_POSTGRES: '1' }
}

function privateTestAuthenticationFile(filename) {
  const source = realpathSync(filename)
  const sourceStat = lstatSync(source)
  if (!sourceStat.isFile() || sourceStat.uid !== process.getuid() || (sourceStat.mode & 0o077) !== 0) {
    throw new Error('Explicit test authentication must be a private file owned by the current user')
  }
  return source
}

export function copyTestAuthenticationFile(resource, filename, destination) {
  const source = privateTestAuthenticationFile(filename)
  const target = assertTestPath(resource, destination)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    const stat = lstatSync(target)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error('Test authentication copy ownership changed')
    }
    // Provider refreshes belong to this copy and must survive repeated fixture setup.
    return
  }
  copyFileSync(source, target)
  chmodSync(target, 0o600)
}

export function referenceTestAuthenticationFile(resource, filename, destination) {
  const target = resolve(destination)
  assertTestPath(resource, dirname(target))
  const source = privateTestAuthenticationFile(filename)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (existsSync(target)) {
    const destinationStat = lstatSync(target)
    if ((destinationStat.isSymbolicLink() || source === target) && realpathSync(target) === source) return
    throw new Error('Test authentication reference changed')
  }
  symlinkSync(source, target)
}

export async function testAdminPool() {
  const pool = createTestPool({ connectionString: testAdminUrl, max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 10_000, query_timeout: 35_000,
    options: '-c statement_timeout=30000 -c lock_timeout=10000' })
  const query = pool.query.bind(pool)
  let pending = Promise.resolve()
  // Slots share one admin session. Start connection and query deadlines only when that session is available.
  pool.query = (...args) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : undefined
    const result = pending.then(() => query(...args))
    pending = result.then(() => undefined, () => undefined)
    if (!callback) return result
    result.then(value => callback(null, value), callback)
  }
  try {
    const result = await pool.query("select shobj_description(oid, 'pg_database') as marker from pg_database where datname='postgres'")
    if (result.rows[0]?.marker !== serverMarker) throw new Error('PostgreSQL test server ownership marker is missing; run pnpm db:up')
    return pool
  } catch (error) {
    await pool.end()
    throw error
  }
}

export async function createTestDatabase(admin, resource, options = {}) {
  const { template, name = `graphql_test_${randomUUID().replaceAll('-', '')}` } = options
  assertTestRoot(resource.directory, resource.token)
  if (template) {
    const { assertTestDatabaseTemplate } = await import('./test-database-template.mjs')
    await assertTestDatabaseTemplate(admin, template)
  }
  const clone = template ? ` template ${identifier(template.name)}` : ''
  await admin.query(`create database ${identifier(name)}${clone}`)
  await admin.query(`comment on database ${identifier(name)} is 'graphql-test:${resource.token}'`)
  const url = new URL(testAdminUrl)
  url.pathname = `/${name}`
  const database = { ...resource, name, databaseUrl: url.toString(), ...(template ? { template } : {}) }
  if (template) {
    const pool = createTestPool({ connectionString: database.databaseUrl, max: 1 })
    try {
      try { await pool.query('update application_installation set id=gen_random_uuid() where singleton=true') }
      finally { await pool.end() }
    } catch (error) {
      await dropTestDatabase(admin, database)
      throw error
    }
  }
  return database
}

export async function resetTestDatabase(admin, resource) {
  assertTestResourcesSettled(resource)
  await assertTestDatabase(admin, resource)
  const replacement = await createTestDatabase(admin, resource, { template: resource.template })
  try {
    await dropTestDatabase(admin, resource)
    return replacement
  } catch (error) {
    await dropTestDatabase(admin, replacement)
    throw error
  }
}

export async function assertTestDatabase(pool, resource) {
  assertTestRoot(resource.directory, resource.token)
  const url = requireTestServerUrl(resource.databaseUrl)
  const name = decodeURIComponent(url.pathname.slice(1))
  const result = await pool.query("select shobj_description(oid, 'pg_database') as marker from pg_database where datname=$1", [name])
  if (result.rows[0]?.marker !== `graphql-test:${resource.token}`) throw new Error('Disposable database ownership mismatch')
}

export async function dropTestDatabase(admin, resource, { force = true } = {}) {
  assertTestResourcesSettled(resource)
  await assertTestDatabase(admin, resource)
  const name = decodeURIComponent(requireTestServerUrl(resource.databaseUrl).pathname.slice(1))
  await admin.query(`drop database ${identifier(name)}${force ? ' with (force)' : ''}`)
}

export async function settleTestResources(admin, resource) {
  assertTestRoot(resource.directory, resource.token)
  const { sweepRestartUnits } = await import('./test-restart-units.mjs')
  await sweepRestartUnits(resource)
  const pending = readTestResourceCleanups(resource)
  if (pending.some(record => !['fixture-database', 'native-acceptance-database'].includes(record.kind))) {
    assertTestResourcesSettled(resource)
  }
  // The suite controller closes its process group before this fallback. Never force-close a database caller.
  for (const record of pending) {
    identifier(record.name)
    const database = (await admin.query(`select shobj_description(oid,'pg_database') as owner,
      (select count(*)::int from pg_stat_activity where datname=$1) as callers
      from pg_database where datname=$1`, [record.name])).rows[0]
    if (database) {
      if (database.owner !== `graphql-test:${resource.token}` || database.callers !== 0) {
        throw new Error('Fixture database cleanup ownership or closure is unconfirmed')
      }
      await admin.query(`drop database ${identifier(record.name)}`)
    }
    completeTestResourceCleanup(resource, record.id)
  }
  assertTestResourcesSettled(resource)
}

export async function cleanupTestResources(resource) {
  assertTestRoot(resource.directory, resource.token)
  const admin = await testAdminPool()
  try {
    await settleTestResources(admin, resource)
    await dropTestDatabase(admin, resource)
    removeTestRoot(resource)
  } finally { await admin.end() }
}

export async function provisionTestResources(environment = process.env) {
  environment = resolveProductEnvironment(environment)
  if (environment.FOREMAN_CODE_TEST_ROOT || environment.FOREMAN_CODE_TEST_OWNER) {
    const resource = { directory: environment.FOREMAN_CODE_TEST_ROOT, token: environment.FOREMAN_CODE_TEST_OWNER,
      databaseUrl: environment.TEST_DATABASE_URL,
      ...(environment.FOREMAN_CODE_TEST_DATABASE_TEMPLATE
        ? { template: JSON.parse(environment.FOREMAN_CODE_TEST_DATABASE_TEMPLATE) } : {}) }
    const admin = await testAdminPool()
    try {
      await assertTestDatabase(admin, resource)
      if (resource.template) {
        const { assertTestDatabaseTemplate } = await import('./test-database-template.mjs')
        await assertTestDatabaseTemplate(admin, resource.template)
      }
    } finally { await admin.end() }
    return { environment: testEnvironment(environment, resource), close: async () => {} }
  }
  const admin = await testAdminPool()
  const root = createTestRoot()
  let resource
  let template
  const dropJobTemplate = async (admin) => {
    if (!template || template.persistent) return
    const { dropTestDatabaseTemplate } = await import('./test-database-template.mjs')
    await dropTestDatabaseTemplate(admin, template)
  }
  try {
    const cacheDirectory = ciTemplateCacheDirectory(environment)
    if (cacheDirectory) {
      const { createTestDatabaseTemplate } = await import('./test-database-template.mjs')
      template = await createTestDatabaseTemplate(admin, root, { cacheDirectory })
    }
    resource = await createTestDatabase(admin, root, { template })
    const isolated = testEnvironment(environment, resource)
    await admin.end()
    return { environment: isolated, close: async () => {
      if (template && !template.persistent) {
        const cleanup = await testAdminPool()
        try { await dropJobTemplate(cleanup) }
        finally { await cleanup.end() }
      }
      await cleanupTestResources(resource)
    } }
  } catch (error) {
    if (resource) await dropTestDatabase(admin, resource)
    await dropJobTemplate(admin)
    await admin.end()
    removeTestRoot(root)
    throw error
  }
}

export function ownedTestDatabaseUrl(variable = 'TEST_DATABASE_URL', environment = process.env) {
  environment = resolveProductEnvironment(environment)
  const directory = environment.FOREMAN_CODE_TEST_ROOT
  const token = environment.FOREMAN_CODE_TEST_OWNER
  assertTestRoot(directory, token)
  const value = environment[variable]
  requireTestServerUrl(value)
  if (value !== environment.TEST_DATABASE_URL) throw new Error('Test database selector does not match its owned database')
  return value
}

function identifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid test fixture SQL identifier')
  return `"${value}"`
}

async function assertFixtureDatabase(sql) {
  ownedTestDatabaseUrl()
  const result = await sql.query("select shobj_description(oid, 'pg_database') as marker from pg_database where datname=current_database()")
  if (result.rows[0]?.marker !== `graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}`) {
    throw new Error('Fixture database ownership mismatch')
  }
}

export async function createFixtureDatabase(sql, name, options = '') {
  await assertFixtureDatabase(sql)
  if (!['', 'template template0', "template template0 encoding 'UTF8'"].includes(options)) {
    throw new Error('Invalid test database creation options')
  }
  await sql.query(`create database ${identifier(name)} ${options}`)
  await sql.query(`comment on database ${identifier(name)} is 'graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}'`)
}

export async function createMigratedFixtureDatabase(sql, name) {
  await assertFixtureDatabase(sql)
  if (!process.env.FOREMAN_CODE_TEST_DATABASE_TEMPLATE) {
    await createFixtureDatabase(sql, name, "template template0 encoding 'UTF8'")
    return
  }
  const template = JSON.parse(process.env.FOREMAN_CODE_TEST_DATABASE_TEMPLATE)
  await createTestDatabase(sql, {
    directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER,
  }, { template, name })
}

export async function dropFixtureDatabase(sql, name) {
  await assertFixtureDatabase(sql)
  const result = await sql.query("select shobj_description(oid, 'pg_database') as marker from pg_database where datname=$1", [name])
  if (result.rows[0]?.marker !== `graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}`) {
    throw new Error('Fixture database cleanup ownership mismatch')
  }
  await sql.query(`drop database ${identifier(name)}`)
  const resource = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }
  const directory = assertTestPath(resource, join(resource.directory, cleanupDirectory))
  for (const file of existsSync(directory) ? readdirSync(directory) : []) {
    const record = JSON.parse(readFileSync(assertTestPath(resource, join(directory, file)), 'utf8'))
    if (record.kind === 'fixture-database' && record.name === name) {
      completeTestResourceCleanup(resource, record.id)
    }
  }
}

export async function createFixtureSchema(sql, name) {
  await assertFixtureDatabase(sql)
  await sql.query(`create schema ${identifier(name)}`)
  await sql.query(`comment on schema ${identifier(name)} is 'graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}'`)
}

export async function dropFixtureSchema(sql, name) {
  await assertFixtureDatabase(sql)
  const result = await sql.query("select obj_description(oid, 'pg_namespace') as marker from pg_namespace where nspname=$1", [name])
  if (!result.rows.length) return
  if (result.rows[0].marker !== `graphql-test:${process.env.FOREMAN_CODE_TEST_OWNER}`) {
    throw new Error('Fixture schema cleanup ownership mismatch')
  }
  await sql.query(`drop schema ${identifier(name)} cascade`)
}

export async function removeFixtureDirectory(directory, options = { force: true }) {
  const root = process.env.FOREMAN_CODE_TEST_ROOT
  assertTestRoot(root, process.env.FOREMAN_CODE_TEST_OWNER)
  const target = resolve(directory)
  if (!target.startsWith(`${root}/`)) throw new Error('Fixture cleanup must remain inside its owned test root')
  if (!existsSync(target) && options.force) return
  // Resolve the parent to reject a directory reached through an escaping symlink.
  const parent = realpathSync(dirname(target))
  if (!parent.startsWith(`${root}/`) && parent !== root) {
    throw new Error('Fixture cleanup parent escapes its owned test root')
  }
  makeTestDirectoriesWritable(target)
  rmSync(target, { recursive: true, force: options.force })
}

export function assertTestPath(resource, path) {
  const root = resource.directory
  assertTestRoot(root, resource.token)
  if (!path || !path.startsWith('/')) throw new Error('Test path must be absolute')
  const target = resolve(path)
  if (target !== root && !target.startsWith(`${root}/`)) throw new Error('Test path must remain inside its owned root')
  let ancestor = target
  let stat
  for (;;) {
    try { stat = lstatSync(ancestor); break } catch (error) {
      if (error.code !== 'ENOENT') throw error
      ancestor = dirname(ancestor)
    }
  }
  if (ancestor === target && stat.isSymbolicLink()) throw new Error('Test path must not be a symlink')
  const canonical = realpathSync(ancestor)
  if (canonical !== root && !canonical.startsWith(`${root}/`)) {
    throw new Error('Test path escapes its owned root')
  }
  return target
}

export function ownedTestPath(path) {
  return assertTestPath({ directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }, path)
}

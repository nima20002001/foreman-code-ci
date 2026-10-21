import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertTestPath, completeTestResourceCleanup, createFixtureDatabase, createFixtureSchema,
  dropFixtureDatabase, ownedTestDatabaseUrl, ownedTestPath, registerTestResourceCleanup,
  testAdminPool, testEnvironment } from './test-resources.mjs'
import { stopGroup } from './integration-process.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const { Pool } = require('pg')

export function nativeAcceptanceEnvironment(source) {
  // Runtime-selection shims cannot reuse their home cache after diagnostics isolate HOME.
  const paths = [dirname(process.execPath), ...(source.PATH ?? '').split(delimiter)]
  return { ...source, PATH: [...new Set(paths.filter(Boolean))].join(delimiter) }
}

export function nativeAcceptanceConfiguration(environment) {
  return {
    databaseUrl: environment.ENG03_A_TEST_DATABASE_URL ?? environment.TEST_DATABASE_URL,
    evidenceRoot: environment.ENG03_A_EVIDENCE_DIR ?? join(root, '.logs', 'native-acceptance'),
  }
}

export function nativeAcceptanceFiles(arguments_) {
  if (!arguments_.length) return [
    'test/eng03-c-native.acceptance.test.ts',
    'test/local-human-native.acceptance.test.ts',
    'test/local-human-native-recovery.acceptance.test.ts',
  ]
  if (arguments_[0] !== '--files' || arguments_.length < 2) {
    throw new Error('Use --files followed by explicit API acceptance test paths.')
  }
  const files = [...new Set(arguments_.slice(1).map(file =>
    file.startsWith('apps/api/') ? file.slice('apps/api/'.length) : file))]
  for (const file of files) {
    if (!/^(?:test|src\/modules)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.acceptance\.test\.ts$/.test(file)
      || posix.normalize(file) !== file || !statSync(join(root, 'apps/api', file)).isFile()) {
      throw new Error(`Invalid acceptance test file: ${file}`)
    }
  }
  return files
}

export function nativeAcceptanceVitestArguments(files, environment) {
  const pattern = environment.ENG03_A_TEST_NAME_PATTERN
  return ['run', ...files, '--no-file-parallelism',
    ...(pattern ? ['--testNamePattern', pattern] : [])]
}

export async function archiveNativeAcceptanceEvidence(invocation, evidenceRoot, archiveRoot) {
  const source = assertTestPath(invocation, evidenceRoot)
  if (!isAbsolute(archiveRoot)) throw new Error('Native evidence archive must be absolute')
  const destination = resolve(archiveRoot)
  if (destination === invocation.directory || destination.startsWith(`${invocation.directory}/`)) {
    throw new Error('Native evidence archive must survive disposable root cleanup')
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const archiveStat = await lstat(destination)
  if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink() || await realpath(destination) !== destination
    || archiveStat.uid !== process.getuid() || (archiveStat.mode & 0o022) !== 0) {
    throw new Error('Native evidence archive must be an owned directory protected from other writers')
  }
  const target = join(destination, basename(invocation.directory))
  async function copyEvidence(from, to) {
    const path = assertTestPath(invocation, from)
    const stat = await lstat(path)
    if (stat.uid !== process.getuid() || stat.isSymbolicLink()) {
      throw new Error('Native evidence must contain only owned regular files and directories')
    }
    if (stat.isDirectory()) {
      await mkdir(to, { mode: 0o700 })
      for (const name of await readdir(path)) await copyEvidence(join(path, name), join(to, name))
    } else if (stat.isFile() && stat.nlink === 1) {
      await copyFile(path, to)
      await chmod(to, 0o600)
    } else {
      throw new Error('Native evidence must contain only owned regular files and directories')
    }
  }
  // Export the evidence subtree; provider authentication and runtime storage stay private.
  await mkdir(target, { mode: 0o700 })
  try {
    for (const name of await readdir(source)) await copyEvidence(join(source, name), join(target, name))
    return target
  } catch (error) {
    await rm(target, { recursive: true })
    throw error
  }
}

async function pendingCleanup(invocation, ownId) {
  const folder = assertTestPath(invocation, join(invocation.directory, '.graphql-test-cleanup'))
  for (const name of await readdir(folder)) {
    const record = JSON.parse(await readFile(assertTestPath(invocation, join(folder, name)), 'utf8'))
    if (record.token !== invocation.token) throw new Error('Native acceptance cleanup ownership mismatch')
    if (record.id !== ownId && record.kind !== 'suite-process-group') return true
  }
  return false
}

export async function withNativeAcceptanceDatabase(configured, evidenceRoot, execute) {
  const parentUrl = ownedTestDatabaseUrl()
  if (configured !== undefined && configured !== parentUrl) throw new Error('Native acceptance requires its owned test database')
  ownedTestPath(evidenceRoot)
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT, token: process.env.FOREMAN_CODE_TEST_OWNER }
  const admin = await testAdminPool()
  let resource
  let evidence
  let cleanupId
  const record = { name: null, created: false, exitCode: null, removed: false }
  try {
    const name = `foreman_code_native_${randomUUID().replaceAll('-', '')}_test`
    const parent = new Pool({ connectionString: parentUrl, max: 1 })
    try { await createFixtureDatabase(parent, name) } finally { await parent.end() }
    const database = new URL(parentUrl)
    database.pathname = `/${name}`
    resource = { ...invocation, name, databaseUrl: database.toString() }
    record.name = resource.name
    record.created = true
    cleanupId = registerTestResourceCleanup(invocation,
      { kind: 'native-acceptance-database', databaseUrl: resource.databaseUrl, name: resource.name })
    evidence = join(evidenceRoot, resource.name)
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    const setup = new Pool({ connectionString: resource.databaseUrl, max: 1 })
    try {
      await createFixtureSchema(setup, 'native_acceptance')
      await setup.query(`alter database "${resource.name}" set search_path to native_acceptance`)
    } finally { await setup.end() }
    const environment = testEnvironment(process.env, resource)
    record.exitCode = await execute({ databaseUrl: resource.databaseUrl, evidence, environment })
  } finally {
    try {
      if (resource) {
        const callers = await admin.query('select count(*)::int as count from pg_stat_activity where datname=$1', [resource.name])
        if (callers.rows[0].count === 0 && !await pendingCleanup(invocation, cleanupId)) {
          const parent = new Pool({ connectionString: parentUrl, max: 1 })
          try { await dropFixtureDatabase(parent, resource.name) } finally { await parent.end() }
          completeTestResourceCleanup(invocation, cleanupId)
          record.removed = true
        } else {
          console.error('Owned acceptance database and recovery state retained because cleanup is unconfirmed.')
          record.exitCode = 1
        }
      }
      if (evidence) {
        await writeFile(join(evidence, 'database.json'), JSON.stringify(record, null, 2), { mode: 0o600 })
        if (process.env.FOREMAN_CODE_TEST_EVIDENCE_ARCHIVE) {
          const archived = await archiveNativeAcceptanceEvidence(invocation, evidenceRoot,
            process.env.FOREMAN_CODE_TEST_EVIDENCE_ARCHIVE)
          console.log(`[acceptance] Native evidence archived: ${archived}`)
        }
      }
    } finally { await admin.end() }
  }
  return record
}

export function nativeAcceptanceCommand(arguments_) {
  const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  return { executable: process.execPath,
    arguments: [join(root, 'scripts/heavy-job.mjs'), '--', process.execPath, cli, ...arguments_],
    directory: join(root, 'apps/api') }
}

async function runNativeAcceptance(environment, files) {
  const invocation = { directory: environment.FOREMAN_CODE_TEST_ROOT, token: environment.FOREMAN_CODE_TEST_OWNER }
  const cleanupId = registerTestResourceCleanup(invocation,
    { kind: 'native-acceptance-process-group', wrapperPid: process.pid, databaseUrl: environment.TEST_DATABASE_URL })
  const command = nativeAcceptanceCommand([...nativeAcceptanceVitestArguments(files, environment), '--maxWorkers=12'])
  const child = spawn(command.executable, command.arguments, {
    cwd: command.directory, stdio: 'inherit', detached: true,
    env: environment,
  })
  let interrupted
  let stopping
  let cleanupError
  const stop = signal => {
    interrupted = signal
    stopping ??= stopGroup(child.pid, { signal }).catch(error => { cleanupError = error })
  }
  const interrupt = () => stop('SIGINT')
  const terminate = () => stop('SIGTERM')
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  let code
  try {
    code = await new Promise((yes, no) => {
      child.once('error', no)
      child.once('exit', (status, signal) => yes(status ?? (signal === 'SIGINT' ? 130 : 143)))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    await stopping
    await stopGroup(child.pid)
    completeTestResourceCleanup(invocation, cleanupId)
  }
  if (cleanupError) throw cleanupError
  if (interrupted === 'SIGINT') return 130
  if (interrupted) return 143
  return code
}

export async function runNativeAcceptanceCases(arguments_ = []) {
  const files = nativeAcceptanceFiles(arguments_)
  return executeNativeAcceptance(files)
}

async function executeNativeAcceptance(files) {
  const configuration = nativeAcceptanceConfiguration(process.env)
  const record = await withNativeAcceptanceDatabase(configuration.databaseUrl,
    configuration.evidenceRoot, async ({ environment: isolated, evidence }) => {
      const environment = nativeAcceptanceEnvironment(isolated)
      console.log(`[acceptance] Native evidence: ${evidence}`)
      return runNativeAcceptance({ ...environment, RUN_ENG03_C_NATIVE_TESTS: '1',
        RUN_REAL_HARNESS_TESTS: '1', NIM2691_REAL_NATIVE: '1', NIM2691_POSTGRES: '1' }, files)
    })
  return record.exitCode
}

async function main() {
  const files = nativeAcceptanceFiles(process.argv.slice(2))
  const contracts = spawnSync('corepack', ['pnpm', '--filter', '@foreman-code/contracts', 'build'], {
    cwd: root, stdio: 'inherit',
  })
  if (contracts.status !== 0) {
    process.exitCode = contracts.status ?? 1
    return
  }
  process.exitCode = await executeNativeAcceptance(files)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

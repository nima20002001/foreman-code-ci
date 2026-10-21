import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ciPostgresCacheDirectory, ciTemplateCacheMarker } from './ci-postgres-cache.mjs'

function reusePrivateDatabase(action) {
  if (action !== 'up') throw new Error('The verification runtime owns private PostgreSQL shutdown')
  if (process.env.FOREMAN_CODE_CI_TEST_DATABASE !== 'running') {
    throw new Error('The verification runtime must start its private PostgreSQL before database startup')
  }
  const result = spawnSync('/usr/lib/postgresql/17/bin/psql', [
    '-h', '127.0.0.1', '-p', '55439', '-U', 'graphql_test_admin', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-Atqc',
    "select current_setting('data_directory'), shobj_description(oid, 'pg_database')"
      + " from pg_database where datname in ('postgres', 'graphql_test_control') order by datname",
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8', PGPASSWORD: 'graphql_test_disposable_only' } })
  if (result.error) throw result.error
  const expected = '/job-scratch/postgres/data|graphql-disposable-test-server'
  if (result.status !== 0 || result.stdout.trim() !== `${expected}\n${expected}`) {
    throw new Error('Private PostgreSQL test server ownership verification failed')
  }
  process.stdout.write('Reusing the runtime-owned private PostgreSQL test server\n')
}

// --no-recreate keeps a reused server's first limits; grow them in place for a job sized for more shards.
// Limits never shrink: another job sharing the server may need what it was given. Zero means unlimited.
function growDatabaseLimits(docker, project, environment) {
  const cpus = Number(environment.FOREMAN_CODE_CI_DATABASE_CPUS ?? 0)
  const memory = Number(environment.FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES ?? 0)
  if (!(cpus > 0) && !(memory > 0)) return
  const containers = docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', 'label=com.docker.compose.service=postgres']).split('\n').filter(Boolean)
  for (const container of containers) {
    const [{ HostConfig: limits }] = JSON.parse(docker(['inspect', container]))
    const update = []
    if (cpus > 0 && limits.NanoCpus > 0 && Math.round(cpus * 1e9) > limits.NanoCpus) update.push(`--cpus=${cpus}`)
    if (memory > 0 && limits.Memory > 0 && memory > limits.Memory) {
      const swap = limits.MemorySwap > 0 ? Math.round(memory * limits.MemorySwap / limits.Memory) : -1
      update.push(`--memory=${memory}`, `--memory-swap=${swap}`)
    }
    if (!update.length) continue
    docker(['update', ...update, container])
    process.stdout.write(`[test-db] grew the shared PostgreSQL limits: ${update.join(' ')}\n`)
  }
}

function isCleanupProject(project) {
  return project.startsWith('foreman-ci-') || project.startsWith('fx-')
}

function resourceAlreadyRemoved(error) {
  return /No such (container|network|object)|network .+ not found/i.test(error.message)
}

function inspectComposeResource(docker, args) {
  try { return JSON.parse(docker(args))[0] }
  catch (error) {
    if (resourceAlreadyRemoved(error)) return undefined
    throw error
  }
}

function composeResources(docker) {
  const projects = new Map()
  function resources(project) {
    if (!projects.has(project)) projects.set(project, { containers: [], networks: [], running: false })
    return projects.get(project)
  }
  const networks = docker(['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project'])
    .split('\n').filter(Boolean)
  for (const network of networks) {
    const record = inspectComposeResource(docker, ['network', 'inspect', network])
    if (!record) continue
    const project = record.Labels?.['com.docker.compose.project']
    if (project && isCleanupProject(project) && record.Name.startsWith(`${project}_`)) {
      resources(project).networks.push(network)
    }
  }
  const containers = docker(['ps', '-aq', '--filter', 'label=com.docker.compose.project']).split('\n').filter(Boolean)
  for (const container of containers) {
    const record = inspectComposeResource(docker, ['inspect', container])
    if (!record) continue
    const project = record.Config.Labels?.['com.docker.compose.project']
    if (!project || !isCleanupProject(project)) continue
    const owned = resources(project)
    owned.containers.push(container)
    owned.running ||= record.State.Running
  }
  return projects
}

function removeComposeResources(docker, resources) {
  const errors = []
  for (const container of resources.containers) {
    try { docker(['rm', '-f', container]) }
    catch (error) { if (!resourceAlreadyRemoved(error)) errors.push(error) }
  }
  for (const network of resources.networks) {
    try { docker(['network', 'rm', network]) }
    catch (error) { if (!resourceAlreadyRemoved(error)) errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Disposable compose resource cleanup failed')
}

function hasLiveCiUnit(project, environment) {
  const result = spawnSync('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState',
    `${project}.service`], { encoding: 'utf8', env: environment, timeout: 10_000 })
  // A missing manager or ambiguous reply is not evidence that a slot is free.
  if (result.error || result.status !== 0) return true
  const state = /^ActiveState=(.+)$/m.exec(result.stdout)?.[1]
  return !['inactive', 'failed'].includes(state)
}

function cleanupOrphanProjects(docker, ownProject, isProjectLive) {
  for (const [project, resources] of composeResources(docker)) {
    if (project === ownProject || project.startsWith('foreman-ci-pg-')) continue
    if (project.startsWith('foreman-ci-') && isProjectLive(project)) continue
    // Fixture servers have no systemd slot; a running fixture can belong to another test.
    if (project.startsWith('fx-') && resources.running) continue
    removeComposeResources(docker, resources)
  }
}

function verifyDatabaseResources(docker, project) {
  const containers = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split('\n').filter(Boolean)
  let running = false
  for (const container of containers) {
    const [record] = JSON.parse(docker(['inspect', container]))
    if (record.Config.Labels['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a container without the disposable test ownership label')
    }
    if (record.Config.Labels['com.docker.compose.service'] === 'postgres' && record.State.Running) running = true
  }
  const volume = `${project}_graphql-test-data`
  if (docker(['volume', 'ls', '-q']).split('\n').includes(volume)) {
    const [record] = JSON.parse(docker(['volume', 'inspect', volume]))
    if (record.Labels?.['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Refusing to modify a volume without the disposable test ownership label')
    }
  }
  return running
}

function teardownComposeProject(docker, project, args) {
  const errors = []
  try { docker([...args, 'down', '--volumes', '--remove-orphans']) } catch (error) { errors.push(error) }
  if (isCleanupProject(project)) {
    try {
      const resources = composeResources(docker).get(project)
      if (resources) removeComposeResources(docker, resources)
    } catch (error) { errors.push(error) }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Disposable database teardown failed')
}

export function composeDatabase(action, {
  persistentCache, environment: sourceEnvironment = process.env, docker: dockerRunner,
  isProjectLive = project => hasLiveCiUnit(project, sourceEnvironment),
} = {}) {
  if (!['up', 'down', 'stop'].includes(action)) throw new Error('Usage: test-db.mjs up|down|stop')
  const runId = sourceEnvironment.FOREMAN_CODE_CI_HOST_RUN_ID
  if (runId !== undefined && !/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Invalid host CI database owner')
  const cacheKey = persistentCache && createHash('sha256').update(persistentCache).digest('hex').slice(0, 16)
  const fixtureProject = sourceEnvironment.COMPOSE_PROJECT_NAME?.startsWith('fx-')
    ? sourceEnvironment.COMPOSE_PROJECT_NAME : undefined
  let project = 'graphql-tests'
  if (runId) project = `foreman-ci-${runId}`
  if (cacheKey) project = `foreman-ci-pg-${cacheKey}`
  if (fixtureProject) project = fixtureProject
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid disposable compose project')
  const file = fileURLToPath(new URL('../compose.test.yaml', import.meta.url))
  const environment = { ...sourceEnvironment }
  for (const key of Object.keys(environment)) if (key.startsWith('COMPOSE_')) delete environment[key]
  if (runId) environment.FOREMAN_CODE_CI_DATABASE_PORT = '0'
  const docker = dockerRunner ?? function (args, input) {
    const result = spawnSync('docker', args, { encoding: 'utf8', env: environment, input })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || `docker ${args[0]} failed`)
    return result.stdout.trim()
  }
  const args = ['compose', '--project-name', project, '--file', file]
  if (action === 'up') cleanupOrphanProjects(docker, project, isProjectLive)
  const running = verifyDatabaseResources(docker, project)
  if (action === 'down' || action === 'stop' && fixtureProject) return teardownComposeProject(docker, project, args)
  try {
    // Snapshot checkouts have different bind-mount paths; replacing this shared server interrupts active tests.
    if (action === 'up') {
      const recreate = persistentCache || running ? '--no-recreate' : '--force-recreate'
      args.push('up', '-d', '--wait', recreate, 'postgres')
    }
    else if (action === 'stop') args.push('stop', 'postgres')
    process.stdout.write(`${docker(args)}\n`)
    if (action === 'up') growDatabaseLimits(docker, project, environment)
    if (action === 'up') {
      // Private checkouts are unreadable to the container user, so the idempotent init SQL goes through stdin.
      docker(['compose', '--project-name', project, '--file', file, 'exec', '-T', '-e', 'PGPASSWORD=graphql_test_disposable_only',
        'postgres', 'psql', '-h', '127.0.0.1', '-U', 'graphql_test_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
      readFileSync(fileURLToPath(new URL('./test-postgres-init.sql', import.meta.url)), 'utf8'))
    }
    if (runId && action === 'up') {
      if (!environment.TMPDIR) throw new Error('Host CI database requires its private run directory')
      const binding = docker(['compose', '--project-name', project, '--file', file, 'port', 'postgres', '5432'])
      const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1]
      if (!port) throw new Error('Host CI database has no private loopback port')
      writeFileSync(join(environment.TMPDIR, 'test-database-url'),
        `postgresql://graphql_test_admin:graphql_test_disposable_only@127.0.0.1:${port}/postgres`, { mode: 0o600 })
      if (persistentCache) {
        writeFileSync(ciTemplateCacheMarker(environment), persistentCache, { mode: 0o600 })
      }
    }
  } catch (error) {
    if (action === 'up' && isCleanupProject(project) && (!persistentCache || !running)) {
      try { teardownComposeProject(docker, project, ['compose', '--project-name', project, '--file', file]) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Database startup and cleanup failed') }
    }
    throw error
  }
}

function hostDatabase(action) {
  if (process.env.COMPOSE_PROJECT_NAME?.startsWith('fx-')) return composeDatabase(action)
  const cache = ciPostgresCacheDirectory()
  const marker = ciTemplateCacheMarker()
  if (action !== 'up' && marker && existsSync(marker)) {
    process.stdout.write('Retaining the CI PostgreSQL server; job databases are cleaned by their owners\n')
    return
  }
  if (action === 'up' && marker) rmSync(marker, { force: true })
  if (!cache || action !== 'up') return composeDatabase(action)
  try {
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    const directory = realpathSync(cache)
    if (process.env.FOREMAN_CODE_CI_POSTGRES_LOCKED === '1') return composeDatabase(action, { persistentCache: directory })
    // Different jobs can reach a cold computer together; only one starts the shared server.
    const result = spawnSync('flock', ['-w', '90', join(directory, 'startup.lock'),
      process.execPath, fileURLToPath(import.meta.url), action], {
      env: { ...process.env, FOREMAN_CODE_CI_POSTGRES_LOCKED: '1' }, encoding: 'utf8',
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr || 'Persistent PostgreSQL startup failed')
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
  } catch (error) {
    process.stderr.write(`[test-db] persistent server unavailable; using job server: ${error.message}\n`)
    composeDatabase(action)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2]
  if (!['up', 'down', 'stop'].includes(action)) throw new Error('Usage: test-db.mjs up|down|stop')
  const started = performance.now()
  if (process.env.FOREMAN_CODE_VERIFICATION_ENVIRONMENT === 'isolated-job-v1') reusePrivateDatabase(action)
  else hostDatabase(action)
  process.stdout.write(`[test-db] ${action} completed in ${Math.round(performance.now() - started)} ms\n`)
}

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertTestPath, assertTestRoot, completeTestResourceCleanup, dropTestDatabase,
  readTestResourceCleanups, removeTestRoot, requireTestServerUrl, settleTestResources,
  testAdminUrl } from './test-resources.mjs'
import { testProcessAlive, testRootInUse } from './test-resource-process.mjs'

const markerName = '.graphql-test-owner.json'
const databaseKinds = new Set(['fixture-database', 'native-acceptance-database'])
const nativeKinds = new Set(['native-qualification', 'native-acceptance'])
const processKinds = new Set(['suite-process-group', 'native-acceptance-process-group'])
let registryModule

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
  if (result.error?.code === 'ENOENT' && !existsSync('/var/run/docker.sock') && !process.env.DOCKER_HOST) return ''
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || 'Disposable container cleanup failed')
  return result.stdout.trim()
}

function readRoot(directory, expectedToken) {
  const root = lstatSync(directory)
  const markerStat = lstatSync(join(directory, markerName))
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o077) !== 0
    || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== process.getuid()
    || (markerStat.mode & 0o077) !== 0) throw new Error('Test root ownership is unsafe')
  const marker = JSON.parse(readFileSync(join(directory, markerName), 'utf8'))
  assertTestRoot(directory, expectedToken ?? marker.token)
  return { directory, token: marker.token, process: marker.process, databaseServer: marker.databaseServer }
}

function childRecord(record, resource) {
  if (record.kind === 'child-invocation' || record.kind === 'codex-wire-fixture') {
    return { directory: record.directory, token: record.childOwner ?? record.owner }
  }
  if (record.kind === 'local-acceptance' && record.stateDirectory !== resource.directory) {
    return { directory: record.stateDirectory }
  }
  return undefined
}

function requireDeadCleanupOwners(resource) {
  requireDeadOwner(resource)
  const pending = readTestResourceCleanups(resource)
  for (const record of pending) {
    if (record.process && testProcessAlive(record.process)) throw new Error('Test cleanup owner is still running')
    const child = childRecord(record, resource)
    if (!child) continue
    const directory = assertTestPath(resource, child.directory)
    if (directory === resource.directory) throw new Error('Test cleanup cannot reference itself as a child')
    if (existsSync(directory)) requireDeadCleanupOwners(readRoot(directory, child.token))
  }
  return pending
}

function requireDeadOwner(resource) {
  if (testProcessAlive(resource.process)) throw new Error('Test root owner is still running')
  if (resource.databaseServer) requireTestServerUrl(resource.databaseServer)
  if (testRootInUse(resource.directory)) throw new Error('Test root is still in use by a process')
}

function rootContainers(resource, containers) {
  const ids = containers(['ps', '-aq']).trim().split('\n').filter(Boolean)
  if (!ids.length) return []
  const inventory = JSON.parse(containers(['inspect', ...ids]))
  return inventory.filter(container => container.Mounts.some(mount => mount.Type === 'bind'
    && (mount.Source === resource.directory || mount.Source.startsWith(`${resource.directory}/`)
      || resource.directory.startsWith(`${mount.Source}/`))))
}

function removeContainers(resource, containers) {
  const inventory = rootContainers(resource, containers)
  for (const container of inventory) {
    if (!/^[a-f0-9]{64}$/.test(container.Id)
      || container.Config.Labels?.['graphql.test-owner'] !== 'disposable-tests') {
      throw new Error('Container referencing the test root has unconfirmed ownership')
    }
    if (container.State.Running) throw new Error('Test root is still in use by a container')
    if (container.Mounts.some(mount => mount.Type === 'bind'
      && resource.directory.startsWith(`${mount.Source}/`))) {
      throw new Error('Test root shares a container mount with other directories')
    }
  }
  // Removing without --force fails safely if another caller starts a container after inspection.
  for (const container of inventory) containers(['rm', '-v', container.Id])
  if (rootContainers(resource, containers).length) throw new Error('Test container cleanup remains unconfirmed')
}

async function ownedDatabases(admin, resource) {
  const owner = `graphql-test:${resource.token}`
  const result = await admin.query(`select datname as name, shobj_description(oid, 'pg_database') as owner,
    (select count(*)::int from pg_stat_activity where datid=d.oid) as callers
    from pg_database d where shobj_description(oid, 'pg_database')=$1
    or shobj_description(oid, 'pg_database') like $2`, [owner, `${owner}:template:%`])
  if (result.rows.some(database => database.callers !== 0)) throw new Error('Test database still has active callers')
  return result.rows
}

async function requireRecordedDatabaseClosed(admin, resource, record) {
  if (!record.databaseUrl && !databaseKinds.has(record.kind)) return
  const url = record.databaseUrl && requireTestServerUrl(record.databaseUrl)
  const name = record.name ?? decodeURIComponent(url.pathname.slice(1))
  if (url && decodeURIComponent(url.pathname.slice(1)) !== name) throw new Error('Test database identity mismatch')
  const result = await admin.query(`select shobj_description(oid, 'pg_database') as owner,
    (select count(*)::int from pg_stat_activity where datid=d.oid) as callers
    from pg_database d where datname=$1`, [name])
  const database = result.rows[0]
  if (database && (database.owner !== `graphql-test:${resource.token}` || database.callers !== 0)) {
    throw new Error('Recorded test database ownership or closure is unconfirmed')
  }
}

async function closeNativeRegistry(resource, record) {
  const directory = assertTestPath(resource, record.registryDirectory)
  if (!existsSync(directory)) return
  if (!registryModule) {
    const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
    const { tsImport } = await import(require.resolve('tsx/esm/api'))
    registryModule = tsImport(new URL('../apps/api/src/modules/harnesses/recovery/processRegistry.ts',
      import.meta.url).href, import.meta.url)
  }
  const { NativeProcessRegistry } = await registryModule
  const registry = new NativeProcessRegistry(directory)
  const launches = registry.snapshot().launches
  for (const launch of launches) {
    for (const identity of [launch.guardian, launch.provider].filter(Boolean)) {
      if (testProcessAlive({ ...identity, boot: launch.bootId })) {
        throw new Error('Native test process is still in use')
      }
    }
  }
  for (const owner of new Set(launches.map(launch => launch.owner))) {
    if (!await registry.closeOwner(owner)) throw new Error('Native test cleanup remains unconfirmed')
  }
}

async function recoverLinkedRoot(admin, resource, directory, token, containers) {
  const target = assertTestPath(resource, directory)
  if (target === resource.directory) throw new Error('Test cleanup cannot reference its own root as a child')
  if (!existsSync(target)) return
  await recoverRoot(admin, readRoot(target, token), containers)
}

async function settleRecord(admin, resource, record, containers) {
  if (record.process && testProcessAlive(record.process)) throw new Error('Test cleanup owner is still running')
  if (databaseKinds.has(record.kind)) return
  if (nativeKinds.has(record.kind)) {
    await closeNativeRegistry(resource, record)
  } else if (record.kind === 'child-invocation' || record.kind === 'codex-wire-fixture') {
    await recoverLinkedRoot(admin, resource, record.directory, record.childOwner ?? record.owner, containers)
  } else if (record.kind === 'local-acceptance') {
    if (record.stateDirectory !== resource.directory) {
      await recoverLinkedRoot(admin, resource, record.stateDirectory, undefined, containers)
    }
  } else if (!processKinds.has(record.kind)) {
    throw new Error(`Unsupported test cleanup kind: ${record.kind}`)
  }
  // Removing a child also completes its parent's child-invocation journal entry.
  if (readTestResourceCleanups(resource).some(pending => pending.id === record.id)) {
    completeTestResourceCleanup(resource, record.id)
  }
}

async function dropOwnedDatabases(admin, resource) {
  for (const database of await ownedDatabases(admin, resource)) {
    const databaseUrl = new URL(testAdminUrl)
    databaseUrl.pathname = `/${database.name}`
    if (database.owner === `graphql-test:${resource.token}`) {
      await dropTestDatabase(admin, { ...resource, name: database.name, databaseUrl: databaseUrl.toString() },
        { force: false })
    } else {
      const hash = database.owner.slice(`graphql-test:${resource.token}:template:`.length)
      const { dropTestDatabaseTemplate } = await import('./test-database-template.mjs')
      await dropTestDatabaseTemplate(admin, { ...resource, name: database.name,
        databaseUrl: databaseUrl.toString(), hash })
    }
  }
}

async function recoverRoot(admin, resource, containers) {
  const pending = requireDeadCleanupOwners(resource)
  for (const record of pending) {
    await requireRecordedDatabaseClosed(admin, resource, record)
  }
  await ownedDatabases(admin, resource)
  removeContainers(resource, containers)
  for (const record of pending) await settleRecord(admin, resource, record, containers)
  await settleTestResources(admin, resource)
  await dropOwnedDatabases(admin, resource)
  requireDeadOwner(resource)
  removeTestRoot(resource)
}

export async function recoverAbandonedTestRoots(admin, {
  parent = join(homedir(), '.cache', 'graphql-disposable-tests'), containers = docker,
} = {}) {
  const result = { removed: [], retained: [] }
  if (!existsSync(parent)) return result
  parent = realpathSync(parent)
  const stat = lstatSync(parent)
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Test recovery directory is unsafe')
  const lock = `graphql-test-root-recovery:${parent}`
  const acquired = await admin.query('select pg_try_advisory_lock(hashtext($1)) as acquired', [lock])
  if (!acquired.rows[0]?.acquired) return result
  try {
    for (const name of readdirSync(parent)) {
      const directory = join(parent, name)
      try {
        const entry = lstatSync(directory)
        if (!entry.isDirectory() || entry.isSymbolicLink() || !existsSync(join(directory, markerName))) continue
        const resource = readRoot(directory)
        await recoverRoot(admin, resource, containers)
        result.removed.push(directory)
      } catch (error) {
        // Another invocation can finish its normal cleanup during this scan.
        if (error.code === 'ENOENT' && !existsSync(directory)) continue
        result.retained.push({ directory, reason: error.message })
      }
    }
  } finally {
    await admin.query('select pg_advisory_unlock(hashtext($1))', [lock])
  }
  return result
}

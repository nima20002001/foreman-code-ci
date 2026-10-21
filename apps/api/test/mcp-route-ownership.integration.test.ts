import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { createFixtureDatabase, dropFixtureDatabase, removeFixtureDirectory } from './helpers/testResources.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { deferred } from './helpers/deferred.js'

it('preserves successor routes when the lost runtime owner finishes shutdown afterward', async () => {
  const name = `route_owner_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! })
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.pathname = `/${name}`
  const lost = deferred()
  const drain = deferred()
  const directory = await privateFixtureDirectory('route-runtime-')
  const launcher = join(directory, 'launcher.mjs')
  const rows = [{ token_hash: 'e'.repeat(64), expires_at: new Date(Date.now() + 60_000) }]
  const pool = { query: async () => ({ rows }) } as unknown as pg.Pool
  const firstRoutes = new AppMcpRoutes(pool, 'http://127.0.0.1:3101/mcp', launcher)
  const secondRoutes = new AppMcpRoutes(pool, 'http://127.0.0.1:3102/mcp', launcher)
  const first = new OperatorRuntimeOwner(url.toString(), () => { shutdown.begin(); lost.resolve() })
  const second = new OperatorRuntimeOwner(url.toString(), () => { throw new Error('Successor lost ownership') })
  const shutdown = new RuntimeShutdown({ stop: [], drain: [{ name: 'native credential detachment', run: () => drain.promise }],
    dispose: [{ name: 'MCP routes', run: () => firstRoutes.close() }], releaseOwnership: () => first.close() })
  let created = false
  try {
    await admin.connect()
    await createFixtureDatabase(admin, name, 'template template0')
    created = true
    await first.acquire()
    await firstRoutes.refresh()
    const epoch = await first.readRuntimeEpoch()
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity
      where datname=$1 and (extract(epoch from backend_start)*1000000)::bigint::text=$2`, [name, epoch])
    await lost.promise
    await second.acquire()
    await secondRoutes.refresh()
    const finishing = shutdown.finish()
    drain.resolve()
    await finishing
    const saved = JSON.parse(await readFile(join(directory, 'routes', `${rows[0]!.token_hash}.json`), 'utf8'))
    expect(saved).toMatchObject({ endpoint: 'http://127.0.0.1:3102/mcp' })
    expect(second.active).toBe(true)
  } finally {
    drain.resolve()
    await firstRoutes.close()
    await secondRoutes.close()
    await first.close()
    await second.close()
    if (created) await dropFixtureDatabase(admin, name)
    await admin.end()
    await removeFixtureDirectory(directory)
  }
}, 30_000)

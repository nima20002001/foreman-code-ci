import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { readRuntimeIdentity } from '../src/infrastructure/runtimeIdentity.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

it('persists local installation identity, rotates after recreation, and preserves bearer revocation without management grants', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const schema = `startup_identity_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  let pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await applyApplicationMigrations(pool)
    const first = await readRuntimeIdentity(pool, process.cwd(), connectionString)
    expect(await readRuntimeIdentity(pool, process.cwd(), connectionString)).toEqual(first)
    const access = new PostgresAccessService(pool)
    const reader = await access.issue({ name: 'Identity-only fixture', audience: 'operator', grants: [], expiresAt: new Date(Date.now() + 60_000) })
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      runtimeIdentity: () => readRuntimeIdentity(pool, process.cwd(), connectionString),
      operator: { access, services: { commands: new PostgresCommandCoordinator(pool) } as OperatorServices } })
    const authorized = await app.inject({ method: 'GET', url: '/api/runtime/identity', headers: { authorization: `Bearer ${reader.token}` } })
    expect(authorized.statusCode).toBe(200)
    expect(authorized.json()).toEqual(first)
    const local = await app.inject({ method: 'GET', url: '/api/runtime/identity' })
    expect(local.statusCode).toBe(200)
    expect(local.json()).toEqual(first)
    expect((await app.inject({ method: 'GET', url: '/api/runtime/identity', remoteAddress: '192.0.2.1' })).statusCode).toBe(403)
    await access.revoke(reader.principal.id)
    expect((await app.inject({ method: 'GET', url: '/api/runtime/identity', headers: { authorization: `Bearer ${reader.token}` } })).statusCode).toBe(401)
    await app.close(); app = undefined
    await pool.end()
    await dropFixtureSchema(admin, schema)
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
    await applyApplicationMigrations(pool)
    const recreated = await readRuntimeIdentity(pool, process.cwd(), connectionString)
    expect(recreated.installationId).not.toBe(first.installationId)
    expect(recreated.checkoutId).toBe(first.checkoutId)
    expect(recreated.databaseId).toBe(first.databaseId)
  } finally {
    await app?.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
  }
}, 30_000)

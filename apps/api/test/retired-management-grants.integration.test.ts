import { randomUUID, createHash } from 'node:crypto'
import Fastify from 'fastify'
import pg from 'pg'
import { expect, it } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl } from './helpers/testResources.js'

const retirementVersion = 2026101703
const validGrants = [
  { actions: ['settings:read', 'runs:start'], scope: { workspaceIds: ['workspace'] } },
  { actions: ['devices:read'], scope: {} },
]
const storedGrants = [
  { ...validGrants[0], actions: ['settings:read', 'devices:provision', 'retired:action', 'runs:start'] },
  { actions: ['devices:provision', 'retired:action'], scope: { workflowIds: ['workflow'] } },
  validGrants[1],
]

async function databaseBeforeRetirement() {
  const connectionString = ownedTestDatabaseUrl()
  const admin = new pg.Pool({ connectionString })
  const schema = `retired_grants_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    // Only the existing tables used by this data migration are needed in this upgrade fixture.
    await pool.query(`
      create table application_migrations(version integer primary key);
      create table management_principals(
        id text primary key, name text, audience text, agent_id text, token_hash text,
        grants jsonb not null, expires_at timestamptz, revoked_at timestamptz, delegated_from text);
      create table local_human_principal(singleton boolean, principal_id text);
      create table run_authority_principals(
        principal_id text, run_id text, owner_principal_id text, caller_principal_id text,
        grant_ceiling jsonb not null, accepted_expires_at timestamptz);
      create table runs(id text, execution_state text, record jsonb);
      create table run_cleanup_intents(run_id text, pending boolean);
      create table workflow_schedule_authorities(workflow_id text, grant_ceiling jsonb not null);
    `)
    await pool.query('insert into application_migrations select unnest($1::integer[])',
      [migrations.filter(migration => migration.version !== retirementVersion).map(migration => migration.version)])
    return { pool, async close() {
      await pool.end()
      try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
    } }
  } catch (error) {
    await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
    throw error
  }
}

it('migrates retired stored grants before serving local human and copied run authority', async () => {
  const db = await databaseBeforeRetirement()
  const app = Fastify()
  const access = new PostgresAccessService(db.pool)
  registerOperatorHttpSecurity(app, access, new PostgresLocalHumanAccess(db.pool, access))
  try {
    const token = 'existing-operator-token'
    const tokenHash = createHash('sha256').update(token).digest('hex')
    for (const [id, audience, agentId, owner] of [
      ['human', 'operator', null, null],
      ['installed-regression', 'operator', null, null],
      ['run-authority', 'operator', null, 'human'],
      ['worker', 'worker', 'agent', null],
    ]) {
      await db.pool.query(`insert into management_principals
        values($1,$1,$2,$3,$4,$5::jsonb,'2099-01-01',null,$6)`,
      [id, audience, agentId, id === 'installed-regression' ? tokenHash : null, JSON.stringify(storedGrants), owner])
    }
    await db.pool.query(`insert into management_principals
      values('retired-only','Retired only','operator',null,null,$1::jsonb,'2020-01-01','2021-01-01',null)`,
    [JSON.stringify([{ actions: ['devices:provision'], scope: {} }])])
    await db.pool.query(`insert into management_principals
      values('valid','Valid operator','operator',null,null,$1::jsonb,'2099-01-01',null,null)`,
    [JSON.stringify(validGrants)])
    await db.pool.query("insert into local_human_principal values(true,'human')")
    await db.pool.query(`insert into run_authority_principals
      values('run-authority','run','human','installed-regression',$1::jsonb,'2099-01-01')`, [JSON.stringify(storedGrants)])
    await db.pool.query(`insert into runs values('run','running','{"authorizationPrincipalId":"run-authority"}')`)
    await db.pool.query("insert into workflow_schedule_authorities values('workflow',$1::jsonb)", [JSON.stringify(storedGrants)])
    const before = (await db.pool.query('select * from management_principals order by id')).rows
    const runBefore = (await db.pool.query('select * from runs')).rows

    await applyApplicationMigrations(db.pool)
    const response = await app.inject({ url: '/api/local-human' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().principal).toEqual({
      id: 'human', name: 'human', expiresAt: '2099-01-01T00:00:00.000Z', grants: validGrants,
    })
    expect((await access.authenticate(token)).grants).toEqual(validGrants)
    const authority = await currentOperatorAuthority(db.pool, 'run-authority')
    expect(authority.principal.grants).toEqual(validGrants)
    expect(authority.owner.grants).toEqual(validGrants)
    const after = (await db.pool.query('select * from management_principals order by id')).rows
    expect(after).toEqual(before.map(row => ({ ...row, grants: row.id === 'retired-only' ? [] : validGrants })))
    for (const row of after) {
      expect(ManagementPrincipalSchema.shape.grants.parse(row.grants)).toEqual(row.grants)
    }
    expect((await db.pool.query('select grant_ceiling from run_authority_principals')).rows)
      .toEqual([{ grant_ceiling: validGrants }])
    expect((await db.pool.query('select grant_ceiling from workflow_schedule_authorities')).rows)
      .toEqual([{ grant_ceiling: validGrants }])
    expect((await db.pool.query('select * from runs')).rows).toEqual(runBefore)
    await applyApplicationMigrations(db.pool)
    expect((await db.pool.query('select * from management_principals order by id')).rows).toEqual(after)
    expect((await app.inject({ url: '/api/local-human' })).statusCode).toBe(200)
  } finally {
    await app.close()
    await db.close()
  }
})

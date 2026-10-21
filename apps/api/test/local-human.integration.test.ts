import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { localHumanMigration } from '../src/infrastructure/localHumanMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { AppMcpRoutes } from '../src/modules/harnesses/appMcpRoutes.js'
import { buildApp } from '../src/app.js'
import { requirePrincipal } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { browserOwnerUpgrade } from './helpers/browserOwnerUpgrade.js'

async function browserTables(pool: Awaited<ReturnType<typeof currentDatabase>>['pool']) {
  return (await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname=current_schema() and tablename like 'browser_auth_%'",
  )).rows
}

describe.skipIf(!postgresEnabled)('local human migration', { timeout: 60_000 }, () => {
  it('preserves saved versions, runs and pending approval decisions when migrations are reapplied', async () => {
    const fixture = await approvalDatabase()
    try {
      const readRun = () => fixture.runs.get(fixture.run.id)
      const workflows = new PostgresWorkflowRepository(fixture.pool)
      const pending = await fixture.repository.get(fixture.interaction.id)
      const run = await readRun()
      const version = await workflows.getSavedVersion(fixture.version.id)
      await applyApplicationMigrations(fixture.pool)
      expect(await readRun()).toEqual(run)
      expect(await workflows.getSavedVersion(fixture.version.id)).toEqual(version)
      expect(await fixture.repository.get(fixture.interaction.id)).toEqual(pending)
    } finally { await fixture.close() }
  })
  it('provides credential-free access to every owner action on a fresh database and remains repeatable', async () => {
    const db = await currentDatabase()
    try {
      const access = new PostgresAccessService(db.pool)
      const human = new PostgresLocalHumanAccess(db.pool, access)
      const before = await human.current()
      expect(before).toMatchObject({ id: 'principal-local-human', audience: 'operator', revokedAt: null })
      expect(new Set(before.grants.flatMap(grant => grant.actions))).toEqual(new Set(ManagementActionSchema.options))
      for (const action of ManagementActionSchema.options) {
        expect(() => requireAuthorization(before, action), action).not.toThrow()
      }
      expect(await browserTables(db.pool)).toEqual([])
      expect((await db.pool.query('select token_hash from management_principals where id=$1', [before.id])).rows)
        .toEqual([{ token_hash: null }])
      const reader = await access.issue({ name: 'MCP routing reader', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const routes = new AppMcpRoutes(db.pool, 'http://127.0.0.1:3000/mcp', join(db.directory, 'graphql-mcp.mjs'))
      try {
        await expect(routes.refresh()).resolves.toBeUndefined()
        expect(await access.authenticate(reader.token)).toEqual(reader.principal)
      } finally { await routes.close() }
      await applyApplicationMigrations(db.pool)
      expect(await human.current()).toEqual(before)
      await expect(access.authenticate(before.id)).rejects.toMatchObject({ code: 'AUTH_INVALID' })
    } finally { await db.close() }
  })

  it('retains the sole root Operator selected by the previous ownerless development path across restart', async () => {
    const db = await currentDatabase()
    try {
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Previously selected development Operator', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: { workspaceIds: ['existing-workspace'] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      await browserOwnerUpgrade(db.pool, owner.principal.id, { ownerMapping: 'empty' })
      const principals = (await db.pool.query('select * from management_principals order by id')).rows
      await applyApplicationMigrations(db.pool)
      expect(await new PostgresLocalHumanAccess(db.pool, access).current()).toEqual(owner.principal)
      expect(await access.authenticate(owner.token)).toEqual(owner.principal)
      expect((await db.pool.query('select * from management_principals order by id')).rows).toEqual(principals)
      await applyApplicationMigrations(db.pool)
      expect(await new PostgresLocalHumanAccess(db.pool, new PostgresAccessService(db.pool)).current())
        .toEqual(owner.principal)
    } finally { await db.close() }
  })

  it('drops existing browser accounts and sessions without widening MCP grants or altering audit history', async () => {
    const db = await currentDatabase()
    try {
      const access = new PostgresAccessService(db.pool)
      const reader = await access.issue({ name: 'Existing browser owner with read-only MCP access', audience: 'operator',
        grants: [{ actions: ['settings:read', 'workspaces:read'], scope: { workspaceIds: ['existing-workspace'] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      await db.pool.query('drop table local_human_principal')
      await db.pool.query("delete from management_principals where id='principal-local-human'")
      await db.pool.query('delete from application_migrations where version=$1', [localHumanMigration.version])
      await db.pool.query('alter table management_principals drop constraint management_principals_credential_required')
      await db.pool.query(`
        create table browser_auth_user(id text primary key);
        create table browser_auth_owner(singleton boolean primary key, user_id text references browser_auth_user(id),
          principal_id text references management_principals(id));
        create table browser_auth_session(id text primary key, user_id text references browser_auth_user(id));
        create table browser_auth_account(id text primary key, user_id text references browser_auth_user(id));
        create table browser_auth_verification(id text primary key);
        create table browser_auth_attempts(key text primary key);
        insert into browser_auth_user values('previous-owner');
        insert into browser_auth_session values('previous-session','previous-owner');
        insert into browser_auth_account values('previous-account','previous-owner');
      `)
      await db.pool.query('insert into browser_auth_owner values(true,$1,$2)', ['previous-owner', reader.principal.id])
      await db.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,'http','settings.read',$2,'succeeded','{}')`, [reader.principal.id, randomUUID()])
      const principals = (await db.pool.query('select * from management_principals order by id')).rows
      const audit = (await db.pool.query('select * from management_audit order by sequence')).rows
      await applyApplicationMigrations(db.pool)
      expect(await browserTables(db.pool)).toEqual([])
      expect((await db.pool.query("select * from management_principals where id <> 'principal-local-human' order by id")).rows)
        .toEqual(principals)
      expect((await db.pool.query('select * from management_audit order by sequence')).rows).toEqual(audit)
      expect(await access.authenticate(reader.token)).toEqual(reader.principal)
      const human = new PostgresLocalHumanAccess(db.pool, access)
      expect(await human.current()).toEqual(reader.principal)
      await applyApplicationMigrations(db.pool)
      expect(await new PostgresLocalHumanAccess(db.pool, new PostgresAccessService(db.pool)).current())
        .toEqual(reader.principal)
      const app = buildApp({
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { commands: new PostgresCommandCoordinator(db.pool) } as never }, localHuman: human,
      })
      app.get('/api/workspaces/:workspaceId/reference-files/permission-probe', requirePrincipal)
      app.post('/api/devices/connection-configure', requirePrincipal)
      try {
        for (const headers of [{}, { authorization: `Bearer ${reader.token}` }]) {
          const self = await app.inject({ url: '/api/local-human', headers })
          expect(self.statusCode, self.body).toBe(200)
          expect(self.json().principal).toMatchObject({ id: reader.principal.id, grants: reader.principal.grants })
          const allowed = await app.inject({
            url: '/api/workspaces/existing-workspace/reference-files/permission-probe', headers,
          })
          expect(allowed.statusCode, allowed.body).toBe(200)
          const denied = await app.inject({
            url: '/api/workspaces/another-workspace/reference-files/permission-probe', headers,
          })
          expect(denied.statusCode).toBe(403)
          expect((await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers })).statusCode).toBe(403)
        }
      } finally { await app.close() }
    } finally { await db.close() }
  })
})

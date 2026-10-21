import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JobDefinitionSchema } from '@foreman-code/contracts/jobs'
import { expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { registerJobRoutes } from '../src/routes/jobs.js'
import { jobSpec } from './helpers/jobFixture.js'

// The integration runner supplies a disposable test database; this test owns its schema.
// Saved metadata is synthetic; no native execution or qualification is claimed.
it('exposes late Operator services through authenticated MCP with denied callers and persisted HTTP readback', async () => {
  const connectionString = process.env.TEST_DATABASE_URL
  if (!connectionString) throw new Error('The integration runner must supply a disposable test database.')
  const url = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests.')
  }
  const schema = `hrt_f03_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString, max: 1 })
  const pool = new pg.Pool({ connectionString, max: 4,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  await createFixtureSchema(admin, schema)
  try {
    await applyApplicationMigrations(pool)
    const workspaceId = randomUUID(), foreignWorkspaceId = randomUUID()
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Late services fixture' })])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const owner = await access.issue({ name: 'Job reader', audience: 'operator', expiresAt: new Date(Date.now() + 300_000),
      grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }] })
    const denied = await access.issue({ name: 'Foreign Job reader', audience: 'operator', expiresAt: new Date(Date.now() + 300_000),
      grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [foreignWorkspaceId] } }] })
    const now = new Date().toISOString()
    const definition = JobDefinitionSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId,
      name: 'Persisted Job', revision: 1, versionId: randomUUID(), spec: jobSpec(), createdAt: now, updatedAt: now })
    await pool.query('insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by) values($1,$2,$3,$4,$5::jsonb,$6)',
      [definition.id, workspaceId, definition.revision, definition.versionId, JSON.stringify(definition), owner.principal.id])
    await pool.query('insert into job_definition_versions(id,definition_id,workspace_id,revision,record) values($1,$2,$3,$4,$5::jsonb)',
      [definition.versionId, definition.id, workspaceId, definition.revision, JSON.stringify(definition)])
    const services = { commands } as OperatorServices
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const unavailable = async (): Promise<never> => { throw new Error('Metadata reads must not invoke native Job ports.') }
    const ports = {
      preparation: { choices: unavailable, validate: unavailable, accept: unavailable,
        revalidateAccepted: unavailable, adoptFinalBinding: unavailable },
      dispatch: { accept: unavailable, cancel: unavailable, cancelForRunCleanup: unavailable, wake: unavailable },
      artifacts: { read: unavailable, list: unavailable },
    }
    // Production assigns this service after buildApp; MCP must observe the same object.
    services.jobs = new JobService(pool, commands, ports)
    registerJobRoutes(app, services.jobs)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'late-services-regression', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(owner.token), deniedClient = await connect(denied.token)
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('job_definition_get')
    const args = { workspaceId, definitionId: definition.id }
    const result = await client.callTool({ name: 'job_definition_get', arguments: args })
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toEqual({ definition })
    const http = await app.inject({ method: 'GET', url: `/api/management/workspaces/${workspaceId}/jobs/definitions/${definition.id}`,
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(decodeMcpToolResult(result))
    expect(await new JobService(pool, new PostgresCommandCoordinator(pool), ports)
      .getDefinition(owner.principal, workspaceId, definition.id)).toEqual(definition)
    expect((await pool.query('select record from job_definitions where id=$1', [definition.id])).rows[0]?.record).toEqual(definition)

    const refused = await deniedClient.callTool({ name: 'job_definition_get', arguments: args })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([{ type: 'text', text: expect.stringContaining('ACCESS_DENIED') }])
    expect(refused.structuredContent).toBeUndefined()
    const write = await client.callTool({ name: 'job_definition_save', arguments: {
      workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Denied write', spec: jobSpec(),
    } })
    expect(write.isError).toBe(true)
    expect(write.content).toEqual([{ type: 'text', text: expect.stringContaining('ACCESS_DENIED') }])
    expect((await pool.query('select count(*)::int as count from job_definitions')).rows[0]?.count).toBe(1)
    const audits = await pool.query('select principal_id,source,action from management_audit where outcome=$1', ['denied'])
    expect(audits.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ principal_id: denied.principal.id, source: 'mcp', action: 'job_definition_get' }),
      expect.objectContaining({ principal_id: owner.principal.id, source: 'mcp', action: 'job_definition_save' }),
    ]))
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
  }
}, 120_000)

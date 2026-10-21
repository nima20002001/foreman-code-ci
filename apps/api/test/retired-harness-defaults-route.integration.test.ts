import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessDefaultsUpdateResultSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

/** Harness defaults change only through the identity-, grant-, revision- and
 * audit-checked management service, equally over HTTP and Operator MCP. The
 * unchecked product settings route no longer exists, even with product routes composed. */
it('changes harness defaults only through the checked HTTP/MCP service', async () => {
  const f = await currentOperatorIntegration()
  const app = buildApp({
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: f.services },
    product: { workspaces: new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs), workflows: f.workflows, runs: f.runs, engine: f.engine },
  })
  const settings = new PostgresSettingsRepository(f.db.pool)
  const json = (token: string) => ({ host: 'localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' })
  try {
    const original = await settings.getManagedHarnessDefaults()
    const changed = { ...original.defaults, codex: { ...original.defaults.codex, model: 'checked-defaults-model' } }

    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({ method, url: '/api/settings/harnesses', headers: json(f.writer.token),
        ...(method === 'PUT' ? { payload: { defaults: changed } } : {}) })
      expect(response.statusCode, method).toBe(404)
    }
    expect(await settings.getManagedHarnessDefaults()).toEqual(original)

    const reader = await f.access.issue({ name: 'Harness defaults reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const input = { commandId: randomUUID(), expectedRevision: original.revision, defaults: changed }
    await expectMcpAccessDenied((await f.connect(reader.token)).callTool({ name: 'harness_defaults_update', arguments: input }))
    const deniedHttp = await app.inject({ method: 'PUT', url: '/api/management/harnesses/defaults', headers: json(reader.token), payload: input })
    expect(deniedHttp.statusCode).toBe(403)
    expect(await settings.getManagedHarnessDefaults()).toEqual(original)

    const saved = await app.inject({ method: 'PUT', url: '/api/management/harnesses/defaults', headers: json(f.writer.token), payload: input })
    expect(saved.statusCode).toBe(200)
    const result = HarnessDefaultsUpdateResultSchema.parse(saved.json())
    expect(result.value).toMatchObject({ revision: original.revision + 1, defaults: { codex: { model: 'checked-defaults-model' } } })

    const stale = await app.inject({ method: 'PUT', url: '/api/management/harnesses/defaults', headers: json(f.writer.token),
      payload: { ...input, commandId: randomUUID() } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })

    expect(decodeMcpToolResult(await f.client.callTool({ name: 'harness_get', arguments: { harness: 'codex' } })))
      .toMatchObject({ defaults: { model: 'checked-defaults-model' }, defaultsRevision: result.value.revision })
    expect((await settings.getManagedHarnessDefaults()).revision).toBe(result.value.revision)
    expect((await f.db.pool.query(
      "select source, outcome from management_audit where principal_id=$1 and action='harness.defaults.update'",
      [f.writer.principal.id])).rows).toContainEqual({ source: 'http', outcome: 'succeeded' })
  } finally {
    await app.close()
    await f.close()
  }
}, 60_000)

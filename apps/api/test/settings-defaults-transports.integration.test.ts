import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const settings = [
  {
    kind: 'agents', readTool: 'agent_defaults_get', updateTool: 'agent_defaults_update',
    operation: 'agent.defaults.update', snapshot: ManagedAgentDefaultsSchema, result: AgentDefaultsUpdateResultSchema,
    change: (value: unknown) => {
      const defaults = ManagedAgentDefaultsSchema.shape.value.parse(value)
      return { ...defaults, operator: { ...defaults.operator, uiEnabled: !defaults.operator.uiEnabled } }
    },
  },
  {
    kind: 'workflows', readTool: 'workflow_defaults_get', updateTool: 'workflow_defaults_update',
    operation: 'workflow.defaults.update', snapshot: ManagedWorkflowDefaultsSchema, result: WorkflowDefaultsUpdateResultSchema,
    change: (value: unknown) => {
      const defaults = ManagedWorkflowDefaultsSchema.shape.value.parse(value)
      return { approvalHandler: defaults.approvalHandler === 'user' ? 'orchestrator' as const : 'user' as const }
    },
  },
] as const

describe.each(settings)('$kind defaults transports', setting => {
  it('removes unchecked routes and shares authenticated revisioned HTTP/MCP writes and readback', async () => {
    const f = await currentOperatorIntegration()
    const product = {
      workspaces: new PostgresWorkspaceRepository(f.db.pool, f.workflows, f.runs),
      workflows: f.workflows, runs: f.runs, engine: f.engine,
    }
    const readiness = { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }
    const app = buildApp({ readiness, product, operator: { access: f.access, services: f.services } })
    const productOnly = buildApp({ readiness, product })
    const path = `/api/management/settings/${setting.kind}`
    const headers = (token: string) => ({ authorization: `Bearer ${token}` })
    try {
      const reader = await f.access.issue({ name: 'Defaults reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read'], scope: {} }] })
      const denied = await f.connect(reader.token)
      const original = setting.snapshot.parse(decodeMcpToolResult(await f.client.callTool({
        name: setting.readTool, arguments: {},
      })))
      const input = { commandId: randomUUID(), expectedRevision: original.revision, value: setting.change(original.value) }
      for (const target of [app, productOnly]) {
        for (const method of ['GET', 'PUT'] as const) {
          const removed = await target.inject({ method, url: `/api/settings/${setting.kind}`,
            headers: headers(f.writer.token), ...(method === 'PUT' ? { payload: input } : {}) })
          expect(removed.statusCode).toBe(404)
        }
      }
      expect((await f.client.listTools()).tools.map(tool => tool.name))
        .toEqual(expect.arrayContaining([setting.readTool, setting.updateTool]))
      expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain(setting.updateTool)
      await expectMcpAccessDenied(denied.callTool({ name: setting.updateTool, arguments: input }))
      const deniedHttp = await app.inject({ method: 'PUT', url: path, headers: headers(reader.token), payload: input })
      expect(deniedHttp.statusCode).toBe(403)
      expect(deniedHttp.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const invalidIdentity = await app.inject({ method: 'PUT', url: path,
        headers: headers('invalid-credential'), payload: input })
      expect(invalidIdentity.statusCode).toBe(401)
      const readOriginal = await app.inject({ url: path, headers: headers(reader.token) })
      expect(readOriginal.statusCode).toBe(200)
      expect(setting.snapshot.parse(readOriginal.json())).toEqual(original)

      const savedHttp = await app.inject({ method: 'PUT', url: path, headers: headers(f.writer.token), payload: input })
      expect(savedHttp.statusCode, savedHttp.body).toBe(200)
      const saved = setting.result.parse(savedHttp.json())
      expect(saved).toMatchObject({ replayed: false, value: { revision: original.revision + 1, value: input.value } })
      expect(saved.value.versionId).toEqual(expect.any(String))
      expect(setting.snapshot.parse(decodeMcpToolResult(await denied.callTool({
        name: setting.readTool, arguments: {},
      })))).toEqual(saved.value)
      const replay = setting.result.parse(decodeMcpToolResult(await f.client.callTool({
        name: setting.updateTool, arguments: input,
      })))
      expect(replay).toEqual({ ...saved, replayed: true })
      const staleInput = { ...input, commandId: randomUUID() }
      const staleHttp = await app.inject({ method: 'PUT', url: path,
        headers: headers(f.writer.token), payload: staleInput })
      expect(staleHttp.statusCode).toBe(409)
      expect(staleHttp.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
      const staleMcp = await f.client.callTool({ name: setting.updateTool, arguments: staleInput })
      expect(staleMcp).toMatchObject({ isError: true,
        content: [{ type: 'text', text: expect.stringContaining('"REVISION_CONFLICT"') }] })

      const nextInput = { commandId: randomUUID(), expectedRevision: saved.value.revision,
        value: setting.change(saved.value.value) }
      const next = setting.result.parse(decodeMcpToolResult(await f.client.callTool({
        name: setting.updateTool, arguments: nextInput,
      })))
      expect(next).toMatchObject({ replayed: false, value: { revision: saved.value.revision + 1, value: nextInput.value } })
      const readback = await app.inject({ url: path, headers: headers(reader.token) })
      expect(readback.statusCode).toBe(200)
      expect(setting.snapshot.parse(readback.json())).toEqual(next.value)
      const httpReplay = await app.inject({ method: 'PUT', url: path,
        headers: headers(f.writer.token), payload: nextInput })
      expect(httpReplay.statusCode).toBe(200)
      expect(setting.result.parse(httpReplay.json())).toEqual({ ...next, replayed: true })
      const restarted = new PostgresFoundationSettingsRepository(f.db.pool)
      const persisted = setting.kind === 'agents'
        ? await restarted.getAgentDefaults() : await restarted.getWorkflowDefaults()
      expect(persisted).toEqual(next.value)
      const audit = await f.db.pool.query(
        'select principal_id,source,action,target_key,outcome from management_audit order by sequence',
      )
      expect(audit.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ principal_id: reader.principal.id, source: 'http',
          target_key: path, outcome: 'denied' }),
        expect.objectContaining({ principal_id: reader.principal.id, source: 'mcp',
          action: setting.updateTool, outcome: 'denied' }),
      ]))
      expect(audit.rows.filter(row => row.action === setting.operation && row.outcome === 'succeeded'))
        .toEqual([
          expect.objectContaining({ principal_id: f.writer.principal.id, source: 'http' }),
          expect.objectContaining({ principal_id: f.writer.principal.id, source: 'mcp' }),
        ])
    } finally {
      await productOnly.close()
      await app.close()
      await f.close()
    }
  }, 60_000)
})

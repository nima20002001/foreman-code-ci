import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentDefaultsUpdateResultSchema, ManagedAgentDefaultsSchema } from '@foreman-code/contracts/management'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { Wave25WorkerCredentialService as WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { access, address, database, mcp, native, production, registerProductionLifecycleFixture, runs, start } from './helpers/productionLifecycleFixture.js'

registerProductionLifecycleFixture()

it('updates and reads Operator defaults through authenticated MCP with a one-slot pool', async () => {
  const writer = await access.issue({ name: 'Settings writer', audience: 'operator', grants: [{
    actions: ['settings:read', 'settings:update'], scope: {},
  }], expiresAt: new Date(Date.now() + 60_000) })
  const reader = await access.issue({ name: 'Settings reader', audience: 'operator', grants: [{
    actions: ['settings:read'], scope: {},
  }], expiresAt: new Date(Date.now() + 60_000) })
  const client = new Client({ name: 'settings-writer', version: '1' })
  const denied = new Client({ name: 'settings-reader', version: '1' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => writer.token },
    }))
    await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => reader.token },
    }))
    const read = async () => ManagedAgentDefaultsSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'agent_defaults_get', arguments: {},
    })))
    const before = await read()
    const input = { commandId: randomUUID(), expectedRevision: before.revision, value: {
      ...before.value, operator: { ...before.value.operator, showThinking: true },
    } }
    await expectMcpAccessDenied(denied.callTool({ name: 'agent_defaults_update', arguments: input }))
    expect(await read()).toEqual(before)
    const updated = await client.callTool({ name: 'agent_defaults_update', arguments: input })
    expect(updated.isError, JSON.stringify(updated)).not.toBe(true)
    const result = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(updated))
    const saved = await read()
    expect(saved.revision).toBe(before.revision + 1)
    expect(saved.value).toEqual(input.value)
    expect(saved.versionId).toEqual(expect.any(String))
    expect(saved).toEqual(result.value)
    expect(await new PostgresFoundationSettingsRepository(database.pool).getAgentDefaults()).toEqual(saved)
    const replay = AgentDefaultsUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'agent_defaults_update', arguments: input,
    })))
    expect(replay).toEqual({ value: saved, replayed: true })
    expect(await read()).toEqual(saved)
  } finally {
    await client.close()
    await denied.close()
  }
})

it('persists a User approval wait when application and checkpoint schemas are separate', async () => {
  const { run, pending } = await start('user')

  expect(await runs.get(run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
  expect(pending.graphInterruptId).toEqual(expect.any(String))
  const response = await production.app.inject({
    method: 'GET', url: `/api/user/interactions?runId=${run.id}`,
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().items).toEqual([expect.objectContaining({ id: pending.id, status: 'pending' })])
  expect(native.responses).toBe(0)
})

it('answers a production User approval through the local API while excluding Operator and App authority', async () => {
  const { run, issuer, pending } = await start('user')

  const url = `/api/user/interactions/${pending.id}/respond`
  const payload = { interactionId: pending.id, optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision }
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${issuer.token}` }, payload })).statusCode).toBe(403)
  const worker = await new WorkerCredentialService(database.pool, access).issueForExecution(pending.executionId)
  const workerToken = readProductEnvironment(worker.environment.variables, 'MCP_TOKEN')
  expect(workerToken).toEqual(expect.any(String))
  expect((await production.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${workerToken}` }, payload })).statusCode).toBe(403)
  const denied = await mcp(workerToken!, payload)
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('ROLE_NOT_ALLOWED')
  const headers = {}
  const list = await production.app.inject({ method: 'GET', url: `/api/user/interactions?runId=${run.id}`, headers })
  expect(list.statusCode, list.body).toBe(200)
  expect(list.json().items.map((item: { id: string }) => item.id)).toEqual([pending.id])
  expect((await production.app.inject({ method: 'GET', url: `/api/user/interactions/${pending.id}`, headers })).statusCode).toBe(200)
  expect(production.app.hasRoute({ method: 'GET', url: '/api/interactions/:interactionId' })).toBe(false)
  const response = await production.app.inject({ method: 'POST', url, headers: {}, payload })
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json().interaction.deliveryState).toBe('delivered')
  await production.engine.resume(run.id)
  await vi.waitFor(async () => expect((await runs.get(run.id))?.outcome).toBe('succeeded'), { timeout: 60_000, interval: 10 })
  expect(native.responses).toBe(1)
})


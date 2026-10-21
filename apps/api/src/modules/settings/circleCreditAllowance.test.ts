import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedCircleCreditAllowanceSchema, CircleCreditAllowanceUpdateResultSchema,
  CircleCreditAllowanceUpdateInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { PostgresFoundationSettingsRepository } from './foundation.js'
import { FoundationSettingsManagementService } from './management.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
  vi.restoreAllMocks()
})

async function fixture() {
  const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] }
  const reader: ManagementPrincipal = { ...owner, id: 'reader', grants: [{ actions: ['settings:read'], scope: {} }] }
  const scoped: ManagementPrincipal = { ...owner, id: 'scoped',
    grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['workspace'] } }] }
  const principals = new Map([owner, reader, scoped].map(principal => [principal.id, principal]))
  const records = new Map<string, { record: unknown; revision: string; current_version_id: string }>()
  const receipts = new Map<string, { input_hash: string; target_key: string; result: unknown }>()
  const audits: { principalId: unknown; source: unknown; action: unknown }[] = []
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (text.includes('from management_principals')) {
      const principal = principals.get(values[0] as string)
      return { rows: principal ? [{ ...principal, expires_at: new Date(principal.expiresAt),
        revoked_at: principal.revokedAt && new Date(principal.revokedAt), delegated_from: null }] : [] }
    }
    if (text.includes('from application_settings')) {
      const value = records.get(values[0] as string)
      return { rows: value ? [value] : [] }
    }
    if (text.includes('insert into application_settings')) {
      const key = values[0] as string
      records.set(key, { record: JSON.parse(values[1] as string),
        revision: String(Number(records.get(key)?.revision ?? 0) + 1), current_version_id: values[2] as string })
    }
    if (text.includes('from management_command_receipts')) {
      const receipt = receipts.get(values.slice(0, 3).join(':'))
      return { rows: receipt ? [receipt] : [] }
    }
    if (text.includes('insert into management_command_receipts')) {
      receipts.set(values.slice(0, 3).join(':'), { target_key: values[3] as string,
        input_hash: values[4] as string, result: JSON.parse(values[5] as string) })
    }
    if (text.includes('insert into management_audit')) {
      audits.push({ principalId: values[0], source: values[1], action: values[2] })
    }
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = new PostgresCommandCoordinator(pool)
  const createSettings = () => new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(pool), commands)
  const settings = createSettings()
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = principals.get(token ?? '')
    if (!principal || principal.revokedAt) throw new DomainError('AUTH_REQUIRED', 'Invalid credential.', 401)
    return principal
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, settings } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  cleanups.push(async () => {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
  })
  const connect = async (token: string) => {
    const client = new Client({ name: 'circle-credit-allowance-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return client
  }
  return { app, connect, settings, createSettings, owner, reader, principals, records, audits }
}

it('saves the CircleCI credit allowance through HTTP and authenticated MCP with persisted readback', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.id)
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('circle_credit_allowance_update')
  const initial = ManagedCircleCreditAllowanceSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'circle_credit_allowance_get', arguments: {} })))
  expect(initial).toEqual({ value: { defaultMonthlyCredits: 400000, accounts: {} }, revision: 0, versionId: null })
  const mcp = CircleCreditAllowanceUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'circle_credit_allowance_update', arguments: { value: { defaultMonthlyCredits: 400000, accounts: { acme: 1000000 } },
      expectedRevision: 0, commandId: randomUUID() } })))
  expect(mcp.value).toMatchObject({ value: { accounts: { acme: 1000000 } }, revision: 1 })
  const http = await f.app.inject({ method: 'PUT', url: '/api/management/settings/circle-credits',
    headers: { authorization: `Bearer ${f.owner.id}` },
    payload: { value: { defaultMonthlyCredits: 50000, accounts: { acme: 1000000 } }, expectedRevision: 1, commandId: randomUUID() } })
  expect(http.statusCode).toBe(200)
  const reader = await f.connect(f.reader.id)
  const persisted = ManagedCircleCreditAllowanceSchema.parse(decodeMcpToolResult(await reader.callTool({
    name: 'circle_credit_allowance_get', arguments: {} })))
  expect(persisted).toMatchObject({ value: { defaultMonthlyCredits: 50000, accounts: { acme: 1000000 } }, revision: 2 })
  expect(await f.createSettings().getCircleCreditAllowance(f.reader)).toEqual(persisted)
  expect(f.audits).toContainEqual({ principalId: f.owner.id, source: 'mcp', action: 'circle.credit.allowance.update' })
})

it('denies read-only and workspace-scoped allowance writes and rejects a stale revision', async () => {
  const f = await fixture()
  const input = { value: { defaultMonthlyCredits: 1, accounts: {} }, expectedRevision: 0, commandId: randomUUID() }
  for (const token of [f.reader.id, 'scoped']) {
    const client = await f.connect(token)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('circle_credit_allowance_update')
    expect((await client.callTool({ name: 'circle_credit_allowance_update', arguments: input })).isError).toBe(true)
    const http = await f.app.inject({ method: 'PUT', url: '/api/management/settings/circle-credits',
      headers: { authorization: `Bearer ${token}` }, payload: input })
    expect(http.statusCode).toBe(403)
  }
  const owner = await f.connect(f.owner.id)
  await owner.callTool({ name: 'circle_credit_allowance_update', arguments: { ...input, commandId: randomUUID() } })
  const stale = await owner.callTool({ name: 'circle_credit_allowance_update',
    arguments: { ...input, value: { defaultMonthlyCredits: 2, accounts: {} }, commandId: randomUUID() } })
  expect(stale.isError).toBe(true)
  expect(await f.settings.getCircleCreditAllowance(f.owner)).toMatchObject({ value: { defaultMonthlyCredits: 1 }, revision: 1 })
})

it('preserves an explicitly saved 30000 allowance and organization overrides after recreation', async () => {
  const f = await fixture()
  await f.settings.updateCircleCreditAllowance(f.owner, 'http', CircleCreditAllowanceUpdateInputSchema.parse({
    value: { defaultMonthlyCredits: 30000, accounts: { 'fixture-custom': 123456 } },
  }))
  expect(await f.createSettings().getCircleCreditAllowance(f.owner)).toMatchObject({
    value: { defaultMonthlyCredits: 30000, accounts: { 'fixture-custom': 123456 } }, revision: 1,
  })
})

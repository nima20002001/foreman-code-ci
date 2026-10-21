import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedGeneralSettingsSchema, GeneralSettingsUpdateResultSchema,
  type GeneralSettingsUpdateInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
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
    const client = new Client({ name: 'general-settings-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
    return client
  }
  return { app, connect, settings, createSettings, owner, reader, principals, records, audits }
}

it('shares HTTP and authenticated MCP preferences with persisted readback after service recreation', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.id)
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('general_settings_update')
  const initial = ManagedGeneralSettingsSchema.parse(decodeMcpToolResult((await client.callTool({
    name: 'general_settings_get', arguments: {},
  }))))
  expect(initial).toEqual({ value: { theme: 'dark' }, revision: 0, versionId: null })
  const input = { value: { theme: 'light' }, expectedRevision: initial.revision, commandId: randomUUID() }
  const http = await f.app.inject({ method: 'PUT', url: '/api/management/settings/general',
    headers: { authorization: `Bearer ${f.owner.id}` }, payload: input })
  expect(http.statusCode).toBe(200)
  const saved = GeneralSettingsUpdateResultSchema.parse(http.json())
  expect(saved.value).toMatchObject({ value: { theme: 'light' }, revision: 1 })
  const otherComputer = await f.connect(f.reader.id)
  expect(decodeMcpToolResult((await otherComputer.callTool({ name: 'general_settings_get', arguments: {} }))))
    .toEqual(saved.value)
  expect(await f.createSettings().getGeneralSettings(f.reader)).toEqual(saved.value)
  expect(f.audits).toContainEqual({ principalId: f.owner.id, source: 'http', action: 'general.settings.update' })
})

it('denies read-only and workspace-scoped writes through MCP and HTTP', async () => {
  const f = await fixture()
  for (const token of [f.reader.id, 'scoped']) {
    const client = await f.connect(token)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('general_settings_update')
    const input = { value: { theme: 'light' }, expectedRevision: 0, commandId: randomUUID() }
    expect((await client.callTool({ name: 'general_settings_update', arguments: input })).isError).toBe(true)
    const http = await f.app.inject({ method: 'PUT', url: '/api/management/settings/general',
      headers: { authorization: `Bearer ${token}` }, payload: input })
    expect(http.statusCode).toBe(403)
  }
  expect(await f.settings.getGeneralSettings(f.owner)).toMatchObject({ value: { theme: 'dark' }, revision: 0 })
})

it('replays the same command, rejects revision and command conflicts and rechecks live grants', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.id)
  const input: GeneralSettingsUpdateInput = { value: { theme: 'light' }, expectedRevision: 0, commandId: randomUUID() }
  const call = (arguments_: unknown) => client.callTool({ name: 'general_settings_update',
    arguments: arguments_ as Record<string, unknown> })
  const first = GeneralSettingsUpdateResultSchema.parse(decodeMcpToolResult((await call(input))))
  expect(GeneralSettingsUpdateResultSchema.parse(decodeMcpToolResult((await call(input)))))
    .toEqual({ ...first, replayed: true })
  expect((await call({ ...input, value: { theme: 'dark' } })).isError).toBe(true)
  expect((await call({ ...input, commandId: randomUUID() })).isError).toBe(true)
  expect((await call({ ...input, value: { theme: 'blue' }, expectedRevision: 1, commandId: randomUUID() })).isError).toBe(true)
  const stale = f.owner
  f.principals.set(stale.id, { ...stale, grants: f.reader.grants })
  await expect(f.settings.updateGeneralSettings(stale, 'mcp', input)).rejects.toMatchObject({ status: 403 })
  expect(await f.settings.getGeneralSettings(f.reader)).toEqual(first.value)
})

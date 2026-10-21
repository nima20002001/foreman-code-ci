import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService } from './fleet.js'
import { ComputerAccountsService } from './accounts.js'

function fixture() {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['settings:read'], scope: {} }] }
  const registrations = Array.from({ length: 2 }, () => ({ mainId, deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
    scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }))
  const query = async (text: string) => ({ rows: text.includes('from management_principals')
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
    : registrations.map(record => ({ record })) })
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const status = { observedAt: '2026-10-14T00:00:00Z', harnesses: [], tasks: [],
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } }
  const accounts = { accounts: [], observedAt: status.observedAt }
  const failingId = registrations[0]!.deviceId
  const state = { failure: 'none' as 'none' | 'status' | 'readiness' | 'accounts' }
  const unavailable = () => Object.assign(new Error('private connection details'), { code: 'DEVICE_LINK_DROPPED' })
  const readiness = vi.fn(async (deviceId: string) => {
    if (deviceId === failingId && state.failure !== 'none') throw unavailable()
    return { ready: true, code: null, expected: null, running: null, updatePhase: null, publicationError: null }
  })
  const endpoint = {
    capabilities: () => [COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_ACCOUNTS_NAMESPACE]
      .map(namespace => ({ namespace, mainCanRequest: true })),
    workerBundleReadiness: readiness,
    request: async (deviceId: string, namespace: string) => {
      if (deviceId === failingId && (state.failure === 'status' || state.failure === 'accounts')) throw unavailable()
      return { payload: namespace === COMPUTER_ACCOUNTS_NAMESPACE ? accounts : { operation: 'status', status } }
    },
  }
  const fleet = new FleetMaintenanceService(pool, mainId, () => endpoint, commands,
    { status: async () => status, drain: async () => {} } as unknown as ComputerMaintenance, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    })
  const accountService = new ComputerAccountsService(pool, mainId, () => endpoint, commands, async () => accounts)
  const app = Fastify()
  registerGraphqlMcp(app, {
    access: { authenticate: async (token: string) => token === 'reader'
      ? principal : { ...principal, id: 'denied', grants: [] } } as unknown as PostgresAccessService,
    operator: { commands, computerMaintenance: fleet, computerAccounts: accountService } as unknown as OperatorServices,
  })
  const call = async (name: string, token = 'reader') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { refresh: true } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return (data ? JSON.parse(data.slice(6)) : response.json()).result
  }
  return { fleet, accountService, principal, call, readiness, registrations, state, status, accounts,
    close: async () => { await app.close(); await fleet.drain() } }
}

it.each(['status', 'readiness'] as const)(
  'keeps all three maintenance results when one Worker loses %s and recovers through MCP', async failure => {
    const f = fixture()
    try {
      expect((await f.fleet.list(f.principal)).computers).toHaveLength(3)
      f.readiness.mockClear()
      f.state.failure = failure
      const result = await f.call('computers_maintenance_status')
      expect(result.isError).not.toBe(true)
      expect(decodeMcpToolResult(result)).toMatchObject({ computers: [
        { status: f.status, observation: { status: 'available' } },
        { status: f.status, observation: { status: 'unavailable', lastError: expect.stringContaining('DEVICE_LINK_DROPPED') } },
        { status: f.status, observation: { status: 'available' }, workerReadiness: { ready: true } },
      ] })
      expect(JSON.stringify(result)).not.toContain('private connection details')
      if (failure === 'status') expect(f.readiness).not.toHaveBeenCalledWith(f.registrations[0]!.deviceId)
      expect((await f.call('computers_maintenance_status', 'denied')).isError).toBe(true)
      f.state.failure = 'none'
      const recovered = decodeMcpToolResult(await f.call('computers_maintenance_status'))
      expect(recovered).toMatchObject({ computers: Array.from({ length: 3 }, () => ({ observation: { status: 'available' } })) })
    } finally { await f.close() }
  })

it('keeps healthy account readbacks when one Worker disconnects during its probe through authenticated MCP', async () => {
  const f = fixture()
  try {
    f.state.failure = 'accounts'
    const result = await f.call('computer_accounts_list')
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toMatchObject({ computers: [
      { accounts: f.accounts }, { accounts: null }, { accounts: f.accounts },
    ] })
    expect((await f.call('computer_accounts_list', 'denied')).isError).toBe(true)
    f.state.failure = 'none'
    expect(decodeMcpToolResult(await f.call('computer_accounts_list'))).toMatchObject({
      computers: Array.from({ length: 3 }, () => ({ accounts: f.accounts })),
    })
  } finally { await f.close() }
})

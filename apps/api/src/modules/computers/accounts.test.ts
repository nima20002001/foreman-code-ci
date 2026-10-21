import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { COMPUTER_ACCOUNTS_NAMESPACE, ComputerAccountsRequestSchema } from '@foreman-code/contracts/computer-accounts'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ComputerAccountsService } from './accounts.js'

it('pages every paired computer without silently dropping the 101st worker', async () => {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read'], scope: {} }] }
  const registrations = Array.from({ length: 105 }, () => ({ mainId, deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, status: 'paired',
    scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) })).sort((a, b) => a.deviceId.localeCompare(b.deviceId))
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes('from management_principals')) return { rows: [{ ...principal,
      expires_at: new Date(principal.expiresAt), revoked_at: null }] }
    const cursor = values[1] as string | null
    return { rows: registrations.filter(value => !cursor || value.deviceId > cursor)
      .slice(0, text.includes('limit 100') ? 100 : 101).map(record => ({ record })) }
  }
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const service = new ComputerAccountsService(pool, mainId, () => undefined,
    {} as PostgresCommandCoordinator, async () => ({ accounts: [], observedAt: new Date().toISOString() }))
  const first = await service.list(principal)
  expect(first.computers).toHaveLength(101)
  expect(first.nextCursor).toBe(registrations[99]!.deviceId)
  const second = await service.list(principal, 'http', false, first.nextCursor!)
  expect(second.computers).toHaveLength(5)
  expect(second.nextCursor).toBeNull()
  expect([...first.computers, ...second.computers].map(value => value.target.hostRef))
    .toEqual([{ kind: 'main', mainId }, ...registrations.map(value => ({ kind: 'device', mainId, deviceId: value.deviceId }))])
})

it('forwards explicit refresh and sign-in invalidation to both main and worker probes', async () => {
  const mainId = randomUUID()
  const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [{ actions: ['settings:read'], scope: {} }] }
  const query = async (text: string) => ({ rows: text.includes('from management_principals')
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null }]
    : [{ record: registration }] })
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const observation = { accounts: [], observedAt: new Date().toISOString() }
  const main = vi.fn<(refresh?: boolean) => Promise<typeof observation>>(async () => observation)
  const requests: Array<ReturnType<typeof ComputerAccountsRequestSchema.parse>> = []
  const endpoint = {
    capabilities: () => [{ namespace: COMPUTER_ACCOUNTS_NAMESPACE, mainCanRequest: true }],
    request: async (_deviceId: string, _namespace: string, payload: unknown) => {
      requests.push(ComputerAccountsRequestSchema.parse(payload))
      return { payload: observation }
    },
  }
  const service = new ComputerAccountsService(pool, mainId, () => endpoint,
    {} as PostgresCommandCoordinator, main)
  const first = await service.list(principal)
  await service.list(principal, 'mcp', true)
  expect(main.mock.calls.map(call => call[0])).toEqual([false, true])
  expect(requests.map(request => request.refresh)).toEqual([undefined, true])
  first.computers.forEach(computer => service.invalidate(computer.target))
  await service.list(principal)
  expect(main).toHaveBeenLastCalledWith(true)
  expect(requests.at(-1)?.refresh).toBe(true)
})

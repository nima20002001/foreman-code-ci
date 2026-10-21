import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../commands/postgres.js'

export function pairedComputerFixture() {
  const mainId = randomUUID()
  const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    status: 'paired', keyRevision: 1, authorizationRevision: 1,
    scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
  const target = { hostRef: { kind: 'device' as const, mainId, deviceId: registration.deviceId },
    applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const principal: ManagementPrincipal = { id: 'fixture-owner', name: 'Fixture owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] }
  let receipts = new Map<string, { input_hash: unknown; target_key: unknown; result: unknown }>()
  vi.spyOn(pg.Pool.prototype, 'connect').mockImplementation((async () => {
    let pending = receipts
    return { query: async (text: string, values: unknown[] = []) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
      if (text === 'begin') pending = new Map(receipts)
      if (text === 'commit') receipts = pending
      if (text.includes('from management_principals')) return { rows: [{ ...principal,
        expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
      if (text.includes('from device_registrations')) return { rows: [{ record: registration }] }
      const key = values.slice(0, 3).map(String).join(':')
      if (text.includes('from management_command_receipts')) {
        const saved = pending.get(key)
        return { rows: saved ? [saved] : [] }
      }
      if (text.includes('insert into management_command_receipts')) {
        pending.set(key, { target_key: values[3], input_hash: values[4], result: JSON.parse(String(values[5])) })
      }
      return { rows: [], rowCount: 1 }
    }, release() {} }
  }) as unknown as pg.Pool['connect'])
  vi.spyOn(pg.Pool.prototype, 'query').mockImplementation((async () => ({ rows: [] })) as unknown as pg.Pool['query'])
  const pool = new pg.Pool()
  const commands = new PostgresCommandCoordinator(pool)
  return { mainId, registration, target, principal, pool, commands }
}

import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ComputerActivityService, type CloudCiService } from '../src/modules/computers/activity.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

function fixture() {
  const principal: ManagementPrincipal = { id: 'actor', name: 'Actor', audience: 'operator',
    grants: [{ actions: ['settings:read', 'jobs:read', 'runs:read'], scope: {} }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const state = { connections: 0, revoked: false }
  const pool = { connect: async () => {
    state.connections++
    return { release: () => { state.connections-- }, query: async (sql: string) => {
      if (sql.includes('from management_principals')) return { rows: [{
        id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
        expires_at: new Date(principal.expiresAt), revoked_at: state.revoked ? new Date() : null, delegated_from: null,
      }] }
      if (sql.includes('from ci_runs') && sql.includes('group by')) return { rows: [{ provider: 'github', running: 2 }] }
      return { rows: [] }
    } }
  } } as unknown as pg.Pool
  const cloud: CloudCiService = { provider: { id: 'github', label: 'GitHub Actions', slots: 16 },
    ready: vi.fn(async () => true) }
  const recordDenied = vi.fn(async () => undefined)
  const service = new ComputerActivityService(pool, '11111111-1111-4111-8111-111111111111', () => null,
    { recordDenied } as unknown as PostgresCommandCoordinator, [cloud])
  return { service, principal, cloud, state, recordDenied }
}

it('checks provider readiness without retaining a database connection and reads running counts afterward', async () => {
  const f = fixture()
  vi.mocked(f.cloud.ready).mockImplementation(async () => {
    expect(f.state.connections).toBe(0)
    return true
  })
  const result = await f.service.list(f.principal, 'mcp')
  expect(result.cloud).toEqual([{ provider: 'github', name: 'GitHub Actions', slots: 16, ready: true, running: 2 }])
  expect(f.state.connections).toBe(0)
})

it('rejects authority revoked during provider readiness before returning activity', async () => {
  const f = fixture()
  vi.mocked(f.cloud.ready).mockImplementation(async () => {
    f.state.revoked = true
    return true
  })
  await expect(f.service.list(f.principal, 'mcp')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  expect(f.state.connections).toBe(0)
})

it('does not probe providers for a caller without settings access', async () => {
  const f = fixture()
  await expect(f.service.list({ ...f.principal, grants: [] }, 'mcp')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.cloud.ready).not.toHaveBeenCalled()
  expect(f.recordDenied).toHaveBeenCalledOnce()
})

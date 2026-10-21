import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ComputerActivityService, type CloudCiService } from './activity.js'

it('returns local activity and the last cloud answer while one shared readiness refresh is pending', async () => {
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'jobs:read', 'runs:read'], scope: {} }] }
  const query = async (text: string) => ({ rows: text.includes('from management_principals')
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
    : [] })
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  let release!: (ready: boolean) => void
  const pending = new Promise<boolean>(resolve => { release = resolve })
  const cloud: CloudCiService = { provider: { id: 'github', label: 'GitHub Actions', slots: 16 },
    ready: vi.fn(async () => true) }
  const service = new ComputerActivityService(pool, '11111111-1111-4111-8111-111111111111', () => null,
    {} as PostgresCommandCoordinator, [cloud])
  expect((await service.list(principal)).cloud).toMatchObject([{ ready: true }])
  vi.mocked(cloud.ready).mockImplementation(() => pending)
  const read = service.list(principal, 'mcp')
  let timer: NodeJS.Timeout | undefined
  try {
    const result = await Promise.race([read, new Promise<'blocked'>(resolve => {
      timer = setTimeout(() => resolve('blocked'), 250)
    })])
    expect(result).not.toBe('blocked')
    expect(result).toMatchObject({ computers: [{ online: true }], cloud: [{ ready: true }] })
    expect((await service.list(principal)).cloud).toMatchObject([{ ready: true }])
    expect(cloud.ready).toHaveBeenCalledTimes(2)
    release(false)
    await pending
    expect((await service.list(principal)).cloud).toEqual([])
  } finally {
    clearTimeout(timer)
    release(false)
    await read
  }
})

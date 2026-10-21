import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { PostgresFileReferenceAuthorization } from '../src/modules/files/references/authorization.js'
import { authorizeSource } from '../src/modules/sources/authority.js'
import { lockActiveWorkspace } from '../src/modules/workspaces/admission.js'

const principal: ManagementPrincipal = {
  id: 'delegate', name: 'Delegate', audience: 'operator', revokedAt: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  grants: [{ actions: ['workspaces:read', 'workspaces:update', 'sources:read'], scope: { workspaceIds: ['own'] } }],
}
function result(rows: Record<string, unknown>[]) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
}
function live(id = principal.id, grants = principal.grants, delegatedFrom: string | null = null) {
  return { id, name: id, audience: 'operator', grants, expires_at: new Date(principal.expiresAt),
    revoked_at: null, delegated_from: delegatedFrom }
}
function fixture() {
  const query = vi.fn()
  const sql: GraphSqlClient = { query }
  return { query, sql }
}

describe('query-only SQL helpers retain authority and workspace boundaries', () => {
  it('intersects the actual delegated chain without needing a raw connection', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce(result([live('delegate', principal.grants, 'owner')]))
      .mockResolvedValueOnce(result([live('owner', [{ actions: ['workspaces:read'], scope: { workspaceIds: ['own'] } }])]))
    const value = await readLiveManagementPrincipal(f.sql, principal.id)
    expect(value.grants).toEqual([{ actions: ['workspaces:read'], scope: { workspaceIds: ['own'] } }])
    expect(f.query.mock.calls.map(([, values]) => values)).toEqual([['delegate'], ['owner']])
    expect(f.query.mock.calls.every(([text]) => text.endsWith('for share'))).toBe(true)
  })

  it('refuses a revoked owner before source ownership or reference metadata can be read', async () => {
    for (const resolve of [
      (sql: GraphSqlClient) => authorizeSource(sql, principal, 'sources:read', 'own'),
      (sql: GraphSqlClient) => new PostgresFileReferenceAuthorization(sql).resolve(principal,
        { kind: 'workspace_reference', workspaceId: 'own' }, 'write'),
    ]) {
      const f = fixture()
      f.query.mockResolvedValueOnce(result([live('delegate', principal.grants, 'owner')]))
        .mockResolvedValueOnce(result([{ ...live('owner'), revoked_at: new Date() }]))
      await expect(resolve(f.sql)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect(f.query).toHaveBeenCalledTimes(2)
    }
  })

  it('rejects foreign scopes and worker audiences before querying', async () => {
    const f = fixture(), references = new PostgresFileReferenceAuthorization(f.sql)
    await expect(authorizeSource(f.sql, principal, 'sources:read', 'foreign')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(references.resolve(principal, { kind: 'workspace_reference', workspaceId: 'foreign' }, 'write'))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(references.resolve({ ...principal, audience: 'worker' },
      { kind: 'workspace_reference', workspaceId: 'own' }, 'read')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.query).not.toHaveBeenCalled()
  })

  it('keeps archive admission serialized and refuses missing or archived workspaces', async () => {
    for (const [rows, code] of [
      [[], 'WORKSPACE_NOT_FOUND'], [[{ archived_at: new Date() }], 'WORKSPACE_ARCHIVED'],
    ] as const) {
      const f = fixture()
      f.query.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([...rows]))
      await expect(lockActiveWorkspace(f.sql, 'own')).rejects.toMatchObject({ code })
      expect(f.query.mock.calls[0]).toEqual(['select pg_advisory_xact_lock(hashtext($1))', ['admission:workspace:own']])
      expect(f.query.mock.calls[1]?.[0]).toContain('for share')
    }
  })

  it('does not change reference files in an archived workspace even with current grants', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce(result([live()])).mockResolvedValueOnce(result([{ archived_at: new Date() }]))
    await expect(new PostgresFileReferenceAuthorization(f.sql).resolve(principal,
      { kind: 'workspace_reference', workspaceId: 'own' }, 'write')).rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' })
    expect(f.query).toHaveBeenCalledTimes(2)
  })
})

import { createHash } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { acceptRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'

function storedPrincipal() {
  const token = 'stored-operator-token'
  const row = {
    id: localHumanPrincipal.id,
    name: 'Stored operator',
    audience: 'operator',
    agent_id: null,
    token_hash: createHash('sha256').update(token).digest('hex'),
    grants: [{ actions: ['settings:read', 'devices:provision'], scope: {} }],
    expires_at: new Date('2099-01-01T00:00:00.000Z'),
    revoked_at: null,
    delegated_from: null,
  }
  const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }))
  const database = { query } as unknown as pg.PoolClient
  const access = new PostgresAccessService({ query } as unknown as pg.Pool)
  return { token, access, database, query }
}

describe('stored principal validation', () => {
  it('rejects retired actions when authenticating a bearer credential', async () => {
    const fixture = storedPrincipal()
    await expect(fixture.access.authenticate(fixture.token)).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects retired actions when reading the local operator authority', async () => {
    const fixture = storedPrincipal()
    await expect(currentOperatorAuthority(fixture.database, localHumanPrincipal.id)).rejects.toBeInstanceOf(ZodError)
  })

  it('rejects retired stored actions before copying authority into a run', async () => {
    const fixture = storedPrincipal()
    await expect(acceptRunAuthority(fixture.database, localHumanPrincipal)).rejects.toBeInstanceOf(ZodError)
    expect(fixture.query).toHaveBeenCalledTimes(1)
  })
})

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PostgresSourceService } from './service.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

// Principal authority has its own tests; this file covers repeated reads of one immutable snapshot.
vi.mock('./authority.js', () => ({ authorizeSource: vi.fn(async () => ({})) }))

it('reuses a verified source snapshot but reports it unavailable once its bytes are released', async () => {
  const mainId = randomUUID()
  const bytes = Buffer.from('export const value = 1\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'source.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const record = { version: 1, workspaceId: 'workspace', ownerPrincipalId: 'owner', approvedByPrincipalId: 'owner',
    locationRevision: 1, mainId, originIdentityHash: `sha256:${'a'.repeat(64)}`, manifest,
    approvedAt: new Date().toISOString(), availability: 'retained' }
  let availability = 'retained'
  const sql: GraphSqlClient = { async query<R extends pg.QueryResultRow>(text: string) {
    const rows = text.includes('application_installation') ? [{ id: mainId }] : [{ record, availability }]
    return { rows: rows as unknown as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  } }
  const sources = new PostgresSourceService(...[{}, {}, {}, {}, mainId, {}, {}, {}] as unknown as
    ConstructorParameters<typeof PostgresSourceService>)
  const principal = { id: 'owner' } as ManagementPrincipal
  const pin = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }

  const first = await sources.resolveApprovedSource(sql, principal, 'workspace', pin)
  const second = await sources.resolveApprovedSource(sql, principal, 'workspace', pin)
  expect(second).toEqual(first)
  second.manifest.entries.length = 0
  expect((await sources.resolveApprovedSource(sql, principal, 'workspace', pin)).manifest.entries).toHaveLength(1)
  availability = 'unavailable'
  await expect(sources.resolveApprovedSource(sql, principal, 'workspace', pin)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
})

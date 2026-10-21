import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { ApprovedSourceSchema, SourceApproveInputSchema } from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { startSqlFixture } from './eng04-start-fixtures.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'

vi.mock('../src/modules/sources/authority.js', () => ({ authorizeSource: vi.fn() }))
vi.mock('../src/modules/sources/capture.js', () => ({
  qualifiedGit: vi.fn(async () => Buffer.from('a'.repeat(40))),
  approvedGitTreePaths: vi.fn(async () => ['script.sh']),
}))

function fixture() {
  const f = startSqlFixture()
  const mainId = randomUUID()
  const input = { workspaceId: f.request.workspaceId, commandId: randomUUID() }
  const location = { ...f.location, locationRevision: 1 }
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('select record from workspaces')) return { rows: [{ record: { id: input.workspaceId, name: 'Project' } }] }
      if (sql.startsWith('select location_revision')) return { rows: [{ location_revision: '1' }] }
      return { rows: [{ archived_at: null }] }
    }),
    release: vi.fn(),
  }
  const receipts = new Map<string, { hash: string; value: unknown }>()
  const commands = {
    execute: vi.fn(async (request: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
      const hash = commandInputHash(request.payload)
      const existing = receipts.get(request.commandId ?? crypto.randomUUID())
      if (existing && existing.hash !== hash) throw new DomainError('COMMAND_ID_CONFLICT', 'Input changed.', 409)
      if (existing) return { value: existing.value, replayed: true }
      const value = await request.perform(client as never)
      receipts.set(request.commandId ?? crypto.randomUUID(), { hash, value })
      return { value, replayed: false }
    }),
  }
  const locations = {
    snapshotAssigned: vi.fn(async () => location),
    revalidateSnapshot: vi.fn(),
  }
  type Dependencies = ConstructorParameters<typeof PostgresSourceService>
  const service = new PostgresSourceService(
    { connect: async () => client } as unknown as pg.Pool,
    commands as unknown as PostgresCommandCoordinator, locations as unknown as Dependencies[2],
    {} as Dependencies[3], mainId, {} as Dependencies[5], {} as Dependencies[6], {} as Dependencies[7],
  )
  vi.spyOn(service, 'approve').mockImplementation(async (_principal, _transport, raw) => {
    const approval = SourceApproveInputSchema.parse(raw)
    return { replayed: false, value: ApprovedSourceSchema.parse({
      version: 1, workspaceId: input.workspaceId, ownerPrincipalId: f.principal.id,
      approvedByPrincipalId: f.principal.id, locationRevision: 1, mainId,
      originIdentityHash: `sha256:${'1'.repeat(64)}`,
      manifest: {
        version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
        capturePolicy: 'git-tree-v1', executablePolicy: approval.executablePolicy,
        git: { commit: approval.commit, tree: 'b'.repeat(40), objectFormat: 'sha1' },
        entries: [], deletions: [], totalEntries: 0, totalBytes: 0, manifestDigest: '1'.repeat(64),
      },
      approvedAt: '2026-10-01T00:00:00.000Z', availability: 'retained',
    }) }
  })
  return { service, principal: f.principal, input }
}

describe('Project source approval', () => {
  it.each(['strip', 'preserve-approved'] as SourceManifest['executablePolicy'][])(
    'carries the selected %s policy into approval', async executablePolicy => {
      const f = fixture()
      const result = await f.service.approveProject(f.principal, { ...f.input, executablePolicy })
      expect(result.manifest.executablePolicy).toBe(executablePolicy)
    },
  )

  it('keeps the default policy for callers without a selection', async () => {
    const f = fixture()
    expect((await f.service.approveProject(f.principal, f.input)).manifest.executablePolicy).toBe('preserve-approved')
  })

  it('approves the supplied commit with its selected executable policy', async () => {
    const f = fixture()
    const commit = 'c'.repeat(40)
    const result = await f.service.approveProject(f.principal, { ...f.input, commit, executablePolicy: 'strip' })
    expect(result.manifest.git?.commit).toBe(commit)
    expect(result.manifest.executablePolicy).toBe('strip')
  })

  it('rejects reuse of the capture command with a changed executable policy', async () => {
    const f = fixture()
    await f.service.approveProject(f.principal, { ...f.input, executablePolicy: 'strip' })
    await expect(f.service.approveProject(f.principal, { ...f.input, executablePolicy: 'preserve-approved' }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })
})

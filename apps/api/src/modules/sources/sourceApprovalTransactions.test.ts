import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ApprovedSource } from '@foreman-code/contracts/source-admission'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { approvedGitTreePaths } from './capture.js'
import { PostgresSourceService } from './service.js'

vi.mock('./authority.js', () => ({
  authorizeSource: async (_sql: unknown, principal: ManagementPrincipal) => ({ principal, ownerId: principal.id }),
}))
vi.mock('./capture.js', async original => {
  const actual = await original<typeof import('./capture.js')>()
  const { createSourceManifest } = await import('./manifest.js')
  return {
    ...actual,
    approvedGitTreePaths: vi.fn(async () => ['source.ts']),
    qualifiedGit: vi.fn(async () => Buffer.from('a'.repeat(40))),
    captureGitSource: vi.fn(async (input: Parameters<typeof actual.captureGitSource>[0]) => createSourceManifest({
      version: 1, approvedSourceId: input.approvedSourceId, snapshotId: input.snapshotId!,
      capturePolicy: 'git-tree-v1', executablePolicy: input.executablePolicy,
      git: { commit: input.commit, tree: 'b'.repeat(40), objectFormat: 'sha1',
        ...(input.repository ? { repository: input.repository } : {}) },
      entries: [{ path: 'source.ts', kind: 'file', byteSize: 1, sha256: 'c'.repeat(64), executable: false }],
      deletions: [],
    })),
  }
})
vi.mock('./gitWorktree.js', async original => ({
  ...await original<typeof import('./gitWorktree.js')>(),
  ensureCommit: async () => '/repository',
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(approvedGitTreePaths).mockReset().mockResolvedValue(['source.ts'])
})

function fixture(repository = true) {
  const mainId = randomUUID()
  const workspaceId = 'workspace'
  const principal: ManagementPrincipal = {
    id: 'operator', name: 'Operator', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }],
  }
  const workspace = { id: workspaceId, name: 'Workspace', ...(repository ? {
    repository: { provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main' },
  } : {}) }
  let revision = 1
  let activeTransactions = 0
  let storedSource: ApprovedSource | undefined
  let exclusiveBlock: Promise<void> | undefined
  const probes: { kind: string; activeTransactions: number }[] = []
  const probe = (kind: string) => { probes.push({ kind, activeTransactions }) }
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.trim().replace(/\s+/g, ' ')
    if (/^begin/i.test(sql)) activeTransactions++
    if (/^(commit|rollback)/i.test(sql)) activeTransactions--
    if (sql.includes('from application_installation')) return { rows: [{ id: mainId }] }
    if (sql.includes('from workspaces')) {
      // Model a concurrent workspace reader: only an exclusive row lock waits for it.
      if (sql.includes('for update')) await exclusiveBlock
      return { rows: [{ record: workspace, location_revision: String(revision), archived_at: null }] }
    }
    if (sql.startsWith('insert into source_snapshots')) storedSource = JSON.parse(values[4] as string)
    if (sql.includes('as pending_bytes')) return { rows: [{ bytes: '0', verification_bytes: '0',
      pending_bytes: '0', preparing: '0', materializations: '0', verification_materializations: '0' }] }
    if (sql.includes('from source_snapshots') && storedSource) {
      return { rows: [{ record: storedSource, availability: 'retained' }] }
    }
    return { rows: [], rowCount: 1 }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { execute: async (input: {
    authorize?(sql: unknown): Promise<void>; perform(sql: unknown): Promise<unknown>
  }) => {
    await input.authorize?.({ query })
    return { value: await input.perform({ query }), replayed: false }
  } } as unknown as PostgresCommandCoordinator
  const location = { runnerId: 'runner-local', rootPath: '/project', locationRevision: 1,
    identityHash: `sha256:${'d'.repeat(64)}` }
  const locations = {
    snapshotAssigned: async () => {
      if (revision !== 1) throw new DomainError('LOCATION_REVISION_CONFLICT', 'Location changed.', 409)
      return location
    },
    snapshot: async () => { probe('directory'); return location },
    revalidateSnapshot: async () => { probe('directory'); },
  }
  const store = {
    storageIdentity: async () => { probe('storage identity'); return { device: '1', inode: '2', mountId: '3' } },
    storageCapacity: async () => {
      probe('capacity')
      return { filesystem: { device: '1', inode: '2', mountId: '3' }, totalBytes: 200 * 2 ** 30,
        availableBytes: 100 * 2 ** 30, availableMemoryBytes: 16 * 2 ** 30,
        cpuCount: 8, observedAt: new Date().toISOString() }
    },
    withCaptureLock: async (_id: string, work: () => Promise<unknown>) => work(),
    manifest: async () => { throw Object.assign(new Error('Missing manifest'), { code: 'ENOENT' }) },
    retainedCaptureBytes: async () => 1,
  }
  const service = new PostgresSourceService(pool, commands, locations as never, store as never, mainId,
    {} as never, {} as never, {} as never)
  const input = { workspaceId, commandId: 'capture-source', expectedLocationRevision: 1,
    commit: 'a'.repeat(40), executablePolicy: 'strip' as const }
  const origin = repository ? { repository: 'fixture/project', clone: '/repository' } : undefined
  return { service, principal, input, origin, probes,
    changeLocation: () => { revision++ },
    blockExclusive: () => {
      let release!: () => void
      exclusiveBlock = new Promise<void>(resolve => { release = resolve })
      return release
    },
  }
}

it.each([true, false])('probes capture storage and directories outside transactions with repository=%s', async repository => {
  const f = fixture(repository)
  const result = await f.service.approve(f.principal, 'mcp', f.input, f.origin)
  expect(result.value.manifest.git?.commit).toBe(f.input.commit)
  expect(f.probes.some(probe => probe.kind === 'capacity')).toBe(true)
  expect(f.probes.filter(probe => probe.activeTransactions !== 0)).toEqual([])
})

it.each(['approve', 'approveProject'] as const)('lets %s capture a repository while another request reads the workspace', async method => {
  const f = fixture()
  const release = f.blockExclusive()
  const capture = method === 'approve'
    ? f.service.approve(f.principal, 'mcp', f.input, f.origin)
    : f.service.approveProject(f.principal, f.input)
  try {
    const outcome = await Promise.race([
      capture.then(() => 'captured'),
      new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 100)),
    ])
    expect(outcome).toBe('captured')
  } finally {
    release()
    await capture
  }
})

it('rejects a changed location between source inventory and reservation', async () => {
  const f = fixture()
  vi.mocked(approvedGitTreePaths).mockImplementationOnce(async () => {
    f.changeLocation()
    return ['source.ts']
  })
  await expect(f.service.approve(f.principal, 'mcp', f.input, f.origin))
    .rejects.toMatchObject({ code: 'SOURCE_APPROVAL_CONFLICT' })
})

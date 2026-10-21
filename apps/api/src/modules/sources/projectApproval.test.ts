import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceApproveInputSchema, type ApprovedSource } from '@foreman-code/contracts/source-admission'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { RegisteredSourceRootPort } from './admissionPorts.js'
import { createSourceManifest } from './manifest.js'
import { PostgresSourceService, type SourceExecutionHostPort } from './service.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { systemGitWorktreePorts } from './gitWorktree.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'

vi.mock('./authority.js', () => ({ authorizeSource: async (_sql: unknown, principal: ManagementPrincipal) =>
  ({ principal, ownerId: principal.id }) }))

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: gitFixtureEnvironment(),
}).trim()

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'project-source-'))
  directories.push(directory)
  const origin = join(directory, 'origin')
  await mkdir(origin)
  git(origin, 'init', '-q', '-b', 'main')
  await writeFile(join(origin, 'main.ts'), 'main branch\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'main')
  const mainCommit = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-qb', 'other')
  await writeFile(join(origin, 'other.ts'), 'other branch\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'other')
  const otherCommit = git(origin, 'rev-parse', 'HEAD')
  git(origin, 'checkout', '-q', 'main')
  const clone = join(directory, 'clone')
  git(directory, 'clone', '-q', '--no-checkout', origin, clone)
  const workspaceId = 'source-workspace'
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Source operator', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [workspaceId] } }] }
  const repository = { provider: 'github' as const, owner: 'octo', name: 'site', defaultBranch: 'main' }
  const query = async () => ({ rows: [{ id: mainId, archived_at: null, location_revision: '1',
    record: { id: workspaceId, name: 'Source workspace', repository } }] })
  const pool = { connect: async () => ({ query, release: () => {} }), query } as unknown as pg.Pool
  const receipts = new Map<string, { hash: string; value: unknown }>()
  const commands = { execute: async (input: {
    operation: string; commandId: string; payload: unknown;
    authorize?(sql: unknown): Promise<void>; perform(sql: unknown): Promise<unknown>
  }) => {
    await input.authorize?.({ query })
    const key = `${input.operation}:${input.commandId}`
    const hash = commandInputHash(input.payload)
    const old = receipts.get(key)
    if (old) {
      if (old.hash !== hash) throw new DomainError('COMMAND_ID_CONFLICT', 'Command input changed.', 409)
      return { value: old.value, replayed: true }
    }
    const value = await input.perform({ query })
    receipts.set(key, { hash, value })
    return { value, replayed: false }
  } } as unknown as PostgresCommandCoordinator
  const service = new PostgresSourceService(pool, commands, {} as WorkspaceLocationService,
    new PrivateSourceSnapshotStore(join(directory, 'storage')), mainId, {} as RegisteredSourceRootPort,
    {} as SourceExecutionHostPort, { confirmedClosed: async () => false })
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  service.git = { ...system, cloneDirectory: () => clone }
  const approved = new Map<string, ApprovedSource>()
  vi.spyOn(service, 'approve').mockImplementation(async (_principal, _transport, raw) => {
    const input = SourceApproveInputSchema.parse(raw)
    const paths = git(clone, 'ls-tree', '-r', '--name-only', input.commit).trim().split('\n')
    let source = approved.get(input.commandId)
    if (!source) {
      const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
        capturePolicy: 'git-tree-v1', executablePolicy: input.executablePolicy, deletions: [],
        git: { commit: input.commit, tree: git(clone, 'rev-parse', `${input.commit}^{tree}`), objectFormat: 'sha1' },
        entries: paths.map(path => ({ path, kind: 'file', executable: false,
          sha256: 'a'.repeat(64), byteSize: 1 })) })
      source = { version: 1, workspaceId, mainId, locationRevision: 1, manifest, availability: 'retained',
        ownerPrincipalId: principal.id, approvedByPrincipalId: principal.id,
        originIdentityHash: 'sha256:' + 'a'.repeat(64), approvedAt: new Date().toISOString() }
      approved.set(input.commandId, source)
    }
    return { value: source, replayed: approved.has(input.commandId) }
  })
  return { service, principal, workspaceId, origin, clone, system, mainCommit, otherCommit }
}

it('approves its own fetched default-branch commit when another fetch changes FETCH_HEAD before resolution', async () => {
  const f = await fixture()
  let fetched = false
  f.service.git.git = async (...args) => {
    const result = await f.system.git(...args)
    if (args[0][0] === 'fetch' && !fetched) {
      fetched = true
      const other = await f.system.git(['fetch', '--no-tags', 'origin', 'other'], args[1])
      expect(other.code).toBe(0)
    }
    return result
  }
  const source = await f.service.approveProject(f.principal, { workspaceId: f.workspaceId, commandId: 'fetch-source' })
  expect(git(f.clone, 'rev-parse', 'FETCH_HEAD')).toBe(f.otherCommit)
  expect(source.manifest.git!.commit).toBe(f.mainCommit)
  expect(source.manifest.entries.map(entry => entry.path)).toEqual(['main.ts'])
  expect(git(f.clone, 'for-each-ref', '--format=%(refname)', 'refs/foreman/ci/fetch/')).toBe('')
})

it('replays a captured default branch after it advances, without fetching replacement source', async () => {
  const f = await fixture()
  const input = { workspaceId: f.workspaceId, commandId: 'retry-source' }
  const source = await f.service.approveProject(f.principal, input)
  await writeFile(join(f.origin, 'main.ts'), 'later main\n')
  git(f.origin, 'commit', '-qam', 'advance main')
  const fetch = vi.spyOn(f.service.git, 'git')
  expect(await f.service.approveProject(f.principal, input)).toEqual(source)
  expect(fetch.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(0)
  await expect(f.service.approveProject(f.principal, { ...input, commit: f.otherCommit }))
    .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
})

it('reports cleanup failure after fetching the default branch successfully', async () => {
  const f = await fixture()
  f.service.git.git = async (...args) => {
    if (args[0][0] === 'update-ref' && args[0][1] === '-d') {
      return { code: 1, stdout: '', stderr: 'Ref cleanup failed' }
    }
    return f.system.git(...args)
  }
  await expect(f.service.approveProject(f.principal, {
    workspaceId: f.workspaceId, commandId: 'cleanup-failure',
  })).rejects.toMatchObject({
    code: 'SOURCE_REPOSITORY_UNAVAILABLE', message: 'Main could not remove its temporary fetch ref.',
  })
})

it('preserves the fetch failure when temporary ref cleanup also fails', async () => {
  const f = await fixture()
  f.service.git.git = async (...args) => {
    if (args[0][0] === 'fetch' || args[0][0] === 'update-ref') {
      return { code: 1, stdout: '', stderr: 'Git operation failed' }
    }
    return f.system.git(...args)
  }
  await expect(f.service.approveProject(f.principal, {
    workspaceId: f.workspaceId, commandId: 'fetch-and-cleanup-failure',
  })).rejects.toMatchObject({
    code: 'SOURCE_REPOSITORY_UNAVAILABLE',
    message: 'Main could not fetch octo/site@main. Sign GitHub in on Main.',
  })
})

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceCommandResultSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../src/modules/errors.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { fixtureGit, fixtureRepository, workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, httpAdd, add, get, clones } from './helpers/workspaceRepositoryOnboarding.js'

describe('workspace repository onboarding: sources', () => {
  it('reuses one retained workspace commit capture across new CI commands and concurrent callers', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const imported = await add(f, input)
      const source = imported.value.approvedSource!
      const operator = await f.issue([{ actions: ['source_roots:bind', 'sources:read', 'workspace_locations:read'],
        scope: { workspaceIds: [input.workspaceId] } }])
      const approvals = () => f.pool.query('select snapshot_id from source_approvals where workspace_id=$1',
        [input.workspaceId])
      const before = await approvals()
      const requests = [f.owner.principal, operator.principal].map(principal => f.sources.approveProject(principal,
        { workspaceId: input.workspaceId, commit: f.commit, commandId: randomUUID() }))
      const captures = await Promise.all(requests)
      expect(captures).toEqual([source, source])
      expect((await approvals()).rows).toEqual(before.rows)
      const read = await callWorkspaceTool(operator.client, 'source_get', ApprovedSourceSchema, {
        workspaceId: input.workspaceId, approvedSourceId: source.manifest.approvedSourceId,
        snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest,
      })
      expect(read).toEqual(source)
      const denied = await f.issue([{ actions: ['sources:read'], scope: { workspaceIds: [input.workspaceId] } }])
      await expect(f.sources.approveProject(denied.principal, { workspaceId: input.workspaceId,
        commit: f.commit, commandId: randomUUID() })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await writeFile(join(f.origin, 'content.txt'), 'changed commit\n')
      fixtureGit(f.origin, 'commit', '-qam', 'advance source')
      const nextCommit = fixtureGit(f.origin, 'rev-parse', 'HEAD')
      const next = await f.sources.approveProject(f.owner.principal, { workspaceId: input.workspaceId,
        commit: nextCommit, commandId: randomUUID() })
      expect(next.manifest.snapshotId).not.toBe(source.manifest.snapshotId)
      expect(next.manifest.git!.commit).toBe(nextCommit)
      expect((await approvals()).rows).toHaveLength(before.rows.length + 1)
      const replayInput = { workspaceId: input.workspaceId, commit: f.commit, commandId: randomUUID() }
      expect(await f.sources.approveProject(f.owner.principal, replayInput)).toEqual(source)
      await f.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [source.manifest.snapshotId])
      await expect(f.sources.approveProject(f.owner.principal, replayInput))
        .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
      const replacement = await f.sources.approveProject(f.owner.principal,
        { ...replayInput, commandId: randomUUID() })
      expect(replacement.manifest.snapshotId).not.toBe(source.manifest.snapshotId)
      expect(replacement.manifest.git!.commit).toBe(f.commit)
    } finally { await f.close() }
  }, 30_000)

  it('reports unsupported trees and a missing branch without publishing metadata or a root', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const missing = { ...input, repository: { ...fixtureRepository, defaultBranch: 'missing' } }
      expect((await httpAdd(f, missing)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_REPOSITORY_BRANCH_NOT_FOUND', newCommandRequired: true, retryable: false } } })
      expect((await httpAdd(f, missing)).status).toBe(409)
      const prepared = await add(f, { ...input, commandId: randomUUID() })
      expect(prepared.value.state).toBe('ready')
      await symlink('content.txt', join(f.origin, 'link.txt'))
      fixtureGit(f.origin, 'add', '.')
      fixtureGit(f.origin, 'commit', '-qm', 'unsupported tree')
      const current = await callWorkspaceTool(f.owner.client, 'workspace_get', ManagedWorkspaceSchema, { workspaceId: input.workspaceId })
      const location = prepared.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a root policy.')
      const unsupported = { ...input, commandId: randomUUID(), expectedRevision: current.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: prepared.value.rootBinding!.bindingRevision }
      expect((await httpAdd(f, unsupported)).status).toBe(400)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: unsupported.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_GIT_TREE_UNSUPPORTED', newCommandRequired: true, retryable: false } } })
      expect((await callWorkspaceTool(f.owner.client, 'workspace_get', ManagedWorkspaceSchema,
        { workspaceId: input.workspaceId })).revision).toBe(current.revision)
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect((await httpAdd(f, unsupported)).status).toBe(409)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('requires a new attempt after a quarantined source capture failure', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      vi.spyOn(f.sources, 'approveProject').mockRejectedValueOnce(new DomainError('SOURCE_CAPTURE_FAILED',
        'This source capture failed. Start a new import.', 409, { newCommandRequired: true }))
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { phase: 'location', failure: { newCommandRequired: true, retryable: false } } })
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(clones(f)).toBe(1)
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('keeps transport failures retryable and releases unsupported content for a corrected new import', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const git = f.sources.git.git.bind(f.sources.git)
      let offline = true
      f.sources.git.git = (args, options) => offline && (args.includes('fetch') || args.includes('ls-remote'))
        ? Promise.resolve({ code: 128, stdout: '', stderr: 'Authentication or transport unavailable' })
        : git(args, options)
      expect((await httpAdd(f, input)).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_REPOSITORY_UNAVAILABLE', retryable: true, newCommandRequired: false } } })
      offline = false
      const previous = await add(f, input)
      fixtureGit(f.origin, 'branch', 'supported')
      await writeFile(join(f.origin, 'blocked.txt'), '-----BEGIN RSA PRIVATE KEY-----\nfixture bytes\n')
      fixtureGit(f.origin, 'add', '.')
      fixtureGit(f.origin, 'commit', '-qm', 'unsupported content')
      const location = previous.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a prepared root.')
      const replacement = { ...input, commandId: randomUUID(), expectedRevision: previous.value.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: previous.value.rootBinding!.bindingRevision }
      expect((await httpAdd(f, replacement)).status).toBe(400)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'SOURCE_SECRET_CONTENT', newCommandRequired: true, retryable: false } } })
      const corrected = await add(f, { ...replacement, commandId: randomUUID(),
        repository: { ...fixtureRepository, defaultBranch: 'supported' } })
      expect(corrected.value.state).toBe('ready')
      expect(corrected.value.approvedSource!.manifest.entries.map(entry => entry.path)).not.toContain('blocked.txt')
    } finally {
      await f.close()
    }
  }, 30_000)

  it('invalidates ready readback after unlinking metadata and preserves the clone and approved snapshot', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const saved = await add(f, input)
      const renamed = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, name: 'Renamed project' })
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'ready', revision: renamed.value.revision })
      await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: renamed.value.revision, repository: null })
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'conflict', repository: null })
      expect((await add(f, input)).value.state).toBe('conflict')
      const location = saved.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a project root.')
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      const pin = saved.value.approvedSource!.manifest
      expect(await callWorkspaceTool(f.owner.client, 'source_get', ApprovedSourceSchema,
        { workspaceId: input.workspaceId, approvedSourceId: pin.approvedSourceId,
          snapshotId: pin.snapshotId, manifestDigest: pin.manifestDigest })).toEqual(saved.value.approvedSource)
    } finally {
      await f.close()
    }
  }, 30_000)
})

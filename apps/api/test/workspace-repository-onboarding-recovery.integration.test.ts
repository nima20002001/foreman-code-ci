import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { WorkspaceRepositoryReadResultSchema } from '@foreman-code/contracts/workspace-git'
import { REPOSITORY_READ_ACTIONS } from '../src/modules/workspaces/repositoryService.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { fixtureGit, workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, httpAdd, add, get, clones } from './helpers/workspaceRepositoryOnboarding.js'

describe('workspace repository onboarding: recovery', () => {
  it('recovers a committed location with a lost acknowledgment and keeps its original commit after branch advancement', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const set = f.roots.set.bind(f.roots)
      vi.spyOn(f.roots, 'set').mockImplementationOnce(async (...args) => {
        await set(...args)
        throw new Error('Location acknowledgment lost')
      })
      expect((await httpAdd(f, input)).status).toBe(500)
      const failed = await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })
      expect(failed).toMatchObject({ state: 'failed', operation: { phase: 'metadata', commit: f.commit,
        failure: { retryable: true, newCommandRequired: false } } })
      await writeFile(join(f.origin, 'content.txt'), 'branch moved\n')
      fixtureGit(f.origin, 'commit', '-qam', 'advance branch')
      const fetches = f.gitCalls.filter(args => args.includes('fetch')).length
      f.services.workspaceRepositories = f.recreate()
      const saved = await add(f, input)
      expect(saved.value).toMatchObject({ state: 'ready', operation: { commit: f.commit },
        location: { locationRevision: input.expectedLocationRevision + 1 } })
      expect(saved.value.approvedSource!.manifest.git!.commit).toBe(f.commit)
      expect(clones(f)).toBe(1)
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetches)
      const captures = await f.pool.query('select snapshot_id from source_approvals where workspace_id=$1', [input.workspaceId])
      expect(captures.rows).toHaveLength(1)
      expect(await add(f, input)).toEqual({ ...saved, replayed: true })
    } finally {
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)

  it('recovers the fetched commit when resolution was interrupted before the journal recorded it', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const git = f.sources.git.git.bind(f.sources.git)
      let interrupted = false
      f.sources.git.git = async (args, options) => {
        const result = await git(args, options)
        if (args.includes('fetch') && !interrupted) {
          interrupted = true
          throw new Error('Interrupted after fetch wrote its recovery reference')
        }
        return result
      }
      expect((await httpAdd(f, input)).status).toBe(500)
      await writeFile(join(f.origin, 'content.txt'), 'a later branch commit\n')
      fixtureGit(f.origin, 'commit', '-qam', 'advance after interruption')
      const fetched = f.gitCalls.filter(args => args.includes('fetch')).length
      f.services.workspaceRepositories = f.recreate()
      const saved = await add(f, input)
      expect(saved.value).toMatchObject({ state: 'ready', operation: { commit: f.commit } })
      expect(saved.value.approvedSource!.manifest.git!.commit).toBe(f.commit)
      expect(f.gitCalls.filter(args => args.includes('fetch'))).toHaveLength(fetched)
      expect(clones(f)).toBe(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('serializes different commands for one workspace while Git is outside row-locking transactions', async () => {
    const f = await workspaceRepositoryFixture()
    let release!: () => void
    try {
      const input = await workspace(f)
      let reached!: () => void
      const fetching = new Promise<void>(resolve => { reached = resolve })
      const pause = new Promise<void>(resolve => { release = resolve })
      const git = f.sources.git.git.bind(f.sources.git)
      f.sources.git.git = async (args, options) => {
        if (args.includes('fetch')) {
          reached()
          await pause
        }
        return git(args, options)
      }
      const first = add(f, input)
      await fetching
      expect((await httpAdd(f, { ...input, commandId: randomUUID() })).status).toBe(409)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'preparing' })
      const edited = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: randomUUID(), expectedRevision: input.expectedRevision, name: 'Concurrent edit' })
      expect(edited.value.revision).toBe(input.expectedRevision + 1)
      release()
      await expect(first).rejects.toThrow('REVISION_CONFLICT')
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { newCommandRequired: true } } })
    } finally {
      release?.()
      await f.close()
    }
  }, 30_000)

  it('shows unfinished replacement progress after reload and gives retry input only to its initiating principal', async () => {
    const f = await workspaceRepositoryFixture()
    let release!: () => void
    try {
      const input = await workspace(f)
      const previous = await add(f, input)
      const location = previous.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected the previous project root.')
      const replacement = { ...input, commandId: randomUUID(), expectedRevision: previous.value.revision,
        expectedLocationRevision: location.locationRevision, expectedRootPolicyRevision: Number(location.binding.rootPolicyRevision),
        expectedBindingRevision: previous.value.rootBinding!.bindingRevision }
      let reached!: () => void
      const fetching = new Promise<void>(resolve => { reached = resolve })
      const pause = new Promise<void>(resolve => { release = resolve })
      const git = f.sources.git.git.bind(f.sources.git)
      f.sources.git.git = async (args, options) => {
        if (args.includes('fetch')) {
          reached()
          await pause
        }
        return git(args, options)
      }
      vi.spyOn(f.services.workspaces, 'update').mockRejectedValueOnce(new Error('Replacement update interrupted'))
      const pending = httpAdd(f, replacement)
      await fetching
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'preparing',
        operation: { commandId: replacement.commandId, retryInput: replacement } })
      const other = await f.issue([{ actions: [...REPOSITORY_READ_ACTIONS], scope: { workspaceIds: [input.workspaceId] } }])
      const progress = await callWorkspaceTool(other.client, 'workspace_repository_get', WorkspaceRepositoryReadResultSchema,
        { workspaceId: input.workspaceId })
      expect(progress).toMatchObject({ state: 'preparing', operation: { commandId: replacement.commandId } })
      expect(progress.operation?.retryInput).toBeUndefined()
      release()
      expect((await pending).status).toBe(500)
      f.services.workspaceRepositories = f.recreate()
      const failure = await get(f, { workspaceId: input.workspaceId })
      expect(failure).toMatchObject({ state: 'failed', operation: { commandId: replacement.commandId,
        retryInput: replacement, failure: { code: 'INTERNAL_ERROR', retryable: true } } })
      const sql = await f.pool.connect()
      try {
        await sql.query('begin')
        expect(await f.services.workspaceRepositories.readyRoot(f.owner.principal, input.workspaceId, sql))
          .toEqual(previous.value.rootBinding)
        await sql.query('commit')
      } finally {
        await sql.query('rollback')
        sql.release()
      }
      const resumed = await add(f, failure.operation!.retryInput!)
      expect(resumed.value.state).toBe('ready')
      expect(resumed.value.operation!.commandId).toBe(replacement.commandId)
      expect(resumed.value.operation!.retryInput).toEqual(replacement)
    } finally {
      release?.()
      vi.restoreAllMocks()
      await f.close()
    }
  }, 30_000)


})

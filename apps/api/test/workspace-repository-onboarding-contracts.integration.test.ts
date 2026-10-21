import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { WorkspaceRepositoryAddResultSchema } from '@foreman-code/contracts/workspace-git'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { REPOSITORY_ADD_ACTIONS } from '../src/modules/workspaces/repositoryService.js'
import { repositorySubcommand } from '../src/modules/workspaces/repositoryRecovery.js'
import { callWorkspaceTool } from './helpers/workspaceMcp.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { fixtureGit, fixtureRepository, workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, httpAdd, add, get, clones } from './helpers/workspaceRepositoryOnboarding.js'

describe('workspace repository onboarding: contracts', () => {
  it('prepares a raw tracked project in one HTTP call, replays through MCP, and reads fresh persisted state', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const previous = join(f.parentPath, 'manual-project')
      await mkdir(previous, { mode: 0o700 })
      await writeFile(join(previous, 'keep.txt'), 'keep the user project\n')
      const previousLocation = await f.services.locations.set(f.owner.principal, 'http', {
        workspaceId: input.workspaceId, commandId: randomUUID(), expectedLocationRevision: input.expectedLocationRevision,
        runnerId: f.services.locations.runnerId, rootPath: previous,
      })
      input.expectedLocationRevision = previousLocation.value.locationRevision
      const response = await httpAdd(f, input)
      expect(response.status).toBe(200)
      const saved = WorkspaceRepositoryAddResultSchema.parse(await response.json())
      expect(saved).toMatchObject({ replayed: false, value: { state: 'ready', repository: fixtureRepository,
        revision: input.expectedRevision + 1, operation: { phase: 'ready', commit: f.commit } } })
      const location = saved.value.location!
      if (location.evidence !== 'bound') throw new Error('Expected a bound project.')
      expect(await readFile(join(location.executionLocation.rootPath, 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
      expect(fixtureGit(location.executionLocation.rootPath, 'rev-parse', 'HEAD')).toBe(f.commit)
      expect(fixtureGit(location.executionLocation.rootPath, 'diff', '--exit-code')).toBe('')
      expect(saved.value.approvedSource!.manifest.entries.map(entry => entry.path)).toEqual([
        '.gitattributes', 'content.txt', 'run.sh',
      ])
      expect(saved.value.approvedSource!.manifest.entries.find(entry => entry.path === 'run.sh')!.executable).toBe(true)
      const pin = saved.value.approvedSource!.manifest
      const root = await callWorkspaceTool(f.owner.client, 'source_root_get', SourceRootRecordSchema,
        { workspaceId: input.workspaceId, ...saved.value.rootBinding! })
      expect(root.source).toEqual({ approvedSourceId: pin.approvedSourceId, snapshotId: pin.snapshotId,
        manifestDigest: pin.manifestDigest })
      expect(root.binding.accessMode).toBe('exclusive-write')
      expect(root.binding.canonicalPath).not.toBe(location.executionLocation.rootPath)
      expect(await add(f, input)).toEqual({ ...saved, replayed: true })
      expect(clones(f)).toBe(1)
      f.services.workspaceRepositories = f.recreate()
      expect(await get(f, { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(await f.recreate().get(f.owner.principal, 'http', { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(await readFile(join(previous, 'keep.txt'), 'utf8')).toBe('keep the user project\n')
      const audits = await f.pool.query<{ source: string; action: string }>(
        "select source,action from management_audit where target_key like $1 and outcome='succeeded'",
        [`%${input.workspaceId}%`])
      expect(audits.rows.some(row => row.action === 'workspace.repository.add' && row.source === 'http')).toBe(true)
      expect(audits.rows.filter(row => row.action === 'source.approve')).toEqual([
        { source: 'http', action: 'source.approve' },
      ])
    } finally {
      await f.close()
    }
  }, 30_000)

  it('requires all overlapping grants through authenticated MCP and HTTP before cloning', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [input.workspaceId] } }])
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_repository_get', arguments: { workspaceId: input.workspaceId } }))
      expect((await httpAdd(f, input, reader.token)).status).toBe(403)
      const incomplete = await f.issue([{ actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'),
        scope: { workspaceIds: [input.workspaceId] } }])
      expect((await incomplete.client.listTools()).tools.some(tool => tool.name === 'workspace_repository_add')).toBe(false)
      await expectMcpAccessDenied(incomplete.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      expect((await httpAdd(f, input, incomplete.token)).status).toBe(403)
      const disjoint = await f.issue([
        { actions: REPOSITORY_ADD_ACTIONS.filter(action => action !== 'sources:approve'), scope: { workspaceIds: [input.workspaceId] } },
        { actions: ['sources:approve'], scope: { workspaceIds: ['other-workspace'] } },
      ])
      expect((await disjoint.client.listTools()).tools.some(tool => tool.name === 'workspace_repository_add')).toBe(false)
      expect((await httpAdd(f, input, disjoint.token)).status).toBe(403)
      const foreign = await f.issue([{ actions: [...REPOSITORY_ADD_ACTIONS], scope: { workspaceIds: ['other-workspace'] } }])
      await expectMcpAccessDenied(foreign.client.callTool({ name: 'workspace_repository_add', arguments: input }))
      expect((await httpAdd(f, input, foreign.token)).status).toBe(403)
      expect(clones(f)).toBe(0)
      expect(await get(f, { workspaceId: input.workspaceId })).toMatchObject({ state: 'unconfigured', revision: input.expectedRevision })
      const denied = await f.pool.query("select 1 from management_audit where outcome='denied' limit 1")
      expect(denied.rows).toHaveLength(1)
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rejects a preused derived subcommand ID instead of adopting an unrelated receipt', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      const edited = await callWorkspaceTool(f.owner.client, 'workspace_update', ManagedWorkspaceCommandResultSchema,
        { workspaceId: input.workspaceId, commandId: repositorySubcommand(input, 'metadata'),
          expectedRevision: input.expectedRevision, name: 'Different operation' })
      input.expectedRevision = edited.value.revision
      const response = await httpAdd(f, input)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
      expect(clones(f)).toBe(0)
      expect(await get(f, { workspaceId: input.workspaceId, commandId: input.commandId })).toMatchObject({ state: 'failed',
        operation: { failure: { code: 'COMMAND_ID_CONFLICT', newCommandRequired: true } } })
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rejects stale revisions and changed input without replacing completed facts', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      const input = await workspace(f)
      for (const changed of [
        { expectedRevision: input.expectedRevision + 1 }, { expectedLocationRevision: 1 },
        { expectedRootPolicyRevision: 1 }, { expectedBindingRevision: 1 },
      ]) {
        expect((await httpAdd(f, { ...input, ...changed, commandId: randomUUID() })).status).toBe(409)
      }
      expect(clones(f)).toBe(0)
      const saved = await add(f, input)
      const conflict = await f.owner.client.callTool({ name: 'workspace_repository_add', arguments: {
        ...input, repository: { ...fixtureRepository, defaultBranch: 'other' },
      } })
      expect(conflict).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('COMMAND_ID_CONFLICT') }] })
      expect(await get(f, { workspaceId: input.workspaceId })).toEqual(saved.value)
      expect(clones(f)).toBe(1)
    } finally {
      await f.close()
    }
  }, 30_000)


})

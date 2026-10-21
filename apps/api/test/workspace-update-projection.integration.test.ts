import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import * as contracts from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

describe('workspace update location projection through authenticated MCP', () => {
  it('returns the saved location for rename and description commands and their replays', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Configured', parentPath: f.parentPath })
      const workspaceId = created.value.workspace.id
      let revision = created.value.revision
      for (const changes of [{ name: 'Renamed' }, { description: 'Updated description' }]) {
        const input = { workspaceId, commandId: randomUUID(), expectedRevision: revision, ...changes }
        const updated = await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
        const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
        expect(updated.value.workspace).toEqual(readback.workspace)
        expect(updated.value.revision).toBe(readback.revision)
        expect(updated.value.executionLocation).toEqual(readback.executionLocation)
        expect(updated.value.executionLocation).toEqual(created.value.executionLocation)
        expect(updated.value.locationRevision).toBe(readback.locationRevision)
        expect(updated.value.locationRevision).toBe(1)
        expect(updated.value.locationValidation.status).toBe('ready')
        expect(readback.locationValidation.status).toBe('ready')
        const replayed = await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
        expect(replayed).toEqual({ ...updated, replayed: true })
        const stored = (await f.pool.query(`select result from management_command_receipts
          where principal_id = $1 and operation = 'workspace.update' and command_id = $2`,
        [f.owner.principal.id, input.commandId])).rows[0].result
        expect(stored).toEqual(updated.value)
        revision = updated.value.revision
      }
    } finally { await f.close() }
  }, 30_000)

  it('preserves the command location snapshot when the saved location changes later', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Original location', parentPath: f.parentPath })
      const workspaceId = created.value.workspace.id
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, name: 'Renamed' }
      const updated = await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
      const rootPath = join(f.parentPath, 'Later location')
      await mkdir(rootPath)
      await callWorkspaceTool(f.owner.client, 'workspace_location_set', contracts.WorkspaceLocationSetResultSchema, {
        workspaceId, commandId: randomUUID(), expectedLocationRevision: 1, runnerId: 'runner-local', rootPath,
      })
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(readback.locationRevision).toBe(2)
      expect(readback.executionLocation?.rootPath).toBe(rootPath)
      expect(await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input))
        .toEqual({ ...updated, replayed: true })
    } finally { await f.close() }
  }, 30_000)

  it('redacts location details for metadata-only writers on new commands and receipt replay', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Private path', parentPath: f.parentPath })
      const workspaceId = created.value.workspace.id
      const caller = await f.issue([{ actions: ['workspaces:update', 'workspaces:read', 'workspace_locations:read'],
        scope: { workspaceIds: [workspaceId] } }])
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, name: 'First rename' }
      const updated = await callWorkspaceTool(caller.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
      expect(updated.value.executionLocation).toEqual(created.value.executionLocation)
      await f.pool.query('update management_principals set grants = $2::jsonb where id = $1',
        [caller.principal.id, JSON.stringify([{ actions: ['workspaces:read', 'workspaces:update'], scope: { workspaceIds: [workspaceId] } }])])
      const replayed = await callWorkspaceTool(caller.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, input)
      expect(replayed.replayed).toBe(true)
      expect(replayed.value.executionLocation).toBeNull()
      expect(replayed.value.locationRevision).toBe(0)
      expect(replayed.value.locationValidation).toEqual({ status: 'restricted' })
      expect(replayed.value.workspace).toEqual(updated.value.workspace)
      const next = await callWorkspaceTool(caller.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, {
        workspaceId, commandId: randomUUID(), expectedRevision: updated.value.revision, description: 'Metadata only',
      })
      const restricted = await callWorkspaceTool(caller.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(next.value).toEqual(restricted)
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(readback.executionLocation).toEqual(created.value.executionLocation)
      expect(readback.locationRevision).toBe(1)
      expect(readback.locationValidation.status).toBe('ready')
      expect(readback.workspace.description).toBe('Metadata only')
    } finally { await f.close() }
  }, 30_000)

  it('rejects an out-of-scope writer without changing metadata or location', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Unchanged', parentPath: f.parentPath })
      const workspaceId = created.value.workspace.id
      const caller = await f.issue([{ actions: ['workspaces:update'], scope: { workspaceIds: ['different-workspace'] } }])
      expect((await caller.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, name: 'Denied',
      } })).isError).toBe(true)
      const readback = await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect(readback.workspace).toEqual(created.value.workspace)
      expect(readback.revision).toBe(created.value.revision)
      expect(readback.executionLocation).toEqual(created.value.executionLocation)
      expect(readback.locationRevision).toBe(1)
    } finally { await f.close() }
  }, 30_000)

  it('sets, reads back and clears the public CI mirror, and denies an out-of-scope writer', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Mirrored', parentPath: f.parentPath })
      const workspaceId = created.value.workspace.id
      const ciMirror = { provider: 'github', owner: 'octo-owner', name: 'website-ci' }
      const denied = await f.issue([{ actions: ['workspaces:update'], scope: { workspaceIds: ['different-workspace'] } }])
      expect((await denied.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, ciMirror } })).isError).toBe(true)
      const set = await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema,
        { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, ciMirror })
      expect(set.value.workspace.ciMirror).toEqual(ciMirror)
      expect((await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId }))
        .workspace.ciMirror).toEqual(ciMirror)
      const cleared = await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema,
        { workspaceId, commandId: randomUUID(), expectedRevision: set.value.revision, ciMirror: null })
      expect(cleared.value.workspace.ciMirror).toBeUndefined()
      expect((await callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId }))
        .workspace.ciMirror).toBeUndefined()
    } finally { await f.close() }
  }, 30_000)
})

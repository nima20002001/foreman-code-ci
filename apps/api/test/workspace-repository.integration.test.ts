import { randomUUID } from 'node:crypto'
import * as contracts from '@foreman-code/contracts/management'
import { describe, expect, it } from 'vitest'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { callWorkspaceTool, workspaceMcpFixture } from './helpers/workspaceMcp.js'

describe('repository settings through authenticated MCP', () => {
  it('persists edits and removals, replays retries, and rejects stale or denied writes', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Repository settings' })
      const workspaceId = created.value.workspace.id
      const repository = { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
      const input = { workspaceId, commandId: randomUUID(), expectedRevision: created.value.revision, repository }
      const saved = await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, input)
      const read = () => callWorkspaceTool(f.owner.client, 'workspace_get', contracts.ManagedWorkspaceSchema, { workspaceId })
      expect((await read()).workspace.repository).toEqual(repository)
      expect(await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, input)).toEqual({ ...saved, replayed: true })
      expect((await read()).revision).toBe(saved.value.revision)

      const reader = await f.issue([{ actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } }])
      await expectMcpAccessDenied(reader.client.callTool({ name: 'workspace_update', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, repository: null,
      } }))
      expect((await read()).workspace.repository).toEqual(repository)

      const changed = { ...repository, defaultBranch: 'release/v1.2' }
      expect(await f.owner.client.callTool({ name: 'workspace_update', arguments: {
        ...input, commandId: randomUUID(), repository: changed,
      } })).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('REVISION_CONFLICT') }] })
      expect((await read()).workspace.repository).toEqual(repository)
      const updated = await callWorkspaceTool(f.owner.client, 'workspace_update',
        contracts.ManagedWorkspaceCommandResultSchema, {
          workspaceId, commandId: randomUUID(), expectedRevision: saved.value.revision, repository: changed,
        })
      expect((await read()).workspace.repository).toEqual(changed)
      await callWorkspaceTool(f.owner.client, 'workspace_update', contracts.ManagedWorkspaceCommandResultSchema, {
        workspaceId, commandId: randomUUID(), expectedRevision: updated.value.revision, repository: null,
      })
      expect((await read()).workspace.repository).toBeUndefined()
    } finally {
      await f.close()
    }
  }, 30_000)

  it('rejects invalid repository fields and Git base branches through HTTP and MCP', async () => {
    const f = await workspaceMcpFixture()
    try {
      const created = await callWorkspaceTool(f.owner.client, 'workspace_create',
        contracts.ManagedWorkspaceCommandResultSchema, { commandId: randomUUID(), name: 'Repository validation' })
      const workspaceId = created.value.workspace.id
      const repository = { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
      for (const invalid of [
        { ...repository, name: 'website/extra' },
        { ...repository, name: 'website/tree/main' },
        { ...repository, owner: 'https://github.com/octo-owner' },
        ...['release..stable', 'release/', 'release.lock', 'feature:broken', ''].map(defaultBranch =>
          ({ ...repository, defaultBranch })),
      ]) {
        const input = { workspaceId, expectedRevision: created.value.revision, repository: invalid }
        expect((await f.owner.client.callTool({ name: 'workspace_update', arguments: {
          ...input, commandId: randomUUID(),
        } })).isError).toBe(true)
        const response = await fetch(new URL(`/api/management/workspaces/${workspaceId}`, f.address), {
          method: 'PATCH',
          headers: { authorization: `Bearer ${f.owner.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, commandId: randomUUID() }),
        })
        expect(response.status).toBe(400)
        const readback = await callWorkspaceTool(f.owner.client, 'workspace_get',
          contracts.ManagedWorkspaceSchema, { workspaceId })
        expect(readback.workspace.repository).toBeUndefined()
        expect(readback.revision).toBe(created.value.revision)
      }
    } finally {
      await f.close()
    }
  }, 30_000)
})

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkspaceRepositoryAddResultSchema, WorkspaceRepositoryReadResultSchema } from '@foreman-code/contracts/workspace-git'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceCommandResultSchema, ManagementActionSchema } from '@foreman-code/contracts/management'
import { SavedManagedWorkflowCommandResultSchema, SavedManagedWorkflowSchema } from '@foreman-code/contracts/wave25'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { workspaceRepositoryFixture, fixtureRepository } from './helpers/workspaceRepository.js'
import { setup } from './helpers/workflowWorktreeMcp.js'

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP: creation', () => {
  it('copies a prepared repository through the domain services and keeps grants conditional', async () => {
    const f = await workspaceRepositoryFixture()
    try {
      f.services.workflows = new WorkflowManagementService(f.pool, f.commands, { worktrees: {
        readyRoot: (principal, workspaceId, sql) => f.repositories.readyRoot(principal, workspaceId, sql),
        sources: f.sources, roots: f.policies,
      } })
      const workspaceResponse = await f.owner.client.callTool({ name: 'workspace_create', arguments: {
        commandId: randomUUID(), name: 'Imported workflow project',
      } })
      expect(workspaceResponse.isError).not.toBe(true)
      const workspace = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(workspaceResponse)).value
      const creator = await f.issue([{ actions: ['workflows:create'], scope: { workspaceIds: [workspace.workspace.id] } }])
      const empty = await creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'No prepared project',
      } })
      expect(empty.isError, JSON.stringify(empty)).not.toBe(true)
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(empty)).value.workflow)
        .not.toHaveProperty('defaultWorktree')
      const preparedResponse = await f.owner.client.callTool({ name: 'workspace_repository_add', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), expectedRevision: workspace.revision,
        expectedLocationRevision: workspace.locationRevision, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
        repository: fixtureRepository, allowedBaseId: f.allowlist.bases[0]!.baseId,
        configurationRevision: f.allowlist.configurationRevision,
      } })
      expect(preparedResponse.isError, JSON.stringify(preparedResponse)).not.toBe(true)
      const prepared = WorkspaceRepositoryAddResultSchema.parse(decodeMcpToolResult(preparedResponse)).value
      expect(prepared.state).toBe('ready')
      const projectRead = await f.owner.client.callTool({ name: 'workspace_repository_get', arguments: {
        workspaceId: workspace.workspace.id,
      } })
      expect(WorkspaceRepositoryReadResultSchema.parse(decodeMcpToolResult(projectRead)).rootBinding)
        .toEqual(prepared.rootBinding)
      const createdResponse = await f.owner.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Prepared source',
      } })
      expect(createdResponse.isError, JSON.stringify(createdResponse)).not.toBe(true)
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(createdResponse)).value
      expect(created.workflow.defaultWorktree).toEqual({ rootBinding: prepared.rootBinding })
      const read = await f.owner.client.callTool({ name: 'workflow_get', arguments: {
        workspaceId: workspace.workspace.id, workflowId: created.workflow.id,
      } })
      expect(SavedManagedWorkflowSchema.parse(decodeMcpToolResult(read)).workflow.defaultWorktree)
        .toEqual(created.workflow.defaultWorktree)
      await expectMcpAccessDenied(creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Missing project grants',
      } }))
      const optedOut = await creator.client.callTool({ name: 'workflow_create', arguments: {
        workspaceId: workspace.workspace.id, commandId: randomUUID(), name: 'Explicit opt-out', defaultWorktree: null,
      } })
      expect(optedOut.isError).not.toBe(true)
      expect(SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(optedOut)).value.workflow)
        .not.toHaveProperty('defaultWorktree')
    } finally { await f.close() }
  }, 30_000)

  it('supports explicit creation opt-out and denies missing selection grants and read-only writers', async () => {
    const f = await setup()
    try {
      expect((await f.create(null)).created.value.workflow).not.toHaveProperty('defaultWorktree')
      const created = await f.create({ rootBinding: f.placement.remote.rootBinding!, branchPrefix: 'foreman/remote' })
      expect(created.created.value.workflow.defaultWorktree?.rootBinding).toEqual(f.placement.remote.rootBinding)
      const deniedActions = ['sources:read', 'source_roots:read', 'workspace_locations:read'] as const
      for (const missing of deniedActions) {
        const issued = await f.base.access.issue({ name: `Missing ${missing}`, audience: 'operator',
          expiresAt: new Date(Date.now() + 600000), grants: [{
            actions: ManagementActionSchema.options.filter(action => action !== missing), scope: { workspaceIds: [f.workspaceId] },
          }] })
        const client = await f.base.connect(issued.token)
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_create', arguments: {
          workspaceId: f.workspaceId, commandId: randomUUID(), name: 'Denied configured workflow',
          defaultWorktree: { rootBinding: f.placement.local.rootBinding },
        } }))
        await expectMcpAccessDenied(client.callTool({ name: 'workflow_save_v3', arguments: created.saveInput }))
      }
      const reader = await f.base.access.issue({ name: 'Read-only workflow caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [f.workspaceId] } }] })
      const readerClient = await f.base.connect(reader.token)
      await expectMcpAccessDenied(readerClient.callTool({ name: 'workflow_save_v3', arguments: created.saveInput }))
      expect((await f.base.db.pool.query<{ outcome: string }>(
        "select outcome from management_audit where principal_id=$1 and action='workflow_save_v3'",
        [reader.principal.id])).rows).toEqual([{ outcome: 'denied' }])
    } finally { await f.close() }
  }, 30_000)
})

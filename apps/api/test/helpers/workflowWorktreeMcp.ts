import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Client } from '@modelcontextprotocol/client'
import { expect } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  SavedManagedWorkflowCommandResultSchema,
  makeCurrentWorkflowFixture, type CurrentWorkflowSaveInput,
} from '@foreman-code/contracts/wave25'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import type { ProviderAccountConfigurationService } from '../../src/modules/harnesses/providerAccountConfiguration.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

export const repository = { provider: 'github' as const, owner: 'octo-owner', name: 'website', defaultBranch: 'main' }

export async function setup(options: {
  sourceAccessMode?: 'read-only' | 'exclusive-write'
  accountConfigurations?: ProviderAccountConfigurationService
} = {}) {
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'),
    agentManagement: true })
  const directory = await privateFixtureDirectory('workflow-worktree-')
  try {
    const placement = await mixedComputerPlacement(base, directory, {
      git: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1', repository: 'octo-owner/website' },
      sourceAccessMode: options.sourceAccessMode ?? 'exclusive-write',
    })
    const workspaceId = base.f.scope.workspaceId
    const workspace = await base.services.workspaces.get(base.writer.principal, workspaceId)
    await base.services.workspaces.update(base.writer.principal, 'mcp', {
      workspaceId, commandId: randomUUID(), expectedRevision: workspace.revision, repository,
    })
    const services = { readyRoot: async () => placement.local.rootBinding,
      sources: placement.sources, roots: placement.policies }
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: services, accountConfigurations: options.accountConfigurations,
    })
    async function create(defaultWorktree?: Parameters<typeof base.services.workflows.create>[2]['defaultWorktree']) {
      const input = { workspaceId, commandId: randomUUID(), name: 'Worktree workflow',
        ...(defaultWorktree === undefined ? {} : { defaultWorktree }) }
      const result = await base.client.callTool({ name: 'workflow_create', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const created = SavedManagedWorkflowCommandResultSchema.parse(decodeMcpToolResult(result))
      const graph = { ...base.f.version.definition, ...created.value.workflow,
        version: created.value.workflow.version,
        nodes: base.f.version.definition.nodes, edges: base.f.version.definition.edges,
        entryNodeId: base.f.version.definition.entryNodeId,
        approval: base.f.version.definition.approval,
        executionPolicy: base.f.version.definition.executionPolicy }
      const saveInput: CurrentWorkflowSaveInput = {
        workspaceId, workflowId: created.value.workflow.id, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: created.value.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: base.f.version.agentConfigurationVersionIds,
        graph,
      }
      return { input, created, saveInput }
    }
    async function save(input: CurrentWorkflowSaveInput, client: Client = base.client) {
      const result = await client.callTool({ name: 'workflow_save_v3', arguments: input })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result))
    }
    async function read(workflowId: string) {
      const result = await base.client.callTool({ name: 'workflow_saved_get_v3', arguments: { workspaceId, workflowId } })
      expect(result.isError).not.toBe(true)
      return CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(result))
    }
    return { base, placement, workspaceId, create, save, read, services,
      async close() { await base.close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    await base.close()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

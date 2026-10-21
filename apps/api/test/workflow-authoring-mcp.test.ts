import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/server'
import type pg from 'pg'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { registerCurrentWorkflowTools, unavailableCurrentWorkflowToolCall } from '../src/mcp/operator/tools/currentWorkflow.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

const expiresAt = '2099-01-01T00:00:00.000Z'
const fixture = () => makeCurrentWorkflowFixture('eng04-b-current-tools', 'repeat')
function principal(actions: ManagementPrincipal['grants'][number]['actions'], workflowIds?: string[]): ManagementPrincipal {
  const grants: ManagementPrincipal['grants'] = []
  if (actions.includes('capabilities:read')) grants.push({ actions: ['capabilities:read'], scope: {} })
  if (actions.includes('workspace_locations:read')) grants.push({ actions: ['workspace_locations:read'], scope: { workspaceIds: [fixture().scope.workspaceId] } })
  const scoped = actions.filter((action) => action !== 'capabilities:read' && action !== 'workspace_locations:read')
  if (scoped.length) grants.push({ actions: scoped, scope: { workspaceIds: [fixture().scope.workspaceId], ...(workflowIds ? { workflowIds } : {}) } })
  return { id: `principal-${actions.length}`, name: 'Operator', audience: 'operator', expiresAt, revokedAt: null, grants }
}
function context(p: ManagementPrincipal) {
  const connect = vi.fn(() => { throw new Error('Tool discovery/denial must not acquire SQL') })
  const pool = { connect } as unknown as pg.Pool
  const commands = new PostgresCommandCoordinator(pool)
  const workflows = new WorkflowManagementService(pool, commands)
  // This registrar uses only workflows and commands. Unrelated Operator ports
  // are deliberately absent in this registration unit test.
  return { connect, context: { principal: p, services: { workflows, commands } } as OperatorRequestContext }
}

afterEach(() => vi.restoreAllMocks())

describe('NIM-2646 current V3 authoring/read MCP boundaries', () => {
  it('exposes the UI-equivalent single current save/read surface, including optional repeat', () => {
    const registered = new Set<string>()
    const server = { registerTool(name: string) { registered.add(name) } } as unknown as McpServer
    const c = context(principal(['capabilities:read', 'workflows:read', 'workflows:update', 'graph:read',
      'graph:edit', 'graph:save', 'runs:read', 'agents:read', 'workspace_locations:read']))
    registerCurrentWorkflowTools(server, c.context)
    expect([...registered].sort()).toEqual(['workflow_authoring_capabilities_v3', 'workflow_edit_v3', 'workflow_edits_get_v3',
      'workflow_save_v3', 'workflow_saved_get_v3', 'workflow_validate_v3'])
    expect([...registered].some((name) => name.startsWith('repeat_'))).toBe(false)
    expect(c.connect).not.toHaveBeenCalled()
  })

  it('does not advertise Save or staged writes to a read-only Operator', () => {
    const registered = new Set<string>()
    const server = { registerTool(name: string) { registered.add(name) } } as unknown as McpServer
    const c = context(principal(['capabilities:read', 'workflows:read', 'graph:read', 'runs:read']))
    registerCurrentWorkflowTools(server, c.context)
    expect(registered.has(CURRENT_WORKFLOW_TOOLS.save)).toBe(false)
    expect(registered.has(CURRENT_WORKFLOW_TOOLS.edits)).toBe(false)
    expect(registered.has(CURRENT_WORKFLOW_TOOLS.saved)).toBe(true)
    expect(c.connect).not.toHaveBeenCalled()
  })

  it('rejects a wrong-workflow writer before any command or database work', async () => {
    const f = fixture()
    const c = context(principal(['workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save',
      'agents:read', 'workspace_locations:read'], ['other-workflow']))
    const execute = vi.spyOn(c.context.services.commands, 'execute')
    const input = CurrentWorkflowSaveInputSchema.parse({ workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      commandId: randomUUID(), expectedRevision: 1, expectedWorkflowVersionId: f.version.id, executionSemanticsVersion: 3,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, graph: f.version.definition })
    await expect(c.context.services.workflows.current.save(c.context.principal, 'mcp', input))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(execute).not.toHaveBeenCalled()
    expect(c.connect).not.toHaveBeenCalled()
  })

  it('fails explicitly when canonical Run reads are not qualified instead of fabricating repeat state', async () => {
    const f = fixture(), c = context(principal(['workflows:read', 'graph:read', 'runs:read'], [f.scope.workflowId]))
    const reads = new RunGraphReadService({ connect: c.connect } as unknown as pg.Pool)
    await expect(reads.current(c.context.principal, { protocolVersion: 1, scope: f.scope }))
      .rejects.toMatchObject({ code: 'GRAPH_NOT_INITIALIZED' })
    expect(c.connect).not.toHaveBeenCalled()
  })

  it('returns a text-only MCP denial and records it without invoking Save', async () => {
    const c = context(principal(['workflows:read', 'graph:read']))
    const denied = vi.spyOn(c.context.services.commands, 'recordDenied').mockResolvedValue(undefined)
    const save = vi.spyOn(c.context.services.workflows.current, 'save')
    const response = await unavailableCurrentWorkflowToolCall(c.context, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: CURRENT_WORKFLOW_TOOLS.save, arguments: {} } })
    expect(response?.result.isError).toBe(true)
    expect(response?.result).not.toHaveProperty('structuredContent')
    expect(response?.result.content).toHaveLength(1)
    const text = response?.result.content[0]
    if (!text || text.type !== 'text') throw new Error('MCP denial must have text content')
    expect(JSON.parse(text.text)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect(denied).toHaveBeenCalledExactlyOnceWith(c.context.principal.id, 'mcp', CURRENT_WORKFLOW_TOOLS.save, `mcp:${CURRENT_WORKFLOW_TOOLS.save}`)
    expect(save).not.toHaveBeenCalled()
    expect(c.connect).not.toHaveBeenCalled()
  })
})

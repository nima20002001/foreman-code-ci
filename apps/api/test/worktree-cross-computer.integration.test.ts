import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import {
  canonicalGraphJson, CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowCapabilitiesSchema,
  CurrentWorkflowSavedSchema, CurrentWorkflowSaveInputSchema,
} from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { requireCurrentWorkflowAccess } from '../src/modules/workflows/currentWorkflowPolicy.js'

type Fixture = Awaited<ReturnType<typeof fixture>>
const prefix = 'foreman/site/shared'
const authoringCases = (['inherited', 'explicit'] as const).flatMap(mode =>
  (['validate', 'save', 'edit'] as const).flatMap(operation =>
    (['http', 'mcp'] as const).map(via => ({ mode, operation, via }))))

async function configure(f: Fixture, mode: 'inherited' | 'explicit') {
  const [first, second] = f.saveInput.graph.nodes.map(agentWorkflowNode)
  first!.name = 'Agent One'
  second!.name = 'Agent Two'
  if (mode === 'inherited') {
    f.saveInput.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding!, branchPrefix: prefix }
  } else {
    first!.placement = f.placement.local
    first!.worktree = { branchPrefix: prefix }
    second!.worktree = { branchPrefix: prefix }
  }
  const mainId = f.placement.local.hostRef.mainId
  const remote = f.placement.remote.hostRef
  if (remote.kind !== 'device') throw new Error('Expected a Worker placement')
  await f.base.db.pool.query(`insert into computer_names(host_key,name,updated_by) values($1,$2,$5),($3,$4,$5)`,
    [`${mainId}:main`, 'Main desktop', `${mainId}:${remote.deviceId}`, 'Worker laptop', f.base.writer.principal.id])
}

function expectConflict(error: unknown) {
  expect(error).toMatchObject({ error: { code: 'WORKTREE_COMPUTER_CONFLICT', message: expect.any(String) } })
  const { message } = (error as { error: { message: string } }).error
  for (const text of ['Agent One', 'Agent Two', 'Main desktop', 'Worker laptop', prefix]) {
    expect(message).toContain(text)
  }
}

// A saved version from before placement validation must remain readable, but cannot Start.
async function seedSavedWorkflow(f: Fixture) {
  const input = CurrentWorkflowSaveInputSchema.parse(JSON.parse(JSON.stringify(f.saveInput)))
  const definition = { ...input.graph, version: 1 }
  const version = { id: `workflow-version-${randomUUID()}`, workspaceId: f.saveInput.workspaceId,
    workflowId: f.saveInput.workflowId, version: 1, executionSemanticsVersion: 3,
    entryNodeId: definition.entryNodeId, definition, approval: definition.approval,
    agentConfigurationVersionIds: f.saveInput.expectedAgentConfigurationVersionIds,
    contentHash: '', createdAt: definition.createdAt }
  const content = canonicalGraphJson({
    definition, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
  })
  version.contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
  const saved = CurrentWorkflowSavedSchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    revision: f.saveInput.expectedRevision + 1, currentVersionId: version.id, version })
  await f.base.commands.execute({ principal: f.base.writer.principal, source: 'mcp',
    commandId: f.saveInput.commandId, operation: 'workflow.save.v3',
    targetKey: `workflow:${version.workflowId}:definition`, payload: f.saveInput,
    authorize: async () => requireCurrentWorkflowAccess(f.base.writer.principal, 'save', f.saveInput),
    perform: async sql => {
      await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,
        entry_node_id,record,execution_semantics_version) values($1,$2,$3,1,$4,$5::jsonb,3)`,
      [version.id, version.workspaceId, version.workflowId, version.entryNodeId, canonicalGraphJson(saved.version)])
      await sql.query('select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)',
        [f.base.writer.principal.id, 'mcp', canonicalGraphJson(input), commandInputHash(f.saveInput), version.id, content])
      return saved
    },
  })
  return saved
}

describe.runIf(postgresEnabled)('worktree computer boundaries', () => {
  it('rejects assigning the identical Main root binding to a Worker placement', async () => {
    const f = await fixture({ gitSource: true })
    try {
      const second = agentWorkflowNode(f.saveInput.graph.nodes[1])
      second.placement = { ...f.placement.remote, rootBinding: f.placement.local.rootBinding! }
      const http = await f.app.inject({ method: 'PUT', url: `${f.path}/definition`,
        headers: f.headers, payload: f.saveInput })
      expect(http.statusCode, http.body).toBe(409)
      expect(http.json()).toMatchObject({ error: { code: 'WORKTREE_BINDING_CONFLICT' } })
      expect(toolError(await f.client.callTool({ name: 'workflow_save_v3', arguments: f.saveInput })))
        .toMatchObject({ error: { code: 'WORKTREE_BINDING_CONFLICT' } })
    } finally { await f.close() }
  }, 120_000)

  it.each(authoringCases)(
    '$via rejects $mode shared worktree settings during $operation', async ({ mode, operation, via }) => {
      const f = await fixture({ gitSource: true })
      try {
        await configure(f, mode)
        const validation = { workspaceId: f.saveInput.workspaceId, workflowId: f.saveInput.workflowId,
          executionSemanticsVersion: 3, expectedRevision: f.saveInput.expectedRevision,
          expectedWorkflowVersionId: f.saveInput.expectedWorkflowVersionId,
          expectedAgentConfigurationVersionIds: f.saveInput.expectedAgentConfigurationVersionIds, graph: f.saveInput.graph }
        const stage = { ...f.saveInput, action: 'stage_edits', draftId: randomUUID(), stagedAgents: [] }
        const requests = {
          validate: { method: 'POST' as const, suffix: '/definition/validate', tool: 'workflow_validate_v3', input: validation },
          save: { method: 'PUT' as const, suffix: '/definition', tool: 'workflow_save_v3', input: f.saveInput },
          edit: { method: 'POST' as const, suffix: '/definition/edits', tool: 'workflow_edit_v3', input: stage },
        }
        const request = requests[operation]
        if (via === 'http') {
          const result = await f.app.inject({ method: request.method, url: `${f.path}${request.suffix}`,
            headers: f.headers, payload: request.input })
          expect(result.statusCode, result.body).toBe(409)
          expectConflict(result.json())
        } else {
          expectConflict(toolError(await f.client.callTool({ name: request.tool, arguments: request.input })))
        }
        const read = await f.client.callTool({ name: 'workflow_edits_get_v3', arguments: {
          workspaceId: f.saveInput.workspaceId, workflowId: f.saveInput.workflowId,
          action: 'read_edits', draftId: stage.draftId,
        } })
        expect(CurrentEditReadResultSchema.parse(decodeMcpToolResult(read)).intent).toBeNull()
        expect((await f.base.db.pool.query('select id from workflow_versions where workflow_id=$1',
          [f.saveInput.workflowId])).rows).toEqual([])
        expect(f.base.provider.counts.sessions).toBe(0)
      } finally { await f.close() }
    }, 120_000)

  it.each(['http', 'mcp'] as const)('%s Start rejects a previously saved cross-computer setting without changing it', async via => {
    const f = await fixture({ gitSource: true })
    try {
      await configure(f, 'inherited')
      const saved = await seedSavedWorkflow(f)
      const input = startInput(f, saved)
      if (via === 'mcp') {
        expectConflict(toolError(await f.client.callTool({ name: 'run_start', arguments: input })))
      } else {
        const result = await f.app.inject({ method: 'POST', url: `${f.path}/runs`, headers: f.headers, payload: input })
        expect(result.statusCode, result.body).toBe(409)
        expectConflict(result.json())
      }
      const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      } })
      expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toEqual([])
      expect(f.base.provider.counts.sessions).toBe(0)
    } finally { await f.close() }
  }, 120_000)

  it.each(['same-computer', 'different-prefixes', 'generated'] as const)(
    'allows %s worktrees and persists their computers and branch requests at Start', async mode => {
      const f = await fixture({ gitSource: true })
      try {
        await configure(f, 'inherited')
        const second = agentWorkflowNode(f.saveInput.graph.nodes[1])
        if (mode === 'same-computer') second.placement = f.placement.local
        if (mode === 'different-prefixes') second.worktree = { branchPrefix: 'foreman/site/reviewer' }
        if (mode === 'generated') delete f.saveInput.graph.defaultWorktree!.branchPrefix
        const saved = await f.save('mcp')
        const accepted = await f.start('mcp', startInput(f, saved))
        const placements = []
        for (const node of saved.version.definition.nodes) {
          const result = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
            workspaceId: saved.workspaceId, workflowId: saved.workflowId, runId: accepted.run.id, nodeId: node.id,
          } })
          const read = RunPlacementGetResultSchema.parse(decodeMcpToolResult(result)).readback
          if (read.evidence !== 'accepted') throw new Error('Expected accepted placement')
          placements.push(read.placement)
        }
        expect(placements.map(item => item.hostRef)).toEqual([
          f.placement.local.hostRef, mode === 'same-computer' ? f.placement.local.hostRef : f.placement.remote.hostRef,
        ])
        const branches = placements.map(item => item.payload.kind === 'agent' ? item.payload.worktree?.branch : undefined)
        expect(branches[0]).toBeDefined()
        if (mode === 'same-computer') expect(branches).toEqual([prefix, prefix])
        else expect(branches[0]).not.toBe(branches[1])
        const read = await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: {
          workspaceId: saved.workspaceId, workflowId: saved.workflowId,
        } })
        expect(CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(read)).version).toEqual(saved.version)
      } finally { await f.close() }
    }, 120_000)

  it('discovers the one-computer worktree boundary through authenticated MCP', async () => {
    const f = await fixture()
    try {
      const result = await f.client.callTool({ name: 'workflow_authoring_capabilities_v3', arguments: {} })
      expect(CurrentWorkflowCapabilitiesSchema.parse(decodeMcpToolResult(result)).worktrees)
        .toHaveProperty('sharedPrefixComputer', 'one')
    } finally { await f.close() }
  }, 120_000)

  it('keeps a read-only MCP caller denied before worktree edits, Save and Start', async () => {
    const f = await fixture({ gitSource: true })
    try {
      await configure(f, 'inherited')
      const saved = await seedSavedWorkflow(f)
      const reader = await f.base.access.issue({ name: 'Workflow reader', audience: 'operator',
        grants: [{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [saved.workspaceId] } }] })
      const client = await f.connect(reader.token)
      for (const [name, input] of [
        ['workflow_save_v3', f.saveInput],
        ['workflow_edit_v3', { ...f.saveInput, action: 'stage_edits', draftId: randomUUID() }],
        ['run_start', startInput(f, saved)],
      ] as const) {
        expect(toolError(await client.callTool({ name, arguments: input })))
          .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      }
    } finally { await f.close() }
  }, 120_000)
})

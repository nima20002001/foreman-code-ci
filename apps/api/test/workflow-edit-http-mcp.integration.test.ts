import { AgentSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema,
  CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

describe.skipIf(!postgresEnabled)('ENG04 current full-definition durable edit parity', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  it.each(['workflow rename', 'Agent settings', 'one-pass dependencies'] as const)(
    'saves %s through MCP with denied writes, replay and persisted readback', async (change) => {
      const t = await writerFixture(db)
      fixtures.push(t)
      if (change === 'one-pass dependencies') t.input.graph.handoffs = { contractVersion: 1 }
      const initial = await t.app.inject({ method: 'PUT', url: t.url,
        headers: graphHeaders(t.writer.token), payload: t.input })
      expect(initial.statusCode, initial.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(initial.json()).value
      const graph = { ...saved.version.definition, name: 'Renamed workflow' }
      if (change === 'one-pass dependencies') delete graph.handoffs
      const agentId = t.configurations[0]!.agentId
      const row = (await db.pool.query('select record,metadata_revision from agents where id=$1', [agentId])).rows[0]!
      const edited = { ...AgentSchema.parse(row.record), name: 'Saved Worker', prompt: { system: 'Updated instructions' } }
      const stage = { ...t.input, action: 'stage_edits', draftId: `board-${t.input.workflowId}`,
        commandId: randomUUID(), expectedRevision: saved.revision,
        expectedWorkflowVersionId: saved.currentVersionId,
        graph, ...(change === 'Agent settings'
          ? { stagedAgents: [{ agent: edited, baseRevision: Number(row.metadata_revision) }] } : {}) }
      const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
        scope: { workspaceIds: [t.input.workspaceId] } }])
      expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, reader.token)).result?.isError).toBe(true)
      const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
      expect(staged.result?.isError, JSON.stringify(staged.result)).not.toBe(true)
      const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
      const advance = { action: 'stop_and_save', workspaceId: stage.workspaceId, workflowId: stage.workflowId,
        draftId: stage.draftId, intentId: intent.id, commandId: intent.advanceCommandId }
      const completed = await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)
      expect(completed.result?.isError, JSON.stringify(completed.result)).not.toBe(true)
      const published = CurrentEditReadResultSchema.parse(graphRpcValue(completed.result))
      expect(published.intent?.state).toBe('saved')
      expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result)).toEqual(published)
      const read = await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { action: 'read_edits',
        workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId })
      expect(read.result?.isError, JSON.stringify(read.result)).not.toBe(true)
      expect(CurrentEditReadResultSchema.parse(graphRpcValue(read.result))).toEqual(published)
      const managed = await t.call('workflow_get', { workspaceId: stage.workspaceId,
        workflowId: stage.workflowId }, reader.token)
      expect(managed.result?.isError, JSON.stringify(managed.result)).not.toBe(true)
      expect(graphRpcValue(managed.result)).toMatchObject({ workflow: { name: 'Renamed workflow' } })
      const persisted = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(reader.token) })
      expect(persisted.statusCode, persisted.body).toBe(200)
      const readback = CurrentWorkflowReadResultSchema.parse(persisted.json())
      expect(readback).toMatchObject({
        revision: published.intent!.result!.revision, currentVersionId: published.intent!.result!.currentVersionId,
      })
      if (change === 'one-pass dependencies') expect(readback.version.definition).not.toHaveProperty('handoffs')
      if (change === 'Agent settings') {
        const agentRow = (await db.pool.query('select record from agents where id=$1', [agentId])).rows[0]!
        const persistedAgent = AgentSchema.parse(agentRow.record)
        expect(persistedAgent).toMatchObject({ name: 'Saved Worker', prompt: { system: 'Updated instructions' },
          configurationVersionId: readback.version.agentConfigurationVersionIds[agentId] })
        expect(published.intent!.result!.agents).toContainEqual(expect.objectContaining({ agent: persistedAgent }))
      }
      const stale = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...stage, commandId: randomUUID(),
        graph: { ...stage.graph, name: 'Stale rename' } })
      expect(stale.result?.isError).toBe(true)
      expect(graphRpcValue((await t.call('workflow_get', { workspaceId: stage.workspaceId,
        workflowId: stage.workflowId })).result)).toMatchObject({ workflow: { name: 'Renamed workflow' } })
    },
  )

  it.each(['name', 'label'] as const)('saves a node %s through a restarted edit journal while a Run remains active', async (field) => {
    const t = await writerFixture(db); fixtures.push(t)
    const initial = await t.app.inject({ method: 'PUT', url: t.url,
      headers: graphHeaders(t.writer.token), payload: t.input })
    expect(initial.statusCode, initial.body).toBe(200)
    const saved = CurrentWorkflowSaveResultSchema.parse(initial.json()).value
    const accepted = await insertCurrentRunFixture(db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1,
        identityHash: `sha256:${'1'.repeat(64)}` } } }, saved, t.writer.principal.id)
    const before = (await db.pool.query('select record from runs where id=$1', [accepted.run.id])).rows[0]!.record
    const renamer = await t.credential([{ actions: ['workflows:read', 'workflows:update', 'graph:read',
      'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read'],
    scope: { workspaceIds: [t.input.workspaceId] } }])
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
      graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map((node, index) =>
        index ? node : { ...node, [field]: 'Saved presentation' }) } }
    const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`,
      headers: graphHeaders(renamer.token), payload: stage })
    expect(response.statusCode, response.body).toBe(200)
    const staged = CurrentEditReadResultSchema.parse(response.json())
    expect(staged.current).toEqual([])
    expect(staged.intent?.affected).toEqual([])
    expect(staged.intent?.stops).toEqual([])
    expect(staged.intent?.stagedDraft.presentationOnly).toBe(true)
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'],
      scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, denied.token)).result?.isError).toBe(true)
    const commands = new PostgresCommandCoordinator(db.pool)
    const workflows = new WorkflowManagementService(db.pool, commands)
    const restarted = buildApp({ readiness: { database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined } },
    operator: { access: t.access, services: { workflows, commands } as OperatorServices } })
    try {
      const intent = staged.intent!
      const advance = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
      const call = (name: string, args: unknown) => graphRpc(restarted, renamer.token,
        'tools/call', { name, arguments: args })
      const completed = await call(CURRENT_WORKFLOW_TOOLS.edits, advance)
      expect(completed.result?.isError, JSON.stringify(completed.result)).not.toBe(true)
      const published = CurrentEditReadResultSchema.parse(graphRpcValue(completed.result))
      expect(published.intent?.state).toBe('saved')
      expect(published.intent?.result).toMatchObject({ revision: saved.revision,
        currentVersionId: saved.currentVersionId, version: saved.version })
      expect(published.intent?.result?.presentation?.nodes[0]).toHaveProperty(field, 'Saved presentation')
      expect(graphRpcValue((await call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result)).toEqual(published)
      const current = graphRpcValue((await call('workflow_get', {
        workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result)
      expect(current).toMatchObject({ workflow: { nodes: stage.graph.nodes } })
      const read = await restarted.inject({ method: 'GET', url: t.url,
        headers: graphHeaders(renamer.token) })
      expect(CurrentWorkflowReadResultSchema.parse(read.json()).version).toEqual(saved.version)
      expect((await db.pool.query('select record from runs where id=$1', [accepted.run.id])).rows[0]!.record).toEqual(before)
      expect((await db.pool.query('select 1 from workflow_versions where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(1)
      expect((await db.pool.query("select 1 from management_command_receipts where operation='run.stop' and principal_id=$1",
        [renamer.principal.id])).rowCount).toBe(0)
    } finally {
      await restarted.close()
    }
  })

  it.each(['http', 'mcp'] as const)('accepts a later rename after a %s save while retaining immutable versions', async (source) => {
    const t = await writerFixture(db); fixtures.push(t)
    const response = await t.app.inject({ method: 'PUT', url: t.url,
      headers: graphHeaders(t.writer.token), payload: t.input })
    expect(response.statusCode, response.body).toBe(200)
    const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
    const input = { ...t.input, commandId: randomUUID(), expectedRevision: saved.revision,
      expectedWorkflowVersionId: saved.currentVersionId,
      graph: { ...saved.version.definition,
        nodes: saved.version.definition.nodes.map((node, index) => index ? node : { ...node, name: 'First rename' }) } }
    const firstReply = source === 'http'
      ? (await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: input })).json()
      : graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, input)).result)
    const first = CurrentWorkflowSaveResultSchema.parse(firstReply)
    const competing = { ...input, commandId: randomUUID(), graph: { ...saved.version.definition,
      nodes: saved.version.definition.nodes.map((node, index) => index === 1 ? { ...node, label: 'Second rename' } : node) } }
    const later = await t.app.inject({ method: 'PUT', url: t.url,
      headers: graphHeaders(t.writer.token), payload: competing })
    expect(later.statusCode, later.body).toBe(200)
    expect(CurrentWorkflowSaveResultSchema.parse(later.json()).value.presentation?.nodes).toEqual(competing.graph.nodes)
    const mcp = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...competing, commandId: randomUUID() })
    expect(mcp.result?.isError).not.toBe(true)
    expect(CurrentWorkflowSaveResultSchema.parse(graphRpcValue(mcp.result)).value.presentation?.nodes)
      .toEqual(competing.graph.nodes)
    const persisted = graphRpcValue((await t.call('workflow_get', {
      workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result)
    expect(persisted).toMatchObject({ revision: saved.revision, currentVersionId: saved.currentVersionId,
      workflow: { nodes: competing.graph.nodes } })
    const combined = { ...competing, commandId: randomUUID(),
      graph: { ...first.value.presentation!, nodes: first.value.presentation!.nodes.map((node, index) =>
        index === 1 ? { ...node, label: 'Second rename' } : node) } }
    const second = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, combined)).result))
    expect(second.value.presentation?.nodes).toEqual(combined.graph.nodes)
    expect(second.value.version).toEqual(saved.version)
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, input)).result)).toEqual({ ...first, replayed: true })
    const drag = { ...combined, commandId: randomUUID(),
      graph: { ...second.value.presentation!, nodes: second.value.presentation!.nodes.map((node, index) =>
        index ? node : { ...node, position: { x: 700, y: 80 } }) } }
    const moved = await t.app.inject({ method: 'PUT', url: t.url,
      headers: graphHeaders(t.writer.token), payload: drag })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(CurrentWorkflowSaveResultSchema.parse(moved.json()).value.version).toEqual(saved.version)
    const readback = await t.app.inject({ method: 'GET', url: t.url.replace(/\/definition$/, ''),
      headers: graphHeaders(t.writer.token) })
    expect(readback.statusCode, readback.body).toBe(200)
    expect(readback.json()).toMatchObject({ workflow: { nodes: drag.graph.nodes } })
    const executable = { ...combined, commandId: randomUUID(),
      graph: { ...second.value.presentation!,
        nodes: second.value.presentation!.nodes.map((node, index) => index ? node : { ...node, initialPrompt: 'Executable edit' }) } }
    const next = await t.app.inject({ method: 'PUT', url: t.url,
      headers: graphHeaders(t.writer.token), payload: executable })
    expect(next.statusCode, next.body).toBe(200)
    expect(CurrentWorkflowSaveResultSchema.parse(next.json()).value.revision).toBe(saved.revision + 1)
  })

  it.each(['approval', 'limits', 'low-limits', 'both', 'empty'] as const)('rejects invalid %s before staging and permits a corrected save', async (invalid) => {
    const t = await writerFixture(db, 'sequential'); fixtures.push(t)
    const graph = structuredClone(t.input.graph)
    if (invalid === 'approval' || invalid === 'both') graph.approval = { handler: 'orchestrator' }
    if (invalid === 'limits' || invalid === 'both') delete graph.executionPolicy
    if (invalid === 'low-limits') graph.executionPolicy = { ...graph.executionPolicy!, maxNodeExecutions: 1 }
    if (invalid === 'empty') { graph.nodes = []; graph.edges = []; graph.entryNodeId = null }
    const stage = { ...t.input, graph, expectedAgentConfigurationVersionIds: invalid === 'empty' ? {} : t.input.expectedAgentConfigurationVersionIds, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID() }
    const rejected = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('GRAPH_INVALID')
    const mcp = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(mcp.result?.isError).toBe(true)
    expect(graphRpcValue(mcp.result)).toEqual({ error: { code: 'GRAPH_INVALID',
      message: rejected.json().error.message, details: rejected.json().error.details } })
    const issues = rejected.json().error.details.issues
    expect(issues).toHaveLength(invalid === 'both' ? 2 : 1)
    if (invalid === 'approval' || invalid === 'both') expect(issues).toContainEqual({
      code: 'ORCHESTRATOR_REQUIRED', path: ['approval', 'designatedOrchestratorAgentId'], message: 'Choose a reviewing orchestrator.',
    })
    if (invalid === 'limits' || invalid === 'both') expect(issues).toContainEqual({
      code: 'EXECUTION_LIMITS_REQUIRED', path: ['executionPolicy'], message: 'Set execution limits.',
    })
    if (invalid === 'low-limits') expect(issues).toContainEqual({
      code: 'EXECUTION_LIMIT_TOO_LOW', path: ['executionPolicy', 'maxNodeExecutions'],
      message: `Increase “Maximum node executions” to at least ${graph.nodes.length}.`, minimum: graph.nodes.length, actual: 1,
    })
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(0)
    const corrected = { ...stage, graph: t.input.graph, expectedAgentConfigurationVersionIds: t.input.expectedAgentConfigurationVersionIds, commandId: randomUUID() }
    const staged = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected)).result))
    expect(staged.intent?.state).toBe('staged')
    expect(staged.intent?.stagedDraft.graph).toEqual(t.input.graph)
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    const deniedReply = await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected, denied.token)
    expect(deniedReply.result?.isError).toBe(true)
    expect(JSON.stringify(deniedReply.result)).toContain('ACCESS_DENIED')
    const intent = staged.intent!
    const published = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, {
      workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: corrected.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId,
    })).result))
    expect(published.intent?.state).toBe('saved')
    const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result))
    expect(persisted.version).toEqual(published.intent?.result?.version)
  })
  it('rejects incompatible reviewer settings before staging and permits correction without changing native permissions', async () => {
    const t = await writerFixture(db, 'approval'); fixtures.push(t)
    const reviewerId = t.input.graph.approval!.designatedOrchestratorAgentId!
    const row = (await db.pool.query('select record,metadata_revision from agents where id=$1', [reviewerId])).rows[0]
    const agent = AgentSchema.parse(row.record)
    if (agent.harnessConfiguration?.harness !== 'codex') throw new Error('Expected Codex fixture')
    const edited = { ...agent, harnessConfiguration: { ...agent.harnessConfiguration,
      advanced: { ...agent.harnessConfiguration.advanced!, approvalsReviewer: 'user' as const } } }
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      stagedAgents: [{ agent: edited, baseRevision: Number(row.metadata_revision) }] }
    const rejected = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error).toMatchObject({ code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED',
      details: { issues: [{ path: ['approval', 'handler'] }] } })
    const mcp = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(mcp.result?.isError).toBe(true)
    expect(graphRpcValue(mcp.result)).toMatchObject({ error: { code: rejected.json().error.code, details: rejected.json().error.details } })
    expect((await db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(0)
    const corrected = { ...stage, commandId: randomUUID(), graph: { ...stage.graph, approval: { handler: 'user' },
      edges: stage.graph.edges.filter((edge) => edge.kind === 'execution') } }
    const staged = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, corrected)).result))
    const intent = staged.intent!
    const published = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, {
      workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId,
    })).result))
    expect(published.intent?.state).toBe('saved')
    const saved = CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result))
    expect(saved.version.approval).toEqual({ handler: 'user' })
    const persisted = AgentSchema.parse((await db.pool.query('select record from agents where id=$1', [reviewerId])).rows[0].record)
    expect(persisted.harnessConfiguration).toEqual(edited.harnessConfiguration)
  })
  it.each(['sequential', 'repeat'] as const)('%s stages and discards the exact private intent across HTTP and MCP', async (form) => {
    const t = await writerFixture(db, form); fixtures.push(t)
    const savedResponse = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
    expect(savedResponse.statusCode, savedResponse.body).toBe(200)
    const saved = CurrentWorkflowSaveResultSchema.parse(savedResponse.json()).value
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
      graph: { ...saved.version.definition, name: 'Private edit' } }
    const staged = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stage })
    expect(staged.statusCode, staged.body).toBe(200)
    const read = CurrentEditReadResultSchema.parse(staged.json()), intent = read.intent!
    expect(intent.stagedDraft.graph.name).toBe('Private edit')
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).toEqual(staged.json())
    const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, denied.token)).result?.isError).toBe(true)
    const discard = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result))
    expect(dropped.intent?.state).toBe('discarded')
    const replay = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(dropped)
    const persisted = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(persisted.json().version).toEqual(saved.version)
    expect((await db.pool.query('select 1 from workflow_versions where workflow_id=$1', [t.input.workflowId])).rowCount).toBe(1)
    expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
  })
})

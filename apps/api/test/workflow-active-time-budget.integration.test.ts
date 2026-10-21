import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowReadResultSchema,
  CurrentWorkflowSaveResultSchema, CurrentEditReadResultSchema, MAX_AGENT_ACTIVE_TIMEOUT_MS,
} from '@foreman-code/contracts/wave25'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

describe('workflow Agent active-time budget through authenticated MCP', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60_000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.app.close())) })
  afterAll(async () => { await db?.close() })

  it('discovers the six-hour default without adding it to saved workflow facts', async () => {
    const f = await writerFixture(db)
    fixtures.push(f)
    const capabilities = CurrentWorkflowCapabilitiesSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.capabilities, {})).result))
    expect(capabilities.agentActiveTimeBudget.defaultMs).toBe(21_600_000)
    const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input)).result)).value
    const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.saved, {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId,
      })).result))
    expect(read.version).toEqual(saved.version)
    expect(read.version.definition.executionPolicy).not.toHaveProperty('agentActiveTimeoutMs')
  })

  it('discovers defaults, denies a reader, saves and resets an override, and preserves historical versions', async () => {
    const f = await writerFixture(db, 'sequential', { agentActiveTimeoutMs: 600_000 })
    fixtures.push(f)
    const scope = { workspaceId: f.input.workspaceId, workflowId: f.input.workflowId }
    const capabilities = CurrentWorkflowCapabilitiesSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.capabilities, {})).result))
    expect(capabilities.agentActiveTimeBudget).toEqual({ defaultMs: 600_000,
      maximumMs: MAX_AGENT_ACTIVE_TIMEOUT_MS, perExecution: true, approvalWaitExcluded: true })
    const tools = await graphRpc(f.app, f.writer.token, 'tools/list')
    expect(JSON.stringify(tools.result)).toContain('agentActiveTimeoutMs')

    f.input.graph.executionPolicy!.agentActiveTimeoutMs = 3_600_000
    const reader = await f.credential([{ actions: ['workflows:read', 'graph:read'],
      scope: { workspaceIds: [scope.workspaceId] } }])
    const denied = await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input, reader.token)
    expect(denied.result?.isError).toBe(true)
    expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect((await f.workflows.get(f.writer.principal, scope.workspaceId, scope.workflowId)).currentVersionId).toBeNull()

    const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input)).result)).value
    const replay = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input)).result))
    expect(replay.replayed).toBe(true)
    expect(replay.value.version).toEqual(saved.version)
    const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope, reader.token)).result))
    expect(read.version.definition.executionPolicy?.agentActiveTimeoutMs).toBe(3_600_000)

    const invalid = { ...f.input, commandId: randomUUID(), expectedRevision: saved.revision,
      expectedWorkflowVersionId: saved.currentVersionId, graph: { ...saved.version.definition,
        executionPolicy: { ...saved.version.definition.executionPolicy, agentActiveTimeoutMs: 0 } } }
    expect((await f.call(CURRENT_WORKFLOW_TOOLS.save, invalid)).result?.isError).toBe(true)

    const graph = structuredClone(saved.version.definition)
    delete graph.executionPolicy!.agentActiveTimeoutMs
    const resetInput = { ...f.input, commandId: randomUUID(), expectedRevision: saved.revision,
      expectedWorkflowVersionId: saved.currentVersionId, graph }
    const reset = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.save, resetInput)).result)).value
    expect(reset.version.id).not.toBe(saved.version.id)
    const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope)).result))
    expect(persisted.version.definition.executionPolicy).not.toHaveProperty('agentActiveTimeoutMs')
    const historical = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.saved, { ...scope, workflowVersionId: saved.version.id })).result))
    expect(historical.version).toEqual(saved.version)
    const stale = await f.call(CURRENT_WORKFLOW_TOOLS.save, { ...f.input, commandId: randomUUID() })
    expect(stale.result?.isError).toBe(true)
    expect(graphRpcValue(stale.result)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  })

  it('edits and clears the budget through the MCP journal with denied writes and persisted readback', async () => {
    const f = await writerFixture(db)
    fixtures.push(f)
    const scope = { workspaceId: f.input.workspaceId, workflowId: f.input.workflowId }
    const reader = await f.credential([{ actions: ['workflows:read', 'graph:read'],
      scope: { workspaceIds: [scope.workspaceId] } }])
    let saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(
      (await f.call(CURRENT_WORKFLOW_TOOLS.save, f.input)).result)).value
    for (const agentActiveTimeoutMs of [3_600_000, undefined]) {
      const graph = structuredClone(saved.version.definition)
      if (agentActiveTimeoutMs === undefined) delete graph.executionPolicy!.agentActiveTimeoutMs
      else graph.executionPolicy!.agentActiveTimeoutMs = agentActiveTimeoutMs
      const stage = { ...f.input, ...scope, graph, action: 'stage_edits', draftId: randomUUID(),
        commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId }
      const denied = await f.call(CURRENT_WORKFLOW_TOOLS.edits, stage, reader.token)
      expect(denied.result?.isError).toBe(true)
      expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const staged = CurrentEditReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result))
      expect(staged.intent?.stagedDraft.graph.executionPolicy).toEqual(graph.executionPolicy)
      expect(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).toEqual(staged)
      const journal = CurrentEditReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope,
          action: 'read_edits', draftId: stage.draftId, intentId: staged.intent!.id })).result))
      expect(journal).toEqual(staged)
      const before = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope, reader.token)).result))
      expect(before.version).toEqual(saved.version)
      const intent = staged.intent!
      const advance = { ...scope, action: 'stop_and_save', draftId: stage.draftId,
        intentId: intent.id, commandId: intent.advanceCommandId }
      const deniedAdvance = await f.call(CURRENT_WORKFLOW_TOOLS.edits, advance, reader.token)
      expect(deniedAdvance.result?.isError).toBe(true)
      expect(graphRpcValue(deniedAdvance.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const published = CurrentEditReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result))
      expect(published.intent?.state).toBe('saved')
      expect(graphRpcValue((await f.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result)).toEqual(published)
      const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.saved, scope, reader.token)).result))
      expect(persisted.version).toEqual(published.intent!.result!.version)
      expect(persisted.version.definition.executionPolicy).toEqual(graph.executionPolicy)
      expect(persisted.revision).toBe(saved.revision + 1)
      const historical = CurrentWorkflowReadResultSchema.parse(graphRpcValue(
        (await f.call(CURRENT_WORKFLOW_TOOLS.saved, { ...scope, workflowVersionId: saved.version.id })).result))
      expect(historical.version).toEqual(saved.version)
      saved = published.intent!.result!
    }
  })
})

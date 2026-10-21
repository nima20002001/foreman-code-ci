import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentEditReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { useWorkflowManagementFixture } from './workflowManagement.helpers.js'

describe.skipIf(!postgresEnabled)('Authenticated workflow management publication', () => {
  const context = useWorkflowManagementFixture()
  const { fixture, httpSave, save, count, agentStage } = context
  it('MCP stages Agent configuration privately then atomically publishes exact resulting snapshots, and HTTP replay does not write twice', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const before = (await context.db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]
    const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError, JSON.stringify(staged)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    expect(intent.saveInput.expectedAgentConfigurationVersionIds).toEqual(stage.expectedAgentConfigurationVersionIds)
    expect(intent.saveInput.resultantAgentConfigurationVersionIds?.[stage.stagedAgents[0]!.agent.id]).not.toBe(stage.stagedAgents[0]!.agent.configurationVersionId)
    expect((await context.db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]).toEqual(before)
    const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id,
      action: 'stop_and_save', commandId: intent.advanceCommandId }
    const execute = t.commands.execute.bind(t.commands)
    vi.spyOn(t.commands, 'execute').mockImplementationOnce(async (request) => {
      await execute(request)
      throw new Error('SIMULATED_LOST_REPLY_AFTER_COMMIT')
    })
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)
    const finished = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result))
    expect(finished.intent?.state, JSON.stringify(finished.intent?.error)).toBe('saved')
    expect(finished.intent?.result?.agents).toHaveLength(1)
    const snapshot = finished.intent!.result!.agents![0]!
    expect(snapshot.agent.name).toBe('Private new name')
    expect(snapshot.metadataRevision).toBe(stage.stagedAgents[0]!.baseRevision + 1)
    expect(finished.intent!.result!.version.agentConfigurationVersionIds).toEqual(intent.saveInput.resultantAgentConfigurationVersionIds)
    const persisted = (await context.db.pool.query('select record,metadata_revision::text from agents where id=$1', [snapshot.agent.id])).rows[0]!
    expect(persisted.record).toEqual(snapshot.agent); expect(Number(persisted.metadata_revision)).toBe(snapshot.metadataRevision)
    const retry = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(retry.statusCode, retry.body).toBe(200); expect(retry.json()).toEqual(finished)
    const read = await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...advance, action: 'read_edits', commandId: undefined })
    expect(graphRpcValue(read.result)).toEqual(finished)
    expect(await count(t, 'workflow_versions')).toBe(2)
    expect((await context.db.pool.query('select 1 from agent_configuration_versions where agent_id=$1', [snapshot.agent.id])).rowCount).toBe(2)
  })
  it('a changed Agent metadata head after Stage blocks publication and preserves original payload and pins', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    await context.db.pool.query('update agents set metadata_revision=metadata_revision+1 where id=$1', [stage.stagedAgents[0]!.agent.id])
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { workspaceId: stage.workspaceId, workflowId: stage.workflowId,
      draftId: stage.draftId, intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId })
    const blocked = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result)).intent!
    expect(blocked).toMatchObject({ state: 'blocked', error: { code: 'AGENT_REVISION_CONFLICT' }, saveInput: intent.saveInput,
      agentPins: intent.agentPins, stops: intent.stops })
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect((await context.db.pool.query('select 1 from agent_configuration_versions where agent_id=$1', [stage.stagedAgents[0]!.agent.id])).rowCount).toBe(1)
  })
  it('a private Stage prevents an intervening meaningful Save from changing its accepted base', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const next = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Concurrent saved head' } }
    const rejected = await httpSave(t, next)
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json()).toMatchObject({ error: { code: 'WORKFLOW_EDITS_UNRESOLVED' } })
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, next)).result)).toMatchObject({ error: { code: 'WORKFLOW_EDITS_UNRESOLVED' } })
    const read = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(CurrentWorkflowReadResultSchema.parse(read.json()).version).toEqual(first.value.version)
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    const reopened = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' })).result)).intent!
    expect(reopened.saveInput).toEqual(intent.saveInput)
    expect(reopened.agentPins).toEqual(intent.agentPins)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(t.cancel).not.toHaveBeenCalled()
  })
  it('publishes staged Agent edits after the workspace location revision changes', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    await context.db.pool.query('update workspaces set location_revision=location_revision+1 where id=$1', [stage.workspaceId])
    const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
      intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
    const response = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })
    expect(response.statusCode, response.body).toBe(200)
    const blocked = CurrentEditReadResultSchema.parse(response.json()).intent!
    expect(blocked.state).toBe('saved')
    expect(blocked.result?.version.agentConfigurationVersionIds)
      .toEqual(intent.saveInput.resultantAgentConfigurationVersionIds)
    expect(blocked.saveInput).toEqual(intent.saveInput)
    expect(blocked.stagedDraft).toEqual(intent.stagedDraft)
    expect(await count(t, 'workflow_versions')).toBe(2)
    expect(t.cancel).not.toHaveBeenCalled()
  })
})

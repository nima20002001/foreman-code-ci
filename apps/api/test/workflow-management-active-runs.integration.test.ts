import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, SavedManagedWorkflowCommandResultSchema, CurrentEditReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture as insertFixtureRepeatRun } from './helpers/eng04CurrentRunFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { useWorkflowManagementFixture } from './workflowManagement.helpers.js'

describe.skipIf(!postgresEnabled)('Authenticated workflow management active runs', () => {
  const context = useWorkflowManagementFixture()
  const { fixture, httpSave, save, count, agentStage } = context
  it('active Run Stage and Discard never mutate Agents or stop the Run; unqualified Stop retains the same payload', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const accepted = await insertFixtureRepeatRun(context.db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: context.db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const original = (await context.db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]
    const staged = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError, JSON.stringify(staged)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    expect(intent.affected.map((pin) => pin.runId)).toEqual([accepted.run.id])
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    const advance = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId })
    expect(CurrentEditReadResultSchema.parse(graphRpcValue(advance.result)).intent).toMatchObject({ state: 'blocked', saveInput: intent.saveInput })
    const discard = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'discard_edits', commandId: intent.discardCommandId })
    expect(CurrentEditReadResultSchema.parse(graphRpcValue(discard.result)).intent?.state).toBe('discarded')
    expect((await context.db.pool.query('select record,metadata_revision,current_configuration_version_id from agents where id=$1', [stage.stagedAgents[0]!.agent.id])).rows[0]).toEqual(original)
    expect((await context.db.pool.query('select execution_state,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]).toMatchObject({ execution_state: 'queued', stop_requested_at: null })
    expect(t.cancel).not.toHaveBeenCalled(); expect(await count(t, 'workflow_versions')).toBe(1)
  })
  it('staged shared Agent edits include exact affected Runs and location pins from another workflow', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const created = await t.app.inject({ method: 'POST', url: `/api/management/workspaces/${stage.workspaceId}/workflows`,
      headers: graphHeaders(t.writer.token), payload: { workspaceId: stage.workspaceId, commandId: randomUUID(), name: 'Other workflow' } })
    const other = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
    const otherInput = { ...t.input, workflowId: other.workflow.id, commandId: randomUUID(), expectedRevision: other.revision,
      graph: { ...t.input.graph, id: other.workflow.id, version: other.workflow.version,
        createdAt: other.workflow.createdAt, updatedAt: other.workflow.updatedAt, name: other.workflow.name } }
    const otherSaved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, otherInput)).result)).value
    const accepted = await insertFixtureRepeatRun(context.db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: context.db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, otherSaved, t.writer.principal.id)
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(remote.result?.isError, JSON.stringify(remote)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(remote.result)).intent!
    expect(intent.affected).toHaveLength(1)
    expect(intent.affected[0]).toMatchObject({ runId: accepted.run.id, workflowId: other.workflow.id })
    expect(intent.affected.map((pin) => pin.runId)).toEqual([accepted.run.id])
    expect(intent.stops[0]!.input.runId).toBe(accepted.run.id)
  })
  it('active meaningful edits retain exact Stop plans across transport retries without fabricated receipts', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    const accepted = await insertFixtureRepeatRun(context.db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: context.db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const before = (await context.db.pool.query('select record,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]
    const direct = await httpSave(t, { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Active meaningful edit' } })
    expect(direct.statusCode).toBe(409)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    expect(intent.affected).toHaveLength(1)
    expect(intent.affected[0]).toMatchObject({ runId: accepted.run.id, workflowVersionId: first.value.currentVersionId,
      agentConfigurationVersionIds: first.value.version.agentConfigurationVersionIds })
    const advance = { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId }
    for (const reply of [
      graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result),
      (await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })).json(),
    ]) {
      expect(CurrentEditReadResultSchema.parse(reply).intent).toMatchObject({ state: 'blocked',
        error: { code: 'REPEAT_STOP_RUNTIME_UNAVAILABLE', uncertain: false }, saveInput: intent.saveInput, stops: intent.stops })
    }
    expect((await context.db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
    const discard = { ...scope, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result))
    expect(dropped.intent?.state).toBe('discarded')
    expect((await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })).json()).toEqual(dropped)
    expect((await context.db.pool.query('select record,stop_requested_at from runs where id=$1', [accepted.run.id])).rows[0]).toEqual(before)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(t.cancel).not.toHaveBeenCalled(); expect(t.start).not.toHaveBeenCalled()
  })
})

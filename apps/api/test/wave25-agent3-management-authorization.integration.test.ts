import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentEditReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { graphRpc, graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture as insertFixtureRepeatRun } from './helpers/eng04CurrentRunFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { useWorkflowManagementFixture } from './workflowManagement.helpers.js'

describe.skipIf(!postgresEnabled)('Authenticated workflow management authorization', () => {
  const context = useWorkflowManagementFixture()
  const { fixture, httpSave, save, count, agentStage } = context
  it('denies read-only, wrong-scope, revoked and missing callers; both transports audit denied writes', async () => {
    const t = await fixture()
    const readonly = await t.credential([{ actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.input.workspaceId] } }])
    const wrong = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: ['wrong'] } }])
    const tools = await graphRpc(t.app, readonly.token, 'tools/list')
    expect(tools.result?.tools?.map((tool) => tool.name)).not.toContain(CURRENT_WORKFLOW_TOOLS.save)
    for (const caller of [readonly, wrong]) {
      expect((await httpSave(t, t.input, caller.token)).statusCode).toBe(403)
      expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input, caller.token)).result?.isError).toBe(true)
      const audit = (await context.db.pool.query('select source,outcome from management_audit where principal_id=$1', [caller.principal.id])).rows
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'http', outcome: 'denied' }), expect.objectContaining({ source: 'mcp', outcome: 'denied' })]))
    }
    expect((await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders('invalid'), payload: t.input })).statusCode).toBe(401)
    await t.access.revoke(t.writer.principal.id)
    expect((await httpSave(t)).statusCode).toBe(401)
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)).status).toBe(401)
    expect(await count(t, 'workflow_versions')).toBe(0)
  })
  it('MCP rejects a missing Agent mutation grant and stale displayed metadata before Stage', async () => {
    const t = await fixture(), first = await save(t), stage = await agentStage(t, first)
    const denied = await t.credential([{ actions: ManagementActionSchema.options.filter((action) => action !== 'agents:update'), scope: { workspaceIds: [stage.workspaceId] } }])
    const remote = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, denied.token)
    expect(graphRpcValue(remote.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const stale = { ...stage, stagedAgents: stage.stagedAgents.map((item) => ({ ...item, baseRevision: item.baseRevision + 1 })) }
    const http = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: stale })
    expect(http.statusCode, http.body).toBe(409); expect(http.json()).toMatchObject({ error: { code: 'AGENT_REVISION_CONFLICT' } })
    expect((await context.db.pool.query('select 1 from graph_edit_intents where workflow_id=$1', [stage.workflowId])).rowCount).toBe(0)
  })
  it('full-definition Discard preserves the saved head and exact command conflicts; another caller cannot read a private intent', async () => {
    const t = await fixture(), first = await save(t)
    const stage = { ...t.input, action: 'stage_edits', draftId: `editor-${randomUUID()}`, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, name: 'Private unsaved label' } }
    const result = await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(result.result?.isError).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(result.result)).intent!
    const scope = { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId, draftId: stage.draftId, intentId: intent.id }
    const other = await t.credential([{ actions: ManagementActionSchema.options, scope: { workspaceIds: [t.input.workspaceId] } }])
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' }, other.token)).result?.isError).toBe(true)
    const changed = await t.call(CURRENT_WORKFLOW_TOOLS.edits, { ...scope, action: 'discard_edits', commandId: randomUUID() })
    expect(graphRpcValue(changed.result)).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const discard = { ...scope, action: 'discard_edits', commandId: intent.discardCommandId }
    const dropped = await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: discard })
    expect(dropped.statusCode, dropped.body).toBe(200); expect(dropped.json().intent.state).toBe('discarded')
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, discard)).result)).toEqual(dropped.json())
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.saved,
      { workspaceId: t.input.workspaceId, workflowId: t.input.workflowId })).result)).version).toEqual(first.value.version)
    expect(t.cancel).not.toHaveBeenCalled()
  })
  it('denies worker credentials and revalidates withdrawn Stop grants before any intent effect', async () => {
    const t = await fixture('single'), first = await save(t), stage = await agentStage(t, first)
    await insertFixtureRepeatRun(context.db.pool, { ...t.f, run: { ...t.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: context.db.directory, locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } } }, first.value, t.writer.principal.id)
    const worker = await t.access.issue({ name: 'Worker has no management authority', audience: 'worker', agentId: t.configurations[0]!.agentId,
      grants: [{ actions: ManagementActionSchema.options, scope: {} }], expiresAt: new Date(Date.now() + 300000) })
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage, worker.token)).status).toBe(403)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.edits, stage)).result)).intent!
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId, intentId: intent.id }
    await context.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [t.writer.principal.id,
      JSON.stringify([{ actions: ManagementActionSchema.options.filter((action) => action !== 'runs:stop'), scope: { workspaceIds: [stage.workspaceId] } }])])
    const advance = { ...scope, action: 'stop_and_save', commandId: intent.advanceCommandId }
    expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result?.isError).toBe(true)
    expect((await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(t.writer.token), payload: advance })).statusCode).toBe(403)
    const read = CurrentEditReadResultSchema.parse(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.editRead, { ...scope, action: 'read_edits' })).result))
    expect(read.intent?.saveInput).toEqual(intent.saveInput)
    expect(read.intent?.stops).toEqual(intent.stops)
    expect((await context.db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'", [t.writer.principal.id])).rowCount).toBe(0)
    expect(t.cancel).not.toHaveBeenCalled(); expect(await count(t, 'workflow_versions')).toBe(1)
  })
})

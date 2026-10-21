import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { graphRpcValue, graphHeaders } from './eng04-graph-composition-fixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { useWorkflowManagementFixture } from './workflowManagement.helpers.js'

describe.skipIf(!postgresEnabled)('Authenticated workflow management save', () => {
  const context = useWorkflowManagementFixture()
  const { fixture, httpSave, save, count } = context
  it('publishes through MCP, conflicts on changed command input, and retains exact old versions after a later Save', async () => {
    const t = await fixture()
    const result = await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)
    expect(result.result?.isError).not.toBe(true)
    const first = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(result.result))
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t)).json()).replayed).toBe(true)
    const conflict = await httpSave(t, { ...t.input, graph: { ...t.input.graph, name: 'different input' } })
    expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } })
    const next = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: { ...first.value.version.definition, name: 'Next exact immutable version' } }
    const second = CurrentWorkflowSaveResultSchema.parse((await httpSave(t, next)).json())
    expect(second.value.currentVersionId).not.toBe(first.value.currentVersionId)
    const historical = await t.app.inject({ method: 'GET', url: `${t.url}?workflowVersionId=${first.value.currentVersionId}`, headers: graphHeaders(t.writer.token) })
    expect(historical.json()).toMatchObject({ currentVersionId: second.value.currentVersionId, version: first.value.version })
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t)).json())).toEqual({ ...first, replayed: true })
  })
  it('rejects stale revision and version/configuration references without creating an immutable version', async () => {
    const t = await fixture()
    for (const changed of [{ expectedRevision: t.input.expectedRevision + 1 }, { expectedWorkflowVersionId: 'wrong-version' },
      { expectedAgentConfigurationVersionIds: {} }]) {
      const input = { ...t.input, ...changed, commandId: randomUUID() }
      const http = await httpSave(t, input)
      expect(http.statusCode).toBe(409)
      const remote = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(remote.result?.isError).toBe(true)
    }
    expect(await count(t, 'workflow_versions')).toBe(0)
  })
  it('persists repeated Agent nodes over MCP and HTTP with one exact immutable configuration', async () => {
    const t = await fixture()
    const input = structuredClone(t.input)
    const [first, second] = input.graph.nodes
    if (!first || !second || first.kind === 'job' || second.kind === 'job') throw new Error('Two Agent nodes expected')
    delete input.expectedAgentConfigurationVersionIds[second.agentId]
    second.agentId = first.agentId
    input.graph.requiredAgentCount = 1
    const saved = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
    expect(saved.result?.isError).not.toBe(true)
    const value = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(saved.result)).value
    expect(value.version.definition.nodes.map((node) => node.id)).toEqual([first.id, second.id])
    expect(value.version.agentConfigurationVersionIds).toEqual(input.expectedAgentConfigurationVersionIds)
    expect(CurrentWorkflowSaveResultSchema.parse((await httpSave(t, input)).json()).replayed).toBe(true)
    const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    const read = await t.call(CURRENT_WORKFLOW_TOOLS.saved, scope)
    expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result)).version).toEqual(value.version)
    const http = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
    expect(http.statusCode, http.body).toBe(200)
    expect(CurrentWorkflowReadResultSchema.parse(http.json()).version).toEqual(value.version)
    expect(await count(t, 'workflow_versions')).toBe(1)
    expect(await count(t, 'runs')).toBe(0)
  })
  it('serializes concurrent Saves at the displayed version and replays the winning exact command', async () => {
    const t = await fixture(), first = await save(t)
    const candidates = ['First writer', 'Second writer'].map((name) => ({ ...t.input, commandId: randomUUID(),
      expectedRevision: first.value.revision, expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, name } }))
    const replies = await Promise.all(candidates.map((input) => httpSave(t, input)))
    expect(replies.map((reply) => reply.statusCode).sort()).toEqual([200, 409])
    const winnerIndex = replies.findIndex((reply) => reply.statusCode === 200)
    const winner = CurrentWorkflowSaveResultSchema.parse(replies[winnerIndex]!.json())
    expect(graphRpcValue((await t.call(CURRENT_WORKFLOW_TOOLS.save, candidates[winnerIndex]!)).result)).toEqual({ ...winner, replayed: true })
    const rows = (await context.db.pool.query('select record from workflow_versions where workflow_id=$1 order by version', [t.input.workflowId])).rows
    expect(rows.map((row) => row.record)).toEqual([first.value.version, winner.value.version])
  })
})

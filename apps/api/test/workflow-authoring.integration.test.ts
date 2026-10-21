import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema,
} from '@foreman-code/contracts/wave25'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'

describe.skipIf(!postgresEnabled)('workflow authoring over authenticated MCP', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { database = await currentDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.app.close())) })
  afterAll(async () => { await database?.close() })

  async function savedFixture() {
    const fixture = await writerFixture(database)
    fixtures.push(fixture)
    const input = {
      workspaceId: fixture.input.workspaceId,
      workflowId: fixture.input.workflowId,
      commandId: randomUUID(),
      executionSemanticsVersion: 3,
      expectedRevision: fixture.input.expectedRevision,
      expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: fixture.input.expectedAgentConfigurationVersionIds,
      graph: fixture.input.graph,
    }
    const response = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, input)
    expect(response.result?.isError, JSON.stringify(response.result)).not.toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(response.result)).value
    return { fixture, input: { ...input, expectedRevision: saved.revision,
      expectedWorkflowVersionId: saved.currentVersionId, graph: saved.version.definition }, saved }
  }

  it('uses last write wins for names and layout, preserving immutable versions, retries and denied writes', async () => {
    const { fixture, input, saved } = await savedFixture()
    const rename = { ...input, commandId: randomUUID(), graph: { ...input.graph,
      nodes: input.graph.nodes.map((node, index) => index ? node : { ...node, name: 'First name' }) } }
    const first = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, rename)
    expect(first.result?.isError, JSON.stringify(first.result)).not.toBe(true)
    const latest = { ...input, commandId: randomUUID(), graph: { ...input.graph,
      nodes: input.graph.nodes.map((node, index) => index ? node : {
        ...node, name: 'Latest name', position: { x: 600, y: 80 },
      }) } }
    const response = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, latest)
    expect(response.result?.isError, JSON.stringify(response.result)).not.toBe(true)
    const result = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(response.result))
    expect(result.value).toMatchObject({ revision: saved.revision, version: saved.version,
      presentation: { nodes: latest.graph.nodes } })
    expect(graphRpcValue((await fixture.call(CURRENT_WORKFLOW_TOOLS.save, rename)).result))
      .toEqual({ ...CurrentWorkflowSaveResultSchema.parse(graphRpcValue(first.result)), replayed: true })
    const reader = await fixture.credential([{ actions: ['workflows:read', 'graph:read'],
      scope: { workspaceIds: [input.workspaceId] } }])
    expect((await fixture.call(CURRENT_WORKFLOW_TOOLS.save, { ...rename, commandId: randomUUID() }, reader.token))
      .result?.isError).toBe(true)
    expect(graphRpcValue((await fixture.call('workflow_get', {
      workspaceId: input.workspaceId, workflowId: input.workflowId,
    }, reader.token)).result)).toMatchObject({ workflow: { nodes: latest.graph.nodes } })
    const stale = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, {
      ...latest, commandId: randomUUID(), expectedRevision: saved.revision - 1,
    })
    expect(graphRpcValue(stale.result)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
  })

  it('publishes staged edits after Agent and location changes while retaining the authored configuration snapshots', async () => {
    const { fixture, input } = await savedFixture()
    const stage = { ...input, action: 'stage_edits', draftId: 'draft', commandId: randomUUID(),
      graph: { ...input.graph, name: 'Saved edit' } }
    const staged = await fixture.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
    expect(staged.result?.isError, JSON.stringify(staged.result)).not.toBe(true)
    const intent = CurrentEditReadResultSchema.parse(graphRpcValue(staged.result)).intent!
    for (const configuration of fixture.configurations) {
      const updated = { ...configuration, id: `${configuration.id}-updated`, version: configuration.version + 1 }
      await database.pool.query(
        'insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,$4,$5::jsonb)',
        [updated.id, input.workspaceId, updated.agentId, updated.version, JSON.stringify(updated)])
      await database.pool.query(`update agents set metadata_revision=metadata_revision+1,
        current_configuration_version_id=$2,record=jsonb_set(record,'{configurationVersionId}',to_jsonb($2::text))
        where id=$1`, [updated.agentId, updated.id])
    }
    await database.pool.query('update workspaces set location_revision=location_revision+1 where id=$1',
      [input.workspaceId])
    const response = await fixture.call(CURRENT_WORKFLOW_TOOLS.edits, {
      action: 'stop_and_save', workspaceId: input.workspaceId, workflowId: input.workflowId,
      draftId: stage.draftId, intentId: intent.id, commandId: intent.advanceCommandId,
    })
    expect(response.result?.isError, JSON.stringify(response.result)).not.toBe(true)
    const published = CurrentEditReadResultSchema.parse(graphRpcValue(response.result)).intent!
    expect(published.state).toBe('saved')
    expect(published.result?.version.agentConfigurationVersionIds).toEqual(input.expectedAgentConfigurationVersionIds)
    expect(graphRpcValue((await fixture.call('workflow_get', {
      workspaceId: input.workspaceId, workflowId: input.workflowId,
    })).result)).toMatchObject({ workflow: { name: 'Saved edit' } })
  })
})

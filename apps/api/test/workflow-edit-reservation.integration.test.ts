import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowSaveResultSchema,
  } from '@foreman-code/contracts/wave25'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

async function insertActiveRun(f: Awaited<ReturnType<typeof writerFixture>>,
  saved: ReturnType<typeof CurrentWorkflowSaveResultSchema.parse>['value']) {
  const fixture = { ...f.f, run: { ...f.f.run, executionLocation: {
    runnerId: 'runner-local',
    rootPath: f.db.directory,
    locationRevision: 1,
    identityHash: `sha256:${'1'.repeat(64)}`,
  } } }
  return insertCurrentRunFixture(f.db.pool, fixture, saved, f.writer.principal.id)
}

describe.skipIf(!postgresEnabled)('workflow-wide edit staging reservation', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  it('persists the configured execution location on the active Run fixture', async () => {
    const f = await writerFixture(database)
    try {
      const response = await f.app.inject({ method: 'PUT', url: f.url,
        headers: graphHeaders(f.writer.token), payload: f.input })
      expect(response.statusCode, response.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
      const { run } = await insertActiveRun(f, saved)
      expect(run.executionLocation).toMatchObject({
        runnerId: 'runner-local', rootPath: database.directory, locationRevision: 1,
      })
      expect((await database.pool.query('select record from runs where id=$1', [run.id])).rows[0]!.record)
        .toMatchObject({ executionLocation: run.executionLocation, executionState: 'queued', outcome: 'pending' })
    } finally { await f.app.close() }
  })

  it.each([false, true])('rejects a competing principal before any Stop plan with active Run=%s', async (active) => {
    const f = await writerFixture(database)
    try {
      const response = await f.app.inject({ method: 'PUT', url: f.url, headers: graphHeaders(f.writer.token), payload: f.input })
      expect(response.statusCode, response.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(response.json()).value
      const run = active ? await insertActiveRun(f, saved) : null
      const other = await f.credential([{ actions: ManagementActionSchema.options,
        scope: { workspaceIds: [f.input.workspaceId] } }])
      const stage = { ...f.input, action: 'stage_edits', commandId: randomUUID(), draftId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, name: 'Private staged workflow' } }
      const first = await f.call(CURRENT_WORKFLOW_TOOLS.edits, stage)
      expect(first.result?.isError, JSON.stringify(first.result)).not.toBe(true)
      const intent = CurrentEditReadResultSchema.parse(graphRpcValue(first.result)).intent!
      const competing = { ...stage, commandId: randomUUID(), draftId: randomUUID(),
        graph: { ...stage.graph, name: 'Other staged workflow' } }
      const denied = await f.app.inject({ method: 'POST', url: `${f.url}/edits`,
        headers: graphHeaders(other.token), payload: competing })
      expect(denied.statusCode, denied.body).toBe(409)
      expect(denied.json()).toMatchObject({ error: { code: 'GRAPH_EDIT_INTENT_EXISTS' } })
      expect(denied.body).not.toContain(stage.graph.name)
      expect(denied.body).not.toContain(intent.id)
      const privateRead = await f.call(CURRENT_WORKFLOW_TOOLS.editRead, { action: 'read_edits',
        workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: competing.draftId }, other.token)
      expect(CurrentEditReadResultSchema.parse(graphRpcValue(privateRead.result)).intent).toBeNull()
      expect((await database.pool.query('select principal_id from graph_edit_intents where workflow_id=$1',
        [stage.workflowId])).rows).toEqual([{ principal_id: f.writer.principal.id }])
      expect((await database.pool.query("select action from management_audit where action='graph.edit_stop_attempt' and principal_id=any($1::text[])",
        [[f.writer.principal.id, other.principal.id]])).rows).toEqual([])
      if (run) {
        expect((await database.pool.query('select record from runs where id=$1', [run.run.id])).rows[0]!.record)
          .toMatchObject({ executionState: run.run.executionState, outcome: run.run.outcome })
      } else {
        const advanced = await f.call(CURRENT_WORKFLOW_TOOLS.edits, { action: 'stop_and_save',
          workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
          intentId: intent.id, commandId: intent.advanceCommandId })
        expect(CurrentEditReadResultSchema.parse(graphRpcValue(advanced.result)).intent?.state).toBe('saved')
      }
    } finally { await f.app.close() }
  })
})

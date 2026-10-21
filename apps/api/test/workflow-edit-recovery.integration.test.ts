import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditIntentSchema, CurrentEditReadResultSchema,
  CurrentEditStageInputSchema, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'

async function seedRenameIntent(t: WriterFixture, principal: ManagementPrincipal,
  stage: ReturnType<typeof CurrentEditStageInputSchema.parse>, state: 'staged' | 'uncertain',
  options: { saveAttempted?: boolean } = {}) {
  const id = `graph-edit-${randomUUID()}`
  const advanceCommandId = randomUUID()
  const discardCommandId = randomUUID()
  const commandScope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
    intentId: id }
  const { action, draftId, commandId, ...definition } = stage
  const saveInput = { ...definition, commandId: randomUUID() }
  const now = new Date().toISOString()
  // Seed a retained command; recovery uses the authenticated product endpoints.
  await t.commands.execute({ principal, source: 'http', operation: 'graph.stage_edits', commandId,
    targetKey: `draft:${draftId}`, payload: stage, perform: async (client) => {
      const current = await readAffectedGraphRuns(client, { ...stage, stagedAgentIds: [] })
      const heads = (await client.query<{ id: string; metadata_revision: string }>(
        'select id,metadata_revision::text from agents where workspace_id=$1 order by id', [stage.workspaceId])).rows
      const record = CurrentEditIntentSchema.parse({ kind: 'current', id, ownerPrincipalId: principal.id,
        workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId,
        stageCommandId: commandId, stageInputHash: commandInputHash(stage),
        advanceCommandId, advanceInputHash: commandInputHash({ ...commandScope, action: 'stop_and_save',
          commandId: advanceCommandId }),
        discardCommandId, discardInputHash: commandInputHash({ ...commandScope, action: 'discard_edits',
          commandId: discardCommandId }),
        expectedRevision: stage.expectedRevision, savedWorkflowRevision: stage.expectedRevision,
        expectedWorkflowVersionId: stage.expectedWorkflowVersionId,
        stagedDraft: { id: draftId, workspaceId: stage.workspaceId, workflowId: stage.workflowId,
          revision: stage.expectedRevision, baseWorkflowVersionId: stage.expectedWorkflowVersionId,
          graph: stage.graph, agentConfigurationVersionIds: stage.expectedAgentConfigurationVersionIds },
        agentPins: heads.map((head) => ({ agentId: head.id, metadataRevision: Number(head.metadata_revision),
          configurationVersionId: stage.expectedAgentConfigurationVersionIds[head.id] })),
        affected: current.map((run) => run.pin), stops: current.filter((run) => !run.settled).map((run) => {
          const input = { workspaceId: stage.workspaceId, runId: run.pin.runId, commandId: randomUUID() }
          return { input }
        }), saveInput, saveInputHash: commandInputHash(saveInput), state,
        saveAttempted: options.saveAttempted ?? state === 'uncertain',
        ...(state === 'uncertain' ? { error: { code: 'COMMAND_UNCERTAIN', message: 'Save reply lost', uncertain: true } } : {}),
        createdAt: now, updatedAt: now })
      await client.query(`insert into graph_edit_intents(id,principal_id,workspace_id,workflow_id,draft_id,state,record)
        values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [id, principal.id, stage.workspaceId, stage.workflowId, draftId, record.state, JSON.stringify(record)])
      return { intentId: id }
    } })
  expect(action).toBe('stage_edits')
  return CurrentEditIntentSchema.parse((await t.db.pool.query('select record from graph_edit_intents where id=$1',
    [id])).rows[0]!.record)
}

describe.skipIf(!postgresEnabled)('persisted workflow edit recovery', () => {
  it.each(['staged', 'uncertain'] as const)('resumes a %s rename over HTTP and MCP without replacing commands', async (state) => {
    const db = await currentDatabase()
    let initial: WriterFixture | undefined
    let restarted: ReturnType<typeof buildApp> | undefined
    try {
      const t = await writerFixture(db)
      initial = t
      const first = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
      expect(first.statusCode, first.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(first.json()).value
      const renamer = await t.credential([{ actions: ['workflows:read', 'workflows:update', 'graph:read',
        'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read', 'runs:read'],
      scope: { workspaceIds: [t.input.workspaceId] } }])
      const insertRun = () => insertCurrentRunFixture(db.pool, { ...t.f, run: { ...t.f.run,
        executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1,
          identityHash: `sha256:${'1'.repeat(64)}` } } }, saved, t.writer.principal.id)
      if (state === 'staged') await insertRun()
      const stage = CurrentEditStageInputSchema.parse({ ...t.input, action: 'stage_edits', draftId: randomUUID(),
        commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map((node, index) =>
          index ? node : { ...node, name: 'Resumed name', label: 'Resumed label' }) } })
      const intent = await seedRenameIntent(t, renamer.principal, stage, state)
      if (state === 'uncertain') await insertRun()
      const runBefore = (await db.pool.query('select record from runs where id=$1', [t.f.run.id])).rows[0]!.record
      expect(intent.stagedDraft.presentationOnly).toBeUndefined()
      await t.app.close()
      await applyApplicationMigrations(db.pool)
      expect((await db.pool.query('select record from graph_edit_intents where id=$1', [intent.id])).rows[0]!.record)
        .toEqual(JSON.parse(JSON.stringify(intent)))
      const commands = new PostgresCommandCoordinator(db.pool)
      const workflows = new WorkflowManagementService(db.pool, commands)
      restarted = buildApp({ readiness: { database: { ping: async () => { await db.pool.query('select 1') } },
        checkpoints: { ping: async () => undefined } },
      operator: { access: t.access, services: { workflows, commands } as OperatorServices } })
      const call = (name: string, args: unknown, token = renamer.token) => graphRpc(restarted!, token,
        'tools/call', { name, arguments: args })
      const readInput = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'read_edits' }
      const reopened = CurrentEditReadResultSchema.parse(graphRpcValue((await call(CURRENT_WORKFLOW_TOOLS.editRead,
        readInput)).result))
      expect(reopened.intent).toEqual(intent)
      expect(reopened.current).toEqual([])
      expect(reopened.affectedSetChanged).toBe(false)
      const stageReplay = await restarted.inject({ method: 'POST', url: `${t.url}/edits`,
        headers: graphHeaders(renamer.token), payload: stage })
      expect(stageReplay.statusCode, stageReplay.body).toBe(200)
      expect(CurrentEditReadResultSchema.parse(stageReplay.json())).toEqual(reopened)
      const advance = { ...readInput, action: 'stop_and_save', commandId: intent.advanceCommandId }
      const denied = await t.credential([{ actions: ['workflows:read', 'graph:read'],
        scope: { workspaceIds: [stage.workspaceId] } }])
      expect((await restarted.inject({ method: 'POST', url: `${t.url}/edits`,
        headers: graphHeaders(denied.token), payload: advance })).statusCode).toBe(403)
      const deniedAdvance = await call(CURRENT_WORKFLOW_TOOLS.edits, advance, denied.token)
      expect(deniedAdvance.result?.isError).toBe(true)
      expect(graphRpcValue(deniedAdvance.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect((await db.pool.query('select record from graph_edit_intents where id=$1', [intent.id])).rows[0]!.record)
        .toEqual(JSON.parse(JSON.stringify(intent)))
      const response = await restarted.inject({ method: 'POST', url: `${t.url}/edits`,
        headers: graphHeaders(renamer.token), payload: advance })
      expect(response.statusCode, response.body).toBe(200)
      const published = CurrentEditReadResultSchema.parse(response.json())
      expect(published.intent?.state).toBe('saved')
      expect(published.intent?.result).toMatchObject({ revision: saved.revision,
        currentVersionId: saved.currentVersionId, version: saved.version,
        presentation: { nodes: stage.graph.nodes } })
      expect(published.intent).toMatchObject({ id: intent.id, stageCommandId: intent.stageCommandId,
        stageInputHash: intent.stageInputHash, advanceCommandId: intent.advanceCommandId,
        advanceInputHash: intent.advanceInputHash, discardCommandId: intent.discardCommandId,
        discardInputHash: intent.discardInputHash, saveInput: intent.saveInput, saveInputHash: intent.saveInputHash,
        stagedDraft: intent.stagedDraft, affected: intent.affected, stops: intent.stops, saveAttempted: true })
      expect(graphRpcValue((await call(CURRENT_WORKFLOW_TOOLS.edits, advance)).result)).toEqual(published)
      const read = await restarted.inject({ method: 'GET', url: t.url, headers: graphHeaders(renamer.token) })
      expect(CurrentWorkflowReadResultSchema.parse(read.json()).version).toEqual(saved.version)
      expect(graphRpcValue((await call('workflow_get', { workspaceId: stage.workspaceId,
        workflowId: stage.workflowId })).result)).toMatchObject({ revision: saved.revision,
        currentVersionId: saved.currentVersionId, workflow: { nodes: stage.graph.nodes } })
      expect((await db.pool.query('select record from runs where id=$1', [t.f.run.id])).rows[0]!.record).toEqual(runBefore)
      expect((await db.pool.query('select 1 from workflow_versions where workflow_id=$1',
        [stage.workflowId])).rowCount).toBe(1)
      expect((await db.pool.query("select 1 from management_command_receipts where principal_id=$1 and operation='run.stop'",
        [renamer.principal.id])).rowCount).toBe(0)
      const receipt = (await db.pool.query(`select command_id,input_hash,result from management_command_receipts
        where principal_id=$1 and operation='workflow.save.v3'`, [renamer.principal.id])).rows
      expect(receipt).toEqual([{ command_id: intent.saveInput.commandId, input_hash: intent.saveInputHash,
        result: JSON.parse(JSON.stringify(published.intent!.result)) }])
    } finally {
      await restarted?.close()
      await initial?.app.close()
      await db.close()
    }
  }, 60000)

  it('publishes a retained rename after another rename at the same workflow revision', async () => {
    const db = await currentDatabase()
    let t: WriterFixture | undefined
    try {
      t = await writerFixture(db)
      const first = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
      const saved = CurrentWorkflowSaveResultSchema.parse(first.json()).value
      const stage = CurrentEditStageInputSchema.parse({ ...t.input, action: 'stage_edits', draftId: randomUUID(),
        commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map((node, index) =>
          index ? node : { ...node, name: 'Older staged name' }) } })
      const intent = await seedRenameIntent(t, t.writer.principal, stage, 'staged')
      await applyApplicationMigrations(db.pool)
      const competing = { ...intent.saveInput, commandId: randomUUID(),
        graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map((node, index) =>
          index ? node : { ...node, name: 'Another saved name' }) } }
      const changed = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: competing })
      expect(changed.statusCode, changed.body).toBe(200)
      const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
      const response = await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance)
      const published = CurrentEditReadResultSchema.parse(graphRpcValue(response.result))
      expect(published.intent).toMatchObject({ state: 'saved', saveAttempted: true,
        saveInput: intent.saveInput, saveInputHash: intent.saveInputHash })
      expect(published.intent?.result?.presentation?.nodes).toEqual(stage.graph.nodes)
      expect(graphRpcValue((await t.call('workflow_get', { workspaceId: stage.workspaceId,
        workflowId: stage.workflowId })).result)).toMatchObject({ workflow: { nodes: stage.graph.nodes } })
    } finally {
      await t?.app.close()
      await db.close()
    }
  }, 60000)

  it('retains an uncertain Stop across restart and denied retries', async () => {
    const db = await currentDatabase()
    let t: WriterFixture | undefined
    try {
      t = await writerFixture(db)
      const first = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
      const saved = CurrentWorkflowSaveResultSchema.parse(first.json()).value
      await insertCurrentRunFixture(db.pool, { ...t.f, run: { ...t.f.run,
        executionLocation: { runnerId: 'runner-local', rootPath: db.directory, locationRevision: 1,
          identityHash: `sha256:${'1'.repeat(64)}` } } }, saved, t.writer.principal.id)
      const renamer = await t.credential([{ actions: ['workflows:read', 'workflows:update', 'graph:read',
        'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read', 'runs:read'],
      scope: { workspaceIds: [t.input.workspaceId] } }])
      const stage = CurrentEditStageInputSchema.parse({ ...t.input, action: 'stage_edits', draftId: randomUUID(),
        commandId: randomUUID(), expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map((node, index) =>
          index ? node : { ...node, label: 'Pending rename' }) } })
      const intent = await seedRenameIntent(t, renamer.principal, stage, 'uncertain', { saveAttempted: false })
      const stop = intent.stops[0]!
      const targetKey = `edit-intent:${intent.id}`
      await t.commands.recordAudit(renamer.principal.id, 'http', 'graph.edit_stop_attempt', targetKey,
        'uncertain', { commandId: stop.input.commandId, targetKey: `run:${stop.input.runId}` })
      await applyApplicationMigrations(db.pool)
      const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
      expect((await t.app.inject({ method: 'POST', url: `${t.url}/edits`, headers: graphHeaders(renamer.token),
        payload: advance })).statusCode).toBe(403)
      expect((await t.call(CURRENT_WORKFLOW_TOOLS.edits, advance, renamer.token)).result?.isError).toBe(true)
      const reopened = await t.call(CURRENT_WORKFLOW_TOOLS.editRead, {
        workspaceId: stage.workspaceId, workflowId: stage.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'read_edits',
      }, renamer.token)
      expect(CurrentEditReadResultSchema.parse(graphRpcValue(reopened.result)).intent).toMatchObject({
        state: 'uncertain', saveAttempted: false, saveInput: intent.saveInput, saveInputHash: intent.saveInputHash,
        stops: intent.stops, error: { code: 'ACCESS_DENIED', uncertain: true },
      })
      expect((await db.pool.query(`select details from management_audit where principal_id=$1
        and action='graph.edit_stop_attempt' and target_key=$2`, [renamer.principal.id, targetKey])).rows)
        .toEqual([{ details: { commandId: stop.input.commandId, targetKey: `run:${stop.input.runId}` } }])
      expect((await db.pool.query(`select 1 from management_command_receipts where principal_id=$1
        and operation in ('run.stop','workflow.save.v3')`, [renamer.principal.id])).rowCount).toBe(0)
    } finally {
      await t?.app.close()
      await db.close()
    }
  }, 60000)
})

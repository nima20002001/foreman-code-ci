import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canonicalGraphJson, CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'

// Current V3 publication SQL fences. Authenticated Create/Save/read/Start,
// grants, revision conflicts and replay are additionally covered in the B suite.
// No legacy writer, native qualification, or direct privilege/config changes.
describe.skipIf(!postgresEnabled)('ENG04 current V3 writer PostgreSQL contract', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { db = await currentDatabase() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture() { const t = await writerFixture(db, 'repeat'); fixtures.push(t); return t }
  async function save(t: WriterFixture) {
    const response = await t.app.inject({ method: 'PUT', url: t.url, headers: graphHeaders(t.writer.token), payload: t.input })
    expect(response.statusCode, response.body).toBe(200)
    return CurrentWorkflowSaveResultSchema.parse(response.json())
  }
  async function snapshot(t: WriterFixture) {
    return (await db.pool.query(`select w.record,w.current_version_id,w.revision::text,
      (select count(*) from workflow_versions where workflow_id=w.id)::text as versions,
      (select count(*) from current_workflow_publications where workflow_id=w.id)::text as publications
      from workflows w where w.id=$1`, [t.input.workflowId])).rows
  }
  it('commits an exact V3 publication, receipt and success audit and replays across authenticated MCP', async () => {
    const t = await fixture(), saved = await save(t)
    const publication = (await db.pool.query(`select p.*,r.operation,r.result,a.outcome from current_workflow_publications p
      join management_command_receipts r on r.principal_id=p.principal_id and r.command_id=p.command_id
      join management_audit a on a.principal_id=p.principal_id and a.details->>'commandId'=p.command_id
      where p.workflow_version_id=$1 and r.operation='workflow.save.v3' and a.outcome='succeeded'`, [saved.value.currentVersionId])).rows
    expect(publication).toHaveLength(1)
    expect(publication[0]).toMatchObject({ input: JSON.parse(JSON.stringify(t.input)), workflow_id: t.input.workflowId, principal_id: t.writer.principal.id,
      command_id: t.input.commandId, result: saved.value })
    const before = await snapshot(t)
    const replay = await t.call(CURRENT_WORKFLOW_TOOLS.save, t.input)
    expect(replay.result?.isError).not.toBe(true)
    expect(CurrentWorkflowSaveResultSchema.parse(graphRpcValue(replay.result))).toEqual({ ...saved, replayed: true })
    expect(await snapshot(t)).toEqual(before)
  })
  it('rejects direct definition changes, semantics downgrades and immutable publication/version rewrites', async () => {
    const t = await fixture(), saved = await save(t), before = await snapshot(t)
    const statements = [
      ["update workflows set record=jsonb_set(record,'{executionSemanticsVersion}','2'::jsonb) where id=$1", t.input.workflowId],
      ["update workflows set record=jsonb_set(record,'{repeat,blocks,0,maxOccurrences}','9'::jsonb) where id=$1", t.input.workflowId],
      ["update workflow_versions set record=jsonb_set(record,'{definition,name}','\"tampered\"'::jsonb) where id=$1", saved.value.currentVersionId],
      ['delete from current_workflow_publications where workflow_version_id=$1', saved.value.currentVersionId],
    ] as const
    for (const [sql, id] of statements) {
      await expect(db.pool.query(sql, [id])).rejects.toThrow()
      expect(await snapshot(t)).toEqual(before)
    }
  })
  it('rejects COMMIT without the exact receipt and audit and rolls back the candidate and head', async () => {
    const t = await fixture(), first = await save(t), before = await snapshot(t)
    const input = { ...t.input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...first.value.version.definition, name: 'Second publication' } }
    const now = new Date().toISOString(), number = first.value.version.version + 1
    const candidate = { ...first.value.version, id: `workflow-version-${randomUUID()}`, version: number, createdAt: now,
      definition: { ...input.graph, version: number, updatedAt: now } }
    const content = canonicalGraphJson({ definition: candidate.definition,
      configurations: candidate.agentConfigurationVersionIds, entryNodeId: candidate.entryNodeId })
    candidate.contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const sql = await db.pool.connect()
    try {
      await sql.query('begin')
      await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
        values($1,$2,$3,$4,$5,$6::jsonb,3)`, [candidate.id, candidate.workspaceId, candidate.workflowId,
        number, candidate.entryNodeId, JSON.stringify(candidate)])
      await sql.query('select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)',
        [t.writer.principal.id, 'http', JSON.stringify(input), commandInputHash(input), candidate.id, content])
      await expect(sql.query('commit')).rejects.toMatchObject({ code: 'PGC04' })
      await sql.query('rollback')
    } finally { sql.release() }
    expect(await snapshot(t)).toEqual(before)
  })
})

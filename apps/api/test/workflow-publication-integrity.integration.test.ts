import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  canonicalGraphJson, CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema,
} from '@foreman-code/contracts/wave25'
import { commandInputHash } from '../src/modules/commands/postgres.js'
import { inTransaction } from '../src/infrastructure/transaction.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { writerFixture, type WriterFixture } from './eng04-writer-fixtures.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'

describe('workflow publication and save admission', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  const fixtures: WriterFixture[] = []
  beforeAll(async () => { database = await currentDatabase() })
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.app.close()
  })
  afterAll(async () => { await database?.close() })

  async function fixture() {
    const value = await writerFixture(database, 'repeat')
    fixtures.push(value)
    return value
  }

  async function save(value: WriterFixture) {
    const response = await value.app.inject({ method: 'PUT', url: value.url,
      headers: graphHeaders(value.writer.token), payload: value.input })
    expect(response.statusCode, response.body).toBe(200)
    return CurrentWorkflowSaveResultSchema.parse(response.json())
  }

  async function stored(value: WriterFixture) {
    return (await database.pool.query(`select w.record,w.current_version_id,w.revision::text,
      (select jsonb_agg(v.record order by v.version) from workflow_versions v where v.workflow_id=w.id) as versions,
      (select count(*) from current_workflow_publications p where p.workflow_id=w.id)::text as publications
      from workflows w where w.id=$1`, [value.input.workflowId])).rows
  }

  it('applies the publication migration once and commits a receipt and audit that replay through MCP', async () => {
    const applied = (await database.pool.query('select version from application_migrations order by version')).rows
      .map(row => Number(row.version))
    expect(applied.filter(version => version === 264502)).toHaveLength(1)
    expect(applied[applied.indexOf(264502) - 1]).toBe(264501)
    const value = await fixture()
    const saved = await save(value)
    const before = await stored(value)
    const replay = await value.call(CURRENT_WORKFLOW_TOOLS.save, value.input)
    expect(replay.result?.isError).not.toBe(true)
    expect(CurrentWorkflowSaveResultSchema.parse(graphRpcValue(replay.result))).toEqual({ ...saved, replayed: true })
    expect(await stored(value)).toEqual(before)
    const publication = await database.pool.query(`select p.input,r.result,a.outcome from current_workflow_publications p
      join management_command_receipts r on r.principal_id=p.principal_id and r.command_id=p.command_id
      join management_audit a on a.principal_id=p.principal_id and a.details->>'commandId'=p.command_id
      where p.workflow_version_id=$1 and r.operation='workflow.save.v3' and a.outcome='succeeded'`,
    [saved.value.currentVersionId])
    expect(publication.rows).toEqual([{ input: value.input, result: saved.value, outcome: 'succeeded' }])
  })

  it('preserves saved versions and rejects direct executable edits and semantics downgrades', async () => {
    const value = await fixture()
    const saved = await save(value)
    const before = await stored(value)
    const mutations = [
      ["update workflows set record=jsonb_set(record,'{executionSemanticsVersion}','2'::jsonb) where id=$1", value.input.workflowId],
      ["update workflows set record=jsonb_set(record,'{repeat,blocks,0,maxOccurrences}','9'::jsonb) where id=$1", value.input.workflowId],
      ["update workflow_versions set record=jsonb_set(record,'{definition,name}','\"tampered\"'::jsonb) where id=$1", saved.value.currentVersionId],
      ['delete from current_workflow_publications where workflow_version_id=$1', saved.value.currentVersionId],
    ] as const
    for (const [statement, id] of mutations) {
      await expect(database.pool.query(statement, [id])).rejects.toThrow()
      expect(await stored(value)).toEqual(before)
    }
  })

  it('rolls back a candidate and head when publication has no matching receipt and success audit', async () => {
    const value = await fixture()
    const saved = await save(value)
    const before = await stored(value)
    const input = { ...value.input, commandId: randomUUID(), expectedRevision: saved.value.revision,
      expectedWorkflowVersionId: saved.value.currentVersionId,
      graph: { ...saved.value.version.definition, name: 'Changed workflow' } }
    const now = new Date().toISOString()
    const version = saved.value.version.version + 1
    const candidate = { ...saved.value.version, id: `workflow-version-${randomUUID()}`, version, createdAt: now,
      definition: { ...input.graph, version, updatedAt: now } }
    const content = canonicalGraphJson({ definition: candidate.definition,
      configurations: candidate.agentConfigurationVersionIds, entryNodeId: candidate.entryNodeId })
    candidate.contentHash = `sha256:${createHash('sha256').update(content).digest('hex')}`
    await expect(inTransaction(database.pool, undefined, async sql => {
      await sql.query(`insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record,execution_semantics_version)
        values($1,$2,$3,$4,$5,$6::jsonb,3)`, [candidate.id, candidate.workspaceId, candidate.workflowId,
      version, candidate.entryNodeId, JSON.stringify(candidate)])
      await sql.query('select eng04_publish_current_workflow($1,$2,$3::jsonb,$4,$5,$6)',
        [value.writer.principal.id, 'http', JSON.stringify(input), commandInputHash(input), candidate.id, content])
    })).rejects.toMatchObject({ code: 'PGC04' })
    expect(await stored(value)).toEqual(before)
  })

  it('rejects invalid executable configuration pins without publishing a version', async () => {
    const value = await fixture()
    const before = await stored(value)
    const response = await value.app.inject({ method: 'PUT', url: value.url,
      headers: graphHeaders(value.writer.token), payload: { ...value.input, expectedAgentConfigurationVersionIds: {} } })
    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: { code: 'AGENT_CONFIGURATION_CONFLICT' } })
    expect(await stored(value)).toEqual(before)
  })

  it('rechecks live authorization before publication and receipt replay', async () => {
    const value = await fixture()
    await save(value)
    const before = await stored(value)
    await value.access.revoke(value.writer.principal.id)
    await expect(value.workflows.current.save(value.writer.principal, 'mcp', value.input))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(await stored(value)).toEqual(before)
  })

  it('requires affected Run settlement before publishing meaningful edits', async () => {
    const value = await fixture()
    const saved = await save(value)
    const runFixture = { ...value.f, run: { ...value.f.run,
      executionLocation: { runnerId: 'runner-local', rootPath: database.directory, locationRevision: 1,
        identityHash: `sha256:${'1'.repeat(64)}` } } }
    await insertCurrentRunFixture(database.pool, runFixture, saved.value, value.writer.principal.id)
    const before = await stored(value)
    const input = { ...value.input, commandId: randomUUID(), expectedRevision: saved.value.revision,
      expectedWorkflowVersionId: saved.value.currentVersionId, graph: structuredClone(saved.value.version.definition) }
    input.graph.repeat!.blocks[0]!.maxOccurrences += 1
    const response = await value.call(CURRENT_WORKFLOW_TOOLS.save, input)
    expect(response.result?.isError).toBe(true)
    expect(graphRpcValue(response.result)).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    expect(await stored(value)).toEqual(before)
  })
})

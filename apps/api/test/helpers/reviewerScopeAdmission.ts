import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { CurrentWorkflowSaveInputSchema } from '@foreman-code/contracts/wave25'
import { seedAgent3 } from './wave25Agent3.js'
import { reviewerScopeFixture, type ReviewerScopeCase } from './eng07ReviewAdmission.testSupport.js'
import { rpc, type SaveFixture, type Transport } from './eng07SaveAdmission.testSupport.js'
import { graphHeaders, graphRpcValue } from '../eng04-graph-composition-fixture.js'

export const code = 'REPEAT_REVIEW_SCOPE_UNSUPPORTED'
export async function counts(f: SaveFixture, workflowId: string) {
  const result = await f.db.pool.query(`select
    (select count(*)::int from workflow_versions where workflow_id=$1) as versions,
    (select count(*)::int from runs where workflow_id=$1) as runs`, [workflowId])
  return result.rows[0]
}
export async function candidate(f: SaveFixture, kind: ReviewerScopeCase) {
  const target = reviewerScopeFixture(kind)
  const baseline = structuredClone(target)
  delete baseline.version.definition.repeat
  for (const node of baseline.version.definition.nodes) delete node.choice
  await seedAgent3(f.db.pool, f.db.directory, baseline, { run: false })
  const row = (await f.db.pool.query('select revision::text from workflows where id=$1', [baseline.scope.workflowId])).rows[0]!
  return { target, baseline, input: CurrentWorkflowSaveInputSchema.parse({
    workspaceId: baseline.scope.workspaceId, workflowId: baseline.scope.workflowId,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: Number(row.revision),
    expectedWorkflowVersionId: baseline.version.id,
    expectedAgentConfigurationVersionIds: baseline.version.agentConfigurationVersionIds,
    graph: { ...target.version.definition, id: baseline.scope.workflowId, version: baseline.version.version,
      createdAt: baseline.version.definition.createdAt, updatedAt: baseline.version.definition.updatedAt,
      nodes: target.version.definition.nodes.map((node) => ({ ...node, initialPrompt: `ENG07 reviewer scope: ${kind}` })) },
  }) }
}
export async function rejected(f: SaveFixture, transport: Transport, tool: string, url: string,
  method: 'POST' | 'PUT', input: Record<string, unknown>) {
  const start = tool === 'run_start'
  const errorCode = start ? 'INVALID_REQUEST' : 'GRAPH_INVALID'
  if (transport === 'http') {
    const reply = await f.app.inject({ method, url, headers: graphHeaders(f.writer.token), payload: input })
    expect(reply.statusCode, reply.body).toBe(start ? 400 : 409)
    expect(reply.json()).toMatchObject({ error: { code: errorCode } })
    expect(JSON.stringify(reply.json().error.details)).toContain(code)
  } else {
    const reply = await rpc(f, tool, input)
    expect(reply.result?.isError, JSON.stringify(reply)).toBe(true)
    const value = graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])
    expect(value).toMatchObject({ error: { code: errorCode } })
    expect(JSON.stringify(value)).toContain(code)
  }
}

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, RunExecutionsListInputSchema } from '@foreman-code/contracts/wave25'
import { inspectionExecutionsQuery } from '../src/modules/runs/inspectionPageQuery.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('inspection database page bounds', () => {
  it('returns only one page plus its lookahead across limits, node filters and cursor positions', async () => {
    const database = await agent3Database()
    try {
      const fixture = await seedAgent3(database.pool, database.directory,
        makeCurrentWorkflowFixture(randomUUID(), 'sequential'))
      const nodes = fixture.version.definition.nodes
      const history = Array.from({ length: 360 }, (_, index) => {
        const node = nodes[index % nodes.length]!
        expect(node.kind ?? 'agent').toBe('agent')
        return { id: `execution-${String(index).padStart(4, '0')}`, nodeId: node.id, agentId: node.agentId,
          configurationId: fixture.version.agentConfigurationVersionIds[node.agentId],
          attempt: index + 1, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(index / 3))).toISOString() }
      })
      await database.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record,created_at)
        select x.id,$1,x."nodeId",x."agentId",x.attempt,jsonb_build_object('id',x.id,'runId',$1::text,
          'workflowNodeId',x."nodeId",'agentId',x."agentId",'agentConfigurationVersionId',x."configurationId",
          'attempt',x.attempt,'state','queued','input','{}'::jsonb,'createdAt',x."createdAt"),x."createdAt"
        from jsonb_to_recordset($2::jsonb) x(id text,"nodeId" text,"agentId" text,"configurationId" text,attempt integer,"createdAt" timestamptz)`,
      [fixture.run.id, JSON.stringify(history)])
      const ordered = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      for (const limit of [1, 25, 100]) {
        for (const nodeId of [undefined, nodes[0]!.id]) {
          for (const position of [undefined, ordered[90]!]) {
            const input = RunExecutionsListInputSchema.parse({ workspaceId: fixture.scope.workspaceId,
              runId: fixture.run.id, limit, workflowNodeId: nodeId })
            const after = position && { createdAt: position.createdAt, executionId: position.id }
            const query = inspectionExecutionsQuery(input, after)
            const result = await database.pool.query(query.text, query.values)
            const expected = ordered.filter(row => (!nodeId || row.nodeId === nodeId)
              && (!position || row.createdAt < position.createdAt
                || row.createdAt === position.createdAt && row.id < position.id)).slice(0, limit + 1)
            expect(result.rows.map(row => row.id)).toEqual(expected.map(row => row.id))
            expect(result.rowCount).toBe(limit + 1)
          }
        }
      }
    } finally { await database.close() }
  })
})

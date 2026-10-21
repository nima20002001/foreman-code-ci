import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  it('saves and reads a choice feeding an all-join through authenticated Operator MCP', async () => {
    const db = await currentDatabase()
    const t = await writerFixture(db, 'parallel')
    try {
      const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: { ...t.input.graph,
        handoffs: { contractVersion: 1 },
        nodes: t.input.graph.nodes.map((node, index) => index === 0 ? { ...node, choice: {
          outcomes: t.input.graph.edges.filter((edge) => edge.source === node.id).map((edge, choice) => ({
            outcome: `branch_${choice}`, target: { kind: 'edge', relationshipId: edge.id },
          })),
        } } : node),
      } })
      const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
        scope: { workspaceIds: [input.workspaceId] } }])
      const denied = await t.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
      expect(denied.result?.isError).toBe(true)
      expect((await db.pool.query('select id from workflow_versions where workflow_id=$1',
        [input.workflowId])).rowCount).toBe(0)
      const saved = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(saved.result?.isError).not.toBe(true)
      const value = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(saved.result)).value
      const persisted = await t.call(CURRENT_WORKFLOW_TOOLS.saved, {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      }, reader.token)
      expect(persisted.result?.isError).not.toBe(true)
      const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(persisted.result))
      expect(read.version).toEqual(value.version)
      const choiceNode = read.version.definition.nodes[0]
      assert.ok(choiceNode && choiceNode.kind !== 'job')
      expect(choiceNode.choice?.outcomes).toHaveLength(2)
      const replay = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(CurrentWorkflowSaveResultSchema.parse(graphRpcValue(replay.result)).replayed).toBe(true)
      const blocked = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() }, reader.token)
      expect(blocked.result?.isError).toBe(true)
      expect((await db.pool.query('select id from workflow_versions where workflow_id=$1',
        [input.workflowId])).rowCount).toBe(1)
    } finally { await t.app.close(); await db.close() }
  }, 120000)
})

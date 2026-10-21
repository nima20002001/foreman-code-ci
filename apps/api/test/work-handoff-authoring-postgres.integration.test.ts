import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nim2691TaskDatabase as taskDatabase } from './helpers/nim2691Database.js'

const postgresDescribe = describe.skipIf(process.env.NIM2691_POSTGRES !== '1')
postgresDescribe('combined handoff artifact authoring through Operator MCP', () => {
  it('saves, reads persisted declarations, and denies a reader the same write', async () => {
    await taskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined } as Awaited<ReturnType<typeof currentDatabase>>
      const t = await writerFixture(db)
      try {
        const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: {
          ...t.input.graph, handoffs: { contractVersion: 1 },
          nodes: t.input.graph.nodes.map((node, index) => index ? node : { ...node,
            artifactOutputs: { version: 1, outputKeys: ['report'] },
          }),
        } })
        const response = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
        expect(response.result?.isError).not.toBe(true)
        const saved = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(response.result))
        const read = await t.call(CURRENT_WORKFLOW_TOOLS.saved,
          { workspaceId: input.workspaceId, workflowId: input.workflowId })
        expect(read.result?.isError).not.toBe(true)
        const persisted = CurrentWorkflowReadResultSchema.parse(graphRpcValue(read.result))
        expect(persisted.version).toEqual(saved.value.version)
        const node = persisted.version.definition.nodes[0]
        expect(node?.kind !== 'job' && node?.artifactOutputs).toEqual({ version: 1, outputKeys: ['report'] })
        expect(persisted.version.definition.handoffs).toEqual({ contractVersion: 1 })
        const http = await t.app.inject({ method: 'GET', url: t.url, headers: graphHeaders(t.writer.token) })
        expect(http.statusCode, http.body).toBe(200)
        const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
          scope: { workspaceIds: [input.workspaceId] } }])
        const denied = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() }, reader.token)
        expect(denied.result?.isError).toBe(true)
        expect((await pool.query('select count(*)::integer as count from workflow_versions where workflow_id=$1',
          [input.workflowId])).rows[0]?.count).toBe(1)
      } finally { await t.app.close() }
    })
  }, 120000)
})

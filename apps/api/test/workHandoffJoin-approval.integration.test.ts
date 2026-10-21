import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { workHandoffJoinDatabase } from './helpers/workHandoffJoinDatabase.js'
import { Command, MemorySaver, interrupt } from '@langchain/langgraph'
import { buildWorkHandoffGraph } from '../src/modules/runs/workHandoffGraph.js'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  const database = workHandoffJoinDatabase()

  it('dispatches one join approval task and preserves its dispatch on checkpoint replay', async () => {
    const db = database()
    const t = await workHandoffFixture(db.pool, 'concurrent-join-approval', (version) => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 } } }))
    try {
      const entryId = await t.store.ensureWorkEntry()
      const entry = await t.accept(entryId, finished(1))
      const branches = []
      for (const edge of t.version.definition.edges.filter((item) => item.source === t.version.entryNodeId)) {
        const request = await t.store.admitWorkRequest(entry.id, edge.id)
        assert.equal(request.kind, 'accepted')
        branches.push(await t.accept(request.request.destinationActivationId, finished(1)))
      }
      const results = new Map([entry, ...branches].map((execution) =>
        [WorkActivationInputSchema.parse(execution.input).work.activation.activationId, execution]))
      const checkpointer = new MemorySaver()
      const compose = () => buildWorkHandoffGraph({ runId: t.run.id, version: t.version, checkpointer,
        signal: new AbortController().signal, port: {
          ensureEntryActivation: () => t.store.ensureWorkEntry(),
          executeActivation: async (id) => {
            const execution = results.get(id)
            if (execution) return t.route(execution)(id)
            interrupt({ approval: 'join' })
            await t.accept(id, finished(2))
            return []
          },
        } })
      let work = compose()
      await work.graph.invoke(work.initial, work.config)
      const waiting = await work.graph.getState(work.config)
      expect(waiting.tasks.flatMap((task) => task.interrupts ?? [])).toHaveLength(1)
      expect(waiting.tasks.filter((task) => task.interrupts?.length)).toHaveLength(1)
      const claims = (await db.pool.query<{ activation_id: string; source_activation_id: string }>(
        'select activation_id,source_activation_id from run_work_join_dispatches where run_id=$1', [t.run.id])).rows
      expect(claims).toHaveLength(1)
      await t.restart()
      const routed = await Promise.all(branches.map((execution) => {
        const id = [...results].find(([, item]) => item.id === execution.id)![0]
        return t.route(execution)(id)
      }))
      expect(routed.flat()).toEqual([claims[0]!.activation_id])
      work = compose()
      await work.graph.invoke(new Command({ resume: true }), work.config)
      expect((await work.graph.getState(work.config)).tasks).toHaveLength(0)
      expect((await db.pool.query('select id from harness_executions where run_id=$1 and workflow_node_id=$2',
        [t.run.id, t.version.definition.nodes[3]!.id])).rowCount).toBe(1)
    } finally { await t.close() }
  }, 120000)

})

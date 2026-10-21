import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { afterAll, beforeAll, expect } from 'vitest'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, RepeatGraphSnapshotV3Schema } from '@foreman-code/contracts/wave25'
import { migratedDatabase } from './migratedDatabase.js'
import { workflowJobFixture } from './workflowJobFixture.js'
import { executeRepeatRuntime } from '../../src/modules/runs/repeatRuntime.js'
import type { WorkflowJobDriver } from '../../src/modules/jobs/workflowRuntimePorts.js'
import { graphRpcValue } from '../eng04-graph-composition-fixture.js'

type Fixture = Awaited<ReturnType<typeof workflowJobFixture>>
export const timeout = 120000
export const success = { outcome: 'succeeded' as const, output: { latestDeliverable: {}, remainingFindings: [] } }
export function useWorkflowJobBudgetFixture() {
  let db: Awaited<ReturnType<typeof migratedDatabase>> | undefined
  beforeAll(async () => {
    db = await migratedDatabase()
  }, timeout)
  afterAll(async () => {
    await db?.close()
  }, timeout)

  return async function withJob(
    configure: Parameters<typeof workflowJobFixture>[1],
    work: (f: Fixture) => Promise<void>,
    form: 'sequential' | 'repeat' = 'sequential',
  ) {
    assert.ok(db, 'Expected the workflow Job database')
    const f = await workflowJobFixture(db, configure, form)
    try {
      await work(f)
    } finally {
      await f.close()
    }
  }
}
export async function snapshot(f: Fixture) {
  const response = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, { protocolVersion: 1, scope: f.scope })
  expect(response.status).toBe(200)
  expect(response.result?.isError, JSON.stringify(graphRpcValue(response.result))).not.toBe(true)
  return RepeatGraphSnapshotV3Schema.parse(graphRpcValue(response.result))
}
export const sink: Parameters<typeof workflowJobFixture>[1] = (graph, job) => {
  assert.ok(graph.entryNodeId, 'Expected an Agent entry node')
  return { ...graph,
    nodes: [graph.nodes[0]!, job], requiredAgentCount: 1,
    edges: [{ id: 'build-edge', kind: 'execution', source: graph.entryNodeId, target: job.id }],
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
  }
}
export function runtime(f: Fixture, jobDriver: WorkflowJobDriver) {
  return executeRepeatRuntime({ runId: f.run.id, version: f.version, owner: f.owner,
    signal: new AbortController().signal, checkpointer: new MemorySaver(), store: f.store,
    driver: { candidate: (ref, attempt) => f.candidate(ref.nodeId, attempt),
      observe: async execution => {
        await f.finish(execution.id, execution.attempt === 1 ? { outcome: 'failed',
          error: { code: 'PROVIDER_FAILED', message: 'Retry the original attempt.', retryable: true } } : success)
      } }, jobs: { store: f.jobStore(), driver: jobDriver }, lifecycle: f.lifecycle })
}

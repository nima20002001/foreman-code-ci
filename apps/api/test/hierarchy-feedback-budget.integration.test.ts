import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

function batchFixture() {
  const fixture = hierarchyRuntimeFixture({ maximum: 21 })
  const workers = Array.from({ length: 16 }, (_, index) => `worker_${index}`)
  const names = ['master', 'build', ...workers]
  const templates = [fixture.configurations[0]!, fixture.configurations[1]!]
  const worker = fixture.configurations[4]!
  fixture.configurations = names.map((name, index) => AgentConfigurationVersionSchema.parse({
    ...(templates[index] ?? worker), id: `configuration-${name}`, agentId: `agent-${name}`,
  }))
  const edges = [{ id: 'master-build', kind: 'execution' as const, source: 'master', target: 'build' },
    ...workers.map(name => ({ id: `build-${name}`, kind: 'execution' as const, source: 'build', target: name }))]
  fixture.version.agentConfigurationVersionIds = Object.fromEntries(fixture.configurations.map(value => [value.agentId, value.id]))
  fixture.version.definition = { ...fixture.version.definition,
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 21 }, edges,
    nodes: names.map((name, index) => ({ id: name, agentId: fixture.configurations[index]!.agentId, name,
      ...(index < 2 ? { choice: { outcomes: edges.filter(edge => edge.source === name).map(edge => ({
        outcome: edge.target, target: { kind: 'edge' as const, relationshipId: edge.id },
      })) } } : {}) })),
    hierarchy: { version: 1, masterNodeId: 'master', parents: edges.map(edge => ({
      workflowNodeId: edge.target, parentNodeId: edge.source,
    })) },
  }
  return { fixture, workers }
}

function batchOutput(workers: string[], node: string, request: HarnessExecutionRequest) {
  const input = WorkActivationInputSchema.parse(request.input)
  const selected = node === 'master' ? ['build'] : workers
  if ((node === 'master' || node === 'build') && input.work.kind !== 'hierarchy_group') {
    return { routing: { kind: 'delegate', requests: selected.map(outcome => ({ outcome, data: { task: outcome } })) },
      data: { latestDeliverable: 'Plan', remainingFindings: [] }, summary: 'Delegate work', board: { kind: 'none', reason: 'no_changes' } }
  }
  return coordinationOutput(node, request, { select: [] })
}

describe.skipIf(!postgresEnabled)('hierarchy expanded feedback reservation', () => {
  it('preserves the earlier native JSON-size refusal without admitting children', async () => {
    const { fixture, workers } = batchFixture()
    fixture.run.input = { task: 'x'.repeat(3.5 * 1024 * 1024) }
    const provider = new ControlledWorkflowProvider(workers, (node, request) => batchOutput(workers, node, request))
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], collaborationPorts: {},
      managerFactory: context => provider.connection(context) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      expect(await drive).toMatchObject({ message: 'GRAPH_JSON_LIMIT' })
      expect((await f.runs.listRepeatExecutions(f.f.run.id)).some(row => workers.includes(row.execution.workflowNodeId))).toBe(false)
      expect((await f.db.pool.query('select destination_node_id from run_work_requests where run_id=$1',
        [f.f.run.id])).rows).toEqual([])
      expect(provider.maximumActive).toBe(0)
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)

  it('delivers sixteen large valid child returns to an admitted parent and completes the hierarchy', async () => {
    const { fixture, workers } = batchFixture()
    const deliverable = 'x'.repeat(60 * 1024)
    const feedback: ReturnType<typeof WorkActivationInputSchema.parse>[] = []
    const startedAt = performance.now()
    const progress: { node: string; elapsedMs: number }[] = []
    const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [], collaborationPorts: {},
      outputFor: (node, request) => {
        progress.push({ node, elapsedMs: Math.round(performance.now() - startedAt) })
        const result = batchOutput(workers, node, request)
        const input = WorkActivationInputSchema.parse(request.input)
        if (node === 'build' && input.work.kind === 'hierarchy_group') feedback.push(input)
        return workers.includes(node) ? { ...result, data: { latestDeliverable: deliverable, remainingFindings: [] } } : result
      } })
    let failure: unknown
    const drive = f.engine.start(f.f.run.id).catch(error => { failure = error; return error })
    try {
      await expect.poll(async () => {
        if (failure) throw failure
        const run = await f.runs.get(f.f.run.id)
        if (run?.outcome !== 'succeeded') {
          throw new Error(JSON.stringify({ state: run?.executionState, outcome: run?.outcome, result: run?.result,
            starts: f.provider.counts.starts, progress }))
        }
        return run.outcome
      }, { timeout: 45_000 }).toBe('succeeded')
      expect(await drive).not.toBeInstanceOf(Error)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(feedback).toHaveLength(1)
      const work = feedback[0]!.work
      if (work.kind !== 'hierarchy_group') throw new Error('Expected the parent continuation')
      expect(work.returns).toHaveLength(16)
      expect(work.returns.every(value => value.latestDeliverable === deliverable && value.remainingFindings?.length === 0)).toBe(true)
      expect(f.provider.counts.starts).toBe(20)
    } finally { await f.stop(); await drive; await f.close() }
  }, 60_000)
})

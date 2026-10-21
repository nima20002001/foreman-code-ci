import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphHarness } from './helpers/eng04A1GraphHarness.js'
import { regressionAuthoringFixture } from './helpers/executionRegressions.js'
import { deferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('current execution parallel regressions', () => {
  const authoring = regressionAuthoringFixture()

  it('requires an explicit sufficient execution budget for all four parallel steps', async () => {
    const f = await authoring('parallel')
    await expect(f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
      graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 3 } } })).rejects.toThrow()
    const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input, commandId: randomUUID(),
      graph: { ...f.input.graph, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 4 } } })
    expect(saved.value.version.definition.executionPolicy?.maxNodeExecutions).toBe(4)
  })

  for (const maximum of [1, 2]) it(`persists maxParallelism=${maximum} and the real graph honors it`, async () => {
    const f = await authoring('parallel')
    const saved = await f.workflows.current.save(f.writer.principal, 'mcp', { ...f.input,
      graph: { ...f.input.graph, executionPolicy: { maxParallelism: maximum, maxNodeExecutions: 4 } } })
    f.f.version = agentWorkflowVersion(saved.value.version)
    f.f.scope.workflowVersionId = saved.value.currentVersionId
    f.f.run.workflowVersionId = saved.value.currentVersionId
    ExecutableWorkflowV3Schema.parse({ version: f.f.version, configurations: f.f.configurations })
    let active = 0, peak = 0
    const overlap = deferred()
    const parallelNodes = f.f.version.definition.nodes.slice(1, 3).map(node => node.id)
    let enteredParallel = 0
    const graph = graphHarness(f.f, { beforeObserve: async execution => {
      active++; peak = Math.max(peak, active)
      if (maximum === 2 && parallelNodes.includes(execution.workflowNodeId)) {
        if (++enteredParallel === 2) overlap.resolve()
        await overlap.promise
      } else {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      active--
    } })
    await graph.run()
    expect(peak).toBe(maximum)
    expect(graph.executions.size).toBe(4)
  })

  it('persists all-required fan-in and executes the final node once after both predecessors', async () => {
    const f = await authoring('parallel')
    const seen: string[] = [], final = f.f.version.definition.nodes.at(-1)!.id
    const graph = graphHarness(f.f, { beforeObserve: async (execution) => {
      if (execution.workflowNodeId === final) expect(seen).toEqual(expect.arrayContaining(f.f.version.definition.nodes.slice(1, 3).map((node) => node.id)))
      seen.push(execution.workflowNodeId)
    } })
    await graph.run()
    expect(seen.filter((id) => id === final)).toHaveLength(1)
    expect(f.f.version.definition.nodes.at(-1)?.join).toEqual({ mode: 'all' })
  })
})

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { WorkflowVersionV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { it } from 'vitest'

import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { compileExecutionTopology } from '../src/modules/runs/topology.js'

for (const maximum of [1, 2]) {
  it(`never exceeds maxParallelism=${maximum} during delayed fan-out work`, async () => {
    const limiter = new ExecutionLimiter(maximum)
    const signal = new AbortController().signal
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 8 }, () => limiter.run(signal, async () => {
      active += 1
      peak = Math.max(peak, active)
      await delay(15)
      active -= 1
    })))
    assert.equal(active, 0)
    assert.equal(peak, maximum)
  })
}

it('does not launch a canceled waiter and returns slots after failures', async () => {
  const limiter = new ExecutionLimiter(1)
  const controller = new AbortController()
  const first = limiter.run(new AbortController().signal, async () => { await delay(20); throw new Error('first failed') })
  const firstRejected = assert.rejects(first, /first failed/)
  let called = false
  const waiting = limiter.run(controller.signal, async () => { called = true })
  const waitingRejected = assert.rejects(waiting)
  controller.abort()
  await Promise.all([firstRejected, waitingRejected])
  assert.equal(called, false)
  assert.equal(await limiter.run(new AbortController().signal, async () => 'released'), 'released')
})

// Admission, not the DAG compiler, validates unsupported join declarations.
// Begin with a valid V3 graph so a rejection cannot be caused by retired tags,
// missing immutable pins or duplicated fixture Agents.
function graph(predecessorCount: number) {
  const { version } = makeCurrentWorkflowFixture('scheduling', 'parallel')
  const count = predecessorCount + 1
  version.definition.nodes = version.definition.nodes.slice(0, count).map((node) => {
    const { join: _join, ...rest } = node
    void _join
    return rest
  })
  const [a, b, c] = version.definition.nodes
  version.definition.edges = predecessorCount === 0 ? [] : predecessorCount === 1
    ? [{ id: 'a-b', kind: 'execution', source: a!.id, target: b!.id }]
    : [{ id: 'a-b', kind: 'execution', source: a!.id, target: b!.id },
      { id: 'a-c', kind: 'execution', source: a!.id, target: c!.id },
      { id: 'b-c', kind: 'execution', source: b!.id, target: c!.id }]
  version.agentConfigurationVersionIds = Object.fromEntries(version.definition.nodes.map((node) =>
    [node.agentId, version.agentConfigurationVersionIds[node.agentId]!]))
  return WorkflowVersionV3Schema.parse(version)
}

for (const join of [{ mode: 'threshold', required: 2 }, { mode: 'any' }]) {
  for (const predecessors of [0, 1, 2]) {
    it(`rejects ${join.mode} joins with ${predecessors} predecessors`, () => {
      const version = graph(predecessors)
      const targetId = version.definition.nodes.at(-1)!.id
      const result = WorkflowVersionV3Schema.safeParse({ ...version, definition: { ...version.definition,
        nodes: version.definition.nodes.map((node) => node.id === targetId ? { ...node, join } : node),
      } })
      assert.equal(result.success, false)
      if (!result.success) {
        const nodeIssue = result.error.issues.find((issue) => issue.code === 'invalid_union'
          && JSON.stringify(issue.path) === JSON.stringify(['definition', 'nodes', version.definition.nodes.length - 1]))
        assert.ok(nodeIssue?.code === 'invalid_union')
        assert.ok(nodeIssue.errors[0]?.some((issue) => issue.code === 'invalid_value'
          && issue.path.slice(-2).join('.') === 'join.mode' && issue.values.length === 1 && issue.values[0] === 'all'))
      }
    })
  }
}

it('validates an all-join with unequal predecessor path lengths', () => {
  const version = graph(2)
  const [a, b, c] = version.definition.nodes
  c!.join = { mode: 'all' }
  const topology = compileExecutionTopology(WorkflowVersionV3Schema.parse(version))
  assert.deepEqual(topology.incoming.get(c!.id)?.map((edge) => edge.source), [a!.id, b!.id])
  assert.deepEqual(topology.sinks, [c!.id])
})

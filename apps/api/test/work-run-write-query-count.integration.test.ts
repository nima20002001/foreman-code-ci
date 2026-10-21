import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'
import { useSettlementFixtures, timeout, finish, handoffs, acceptedActivation } from './helpers/workflowSettlementTestSupport.js'

// The fixture supplies native closure; repository, publication and result guards execute against PostgreSQL.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

async function measure<T>(work: () => Promise<T>) {
  let statements = 0
  const record = (message: unknown) => {
    if ((message as RuntimeTimingRecord).phase === 'sql.query') statements++
  }
  runtimeTimingChannel.subscribe(record)
  try { return { value: await work(), statements } }
  finally { runtimeTimingChannel.unsubscribe(record) }
}

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('work Run write statements', () => {
  const withFixture = useSettlementFixtures()

  it('admits one activation within a bounded statement budget and reuses its frozen execution', async () => {
    await withFixture(handoffs(10), async f => {
      const activationId = await f.store.ensureWorkEntry()
      const queued = await measure(() => f.store.admitWorkActivation(activationId, nodeId => f.candidate(nodeId)))
      expect(queued.value.reused).toBe(false)
      const replay = await f.store.admitWorkActivation(activationId, () => { throw new Error('Replay allocated an execution') })
      expect(replay).toEqual({ execution: queued.value.execution, reused: true })
      expect((await f.store.readExecution(queued.value.execution.id)).execution).toEqual(queued.value.execution)
      console.info('work activation statements', queued.statements)
      expect(queued.statements).toBeLessThanOrEqual(60)
    }, 'single')
  }, timeout)

  it('completes all accepted activations without per-execution reads and preserves output ordering on replay', async () => {
    const counts: number[] = []
    for (const size of [1, 3]) {
      await withFixture(graph => ({ ...handoffs(10)(graph), nodes: graph.nodes.slice(0, size),
        edges: graph.nodes.slice(1, size).map((node, index) => ({ id: `step-${index}`,
          kind: 'execution', source: graph.nodes[index]!.id, target: node.id })) }), async f => {
        let activationId = await f.store.ensureWorkEntry()
        const executions = []
        for (let index = 0; index < size; index++) {
          const execution = await acceptedActivation(f, activationId, finish(index + 1))
          executions.push(execution)
          const edge = f.version.definition.edges.find(item => item.source === execution.workflowNodeId)
          if (edge) {
            const request = await f.store.admitWorkRequest(execution.id, edge.id)
            assert.equal(request.kind, 'accepted')
            activationId = request.request.destinationActivationId
          }
        }
        const completed = await measure(() => f.store.completeWorkRun())
        expect(completed.value).toBe('completed')
        const saved = await f.readRun()
        expect(saved).toMatchObject({ executionState: 'completed', outcome: 'succeeded',
          result: { outcome: 'succeeded', output: finish(size).output } })
        await f.restart()
        expect(await f.store.completeWorkRun()).toBe('completed')
        expect(await f.readRun()).toEqual(saved)
        for (const execution of executions) expect((await f.store.readExecution(execution.id)).accepted).toBe(true)
        counts.push(completed.statements)
      }, size === 1 ? 'single' : 'parallel')
    }
    console.info('work completion statements', counts)
    expect(counts[1]).toBeLessThanOrEqual(counts[0]! + 4)
  }, timeout)
})

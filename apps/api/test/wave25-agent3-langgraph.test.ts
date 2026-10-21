import { Command, MemorySaver, interrupt } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import { buildRepeatGraph, compileWorkflowGraph } from '../src/modules/runs/repeatGraph.js'
import { selectedTerminalResolutions } from '../src/modules/runs/topology.js'
import { syntheticCurrentWorkflow } from './helpers/currentSynthetic.js'
import { deferred } from './helpers/deferred.js'

const signal = () => new AbortController().signal
function build(f: ReturnType<typeof syntheticCurrentWorkflow>, driver = f.driver(), checkpointer = new MemorySaver()) {
  return buildRepeatGraph({ runId: f.runId, version: f.version, store: f.store, driver, signal: signal(), checkpointer, configuredParallelism: 4 })
}
const initial = (runId: string) => ({ runId, executionIds: {}, occurrences: {}, boundaries: {} })
const choice = { outcomes: [
  { outcome: 'pass', target: { kind: 'branch_end' as const } },
  { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-fixer' } },
] }

describe('Agent 3 real LangGraph current V3 wrappers with synthetic native work', () => {
  it.each([['pass', 0], ['issues', 1]] as const)('%s activates Fixer exactly %s times', async (outcome, count) => {
    const f = syntheticCurrentWorkflow(['review', 'fixer'], [['review', 'fixer']], { review: choice })
    const { graph, config } = build(f, f.driver((id) => id === 'review' ? { routing: { outcome }, data: { private: true } } : { fixed: true }))
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls.filter((id) => id === 'fixer')).toHaveLength(count)
    expect(f.constructed.filter((id) => id === 'fixer')).toHaveLength(count)
    expect(f.receipts).toHaveLength(count)
    expect(selectedTerminalResolutions([...f.resolutions.values()]).map((item) => item.workflowNodeId)).toEqual(count ? ['fixer'] : ['review'])
  })
  it.each(['```json\n{"routing":{"outcome":"issues"},"data":{}}\n```', '{"routing":',
    { data: {} }, { routing: { outcome: 'unknown' }, data: {} }, { routing: { outcome: 'issues', target: 'fixer' }, data: {} }])(
    'rejects malformed/undeclared complete evidence without a fallback activation: %j', async (output) => {
      const f = syntheticCurrentWorkflow(['review', 'fixer'], [['review', 'fixer']], { review: choice })
      const { graph, config } = build(f, f.driver(() => output))
      await expect(graph.invoke(initial(f.runId), config)).rejects.toThrow()
      expect(f.nativeCalls).toEqual(['review']); expect(f.constructed).toEqual(['review'])
      expect(f.resolutions.get('review')?.resolution).toBe('failed'); expect(f.receipts).toHaveLength(0)
    })
  it('waits for unequal diamond paths and binds both exact accepted inputs once', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'short', 'long1', 'long2', 'join'],
      [['entry', 'short'], ['entry', 'long1'], ['long1', 'long2'], ['short', 'join'], ['long2', 'join']])
    const { graph, config } = build(f)
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls.filter((id) => id === 'join')).toHaveLength(1)
    expect(f.completionOrder.indexOf('join')).toBeGreaterThan(f.completionOrder.indexOf('long2'))
    expect(f.receipts.filter((item) => item.recipient.workflowNodeId === 'join').map((item) => 'relationshipId' in item.source ? item.source.relationshipId : null)).toEqual(['long2-join', 'short-join'])
  })
  it('settles unselected branches before joining only selected predecessors', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'short', 'unused1', 'unused2', 'join'],
      [['entry', 'short'], ['entry', 'unused1'], ['unused1', 'unused2'], ['short', 'join'], ['unused2', 'join']],
      { entry: { outcomes: [
        { outcome: 'short', target: { kind: 'edge', relationshipId: 'entry-short' } },
        { outcome: 'unused', target: { kind: 'edge', relationshipId: 'entry-unused1' } },
      ] } })
    const { graph, config } = build(f, f.driver((id) => id === 'entry' ? { routing: { outcome: 'short' }, data: {} } : {}))
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls).toEqual(['entry', 'short', 'join'])
    expect(f.resolutions.get('unused2')?.resolution).toBe('skipped')
    expect(f.receipts.filter((item) => item.recipient.workflowNodeId === 'join').map((item) => 'relationshipId' in item.source ? item.source.relationshipId : null)).toEqual(['short-join'])
  })
  it('does not complete a branch end while another selected path is still running', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'end', 'slow', 'unused'], [['entry', 'end'], ['entry', 'slow'], ['end', 'unused']],
      { end: { outcomes: [{ outcome: 'stop', target: { kind: 'branch_end' } }, { outcome: 'go', target: { kind: 'edge', relationshipId: 'end-unused' } }] } })
    const held = deferred(), entered = deferred()
    const { graph, config } = build(f, f.driver((id) => id === 'end' ? { routing: { outcome: 'stop' }, data: {} } : {}, async (id) => {
      if (id === 'slow') { entered.resolve(); await held.promise }
    }))
    let done = false
    const task = graph.invoke(initial(f.runId), config).then(() => { done = true })
    await entered.promise; await Promise.resolve(); expect(done).toBe(false)
    held.resolve(); await task
    expect(f.nativeCalls).not.toContain('unused')
    expect(selectedTerminalResolutions([...f.resolutions.values()]).map((item) => item.workflowNodeId)).toEqual(['end', 'slow'])
  })
  it('compiles neither dormant board components nor approval-only dependencies', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'worker', 'board'], [['entry', 'worker']])
    f.version.definition.edges.push({ id: 'review-line', kind: 'approval', source: 'board', target: 'entry' })
    const { graph, config } = build(f)
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls).toEqual(['entry', 'worker'])
    expect(f.executions.has('exec-board')).toBe(false)
  })
  it('re-enters after result-before-acceptance crash without repeating native work', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'last'], [['entry', 'last']]), saver = new MemorySaver()
    const { graph, config } = build(f, f.driver(), saver)
    f.failNextAcceptance()
    await expect(graph.invoke(initial(f.runId), config)).rejects.toThrow('synthetic acceptance/checkpoint boundary crash')
    const recovered = build(f, f.driver(), saver)
    await recovered.graph.invoke(null, config)
    expect(f.nativeCalls).toEqual(['entry', 'last']); expect(f.constructed).toEqual(['entry', 'last'])
  })
  it('reconstructs a lost checkpoint from accepted records without launching accepted predecessors', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'last'], [['entry', 'last']])
    const first = build(f)
    await first.graph.invoke(initial(f.runId), first.config)
    const recovered = build(f) // test-only lost checkpoint; durable records remain
    await recovered.graph.invoke(initial(f.runId), recovered.config)
    expect(f.nativeCalls).toEqual(['entry', 'last']); expect(f.receipts).toHaveLength(1)
  })
  it('keeps a persisted approval interrupt and resumes the exact thread without replaying its predecessor', async () => {
    const f = syntheticCurrentWorkflow(['entry', 'waiting'], [['entry', 'waiting']]), saver = new MemorySaver()
    const invoked = vi.fn(), checks: string[] = []
    const action = async ({ nodeId: id }: { nodeId: string }) => {
      invoked(id)
      if (id === 'waiting') {
        const value: unknown = interrupt({ interactionId: 'exact-interaction', interactionIds: ['exact-interaction'] })
        expect(value).toEqual({ interactionId: 'exact-interaction' }); checks.push('delivered identity checked')
      }
      return { executionIds: { [id]: { executionId: `exec-${id}`, occurrenceId: null } } }
    }
    const graph = compileWorkflowGraph(f.version, saver, action), config = { configurable: { thread_id: f.runId }, recursionLimit: 4 }
    await graph.invoke(initial(f.runId), config)
    const before = await graph.getState(config)
    const id = before.tasks[0]!.interrupts![0]!.id
    await compileWorkflowGraph(f.version, saver, action).invoke(new Command({ resume: { [id]: { interactionId: 'exact-interaction' } } }), config)
    expect(invoked.mock.calls.filter(([node]) => node === 'entry')).toHaveLength(1)
    expect(checks).toEqual(['delivered identity checked'])
  })
  it.each([300, 500])('runs a %s-node synthetic chain with an explicit superstep budget', async (count) => {
    const names = Array.from({ length: count }, (_, i) => `n${i}`)
    const f = syntheticCurrentWorkflow(names, names.slice(1).map((name, i) => [names[i]!, name]))
    const { graph, config } = build(f)
    expect(config.recursionLimit).toBe(count + 2)
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls).toHaveLength(count); expect(f.peak).toBe(1)
  }, 60000)
  it('bounds native concurrency on a 500-node synthetic wide board', async () => {
    const names = Array.from({ length: 500 }, (_, i) => `n${i}`)
    const f = syntheticCurrentWorkflow(names, names.slice(1).map((name) => ['n0', name]))
    const { graph, config } = build(f)
    // Current compiler budgets ordinary work from the accepted execution policy.
    expect(config.recursionLimit).toBe(names.length + 2)
    await graph.invoke(initial(f.runId), config)
    expect(f.nativeCalls).toHaveLength(500); expect(f.peak).toBeLessThanOrEqual(4)
  }, 60000)
})

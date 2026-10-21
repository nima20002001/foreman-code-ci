import assert from 'node:assert/strict'
import { Command, interrupt } from '@langchain/langgraph'
import { describe, it } from 'vitest'
import { validateRepeatSuccessorV1 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { currentInitialPrompt, parseCurrentChoiceResult } from '../src/modules/runs/currentRouting.js'
import { repeatNodeAction } from '../src/modules/runs/repeatNode.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import {
  assertRepeatRef, bindRepeatNodeInput, compileRepeatLayout, decideRepeatAdmission, repeatSlotId,
} from '../src/modules/runs/repeatResolution.js'
import { a1Scenario, approvalParallelScenario, conditionalScenario, graphHarness, unequalScenario } from './helpers/eng04A1GraphHarness.js'

// Real LangGraph/checkpointer + production pure/node algorithms. Only persistence,
// native observation and lifecycle are deterministic TEST ports; no live gate claim.
describe('ENG04 A1 common graph progression', () => {
  for (const form of ['single', 'sequential', 'parallel', 'conditional', 'approval'] as const) {
    it(`S3-01..04 ${form}: ordinary graph keeps identities without any repeat occurrence/boundary calls`, async () => {
      const f = a1Scenario(form), h = graphHarness(f, { outcome: () => 'go' })
      const events: string[] = []
      const lifecycle: RepeatRuntimeLifecycle = {
        preflight: async () => { events.push('preflight') }, markRunning: async () => { events.push('running') },
        currentState: async () => ({ executionState: 'running', stopRequested: false }),
        persistWait: async (checkpoint) => { assert.equal(checkpoint.tasks.flatMap((task) => task.interrupts ?? []).length, 0); return false },
        cancelNativeAndRequestCleanup: async () => { throw new Error('unexpected cancellation') },
        settleRun: async () => { throw new Error('unexpected failure settlement') },
        requestCleanup: async () => { events.push('cleanup') }, finishNative: async () => { events.push('native-finish') },
        finishCleanup: async () => { events.push('cleanup-finish') },
      }
      await executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })
      assert.equal(h.completeCalls, 1); assert.equal(h.enterCalls, 0)
      assert.equal(h.occurrences.size, 0); assert.equal(h.decisions.size, 0); assert.equal(h.transitions.length, 0)
      assert.equal(h.layout.boundaries.length, 0)
      assert(h.layout.nodes.every((node) => node.kind === 'once'))
      assert.equal(h.executions.size, f.version.definition.nodes.length)
      assert.equal(new Set(h.candidateIds).size, h.candidateIds.length)
      assert.deepEqual(events.slice(0, 2), ['preflight', 'running'])
      for (const [id, bound] of h.inputs) {
        assert.equal(bound.input.occurrence, null); assert.equal(bound.input.entry, null)
        assert(bound.bindings.every((binding) => binding.kind === 'predecessor' && binding.recipientOccurrence === null))
        assert.equal(bound.input.executionSemanticsVersion, 3)
        assert.equal(h.executions.get(id)!.agentConfigurationVersionId, f.version.agentConfigurationVersionIds[h.executions.get(id)!.agentId])
        for (const source of bound.input.predecessors) {
          assert.equal(source.acceptedResultDigest, h.digest(h.executions.get(source.execution.executionId)!.result, 64 * 1024))
          assert.equal(source.occurrence, null)
        }
      }
    })
  }
  it('S3-02: unequal all-required join waits for the long branch and binds both exact accepted results once', async () => {
    const f = unequalScenario(), join = f.version.definition.nodes[3]!.id, long = f.version.definition.nodes[4]!.id
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>((done) => { release = done }), atLong = new Promise<void>((done) => { reached = done })
    const h = graphHarness(f, { beforeObserve: async (execution) => {
      if (execution.workflowNodeId === long) { reached(); await gate }
    } })
    const pending = h.run()
    await atLong
    assert.equal([...h.executions.values()].some((execution) => execution.workflowNodeId === join), false)
    release(); await pending
    const joined = [...h.executions.values()].filter((execution) => execution.workflowNodeId === join)
    assert.equal(joined.length, 1)
    const sources = h.inputs.get(joined[0]!.id)!.input.predecessors
    assert.deepEqual(sources.map((source) => source.execution.workflowNodeId).sort(), [f.version.definition.nodes[1]!.id, long].sort())
    assert(sources.every((source) => h.executions.get(source.execution.executionId)?.state === 'completed'))
    assert.equal(h.occurrences.size, 0)
  })
  it('S3-03: conditional unselected work settles without a launch, then the join binds only the selected predecessor', async () => {
    const f = conditionalScenario(), h = graphHarness(f, { outcome: () => 'left' })
    await h.run()
    const [, selected, skipped, joined] = f.version.definition.nodes
    assert.equal(h.outside.get(skipped!.id)!.value.resolution, 'skipped')
    assert.equal([...h.executions.values()].some((execution) => execution.workflowNodeId === skipped!.id), false)
    const join = [...h.executions.values()].find((execution) => execution.workflowNodeId === joined!.id)!
    assert.deepEqual(h.inputs.get(join.id)!.input.predecessors.map((source) => source.execution.workflowNodeId), [selected!.id])
    assert.equal(h.occurrences.size, 0)
  })
  it('S3-03: branch-end is selected completion even when it is not a static sink', async () => {
    const f = a1Scenario('conditional', 'a1-branch-end'), h = graphHarness(f, { outcome: () => 'skip' })
    await h.run(); await h.input.store.completeRun()
    assert.equal(h.executions.size, 1)
    assert.equal(h.outside.get(f.version.entryNodeId)!.value.branchEnded, true)
    assert.equal(h.outside.get(f.version.definition.nodes[1]!.id)!.value.resolution, 'skipped')
    assert.equal(h.completeCalls, 1)
  })
  it('S3-04: ordinary approval interrupt allows sibling progress and resumes the same execution without relaunching accepted siblings', async () => {
    const f = approvalParallelScenario(), waitingNode = f.version.definition.nodes[1]!.id, sibling = f.version.definition.nodes[2]!.id
    const h = graphHarness(f, { beforeObserve: async (execution) => {
      if (execution.workflowNodeId === waitingNode) {
        const response: unknown = interrupt({ type: 'synthetic-approval', executionId: execution.id })
        assert.equal(response, 'approved')
      }
    } })
    await h.run()
    const checkpoint = await h.graph.getState(h.config)
    const suspended = checkpoint.tasks.flatMap((task) => task.interrupts ?? [])
    assert.equal(suspended.length, 1)
    assert.equal(h.outside.get(sibling)?.value.resolution, 'succeeded')
    assert.equal(h.outside.has(f.version.definition.nodes[3]!.id), false)
    const waitingId = [...h.executions.values()].find((execution) => execution.workflowNodeId === waitingNode)!.id
    const siblingId = [...h.executions.values()].find((execution) => execution.workflowNodeId === sibling)!.id
    // Direct graph unit test only. Engine APIs never accept this raw Command;
    // A2 must authenticate and commit the exact task-local receipt before resume.
    await h.graph.invoke(new Command({ resume: { [suspended[0]!.id]: 'approved' } }), h.config)
    await h.input.store.completeRun()
    assert.equal([...h.executions.values()].filter((execution) => execution.workflowNodeId === waitingNode).length, 1)
    assert.equal(h.outside.get(waitingNode)!.value.execution!.executionId, waitingId)
    assert.equal(h.observations.filter((id) => id === siblingId).length, 1)
    assert.equal(h.occurrences.size, 0); assert.equal(h.completeCalls, 1)
  })
  for (const mode of ['early', 'limit'] as const) it(`S3-05: bounded ${mode} exit retains exact occurrence ancestry and final data`, async () => {
    const f = a1Scenario('repeat', `a1-${mode}`), h = graphHarness(f, {
      outcome: (ref) => mode === 'early' && ref.occurrence!.occurrenceIndex === 2 ? 'pass' : 'issues',
    })
    await h.run(); await h.input.store.completeRun()
    const expected = mode === 'early' ? 2 : 3, decisions = [...h.decisions.values()]
    assert.equal(h.occurrences.size, expected); assert.equal(decisions.length, expected)
    assert.equal(h.executions.size, expected * 2)
    assert.equal(decisions.at(-1)!.reason, mode === 'early' ? 'early_exit' : 'limit_exit')
    assert.deepEqual(decisions.at(-1)!.resultData.latestDeliverable, { revision: expected })
    assert.deepEqual(decisions.at(-1)!.resultData.remainingFindings, mode === 'early' ? [] : ['remaining'])
    for (const previous of decisions.slice(0, -1)) {
      const next = h.successors.get(previous.occurrence.identity.occurrenceId)!
      assert(next)
      const accepted = h.executions.get(previous.exitExecution.executionId)!.result!
      validateRepeatSuccessorV1(f.version, previous, next, accepted)
      const entry = h.entries.get(next.identity.occurrenceId)!
      assert.equal(entry.carry!.execution.executionId, previous.exitExecution.executionId)
      assert.equal(entry.carry!.acceptedResultDigest, h.digest(accepted, 64 * 1024))
      assert.equal(next.input.previous!.decisionId, previous.decisionId)
    }
    for (const [id, bound] of h.inputs) for (const predecessor of bound.input.predecessors) {
      assert.deepEqual(predecessor.occurrence, h.refs.get(id)!.occurrence)
      assert.notEqual(predecessor.execution.executionId, id)
    }
    assert.equal(h.completeCalls, 1)
  })
  it('S3-05: repeated unequal all-required joins bind only the current occurrence on every loop', async () => {
    const f = unequalScenario(), exit = f.version.definition.nodes[3]!
    exit.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } }] }
    f.version.definition.repeat = { contractVersion: 1, blocks: [{ id: 'unequal-loop', nodeIds: f.version.definition.nodes.map((node) => node.id),
      entryNodeId: f.version.entryNodeId, exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
    f.version.definition.executionPolicy!.maxNodeExecutions = 10
    const h = graphHarness(f, { outcome: (ref) => ref.occurrence!.occurrenceIndex === 1 ? 'issues' : 'pass' })
    await h.run(); await h.input.store.completeRun()
    assert.equal(h.occurrences.size, 2); assert.equal(h.executions.size, 10)
    const joins = [...h.executions.values()].filter((execution) => execution.workflowNodeId === exit.id)
    assert.equal(joins.length, 2)
    for (const joined of joins) {
      const input = h.inputs.get(joined.id)!.input
      assert.equal(input.predecessors.length, 2)
      assert(input.predecessors.every((source) => source.occurrence!.occurrenceId === h.refs.get(joined.id)!.occurrence!.occurrenceId))
    }
  })
  it('S3-05: changing selected branch between occurrences cannot reuse earlier join results', async () => {
    const f = conditionalScenario(), exit = f.version.definition.nodes[3]!
    exit.choice = { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } }] }
    f.version.definition.repeat = { contractVersion: 1, blocks: [{ id: 'conditional-loop', nodeIds: f.version.definition.nodes.map((node) => node.id),
      entryNodeId: f.version.entryNodeId, exitNodeId: exit.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] }
    f.version.definition.executionPolicy!.maxNodeExecutions = 8
    const h = graphHarness(f, { outcome: (ref) => ref.nodeId === f.version.entryNodeId
      ? ref.occurrence!.occurrenceIndex === 1 ? 'left' : 'right'
      : ref.occurrence!.occurrenceIndex === 1 ? 'issues' : 'pass' })
    await h.run(); await h.input.store.completeRun()
    assert.equal(h.occurrences.size, 2); assert.equal(h.executions.size, 6)
    const joins = [...h.executions.values()].filter((execution) => execution.workflowNodeId === exit.id)
    assert.deepEqual(joins.map((joined) => h.inputs.get(joined.id)!.input.predecessors.map((source) => source.execution.workflowNodeId)),
      [[f.version.definition.nodes[1]!.id], [f.version.definition.nodes[2]!.id]])
    for (const joined of joins) assert(h.inputs.get(joined.id)!.input.predecessors.every((source) =>
      source.occurrence!.occurrenceId === h.refs.get(joined.id)!.occurrence!.occurrenceId))
  })
  it('technical retry stays in the same business occurrence/input slot; replay allocates nothing', async () => {
    const f = a1Scenario('repeat', 'a1-technical-retry'), h = graphHarness(f, { retryEntryOnce: true })
    await h.run()
    assert.equal(h.retryCount, 1); assert.equal(h.occurrences.size, 1)
    const entryExecutions = [...h.executions.values()].filter((execution) => execution.workflowNodeId === f.version.entryNodeId)
    assert.deepEqual(entryExecutions.map((execution) => execution.attempt), [1, 2])
    const [one, two] = entryExecutions
    assert.notEqual(one!.id, two!.id)
    assert.deepEqual(h.refs.get(one!.id), h.refs.get(two!.id))
    assert.equal(h.inputs.get(one!.id)!.digest, h.inputs.get(two!.id)!.digest)
    assert.equal(repeatSlotId(f.run.id, h.refs.get(one!.id)!), repeatSlotId(f.run.id, h.refs.get(two!.id)!))
    const count = h.candidateIds.length
    const replay = repeatNodeAction({ runId: f.run.id, store: h.input.store, driver: h.input.driver,
      limiter: new ExecutionLimiter(1), signal: h.controller.signal })
    await replay(h.refs.get(two!.id)!, h.initial)
    assert.equal(h.candidateIds.length, count)
    assert.equal(h.observations.filter((id) => id === two!.id).length, 1)
  })
  it('rejects cross-occurrence resolution and input binding, and a synthetic occurrence on ordinary work', async () => {
    const f = a1Scenario('repeat', 'a1-cross'), h = graphHarness(f, { outcome: (ref) => ref.occurrence!.occurrenceIndex === 2 ? 'pass' : 'issues' })
    await h.run()
    const [first, second] = [...h.occurrences.values()]
    const target = { nodeId: f.version.definition.nodes[1]!.id, occurrence: second!.identity }
    assert.throws(() => decideRepeatAdmission(f.version, target, h.local.get(first!.identity.occurrenceId)!), { code: 'REPEAT_CROSS_OCCURRENCE_JOIN' })
    const recipient = [...h.executions.values()].find((execution) => execution.workflowNodeId === target.nodeId
      && h.refs.get(execution.id)!.occurrence?.occurrenceId === second!.identity.occurrenceId)!
    const prior = [...h.inputs].find(([id]) => h.refs.get(id)!.nodeId === target.nodeId
      && h.refs.get(id)!.occurrence?.occurrenceId === first!.identity.occurrenceId)![1]
    assert.throws(() => bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient, ref: target,
      occurrence: second!, entry: h.entries.get(second!.identity.occurrenceId)!, predecessors: prior.input.predecessors }), { code: 'REPEAT_CROSS_OCCURRENCE_JOIN' })
    const ordinary = a1Scenario('single', 'a1-no-synthetic')
    assert.throws(() => assertRepeatRef(ordinary.version, ordinary.scope, { nodeId: ordinary.version.entryNodeId,
      occurrence: { ...first!.identity, scope: ordinary.scope } }), { code: 'REPEAT_OCCURRENCE_CONFLICT' })
  })
  it('Stop after an accepted repeat decision cannot admit the next business occurrence', async () => {
    const f = a1Scenario('repeat', 'a1-stop-boundary')
    const h: ReturnType<typeof graphHarness> = graphHarness(f, { outcome: () => 'issues', beforeTransition: () => {
      h.controller.abort(new DomainError('GRAPH_STOP_CONFLICT', 'Synthetic committed Stop', 409))
    } })
    await assert.rejects(h.run())
    assert.equal(h.decisions.size, 1)
    assert([...h.refs.values()].every((ref) => ref.occurrence!.occurrenceIndex === 1))
    assert.equal(h.completeCalls, 0)
    const count = h.candidateIds.length
    await assert.rejects(h.input.store.transition([...h.decisions.keys()][0]!))
    assert.equal(h.candidateIds.length, count)
  })
  it('Stop racing an already-returning transition is checked again before checkpointing the next occurrence', async () => {
    const f = a1Scenario('repeat', 'a1-stop-return'), h = graphHarness(f, { outcome: () => 'issues' })
    const transition = h.input.store.transition.bind(h.input.store)
    h.input.store.transition = async (id) => {
      const result = await transition(id)
      h.controller.abort(new DomainError('GRAPH_STOP_CONFLICT', 'Committed Stop after transition read', 409))
      return result
    }
    await assert.rejects(h.run())
    assert.equal(h.transitions.length, 1)
    assert([...h.refs.values()].every((ref) => ref.occurrence!.occurrenceIndex === 1))
    assert.equal(h.completeCalls, 0)
  })
  it('graph size is independent of repeat cap and ordinary size has no hidden cap-one wrapper', () => {
    const f = a1Scenario('repeat', 'a1-layout'), first = compileRepeatLayout(f.version)
    f.version.definition.repeat!.blocks[0]!.maxOccurrences = 30
    f.version.definition.executionPolicy!.maxNodeExecutions = 60
    const second = compileRepeatLayout(f.version)
    assert.deepEqual(second.nodes, first.nodes); assert.deepEqual(second.edges, first.edges)
    assert(second.recursionLimit > first.recursionLimit)
    delete f.version.definition.repeat
    const ordinary = compileRepeatLayout(f.version)
    assert.equal(ordinary.nodes.length, f.version.definition.nodes.length)
    assert.deepEqual(ordinary.boundaries, [])
  })
  it('current choice parser accepts an exact native text carrier without rewriting evidence and rejects mixed/prose carriers', () => {
    const f = a1Scenario('conditional', 'a1-result'), node = f.version.definition.nodes[0]!
    const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({ routing: { outcome: 'go' }, data: null }) } }
    const original = structuredClone(result)
    assert.equal(parseCurrentChoiceResult(result, node.choice!).routing.outcome, 'go')
    assert.deepEqual(result, original)
    assert.throws(() => parseCurrentChoiceResult({ ...result, output: { ...result.output, other: true } }, node.choice!))
    assert.throws(() => parseCurrentChoiceResult({ ...result, output: `prose ${result.output.text}` }, node.choice!))
    assert(currentInitialPrompt(node)!.includes('finite-choice output contract (version 1)'))
    const repeated = a1Scenario('repeat', 'a1-result-repeat')
    assert(currentInitialPrompt(repeated.version.definition.nodes[1]!, true)!.includes('remainingFindings'))
  })
})

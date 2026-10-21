import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { HarnessExecutionSchema, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import {
  ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, parseRepeatExitResultV1, validateRepeatDecisionV1,
  type CurrentFixtureForm, type RepeatDecisionV1, type RepeatOccurrenceV1,
} from '@foreman-code/contracts/wave25'
import { buildRepeatGraph, type RepeatGraphStore } from '../../src/modules/runs/repeatGraph.js'
import type { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'
import {
  inactiveRepeatResolution, repeatTerminalResolution,
  type RepeatExecutionDriver, type RepeatGraphState,
} from '../../src/modules/runs/repeatNode.js'
import {
  assertRepeatBodyComplete, assertRepeatRef, bindRepeatNodeInput, blockForNode, compileRepeatLayout,
  decideRepeatAdmission, decideRepeatExit, finalRepeatExport, freezeRepeatEntry, makeRepeatOccurrence,
  repeatDigest, repeatId, repeatSlotId, repeatSuccessorInput,
  type RepeatEntryInput, type RepeatInputBinding, type RepeatNodeInput, type RepeatNodeRef,
  type RepeatResolution, type RepeatSource,
} from '../../src/modules/runs/repeatResolution.js'
import { compileExecutionTopology, decideExecutionAdmission } from '../../src/modules/runs/topology.js'

export function a1Scenario(form: CurrentFixtureForm = 'sequential', suffix = `a1-${form}`) {
  return makeCurrentWorkflowFixture(suffix, form)
}
export type A1Scenario = ReturnType<typeof a1Scenario>
export function unequalScenario(): A1Scenario {
  const f = a1Scenario('parallel', 'a1-unequal-engine')
  const config = { ...f.configurations[2]!, agentId: 'agent-a1-long', id: 'cfg-a1-long' }
  f.configurations.push(config)
  const extra = { id: 'node-a1-long', agentId: config.agentId, name: 'Long branch' }
  const edge = f.version.definition.edges.find((item) => item.source === f.version.definition.nodes[2]!.id && item.target === f.version.definition.nodes[3]!.id)!
  edge.target = extra.id
  f.version.definition.edges.push({ id: 'edge-a1-long', kind: 'execution', source: extra.id, target: f.version.definition.nodes[3]!.id })
  f.version.definition.nodes.push(extra); f.version.agentConfigurationVersionIds[config.agentId] = config.id
  f.version.definition.executionPolicy!.maxNodeExecutions = 5
  f.run.agentConfigurationVersionIds = { ...f.version.agentConfigurationVersionIds }
  ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
  return f
}
export function conditionalScenario(): A1Scenario {
  const f = a1Scenario('parallel', 'a1-conditional-engine')
  f.version.definition.nodes[0]!.choice = { outcomes: f.version.definition.edges.filter((item) => item.source === f.version.entryNodeId)
    .map((edge, index) => ({ outcome: index === 0 ? 'left' : 'right', target: { kind: 'edge' as const, relationshipId: edge.id } })) }
  ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
  return f
}
export function approvalParallelScenario(): A1Scenario {
  const f = a1Scenario('parallel', 'a1-approval-engine')
  f.configurations[0]!.productRole = 'orchestrator'
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: f.configurations[0]!.agentId }
  f.version.approval = approval; f.version.definition.approval = approval; f.run.approval = approval
  for (const node of f.version.definition.nodes.slice(1)) f.version.definition.edges.push({ id: `review-${node.id}`,
    kind: 'approval', source: f.version.entryNodeId, target: node.id })
  ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations })
  return f
}

/** Deterministic TEST PORTS only: exercises the REAL graph, node action, routing,
 * binding and repeat algorithms. Not PostgreSQL, native launch, receipts or a
 * production publisher. The A2/A3 suites must prove these ports durably. */
export function graphHarness(f: A1Scenario, options: {
  outcome?: (ref: RepeatNodeRef) => string
  retryEntryOnce?: boolean
  beforeObserve?: (execution: HarnessExecution, ref: RepeatNodeRef, signal: AbortSignal) => Promise<void>
  beforeTransition?: (occurrence: RepeatOccurrenceV1) => void
} = {}) {
  const version = ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version
  const controller = new AbortController(), checkpointer = new MemorySaver()
  const executions = new Map<string, HarnessExecution>(), refs = new Map<string, RepeatNodeRef>()
  const inputs = new Map<string, { input: RepeatNodeInput; digest: string; bindings: RepeatInputBinding[] }>()
  const slots = new Map<string, string>(), local = new Map<string, Map<string, RepeatResolution>>()
  const outside = new Map<string, RepeatResolution>(), occurrences = new Map<string, RepeatOccurrenceV1>()
  const entries = new Map<string, RepeatEntryInput>(), decisions = new Map<string, RepeatDecisionV1>()
  const successors = new Map<string, RepeatOccurrenceV1 | null>(), first = new Map<string, string>()
  const observations: string[] = [], candidateIds: string[] = [], transitions: string[] = []
  let completeCalls = 0, enterCalls = 0, retryCount = 0
  const now = f.createdAt
  const scopeRows = (ref: RepeatNodeRef) => {
    if (!ref.occurrence) return outside
    let rows = local.get(ref.occurrence.occurrenceId)
    if (!rows) { rows = new Map(); local.set(ref.occurrence.occurrenceId, rows) }
    return rows
  }
  const candidate = (ref: RepeatNodeRef, attempt: number) => {
    assertRepeatRef(version, f.scope, ref)
    const node = version.definition.nodes.find((item) => item.id === ref.nodeId)!
    assert(node.kind !== 'job', 'Agent graph harness requires an Agent node')
    const id = repeatId('a1-execution', f.run.id, ref.occurrence?.occurrenceId ?? 'ordinary', ref.nodeId, attempt)
    assert.equal(candidateIds.includes(id), false, 'candidate must be allocated once per exact attempt')
    candidateIds.push(id)
    return HarnessExecutionSchema.parse({ id, runId: f.run.id, workflowNodeId: ref.nodeId,
      agentId: node.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
      attempt, input: {}, state: 'queued', createdAt: now })
  }
  const source = (row: RepeatResolution, relationshipId: string): RepeatSource => {
    assert(row.value.execution); const execution = executions.get(row.value.execution.executionId)!
    assert.equal(execution.result?.outcome, 'succeeded')
    return { relationshipId, execution: row.value.execution, occurrence: row.ref.occurrence,
      acceptedResult: execution.result!, acceptedResultDigest: row.value.acceptedResultDigest! }
  }
  const saveCandidate = (ref: RepeatNodeRef, execution: HarnessExecution, predecessors: RepeatSource[]) => {
    const occurrence = ref.occurrence ? occurrences.get(ref.occurrence.occurrenceId)! : null
    const bound = bindRepeatNodeInput({ version, runInput: f.run.input, recipient: execution, ref,
      occurrence, entry: occurrence ? entries.get(occurrence.identity.occurrenceId)! : null, predecessors })
    inputs.set(execution.id, bound)
    const stored = HarnessExecutionSchema.parse({ ...execution, input: bound.input })
    executions.set(execution.id, stored); refs.set(execution.id, ref); slots.set(repeatSlotId(f.run.id, ref), execution.id)
    return stored
  }
  const unsupportedWork = async (): Promise<never> => { throw new Error('Unexpected work handoff') }
  const store: RepeatGraphStore & Pick<RepeatRunRepository, 'ensureWorkEntry' | 'admitWorkActivation' | 'acceptWorkTerminal'
    | 'admitWorkRequest' | 'returnWork' | 'recordWorkUnresolved' | 'resolveWaitingWorkJoins' | 'completeWorkRun'>
    & { resolveExcluded(): Promise<void>; completeRun(): Promise<void> } = {
    ensureWorkEntry: unsupportedWork, admitWorkActivation: unsupportedWork, acceptWorkTerminal: unsupportedWork,
    admitWorkRequest: unsupportedWork, returnWork: unsupportedWork, recordWorkUnresolved: unsupportedWork,
    completeWorkRun: unsupportedWork,
    resolveWaitingWorkJoins: unsupportedWork,
    async admit(ref, allocate) {
      controller.signal.throwIfAborted(); assertRepeatRef(version, f.scope, ref)
      const rows = scopeRows(ref), admission = decideRepeatAdmission(version, ref, rows)
      if (admission.kind === 'resolved') return { kind: 'resolved', resolution: rows.get(ref.nodeId)! }
      if (admission.kind === 'waiting') return { kind: 'waiting' }
      if (admission.kind === 'skipped' || admission.kind === 'excluded') {
        const resolution = inactiveRepeatResolution(version, ref, admission.kind, now)
        rows.set(ref.nodeId, resolution); return { kind: 'resolved', resolution }
      }
      assert.equal(admission.kind, 'run')
      if (admission.kind !== 'run') throw new Error('Expected runnable admission')
      const prior = slots.get(repeatSlotId(f.run.id, ref))
      if (prior) return { kind: 'admitted', execution: executions.get(prior)!, reused: true }
      const predecessors = admission.selected.map((edge) => source(rows.get(edge.source)!, edge.id))
      return { kind: 'admitted', execution: saveCandidate(ref, allocate(), predecessors), reused: false }
    },
    async acceptTerminal(id, allocate) {
      controller.signal.throwIfAborted()
      const execution = executions.get(id)!, ref = refs.get(id)!, rows = scopeRows(ref)
      assert.equal(execution.state, 'completed')
      const replay = rows.get(ref.nodeId)
      if (replay) { assert.equal(replay.value.execution?.executionId, id); return { kind: 'resolved', resolution: replay } }
      if (execution.result?.outcome === 'failed' && options.retryEntryOnce && execution.attempt === 1) {
        retryCount++
        const retry = saveCandidate(ref, allocate(2), inputs.get(id)!.input.predecessors)
        assert.equal(inputs.get(retry.id)!.digest, inputs.get(id)!.digest, 'retry keeps frozen input')
        return { kind: 'retry', execution: retry }
      }
      const resolution = repeatTerminalResolution(version, f.scope, ref, execution)
      rows.set(ref.nodeId, resolution)
      const block = blockForNode(version, ref.nodeId)
      if (block && block.exitNodeId === ref.nodeId) {
        const occurrence = occurrences.get(ref.occurrence!.occurrenceId)!
        assertRepeatBodyComplete(version, occurrence.identity, rows)
        const envelope = parseRepeatExitResultV1(execution.result, version.definition.nodes.find((node) => node.id === ref.nodeId)!.choice!)
        const decision = decideRepeatExit(version, occurrence, execution, envelope, now)
        validateRepeatDecisionV1(version, decision, execution.result)
        decisions.set(occurrence.identity.occurrenceId, decision)
        if (decision.reason === 'repeat') {
          const nextInput = repeatSuccessorInput(entries.get(occurrence.identity.occurrenceId)!, decision, execution.result!)
          const next = makeRepeatOccurrence(f.scope, block, nextInput, decision)
          occurrences.set(next.occurrence.identity.occurrenceId, next.occurrence)
          entries.set(next.occurrence.identity.occurrenceId, next.input)
          successors.set(occurrence.identity.occurrenceId, next.occurrence)
        } else {
          successors.set(occurrence.identity.occurrenceId, null)
          outside.set(block.exitNodeId, finalRepeatExport(version, resolution, decision))
        }
      }
      return { kind: 'resolved', resolution }
    },
    async enterBlock(blockId) {
      controller.signal.throwIfAborted(); enterCalls++
      const block = version.definition.repeat!.blocks.find((item) => item.id === blockId)!
      const existing = first.get(blockId)
      if (existing) return { kind: 'active', occurrence: occurrences.get(existing)! }
      const decision = decideExecutionAdmission(compileExecutionTopology(version), block.entryNodeId,
        new Map([...outside].map(([id, row]) => [id, row.value])))
      assert.equal(decision.kind, 'run', 'this harness only enters selected configured blocks')
      if (decision.kind !== 'run') throw new Error('unexpected inactive block')
      const entry = freezeRepeatEntry(f.run.input, decision.selected.map((edge) => source(outside.get(edge.source)!, edge.id)))
      const value = makeRepeatOccurrence(f.scope, block, entry, null)
      occurrences.set(value.occurrence.identity.occurrenceId, value.occurrence)
      entries.set(value.occurrence.identity.occurrenceId, value.input); first.set(blockId, value.occurrence.identity.occurrenceId)
      return { kind: 'active', occurrence: value.occurrence }
    },
    async readOccurrence(id) {
      controller.signal.throwIfAborted(); assert(occurrences.has(id)); return structuredClone(occurrences.get(id)!)
    },
    async transition(id) {
      controller.signal.throwIfAborted(); const occurrence = occurrences.get(id)!; assert(occurrence)
      options.beforeTransition?.(occurrence)
      controller.signal.throwIfAborted(); transitions.push(id)
      assert(decisions.has(id)); assert(successors.has(id))
      return { decision: decisions.get(id)!, next: successors.get(id)! }
    },
    async resolveExcluded() {
      for (const nodeId of compileExecutionTopology(version).excluded) outside.set(nodeId,
        inactiveRepeatResolution(version, { nodeId, occurrence: null }, 'excluded', now))
    },
    async completeRun() {
      controller.signal.throwIfAborted()
      for (const nodeId of compileExecutionTopology(version).order) {
        const block = blockForNode(version, nodeId)
        if (block && block.exitNodeId !== nodeId) continue
        assert(['succeeded', 'skipped'].includes(outside.get(nodeId)?.value.resolution ?? ''), `${nodeId} has not settled`)
      }
      completeCalls++
    },
  }
  const driver: RepeatExecutionDriver = {
    candidate,
    async observe(value, signal) {
      signal.throwIfAborted(); const execution = executions.get(value.id)!, ref = refs.get(value.id)!
      if (execution.state === 'completed') return
      await options.beforeObserve?.(execution, ref, signal)
      signal.throwIfAborted(); observations.push(value.id)
      const node = version.definition.nodes.find((item) => item.id === ref.nodeId)!, block = blockForNode(version, ref.nodeId)
      const outcome = options.outcome?.(ref) ?? (block?.exitNodeId === ref.nodeId ? 'pass' : 'left')
      const data = block?.exitNodeId === ref.nodeId
        ? { latestDeliverable: { revision: ref.occurrence!.occurrenceIndex }, remainingFindings: outcome === 'pass' ? [] : ['remaining'] }
        : { nodeId: ref.nodeId }
      const retry = options.retryEntryOnce && ref.nodeId === version.entryNodeId && execution.attempt === 1
        && (ref.occurrence?.occurrenceIndex ?? 1) === 1
      const result: ExecutionResult = retry ? { outcome: 'failed', error: { code: 'A1_TRANSIENT', message: 'Synthetic technical failure', retryable: true } }
        : { outcome: 'succeeded', output: node.choice ? { routing: { outcome }, data } : data }
      executions.set(value.id, HarnessExecutionSchema.parse({ ...execution, state: 'completed', result, finishedAt: now }))
    },
  }
  const input = { runId: f.run.id, version, store, driver, checkpointer, signal: controller.signal, configuredParallelism: 3 }
  const built = buildRepeatGraph(input)
  const initial: RepeatGraphState = { runId: f.run.id, occurrences: {}, boundaries: {}, executionIds: {} }
  return { ...built, input, initial, version, controller, executions, refs, inputs, outside, local,
    occurrences, entries, decisions, successors, observations, candidateIds, transitions,
    get completeCalls() { return completeCalls }, get enterCalls() { return enterCalls }, get retryCount() { return retryCount },
    layout: compileRepeatLayout(version), digest: repeatDigest,
    async run() { await store.resolveExcluded(); const result = await built.graph.invoke(initial, built.config); return result },
  }
}

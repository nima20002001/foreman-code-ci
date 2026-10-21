import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, ExecutableWorkflowV3Schema, type NodeResolution, type WorkflowChoice } from '@foreman-code/contracts/wave25'
import { normalizeRepeatTerminal, inactiveRepeatResolution, repeatTerminalResolution, type RepeatNodeStore } from '../../src/modules/runs/repeatNode.js'
import { bindRepeatNodeInput, type RepeatInputBinding, type RepeatNodeRef } from '../../src/modules/runs/repeatResolution.js'
import { compileExecutionTopology, decideExecutionAdmission } from '../../src/modules/runs/topology.js'
import type { RepeatGraphStore } from '../../src/modules/runs/repeatGraph.js'

/** Synthetic durable-domain stand-in ONLY for real LangGraph wrapper tests.
 * SQL atomicity/locks are tested separately against actual PostgreSQL. */
export function syntheticCurrentWorkflow(names: string[], edges: Array<[string, string]>, choices: Record<string, WorkflowChoice> = {}) {
  const f = makeCurrentWorkflowFixture(randomUUID())
  const configurations = names.map((name) => ({ ...f.configurations[0]!, id: `cfg-${name}`, agentId: `agent-${name}` }))
  const version = ExecutableWorkflowV3Schema.parse({ configurations, version: {
    ...f.version, entryNodeId: names[0],
    agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])),
    definition: { ...f.version.definition, entryNodeId: names[0],
      executionPolicy: { maxParallelism: 4, maxNodeExecutions: names.length },
      nodes: names.map((name) => ({ id: name, agentId: `agent-${name}`, name, ...(choices[name] ? { choice: choices[name] } : {}) })),
      edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target, kind: 'execution' })),
    },
  } }).version
  const topology = compileExecutionTopology(version)
  const resolutions = new Map<string, NodeResolution>()
  const executions = new Map<string, { execution: HarnessExecution; accepted: boolean }>()
  const receipts: RepeatInputBinding[] = []
  const constructed: string[] = [], nativeCalls: string[] = []
  const completionOrder: string[] = []
  let active = 0, peak = 0
  let failAcceptance = false
  const candidate = ({ nodeId }: RepeatNodeRef) => {
    constructed.push(nodeId)
    return HarnessExecutionSchema.parse({ id: `exec-${nodeId}`, runId: f.run.id, workflowNodeId: nodeId,
      agentId: `agent-${nodeId}`, agentConfigurationVersionId: `cfg-${nodeId}`, attempt: 1,
      input: {}, state: 'queued', createdAt: f.createdAt })
  }
  const store: RepeatNodeStore & RepeatGraphStore = {
    async admit(ref, create) {
      const { nodeId } = ref
      const decision = decideExecutionAdmission(topology, nodeId, resolutions)
      if (decision.kind === 'resolved') return { kind: 'resolved', resolution: { ref, value: decision.resolution, deferredRelationshipIds: [] } }
      if (decision.kind === 'waiting') return { kind: 'waiting' }
      if (decision.kind === 'skipped' || decision.kind === 'excluded') {
        const resolution = inactiveRepeatResolution(version, ref, decision.kind, f.createdAt)
        resolutions.set(nodeId, resolution.value)
        return { kind: 'resolved', resolution }
      }
      const existing = [...executions.values()].find((item) => item.execution.workflowNodeId === nodeId)
      if (existing) return { kind: 'admitted', execution: existing.execution, reused: true }
      assert(decision.kind === 'run')
      const execution = create()
      const result = bindRepeatNodeInput({ version, runInput: {}, recipient: execution, ref, occurrence: null, entry: null,
        predecessors: decision.selected.map((edge) => {
          const resolution = resolutions.get(edge.source)!
          const previous = executions.get(resolution.execution!.executionId)!
          if (!previous.accepted) throw new Error('Cannot bind an unaccepted predecessor')
          return { relationshipId: edge.id, execution: resolution.execution!, occurrence: null,
            acceptedResult: previous.execution.result!, acceptedResultDigest: resolution.acceptedResultDigest! }
        }) })
      const bound = HarnessExecutionSchema.parse({ ...execution, input: result.input })
      executions.set(bound.id, { execution: bound, accepted: false })
      receipts.push(...result.bindings)
      return { kind: 'admitted', execution: bound, reused: false }
    },
    async acceptTerminal(id) {
      if (failAcceptance) { failAcceptance = false; throw new Error('synthetic acceptance/checkpoint boundary crash') }
      const row = executions.get(id)!
      const old = resolutions.get(row.execution.workflowNodeId)
      const ref = { nodeId: row.execution.workflowNodeId, occurrence: null }
      if (old) return { kind: 'resolved', resolution: { ref, value: old, deferredRelationshipIds: [] } }
      row.execution = normalizeRepeatTerminal(version, f.scope, ref, row.execution)
      const resolution = repeatTerminalResolution(version, f.scope, ref, row.execution)
      row.accepted = resolution.value.resolution === 'succeeded'
      resolutions.set(resolution.value.workflowNodeId, resolution.value)
      return { kind: 'resolved', resolution }
    },
    async enterBlock() { throw new Error('Ordinary fixture has no repeat block') },
    async readOccurrence() { throw new Error('Ordinary fixture has no occurrence') },
    async transition() { throw new Error('Ordinary fixture has no transition') },
  }
  const driver = (output: (nodeId: string) => unknown = () => ({ done: true }), wait: (nodeId: string) => Promise<void> = async () => undefined) => ({
    candidate,
    async observe(execution: HarnessExecution, signal: AbortSignal) {
      signal.throwIfAborted()
      if (executions.get(execution.id)!.execution.state === 'completed') return
      nativeCalls.push(execution.workflowNodeId); active++; peak = Math.max(peak, active)
      try {
        await wait(execution.workflowNodeId)
        signal.throwIfAborted()
        executions.get(execution.id)!.execution = HarnessExecutionSchema.parse({ ...execution,
          state: 'completed', result: { outcome: 'succeeded', output: output(execution.workflowNodeId) }, finishedAt: f.createdAt })
        completionOrder.push(execution.workflowNodeId)
      } finally { active-- }
    },
  })
  return { runId: f.run.id, version, store, driver, resolutions, executions, receipts, constructed, nativeCalls, completionOrder,
    get peak() { return peak }, failNextAcceptance: () => { failAcceptance = true } }
}

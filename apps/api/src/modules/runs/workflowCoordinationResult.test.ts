import { describe, expect, it } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { parseWorkflowCoordinationResult, parseWorkflowWorkResult, workflowArtifactResult } from './workflowCoordinationResult.js'
import { normalizeRepeatTerminal, repeatTerminalResolution } from './repeatNode.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'
import { workflowDeliverableContract } from './workflowDeliverable.js'
import { workResultRepairPrompt } from '../interactions/workResultRepair.js'

const board = { kind: 'none', reason: 'no_changes' } as const
const business = { answer: 'A concrete completed deliverable' }
const outputSchema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false }
const kinds = ['plain', 'choice', 'repeat', 'artifact', 'handoff', 'interval'] as const

function producer(kind: typeof kinds[number]) {
  const f = makeCurrentWorkflowFixture(`coordinated-${kind}`, kind === 'choice' ? 'conditional' : kind === 'repeat' ? 'repeat' : 'single')
  const node = f.version.definition.nodes[kind === 'repeat' ? 1 : 0]!
  node.outputSchema = outputSchema
  if (kind === 'artifact') node.artifactOutputs = { version: 1, outputKeys: ['report'] }
  if (kind === 'handoff') f.version.definition.handoffs = { contractVersion: 1 }
  if (kind === 'interval') node.interval = { everySeconds: 60 }
  const input = kind === 'handoff' ? WorkActivationInputSchema.parse({ executionSemanticsVersion: 3,
    runInput: { task: 'Preserve the exact assigned input' }, occurrence: null, entry: null, predecessors: [],
    work: { kind: 'entry', activation: { scope: f.scope, activationId: 'activation', workflowNodeId: node.id,
      lineageId: 'lineage', cause: { kind: 'entry' } } },
  }) : kind === 'interval' ? { tick: { index: 1 } } : { task: 'Preserve the exact assigned input' }
  const envelope = { data: kind === 'handoff' || kind === 'repeat'
    ? { latestDeliverable: business, remainingFindings: [] } : kind === 'interval' ? { observations: [] } : business,
  summary: 'A useful result summary', board,
  ...(kind === 'choice' ? { routing: { outcome: 'go' } } : kind === 'repeat' ? { routing: { outcome: 'pass' } }
    : kind === 'handoff' ? { routing: { kind: 'finish' } } : {}),
  ...(kind === 'artifact' ? { artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: 'original-report' }] } } : {}),
  }
  const result: ExecutionResult = { outcome: 'succeeded', output: kind === 'artifact' ? { text: JSON.stringify(envelope) } : envelope }
  const execution = HarnessExecutionSchema.parse({ id: `execution-${kind}`, runId: f.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId], attempt: 1,
    input, workingDirectory: '/workspace/project', runtimeDirectory: '/workspace/runtime', state: 'completed', result,
    createdAt: f.createdAt, finishedAt: '2026-10-21T10:00:00.000Z' })
  const context = { resultProtocol: COORDINATION_RESULT_PROTOCOL, definition: f.version.definition,
    workflowNodeId: node.id, interval: kind === 'interval' }
  return { f, node, execution, result, envelope, context }
}

describe('workflow coordinated producers and native result consumers', () => {
  it.each(kinds)('parses %s metadata without applying the business schema to collaboration fields', kind => {
    const { f, node, execution, result, envelope, context } = producer(kind)
    const parsed = parseWorkflowCoordinationResult(result, context, execution.input)
    expect(parsed).toEqual(envelope)
    const contract = workflowDeliverableContract(f.version, execution, async () => new Set(), COORDINATION_RESULT_PROTOCOL)
    expect(contract?.source).toBe(['handoff', 'repeat'].includes(kind) ? 'latestDeliverable' : 'data')
    // Request metadata and bounded context do not mutate the frozen logical task.
    const request = workflowExecutionRequest({ execution, version: f.version,
      configuration: f.configurations.find(configuration => configuration.agentId === node.agentId)!,
      workspaceId: f.scope.workspaceId, resultProtocol: COORDINATION_RESULT_PROTOCOL,
      collaborationPrompt: 'Permitted board context at the accepted revision' })
    expect(request.resultProtocol).toBe(COORDINATION_RESULT_PROTOCOL)
    expect(request.input).toEqual(execution.input)
    expect(request.initialPrompt).toContain('Permitted board context at the accepted revision')
    expect(workResultRepairPrompt(result, request.initialPrompt!, execution.input, undefined, context)).toBeUndefined()
    const invalid = { ...result, output: { ...envelope, summary: '' } }
    expect(workResultRepairPrompt(invalid, request.initialPrompt!, execution.input, undefined, context)).toEqual(expect.any(String))
    if (kind === 'artifact') expect(workflowArtifactResult(result, f.version, node.id, COORDINATION_RESULT_PROTOCOL))
      .toEqual({ version: 1, outputs: [{ outputKey: 'report', commandId: 'original-report' }] })
  })

  it('normalizes a malformed marked plain success once and preserves historical plain native bytes', () => {
    const { f, node, execution } = producer('plain')
    const original = { ...execution, result: { outcome: 'succeeded' as const, output: 'The historical plain answer' } }
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: node.id, occurrence: null }, original).result).toEqual(original.result)
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: node.id, occurrence: null }, original,
      { resultProtocol: COORDINATION_RESULT_PROTOCOL }).result).toMatchObject({ outcome: 'failed', error: { code: 'WORK_RESULT_INVALID' } })
    expect(original.result).toEqual({ outcome: 'succeeded', output: 'The historical plain answer' })
    const request = workflowExecutionRequest({ execution: original, version: f.version, configuration: f.configurations[0]!,
      workspaceId: f.scope.workspaceId })
    expect(request.resultProtocol).toBeUndefined()
  })

  it('retains real failures and cancellations without inventing a model summary or board', () => {
    const { f, node, execution } = producer('plain')
    f.version.definition.handoffs = { contractVersion: 1 }
    for (const outcome of ['failed', 'canceled'] as const) {
      const result: ExecutionResult = outcome === 'failed' ? { outcome,
        error: { code: 'NATIVE_STOPPED', message: 'The original native attempt stopped.', retryable: false } } : { outcome }
      expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: node.id, occurrence: null }, { ...execution, result },
        { resultProtocol: COORDINATION_RESULT_PROTOCOL, workResultRepair: true }).result).toEqual(result)
    }
    expect(() => normalizeRepeatTerminal(f.version, f.scope, { nodeId: node.id, occurrence: null }, { ...execution,
      result: { outcome: 'canceled', error: { code: 'INVALID', message: 'Cancellation is not a failure.', retryable: false } },
    }, { resultProtocol: COORDINATION_RESULT_PROTOCOL })).toThrow('only a failed result may include an error')
  })

  it('uses saved exclusive routing for a coordinated choice and preserves an unmarked handoff envelope', () => {
    const selected = producer('choice')
    const resolution = repeatTerminalResolution(selected.f.version, selected.f.scope,
      { nodeId: selected.node.id, occurrence: null }, selected.execution, COORDINATION_RESULT_PROTOCOL)
    expect(resolution.value).toMatchObject({ outcome: 'go', selectedRelationshipIds: [selected.f.version.definition.edges[0]!.id] })
    const old = producer('handoff')
    const result: ExecutionResult = { outcome: 'succeeded', output: { routing: { kind: 'finish' },
      data: { latestDeliverable: business, remainingFindings: [] } } }
    expect(parseWorkflowWorkResult(result, old.f.version, old.node.id, undefined, old.execution.input)).toEqual(result.output)
    expect(() => parseWorkflowWorkResult(result, old.f.version, old.node.id, COORDINATION_RESULT_PROTOCOL, old.execution.input)).toThrow()
  })

  it('checks interval output without requiring a work request or accepting route/artifact declarations', () => {
    const { f, node, execution, context, result, envelope } = producer('interval')
    f.version.definition.handoffs = { contractVersion: 1 }
    node.artifactOutputs = { version: 1, outputKeys: ['report'] }
    expect(parseWorkflowCoordinationResult(result, context, execution.input)).toEqual(envelope)
    expect(() => parseWorkflowCoordinationResult({ outcome: 'succeeded', output: { ...envelope, routing: { kind: 'finish' } } },
      context, execution.input)).toThrow()
    expect(workResultRepairPrompt({ outcome: 'succeeded', output: { invalid: true } }, 'Bounded result contract',
      execution.input, undefined, context)).toEqual(expect.any(String))
  })

  it('keeps the original artifact text carrier and rejects mixed or unbounded coordinated output', () => {
    const { f, node, result, envelope, context } = producer('artifact')
    expect(() => workflowArtifactResult({ outcome: 'succeeded', output: envelope }, f.version, node.id,
      COORDINATION_RESULT_PROTOCOL)).toThrow('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED')
    expect(() => parseWorkflowCoordinationResult({ ...result, output: { text: JSON.stringify(envelope), extra: true } }, context)).toThrow()
    expect(() => parseWorkflowCoordinationResult({ outcome: 'succeeded', output: { text: JSON.stringify({
      ...envelope, summary: 'x'.repeat(601),
    }) } }, context)).toThrow()
    expect(() => parseWorkflowCoordinationResult({ outcome: 'succeeded', output: { text: ' '.repeat(64 * 1024 + 1) } }, context)).toThrow()
  })
})

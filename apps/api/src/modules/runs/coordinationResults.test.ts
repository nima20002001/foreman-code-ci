import { expect, it } from 'vitest'
import { HarnessExecutionSchema, parseCoordinationResult, type CoordinationResultContext } from '@foreman-code/contracts'
import { parseWorkflowArtifactResult } from '@foreman-code/contracts/workflow-artifact-result'
import { makeCurrentWorkflowFixture, parseWorkHandoffResult, parseRepeatExitResultV1 } from '@foreman-code/contracts/wave25'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'
import { normalizeRepeatTerminal } from './repeatNode.js'
import { parseCurrentChoiceResult } from './currentRouting.js'
import { workflowDeliverableContract } from './workflowDeliverable.js'
import { deliverableVerdict } from '../interactions/deliverable.js'

it.each(['plain', 'choice', 'repeat', 'handoff', 'artifact', 'choice_artifact', 'interval'] as const)(
  'validates the complete %s result and preserves its original bytes', async family => {
    const form = family === 'repeat' ? 'repeat' : family === 'choice' || family === 'choice_artifact' ? 'conditional' : 'single'
    const fixture = makeCurrentWorkflowFixture(`coordination-${family}`, form)
    if (family === 'handoff') fixture.version.definition.handoffs = { contractVersion: 1 }
    const node = family === 'repeat' ? fixture.version.definition.nodes[1]! : fixture.version.definition.nodes[0]!
    if (family === 'artifact' || family === 'choice_artifact') node.artifactOutputs = { version: 1, outputKeys: ['report'] }
    if (family === 'interval') node.interval = { everySeconds: 300 }
    const context: CoordinationResultContext = { resultProtocol: 'f1-f4-v1', definition: fixture.version.definition,
      workflowNodeId: node.id, interval: family === 'interval' }
    const data = family === 'handoff' || family === 'repeat'
      ? { latestDeliverable: { answer: 'Complete' }, remainingFindings: [] } : { answer: 'Complete' }
    const business = { data,
      ...(family === 'handoff' ? { routing: { kind: 'finish' } } : {}),
      ...(node.choice ? { routing: { outcome: node.choice.outcomes[0]!.outcome } } : {}),
      ...(node.artifactOutputs ? { artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: 'publication' }] } } : {}),
    }
    const output = { text: JSON.stringify({ ...business, summary: 'Finished.', board: { kind: 'none', reason: 'no_access' } }) }
    const configuration = fixture.configurations.find(value => value.agentId === node.agentId)!
    let input: unknown = {}
    if (family === 'interval') input = { tick: { index: 1, everySeconds: 300 } }
    if (family === 'handoff') input = { executionSemanticsVersion: 3, runInput: {}, occurrence: null, entry: null,
      predecessors: [], work: { kind: 'entry', activation: { scope: fixture.scope, activationId: 'entry-activation',
        workflowNodeId: node.id, lineageId: fixture.run.id, cause: { kind: 'entry' } } } }
    const execution = HarnessExecutionSchema.parse({ id: 'coordinated-execution', runId: fixture.run.id,
      workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId: configuration.id,
      resultProtocol: 'f1-f4-v1', attempt: 1, state: 'completed', createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
      input,
      workingDirectory: '/work', runtimeDirectory: '/runtime', result: { outcome: 'succeeded', output } })
    const request = workflowExecutionRequest({ execution, version: fixture.version, configuration, workspaceId: fixture.scope.workspaceId })
    expect(request.resultProtocol).toBe('f1-f4-v1')
    expect(request.initialPrompt).toContain('summary')
    expect(request.initialPrompt).toContain('board')
    const contract = workflowDeliverableContract(fixture.version, execution, async () => new Set<string>())!
    expect(await deliverableVerdict(execution.result!, contract)).toBeUndefined()
    expect(await deliverableVerdict({ outcome: 'succeeded', output: { text: JSON.stringify(business) } }, contract))
      .toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
    expect(parseCoordinationResult(output, context).data).toEqual(data)
    if (family === 'handoff') expect(parseWorkHandoffResult(execution.result, context).data).toEqual(data)
    else if (family === 'repeat') expect(parseRepeatExitResultV1(execution.result, node.choice!, node.artifactOutputs, context).data).toEqual(data)
    else if (node.artifactOutputs) expect(parseWorkflowArtifactResult(execution.result, node.artifactOutputs, node.choice, context).data).toEqual(data)
    else if (node.choice) expect(parseCurrentChoiceResult(execution.result!, node.choice, node.artifactOutputs, context).data).toEqual(data)
    else {
      expect(normalizeRepeatTerminal(fixture.version, fixture.scope, { nodeId: node.id, occurrence: null }, execution).result).toEqual(execution.result)
    }
    expect(execution.result).toEqual({ outcome: 'succeeded', output })
  })

it('completes an ordinary node whose Agent answers plain text and still rejects it for an explicit schema', async () => {
  const fixture = makeCurrentWorkflowFixture('coordination-plain-text', 'single')
  const node = fixture.version.definition.nodes[0]!
  const answer = { outcome: 'succeeded', output: { text: 'All checks pass.' } } as const
  const contractFor = () => workflowDeliverableContract(fixture.version, HarnessExecutionSchema.parse({ id: 'plain-execution',
    runId: fixture.run.id, workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: fixture.configurations.find(value => value.agentId === node.agentId)!.id,
    resultProtocol: 'f1-f4-v1', attempt: 1, state: 'completed', createdAt: fixture.createdAt, finishedAt: fixture.createdAt,
    input: {}, workingDirectory: '/work', runtimeDirectory: '/runtime', result: answer }), async () => new Set<string>())!
  expect(await deliverableVerdict(answer, contractFor())).toBeUndefined()
  node.outputSchema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } }
  expect(await deliverableVerdict(answer, contractFor())).toMatchObject({ code: 'OUTPUT_SCHEMA_MISMATCH' })
})

import { expect, it } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { hierarchyRuntimeFixture } from '../../../test/helpers/hierarchyRuntimeFixture.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'

it('routes a saved hierarchy without enabling the separate result protocol or requiring board effects', () => {
  const f = hierarchyRuntimeFixture()
  const output = { routing: { kind: 'delegate', requests: [{ outcome: 'build', data: { task: 'Implement the requested work' } }] },
    data: { latestDeliverable: { plan: 'Build and review' }, remainingFindings: [] }, summary: 'Delegating implementation' }
  const result: ExecutionResult = { outcome: 'succeeded', output }
  const original = structuredClone(result)
  expect(parseWorkflowWorkResult(result, f.version, 'master')).toEqual(output)
  expect(result).toEqual(original)
  expect(() => parseWorkflowWorkResult({ outcome: 'succeeded', output: { ...output,
    routing: { kind: 'delegate', requests: [{ outcome: 'undeclared', data: {} }] },
  } }, f.version, 'master')).toThrow()
  const configuration = f.configurations[0]!
  const input = WorkActivationInputSchema.parse({ executionSemanticsVersion: 3, runInput: f.run.input,
    occurrence: null, entry: null, predecessors: [], work: { kind: 'entry', activation: {
      scope: f.scope, activationId: 'root-activation', workflowNodeId: 'master', lineageId: 'root-lineage', cause: { kind: 'entry' },
    } } })
  const execution = HarnessExecutionSchema.parse({ id: 'root-execution', runId: f.run.id, workflowNodeId: 'master',
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id, attempt: 1, state: 'starting',
    input, workingDirectory: '/workspace/project', runtimeDirectory: '/workspace/runtime', createdAt: f.createdAt })
  const request = workflowExecutionRequest({ execution, version: f.version, configuration, workspaceId: f.scope.workspaceId })
  expect(request.resultProtocol).toBeUndefined()
  expect(request.initialPrompt).toContain('"kind":"delegate"')
  expect(request.initialPrompt).toContain('summary')
  expect(request.initialPrompt).not.toContain('f1-f4-v1')
})

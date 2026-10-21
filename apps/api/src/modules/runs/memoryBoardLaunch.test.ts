import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { assertRepeatNativeUpdate } from '../interactions/repeatNativeEvidence.js'
import { workflowExecutionRequest } from './workflowExecutionRequest.js'

it('retains the selected memory digest in launch requests and rejects replacement by a native update', () => {
  const saved = makeCurrentWorkflowFixture('memory-launch', 'single')
  const configuration = saved.configurations[0]!
  const execution = HarnessExecutionSchema.parse({ id: 'memory-execution', runId: saved.run.id,
    workflowNodeId: saved.version.entryNodeId, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: 1, state: 'starting',
    input: { task: 'Work' }, workingDirectory: '/work', runtimeDirectory: '/runtime', createdAt: saved.createdAt,
    memoryBoardDigest: { text: 'Saved memory', byteLength: 12, cardIds: [], omittedCount: 0 } })
  const request = workflowExecutionRequest({ execution, version: saved.version, configuration,
    workspaceId: saved.scope.workspaceId })
  expect(request.initialPrompt).toContain('Saved memory')
  expect(request.input).toEqual({ task: 'Work' })
  expect(() => assertRepeatNativeUpdate(execution, { ...execution, state: 'running',
    memoryBoardDigest: { text: 'Changed', byteLength: 7, cardIds: [], omittedCount: 0 } })).toThrow()
  expect(assertRepeatNativeUpdate(execution, { ...execution, state: 'running' })).toBe('write')
})

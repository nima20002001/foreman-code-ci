import { expect, it } from 'vitest'
import { emptyNativeProjection, projectNativeEvidence, type ProjectionBinding } from './nativeProjection.js'
import { parseNativeCheckpoint } from './nativeCheckpoint.js'

it('reads retired native checkpoints unchanged and ignores new execution observations', () => {
  const binding: ProjectionBinding = {
    key: {
      execution: { workflowNodeId: 'node', executionId: 'execution', agentId: 'agent',
        agentConfigurationVersionId: 'configuration', attempt: 1 },
      workKind: 'workflow',
      workId: 'execution',
    },
    provider: 'opencode',
    nativeSessionId: 'saved-session',
    nativeTurnId: 'saved-turn',
    connectionGeneration: '1',
    interactionId: null,
    closed: false,
  }
  const stored = emptyNativeProjection(binding)
  stored.messages.push({ id: 'saved-message', parent: 'saved-turn', conflicted: false })
  const saved = structuredClone(stored)
  expect(parseNativeCheckpoint(stored)).toEqual(saved)
  const result = projectNativeEvidence(stored, binding, {
    nativeSequence: '1', sourcePosition: '1', sourceStreamId: 'source-stream',
    connectionGeneration: '1', sourceId: 'source-event', type: 'graph.native.acknowledged',
    payload: { nativeSessionId: 'saved-session', turnId: 'saved-turn' },
  })
  expect(result.disposition).toBe('ignored')
  expect(result.state).toEqual(saved)
  expect(stored).toEqual(saved)
})

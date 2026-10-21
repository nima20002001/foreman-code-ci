import { describe, expect, it } from 'vitest'
import { graphJsonBytes } from '@foreman-code/contracts/wave25'
import { parseNativeCheckpoint } from '../src/modules/run-graph/nativeCheckpoint.js'
import {
  emptyNativeProjection, nativeProjectionActivity, projectNativeEvidence, NATIVE_PROJECTION_LIMITS,
  type NativeProjectionState, type ProjectionBinding,
} from '../src/modules/run-graph/nativeProjection.js'

const binding: ProjectionBinding = {
  key: { execution: { workflowNodeId: 'node', executionId: 'execution', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1 }, workKind: 'workflow', workId: 'execution' },
  provider: 'codex', nativeSessionId: 'session', nativeTurnId: 't'.repeat(1000),
  connectionGeneration: '1', interactionId: null, closed: false,
}

function largeCheckpoint(): NativeProjectionState {
  return {
    ...emptyNativeProjection(binding), lastNativeSequence: '128',
    operations: Array.from({ length: 128 }, (_, index) => ({
      id: `operation-${index + 1}`, messageId: null, turnId: binding.nativeTurnId,
      action: 'reading_file' as const, position: String(index + 1), nativeSequence: String(index + 1),
      sourceId: `source-${index + 1}`, stream: 'stream', generation: '1', pending: false, ended: false,
    })),
  }
}

describe('native checkpoint truncation', () => {
  it('reads an oversized checkpoint as complete JSON retaining the newest operations', () => {
    const original = largeCheckpoint()
    expect(graphJsonBytes(original)).toBeGreaterThan(NATIVE_PROJECTION_LIMITS.checkpointBytes)
    const checkpoint = parseNativeCheckpoint(original)
    expect(graphJsonBytes(checkpoint)).toBeLessThanOrEqual(NATIVE_PROJECTION_LIMITS.checkpointBytes)
    expect(checkpoint.operations.length).toBeGreaterThan(0)
    expect(checkpoint.operations.length).toBeLessThan(original.operations.length)
    expect(checkpoint.operations.map(operation => operation.nativeSequence)).toEqual(
      Array.from({ length: checkpoint.operations.length }, (_, index) => String(128 - index)),
    )
    expect(checkpoint.lastNativeSequence).toBe('128')
    expect(checkpoint.overflow).toBe(true)
    expect(nativeProjectionActivity(checkpoint, binding).status).toBe('unknown')
    expect(parseNativeCheckpoint(checkpoint)).toEqual(checkpoint)
    expect(original.operations).toHaveLength(128)
    expect(original.overflow).toBe(false)
  })

  it('truncates projected checkpoints without rejecting valid native evidence', () => {
    const original = largeCheckpoint()
    original.operations.pop()
    const result = projectNativeEvidence(original, binding, {
      type: 'item.started', nativeSequence: '129', sourcePosition: '129', sourceStreamId: 'stream',
      connectionGeneration: '1', sourceId: 'source-129', payload: {
        threadId: 'session', turnId: binding.nativeTurnId,
        item: { id: 'latest-tool', type: 'fileChange', status: 'inProgress' },
      },
    })
    expect(result.disposition).toBe('changed')
    expect(result.state.operations[0]?.nativeSequence).toBe('129')
    expect(graphJsonBytes(result.state)).toBeLessThanOrEqual(NATIVE_PROJECTION_LIMITS.checkpointBytes)
    expect(result.activity.status).toBe('unknown')
    expect(result.state.lastNativeSequence).toBe('129')
  })
})

import { describe, expect, it } from 'vitest'
import { RepeatGraphStateV3Schema } from '@foreman-code/contracts/wave25'
import { repeatEffectFactsFromState } from '../src/modules/run-graph/repeatProjectionProof.js'
import { ProjectionDatabase, projectionScope, projectionDigest } from './eng04-projection-fixture.js'

function acceptedWorkState() {
  const identity = { workflowNodeId: 'work-node', executionId: 'work-execution', agentId: 'work-agent',
    agentConfigurationVersionId: 'work-configuration', attempt: 1, occurrence: null }
  return RepeatGraphStateV3Schema.parse({ run: new ProjectionDatabase().runState(),
    nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], bindings: [],
    resolutions: [], decisions: [],
    executions: [{ identity, inputDigest: projectionDigest, workActivationId: 'work-activation',
      previousExecutionId: null, state: 'completed', resultOutcome: 'succeeded' }],
    results: [{ execution: identity, resultDigest: projectionDigest }],
  })
}

const effect = { kind: 'terminal.accept' as const, entityId: 'work-execution', digest: projectionDigest }

describe('handoff terminal publication reconstruction', () => {
  it('reconstructs the accepted activation result after recovery without a node resolution', () => {
    const state = acceptedWorkState()
    const expected = [{ type: 'repeat.result.accepted', result: state.results[0] }]
    expect(repeatEffectFactsFromState(projectionScope, state, effect)).toEqual(expected)
    expect(repeatEffectFactsFromState(projectionScope, structuredClone(state), effect)).toEqual(expected)
  })

  it('requires the matching successful result for the activation', () => {
    const state = acceptedWorkState()
    expect(() => repeatEffectFactsFromState(projectionScope, { ...state, results: [] }, effect))
      .toThrow('GRAPH_INVARIANT_VIOLATION')
    expect(() => repeatEffectFactsFromState(projectionScope, { ...state,
      executions: [{ ...state.executions[0]!, resultOutcome: 'failed' }],
    }, effect)).toThrow('GRAPH_INVARIANT_VIOLATION')
    expect(() => repeatEffectFactsFromState(projectionScope, { ...state,
      results: [{ ...state.results[0]!, execution: { ...state.results[0]!.execution, executionId: 'foreign-execution' } }],
    }, effect)).toThrow('GRAPH_INVARIANT_VIOLATION')
  })
})

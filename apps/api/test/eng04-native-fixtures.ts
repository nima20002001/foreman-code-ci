import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { RepeatWorkflowVersionV1Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { freezeRepeatEntry, makeRepeatOccurrence, type RepeatScope } from '../src/modules/runs/repeatResolution.js'

export const nativeAt = '2026-09-25T00:00:00.000Z'
export function nativeFixture() {
  const base = makeCurrentWorkflowFixture('eng04-native')
  const names = ['work', 'review', 'done', 'limit']
  const edge = (source: string, target: string) => ({ id: `${source}-${target}`, kind: 'execution' as const, source, target })
  const version = RepeatWorkflowVersionV1Schema.parse({ ...base.version, executionSemanticsVersion: 3, entryNodeId: 'work',
    agentConfigurationVersionIds: Object.fromEntries(names.map((id) => [`agent-${id}`, `config-${id}`])),
    definition: { ...base.version.definition, executionSemanticsVersion: 3, entryNodeId: 'work',
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8 },
      nodes: names.map((id) => ({ id, agentId: `agent-${id}`, name: id, ...(id === 'review' ? { choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'edge', relationshipId: 'review-done' } },
        { outcome: 'issues', target: { kind: 'edge', relationshipId: 'review-limit' } },
      ] } } : {}) })),
      edges: [edge('work', 'review'), edge('review', 'done'), edge('review', 'limit')],
      repeat: { contractVersion: 1, blocks: [{ id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review',
        maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'edge', relationshipId: 'review-limit' } }] },
    } })
  const scope: RepeatScope = { ...base.scope, executionSemanticsVersion: 3 }
  const occurrence = makeRepeatOccurrence(scope, version.definition.repeat!.blocks[0]!, freezeRepeatEntry({}, []), null).occurrence
  const ref = { nodeId: 'review', occurrence: occurrence.identity }
  const execution = HarnessExecutionSchema.parse({ id: 'native-execution-1', runId: scope.runId, workflowNodeId: 'review',
    agentId: 'agent-review', agentConfigurationVersionId: 'config-review', attempt: 1, state: 'running', input: {},
    createdAt: nativeAt, startedAt: nativeAt, workingDirectory: '/accepted/root', runtimeDirectory: '/accepted/runtime/one',
    nativeSessionId: 'native-session-one' })
  return { version, scope, occurrence, ref, execution }
}
export function nativeCompleted(value: HarnessExecution, output: unknown = {
  routing: { outcome: 'issues' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'f1' }] },
}): HarnessExecution {
  return HarnessExecutionSchema.parse({ ...value, state: 'completed', finishedAt: nativeAt, result: { outcome: 'succeeded', output } })
}
export function nativeStored(execution: HarnessExecution, f = nativeFixture()) {
  return { execution, ref: f.ref, slotId: 'fixture-slot', input: {
    executionSemanticsVersion: 3 as const, runInput: {}, occurrence: f.occurrence, entry: null, predecessors: [],
  }, inputDigest: `sha256:${'1'.repeat(64)}`, accepted: false }
}

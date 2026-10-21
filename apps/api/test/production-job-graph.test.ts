import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { buildRepeatGraph, type RepeatGraphStore } from '../src/modules/runs/repeatGraph.js'
import type { WorkflowJobNodeStore } from '../src/modules/jobs/workflowNode.js'
import type { RepeatResolution } from '../src/modules/runs/repeatResolution.js'

function fixture() {
  const f = makeCurrentWorkflowFixture('production-job-graph')
  const version = WorkflowVersionV3Schema.parse({ ...f.version, entryNodeId: 'job-node', agentConfigurationVersionIds: {}, definition: { ...f.version.definition,
    nodes: [{ kind: 'job', id: 'job-node', name: 'Build', jobDefinitionId: 'definition', jobDefinitionRevision: 1,
      jobDefinitionVersionId: 'definition-version' }], edges: [], entryNodeId: 'job-node', repeat: undefined, handoffs: undefined } })
  const forbidden = vi.fn(async () => { throw new Error('Agent/native path must not run for a Job node') })
  const store: RepeatGraphStore = { admit: forbidden, acceptTerminal: forbidden, enterBlock: forbidden,
    readOccurrence: forbidden, transition: forbidden }
  const resolution: RepeatResolution = { ref: { nodeId: 'job-node', occurrence: null }, deferredRelationshipIds: [],
    value: { workflowNodeId: 'job-node', resolution: 'succeeded', branchEnded: false, selectedRelationshipIds: [], unselectedRelationshipIds: [], resolvedAt: '2026-10-01T00:00:00.000Z', execution: { kind: 'job', workflowNodeId: 'job-node',
      executionId: 'job-execution', jobDefinitionId: 'definition', jobDefinitionVersionId: 'definition-version', attempt: 1 },
      acceptedResultDigest: `sha256:${'a'.repeat(64)}` } }
  const jobs: WorkflowJobNodeStore = { prepareJob: vi.fn(async () => ({ kind: 'resolved' as const, resolution })),
    admitPreparedJob: forbidden, observeJobState: forbidden, acceptJobTerminal: forbidden }
  return { version, store, forbidden, jobs }
}
describe('actual production graph Job dispatch with admitted-store doubles, no persistence/native proof', () => {
  it('replays the exact resolved Job identity without allocating an Agent or native session', async () => {
    const f = fixture()
    const graph = buildRepeatGraph({ ...f, runId: 'run', checkpointer: new MemorySaver(), signal: new AbortController().signal,
      driver: { candidate: () => { throw new Error('Agent candidate forbidden') }, observe: f.forbidden },
      jobs: { store: f.jobs, driver: { prepare: f.forbidden, observe: f.forbidden } } })
    const result = await graph.graph.invoke({ runId: 'run', occurrences: {}, boundaries: {}, executionIds: {} }, graph.config)
    expect(result.executionIds['job-node']).toEqual({ executionId: 'job-execution', occurrenceId: null })
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it('reports the missing Job compositor before calling Agent/native admission', async () => {
    const f = fixture()
    const graph = buildRepeatGraph({ runId: 'run', version: f.version, store: f.store, checkpointer: new MemorySaver(), signal: new AbortController().signal,
      driver: { candidate: () => { throw new Error('Agent candidate forbidden') }, observe: f.forbidden } })
    await expect(graph.graph.invoke({ runId: 'run', occurrences: {}, boundaries: {}, executionIds: {} }, graph.config)).rejects.toMatchObject({ code: 'WORKFLOW_JOB_COMPOSITION_REQUIRED' })
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})

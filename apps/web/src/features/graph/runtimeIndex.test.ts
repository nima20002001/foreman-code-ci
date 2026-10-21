import { describe, expect, it } from 'vitest'
import { graphRuntimeIndex, selectGraphNodeActivity } from './runtimeIndex'
import { makeSyntheticRun } from './fixtures/scaleData'

const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }

describe('read-only canonical runtime index', () => {
  it('memoizes an index of the original Query records, without creating another fact owner', () => {
    const response = makeSyntheticRun(300)
    const index = graphRuntimeIndex(response.liveActivity!)
    expect(graphRuntimeIndex(response.liveActivity!)).toBe(index)
    expect(index.get('synthetic-node-12')).toBe(response.liveActivity!.nodes[12])
    expect(selectGraphNodeActivity(response, scope, 'synthetic-node-12', 'synthetic-agent-12')).toBe(response.liveActivity!.nodes[12])
  })

  it('fails closed across workspace, Run, version, agent, dirty-board, and unavailable boundaries', () => {
    const response = makeSyntheticRun(1)
    const read = (override: Partial<typeof scope> & { unavailable?: boolean } = {}, agentId = 'synthetic-agent-0') =>
      selectGraphNodeActivity(response, { ...scope, ...override }, 'synthetic-node-0', agentId)
    expect(read({ workspaceId: 'other' })).toBeUndefined()
    expect(read({ workflowId: 'other' })).toBeUndefined()
    expect(read({ runId: 'other' })).toBeUndefined()
    expect(read({ workflowVersionId: 'other' })).toBeUndefined()
    expect(read({ overlayAllowed: false })).toBeUndefined()
    expect(read({ unavailable: true })).toBeUndefined()
    expect(read({}, 'other')).toBeUndefined()
    expect(selectGraphNodeActivity(response, { ...scope, workflowVersionId: undefined }, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    response.liveActivity!.workflowVersionId = 'wrong'
    expect(read()).toBeUndefined()
  })

  it('does not show stale native activity after a terminal or interrupted state', () => {
    const response = makeSyntheticRun(1)
    response.run.executionState = 'completed'
    expect(selectGraphNodeActivity(response, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    response.run.executionState = 'interrupted'
    expect(selectGraphNodeActivity(response, scope, 'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
  })
})

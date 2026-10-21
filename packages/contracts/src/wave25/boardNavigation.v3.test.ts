import { describe, expect, it } from 'vitest'
import { CanonicalRunGraphScopeSchema } from './repeatGraphMetadata.js'
import { WorkspaceBoardSearchSchema, boardSearchForRun, resolveWorkflowBoardLocation, staysOnWorkflowBoard } from './boardNavigation.js'

const scope = { workspaceId: 'ws', workflowId: 'wf', runId: 'run-history', workflowVersionId: 'version-pinned', executionSemanticsVersion: 3 as const }
const search = { workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: 3 as const }

describe('explicit v3 board navigation without widening legacy protocols', () => {
  it.each([3, '3'])('accepts complete v3 query pins (%s)', (executionSemanticsVersion) => {
    expect(resolveWorkflowBoardLocation('/workspaces/ws', { ...search, executionSemanticsVersion }).run).toEqual(scope)
  })
  it('resolves the existing deep-link route with exact decoded pins', () => {
    const location = resolveWorkflowBoardLocation('/workspaces/ws/workflows/wf/runs/run-history/graph/version-pinned/3', {})
    expect(location.run).toEqual(CanonicalRunGraphScopeSchema.parse(scope))
  })
  it.each([0, 4, '03', '4', '3.0', 'unknown'])('rejects unknown or coerced semantics (%s)', (executionSemanticsVersion) => {
    expect(WorkspaceBoardSearchSchema.safeParse({ ...search, executionSemanticsVersion }).success).toBe(false)
  })
  it('keeps the canonical graph scope pinned to current semantics', () => {
    expect(CanonicalRunGraphScopeSchema.safeParse(scope).success).toBe(true)
  })
  it('rejects partial pins, conflicting version and cross-workspace Run requests', () => {
    expect(() => resolveWorkflowBoardLocation('/workspaces/ws', { workflowId: 'wf', runId: 'run-history' })).toThrow()
    expect(() => resolveWorkflowBoardLocation('/workspaces/ws/workflows/wf/runs/run-history/graph/version-pinned/3', { ...search, workflowVersionId: 'moving-head' })).toThrow()
    expect(() => boardSearchForRun({ workspaceId: 'elsewhere', workflowId: 'wf' }, 'wf', scope)).toThrow()
    expect(() => boardSearchForRun({}, 'different-workflow', scope)).toThrow()
  })
  it('clears only Run inspection when switching back to the draft', () => {
    const selected = boardSearchForRun({ workflowId: 'wf', agentId: 'agent-selected' }, 'wf', scope)
    expect(boardSearchForRun({ ...selected, runNodeId: 'node-history' }, 'wf')).toEqual({ workflowId: 'wf', agentId: 'agent-selected' })
  })
  it('keeps the document mounted for current and past v3 Runs, not another workflow', () => {
    const current = { pathname: '/workspaces/ws', search: { ...search, runId: 'older-v3' } }
    expect(staysOnWorkflowBoard(current, { pathname: '/workspaces/ws', search })).toBe(true)
    expect(staysOnWorkflowBoard(current, { pathname: '/workspaces/ws', search: { ...search, workflowId: 'other' } })).toBe(false)
  })
})

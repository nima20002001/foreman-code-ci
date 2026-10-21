import { describe, expect, it } from 'vitest'
import { WorkspaceBoardSearchSchema, boardSearchForRun, boardSearchForInspection, resolveWorkflowBoardLocation, staysOnWorkflowBoard } from './boardNavigation.js'

const scope = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-1', workflowVersionId: 'version-1', executionSemanticsVersion: 3 as const }
const search = { workflowId: 'workflow', agentId: 'agent-1' }
const at = (value: unknown) => ({ pathname: '/workspaces/workspace', search: value })
describe('unified board URL contract', () => {
  it('retains the existing workspace selection fields', () => {
    expect(WorkspaceBoardSearchSchema.parse({ ...search, scenarioId: 'normal', conversationId: 'chat', interactionId: 'request' }))
      .toEqual({ ...search, scenarioId: 'normal', conversationId: 'chat', interactionId: 'request' })
  })
  it('selects a complete immutable Run without losing authoring selection', () => {
    const selected = boardSearchForRun(search, 'workflow', scope)
    expect(resolveWorkflowBoardLocation('/workspaces/workspace', selected).run).toEqual(scope)
    expect(selected.agentId).toBe('agent-1')
  })
  it.each(['runId', 'workflowVersionId', 'executionSemanticsVersion', 'workflowId'])('rejects partial pins missing %s', (name) => {
    const selected: Record<string, unknown> = boardSearchForRun(search, 'workflow', scope); delete selected[name]
    expect(() => WorkspaceBoardSearchSchema.parse(selected)).toThrow()
  })
  it.each([0, 1, 2, 4, '03', 'unknown'])('rejects retired or unknown semantics %s', (executionSemanticsVersion) => {
    expect(() => WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, 'workflow', scope), executionSemanticsVersion })).toThrow()
  })
  it('normalizes only the exact textual semantics tags', () => {
    expect(WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, 'workflow', scope), executionSemanticsVersion: '3' }).executionSemanticsVersion).toBe(3)
  })
  it('keeps existing URL forms on the current board', () => {
    expect(resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/draft', {}).draftAlias).toBe(true)
    expect(resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/runs/run-1/graph/version-1/3', {}).run).toEqual(scope)
  })
  it('rejects conflicting path and query pins rather than using latest', () => {
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/runs/run-1/graph/version-1/3', {
      ...boardSearchForRun(search, 'workflow', scope), workflowVersionId: 'version-2',
    })).toThrow()
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/draft', { workflowId: 'different' })).toThrow()
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace', { workspaceId: 'other' })).toThrow()
  })
  it('stores exact inspection keys in the URL and clears them for another Run', () => {
    const selected = boardSearchForInspection(search, 'workflow', scope, { runNodeId: 'node-1', runExchangeKey: 'interaction:request-1' })
    expect(resolveWorkflowBoardLocation('/workspaces/workspace', selected).search.runNodeId).toBe('node-1')
    expect(boardSearchForRun(selected, 'workflow', { ...scope, runId: 'run-2' }).runNodeId).toBeUndefined()
    expect(boardSearchForRun(selected, 'workflow').runExchangeKey).toBeUndefined()
  })
  it('rejects orphaned and contradictory inspection selection', () => {
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace', { ...search, runNodeId: 'node-1' })).toThrow()
    expect(() => WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, 'workflow', scope), runNodeId: 'node-1', runRelationshipId: 'edge-1' })).toThrow()
  })
  it('only exempts same-board Run/inspection navigation from dirty prompts', () => {
    const first = at(boardSearchForRun(search, 'workflow', scope))
    expect(staysOnWorkflowBoard(first, at(boardSearchForRun(search, 'workflow', { ...scope, runId: 'run-2' })))).toBe(true)
    expect(staysOnWorkflowBoard(first, at(boardSearchForInspection(search, 'workflow', scope, { runNodeId: 'node-1' })))).toBe(true)
    expect(staysOnWorkflowBoard(first, at({ ...search, agentId: 'agent-2' }))).toBe(false)
    expect(staysOnWorkflowBoard(first, at({ ...search, workflowId: 'other' }))).toBe(false)
    expect(staysOnWorkflowBoard(first, { pathname: '/account', search: {} })).toBe(false)
  })
  it('keeps Activities filters linkable through Run switches without leaving the draft', () => {
    const selected = WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(search, 'workflow', scope),
      activityKind: 'work_notice', activityAgentId: 'agent-2' })
    expect(boardSearchForRun(selected, 'workflow', { ...scope, runId: 'run-2' }))
      .toMatchObject({ activityKind: 'work_notice', activityAgentId: 'agent-2', runId: 'run-2' })
    expect(staysOnWorkflowBoard(at(boardSearchForRun(search, 'workflow', scope)), at(selected))).toBe(true)
  })
  it('recognizes the same board across aliases without losing a dirty editor', () => {
    expect(staysOnWorkflowBoard(at({ workflowId: 'workflow' }), {
      pathname: '/workspaces/workspace/workflows/workflow/runs/run-1/graph/version-1/3', search: {},
    })).toBe(true)
  })
  it('does not hide malformed percent encoding or unsupported paths', () => {
    expect(() => resolveWorkflowBoardLocation('/workspaces/%ZZ', {})).toThrow()
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/runs/run-1/graph/version-1/2', {})).toThrow()
  })
})

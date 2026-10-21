import { describe, expect, it } from 'vitest'
import {
  makeCurrentWorkflowFixture, WorkspaceBoardSearchSchema, boardSearchForInspection, boardSearchForRun,
  readRunInspectionKey, resolveWorkflowBoardLocation, runInspectionKey, staysOnWorkflowBoard,
} from '@foreman-code/contracts/wave25'

const { scope, identities } = makeCurrentWorkflowFixture('inspection-links')
const path = `/workspaces/${scope.workspaceId}`
const selection = { runNodeId: identities[0]!.workflowNodeId,
  runExchangeKey: runInspectionKey({ occurrenceId: 'occ-2', executionId: 'exec-attempt-3' })! }
const search = boardSearchForInspection({ workflowId: scope.workflowId }, scope.workflowId, scope, selection)

describe('same-Board execution and occurrence deep links', () => {
  it('round trips through a fresh URL parse, retaining all immutable pins', () => {
    const url = new URL(path, 'http://localhost')
    for (const [key, value] of Object.entries(search)) if (value !== undefined) url.searchParams.set(key, String(value))
    const reopened = resolveWorkflowBoardLocation(url.pathname, Object.fromEntries(url.searchParams))
    expect(reopened.run).toEqual(scope)
    expect(reopened.search.runNodeId).toBe(selection.runNodeId)
    expect(readRunInspectionKey(reopened.search.runExchangeKey)).toEqual({ occurrenceId: 'occ-2', executionId: 'exec-attempt-3' })
  })

  it('uses the same immutable selection in the retained graph and draft aliases', () => {
    const alias = `/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/${scope.runId}/graph/${scope.workflowVersionId}/3`
    expect(resolveWorkflowBoardLocation(alias, selection).run).toEqual(scope)
    expect(resolveWorkflowBoardLocation(`${path}/workflows/${scope.workflowId}/draft`, search).run).toEqual(scope)
    expect(staysOnWorkflowBoard({ pathname: path, search }, { pathname: alias, search })).toBe(true)
  })

  it('clears node, occurrence and attempt selection on a Run switch, not the workflow', () => {
    const next = boardSearchForRun(search, scope.workflowId, { ...scope, runId: 'other-run', workflowVersionId: 'older-version' })
    expect(next.workflowId).toBe(scope.workflowId)
    expect(next.runId).toBe('other-run')
    expect(next.workflowVersionId).toBe('older-version')
    expect(next).not.toHaveProperty('runNodeId')
    expect(next).not.toHaveProperty('runExchangeKey')
    expect(boardSearchForRun(search, scope.workflowId)).toEqual({ workflowId: scope.workflowId })
  })

  it('supports a node, an occurrence filter, or an exact execution independently', () => {
    for (const value of [{ occurrenceId: 'occ-2' }, { executionId: 'execution-1' }, { occurrenceId: 'occ-2', executionId: 'execution-1' }]) {
      expect(readRunInspectionKey(runInspectionKey(value))).toEqual(value)
    }
    expect(runInspectionKey({})).toBeUndefined()
    expect(readRunInspectionKey('an-existing-graph-exchange')).toEqual({})
  })

  it('rejects malformed or unpinned inspection and conflicting identities', () => {
    for (const runExchangeKey of ['inspection/-/-', 'inspection/o', 'inspection/o/e/extra', 'inspection//e']) {
      expect(() => WorkspaceBoardSearchSchema.parse({ ...search, runExchangeKey })).toThrow()
    }
    expect(() => resolveWorkflowBoardLocation(path, { workflowId: scope.workflowId, ...selection })).toThrow()
    expect(() => WorkspaceBoardSearchSchema.parse({ ...search, runRelationshipId: 'edge' })).toThrow()
    expect(() => resolveWorkflowBoardLocation(path, { ...search, workspaceId: 'elsewhere' })).toThrow()
  })

  it('never treats a historical V1 or V2 tag as a current execution mode', () => {
    for (const executionSemanticsVersion of [1, 2, '1', '2']) {
      expect(() => WorkspaceBoardSearchSchema.parse({ ...search, executionSemanticsVersion })).toThrow()
    }
  })
})

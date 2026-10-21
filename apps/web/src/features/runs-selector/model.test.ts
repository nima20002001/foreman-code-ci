import { describe, expect, it } from 'vitest'
import { createRunSelectionSource, type RunSelection } from './selectionGeneration'
import { flattenRunPages, labelRuns, nextRunsCursor, RUNS_MAX_ITEMS, RUNS_MAX_PAGES } from './presentation'
import { readRunSelection, resolveRunsSelectorBoardLocation, RunsSelectorSearchSchema, searchForSelectedRun } from './search'
import { page, runA, runB, runC, scope } from './testFixtures'

describe('Runs selector model', () => {
  it('adds shortId only for a shared local day, across page boundaries, never sorting by start', () => {
    const items = flattenRunPages([page([runB, runC]), page([runA, { ...runB, status: 'running' }])])
    expect(items.map((run) => run.runId)).toEqual(['run-b', 'run-c', 'run-a'])
    const labels = labelRuns(items)
    expect(labels.map((run) => run.showShortId)).toEqual([true, false, true])
    expect(labels[0]!.label).toContain('short-B')
    expect(labels[1]!.label).not.toContain('short-C')
    expect(labels[1]!.status).toBe('Interrupted')
  })

  it('uses local days rather than the UTC date prefix, including year', () => {
    const a = { ...runA, startedAt: '2026-09-28T01:00:00.000Z' }
    const b = { ...runB, startedAt: '2026-09-27T23:00:00.000Z' }
    expect(labelRuns([a, b], 'en-US', 'America/New_York').every((label) => label.showShortId)).toBe(true)
    expect(labelRuns([a, b], 'en-US', 'UTC').every((label) => !label.showShortId)).toBe(true)
    expect(labelRuns([a, { ...b, startedAt: '2025-09-28T01:00:00.000Z' }], 'en-US', 'UTC')
      .every((label) => !label.showShortId)).toBe(true)
  })

  it('identifies every unstarted Run without inventing a timestamp', () => {
    const rows = labelRuns([{ ...runA, startedAt: null, status: 'queued' }, { ...runB, startedAt: null, status: 'queued' }])
    expect(rows.map((row) => row.label)).toEqual(['Not started · short-A · Queued', 'Not started · short-B · Queued'])
    expect(rows.every((row) => row.showShortId)).toBe(true)
    expect(labelRuns([{ ...runC, startedAt: null }])[0]!.label).toBe('Not started · short-C · Interrupted')
  })

  it('bounds pages and rows and terminates a repeated opaque cursor', () => {
    expect(nextRunsCursor(page([], 'cursor/+?'), [page([])], undefined, [undefined])).toBe('cursor/+?')
    expect(nextRunsCursor(page([], 'cursor/+?'), [page([]), page([])], 'cursor/+?', [undefined, 'cursor/+?'])).toBeUndefined()
    expect(nextRunsCursor(page([], 'next'), Array.from({ length: RUNS_MAX_PAGES }, () => page([])), 'last', [undefined])).toBeUndefined()
    const many = Array.from({ length: RUNS_MAX_ITEMS + 1 }, (_, index) => ({ ...runA, runId: `run-${index}` }))
    expect(flattenRunPages([page(many)])).toHaveLength(RUNS_MAX_ITEMS)
  })

  it('keeps the new search param separate from frozen Board pins', () => {
    const search = RunsSelectorSearchSchema.parse({ workflowId: scope.workflowId, selectedRunId: 'run-a', agentId: 'agent-a' })
    expect(resolveRunsSelectorBoardLocation(`/workspaces/${scope.workspaceId}`, search).search)
      .toEqual({ workflowId: scope.workflowId, agentId: 'agent-a' })
    expect(searchForSelectedRun({ ...search, runId: 'old', workflowVersionId: 'old-version', executionSemanticsVersion: 3,
      runNodeId: 'old-node' }, scope, 'run-b')).toEqual({ workflowId: scope.workflowId, agentId: 'agent-a', selectedRunId: 'run-b' })
    expect(searchForSelectedRun(search, scope, null)).toEqual({ workflowId: scope.workflowId, agentId: 'agent-a' })
  })

  it('does not inherit a selected Run into another workspace/workflow or a default workflow', () => {
    expect(readRunSelection(scope, { pathname: '/workspaces/other', search: { workflowId: scope.workflowId, selectedRunId: 'run-a' } }).active).toBe(false)
    expect(readRunSelection(scope, { pathname: `/workspaces/${scope.workspaceId}`, search: { workflowId: 'other', selectedRunId: 'run-a' } }).active).toBe(false)
    expect(readRunSelection(scope, { pathname: `/workspaces/${scope.workspaceId}`, search: { selectedRunId: 'run-a' } }).invalid).toBe(true)
  })

  it('resolves saved Run inspection without inventing version pins and still rejects unselected inspection', () => {
    const pathname = `/workspaces/${scope.workspaceId}`
    const search = { workflowId: scope.workflowId, selectedRunId: 'run-a', runNodeId: 'node-saved' }
    const board = resolveRunsSelectorBoardLocation(pathname, search)
    expect(board.search).toEqual({ workflowId: scope.workflowId, runNodeId: 'node-saved' })
    expect(board.run).toBeUndefined()
    expect(() => resolveRunsSelectorBoardLocation(pathname, { workflowId: scope.workflowId, runNodeId: 'node-saved' }))
      .toThrow('Run inspection needs a complete Run selection.')
    expect(() => resolveRunsSelectorBoardLocation(pathname, { ...search, runId: 'run-a' })).toThrow()
  })

  it('reads existing pinned Run URLs as aliases and rejects conflicting selections', () => {
    const search = { workflowId: scope.workflowId, runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3 }
    expect(readRunSelection(scope, { pathname: `/workspaces/${scope.workspaceId}`, search }).identity.runId).toBe('run-a')
    expect(readRunSelection(scope, { pathname: `/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/run-a/graph/version-a/3`, search: {} }).identity.runId).toBe('run-a')
    expect(readRunSelection(scope, { pathname: `/workspaces/${scope.workspaceId}`, search: { ...search, selectedRunId: 'run-b' } }).invalid).toBe(true)
  })

  it('fences A -> B -> A without a render, and unmount, with no reliance on AbortSignal', () => {
    let value: RunSelection = { identity: { ...scope, runId: 'run-a' }, active: true, invalid: false }
    let changed = () => {}
    const source = createRunSelectionSource(() => value, (notify) => { changed = notify; return () => {} })
    const unsubscribe = source.subscribe(() => {})
    const firstA = source.getSnapshot().generation
    expect(source.isCurrent(firstA)).toBe(true)
    value = { ...value, identity: { ...scope, runId: 'run-b' } }; changed()
    const b = source.getSnapshot().generation
    value = { ...value, identity: { ...scope, runId: 'run-a' } }; changed()
    const secondA = source.getSnapshot().generation
    expect(secondA.id).not.toBe(firstA.id)
    expect(source.isCurrent(firstA)).toBe(false)
    expect(source.isCurrent(b)).toBe(false)
    expect(source.isCurrent(secondA)).toBe(true)
    expect(source.getSnapshot().generation).toBe(secondA)
    unsubscribe()
    expect(source.isCurrent(secondA)).toBe(false)
    const again = source.subscribe(() => {})
    expect(source.isCurrent(secondA)).toBe(false)
    expect(source.isCurrent(source.getSnapshot().generation)).toBe(true)
    again()
  })

  it('does not accept another source ticket or a departed/invalid URL', () => {
    let value: RunSelection = { identity: { ...scope, runId: 'run-a' }, active: true, invalid: false }
    const source = createRunSelectionSource(() => value, () => () => {})
    const other = createRunSelectionSource(() => value, () => () => {})
    const stop = source.subscribe(() => {}), stopOther = other.subscribe(() => {})
    const ticket = source.getSnapshot().generation
    expect(other.isCurrent(ticket)).toBe(false)
    value = { ...value, active: false }
    expect(source.isCurrent(ticket)).toBe(false)
    value = { ...value, active: true, invalid: true }
    expect(source.isCurrent(source.getSnapshot().generation)).toBe(false)
    stop(); stopOther()
  })
})

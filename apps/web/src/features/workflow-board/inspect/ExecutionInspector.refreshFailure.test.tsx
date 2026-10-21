import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInspectionKey, type RepeatGraphScopeV3, type RunExecutionDetail, type RunExecutionSummary, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { WorkflowBoardContext } from '../context'
import { ExecutionInspector } from './ExecutionInspector'

// Component scenario: the Run-inspection reads are stubbed at the query-hook boundary with a failed
// refresh that still holds previously loaded data. Not React Flow, authenticated, or browser evidence.
const store = vi.hoisted(() => ({ summaries: [] as unknown[], details: new Map<string, unknown>() }))
vi.mock('./queries', async (original) => {
  const failed = { error: new Error('refresh failed'), failureReason: null, isSuccess: false, failureCount: 1, dataUpdatedAt: 1,
    isError: true, isPending: false, isPaused: false, isFetching: false }
  return { ...await original<typeof import('./queries')>(),
    useExecutionPages: () => ({ ...failed, hasNextPage: true, data: { pages: [{ items: store.summaries }] } }),
    useExecutionQuery: (_scope: unknown, executionId?: string) => ({ ...failed, data: executionId ? store.details.get(executionId) : undefined, refetch: vi.fn() }),
    useBindingPages: () => ({ ...failed, hasNextPage: false, data: undefined }),
  }
})

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', workflowVersionId: 'workflow-version-a' } as RepeatGraphScopeV3
const version = { id: scope.workflowVersionId, agentConfigurationVersionIds: { 'agent-1': 'configuration-1' },
  definition: { nodes: [{ id: 'review', name: 'Review', agentId: 'agent-1' }], edges: [] } } as unknown as WorkflowVersionV3
const summary = { workflowNodeId: 'review', agentId: 'agent-1', agentConfigurationVersionId: 'configuration-1', executionId: 'exec-a',
  attempt: 1, state: 'completed', createdAt: '2026-10-01T00:00:00.000Z', acceptedResultAvailable: false } as unknown as RunExecutionSummary

function tree(selected: boolean) {
  const board = { workspaceId: scope.workspaceId, workflowId: scope.workflowId, run: scope, activeRuns: 0,
    inspection: { runNodeId: 'review', ...(selected ? { runExchangeKey: runInspectionKey({ executionId: 'exec-a' }) } : {}) },
    selectInspection: vi.fn(), selectRun: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }
  return <QueryClientProvider client={new QueryClient()}><WorkflowBoardContext.Provider value={board}>
    <ExecutionInspector scope={scope} version={version} /></WorkflowBoardContext.Provider></QueryClientProvider>
}
afterEach(() => { cleanup(); store.summaries = []; store.details.clear() })

describe('ExecutionInspector after a failed refresh', () => {
  it('keeps the previously loaded executions listed and offers a retry', () => {
    store.summaries = [summary]
    render(tree(false))
    expect(screen.getByRole('button', { name: /exec-a/ })).toBeInTheDocument()
    expect(screen.getByText('Execution history could not be refreshed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry executions' })).toBeInTheDocument()
  })

  it('keeps a previously loaded exact execution visible', () => {
    store.summaries = [summary]
    store.details.set('exec-a', { run: scope, execution: summary, acceptedResult: { status: 'not_accepted' },
      acceptedInput: { digest: `sha256:${'1'.repeat(64)}`, value: { executionSemanticsVersion: 3, runInput: null, occurrence: null, entry: null, predecessors: [] } } } as unknown as RunExecutionDetail)
    render(tree(true))
    expect(screen.getByLabelText('Execution exec-a')).toBeInTheDocument()
    expect(screen.queryByText('This exact execution is unavailable.')).toBeNull()
  })
})

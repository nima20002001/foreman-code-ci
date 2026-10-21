import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobWorkflowExecutionReference } from '@foreman-code/contracts/job-workflow'
import { runInspectionKey, type RepeatGraphScopeV3, type RunExecutionDetail, type RunExecutionSummary, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { server } from '../../../mocks/server'
import { definition, execution as jobFixture } from '../../jobs/fixtures'
import { WorkflowBoardContext } from '../context'
import { ExecutionInspector } from './ExecutionInspector'

// Component scenario with MSW for the Jobs API. The Run-inspection reads are stubbed at the query-hook
// boundary; this is not React Flow, authenticated, or browser evidence.
const store = vi.hoisted(() => ({ summaries: new Map<string, unknown>(), details: new Map<string, unknown>() }))
vi.mock('./queries', async (original) => {
  const ok = { error: null, failureReason: null, isSuccess: true, failureCount: 0, dataUpdatedAt: 1, isError: false, isPending: false, isPaused: false, isFetching: false }
  return { ...await original<typeof import('./queries')>(),
    useExecutionPages: () => ({ ...ok, hasNextPage: false, data: { pages: [{ items: [...store.summaries.values()] }] } }),
    useExecutionQuery: (_scope: unknown, executionId?: string) => ({ ...ok, data: executionId ? store.details.get(executionId) : undefined, refetch: vi.fn() }),
    useBindingPages: () => ({ ...ok, hasNextPage: false, data: undefined }),
  }
})

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', workflowVersionId: 'workflow-version-a' } as RepeatGraphScopeV3
const jobNode = { kind: 'job', id: 'build', name: 'Build', jobDefinitionId: definition.id, jobDefinitionRevision: 1, jobDefinitionVersionId: definition.versionId }
const agentNode = { id: 'review', name: 'Review', agentId: 'agent-1' }
const version = { id: scope.workflowVersionId, agentConfigurationVersionIds: { 'agent-1': 'configuration-1' },
  definition: { nodes: [jobNode, agentNode], edges: [] } } as unknown as WorkflowVersionV3
const mapping = '*/api/management/workspaces/:workspaceId/jobs/workflow-executions/:runId/:nodeExecutionId'
const jobs = '*/api/management/workspaces/:workspaceId/jobs/executions/:id'

function install(nodeExecutionId: string, kind: 'job' | 'agent' = 'job') {
  const identity = kind === 'job'
    ? { kind: 'job', workflowNodeId: 'build', jobDefinitionId: definition.id, jobDefinitionVersionId: definition.versionId }
    : { workflowNodeId: 'review', agentId: 'agent-1', agentConfigurationVersionId: 'configuration-1' }
  const summary = { ...identity, executionId: nodeExecutionId, attempt: 1, state: 'completed', createdAt: jobFixture.createdAt, acceptedResultAvailable: false } as unknown as RunExecutionSummary
  store.summaries.set(nodeExecutionId, summary)
  store.details.set(nodeExecutionId, { run: scope, execution: summary, acceptedResult: { status: 'not_accepted' },
    acceptedInput: { digest: `sha256:${'1'.repeat(64)}`, value: { executionSemanticsVersion: 3, runInput: null, occurrence: null, entry: null, predecessors: [] } } } as unknown as RunExecutionDetail)
}
const mapped = (nodeExecutionId: string, jobExecutionId: string): JobWorkflowExecutionReference => ({ kind: 'job', ...scope, nodeId: 'build',
  nodeExecutionId, jobExecutionId, occurrenceId: null, occurrenceIndex: 0 })
const jobFor = (nodeExecutionId: string, id: string) => ({ ...jobFixture, id, workflow: { workflowId: scope.workflowId, runId: scope.runId, nodeId: 'build', nodeExecutionId } })
function jobApi(options: {
  mappings: Record<string, JobWorkflowExecutionReference>
  gate?: Record<string, Promise<void>>
  requested?: string[]
  mappingStarted?: string[]
  mappingCompleted?: string[]
}) {
  server.use(
    http.get(mapping, async ({ params }) => {
      const id = String(params.nodeExecutionId)
      options.mappingStarted?.push(id)
      await options.gate?.[id]
      options.mappingCompleted?.push(id)
      return HttpResponse.json({ reference: options.mappings[id] })
    }),
    http.get(jobs, ({ params }) => {
      const id = String(params.id), nodeExecutionId = Object.values(options.mappings).find((item) => item.jobExecutionId === id)!.nodeExecutionId
      options.requested?.push(id)
      return HttpResponse.json({ execution: jobFor(nodeExecutionId, id) })
    }),
    http.get(`${jobs}/logs`, () => HttpResponse.json({ chunks: [], nextCursor: 0, truncated: false, gap: null })),
    http.get(`${jobs}/artifacts`, () => HttpResponse.json({ artifacts: [] })))
}
function tree(executionId: string, client: QueryClient) {
  const board = { workspaceId: scope.workspaceId, workflowId: scope.workflowId, run: scope, activeRuns: 0,
    inspection: { runNodeId: executionId === 'agent-exec' ? 'review' : 'build', runExchangeKey: runInspectionKey({ executionId }) },
    selectInspection: vi.fn(), selectRun: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }
  return <QueryClientProvider client={client}><WorkflowBoardContext.Provider value={board}>
    <ExecutionInspector scope={scope} version={version} /></WorkflowBoardContext.Provider></QueryClientProvider>
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
afterEach(() => { cleanup(); store.summaries.clear(); store.details.clear() })

describe('ExecutionInspector exact selected job execution', () => {
  it('shows the JobExecution behind a distinct node execution ID and never reads the node execution ID as a job', async () => {
    install('node-exec-a')
    const requested: string[] = []
    jobApi({ mappings: { 'node-exec-a': mapped('node-exec-a', 'job-exec-a') }, requested })
    render(tree('node-exec-a', client()))
    const section = await screen.findByRole('region', { name: 'Job result for execution node-exec-a' })
    expect(await screen.findByText('job-exec-a')).toBeInTheDocument()
    expect(section).toHaveTextContent('node-exec-a')
    expect(requested).toEqual(['job-exec-a'])
  })

  it('does not leak an old selection that resolves after another execution is selected', async () => {
    install('node-exec-a'); install('node-exec-b')
    let release!: () => void
    const late = new Promise<void>((resolve) => { release = resolve })
    const mappingStarted: string[] = []
    const mappingCompleted: string[] = []
    jobApi({ mappings: { 'node-exec-a': mapped('node-exec-a', 'job-exec-a'),
      'node-exec-b': mapped('node-exec-b', 'job-exec-b') }, gate: { 'node-exec-a': late },
      mappingStarted, mappingCompleted })
    const cache = client()
    const view = render(tree('node-exec-a', cache))
    expect(await screen.findByText(/Reading the job accepted for this exact Run execution/)).toBeInTheDocument()
    await waitFor(() => expect(mappingStarted).toContain('node-exec-a'))
    view.rerender(tree('node-exec-b', cache))
    expect(await screen.findByText('job-exec-b')).toBeInTheDocument()
    await act(async () => {
      release()
      await waitFor(() => expect(mappingCompleted).toContain('node-exec-a'))
    })
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(screen.queryByText('job-exec-a')).toBeNull()
    expect(screen.getByText('job-exec-b')).toBeInTheDocument()
  })

  it('refuses a mapping that names another node execution and shows no job result', async () => {
    install('node-exec-a')
    jobApi({ mappings: { 'node-exec-a': mapped('node-exec-other', 'job-exec-a') } })
    render(tree('node-exec-a', client()))
    expect(await screen.findByText('Run job result unavailable')).toBeInTheDocument()
    expect(screen.queryByText('job-exec-a')).toBeNull()
  })

  it('keeps Agent execution inspection unchanged: no job lookup is made', async () => {
    install('agent-exec', 'agent')
    const asked = vi.fn()
    server.use(http.get(mapping, () => { asked(); return HttpResponse.json({}, { status: 500 }) }))
    render(tree('agent-exec', client()))
    expect(await screen.findByLabelText('Execution agent-exec')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /Job result for execution/ })).toBeNull()
    expect(asked).not.toHaveBeenCalled()
  })
})

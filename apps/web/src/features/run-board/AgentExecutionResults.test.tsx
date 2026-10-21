import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import type { RunExecutionSummary, RepeatGraphScopeV3, RunExecutionDetail } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { autoQueueTicket, execution as job, definition, logPage } from '../jobs/fixtures'
import { AgentExecutionResults } from './AgentExecutionResults'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 }
const selection = { identity: scope, generation: { id: 1 }, active: true, invalid: false,
  isCurrent: () => true } as unknown as SelectedRunState
const execution: Exclude<RunExecutionSummary, { kind: 'job' }> = {
  workflowNodeId: 'coder', agentId: 'agent-a', agentConfigurationVersionId: 'configuration-a',
  executionId: 'agent-execution', attempt: 1, state: 'running', createdAt: job.createdAt,
  acceptedResultAvailable: false,
}
const initiatingAgent = { workflowId: scope.workflowId, runId: scope.runId,
  agentId: execution.agentId, executionId: execution.executionId }
const jobsRoot = '*/api/management/workspaces/:workspaceId/jobs/executions/:executionId'
function responses(origin = initiatingAgent, state: 'accepted' | 'terminal' = 'accepted') {
  const ticket = { ...autoQueueTicket, initiatingAgent, state,
    terminalReason: state === 'terminal' ? 'completed' : null,
    finishedAt: state === 'terminal' ? job.createdAt : null, executionId: job.id,
    reservationId: autoQueueTicket.id, selectedComputer: { target: definition.spec.target,
      rootId: '11111111-1111-4111-8111-111111111111', bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }
  let filter: string | null = null
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', ({ request }) => {
    filter = new URL(request.url).searchParams.get('initiatingExecutionId')
    return HttpResponse.json({ tickets: [ticket], nextHistoryCursor: null })
  }), http.get(jobsRoot, () => HttpResponse.json({ execution: { ...job, workflow: null, initiatingAgent: origin } })),
  http.get(`${jobsRoot}/logs`, () => HttpResponse.json(logPage)),
  http.get(`${jobsRoot}/artifacts`, () => HttpResponse.json({ artifacts: [] })),
  http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:nodeId', () =>
    HttpResponse.json({ kind: 'unavailable', target: { workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId, workflowNodeId: execution.workflowNodeId }, reason: 'execution_missing' })))
  return () => filter
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}>
    <AgentExecutionResults scope={scope} selection={selection} execution={execution} name="Coder"
      acceptedResult={{ status: 'not_accepted' }} />
  </QueryClientProvider>)
  return { ...view, client }
}
async function openResult() {
  fireEvent.click(await screen.findByRole('button', { name: 'View result' }))
}
it.each(['accepted', 'terminal'] as const)(
  'shows %s CI results, logs, artifacts and parent Run using separate Agent provenance', async state => {
  const filter = responses(initiatingAgent, state)
  const { client, unmount } = mount()
  try {
    await openResult()
    expect(await screen.findByText('Process: build failed')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Job logs' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Job artifacts' })).toBeInTheDocument()
    expect(screen.getByText('Initiating Run / Agent / execution')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'run-a' })).toHaveAttribute('href',
      '/workspaces/workspace-a?workflowId=workflow-a&selectedRunId=run-a')
    expect(screen.queryByRole('button', { name: /Request cancellation|Review rerun/ })).toBeNull()
    expect(filter()).toBe(execution.executionId)
  } finally { unmount(); client.clear() }
})
it('withholds a job result that belongs to another initiating Agent execution', async () => {
  responses({ ...initiatingAgent, executionId: 'foreign-execution' })
  const { client, unmount } = mount()
  try {
    await openResult()
    await screen.findByText('CI origin mismatch')
    expect(screen.queryByText('Process: build failed')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Job logs' })).toBeNull()
  } finally { unmount(); client.clear() }
})
it('keeps accepted execution output and artifacts separate from later follow-up messages', async () => {
  responses()
  let chatReads = 0
  server.use(http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:nodeId', () => {
    chatReads++
    return HttpResponse.json({ messages: [{ content: 'Later follow-up answer' }] })
  }))
  const acceptedResult: RunExecutionDetail['acceptedResult'] = { status: 'accepted',
    digest: `sha256:${'a'.repeat(64)}`, value: { outcome: 'succeeded', output: {
      text: 'Original execution answer', artifacts: [{ name: 'Original artifact', digest: 'original-artifact' }],
    } } }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const content = <QueryClientProvider client={client}>
    <AgentExecutionResults scope={scope} selection={selection} execution={execution} name="Coder"
      acceptedResult={acceptedResult} />
  </QueryClientProvider>
  const view = render(content)
  try {
    const output = screen.getByRole('region', { name: 'Agent output and artifacts' })
    expect(output).toHaveTextContent('Original execution answer')
    expect(output).toHaveTextContent('Original artifact')
    expect(screen.queryByText('Follow-up messages appear in Agent chat. They do not change this execution’s output.')).not.toBeInTheDocument()
    await userEvent.hover(within(output).getByRole('button', { name: 'About Agent output' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Follow-up messages appear in Agent chat. They do not change this execution’s output.')
    await screen.findByRole('button', { name: 'View result' })
    view.rerender(content)
    await act(async () => { await client.invalidateQueries({ queryKey: ['agent-chat'] }) })
    expect(output).toHaveTextContent('Original execution answer')
    expect(output).not.toHaveTextContent('Later follow-up answer')
    expect(chatReads).toBe(0)
  } finally { view.unmount(); client.clear() }
})
it('withdraws cached CI results when an authenticated queue refresh is denied', async () => {
  responses()
  const { client, unmount } = mount()
  try {
    await openResult()
    await screen.findByText('Process: build failed')
    server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () =>
      HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })))
    await client.refetchQueries({ queryKey: ['saved-run-inspection'] })
    await waitFor(() => expect(screen.queryByText('Process: build failed')).toBeNull())
    expect(screen.getByText(/CI history unavailable/)).toBeInTheDocument()
  } finally { unmount(); client.clear() }
})

function terminalTicket(index: number): JobQueueTicket {
  return { ...autoQueueTicket, id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    initiatingAgent, enqueueSequence: String(index), state: 'terminal', terminalReason: 'completed',
    finishedAt: job.finishedAt, executionId: `job-${index}`, reservationId: autoQueueTicket.id,
    definition: { ...autoQueueTicket.definition, name: `CI checks ${index}` },
    selectedComputer: { target: definition.spec.target, rootId: autoQueueTicket.id,
      bindingRevision: 1, profileId: 'profile', profileRevision: 1 } }
}

it('reads full CI results only when opened while the request history keeps refreshing', async () => {
  responses()
  const tickets = Array.from({ length: 100 }, (_, index) => terminalTicket(index + 1))
  const reads = { queue: 0, execution: 0, artifacts: 0, logs: 0 }
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () => {
    reads.queue += 1
    return HttpResponse.json({ tickets, nextHistoryCursor: null })
  }), http.get(jobsRoot, ({ params }) => {
    reads.execution += 1
    return HttpResponse.json({ execution: { ...job, id: params.executionId, workflow: null, initiatingAgent } })
  }), http.get(`${jobsRoot}/artifacts`, () => {
    reads.artifacts += 1
    return HttpResponse.json({ artifacts: [] })
  }), http.get(`${jobsRoot}/logs`, ({ params }) => {
    reads.logs += 1
    return HttpResponse.json({ ...logPage,
      chunks: logPage.chunks.map(chunk => ({ ...chunk, executionId: params.executionId })) })
  }))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const { client, unmount } = mount()
  try {
    const first = await screen.findByRole('region', { name: `CI request ${tickets[0]!.id}` })
    expect(reads).toEqual({ queue: 1, execution: 0, artifacts: 0, logs: 0 })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    await waitFor(() => expect(reads.queue).toBeGreaterThan(1))
    expect(reads.execution + reads.artifacts + reads.logs).toBe(0)
    fireEvent.click(within(first).getByRole('button', { name: 'View result' }))
    await screen.findByText('Process: build failed')
    await screen.findByText(/build failed <script>/)
    expect(reads.execution).toBe(1)
    expect(reads.artifacts).toBe(1)
    expect(reads.logs).toBe(1)
    fireEvent.click(within(first).getByRole('button', { name: 'Hide result' }))
    const closedReads = { ...reads }
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    await waitFor(() => expect(reads.queue).toBeGreaterThan(closedReads.queue))
    expect(reads.execution).toBe(closedReads.execution)
    expect(reads.artifacts).toBe(closedReads.artifacts)
    expect(reads.logs).toBe(closedReads.logs)
  } finally {
    unmount()
    client.clear()
    vi.useRealTimers()
  }
})

it('returns to newest CI history after the sixth page removes its initial cursor', async () => {
  responses()
  const newest = terminalTicket(7)
  const active: JobQueueTicket = { ...newest, state: 'accepted', terminalReason: null, finishedAt: null }
  let completed = false
  const cursors: (string | null)[] = []
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('historyBeforeSequence')
    cursors.push(cursor)
    const index = cursor ? Number(cursor) - 1 : 6
    const activeTickets = completed ? [] : [active]
    return HttpResponse.json({ tickets: cursor ? [...activeTickets, terminalTicket(index)]
      : [completed ? newest : active, terminalTicket(6)],
      nextHistoryCursor: index > 1 ? String(index) : null })
  }))
  const { client, unmount } = mount()
  try {
    await screen.findByRole('region', { name: `CI request ${newest.id}` })
    for (let index = 5; index >= 1; index -= 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Load older CI requests' }))
      await screen.findByRole('region', { name: `CI request ${terminalTicket(index).id}` })
    }
    completed = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh CI requests' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: `CI request ${newest.id}` })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Newest CI requests' }))
    expect(await screen.findByRole('region', { name: `CI request ${newest.id}` })).toBeInTheDocument()
    expect(cursors.at(-1)).toBeNull()
    expect(screen.queryByRole('region', { name: `CI request ${terminalTicket(1).id}` })).toBeNull()
  } finally { unmount(); client.clear() }
})

it('refreshes publication for an opened CI result', async () => {
  responses()
  let publication: typeof job.publication = 'collecting'
  server.use(http.get(jobsRoot, () => HttpResponse.json({ execution: {
    ...job, workflow: null, initiatingAgent, publication,
    process: { ...job.process, outcome: 'succeeded', exitCode: 0 },
  } })))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const { client, unmount } = mount()
  try {
    await openResult()
    await screen.findByText('Artifacts: collecting')
    publication = 'complete'
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(await screen.findByText('Artifacts: complete')).toBeInTheDocument()
  } finally {
    unmount()
    client.clear()
    vi.useRealTimers()
  }
})

it('visibly identifies each pending CI request through its prelaunch terminal transition', async () => {
  responses()
  let tickets: JobQueueTicket[] = [1, 2].map(index => ({ ...autoQueueTicket,
    id: terminalTicket(index).id, initiatingAgent, enqueueSequence: String(index),
    definition: { ...autoQueueTicket.definition, name: index === 1 ? 'Unit checks' : 'Integration checks' } }))
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/queue', () =>
    HttpResponse.json({ tickets, nextHistoryCursor: null })))
  const { client, unmount } = mount()
  try {
    for (const ticket of tickets) {
      const region = await screen.findByRole('region', { name: `CI request ${ticket.id}` })
      expect(within(region).getByText(ticket.definition.name)).toBeVisible()
      expect(within(region).getByText(ticket.id)).toBeVisible()
    }
    tickets = tickets.map(ticket => ({ ...ticket, state: 'terminal', terminalReason: 'timed_out',
      finishedAt: ticket.deadlineAt, waitingReasons: [], queuePosition: null }))
    await client.refetchQueries({ queryKey: ['saved-run-inspection'] })
    for (const ticket of tickets) {
      const region = screen.getByRole('region', { name: `CI request ${ticket.id}` })
      expect(within(region).getByText(ticket.definition.name)).toBeVisible()
      expect(within(region).getByText(ticket.id)).toBeVisible()
      expect(await within(region).findByText('timed out')).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'View result' })).toBeNull()
  } finally { unmount(); client.clear() }
})

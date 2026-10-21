// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures, HierarchyReportSchema } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { HierarchyReportHistory } from './HierarchyReportHistory'

const fixture = collaborationContractFixtures
const agent = { ...fixture.agent, workflowNodeId: 'team', agentId: 'agent-team',
  displayName: 'Team', productRole: 'orchestrator' as const }
const scope = { workspaceId: agent.workspaceId, workflowId: agent.workflowId, runId: fixture.execution.runId }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

function report(round: number) {
  return HierarchyReportSchema.parse({ id: `report-${round}`, agent,
    execution: { ...fixture.execution, executionId: `execution-${round}`, attempt: round },
    parentNodeId: 'master', parentRequestId: `request-${round}`, state: 'returned',
    summary: `Summary for round ${round}`, cardIds: [], sourceEventKey: `event-${round}`,
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, round)).toISOString(),
  })
}

it('continues the refreshed cursor chain as the 20-window cache evicts older windows', async () => {
  const reads: (string | null)[] = []
  let refreshed = false
  server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/hierarchy/reports', ({ request }) => {
    const query = new URL(request.url).searchParams
    expect(query.get('workflowNodeId')).toBe(agent.workflowNodeId)
    expect(query.get('limit')).toBe('20')
    const cursor = query.get('cursor')
    reads.push(cursor)
    const chain = cursor?.split('-')[0] ?? (refreshed ? 'recent' : 'older')
    const round = cursor ? Number(cursor.split('-')[1]) : refreshed ? 50 : 20
    const nextCursor = round > 1 ? `${chain}-${round - 1}` : null
    return HttpResponse.json({ ...scope, workflowVersionId: fixture.execution.workflowVersionId,
      items: [report(round)], nextCursor, hasMore: nextCursor !== null, revision: refreshed ? 50 : 20 })
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(cache)
  const showExecution = vi.fn()
  render(<QueryClientProvider client={cache}>
    <HierarchyReportHistory scope={scope} agent={agent} close={vi.fn()} showExecution={showExecution} />
  </QueryClientProvider>)
  const dialog = within(await screen.findByRole('dialog', { name: 'Team · Report history' }))
  const rounds = within(dialog.getByRole('list', { name: 'Report rounds' }))
  await rounds.findByText('Summary for round 20')
  for (let round = 19; round >= 1; round--) {
    fireEvent.click(dialog.getByRole('button', { name: 'Load earlier reports' }))
    await rounds.findByText(`Summary for round ${round}`)
  }
  expect(rounds.getAllByRole('listitem')).toHaveLength(20)
  expect(reads).toEqual([null, ...Array.from({ length: 19 }, (_, index) => `older-${19 - index}`)])
  fireEvent.click(rounds.getByRole('button', { name: /request-10 ·/ }))
  expect(dialog.getByRole('region', { name: 'Selected immutable report' })).toHaveTextContent('Summary for round 10')

  refreshed = true
  fireEvent.click(dialog.getByRole('button', { name: 'Refresh reports' }))
  await rounds.findByText('Summary for round 50')
  expect(rounds.getAllByRole('listitem')).toHaveLength(20)
  for (let round = 49; round >= 29; round--) {
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Load earlier reports' })).toBeEnabled())
    fireEvent.click(dialog.getByRole('button', { name: 'Load earlier reports' }))
    await rounds.findByText(`Summary for round ${round}`)
    expect(rounds.getAllByRole('listitem')).toHaveLength(20)
    expect(reads.at(-1)).toBe(`recent-${round}`)
  }
  expect(reads.slice(20)).toEqual([null, ...Array.from({ length: 21 }, (_, index) => `recent-${49 - index}`)])
  expect(rounds.queryByText('Summary for round 50')).not.toBeInTheDocument()
  expect(dialog.getByRole('region', { name: 'Selected immutable report' })).toHaveTextContent('Summary for round 10')
  fireEvent.click(dialog.getByRole('button', { name: 'Show execution' }))
  expect(showExecution).toHaveBeenCalledExactlyOnceWith(report(10))
}, 30000)

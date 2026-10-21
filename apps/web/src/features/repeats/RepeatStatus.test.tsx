import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { RepeatRunReadbackSchema } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { boardV3Fixture } from '../workflow-board/v3Fixture.testSupport'
import { RepeatStatus } from './RepeatStatus'
import { repeatCurrentPath } from './canonicalClient'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; onlineManager.setOnline(true) })
const path = (fixture: ReturnType<typeof boardV3Fixture>) => repeatCurrentPath(fixture.scope).split('?')[0]!
function mount(fixture: ReturnType<typeof boardV3Fixture>, live = false) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(query)
  return { query, ...render(<QueryClientProvider client={query}><RepeatStatus scope={fixture.scope} live={live} /></QueryClientProvider>) }
}

describe('canonical repeat status in the existing selected Run context', () => {
  it.each(['early_exit', 'limit_exit'] as const)('shows durable %s and technical attempts without following workflow head', async (reason) => {
    const fixture = boardV3Fixture(reason)
    let headReads = 0
    server.use(http.get(path(fixture), () => HttpResponse.json(fixture.current)),
      http.get(`/api/management/workspaces/${fixture.scope.workspaceId}/workflows/${fixture.scope.workflowId}`, () => {
        headReads++; return HttpResponse.json({})
      }))
    mount(fixture)
    expect(await screen.findByRole('region', { name: 'Repeat occurrences' })).toBeInTheDocument()
    expect(screen.getByText('Historical Run')).toBeInTheDocument()
    expect(screen.getByText('review · business occurrence 1 of 1')).toBeInTheDocument()
    expect(screen.getByText(reason === 'early_exit' ? 'Early exit' : 'Limit exit')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Technical attempts for review occurrence 1' })).toHaveTextContent('technical attempt 4')
    expect(screen.getByText(fixture.scope.workflowVersionId)).toBeInTheDocument()
    expect(headReads).toBe(0)
  })
  it('does not turn a repeat decision into activation of its successor', async () => {
    const fixture = boardV3Fixture('repeat')
    server.use(http.get(path(fixture), () => HttpResponse.json(fixture.current)))
    mount(fixture)
    expect(await screen.findByText('Repeat decided')).toBeInTheDocument()
    expect(screen.getByText(/A decision alone is not evidence of activation/)).toBeInTheDocument()
    expect(screen.queryByText('review · business occurrence 2 of 2')).not.toBeInTheDocument()
  })
  it('hides earlier facts on an unqualified or denied refresh instead of presenting success', async () => {
    const fixture = boardV3Fixture(), user = userEvent.setup()
    server.use(http.get(path(fixture), () => HttpResponse.json(fixture.current)))
    mount(fixture)
    await screen.findByText('Limit exit')
    server.use(http.get(path(fixture), () => HttpResponse.json({ error: { code: 'GRAPH_PUBLICATION_UNAVAILABLE', message: 'not qualified' } }, { status: 409 })))
    await user.click(screen.getByRole('button', { name: 'Refresh repeat state' }))
    expect(await screen.findByRole('alert', { name: 'Repeat state unavailable' })).toHaveTextContent('unavailable')
    expect(screen.queryByText('Limit exit')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Read accepted results' })).not.toBeInTheDocument()
  })
  it('refetches the exact selected pins on reconnect', async () => {
    const fixture = boardV3Fixture()
    const requests: string[] = []
    server.use(http.get(path(fixture), ({ request }) => { requests.push(request.url); return HttpResponse.json(fixture.current) }))
    mount(fixture)
    await screen.findByText('Limit exit')
    act(() => onlineManager.setOnline(false)); act(() => onlineManager.setOnline(true))
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(2))
    expect(requests.every((url) => new URL(url).searchParams.get('workflowVersionId') === fixture.scope.workflowVersionId)).toBe(true)
  })
  it('never replaces a newer selection with a late old-Run response', async () => {
    const old = boardV3Fixture('limit_exit', 'run-old', 'version-old'), next = boardV3Fixture('early_exit', 'run-new', 'version-new')
    let release: (() => void) | undefined
    const delayed = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get(path(old), async () => { await delayed; return HttpResponse.json(old.current) }),
      http.get(path(next), () => HttpResponse.json(next.current)))
    const view = mount(old)
    view.rerender(<QueryClientProvider client={view.query}><RepeatStatus scope={next.scope} live={false} /></QueryClientProvider>)
    expect(await screen.findByText('version-new')).toBeInTheDocument()
    await act(async () => { release!(); await Promise.resolve() })
    expect(screen.queryByText('version-old')).not.toBeInTheDocument()
  })
  it('reads private deliverables only on demand and matches the canonical accepted decision', async () => {
    const fixture = boardV3Fixture(), user = userEvent.setup()
    let detailReads = 0
    const details = RepeatRunReadbackSchema.parse({ contractVersion: 1, workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      runId: fixture.scope.runId, executionSemanticsVersion: 3,
      items: [{ occurrence: fixture.occurrence, decision: { ...fixture.decision,
        resultData: { latestDeliverable: 'accepted-deliverable', remainingFindings: ['remaining-finding'] } } }], pageInfo: { nextCursor: null },
    })
    // The occurrence-detail envelope has Run identity, not a version field.
    server.use(http.get(path(fixture), () => HttpResponse.json(fixture.current)),
      http.get(`/api/management/workspaces/${fixture.scope.workspaceId}/workflows/${fixture.scope.workflowId}/runs/${fixture.scope.runId}/repeats`, () => {
        detailReads++; return HttpResponse.json(details)
      }))
    mount(fixture)
    await screen.findByText('Limit exit')
    expect(detailReads).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Read accepted results' }))
    expect(await screen.findByText('accepted-deliverable')).toBeInTheDocument()
    expect(screen.getByText('remaining-finding')).toBeInTheDocument()
    expect(detailReads).toBe(1)
  })
})

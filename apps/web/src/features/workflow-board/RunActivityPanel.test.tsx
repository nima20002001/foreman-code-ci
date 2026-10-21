import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowRunSummarySchema, type WorkflowRunSummary } from '@foreman-code/contracts'
import { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { WorkflowBoardContext } from './context'
import { boardRunListKey } from './keys'
import { RunActivityPanel } from './RunActivityPanel'
import { deferred } from '../../test/deferred'

const fixture = currentWorkflowFixture('activity-list')
const { workspaceId, workflowId } = fixture.scope
const listRoute = `*/api/management/workspaces/${workspaceId}/runs`
const clients: QueryClient[] = []
const completedRun = WorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'completed', outcome: 'succeeded',
  startedAt: fixture.createdAt, finishedAt: '2026-10-04T10:00:00.000Z', result: { outcome: 'succeeded', output: {} } })

function summary(run: typeof fixture.run): WorkflowRunSummary {
  return WorkflowRunSummarySchema.parse({ id: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
    executionCondition: run.executionCondition, executionState: run.executionState, outcome: run.outcome,
    startedAt: run.startedAt, finishedAt: run.finishedAt, authRequired: false, browserWait: null,
    runnerHealth: { status: 'healthy' }, cleanupPending: false })
}

function mount(summaries: readonly WorkflowRunSummary[] = [], existingClient?: QueryClient) {
  const client = existingClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (!clients.includes(client)) clients.push(client)
  const selectRun = vi.fn()
  const view = (items: readonly WorkflowRunSummary[]) => <QueryClientProvider client={client}>
    <WorkflowBoardContext.Provider value={{ workspaceId, workflowId, inspection: {}, activeRuns: 0, selectRun,
      selectInspection: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }}>
      <RunActivityPanel summaries={items} />
    </WorkflowBoardContext.Provider>
  </QueryClientProvider>
  const rendered = render(view(summaries))
  return { client, selectRun, unmount: rendered.unmount,
    update: (items: readonly WorkflowRunSummary[]) => rendered.rerender(view(items)) }
}

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

describe('Run activity list summary freshness', () => {
  it('reads the initial page for a completed summary after six pages evict the newest page', async () => {
    const cursors: Array<string | null> = []
    let arrived = false
    server.use(http.get(listRoute, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      const index = cursor ? Number(cursor.split('-')[1]) : 0
      const older = { ...completedRun, id: `historical-run-${index}` }
      return HttpResponse.json({ items: arrived && !cursor ? [completedRun, older] : [older],
        pageInfo: { nextCursor: index < 6 ? `older-${index + 1}` : null } })
    }))
    const mounted = mount()
    await screen.findByRole('button', { name: 'Open Run historical-run-0 · completed · succeeded' })
    for (let index = 1; index <= 5; index++) {
      await userEvent.click(screen.getByRole('button', { name: 'Load more Runs' }))
      await screen.findByRole('button', { name: `Open Run historical-run-${index} · completed · succeeded` })
    }
    expect(screen.queryByRole('button', { name: 'Open Run historical-run-0 · completed · succeeded' })).toBeNull()
    expect(cursors).toEqual([null, 'older-1', 'older-2', 'older-3', 'older-4', 'older-5'])
    arrived = true
    mounted.update([summary(completedRun)])
    await screen.findByRole('button', { name: `Open Run ${completedRun.id} · completed · succeeded` })
    expect(cursors.at(-1)).toBeNull()
    mounted.update([])
    await waitFor(() => expect(mounted.client.getQueryState(boardRunListKey(workspaceId, workflowId))?.fetchStatus)
      .toBe('idle'))
    expect(screen.getByRole('button', { name: `Open Run ${completedRun.id} · completed · succeeded` })).toBeVisible()
    expect(cursors.slice(6).every((cursor) => cursor === null)).toBe(true)
  })

  it('remounts from the initial page after six-page history loading', async () => {
    const cursors: Array<string | null> = []
    let arrived = false
    server.use(http.get(listRoute, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      const index = cursor ? Number(cursor.split('-')[1]) : 0
      return HttpResponse.json({ items: arrived && !cursor ? [completedRun]
        : [{ ...completedRun, id: `historical-run-${index}` }],
      pageInfo: { nextCursor: index < 6 ? `older-${index + 1}` : null } })
    }))
    const mounted = mount()
    await screen.findByRole('button', { name: 'Open Run historical-run-0 · completed · succeeded' })
    for (let index = 1; index <= 5; index++) {
      await userEvent.click(screen.getByRole('button', { name: 'Load more Runs' }))
      await screen.findByRole('button', { name: `Open Run historical-run-${index} · completed · succeeded` })
    }
    expect(screen.queryByRole('button', { name: 'Open Run historical-run-0 · completed · succeeded' })).toBeNull()
    mounted.unmount()
    arrived = true
    mount([], mounted.client)
    await screen.findByRole('button', { name: `Open Run ${completedRun.id} · completed · succeeded` })
    expect(cursors.slice(6)).toEqual([null])
  })

  it('persists a Run first observed after completion when it leaves the summary window', async () => {
    let reads = 0
    server.use(http.get(listRoute, () => {
      reads++
      return HttpResponse.json({ items: reads === 1 ? [] : [completedRun], pageInfo: { nextCursor: null } })
    }))
    const mounted = mount()
    await screen.findByText('No runs yet')
    mounted.update([summary(completedRun)])
    await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })
    expect(reads).toBe(2)
    mounted.update([])
    expect(screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })).toBeVisible()
  })

  it('overlays queued, running and completed summaries and preserves the saved selection pins', async () => {
    let reads = 0
    server.use(http.get(listRoute, () => {
      reads++
      return HttpResponse.json({ items: [fixture.run], pageInfo: { nextCursor: null } })
    }))
    const mounted = mount([summary(fixture.run)])
    await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · queued · pending` })
    mounted.update([summary({ ...fixture.run, executionState: 'running', startedAt: fixture.createdAt })])
    const running = screen.getByRole('button', { name: `Open Run ${fixture.run.id} · running · pending` })
    expect(running).toHaveTextContent('Running')
    expect(screen.queryByRole('button', { name: `Open Run ${fixture.run.id} · queued · pending` })).toBeNull()
    const initialReads = reads
    mounted.update([summary(completedRun)])
    const completed = screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })
    expect(completed).toHaveTextContent('Completed')
    expect(completed).toHaveTextContent('Past Run')
    await waitFor(() => expect(reads).toBeGreaterThan(initialReads))
    await userEvent.click(completed)
    expect(mounted.selectRun).toHaveBeenCalledWith(fixture.scope)
  })

  it('refreshes when a Run arrives and retains it through completion before the list response', async () => {
    let reads = 0
    let next = deferred<{ items: typeof fixture.run[]; pageInfo: { nextCursor: null } }>()
    server.use(http.get(listRoute, async () => {
      reads++
      return HttpResponse.json(reads === 1 ? { items: [], pageInfo: { nextCursor: null } } : await next.promise)
    }))
    const mounted = mount()
    await screen.findByText('No runs yet')
    mounted.update([summary(fixture.run)])
    await screen.findByRole('button', { name: `Inspect ${fixture.run.id}` })
    await waitFor(() => expect(reads).toBe(2))
    await act(async () => { next.resolve({ items: [fixture.run], pageInfo: { nextCursor: null } }) })
    await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · queued · pending` })
    const settling = deferred<{ items: typeof fixture.run[]; pageInfo: { nextCursor: null } }>()
    next = settling
    mounted.update([summary(completedRun)])
    expect(screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })).toHaveTextContent('Completed')
    await waitFor(() => expect(reads).toBe(3))
    await act(async () => { settling.resolve({ items: [completedRun], pageInfo: { nextCursor: null } }) })
    await waitFor(() => expect(mounted.client.getQueryState(boardRunListKey(workspaceId, workflowId))?.fetchStatus).toBe('idle'))
    expect(screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })).toBeInTheDocument()
    mounted.update([])
    expect(screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })).toBeInTheDocument()
  })

  it('retains a just-completed summary while the newly created Run is absent from the cached list', async () => {
    const pending = deferred<{ items: typeof fixture.run[]; pageInfo: { nextCursor: null } }>()
    let reads = 0
    server.use(http.get(listRoute, async () => {
      reads++
      return HttpResponse.json(reads === 1 ? { items: [], pageInfo: { nextCursor: null } } : await pending.promise)
    }))
    const mounted = mount()
    await screen.findByText('No runs yet')
    mounted.update([summary(fixture.run)])
    await waitFor(() => expect(reads).toBe(2))
    mounted.update([summary(completedRun)])
    expect(screen.getByRole('button', { name: `Inspect ${fixture.run.id}` })).toHaveTextContent('Completed')
    await act(async () => { pending.resolve({ items: [completedRun], pageInfo: { nextCursor: null } }) })
    await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })
  })

  it('keeps scope filtering and hides summaries after denied list readback', async () => {
    let denied = false
    server.use(http.get(listRoute, () => denied
      ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })
      : HttpResponse.json({ items: [fixture.run], pageInfo: { nextCursor: null } })))
    const mounted = mount([summary(fixture.run), { ...summary(fixture.run), id: 'run-other', workflowId: 'workflow-other' }])
    await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · queued · pending` })
    expect(screen.queryByRole('button', { name: 'Inspect run-other' })).toBeNull()
    denied = true
    await act(async () => { await mounted.client.invalidateQueries({ queryKey: boardRunListKey(workspaceId, workflowId) }) })
    await screen.findByText('You don’t have access to this workflow’s runs.')
    expect(screen.queryByRole('button', { name: /Open Run|Inspect run-/ })).toBeNull()
  })
})


it('keeps a refreshed terminal Run above stale active workspace details, including a later stale refresh', async () => {
  let completed = false
  server.use(http.get(listRoute, () => HttpResponse.json({
    items: [completed ? completedRun : { ...fixture.run, executionState: 'running', startedAt: fixture.createdAt }],
    pageInfo: { nextCursor: null },
  })))
  const active = summary({ ...fixture.run, executionState: 'running', startedAt: fixture.createdAt })
  const mounted = mount([active])
  await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · running · pending` })
  completed = true
  await userEvent.click(screen.getByRole('button', { name: 'Refresh Runs' }))
  const row = await screen.findByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })
  expect(row).toHaveTextContent('Past Run')
  mounted.update([{ ...active }])
  expect(screen.getByRole('button', { name: `Open Run ${fixture.run.id} · completed · succeeded` })).toBeVisible()
  expect(screen.queryByRole('button', { name: `Open Run ${fixture.run.id} · running · pending` })).toBeNull()
})

import { useLayoutEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RunBoardSnapshotGetResult } from '@foreman-code/contracts/run-snapshots'
import { server } from '../../mocks/server'
import { RunsSelector } from './RunsSelector'
import { RunsSelectorSearchSchema } from './search'
import { labelRuns, RUNS_MAX_PAGES, RUNS_PAGE_SIZE } from './presentation'
import { runsSelectorKeys, useSelectedRunSnapshot } from './query'
import { useSelectedRun, type SelectedRunState } from './useSelectedRun'
import { useRunsSelectorUi } from './uiStore'
import { page, runA, runB, runC, runsUrl, scope, snapshot } from './testFixtures'
import { deferred } from '../../test/deferred'

const runsRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs'
const listRoute = `${runsRoute}/summaries`
const snapshotRoute = `${runsRoute}/:runId/snapshot`
const clients: QueryClient[] = []
let latest: SelectedRunState | undefined

function BoardProbe() {
  const location = useLocation()
  const search = location.search as Record<string, unknown>
  const selection = useSelectedRun({ workspaceId: decodeURIComponent(location.pathname.split('/')[2]!),
    workflowId: typeof search.workflowId === 'string' ? search.workflowId : scope.workflowId })
  const readback = useSelectedRunSnapshot(selection)
  useLayoutEffect(() => { latest = selection }, [selection])
  const value = readback.snapshot
  return <>
    <RunsSelector selection={selection} />
    <output aria-label="Selected identity">{`${selection.identity.workspaceId}/${selection.identity.workflowId}/${selection.identity.runId ?? 'current'}`}</output>
    <output aria-label="Snapshot identity">{value ? `${value.workspaceId}/${value.workflowId}/${value.runId}/${value.kind === 'available' ? value.workflowVersionId : 'legacy'}` : 'none'}</output>
    <button type="button">After selector</button>
  </>
}

async function mount(entry = runsUrl(null)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: BoardProbe })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }),
    defaultPendingMinMs: 0 })
  await router.load()
  const result = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByLabelText('Selected identity')
  await waitFor(() => expect(latest).toBeDefined())
  return { ...result, client, router }
}
async function select(runId: string | null) { await act(async () => { await latest!.selectRun(runId) }) }
async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: /^Runs$/ }))
  return screen.findByRole('menu', { name: 'Runs' })
}
const selectedIdentity = (id: string | null, target = scope) => `${target.workspaceId}/${target.workflowId}/${id ?? 'current'}`
const deniedResponse = (status: number) => HttpResponse.json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Unavailable' } }, { status })

beforeEach(() => {
  latest = undefined
  useRunsSelectorUi.setState({ openId: null, geometry: null })
  server.use(
    http.get(listRoute, () => HttpResponse.json(page([runA, runB, runC]))),
    http.get(snapshotRoute, ({ params }) => HttpResponse.json(snapshot(String(params.runId), undefined,
      { workspaceId: String(params.workspaceId), workflowId: String(params.workflowId) }))),
  )
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  vi.unstubAllGlobals()
})

describe('Runs window and URL selection (real HTTP boundary + MSW)', () => {
  it('lists New run first, preserves saved-run order, and disambiguates only the shared date', async () => {
    await mount()
    const menu = await openMenu()
    const labels = labelRuns([runA, runB, runC])
    await within(menu).findByRole('menuitemradio', { name: labels[2]!.label })
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(within(menu).queryByText('Current workflow')).not.toBeInTheDocument()
    expect(rows[0]).toHaveAccessibleName('New run')
    expect(rows[0]).toHaveAttribute('aria-checked', 'true')
    expect(rows.slice(1).map((row) => row.getAttribute('data-run-id'))).toEqual(['run-a', 'run-b', 'run-c'])
    expect(rows[1]).toHaveTextContent('short-A')
    expect(rows[2]).toHaveTextContent('short-B')
    expect(rows[3]).toHaveTextContent('short-C') // The Run column always names each row.
    await userEvent.click(rows[2]!)
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-b')))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Runs$/ })).toHaveFocus()
  })

  it('returns to the current workflow through New run and marks it selected', async () => {
    const { router } = await mount(`${runsUrl('run-a')}&agentId=agent-one#details`)
    const menu = await openMenu()
    const draft = within(menu).getByRole('menuitemradio', { name: 'New run' })
    expect(draft).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(draft)
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity(null)))
    expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent('none')
    expect(router.history.location.href).not.toContain('selectedRunId')
    expect(router.history.location.href).toContain('agentId=agent-one')
    expect(router.history.location.href).toContain('#details')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Runs$/ })).toHaveFocus()
    const reopened = await openMenu()
    expect(within(reopened).getByRole('menuitemradio', { name: 'New run' })).toHaveAttribute('aria-checked', 'true')
    const savedRows = within(reopened).getAllByRole('menuitemradio').slice(1)
    for (const row of savedRows) expect(row).toHaveAttribute('aria-checked', 'false')
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('gives unstarted Runs distinct visible and accessible labels', async () => {
    server.use(http.get(listRoute, () => HttpResponse.json(page([
      { ...runA, startedAt: null, status: 'queued' },
      { ...runB, startedAt: null, status: 'queued' },
    ]))))
    await mount()
    const menu = await openMenu()
    const first = await within(menu).findByRole('menuitemradio', { name: 'Not started · short-A · Queued' })
    const second = within(menu).getByRole('menuitemradio', { name: 'Not started · short-B · Queued' })
    expect(first).toHaveTextContent('Not started')
    expect(first).toHaveTextContent('short-A')
    expect(second).toHaveTextContent('Not started')
    expect(second).toHaveTextContent('short-B')
    await userEvent.click(second)
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-b')))
  })

  it('shows concise loading, empty, transient error and retry without a redundant current-workflow section', async () => {
    const pending = deferred<ReturnType<typeof page>>()
    server.use(http.get(listRoute, async () => HttpResponse.json(await pending.promise)))
    await mount(); const menu = await openMenu()
    expect(within(menu).getByText('Loading…')).toBeInTheDocument()
    expect(within(menu).queryByText('Current workflow')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Return to workflow' })).not.toBeInTheDocument()
    pending.resolve(page([]))
    await within(menu).findByText('No runs')
    server.use(http.get(listRoute, () => HttpResponse.json({ error: { code: 'OFFLINE', message: 'Offline' } }, { status: 500 })))
    await act(async () => { await clients.at(-1)!.invalidateQueries({ queryKey: runsSelectorKeys.list(scope) }) })
    await within(menu).findByText('Load failed')
    server.use(http.get(listRoute, () => HttpResponse.json(page([runA]))))
    await userEvent.click(within(menu).getByRole('menuitem', { name: /^Retry$/ }))
    await within(menu).findByRole('menuitemradio', { name: labelRuns([runA])[0]!.label })
  })

  it('keeps A selected when a newer Run arrives', async () => {
    const { client, router } = await mount(runsUrl('run-a'))
    const menu = await openMenu()
    await within(menu).findByRole('menuitemradio', { name: labelRuns([runA, runB, runC])[0]!.label })
    const ticket = latest!.capture(), href = router.history.location.href
    const newer = { ...runC, runId: 'run-new', shortId: 'new', startedAt: new Date(2026, 8, 28, 10).toISOString(), status: 'running' as const }
    server.use(http.get(listRoute, () => HttpResponse.json(page([newer, runA, runB, runC]))))
    await act(async () => { await client.invalidateQueries({ queryKey: runsSelectorKeys.list(scope) }) })
    await within(menu).findByRole('menuitemradio', { name: labelRuns([newer, runA, runB, runC])[0]!.label })
    expect(within(menu).getAllByRole('menuitemradio')[1]).toHaveAttribute('data-run-id', 'run-new')
    expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-a'))
    expect(router.history.location.href).toBe(href)
    expect(latest!.isCurrent(ticket)).toBe(true)
  })

  it('keeps selection through refresh and browser back/forward, preserving unrelated search and hash', async () => {
    const mounted = await mount(`${runsUrl('run-a')}&agentId=agent-one#details`)
    await select('run-b')
    expect(mounted.router.history.location.href).toContain('agentId=agent-one')
    expect(mounted.router.history.location.href).toContain('#details')
    await act(async () => { mounted.router.history.back() })
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-a')))
    await act(async () => { mounted.router.history.forward() })
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-b')))
    const refreshUrl = mounted.router.history.location.href
    mounted.unmount(); mounted.client.clear(); latest = undefined
    await mount(refreshUrl)
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-b')))
    const trigger = screen.getByRole('button', { name: /^Runs$/ })
    expect(trigger).toBeEnabled()
    await openMenu()
    await userEvent.click(screen.getByRole('button', { name: 'Return to workflow' }))
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity(null)))
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(await screen.findByRole('menu', { name: 'Runs' })).toBeInTheDocument()
    await waitFor(() => expect(within(screen.getByRole('menu', { name: 'Runs' })).getAllByRole('menuitemradio')[0]).toHaveFocus())
    expect(localStorage.getItem('selectedRunId')).toBeNull()
  })

  it('fences rapid A -> B -> A with HTTP responses delivered newest first', async () => {
    const aOld = deferred<RunBoardSnapshotGetResult>(), b = deferred<RunBoardSnapshotGetResult>(), aNew = deferred<RunBoardSnapshotGetResult>()
    let aCalls = 0, bCalls = 0
    server.use(http.get(snapshotRoute, async ({ params }) => {
      if (params.runId === 'run-b') { bCalls++; return HttpResponse.json(await b.promise) }
      aCalls++
      return HttpResponse.json(await (aCalls === 1 ? aOld.promise : aNew.promise))
    }))
    await mount(runsUrl('run-a'))
    await waitFor(() => expect(aCalls).toBe(1))
    const oldTicket = latest!.capture()
    await select('run-b')
    await waitFor(() => expect(bCalls).toBe(1))
    expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent('none')
    await select('run-a')
    await waitFor(() => expect(aCalls).toBe(2))
    expect(latest!.isCurrent(oldTicket)).toBe(false)
    aNew.resolve(snapshot('run-a', 'new-A'))
    await waitFor(() => expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent(`${selectedIdentity('run-a')}/new-A`))
    await act(async () => { b.resolve(snapshot('run-b', 'late-B')); aOld.resolve(snapshot('run-a', 'late-old-A')); await Promise.resolve() })
    await waitFor(() => expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent(`${selectedIdentity('run-a')}/new-A`))
    expect(screen.getByLabelText('Snapshot identity')).not.toHaveTextContent('late-')
  })

  it('never renders an old snapshot under a different workspace/workflow', async () => {
    const old = deferred<RunBoardSnapshotGetResult>()
    const nextScope = { workspaceId: 'workspace-2', workflowId: 'workflow-other' }
    server.use(http.get(snapshotRoute, async ({ params }) => HttpResponse.json(params.workspaceId === scope.workspaceId
      ? await old.promise : snapshot('run-a', 'other-scope', nextScope))))
    const { router } = await mount(runsUrl('run-a'))
    await act(async () => { await router.navigate({ href: runsUrl('run-a', nextScope) }) })
    await waitFor(() => expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent(`${selectedIdentity('run-a', nextScope)}/other-scope`))
    old.resolve(snapshot('run-a', 'wrong-scope'))
    expect(screen.getByLabelText('Snapshot identity')).not.toHaveTextContent('wrong-scope')
  })

  it.each([[404, 'Run not found'], [403, 'No access']] as const)('retains a %s selected Run rather than falling back', async (status, text) => {
    server.use(http.get(snapshotRoute, () => deniedResponse(status)))
    const { router } = await mount(runsUrl('absent-run'))
    await screen.findByText(text)
    expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('absent-run'))
    expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent('none')
    expect(router.history.location.href).toContain('selectedRunId=absent-run')
    const menu = await openMenu()
    expect(within(menu).queryByText('Current workflow')).not.toBeInTheDocument()
    const current = screen.getByRole('button', { name: 'Return to workflow' })
    await userEvent.click(current)
    await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity(null)))
    expect(router.history.location.href).not.toContain('selectedRunId')
  })

  it('does not infer missing from a first page; legacy unavailable is a valid Run', async () => {
    server.use(http.get(listRoute, () => HttpResponse.json(page([], 'older'))),
      http.get(snapshotRoute, () => HttpResponse.json({ snapshot: { kind: 'unavailable', reason: 'legacy_run', ...scope, runId: 'old-run' } })))
    await mount(runsUrl('old-run'))
    await waitFor(() => expect(screen.getByLabelText('Snapshot identity')).toHaveTextContent(`${selectedIdentity('old-run')}/legacy`))
    const menu = await openMenu()
    await within(menu).findByText('Selected Run outside page')
    expect(screen.queryByText('Run not found')).not.toBeInTheDocument()
  })

  it('hides cached rows when a background read becomes forbidden', async () => {
    const { client } = await mount(); const menu = await openMenu()
    await within(menu).findByRole('menuitemradio', { name: labelRuns([runA, runB, runC])[0]!.label })
    server.use(http.get(listRoute, () => deniedResponse(403)))
    await act(async () => { await client.invalidateQueries({ queryKey: runsSelectorKeys.list(scope) }) })
    await within(menu).findByText('No access')
    const draft = within(menu).getByRole('menuitemradio', { name: 'New run' })
    expect(within(menu).getAllByRole('menuitemradio')).toEqual([draft])
    expect(within(menu).queryByRole('menuitem', { name: 'More' })).not.toBeInTheDocument()
  })

  it('loads one bounded page per More, encodes cursors, deduplicates and updates shared-day labels', async () => {
    const calls: URL[] = []
    server.use(http.get(listRoute, ({ request }) => {
      const url = new URL(request.url); calls.push(url)
      return HttpResponse.json(url.searchParams.has('cursor') ? page([runB, runA]) : page([runA], 'opaque:/+?=&'))
    }))
    await mount(); const menu = await openMenu()
    await within(menu).findByRole('menuitemradio', { name: labelRuns([runA])[0]!.label })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.searchParams.get('limit')).toBe(String(RUNS_PAGE_SIZE))
    await userEvent.click(within(menu).getByRole('menuitem', { name: /^More$/ }))
    await within(menu).findByRole('menuitemradio', { name: labelRuns([runA, runB])[1]!.label })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.searchParams.get('cursor')).toBe('opaque:/+?=&')
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
    expect(within(menu).getByRole('menuitem', { name: 'No more' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('stops at the page cap without evicting the newest Run or looping cursors', async () => {
    let calls = 0
    server.use(http.get(listRoute, ({ request }) => {
      calls++
      const index = Number(new URL(request.url).searchParams.get('cursor') ?? 0)
      return HttpResponse.json(page([{ ...runA, runId: `page-${index}`, shortId: `p${index}` }], String(index + 1)))
    }))
    await mount(); const menu = await openMenu()
    for (let index = 1; index < RUNS_MAX_PAGES; index++) {
      const more = await within(menu).findByRole('menuitem', { name: /^More$/ })
      await waitFor(() => expect(more).toHaveAttribute('aria-disabled', 'false'))
      await userEvent.click(more)
    }
    await within(menu).findByRole('menuitem', { name: 'Limit reached' })
    expect(calls).toBe(RUNS_MAX_PAGES)
    expect(menu.querySelector('[data-run-id="page-0"]')).toBeInTheDocument()
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Limit reached' }))
    expect(calls).toBe(RUNS_MAX_PAGES)
  })

  it('supports keyboard navigation and explicit dismissal, leaving the board usable at 320px', async () => {
    const width = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 })
    try {
      await mount()
      const user = userEvent.setup(), trigger = screen.getByRole('button', { name: /^Runs$/ })
      trigger.focus(); await user.keyboard('{ArrowDown}')
      const menu = await screen.findByRole('menu', { name: 'Runs' })
      await within(menu).findByRole('menuitemradio', { name: labelRuns([runA, runB, runC])[2]!.label })
      expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveFocus()
      expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ width: '296px' })
      await user.keyboard('{End}')
      expect(within(menu).getAllByRole('menuitemradio').at(-1)).toHaveFocus()
      await user.keyboard('{Home}')
      expect(within(menu).getAllByRole('menuitemradio')[0]).toHaveFocus()
      await user.keyboard('{ArrowDown}{Enter}')
      await waitFor(() => expect(screen.getByLabelText('Selected identity')).toHaveTextContent(selectedIdentity('run-a')))
      expect(trigger).toHaveFocus()
      await user.keyboard('{ArrowDown}{Escape}')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
      await user.keyboard('{ArrowDown}{Tab}')
      expect(screen.getByRole('button', { name: 'Resize Runs window' })).toHaveFocus()
      expect(screen.getByRole('dialog', { name: 'Runs' })).toBeInTheDocument()
      fireEvent.pointerDown(document.body)
      expect(screen.getByRole('dialog', { name: 'Runs' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'After selector' }))
      expect(screen.getByRole('dialog', { name: 'Runs' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Close Runs' }))
      expect(screen.queryByRole('dialog', { name: 'Runs' })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }) }
  })
})

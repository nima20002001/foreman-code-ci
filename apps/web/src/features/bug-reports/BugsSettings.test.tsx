import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import type { BugReport, BugReportCloseInput, BugReportUpdateInput } from '@foreman-code/contracts/management'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'

function report(overrides: Partial<BugReport> = {}): BugReport {
  return {
    id: 'bug-report-1',
    workspaceId: 'workspace-1',
    title: 'Workflow start fails',
    tried: { feature: 'workflow_start', inputsSummary: 'Start the saved Website workflow.' },
    happened: { errorCode: 'START_FAILED', message: 'The workflow could not start.' },
    expected: 'The saved workflow starts a run.',
    severity: 'high',
    status: 'open',
    revision: 1,
    reporter: { principalId: 'worker-1', name: 'Website Coder', audience: 'worker', agentId: 'agent-1' },
    harness: 'codex',
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    lastReportedAt: '2026-10-10T10:00:00.000Z',
    occurrenceCount: 2,
    workflowId: 'workflow-1',
    runId: 'run-1',
    ...overrides,
  }
}

const caches: QueryClient[] = []
afterEach(() => {
  for (const cache of caches) cache.clear()
  caches.length = 0
})

function mount(url: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [url] }) })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  caches.push(cache)
  render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

function serveReports(items: BugReport[] = [report()]) {
  server.use(
    http.get('*/api/management/bug-reports', ({ request }) => {
      const url = new URL(request.url)
      const history = url.searchParams.get('view') === 'history'
      const filtered = items.filter(item => ['fixed', 'wont-fix', 'duplicate'].includes(item.status) === history
        && (!url.searchParams.get('status')
        || item.status === url.searchParams.get('status')) && (!url.searchParams.get('severity')
        || item.severity === url.searchParams.get('severity')))
      return HttpResponse.json({ items: filtered, pageInfo: { nextCursor: null } })
    }),
    http.get('*/api/management/bug-reports/:reportId', ({ params }) => {
      const item = items.find(item => item.id === params.reportId)
      return item ? HttpResponse.json(item)
        : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'This bug report was not found.' } }, { status: 404 })
    }),
  )
}

it.each(['footer', 'escape', 'backdrop'] as const)('guards unsaved closing notes when dismissing through %s', async method => {
  serveReports()
  mount('/settings/bugs?reportId=bug-report-1')
  const user = userEvent.setup()
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  await user.type(within(dialog).getByRole('textbox', { name: 'Closing note' }), 'Needs another look')
  if (method === 'footer') await user.click(within(dialog).getByRole('button', { name: 'Close report' }))
  if (method === 'escape') await user.keyboard('{Escape}')
  if (method === 'backdrop') {
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
  }
  const guard = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(within(guard).getByText(/unsaved changes/)).toBeVisible()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(within(dialog).getByRole('textbox', { name: 'Closing note' })).toHaveValue('Needs another look')
  await user.click(within(dialog).getByRole('button', { name: 'Close report' }))
  const discard = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  await user.click(within(discard).getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Workflow start fails' })).not.toBeInTheDocument())
})

it('saves a closing draft before leaving through the shared navigation guard', async () => {
  const items = [report()]
  const writes: BugReportCloseInput[] = []
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/close', async ({ request }) => {
    const input = await request.json() as BugReportCloseInput
    writes.push(input)
    items[0] = { ...items[0]!, status: input.status, revision: 2,
      resolution: { status: input.status, note: input.note!, closedAt: '2026-10-11T10:00:00.000Z' } }
    return HttpResponse.json({ reports: items, replayed: false })
  }))
  const router = mount('/settings/bugs?reportId=bug-report-1')
  const user = userEvent.setup()
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  await user.type(within(dialog).getByRole('textbox', { name: 'Closing note' }), 'Fixed in the release')
  act(() => { void router.navigate({ to: '/settings' }) })
  const guard = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  await user.click(within(guard).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  expect(writes).toEqual([{ commandId: expect.any(String), status: 'fixed', note: 'Fixed in the release',
    reports: [{ reportId: 'bug-report-1', expectedRevision: 1 }] }])
  expect(items[0]!.status).toBe('fixed')
})

it('opens Bugs from Settings and stores filters and report selection in the URL', async () => {
  const items = [report(), report({ id: 'bug-report-2', title: 'Context is confusing', severity: 'low', status: 'fixed' })]
  serveReports(items)
  const router = mount('/settings')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'Bugs' }))
  expect(await screen.findByRole('heading', { name: 'Bugs', level: 1 })).toBeVisible()
  expect(router.state.location.pathname).toBe('/settings/bugs')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'open')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by severity' }), 'high')
  await waitFor(() => expect(router.state.location.search).toEqual({ status: 'open', severity: 'high' }))
  expect(await screen.findByRole('button', { name: 'Read Workflow start fails' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Read Context is confusing' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Read Workflow start fails' }))
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  expect(router.state.location.search).toEqual({ status: 'open', severity: 'high', reportId: 'bug-report-1' })
  expect(within(dialog).getByText('Start the saved Website workflow.')).toBeVisible()
  expect(within(dialog).getByText('START_FAILED')).toBeVisible()
  expect(within(dialog).getByText('The saved workflow starts a run.')).toBeVisible()
  expect(within(dialog).getByText('Website Coder (worker)')).toBeVisible()
  expect(within(dialog).getByText('codex')).toBeVisible()
  expect(within(dialog).getByText('run-1')).toBeVisible()
  await user.click(within(dialog).getByRole('button', { name: 'Close report' }))
  await waitFor(() => expect(router.state.location.search).toEqual({ status: 'open', severity: 'high' }))
})

it('shows reports in server order and loads the next page so older reports remain reachable', async () => {
  const newest = report()
  const older = report({ id: 'bug-report-2', title: 'Older failure', createdAt: '2026-10-09T10:00:00.000Z' })
  const cursors: Array<string | null> = []
  server.use(http.get('*/api/management/bug-reports', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor')
    cursors.push(cursor)
    return HttpResponse.json({ items: cursor ? [older] : [newest], pageInfo: { nextCursor: cursor ? null : 'older-page' } })
  }))
  mount('/settings/bugs')
  await screen.findByRole('button', { name: 'Read Workflow start fails' })
  await userEvent.click(screen.getByRole('button', { name: 'Show more bug reports' }))
  await screen.findByRole('button', { name: 'Read Older failure' })
  const cards = within(screen.getByRole('list', { name: 'Bug reports, newest first' })).getAllByRole('button')
  expect(cards.map(card => card.getAttribute('aria-label'))).toEqual(['Read Workflow start fails', 'Read Older failure'])
  expect(cursors).toEqual([null, 'older-page'])
  expect(screen.queryByRole('button', { name: 'Show more bug reports' })).not.toBeInTheDocument()
})

it('saves the selected status with its revision, reads it back, and keeps it when reopening', async () => {
  const items = [report()]
  const writes: BugReportUpdateInput[] = []
  let reads = 0
  serveReports(items)
  server.use(
    http.get('*/api/management/bug-reports/:reportId', () => {
      reads += 1
      return HttpResponse.json(items[0])
    }),
    http.post('*/api/management/bug-reports/:reportId/status', async ({ request }) => {
      const input = await request.json() as BugReportUpdateInput
      writes.push(input)
      items[0] = { ...items[0]!, status: input.status, revision: 2 }
      return HttpResponse.json({ report: items[0], replayed: false })
    }),
  )
  const router = mount('/settings/bugs?reportId=bug-report-1')
  const user = userEvent.setup()
  const status = await screen.findByRole('combobox', { name: 'Report status' })
  await user.selectOptions(status, 'triaged')
  expect(await screen.findByText('Status saved.')).toBeVisible()
  expect(status).toHaveValue('triaged')
  expect(writes).toEqual([expect.objectContaining({ reportId: 'bug-report-1', expectedRevision: 1, status: 'triaged' })])
  expect(writes[0]?.commandId).toEqual(expect.any(String))
  expect(reads).toBeGreaterThanOrEqual(2)
  await user.click(screen.getByRole('button', { name: 'Close report' }))
  await waitFor(() => expect(router.state.location.search).toEqual({}))
  expect(within(screen.getByRole('button', { name: 'Read Workflow start fails' })).getByText('Triaged')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Read Workflow start fails' }))
  expect(await screen.findByRole('combobox', { name: 'Report status' })).toHaveValue('triaged')
})

it('returns focus to the Bugs heading when a saved status removes the card from the filtered list', async () => {
  const items = [report()]
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/:reportId/status', async ({ request }) => {
    const input = await request.json() as BugReportUpdateInput
    items[0] = { ...items[0]!, status: input.status, revision: 2 }
    return HttpResponse.json({ report: items[0], replayed: false })
  }))
  mount('/settings/bugs?status=open')
  const user = userEvent.setup()
  const card = await screen.findByRole('button', { name: 'Read Workflow start fails' })
  card.focus()
  expect(card).toHaveFocus()
  await user.click(card)
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Report status' }), 'triaged')
  expect(await screen.findByText('Status saved.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Read Workflow start fails' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Close report' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Bugs', level: 1 })).toHaveFocus())
})

it('dismisses on a backdrop click but keeps inside clicks and inside-started drags open', async () => {
  serveReports()
  const router = mount('/settings/bugs?reportId=bug-report-1&severity=high')
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  const content = within(dialog).getByText('What they tried')
  fireEvent.pointerDown(content)
  fireEvent.click(content)
  expect(dialog).toBeVisible()
  fireEvent.pointerDown(content)
  fireEvent.click(dialog)
  expect(dialog).toBeVisible()
  fireEvent.pointerDown(dialog)
  fireEvent.click(dialog)
  await waitFor(() => expect(router.state.location.search).toEqual({ severity: 'high' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('locks dismissal and status changes while the save is pending', async () => {
  serveReports()
  let finish: (() => void) | undefined
  const pending = new Promise<void>(resolve => { finish = resolve })
  server.use(http.post('*/api/management/bug-reports/:reportId/status', async () => {
    await pending
    return HttpResponse.json({ report: report({ status: 'triaged', revision: 2 }), replayed: false })
  }))
  mount('/settings/bugs?reportId=bug-report-1')
  const status = await screen.findByRole('combobox', { name: 'Report status' })
  await userEvent.selectOptions(status, 'triaged')
  expect(await screen.findByText('Saving status…')).toBeVisible()
  const dialog = screen.getByRole('dialog', { name: 'Workflow start fails' })
  expect(status).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: 'Close report' })).toBeDisabled()
  fireEvent.pointerDown(dialog)
  fireEvent.click(dialog)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(dialog).toBeVisible()
  await act(async () => { finish?.() })
  expect(await screen.findByText('Status saved.')).toBeVisible()
})

it('keeps a denied status unchanged and explains that the caller cannot update it', async () => {
  serveReports()
  server.use(http.post('*/api/management/bug-reports/:reportId/status', () => HttpResponse.json({
    error: { code: 'ACCESS_DENIED', message: 'You do not have permission to update bug reports.' },
  }, { status: 403 })))
  mount('/settings/bugs?reportId=bug-report-1')
  const status = await screen.findByRole('combobox', { name: 'Report status' })
  await userEvent.selectOptions(status, 'triaged')
  expect(await screen.findByText('You do not have permission to update bug reports.')).toBeVisible()
  expect(screen.getByText('Your access does not allow status changes.')).toBeVisible()
  expect(status).toHaveValue('open')
  expect(screen.queryByText('Status saved.')).not.toBeInTheDocument()
  expect(status).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Close report' })).toBeEnabled()
})

it.each(['server failure', 'invalid acknowledgement'])('retries a save after %s with the original command and revision', async failure => {
  const items = [report()]
  const writes: BugReportUpdateInput[] = []
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/:reportId/status', async ({ request }) => {
    const input = await request.json() as BugReportUpdateInput
    writes.push(input)
    if (writes.length === 1) {
      if (failure === 'invalid acknowledgement') return HttpResponse.json({ incomplete: true })
      return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Connection interrupted.' } }, { status: 503 })
    }
    items[0] = { ...items[0]!, status: input.status, revision: 2 }
    return HttpResponse.json({ report: items[0], replayed: true })
  }))
  mount('/settings/bugs?reportId=bug-report-1')
  await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Report status' }), 'triaged')
  expect(await screen.findByText('The save is unconfirmed. Retry the same change before leaving.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Close report' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Retry status save' }))
  expect(await screen.findByText('Status saved.')).toBeVisible()
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(screen.getByRole('combobox', { name: 'Report status' })).toHaveValue('triaged')
})

it.each([500, 502, 503])('recovers list and detail request failures through their refresh actions (%s)', async status => {
  let detailReads = 0
  server.use(
    http.get('*/api/management/bug-reports', () => HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Reports are unavailable.' },
    }, { status })),
    http.get('*/api/management/bug-reports/:reportId', () => {
      detailReads++
      return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'This bug report was not found.' } },
        { status: 404 })
    }),
  )
  mount('/settings/bugs?reportId=bug-report-missing')
  const reports = within(await screen.findByRole('region', { name: 'Bug reports' }))
  expect(await reports.findByRole('alert')).toHaveTextContent('Reports are unavailable.')
  expect(await screen.findByText('This bug report was not found.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Refresh bug reports' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Refresh report' })).toBeEnabled()
  expect(screen.queryByRole('combobox', { name: 'Report status' })).not.toBeInTheDocument()
  const failedDetailReads = detailReads
  serveReports([report({ id: 'bug-report-missing' })])
  server.use(http.get('*/api/management/bug-reports/:reportId', () => {
    detailReads++
    return HttpResponse.json(report({ id: 'bug-report-missing' }))
  }))
  await userEvent.click(screen.getByRole('button', { name: 'Refresh bug reports' }))
  expect(detailReads).toBe(failedDetailReads)
  await userEvent.click(screen.getByRole('button', { name: 'Refresh report' }))
  await waitFor(() => expect(detailReads).toBe(failedDetailReads + 1))
  expect(await screen.findByRole('combobox', { name: 'Report status' })).toHaveValue('open')
  expect(screen.getByRole('button', { name: 'Read Workflow start fails' })).toBeVisible()
  expect(reports.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText('This bug report was not found.')).not.toBeInTheDocument()
})

it('shows pending reads and an empty filtered list without losing URL filters', async () => {
  let finish: (() => void) | undefined
  const pending = new Promise<void>(resolve => { finish = resolve })
  server.use(http.get('*/api/management/bug-reports', async () => {
    await pending
    return HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })
  }))
  const router = mount('/settings/bugs?status=triaged&severity=critical')
  expect(await screen.findByText('Reading bug reports…')).toBeVisible()
  await act(async () => { finish?.() })
  expect(await screen.findByText('No active bug reports')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveValue('triaged')
  expect(screen.getByRole('combobox', { name: 'Filter by severity' })).toHaveValue('critical')
  expect(router.state.location.search).toEqual({ status: 'triaged', severity: 'critical' })
})

it('hides cached reports after denied reads and keeps them hidden through a later network failure', async () => {
  serveReports()
  mount('/settings/bugs?reportId=bug-report-1')
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  const details = within(dialog)
  const reports = within(screen.getByRole('region', { name: 'Bug reports' }))
  expect(await details.findByRole('combobox', { name: 'Report status' })).toHaveValue('open')
  expect(await reports.findByRole('button', { name: 'Read Workflow start fails' })).toBeVisible()
  const cache = caches.at(-1)!
  server.use(
    http.get('*/api/management/bug-reports', () => HttpResponse.json({
      error: { code: 'ACCESS_DENIED', message: 'You cannot read bug reports.' },
    }, { status: 403 })),
    http.get('*/api/management/bug-reports/:reportId', () => HttpResponse.json({
      error: { code: 'ACCESS_DENIED', message: 'You cannot read this report.' },
    }, { status: 403 })),
  )
  await act(async () => { await cache.refetchQueries({ type: 'active' }) })
  expect(await screen.findByText('You cannot read bug reports.')).toBeVisible()
  expect(await screen.findByText('You cannot read this report.')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Read Workflow start fails' })).not.toBeInTheDocument()
  expect(screen.queryByText('Start the saved Website workflow.')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Report status' })).not.toBeInTheDocument()
  server.use(
    http.get('*/api/management/bug-reports', () => HttpResponse.error()),
    http.get('*/api/management/bug-reports/:reportId', () => HttpResponse.error()),
  )
  await userEvent.click(await reports.findByRole('button', { name: 'Refresh bug reports' }))
  await userEvent.click(await details.findByRole('button', { name: 'Refresh report' }))
  await waitFor(() => {
    expect(reports.getAllByText('Updating — reconnecting…')).toHaveLength(1)
    expect(details.getAllByText('Updating — reconnecting…')).toHaveLength(1)
  })
  expect(screen.queryByRole('button', { name: 'Read Workflow start fails' })).not.toBeInTheDocument()
  expect(screen.queryByText('Start the saved Website workflow.')).not.toBeInTheDocument()
  serveReports()
  await userEvent.click(await reports.findByRole('button', { name: 'Refresh bug reports' }))
  await userEvent.click(await details.findByRole('button', { name: 'Refresh report' }))
  expect(await details.findByRole('combobox', { name: 'Report status' })).toHaveValue('open')
  expect(await reports.findByRole('button', { name: 'Read Workflow start fails' })).toBeVisible()
})

it('refreshes a conflicting status and uses the latest revision for the next change', async () => {
  const items = [report()]
  const writes: BugReportUpdateInput[] = []
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/:reportId/status', async ({ request }) => {
    const input = await request.json() as BugReportUpdateInput
    writes.push(input)
    if (writes.length === 1) {
      items[0] = { ...items[0]!, status: 'triaged', revision: 2 }
      return HttpResponse.json({
        error: { code: 'REVISION_CONFLICT', message: 'The report changed. Refresh it before updating.' },
      }, { status: 409 })
    }
    items[0] = { ...items[0]!, status: input.status, revision: 3 }
    return HttpResponse.json({ report: items[0], replayed: false })
  }))
  mount('/settings/bugs?reportId=bug-report-1')
  const status = await screen.findByRole('combobox', { name: 'Report status' })
  await userEvent.selectOptions(status, 'triaged')
  expect(await screen.findByText('The report changed. Refresh it before updating.')).toBeVisible()
  expect(status).toHaveValue('open')
  expect(status).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Refresh report' }))
  await waitFor(() => expect(status).toBeEnabled())
  expect(status).toHaveValue('triaged')
  await userEvent.selectOptions(status, 'open')
  expect(await screen.findByText('Status saved.')).toBeVisible()
  expect(status).toHaveValue('open')
  expect(writes[1]).toMatchObject({ expectedRevision: 2, status: 'open' })
  expect(writes[1]?.commandId).not.toBe(writes[0]?.commandId)
})

it('closes an active report with a note and moves it from the active list to history', async () => {
  const items = [report()]
  const closes: BugReportCloseInput[] = []
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/close', async ({ request }) => {
    const input = await request.json() as BugReportCloseInput
    closes.push(input)
    items[0] = { ...items[0]!, status: input.status, revision: 2, resolution: {
      status: input.status, closedAt: '2026-10-11T10:00:00.000Z', ...(input.note ? { note: input.note } : {}),
      ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
    } }
    return HttpResponse.json({ reports: [items[0]], replayed: false })
  }))
  const router = mount('/settings/bugs?reportId=bug-report-1')
  const user = userEvent.setup()
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Close as' }), 'duplicate')
  const archive = within(dialog).getByRole('button', { name: 'Close and archive' })
  expect(archive).toBeDisabled()
  await user.type(within(dialog).getByRole('textbox', { name: /Duplicate of report ID/ }), 'bug-report-0')
  await user.type(within(dialog).getByRole('textbox', { name: 'Closing note' }), 'Same as the start failure')
  await user.click(archive)
  expect(await screen.findByText('Report closed and archived.')).toBeVisible()
  expect(closes).toEqual([{ commandId: expect.any(String), status: 'duplicate', duplicateOfId: 'bug-report-0',
    note: 'Same as the start failure', reports: [{ reportId: 'bug-report-1', expectedRevision: 1 }] }])
  expect(within(dialog).getByText('Same as the start failure')).toBeVisible()
  expect(within(dialog).getByRole('combobox', { name: 'Report status' })).toHaveValue('duplicate')
  expect(within(dialog).queryByRole('button', { name: 'Close and archive' })).not.toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'Close report' }))
  expect(await screen.findByText('No active bug reports')).toBeVisible()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Show reports' }), 'history')
  await waitFor(() => expect(router.state.location.search).toEqual({ view: 'history' }))
  const card = await screen.findByRole('button', { name: 'Read Workflow start fails' })
  expect(within(card).getByText('Duplicate')).toBeVisible()
  expect(within(screen.getByRole('combobox', { name: 'Filter by status' })).queryByRole('option', { name: 'Open' }))
    .not.toBeInTheDocument()
})

it('reopens a closed report from history through its status', async () => {
  const items = [report({ status: 'fixed', revision: 2,
    resolution: { status: 'fixed', note: 'Released in v1.2.3', closedAt: '2026-10-11T10:00:00.000Z' } })]
  const writes: BugReportUpdateInput[] = []
  serveReports(items)
  server.use(http.post('*/api/management/bug-reports/:reportId/status', async ({ request }) => {
    const input = await request.json() as BugReportUpdateInput
    writes.push(input)
    items[0] = { ...items[0]!, status: input.status, revision: 3 }
    return HttpResponse.json({ report: items[0], replayed: false })
  }))
  mount('/settings/bugs?view=history&reportId=bug-report-1')
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  expect(within(dialog).getByText('Released in v1.2.3')).toBeVisible()
  const status = within(dialog).getByRole('combobox', { name: 'Report status' })
  expect(status).toHaveValue('fixed')
  await userEvent.selectOptions(status, 'open')
  expect(await screen.findByText('Status saved.')).toBeVisible()
  expect(writes).toEqual([expect.objectContaining({ expectedRevision: 2, status: 'open' })])
  expect(within(dialog).getByText('Previously closed as')).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close report' }))
  expect(await screen.findByText('No closed bug reports')).toBeVisible()
})

it('shows report status and closing-note help on demand', async () => {
  serveReports()
  mount('/settings/bugs?reportId=bug-report-1')
  const user = userEvent.setup()
  const dialog = await screen.findByRole('dialog', { name: 'Workflow start fails' })
  expect(within(dialog).queryByText('Status changes save immediately.')).not.toBeInTheDocument()
  await user.hover(within(dialog).getByRole('button', { name: 'About Report status' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Status changes save immediately.')
  await user.unhover(within(dialog).getByRole('button', { name: 'About Report status' }))
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  await user.hover(within(dialog).getByRole('button', { name: 'About Closing note' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Optional, such as the release or commit.')
})

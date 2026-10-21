// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowRunSummarySchema } from '@foreman-code/contracts'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { server } from '../../mocks/server'
import { AgentChatPanel } from '../graph/AgentPanels'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useRunsSelectorUi } from '../runs-selector/uiStore'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { agentChatContextKey } from '../conversations/agentChat/model'
import { activitiesRoute, activityPage, clients, context,
  installSelectedHandlers, scope, snapshot, snapshotRoute } from '../conversations/agentChat/sch10.testSupport'
import { boardDraftContextKey } from './keys'
import { WorkflowBoard } from './WorkflowBoard'
import { useWorkflowBoard } from './context'

function CurrentNavigation() { return useWorkflowBoard()?.navigationControls }

vi.mock('../schedules', () => ({ ScheduleClockButton: () => null }))
vi.mock('../workflow-files', () => ({ WorkflowFilesButton: () => null }))

beforeEach(() => { installChatSource(); installFlowLayout(); useRunsSelectorUi.getState().setOpen(null) })
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  useConversationDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('opens a past Run without a sidebar and restores Current Agent chat', async () => {
  const source = installSelectedHandlers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(boardDraftContextKey(scope.workspaceId, scope.workflowId), { draft: { baseWorkflowVersionId: 'version-current' } })
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined} selectRun={() => undefined} summaries={[]}>
      <CurrentNavigation />
      <AgentChatPanel name="Current Agent" context={context()} />
    </WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)

  expect(await screen.findByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(await within(menu).findByRole('menuitemradio', { name: /run-a/i }))

  await screen.findByRole('region', { name: 'Selected Run board' })
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open Selected Run panel' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Selected Run' })).not.toBeInTheDocument()
  expect(source.reads).toHaveLength(0)
  expect(source.current.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(screen.getByRole('button', { name: 'Return to workflow' }))
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument())
  expect(screen.getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(context()))
})

async function mountBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(boardDraftContextKey(scope.workspaceId, scope.workflowId), { draft: { baseWorkflowVersionId: 'version-current' } })
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined}
      selectRun={() => undefined} summaries={[]}><CurrentNavigation /><button type="button">Edit workflow</button></WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }),
    defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(await within(menu).findByRole('menuitemradio', { name: /run-a/i }))
  return { client, router }
}

function renderedNodeBounds(node: HTMLElement) {
  const viewport = node.closest<HTMLElement>('.react-flow__viewport')!
  const transform = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(viewport.style.transform)!
  const zoom = Number(transform[3])
  const bounds = node.getBoundingClientRect()
  const left = Number(transform[1]) + bounds.x * zoom
  const top = Number(transform[2]) + bounds.y * zoom
  return { left, top, right: left + bounds.width * zoom, bottom: top + bounds.height * zoom }
}

it('keeps the saved Agent and Inspect reachable after desktop resize without a Selected Run panel', async () => {
  installSelectedHandlers()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
  http.get('*/api/management/workspaces/:workspaceId/runs/:runId/executions', () =>
    HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })),
  http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement', () =>
    HttpResponse.json({ error: { code: 'DENIED', message: 'No access' } }, { status: 403 })))
  const layout = installFlowLayout(1431, 800)
  await mountBoard()
  const node = await screen.findByRole('group', { name: 'Removed Coder, saved agent, read only' })
  await waitFor(() => expect(renderedNodeBounds(node).left).toBeGreaterThan(320))
  const savedPosition = node.style.transform
  const pane = node.closest('.react-flow')!.querySelector('.react-flow__pane')!
  for (const type of ['mousedown', 'mouseup']) {
    const event = new MouseEvent(type, { bubbles: true, clientX: 200, clientY: 200, button: 0 })
    // jsdom's UIEvent constructor rejects Vitest's Window proxy.
    Object.defineProperty(event, 'view', { value: document.defaultView })
    fireEvent(pane, event)
  }

  act(() => layout.resize(320, 480))
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open Selected Run panel' })).not.toBeInTheDocument()
  await waitFor(() => {
    const bounds = renderedNodeBounds(node)
    expect(bounds.left).toBeGreaterThanOrEqual(0)
    expect(bounds.right).toBeLessThanOrEqual(320)
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(480)
  })
  expect(node.style.transform).toBe(savedPosition)
  expect(within(node).getByRole('button', { name: 'Inspect Removed Coder' })).toBeEnabled()

  act(() => layout.resize(280, 480))
  await waitFor(() => expect(renderedNodeBounds(node).right).toBeLessThanOrEqual(280))
  await userEvent.click(within(node).getByRole('button', { name: 'Inspect Removed Coder' }))
  expect(await screen.findByRole('region', { name: 'Run node inspector: Removed Coder' })).toBeInTheDocument()
})

it.each(['Zoom In', 'Zoom Out'])('preserves a saved Run viewport adjusted with %s when resized without a sidebar', async (action) => {
  installSelectedHandlers()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })))
  const layout = installFlowLayout(1431, 800)
  await mountBoard()
  const node = await screen.findByRole('group', { name: 'Removed Coder, saved agent, read only' })
  await waitFor(() => expect(renderedNodeBounds(node).left).toBeGreaterThan(320))
  const viewport = node.closest<HTMLElement>('.react-flow__viewport')!
  await userEvent.click(screen.getByRole('button', { name: action }))
  const expectedZoom = action === 'Zoom In' ? 1.2 : 1 / 1.2
  await waitFor(() => {
    const zoom = Number(/scale\(([-\d.]+)\)/.exec(viewport.style.transform)![1])
    expect(zoom).toBeCloseTo(expectedZoom, 5)
  })
  const adjusted = viewport.style.transform
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  act(() => layout.resize(320, 480))
  // Cover the resize debounce and animation frames without advancing wall time.
  await act(async () => { await vi.advanceTimersByTimeAsync(120) })
  expect(viewport.style.transform).toBe(adjusted)
})

it.each(['job-only', 'early-failed', 'mixed'] as const)('opens a %s Run chosen in the picker without an automatic chat read', async (kind) => {
  const source = installSelectedHandlers()
  const saved = snapshot('run-a').snapshot
  if (saved.kind !== 'available') throw new Error('Expected available snapshot')
  const job = { kind: 'job', id: 'node-job', name: 'Build Job', jobDefinitionId: 'job-build',
    jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version-pinned',
    position: { x: 0, y: 0 }, size: { width: 240, height: 100 } }
  const nodes = kind === 'job-only' ? [job] : [...saved.nodes, ...(kind === 'mixed' ? [job, {
    ...saved.nodes[0]!, id: 'node-other', name: 'Other saved Agent', agentId: 'agent-other',
  }] : [])]
  const activityReads = vi.fn(() => HttpResponse.json(activityPage('run-a')))
  server.use(http.get(snapshotRoute, () => HttpResponse.json(RunBoardSnapshotGetResultSchema.parse({
    snapshot: { ...saved, nodes },
  }))), http.get(activitiesRoute, activityReads))
  await mountBoard()
  expect(await screen.findByRole('region', { name: 'Selected Run board' })).toHaveTextContent('Read only')
  expect(screen.queryByRole('button', { name: 'Edit workflow' })).not.toBeInTheDocument()
  expect(screen.queryByRole('complementary', { name: 'Agent chat' })).not.toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Run-wide Activities' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Open Selected Run panel' })).not.toBeInTheDocument()
  expect(source.reads).toHaveLength(0)
  expect(source.current.calls).toHaveLength(0)
  expect(activityReads).not.toHaveBeenCalled()
})

it('keeps Run-wide Activities hidden when the selected snapshot is denied', async () => {
  const source = installSelectedHandlers()
  const reads = vi.fn(() => HttpResponse.json(activityPage('run-a')))
  server.use(http.get(snapshotRoute, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })),
    http.get(activitiesRoute, reads))
  await mountBoard()
  await within(await screen.findByRole('region', { name: 'Selected Run board' })).findByText('No access')
  expect(screen.queryByRole('region', { name: 'Run-wide Activities' })).not.toBeInTheDocument()
  expect(reads).not.toHaveBeenCalled()
  expect(source.reads).toHaveLength(0)
})


it.each(['succeeded', 'failed', 'canceled'] as const)(
  'does not select or count a %s polled Run from stale running workspace details', async status => {
  installSelectedHandlers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const selectRun = vi.fn()
  const snapshotReads = vi.fn(() => HttpResponse.json(snapshot('run-a')))
  const listReads = vi.fn(() => HttpResponse.json({ items: [{ runId: 'run-a', shortId: 'a',
    startedAt: '2026-10-04T09:00:00.000Z', status, trigger: 'manual' }], pageInfo: { nextCursor: null } }))
  server.use(http.get(`*/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/summaries`, listReads),
    http.get(snapshotRoute, snapshotReads))
  const active = WorkflowRunSummarySchema.parse({ id: 'run-a', workspaceId: scope.workspaceId,
    workflowId: scope.workflowId, executionCondition: { kind: 'manual' },
    executionState: 'running', outcome: 'pending', startedAt: '2026-10-04T09:00:00.000Z',
    authRequired: false, browserWait: null, runnerHealth: { status: 'healthy' } })
  function Count() { return <output aria-label="Active Runs">{useWorkflowBoard()?.activeRuns}</output> }
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined} selectRun={selectRun}
      summaries={[active]}><Count /></WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await waitFor(() => expect(listReads).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByLabelText('Active Runs')).toHaveTextContent('0'))
  expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
  expect(snapshotReads).not.toHaveBeenCalled()
  expect(selectRun).not.toHaveBeenCalled()
})

it('keeps the draft selected when background facts discover a running Run', async () => {
  installSelectedHandlers()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const selectRun = vi.fn(), snapshotReads = vi.fn(() => HttpResponse.json(snapshot('run-a')))
  const listReads = vi.fn(() => HttpResponse.json({ items: [{ runId: 'run-a', shortId: 'a',
    startedAt: '2026-10-04T09:00:00.000Z', status: 'running', trigger: 'manual' }], pageInfo: { nextCursor: null } }))
  server.use(http.get(`*/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/summaries`, listReads),
    http.get(snapshotRoute, snapshotReads))
  function Count() { return <output aria-label="Active Runs">{useWorkflowBoard()?.activeRuns}</output> }
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined} selectRun={selectRun}
      summaries={[]}><Count /><button type="button">Edit workflow</button></WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await waitFor(() => expect(listReads).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByLabelText('Active Runs')).toHaveTextContent('1'))
  expect(screen.getByRole('button', { name: 'Edit workflow' })).toBeInTheDocument()
  expect(snapshotReads).not.toHaveBeenCalled()
  expect(selectRun).not.toHaveBeenCalled()
})

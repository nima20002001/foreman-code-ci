import { installBrowserLocks } from '../test/browserLocks'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, getConfig, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import { routeTree } from '../app/router'
import { useGraphDraftStore } from '../features/graph/store'
import { nextDraftKey } from '../features/graph/nextDraft/state'
import { nextDraftApi } from '../features/graph/nextDraft/transport'
import { boardDraftContextKey } from '../features/workflow-board/keys'
import { pinnedRunHandlers, reply, runsUrl, versionReply } from '../features/run-board/testFixtures'
import { installFlowLayout } from '../features/run-board/testFlowLayout'
import { page, runA, runB } from '../features/runs-selector/testFixtures'
import { runsSelectorApi } from '../features/runs-selector/client'
import { bindMockInstallation } from '../shared/mocks/handlers'
import { getMockFixture, setMockScenario } from '../shared/mocks/scenarios'
import { server } from '../mocks/server'
import { base as subagentsRoute, child, detail } from '../features/run-subagents/testFixtures'
import boardStyles from '../features/workflow-board/workflowBoard.css?inline'

const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline' }
const key = nextDraftKey(scope.workspaceId, scope.workflowId)
const runsRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs'
const clients: QueryClient[] = []
let restoreBrowserLocks: () => void
const unhandled: string[] = []
const writes: string[] = [], scheduleReads: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
const recordWrite = ({ request }: { request: Request }) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) writes.push(`${request.method} ${new URL(request.url).pathname}`)
}

async function mount(entry = runsUrl(null, scope)) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  clients.push(client)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  const result = render(<><style>{boardStyles}</style>
    <QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></>)
  return { ...result, router, client }
}
async function waitForQuery(client: QueryClient, queryKey: QueryKey) {
  // Use RTL's async boundary for cache notifications as well as DOM waits.
  await getConfig().asyncWrapper(() => new Promise<void>((resolve, reject) => {
    const check = () => {
      const state = client.getQueryState(queryKey)
      if (state?.status === 'success' || state?.status === 'error') {
        unsubscribe()
        if (state.status === 'error') reject(state.error)
        else resolve()
      }
    }
    const unsubscribe = client.getQueryCache().subscribe(check)
    check()
  }))
}
function waitForBoardContext(client: QueryClient) {
  return waitForQuery(client, boardDraftContextKey(scope.workspaceId, scope.workflowId))
}
async function authoring() {
  const editor = await screen.findByRole('region', { name: 'Workflow authoring' }, { timeout: 3000 })
  await within(editor).findByRole('heading', { name: 'Research to review' })
  return editor
}
async function choose(runId: string | null) {
  const controls = screen.getByRole('group', { name: 'Board controls' })
  await userEvent.click(within(controls).getByRole('button', { name: /^Runs$/ }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  if (runId === null) {
    await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'New run' }))
    return
  }
  const item = await waitFor(() => {
    const row = menu.querySelector<HTMLButtonElement>(`[data-run-id="${runId}"]`)
    expect(row).not.toBeNull()
    return row!
  })
  await userEvent.click(item)
}
const savedY = () => screen.findByRole('button', { name: 'Inspect Y' })
const pinnedUrl = (runId: string) => `${runsUrl(null, scope)}&runId=${runId}&workflowVersionId=version-${runId.slice(4)}&executionSemanticsVersion=3`
async function openActivities() {
  // The retained editor's own Activities button is hidden while a Run is shown.
  const trigger = screen.getByRole('button', { name: 'Activities' })
  expect(trigger).toBeVisible()
  await userEvent.click(trigger)
  return screen.findByRole('region', { name: 'Activities popover' })
}

function installNodeInspection() {
  const reads: URL[] = []
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/executions', ({ request, params }) => {
      const url = new URL(request.url)
      if (url.searchParams.get('limit') !== '1') reads.push(url)
      return HttpResponse.json({
        run: { ...scope, runId: String(params.runId), workflowVersionId: 'version-a', executionSemanticsVersion: 3,
          executionState: 'completed', outcome: 'succeeded', createdAt: '2026-09-20T08:00:00.000Z',
          cleanupPending: false },
        items: [], pageInfo: { nextCursor: null },
      })
    }),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/nodes/:nodeId/placement',
      ({ params }) => HttpResponse.json({ ...scope, runId: String(params.runId), nodeId: String(params.nodeId),
        readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })),
  )
  return reads
}

beforeEach(() => {
  restoreBrowserLocks = installBrowserLocks()
  unhandled.length = 0; server.events.on('request:unhandled', recordUnhandled)
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear(); sessionStorage.clear(); bindMockInstallation()
  writes.length = 0; scheduleReads.length = 0
  server.events.on('request:start', recordWrite)
  installFlowLayout(1000, 720)
  const fixture = getMockFixture(scope.workspaceId)!
  server.use(
    ...pinnedRunHandlers(scope),
    http.get(subagentsRoute, () => HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
      evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
    })),
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({
      workspace: fixture.workspace, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' }, locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
    })),
    http.get(`${runsRoute}/summaries`, () => HttpResponse.json(page([runA, runB]))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/version', ({ params }) =>
      HttpResponse.json(versionReply(reply(String(params.runId), scope).snapshot))),
    http.get(`${runsRoute}/:runId/snapshot`, ({ params }) => HttpResponse.json(reply(String(params.runId), {
      workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
    }))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/activities', ({ params, request }) => {
      const runId = String(params.runId)
      if (params.workspaceId !== scope.workspaceId || !['run-a', 'run-b'].includes(runId)) {
        return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Run not found' } }, { status: 404 })
      }
      const snapshot = reply(runId, scope).snapshot
      if (snapshot.kind !== 'available') throw new Error('Expected the saved Run board fixture.')
      const activityScope = { ...scope, runId, workflowVersionId: snapshot.workflowVersionId,
        executionSemanticsVersion: 3 }
      const cursor = new URL(request.url).searchParams.get('cursor')
      return HttpResponse.json(RunActivitiesPageSchema.parse({
        scope: activityScope, mode: cursor ? 'newer' : 'initial',
        items: cursor ? [] : [{ id: `activity-${runId}`, scope: activityScope, sequence: '1',
          occurredAt: snapshot.capturedAt, source: 'backend', kind: 'run', status: 'recorded',
          severity: 'info', summary: `History for ${runId}`, refs: {} }],
        highWater: '1', retainedFrom: '1', nextCursor: `activities-${runId}-1`, olderCursor: null, hasMore: false,
      }))
    }),
    http.get('*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId',
      ({ params }) => HttpResponse.json(ReadSelectedRunChatResponseSchema.parse({ kind: 'unavailable',
        target: { workspaceId: String(params.workspaceId), workflowId: String(params.workflowId),
          runId: String(params.runId), workflowNodeId: String(params.workflowNodeId) }, reason: 'execution_missing',
      }))),
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat/target',
      () => HttpResponse.json({ kind: 'unavailable', reason: 'NO_EXECUTION' })),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule', ({ request }) => {
      scheduleReads.push(new URL(request.url).pathname)
      return HttpResponse.json({ schedule: null })
    }),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule/occurrences',
      () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  )
})
afterEach(() => {
  cleanup(); window.dispatchEvent(new Event('pagehide'))
  restoreBrowserLocks()
  clients.splice(0).forEach((client) => client.clear())
  server.events.removeListener('request:unhandled', recordUnhandled)
  expect(unhandled, 'No selected Board request may bypass MSW').toEqual([])
  server.events.removeListener('request:start', recordWrite)
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear(); sessionStorage.clear(); setMockScenario('normal')
  vi.useRealTimers()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

describe('Workspace Board route, editor and HTTP boundary', { timeout: 20_000 }, () => {
  it.each([
    { runId: null, contextDelay: 0 },
    { runId: 'run-a', contextDelay: 0 },
    { runId: null, contextDelay: 1_100 },
  ])('opens the Board after claiming browser tab ownership for Run $runId with $contextDelay ms context reads', async ({ runId, contextDelay }) => {
    if (contextDelay) server.use(http.get('/api/management/workspaces/:workspaceId/agents', async () => {
      await delay(contextDelay)
      // Continue to the normal agent handler after the delayed response.
    }))
    const { client } = await mount(runsUrl(runId, scope))
    await waitForBoardContext(client)
    const name = runId ? 'Selected Run board' : 'Workflow authoring'
    expect(await screen.findByRole('region', { name })).toBeVisible()
    expect(screen.queryByText('This browser cannot safely recover independent tab edits.')).not.toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Board controls' })).toBeVisible()
    expect(writes).toEqual([])
  })

  it('opens a cold draft, inspects a saved Run and returns without sending a write', async () => {
    const { router } = await mount()
    const editor = await authoring()
    await choose('run-a')
    expect(await savedY()).toBeVisible()
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toBeVisible()
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    await choose(null)
    await waitFor(() => expect(editor).toBeVisible())
    expect(within(editor).getByRole('heading', { name: 'Research to review' })).toBeVisible()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(writes).toEqual([])
  })

  it('inspects a saved Agent missing from the current workflow and reopens its generated URL', async () => {
    const reads = installNodeInspection()
    const current = getMockFixture(scope.workspaceId)!.workflows.find(item => item.id === scope.workflowId)!
    expect(current.nodes.some(node => node.id === 'node-x')).toBe(false)
    const { router, unmount } = await mount(`${pinnedUrl('run-a')}&runNodeId=node-x`)
    const inspect = await screen.findByRole('button', { name: 'Inspect X before rename' }, { timeout: 5000 })
    expect(inspect).toBeEnabled()
    // The linked node opens its saved details in the shared rail, which owns the selection afterwards.
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(await within(rail).findByRole('region', { name: 'Run node inspector: X before rename' })).toBeVisible()
    await within(rail).findByText('No execution recorded for this node yet.')
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toBeVisible()
    expect(screen.getByRole('group', { name: 'Board controls' })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3,
      boardPanel: 'agent', boardAgentTab: 'details', boardNodeId: 'node-x' })
    expect(router.state.location.search).not.toHaveProperty('runNodeId')
    expect(reads[0]!.searchParams.get('workflowNodeId')).toBe('node-x')
    expect(reads[0]!.pathname).toBe(`/api/management/workspaces/${scope.workspaceId}/runs/run-a/executions`)
    const href = router.history.location.href
    unmount()
    await mount(href)
    const reopened = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(await within(reopened).findByRole('region', { name: 'Run node inspector: X before rename' })).toBeVisible()
    expect(screen.queryByText('Invalid board selection')).toBeNull()
    expect(writes).toEqual([])
  }, 20_000)

  it('keeps the Run and says so when a linked saved node is not in the Run', async () => {
    const reads = installNodeInspection()
    const { router } = await mount(`${pinnedUrl('run-a')}&runNodeId=missing-node`)
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(await within(rail).findByText('This node is not in the saved Run.')).toBeVisible()
    expect(screen.getByRole('group', { name: 'Board controls' })).toBeVisible()
    expect(await savedY()).toBeVisible()
    expect(reads).toEqual([])
    await userEvent.click(within(rail).getByRole('button', { name: 'Close inspector' }))
    await waitFor(() => expect(router.state.location.search.boardPanel).toBeUndefined())
    expect(router.state.location.search.runId).toBe('run-a')
    expect(router.state.location.search).not.toHaveProperty('runNodeId')
    expect(writes).toEqual([])
  })

  it.each([0, 1_100])('opens saved Agent rail tabs and toolbar Activities at 320px with %s ms context reads', async contextDelay => {
    if (contextDelay) server.use(http.get('/api/management/workspaces/:workspaceId/agents', async () => {
      await delay(contextDelay)
    }))
    // Keep background polling on a controlled clock; timed refreshes are covered below.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const user = userEvent.setup()
    vi.stubGlobal('innerWidth', 320)
    installFlowLayout(320, 800)
    const { router, client } = await mount(runsUrl('run-a', scope))
    await waitForBoardContext(client)
    const canvas = await screen.findByLabelText('Selected Run board')
    expect(canvas).toHaveRole('region')
    expect(canvas).toBeVisible()
    const savedNode = await within(canvas).findByLabelText('Inspect Y')
    expect(savedNode).toHaveRole('button')
    expect(savedNode).toBeVisible()
    expect(canvas.getBoundingClientRect().width).toBe(320)
    const node = within(canvas).getByLabelText('Inspect X before rename')
    expect(node).toHaveRole('button')
    expect(node).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).toBeNull()
    await user.click(node)
    const info = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(info).toHaveRole('complementary')
    expect(router.state.location.search).toMatchObject({ boardPanel: 'agent', boardAgentTab: 'details' })
    expect(within(info).getByRole('button', { name: 'Details' })).toHaveAttribute('aria-pressed', 'true')
    expect(await within(info).findByRole('region', { name: 'Run node inspector: X before rename' })).toBeVisible()
    await user.click(within(info).getByRole('button', { name: 'Settings' }))
    expect(router.state.location.search).toMatchObject({ boardPanel: 'agent', boardAgentTab: 'settings' })
    expect(within(info).getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-pressed', 'true')
    expect(await within(info).findByText(/This Run keeps its saved Agent configuration/)).toBeVisible()
    await user.click(within(info).getByRole('button', { name: 'Chat' }))
    expect(router.state.location.search).toMatchObject({ boardPanel: 'agent', boardAgentTab: 'chat' })
    expect(await within(info).findByText(/This saved node has no available execution/)).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(info).not.toBeVisible())
    const activities = await openActivities()
    expect(await within(activities).findByText('History for run-a')).toBeVisible()
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      executionSemanticsVersion: 3 })
    expect(writes).toEqual([])
  })

  it('mounts native children through the product route and opens the exact child panel', async () => {
    const record = child({ ...scope, runId: 'run-a', name: 'Run child' })
    const reads: string[] = []
    server.use(
      http.get(subagentsRoute, ({ request }) => {
        reads.push(new URL(request.url).pathname)
        return HttpResponse.json({ items: [detail(record)], nextCursor: null, projection: 'caught-up' })
      }),
      http.get(`${subagentsRoute}/:subagentId`, () => HttpResponse.json(detail(record))),
      http.get(`${subagentsRoute}/:subagentId/messages`, () => HttpResponse.json({ items: [], nextCursor: null, coverage: record.coverage })),
      http.get(`${subagentsRoute}/:subagentId/tools`, () => HttpResponse.json({ items: [], nextCursor: null, coverage: record.coverage })),
    )
    const { router } = await mount(runsUrl('run-a', scope))
    await savedY()
    await userEvent.click(await screen.findByRole('button', { name: 'Run child, Codex, Running' }))
    expect(await screen.findByRole('dialog', { name: 'Run child' })).toBeVisible()
    expect([...new Set(reads)]).toEqual([`/api/management/workspaces/${scope.workspaceId}/runs/run-a/subagents`])
    expect(router.history.location.hash).toContain('selectedSubagentId=child-1')
    expect(writes).toEqual([])
  })
  it('locks the pinned canvas and restores the same unsaved draft canvas', async () => {
    installNodeInspection()
    const { router } = await mount()
    const editor = await authoring()
    const canvas = within(editor).getByLabelText('Editable workflow graph')
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Unsaved board name' })))
    await within(editor).findByRole('heading', { name: 'Unsaved board name' })
    const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
    const writesBefore = [...writes]

    await choose('run-a'); await savedY()
    expect(router.state.location.search).toMatchObject({ selectedRunId: 'run-a' })
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toBeVisible()
    // The retained editor and its canvas stay mounted but hidden and inert behind the saved Run.
    expect(editor.closest('.run-board-current')).toHaveAttribute('inert')
    expect(editor).not.toBeVisible()
    expect(canvas).not.toBeVisible()
    const activities = await openActivities()
    expect(await within(activities).findByText('History for run-a')).toBeVisible()
    await userEvent.click(within(activities).getByRole('button', { name: 'Close Activities' }))
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    fireEvent.keyDown(window, { key: 'y', metaKey: true })
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)
    expect(writes).toEqual(writesBefore)
    expect(screen.queryByRole('alertdialog', { name: 'Save changes before leaving?' })).not.toBeInTheDocument()

    await choose(null)
    await waitFor(() => expect(canvas).toBeVisible())
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(editor)
    expect(within(editor).getByLabelText('Editable workflow graph')).toBe(canvas)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)
    expect(within(editor).getByRole('heading', { name: 'Unsaved board name' })).toBeVisible()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(router.state.location.search.runId).toBeUndefined()
    expect(router.state.location.search.workflowVersionId).toBeUndefined()
    expect(router.state.location.search.executionSemanticsVersion).toBeUndefined()
    expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
  }, 20_000)

  it.each([0, 1_100])('restores the URL-selected Run in a fresh Router and QueryClient, with back/forward selection and %s ms context reads', async contextDelay => {
    const first = await mount()
    await authoring(); await choose('run-a'); await savedY()
    await act(async () => { first.router.history.back() })
    await waitFor(() => expect(screen.getByLabelText('Editable workflow graph')).toBeVisible())
    await act(async () => { first.router.history.forward() })
    await savedY()
    await waitFor(() => expect(first.router.state.location.search.selectedRunId).toBe('run-a'))
    const href = first.router.history.location.href
    first.unmount(); first.client.clear(); useGraphDraftStore.getState().clearAllDrafts()
    if (contextDelay) server.use(http.get('/api/management/workspaces/:workspaceId/agents', async () => {
      await delay(contextDelay)
    }))
    const refreshed = await mount(href)
    await waitForBoardContext(refreshed.client)
    await savedY()
    await waitFor(() => expect(refreshed.router.state.location.search).toMatchObject({ selectedRunId: 'run-a' }))
    expect(await screen.findByRole('region', { name: 'Workflow authoring', hidden: true })).not.toBeVisible()
    expect(screen.getByLabelText('Editable workflow graph')).not.toBeVisible()
    expect(writes).toEqual([])
  })

  it.each([3_200, 6_400])('refreshes the retained draft context without replacing local edits over %s ms while a Run is pinned', async (pollingTime) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let workspaceReads = 0
    const recordWorkspaceRead = ({ request }: { request: Request }) => {
      if (new URL(request.url).pathname === `/api/workspaces/${scope.workspaceId}`) workspaceReads++
    }
    server.events.on('request:start', recordWorkspaceRead)
    const context = vi.spyOn(nextDraftApi, 'context')
    try {
      const { client } = await mount()
      const editor = await authoring()
      act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, name: 'Retained local name' })))
      await within(editor).findByRole('heading', { name: 'Retained local name' })
      const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
      await waitFor(() => expect(client.isFetching({ queryKey: boardDraftContextKey(scope.workspaceId, scope.workflowId) })).toBe(0))
      const initialWorkspaceReads = workspaceReads
      const currentReads = context.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(pollingTime) })
      await waitFor(() => expect(context.mock.calls.length).toBeGreaterThan(currentReads))
      expect(workspaceReads).toBe(initialWorkspaceReads)

      await choose('run-a')
      await savedY()
      expect(workspaceReads).toBe(initialWorkspaceReads)
      expect(within(editor).getByRole('heading', { name: 'Retained local name', hidden: true })).toBeInTheDocument()
      await waitFor(() => expect(client.isFetching({ queryKey: boardDraftContextKey(scope.workspaceId, scope.workflowId) })).toBe(0))
      const selectedWorkspaceReads = workspaceReads
      const historyReads = context.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(pollingTime) })
      await waitFor(() => expect(context.mock.calls.length).toBeGreaterThan(historyReads))
      expect(workspaceReads).toBe(selectedWorkspaceReads)
      expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)

      await choose(null)
      await waitFor(() => expect(editor).toBeVisible())
      const restoredReads = context.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(pollingTime) })
      await waitFor(() => expect(context.mock.calls.length).toBeGreaterThan(restoredReads))
      expect(workspaceReads).toBe(initialWorkspaceReads)
      expect(writes).toEqual([])
      expect(within(editor).getByRole('heading', { name: 'Retained local name' })).toBeVisible()
      expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(graph)
    } finally {
      server.events.removeListener('request:start', recordWorkspaceRead)
      vi.useRealTimers()
    }
  }, 15_000)

  it.each(['running', 'queued'] as const)('keeps the draft selected while a %s Run is discovered, and shows the Run only after an explicit choice', async executionState => {
    const fixture = getMockFixture(scope.workspaceId)!
    server.use(
      http.get('/api/workspaces/workspace-1', () => HttpResponse.json({
        workspace: fixture.workspace, agents: fixture.agents, workflows: fixture.workflows,
        resources: fixture.resources, browserProfiles: fixture.browserProfiles, runners: fixture.runners,
        runs: [{ ...fixture.runs[0], id: 'run-a', executionState, outcome: 'pending', finishedAt: undefined }],
      })),
      http.get(`${runsRoute}/summaries`, () => HttpResponse.json(page([
        { ...runA, status: executionState }, runB,
      ]))),
    )
    const listed = await runsSelectorApi.list({ ...scope, limit: 20 })
    expect(listed.items.find(run => run.runId === 'run-a')).toMatchObject({ status: executionState })
    const { router } = await mount()
    const editor = await authoring()
    expect(router.state.location.search.runId).toBeUndefined()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
    expect(editor).toBeVisible()
    await choose('run-a')
    expect(await savedY()).toBeVisible()
    expect(router.state.location.search).toMatchObject({ selectedRunId: 'run-a' })
    await choose(null)
    await waitFor(() => expect(screen.getByLabelText('Editable workflow graph')).toBeVisible())
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
    expect(writes).toEqual([])
  })

  it('opens the saved-workflow clock from history, without scheduling the historical version', async () => {
    await mount(); await authoring()
    await choose('run-a'); await savedY()
    expect(scheduleReads).toEqual([])
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule workflow' }))
    const modal = await screen.findByRole('dialog', { name: /^Schedule$/ })
    await within(modal).findByRole('tab', { name: 'Weekly' })
    expect(scheduleReads.length).toBeGreaterThan(0)
    expect(new Set(scheduleReads)).toEqual(new Set(['/api/management/workspaces/workspace-1/workflows/workflow-content-pipeline/schedule']))
    expect(within(modal).getByRole('button', { name: /^Save$/ })).toBeEnabled()
    await userEvent.click(within(modal).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(modal).not.toBeVisible())
    expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', 'run-a')
  })

  it('canonicalizes a legacy Run link and preserves unrelated selection and hash', async () => {
    const entry = `/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/run-a/graph/version-a/3?workflowId=${scope.workflowId}&agentId=agent-researcher&runNodeId=node-x#board`
    const { router } = await mount(entry)
    await savedY()
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
    // The linked node moves into the shared rail; unrelated selection and the hash are preserved.
    await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      executionSemanticsVersion: 3, boardPanel: 'agent', boardAgentTab: 'details', boardNodeId: 'node-x', agentId: 'agent-researcher' })
    expect(router.state.location.search).not.toHaveProperty('runNodeId')
    const hash = router.history.location.hash
    await choose('run-b')
    await screen.findByRole('button', { name: 'Inspect X in B' })
    const activities = await openActivities()
    await within(activities).findByText('History for run-b')
    await userEvent.click(within(activities).getByRole('button', { name: 'Close Activities' }))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
    expect(router.state.location.search).toMatchObject({ workflowId: scope.workflowId, selectedRunId: 'run-b', agentId: 'agent-researcher' })
    expect(router.state.location.search.runId).toBeUndefined()
    expect(router.history.location.hash).toBe(hash)
    await choose(null)
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(router.history.location.hash).toBe(hash)
  })

  it('never falls back to the first workflow after a requested history workflow is missing', async () => {
    const missing = { ...scope, workflowId: 'workflow-missing' }
    const notFound = () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, { status: 404 })
    server.use(
      http.get('*/api/management/workspaces/workspace-1/workflows/workflow-missing', notFound),
      http.get(`${runsRoute}/:runId/snapshot`, notFound),
    )
    const { router } = await mount(runsUrl('run-a', missing))
    const board = await screen.findByRole('region', { name: 'Selected Run board' })
    await waitFor(() => expect(board).toHaveAttribute('aria-busy', 'false'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-missing', selectedRunId: 'run-a' })
    expect(screen.queryByRole('region', { name: 'Workflow authoring' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('run-board-canvas')).not.toBeInTheDocument()
  })

  it('rejects an unscoped or conflicting history request without choosing the current workflow', async () => {
    const { router } = await mount('/workspaces/workspace-1?selectedRunId=run-a')
    await screen.findByText('Invalid board selection')
    expect(router.state.location.search.workflowId).toBeUndefined()
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    await act(async () => { await router.navigate({ href: `${runsUrl('run-a', scope)}&runId=run-b&workflowVersionId=version-b&executionSemanticsVersion=3` }) })
    expect(await screen.findByText('Invalid board selection')).toBeVisible()
    expect(screen.queryByTestId('unified-workflow-board')).not.toBeInTheDocument()
  })

  it('keeps the compact clock, Runs and Files controls adjacent at 320px (DOM/CSS invariants only)', async () => {
    vi.stubGlobal('innerWidth', 320)
    installFlowLayout(320, 480)
    const { container } = await mount(runsUrl('run-a', scope))
    await savedY()
    const group = screen.getByRole('group', { name: 'Board controls' })
    const clock = await within(group).findByRole('button', { name: 'Schedule workflow' })
    const selector = within(group).getByRole('button', { name: /^Runs$/ })
    const files = within(group).getByRole('button', { name: 'Files' })
    expect(selector.compareDocumentPosition(clock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(clock.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(group.closest('header')).toHaveStyle({ position: 'static', minWidth: '0', boxSizing: 'border-box' })
    expect(container.querySelector('.unified-workflow-board')).toHaveStyle({ flexDirection: 'column' })
    await userEvent.click(selector)
    const menu = await screen.findByRole('menu', { name: 'Runs' })
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Runs' })).toHaveStyle({ width: '296px' }))
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(3)
    expect(within(menu).getByRole('menuitemradio', { name: 'New run' })).toBeEnabled()
  })
})

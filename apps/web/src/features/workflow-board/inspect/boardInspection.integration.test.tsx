import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  boardSearchForInspection, boardSearchForRun, runInspectionKey, RepeatGraphCurrentV3Schema,
  type RepeatGraphScopeV3, type WorkspaceBoardInspection,
} from '@foreman-code/contracts/wave25'
import { routeTree } from '../../../app/router'
import { server } from '../../../mocks/server'
import { bindMockInstallation } from '../../../shared/mocks/handlers'
import { useGraphDraftStore } from '../../graph/store'
import { nextDraftKey } from '../../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspectionFixtures'
import { useInspectionPresentation } from './presentation'
import { executionPagesKey, runInspectionQueryKey } from './queries'
import { currentRunKey } from '../currentRunQuery'
import { base as childRoute, child, detail, message, tool } from '../../run-subagents/testFixtures'
import { clearBoardStopStorage, readBoardStop, recordBoardStopReceipt, reserveBoardStop, type BoardStopJournal } from '../stopOutbox'

// Actual registered route, Board, retained authoring owner, pinned React Flow,
// Query hooks, HTTP clients and contract parsers. Only the HTTP service and
// absent JSDOM layout/locking primitives are synthetic; no component mocks.
configure({ asyncUtilTimeout: 5000 })
type Fixture = Awaited<ReturnType<typeof inspectionBoardFixture>>
const clients: QueryClient[] = []
let number = 0, fixture: Fixture
const unhandled: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
const basePath = (scope: RepeatGraphScopeV3) => `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}`
function href(scope: RepeatGraphScopeV3, inspection: WorkspaceBoardInspection = {}) {
  const search = boardSearchForInspection({}, scope.workflowId, scope, inspection)
  const params = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]))
  return `/workspaces/${scope.workspaceId}?${params}`
}
function domInfrastructure() {
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (
    key: string,
    work: (() => unknown) | LockOptions,
    claim?: (lock: Lock | null) => unknown,
  ) => {
    const lock: Lock = { name: key, mode: 'exclusive' }
    if (typeof work !== 'function' && work.ifAvailable && queues.has(key)) {
      return Promise.resolve().then(() => claim!(null))
    }
    const action = typeof work === 'function' ? work : () => claim!(lock)
    const result = (queues.get(key) ?? Promise.resolve()).then(action)
    const settled = result.then(release, release)
    queues.set(key, settled)
    function release() {
      if (queues.get(key) === settled) queues.delete(key)
    }
    return result
  } } })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) {
      queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver))
    }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}),
  }))
}
async function mount(url: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(cache)
  const history = createMemoryHistory({ initialEntries: [url] })
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 })
  await router.load()
  const view = render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  await screen.findByRole('region', { name: 'Workflow authoring' })
  return { ...view, cache, router, history }
}
const pinnedCanvas = () => screen.getByRole('region', { name: 'Selected Run pinned topology' })
const inspector = () => screen.getByRole('region', { name: 'Exact execution inputs and results' })
const eventCalls = () => fixture.mock.calls.filter((call) => call.method === 'GET' && call.path.endsWith('/events'))
function clickCiServer(button: HTMLElement) {
  const browserErrors: unknown[] = []
  const recordBrowserError = (event: ErrorEvent) => browserErrors.push(event.error)
  window.addEventListener('error', recordBrowserError)
  try {
    // JSDOM does not provide the pointer view required by canvas panning.
    fireEvent.click(button)
  } finally {
    window.removeEventListener('error', recordBrowserError)
  }
  expect(browserErrors).toEqual([])
}
async function openDetails() {
  const close = screen.queryByRole('button', { name: 'Close Activities' })
  if (!close) await userEvent.setup().click(await screen.findByRole('button', { name: 'Activities' }))
  await screen.findByRole('region', { name: 'Exact execution inputs and results' })
}
async function retainStop(status?: NonNullable<BoardStopJournal['receipt']>['status'], processStopped = false) {
  const scope = fixture.runs.before.scope, journal = await reserveBoardStop(scope)
  if (status) await recordBoardStopReceipt(journal, { runId: scope.runId, status, processStopped, replayed: false })
  return readBoardStop(scope)!
}
beforeEach(async () => {
  unhandled.length = 0
  server.events.on('request:unhandled', recordUnhandled)
  localStorage.clear(); bindMockInstallation(); sessionStorage.clear(); clearBoardStopStorage()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useInspectionPresentation.setState({ open: {} })
  vi.stubGlobal('crypto', webcrypto)
  domInfrastructure()
  fixture = await inspectionBoardFixture(`mounted-inspection-${++number}`)
  server.use(...fixture.mock.handlers)
})
afterEach(() => {
  cleanup()
  window.dispatchEvent(new Event('pagehide'))
  clients.splice(0).forEach((cache) => cache.clear()); clearBoardStopStorage()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useInspectionPresentation.setState({ open: {} })
  server.events.removeListener('request:unhandled', recordUnhandled)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  expect(unhandled, 'No Run inspection request may bypass its MSW service').toEqual([])
})

describe('Run inspection inside the one mounted Board', () => {
  it('opens the idle CI server dialog without browser event errors', async () => {
    const scope = fixture.runs.before.scope
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/ci`, () =>
      HttpResponse.json({ runId: scope.runId, truncated: false, jobs: [] })))
    await mount(href(scope))
    clickCiServer(await screen.findByRole('button', { name: /^CI server, Idle/ }))
    const dialog = await screen.findByRole('dialog', { name: 'CI server' })
    expect(within(dialog).getByText('No CI jobs in this Run yet')).toBeVisible()
    expect(within(dialog).getByRole('tab', { name: 'Tests' })).toBeDisabled()
    expect(within(dialog).getByRole('tab', { name: 'Log' })).toBeDisabled()
  })

  it.each([401, 403])('removes cached CI jobs and node activity after CI-only HTTP %s denial', async status => {
    const scope = fixture.runs.before.scope
    const route = `/api/management/workspaces/${scope.workspaceId}/ci`
    const ticketId = '00000000-0000-4000-8000-000000000001'
    let responseStatus = 200
    server.use(http.get(route, () => responseStatus !== 200
      ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'CI read denied' } }, { status: responseStatus })
      : HttpResponse.json({ runId: scope.runId, truncated: false, jobs: [{ ticketId,
        scope: 'affected', placement: 'host', message: null, tests: { passed: 0, failed: 1, skipped: 0 },
        requester: { executionId: 'ci-owner', agentId: fixture.first.agentId,
          nodeId: fixture.first.id, nodeName: 'CI Agent' },
        ci: { id: ticketId, groupId: '00000000-0000-4000-8000-000000000002',
          suite: 'build', part: 'build-api', partition: null, state: 'running', computer: null,
          step: null, exitCode: null, queuedAt: '2026-10-01T00:00:00.000Z',
          startedAt: null, finishedAt: null } }] })))
    const { cache } = await mount(href(scope))
    expect(await within(pinnedCanvas()).findByText(/CI build-api · running/)).toBeVisible()
    clickCiServer(screen.getByRole('button', { name: /CI server, 1 running/ }))
    const dialog = await screen.findByRole('dialog', { name: 'CI server' })
    expect(within(dialog).getByRole('button', { name: /Show tests of build · build-api/ })).toBeVisible()
    responseStatus = 503
    await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] }) })
    expect(await within(dialog).findByText('The list shows the last jobs read.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: /Show tests of build · build-api/ })).toBeVisible()
    for (const next of [status, 503]) {
      responseStatus = next
      await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] }) })
      await waitFor(() => expect(within(pinnedCanvas()).queryByText(/CI build-api · running/)).not.toBeInTheDocument())
      expect(within(dialog).queryByRole('button', { name: /Show tests of build · build-api/ })).not.toBeInTheDocument()
      expect(within(dialog).getByRole('tab', { name: 'Tests' })).toBeDisabled()
      expect(within(dialog).getByRole('tab', { name: 'Log' })).toBeDisabled()
      expect(screen.getByRole('button', { name: /CI server, CI unavailable/ })).toBeVisible()
      expect(within(pinnedCanvas()).getByRole('heading', {
        name: `Before repeat · Run ${scope.runId} · version ${scope.workflowVersionId}`,
      })).toBeVisible()
    }
  })

  it('loads a pinned Run after claiming tab ownership and returns to the same authoring surface', async () => {
    const scope = fixture.runs.before.scope
    const user = userEvent.setup()
    await mount(href(scope))
    const authoring = await screen.findByRole('region', { name: 'Workflow authoring' })
    const pinned = await screen.findByRole('region', { name: 'Selected Run pinned topology' })
    expect(pinned).toHaveTextContent(scope.workflowVersionId)
    expect(await within(pinned).findByRole('button', {
      name: `Inspect Run node ${fixture.first.name ?? fixture.first.label ?? fixture.first.id}`,
    })).toBeVisible()
    expect(screen.getByLabelText('Editable workflow graph')).toHaveAttribute('aria-hidden', 'true')

    await user.click(screen.getByRole('button', { name: /^Runs$/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'New run' }))

    await waitFor(() => expect(screen.queryByRole('region', {
      name: 'Selected Run pinned topology',
    })).not.toBeInTheDocument())
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(authoring)
    expect(screen.getByLabelText('Editable workflow graph')).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByRole('button', { name: 'Start saved version' })).toBeVisible()
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('shows the originating Agent CI lifecycle on the pinned canvas', async () => {
    const scope = fixture.runs.before.scope
    const ref = { kind: 'ci', workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      runId: scope.runId, workflowVersionId: scope.workflowVersionId, nodeId: fixture.first.id,
      agentId: fixture.first.agentId, executionId: 'ci-owner', attemptKey: '1',
      ticketId: '00000000-0000-4000-8000-000000000001' }
    let state: 'queued' | 'running' | 'passed' = 'queued'
    const route = `/api/management/workspaces/${scope.workspaceId}/ci`
    server.use(http.get(route, () => {
      const ci = { id: ref.ticketId, groupId: '00000000-0000-4000-8000-000000000002',
        suite: 'build', part: 'build-api', partition: null, state, computer: null, step: null, exitCode: null,
        queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null }
      return HttpResponse.json({ runId: scope.runId, truncated: false, jobs: [{
        ticketId: ref.ticketId, scope: 'affected', placement: null, message: null, tests: null, ci,
        requester: { executionId: ref.executionId, agentId: ref.agentId, nodeId: ref.nodeId, nodeName: 'CI Agent' },
      }] })
    }))
    const { cache } = await mount(href(scope))
    expect(await within(pinnedCanvas()).findByText(/CI build-api · queued/)).toBeVisible()
    for (const next of ['running', 'passed'] as const) {
      state = next
      await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] }) })
      expect(await within(pinnedCanvas()).findByText(new RegExp(`CI build-api · ${next}`))).toBeVisible()
    }
  })
  it('shows nested native children on Start-pinned Run links and pages their own recorded items', async () => {
    const scope = fixture.runs.before.scope
    const { workspaceId, workflowId, workflowVersionId, runId } = scope
    const childScope = { workspaceId, workflowId, workflowVersionId, runId }
    const parent = child({ ...childScope, id: 'parent-child', parentNodeId: fixture.first.id,
      parentAgentId: fixture.first.agentId, name: 'Native child' })
    const nested = child({ ...childScope, id: 'nested-child', parentNodeId: fixture.first.id,
      parentAgentId: fixture.first.agentId, parentSubagentId: parent.id, name: 'Nested child' })
    const cursors: string[] = []
    server.use(
      http.get(childRoute, ({ params }) => HttpResponse.json({
        items: params.runId === scope.runId ? [detail(parent), detail(nested)] : [],
        nextCursor: null, projection: 'caught-up',
      })),
      http.get(`${childRoute}/:subagentId`, ({ params }) => HttpResponse.json(detail(
        params.subagentId === nested.id ? nested : parent))),
      http.get(`${childRoute}/:subagentId/messages`, ({ request, params }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        cursors.push(`messages:${cursor ?? 'first'}`)
        return HttpResponse.json({ items: [{ ...message(cursor ?? 'first', cursor ? 'Earlier child answer' : 'Child answer'),
          subagentId: String(params.subagentId) }], nextCursor: cursor ? null : 'messages-next', coverage: parent.coverage })
      }),
      http.get(`${childRoute}/:subagentId/tools`, ({ request, params }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        cursors.push(`tools:${cursor ?? 'first'}`)
        return HttpResponse.json({ items: [{ ...tool(), id: cursor ?? 'first-tool', subagentId: String(params.subagentId) }],
          nextCursor: cursor ? null : 'tools-next', coverage: parent.coverage })
      }),
    )
    const { history } = await mount(`${href(scope)}#keep=anchor`)
    const root = await screen.findByRole('button', { name: 'Native child, Codex, Running' })
    const descendant = await screen.findByRole('button', { name: 'Nested child, Codex, Running' })
    expect(root).toHaveAttribute('data-parent-id', fixture.first.id)
    expect(descendant).toHaveAttribute('data-parent-id', parent.id)
    await userEvent.click(root)
    const panel = await screen.findByRole('dialog', { name: 'Native child' })
    await within(panel).findByText('Child answer')
    expect(history.location.hash).toContain('selectedSubagentId=parent-child')
    expect(within(panel).getByText('Controls are unavailable for this subagent right now.')).toBeVisible()
    expect(within(panel).queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    await userEvent.click(within(panel).getByRole('button', { name: 'Load more messages' }))
    await within(panel).findByText('Earlier child answer')
    await userEvent.click(within(panel).getByRole('tab', { name: /Tool calls/ }))
    await userEvent.click(await within(panel).findByRole('button', { name: 'Load more tool calls' }))
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Load more tool calls' })).not.toBeInTheDocument())
    expect(cursors).toContain('messages:messages-next')
    expect(cursors).toContain('tools:tools-next')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Native child' })).not.toBeInTheDocument())
    expect(root).toHaveFocus()
    expect(history.location.hash).toBe('#keep=anchor')
    await act(async () => { history.back() })
    expect(await screen.findByRole('dialog', { name: 'Native child' })).toBeVisible()
    await act(async () => { history.forward() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Native child' })).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /^Runs$/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'New run' }))
    expect(history.location.hash).toBe('#keep=anchor')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Native child, Codex, Running' })).not.toBeInTheDocument())
  }, 15_000)
  it('switches before/with/after-repeat Runs without changing the draft or its owner', async () => {
    const user = userEvent.setup(), key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId)
    const { router } = await mount(href(fixture.runs.before.scope))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('Before repeat'))
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    const boardElement = screen.getByTestId('unified-workflow-board')
    const authoring = screen.getByRole('region', { name: 'Workflow authoring' })
    const instanceId = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({
      ...graph, nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Keep this unpublished next draft' })),
    })))
    await openDetails()
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: `Open Run ${fixture.runs.repeated.run.id} · completed · succeeded` }))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('With repeat'))
    expect(await within(inspector()).findByRole('combobox', { name: 'Business repetition' })).toBeInTheDocument()
    await user.selectOptions(within(inspector()).getByRole('combobox', { name: 'Run node' }), fixture.second.id)
    await user.click(screen.getByRole('button', { name: `Open Run ${fixture.runs.after.run.id} · completed · succeeded` }))
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('After repeat removed'))
    expect(router.state.location.search).not.toHaveProperty('runNodeId')
    expect(router.state.location.search).not.toHaveProperty('runExchangeKey')
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(screen.getByTestId('unified-workflow-board')).toBe(boardElement)
    expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(authoring)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.instanceId).toBe(instanceId)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!).initialPrompt).toBe('Keep this unpublished next draft')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  }, 10_000)

  it('does not render a node added later or silently retarget its historical deep link', async () => {
    const scope = fixture.runs.before.scope, requests: URLSearchParams[] = []
    server.use(http.get(`${basePath(scope)}/executions`, ({ request }) => {
      requests.push(new URL(request.url).searchParams)
      return fixture.mock.dispatch(request)
    }))
    const { router, cache } = await mount(href(scope, { runNodeId: fixture.added.id }))
    await screen.findByText('The linked node is not in this Run’s saved version.')
    expect(within(pinnedCanvas()).queryByRole('button', { name: 'Inspect Run node Added later' })).not.toBeInTheDocument()
    await screen.findByText('This selection is not in the Run’s saved version.')
    // C's contextual status uses the same endpoint with limit=1. That bounded
    // read is allowed; the unavailable node must not enable B's history query.
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(requests.every((query) => query.get('limit') === '1' && !query.has('workflowNodeId')
      && !query.has('occurrenceId') && !query.has('cursor'))).toBe(true)
    expect(cache.getQueryState(executionPagesKey(scope, { workflowNodeId: fixture.added.id })))
      .toMatchObject({ status: 'pending', fetchStatus: 'idle', data: undefined })
    expect(within(inspector()).queryByRole('listitem')).not.toBeInTheDocument()
    expect(router.state.location.search.runNodeId).toBe(fixture.added.id)
    await userEvent.setup().click(within(inspector()).getByRole('button', { name: 'Clear detail filter' }))
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('runNodeId'))
    await within(inspector()).findByRole('button', { name: new RegExp(fixture.ordinaryExecutions[1]!.detail.execution.executionId) })
    expect(within(inspector()).getByRole('combobox', { name: 'Run node' }).querySelectorAll('option')).toHaveLength(2)
    expect(requests.some((query) => query.get('limit') === '25' && !query.has('workflowNodeId'))).toBe(true)
    expect(requests.some((query) => query.get('workflowNodeId') === fixture.added.id)).toBe(false)
    expect(cache.getQueryState(executionPagesKey(scope, {})))
      .toMatchObject({ status: 'success', fetchStatus: 'idle' })
  })

  it('settles the exact retained Stop with C mounted in the actions slot, without another command or focus move', async () => {
    const scope = fixture.runs.before.scope
    fixture.mock.runs.get(scope.runId)!.cleanupPending = true
    fixture.mock.currents.get(scope.runId)!.state.run.cleanupPending = true
    const journal = await retainStop('accepted')
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    const slot = await screen.findByTestId('run-details-actions-slot')
    await within(slot).findByRole('region', { name: 'Selected Run actions' })
    await waitFor(() => expect(within(slot).getByRole('button', { name: 'Verify cleanup settlement' })).toBeDisabled())
    expect(readBoardStop(scope)).toEqual(journal)
    expect(journal.receipt?.processStopped).toBe(false)
    const focus = screen.getByRole('button', { name: 'Close Activities' })
    focus.focus()
    await act(async () => { fixture.mock.settle(scope.runId); await cache.invalidateQueries() })
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(focus).toHaveFocus()
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it.each(['missing', 'not_owner'] as const)('retains a %s Stop receipt after terminal cleanup readback', async (receipt) => {
    const scope = fixture.runs.before.scope
    const journal = await retainStop(receipt === 'missing' ? undefined : receipt)
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByRole('region', { name: 'Selected Run actions' })
    await screen.findByRole('button', { name: 'Refresh accepted Run facts' })
    await act(async () => { await cache.invalidateQueries() })
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(readBoardStop(scope)).toEqual(journal)
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('does not clear Stop while the canonical cut still reports cleanup, even with private settled readback', async () => {
    const scope = fixture.runs.before.scope, current = fixture.mock.currents.get(scope.runId)!
    current.state.run.cleanupPending = true
    const journal = await retainStop('already_terminal', true)
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByRole('button', { name: 'Refresh accepted Run facts' })
    await screen.findByRole('region', { name: 'Selected Run actions' })
    // Unrelated Board queries keep polling; settlement depends on this Run's readbacks.
    await waitFor(() => expect(cache.getQueryState<typeof current>(currentRunKey(scope))).toMatchObject({
      status: 'success', fetchStatus: 'idle', data: { state: { run: { cleanupPending: true } } },
    }))
    const stop = await screen.findByRole('region', { name: 'Stop and cleanup' })
    await waitFor(() => expect(within(stop).getByRole('button', { name: 'Verify cleanup settlement' })).toBeEnabled())
    expect(readBoardStop(scope)).toEqual(journal)
    await act(async () => {
      current.state.run.cleanupPending = false
      current.asOfSequence = '1'
      await cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true })
    })
    await waitFor(() => expect(cache.getQueryData<typeof current>(currentRunKey(scope))).toMatchObject({
      asOfSequence: '1', state: { run: { cleanupPending: false } },
    }))
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('retains the journal when private Run readback fails and settles only after an explicit successful retry', async () => {
    const scope = fixture.runs.before.scope, journal = await retainStop('accepted')
    let unavailable = true
    server.use(http.get(basePath(scope), ({ request }) => unavailable ? HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Private Run readback is unavailable' },
    }, { status: 503 }) : fixture.mock.dispatch(request)))
    const { cache } = await mount(href(scope, { runNodeId: fixture.first.id }))
    await screen.findByText('Private Run details are unavailable.')
    await screen.findByRole('region', { name: 'Selected Run actions' })
    await waitFor(() => expect(cache.getQueryState(currentRunKey(scope)))
      .toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    expect(readBoardStop(scope)).toEqual(journal)
    unavailable = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry pinned details' }))
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    expect(fixture.mock.calls.filter((call) => call.method === 'POST')).toEqual([])
  })

  it('reopens an occurrence/execution deep link with exact accepted input, result and bindings', async () => {
    const expected = fixture.repeatedExecutions[2]!, id = expected.detail.execution.executionId
    const occurrenceId = expected.detail.execution.occurrence!.occurrenceId
    const url = href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ occurrenceId, executionId: id }) })
    const mounted = await mount(url)
    const article = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(JSON.parse(within(article).getByLabelText(`Input ${id}`).textContent!)).toEqual(expected.detail.acceptedInput.value)
    expect(expected.detail.acceptedResult.status).toBe('accepted')
    if (expected.detail.acceptedResult.status !== 'accepted') throw new Error('Fixture must have an accepted result')
    expect(JSON.parse(within(article).getByLabelText(`Accepted result ${id}`).textContent!)).toEqual(expected.detail.acceptedResult.value)
    expect(within(inspector()).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(occurrenceId)
    expect(fixture.mock.calls.some((call) => call.path.endsWith('/bindings'))).toBe(false)
    fireEvent.click(within(article).getByText('Exact predecessor/result bindings'))
    expect(await within(article).findByLabelText(`Binding ${expected.bindings[0]!.bindingId}`)).toHaveTextContent(expected.detail.acceptedInput.digest)
    fireEvent.click(within(inspector()).getByText('Saved node configuration (this Run)'))
    const saved = await within(inspector()).findByLabelText(`Saved Run node ${fixture.second.id}`)
    expect(JSON.parse(saved.textContent!).node).toEqual(fixture.second)
    expect(saved).not.toHaveTextContent('Current Agent name')
    const reopenedUrl = mounted.router.state.location.href
    mounted.unmount(); mounted.cache.clear()
    act(() => useInspectionPresentation.setState({ open: {} }))
    await mount(reopenedUrl)
    const reopened = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(JSON.parse(within(reopened).getByLabelText(`Accepted result ${id}`).textContent!)).toEqual(expected.detail.acceptedResult.value)
    expect(within(inspector()).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(occurrenceId)
    expect(pinnedCanvas()).toHaveTextContent(fixture.repeated.id)
  })

  it('keeps technical failure separate from accepted result and permits another real attempt', async () => {
    const attempt = fixture.repeatedExecutions[1]!.detail, id = attempt.execution.executionId
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ occurrenceId: attempt.execution.occurrence!.occurrenceId, executionId: id }) }))
    const article = await screen.findByRole('article', { name: `Execution ${id}` })
    expect(within(article).queryByLabelText(`Accepted result ${id}`)).not.toBeInTheDocument()
    expect(article).toHaveTextContent('No accepted result is recorded for this exact execution.')
    expect(within(article).queryByLabelText(`Reported result ${id}`)).not.toBeInTheDocument()
    fireEvent.click(within(article).getByText('Recorded execution result (not proof of acceptance)'))
    expect(await within(article).findByLabelText(`Reported result ${id}`)).toHaveTextContent('FIXTURE_INTERRUPTED')
    const acceptedId = fixture.repeatedExecutions[2]!.detail.execution.executionId
    await userEvent.setup().click(await within(inspector()).findByRole('button', { name: new RegExp(acceptedId) }))
    const accepted = await screen.findByRole('article', { name: `Execution ${acceptedId}` })
    expect(within(accepted).getByLabelText(`Accepted result ${acceptedId}`)).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: `Execution ${id}` })).not.toBeInTheDocument()
  })

  it('loads activity only on expansion, pages it, and refreshes only the first page', async () => {
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id }))
    await screen.findByText('Run activity history')
    expect(eventCalls()).toHaveLength(0)
    const summary = screen.getByText('Run activity history'), history = summary.closest('details')!
    fireEvent.click(summary)
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(50))
    expect(eventCalls()).toHaveLength(1)
    expect(within(history).queryByLabelText(/^Activity /)).not.toBeInTheDocument()
    await userEvent.setup().click(within(history).getByRole('button', { name: 'Load more activity' }))
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(52))
    expect(eventCalls()).toHaveLength(2)
    await userEvent.setup().click(within(history).getByRole('button', { name: 'Refresh activity' }))
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(50))
    expect(eventCalls()).toHaveLength(3)
    fireEvent.click(within(history).getAllByText('Activity details')[0]!)
    expect(await within(history).findByLabelText(`Activity ${fixture.mock.history.get(fixture.runs.repeated.run.id)![0]!.id}`))
      .toHaveTextContent('Historical event 0')
  })

  it('shows unavailable pinned topology without falling back to the current draft', async () => {
    server.use(http.get(`${basePath(fixture.runs.before.scope)}/version`, () => HttpResponse.json({
      error: { code: 'NOT_FOUND', message: 'Immutable version is unavailable' },
    }, { status: 404 })))
    await mount(href(fixture.runs.before.scope))
    await screen.findByText('The selected Run topology is unavailable.')
    expect(within(pinnedCanvas()).queryByLabelText('Run graph canvas')).not.toBeInTheDocument()
    expect(within(pinnedCanvas()).queryByText('After repeat removed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Editable workflow graph')).toHaveAttribute('aria-hidden', 'true')
  })

  it('ignores a late exact execution response after switching Runs', async () => {
    const previous = fixture.repeatedExecutions[2]!.detail
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    let started = false
    server.use(http.get(`${basePath(fixture.runs.repeated.scope)}/executions/${previous.execution.executionId}`, async () => {
      started = true; await pending; return HttpResponse.json(previous)
    }))
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: previous.execution.executionId }) }))
    await waitFor(() => expect(started).toBe(true))
    try {
      await userEvent.setup().click(await screen.findByRole('button', { name: `Open Run ${fixture.runs.before.run.id} · completed · succeeded` }))
      await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('Before repeat'))
    } finally { await act(async () => { release(); await pending }) }
    expect(screen.queryByLabelText(`Accepted result ${previous.execution.executionId}`)).not.toBeInTheDocument()
    expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
  })

  it('keeps exact history available when bounded current-state refresh fails', async () => {
    const expected = fixture.repeatedExecutions[2]!.detail
    server.use(http.get(/\/graph\/.*\/current$/, () => HttpResponse.json({
      error: { code: 'GRAPH_NOT_INITIALIZED', message: 'Current projection is unavailable' },
    }, { status: 503 })))
    await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: expected.execution.executionId }) }))
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    expect(await screen.findByLabelText(`Accepted result ${expected.execution.executionId}`)).toBeInTheDocument()
    await screen.findByText('Current Run state is unavailable.')
    expect(pinnedCanvas()).toHaveTextContent(fixture.repeated.id)
  })

  it('returns keyboard focus to the stable Details trigger when closing the Run drawer', async () => {
    const user = userEvent.setup()
    await mount(href(fixture.runs.before.scope))
    const trigger = await screen.findByRole('button', { name: 'Activities' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await screen.findByRole('button', { name: 'Close Activities' })
    await user.click(screen.getByRole('button', { name: 'Close Activities' }))
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('restores an execution selection through URL back navigation without a separate page', async () => {
    const expected = fixture.repeatedExecutions[2]!.detail
    const { router, history } = await mount(href(fixture.runs.repeated.scope, { runNodeId: fixture.second.id,
      runExchangeKey: runInspectionKey({ executionId: expected.execution.executionId }) }))
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: fixture.mock.workspaceId },
      search: boardSearchForRun({}, fixture.after.workflowId, fixture.runs.after.scope) }) })
    await waitFor(() => expect(pinnedCanvas()).toHaveTextContent('After repeat removed'))
    await act(async () => { history.back() })
    await screen.findByRole('article', { name: `Execution ${expected.execution.executionId}` })
    expect(router.state.location.pathname).toBe(`/workspaces/${fixture.mock.workspaceId}`)
    expect(screen.getAllByTestId('unified-workflow-board')).toHaveLength(1)
  })
})

describe('Live Run status on the Board', () => {
  it('shows turns, CI and pending decisions on Agent nodes without a status strip', async () => {
    const { scope, version, run } = fixture.runs.after
    const first = nativeNode(version.definition.nodes[0]!), added = nativeNode(version.definition.nodes[1]!)
    const nameOf = (node: typeof first) => node.name ?? node.label ?? node.id
    const execution = (node: typeof first, state: 'queued' | 'running' | 'completed') => ({
      identity: { workflowNodeId: node.id, executionId: `exec-live-${node.id}`, agentId: node.agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId]!, attempt: 1, occurrence: null },
      inputDigest: `sha256:${'a'.repeat(64)}`, previousExecutionId: null, state,
      resultOutcome: state === 'completed' ? 'succeeded' : null })
    const base = fixture.mock.currents.get(run.id)!
    const cut = (sequence: string, executionState: 'running' | 'waiting', executions: unknown[]) => fixture.mock.currents.set(run.id,
      RepeatGraphCurrentV3Schema.parse({ ...base, asOfSequence: sequence, state: { ...base.state, executions,
        run: { ...base.state.run, executionState, outcome: 'pending', pendingInteractionCount: executionState === 'waiting' ? 1 : 0 } } }))
    cut('1', 'running', [execution(first, 'running'), execution(added, 'queued')])
    const ticket = '00000000-0000-4000-8000-000000000011'
    let ciState: 'running' | 'passed' | undefined
    const ref = { kind: 'ci', workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
      workflowVersionId: scope.workflowVersionId, executionId: `exec-live-${added.id}`, attemptKey: '1',
      nodeId: added.id, agentId: added.agentId, ticketId: ticket }
    const ciActivity = () => ciState ? {
      id: ticket, groupId: '00000000-0000-4000-8000-000000000012', suite: 'build', part: 'build-api',
      partition: null, state: ciState, exitCode: ciState === 'passed' ? 0 : null, queuedAt: '2026-10-01T00:00:00.000Z',
      startedAt: '2026-10-01T00:00:01.000Z', finishedAt: ciState === 'passed' ? '2026-10-01T00:00:09.000Z' : null,
      computer: { hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'github', slot: 1 }, label: 'GitHub Actions 2' },
      step: 'build-api',
    } : undefined
    const snapshotRoute = `/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/${scope.runId}/snapshot`
    let decision = false
    const interaction = { kind: 'work_direction', id: `work-direction-${run.id}`, revision: 0, workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: run.id, executionId: `exec-live-${added.id}`, requestingAgentId: added.agentId,
      harness: 'codex', providerVersion: 'workflow', nativeSessionId: 'session-live', nativeRequestId: `work-direction-${run.id}`,
      nativeRequestType: 'workflow/work_direction', graphThreadId: run.id, request: { message: 'Accept the remaining findings?' },
      approval: { handler: 'user' }, responseOptions: [{ optionId: 'finish', semantic: 'approve_once', label: 'Finish Run',
        persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
      status: 'pending', deliveryState: 'not_started', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }
    server.use(
      http.get(`/api/management/workspaces/${scope.workspaceId}/ci`, () => {
        const ci = ciActivity()
        return HttpResponse.json({ runId: scope.runId, truncated: false, jobs: ci ? [{
          ticketId: ticket, scope: 'affected', placement: 'github', message: null, tests: null, ci,
          requester: { executionId: ref.executionId, agentId: added.agentId, nodeId: added.id, nodeName: nameOf(added) },
        }] : [] })
      }),
      http.get('/api/management/interactions', () => HttpResponse.json({ items: decision ? [interaction] : [], nextCursor: null })),
      http.get(snapshotRoute, () => {
        const ci = ciActivity()
        return HttpResponse.json({ snapshot: { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
          workflowVersionId: scope.workflowVersionId, kind: 'available', capturedAt: '2026-10-01T00:00:00.000Z',
          nodes: version.definition.nodes.map((node, index) => ({ id: node.id, agentId: nativeNode(node).agentId, name: nameOf(nativeNode(node)),
            agentConfigurationVersionId: version.agentConfigurationVersionIds[nativeNode(node).agentId],
            position: { x: index * 300, y: 0 }, size: { width: 212, height: 212 } })), edges: [] },
        ...(ci ? { activitySnapshot: { schemaVersion: 1, scope: { kind: 'workflow_run', workspaceId: scope.workspaceId,
          workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId }, revision: '1',
          active: ci.state === 'running' ? [{ ref, phase: 'active', evidence: 'confirmed', outcome: null, delivery: null,
            startedAt: ci.startedAt, ci }] : [], queued: [], latest: ref, pendingInteractions: [], activities: [],
          page: { before: null, nextCursor: null, hasMore: false } } } : {}) })
      }),
    )
    const { cache } = await mount(href(scope))
    const agentNode = (node: typeof first) => within(pinnedCanvas()).getByRole('button', { name: `Inspect Run node ${nameOf(node)}` })
      .closest<HTMLElement>('.n-agent')!
    const nodeState = (node: typeof first) => agentNode(node).getAttribute('data-state')
    const advance = async (next: () => void) => act(async () => {
      next()
      await cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true })
      await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'board-activity'] })
      await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] })
    })

    // The first Agent's turn: it is visibly running, the next one is queued, not idle.
    await waitFor(() => expect(nodeState(first)).toBe('running'))
    expect(nodeState(added)).toBe('queued')
    expect(screen.queryByRole('region', { name: 'Run status' })).not.toBeInTheDocument()

    // The turn passes; the second Agent runs CI on a cloud computer. CI lives on the CI server, not in a strip on top.
    ciState = 'running'
    await advance(() => cut('2', 'running', [execution(first, 'completed'), execution(added, 'running')]))
    const ciServerButton = await within(pinnedCanvas()).findByRole('button', { name: /^CI server, 1 running/ })
    expect(screen.queryByRole('list', { name: 'CI jobs' })).not.toBeInTheDocument()
    fireEvent.click(ciServerButton)
    const ciDialog = await screen.findByRole('dialog', { name: 'CI server' })
    const ciRow = within(within(ciDialog).getByRole('region', { name: 'CI jobs' })).getAllByRole('row')[1]!
    for (const text of ['build · build-api', 'GitHub Actions', 'GitHub Actions 2', 'Step build-api', 'Running', nameOf(added)]) {
      expect(ciRow).toHaveTextContent(text)
    }
    await userEvent.setup().click(within(ciDialog).getByRole('button', { name: 'Close CI server' }))
    await waitFor(() => expect(nodeState(added)).toBe('waiting'))
    expect(within(agentNode(added)).getByText('Waiting for CI build-api · running')).toBeVisible()
    expect(nodeState(first)).toBe('completed')
    expect(screen.queryByRole('region', { name: 'Run status' })).not.toBeInTheDocument()

    // CI finished and the second Agent's node now explains the pending decision.
    ciState = 'passed'; decision = true
    await advance(() => cut('3', 'waiting', [execution(first, 'completed'), execution(added, 'completed')]))
    await waitFor(() => expect(within(agentNode(added)).getByText('Waiting for your decision')).toBeVisible())
    expect(nodeState(added)).toBe('waiting')
    expect(screen.queryByRole('region', { name: 'Run status' })).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open human approval inbox, 1 pending' }))
    expect(await screen.findByRole('dialog', { name: 'Human approval inbox' })).toBeVisible()
  }, 15_000)
})

describe('CI server on the Board', () => {
  it('activates with the Run’s CI and opens its jobs, filtered test results and log in the shared dialog', async () => {
    const { scope, version } = fixture.runs.after
    const agent = nativeNode(version.definition.nodes[1]!), name = agent.name ?? agent.label ?? agent.id
    const ticket = '00000000-0000-4000-8000-000000000021'
    const results = { summary: { passed: 1, failed: 1, skipped: 1 }, truncated: false, files: [
      { file: 'apps/api/test/save.test.ts', status: 'failed', durationMs: 1200, tests: [
        { name: 'save rejects a stale revision', status: 'failed', durationMs: 800, message: 'expected 409 to be 200' },
        { name: 'save writes the record', status: 'passed', durationMs: 400 }] },
      { file: 'apps/api/test/later.test.ts', status: 'skipped', durationMs: 3, tests: [
        { name: 'later waits for a computer', status: 'skipped', durationMs: null }] }] }
    const job = (state: 'running' | 'failed') => ({ ticketId: ticket, scope: 'affected', placement: 'github', message: null,
      requester: { executionId: 'exec-ci', agentId: agent.agentId, nodeId: agent.id, nodeName: name },
      tests: state === 'failed' ? results.summary : null,
      ci: { id: ticket, groupId: '00000000-0000-4000-8000-000000000022', suite: 'unit', part: 'unit-api', partition: null, state,
        exitCode: state === 'failed' ? 1 : null, queuedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:01.000Z',
        finishedAt: state === 'failed' ? '2026-10-01T00:02:01.000Z' : null, step: 'unit-api',
        computer: { hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'github', slot: 0 }, label: 'GitHub Actions 1' } } })
    let jobs: unknown[] = []
    const requested: (string | null)[] = []
    let logReads = 0
    const ci = `/api/management/workspaces/${scope.workspaceId}/ci`
    server.use(
      http.get(`/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/${scope.runId}/snapshot`,
        () => HttpResponse.json({ error: { code: 'DATABASE_READ_TIMEOUT', message: 'Snapshot read timed out' } }, { status: 503 })),
      http.get(ci, ({ request }) => HttpResponse.json({ runId: new URL(request.url).searchParams.get('runId'), jobs, truncated: false })),
      http.get(`${ci}/${ticket}/tests`, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')
        requested.push(status)
        const wanted = status?.split(',') ?? ['passed', 'failed', 'skipped']
        return HttpResponse.json({ ticketId: ticket, tests: { ...results, files: results.files.flatMap((file) => {
          const tests = file.tests.filter((test) => wanted.includes(test.status))
          return tests.length ? [{ ...file, tests }] : []
        }) } })
      }),
      http.get(`${ci}/${ticket}/logs`, () => { logReads++; return HttpResponse.json({ text: '::step unit-api\nTests  1 failed | 1 passed', nextOffset: 40, logBytes: 40, maxBytes: 65_536 }) }),
    )
    const { cache } = await mount(href(scope))
    const serverNode = async (label: RegExp) => (await within(pinnedCanvas()).findByRole('button', { name: label })).closest<HTMLElement>('.ci-server-node')!
    const refresh = () => act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] }) })

    // Idle without CI; it runs (with the node activity styling) while an Agent's ticket runs, then shows the result.
    expect((await serverNode(/^CI server, Idle/)).getAttribute('data-state')).toBe('idle')
    jobs = [job('running')]
    await refresh()
    expect((await serverNode(/^CI server, 1 running/)).getAttribute('data-state')).toBe('running')
    const agentNode = within(pinnedCanvas()).getByRole('button', { name: `Inspect Run node ${name}` }).closest<HTMLElement>('.n-agent')!
    await waitFor(() => expect(agentNode).toHaveAttribute('data-state', 'waiting'))
    expect(agentNode).toHaveTextContent('Waiting for CI unit-api · running')
    expect(screen.queryByRole('region', { name: 'Run status' })).not.toBeInTheDocument()

    // The request travels as a light from the Agent to the server, and the result travels back; no lasting line.
    const light = () => pinnedCanvas().querySelector('.ci-transfer')
    await waitFor(() => expect(light()).toHaveTextContent('CI request'))
    jobs = [job('failed')]
    await refresh()
    const failed = await serverNode(/^CI server, Last CI failed/)
    expect(failed.getAttribute('data-state')).toBe('failed')
    await waitFor(() => expect(agentNode).toHaveTextContent('CI unit-api · failed'))
    await waitFor(() => expect(light()).toHaveTextContent('CI failed'))
    await waitFor(() => expect(light()).toBeNull(), { timeout: 8000 })

    // The server opens the shared dialog; a job row opens its tests.
    // A click on the canvas (jsdom has no pointer view for the canvas pan handler).
    fireEvent.click(within(failed).getByRole('button', { name: /^CI server/ }))
    const user = userEvent.setup()
    const dialog = await screen.findByRole('dialog', { name: 'CI server' })
    const row = within(within(dialog).getByRole('region', { name: 'CI jobs' })).getAllByRole('row')[1]!
    for (const text of ['unit · unit-api', 'Affected', 'GitHub Actions', 'GitHub Actions 1', 'Failed', '1 passed · 1 failed · 1 skipped', name, '2m 0s']) {
      expect(row).toHaveTextContent(text)
    }
    await user.click(within(row).getByRole('button', { name: `Show tests of unit · unit-api requested by ${name}` }))
    expect(within(dialog).getByRole('tab', { name: 'Tests' })).toHaveAttribute('aria-selected', 'true')
    const tests = await within(dialog).findByRole('list', { name: 'Test results' })
    expect(within(dialog).getByText(`Requested by ${name}`)).toBeVisible()
    expect(tests).toHaveTextContent('save rejects a stale revision')
    expect(tests).toHaveTextContent('expected 409 to be 200')
    expect(tests).toHaveTextContent('save writes the record')
    expect(tests).toHaveTextContent('later waits for a computer')
    expect(requested).toEqual([null])

    // Status chips filter through the same read the Operator uses (ci_get testStatus).
    const filters = within(dialog).getByRole('group', { name: 'Show tests by status' })
    await user.click(within(filters).getByRole('button', { name: 'Passed 1' }))
    await user.click(within(filters).getByRole('button', { name: 'Skipped 1' }))
    expect(within(filters).getByRole('button', { name: 'Failed 1' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(requested.at(-1)).toBe('failed'))
    await waitFor(() => expect(within(dialog).getByRole('list', { name: 'Test results' })).not.toHaveTextContent('save writes the record'))
    expect(within(dialog).getByRole('list', { name: 'Test results' })).toHaveTextContent('save rejects a stale revision')
    expect(within(dialog).getByRole('list', { name: 'Test results' })).not.toHaveTextContent('later waits for a computer')

    await user.click(within(dialog).getByRole('tab', { name: 'Log' }))
    expect(await within(dialog).findByLabelText('Log tail')).toHaveTextContent('Tests 1 failed | 1 passed')
    // The filter survives a visit to another tab.
    await user.click(within(dialog).getByRole('tab', { name: 'Tests' }))
    const kept = within(dialog).getByRole('group', { name: 'Show tests by status' })
    expect(within(kept).getByRole('button', { name: 'Passed 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(kept).getByRole('button', { name: 'Skipped 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(await within(dialog).findByRole('list', { name: 'Test results' })).not.toHaveTextContent('save writes the record')
    expect(requested.at(-1)).toBe('failed')
    await user.click(within(dialog).getByRole('tab', { name: 'Log' }))
    await within(dialog).findByLabelText('Log tail')
    await user.click(within(dialog).getByRole('button', { name: 'Close CI server' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'CI server' })).not.toBeInTheDocument())
    // Closed from the Log tab, the dialog reads no log, even when the job runs again.
    const reads = logReads
    jobs = [job('running')]
    await refresh()
    await serverNode(/^CI server, 1 running/)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
    expect(logReads).toBe(reads)
  }, 20_000)

  it('keeps the CI server state but sends no lights under reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query,
      addEventListener() {}, removeEventListener() {} }))
    const { scope, version } = fixture.runs.after
    const agent = nativeNode(version.definition.nodes[0]!)
    let jobs: unknown[] = []
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/ci`, () => HttpResponse.json({ runId: scope.runId, jobs, truncated: false })))
    const { cache } = await mount(href(scope))
    await within(pinnedCanvas()).findByRole('button', { name: /^CI server, Idle/ })
    jobs = [{ ticketId: '00000000-0000-4000-8000-000000000031', scope: 'full', placement: 'host', message: null, tests: null,
      requester: { executionId: 'exec-ci', agentId: agent.agentId, nodeId: agent.id, nodeName: 'Coder' },
      ci: { id: '00000000-0000-4000-8000-000000000031', groupId: '00000000-0000-4000-8000-000000000032', suite: 'lint',
        part: 'lint-api', partition: null, state: 'running', exitCode: null, queuedAt: '2026-10-01T00:00:00.000Z',
        startedAt: '2026-10-01T00:00:01.000Z', finishedAt: null, step: 'lint-api',
        computer: { hostRef: { kind: 'main', mainId: 'main-1' }, label: 'Main computer' } } }]
    await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] }) })
    const node = (await within(pinnedCanvas()).findByRole('button', { name: /^CI server, 1 running/ })).closest('.ci-server-node')
    expect(node).toHaveAttribute('data-state', 'running')
    expect(pinnedCanvas().querySelector('.ci-transfer')).toBeNull()
  })
})

it('inspects an immutable Run node named ci-server independently of its CI tower', async () => {
  const uncaughtError = vi.fn()
  window.addEventListener('error', uncaughtError)
  try {
    fixture = await inspectionBoardFixture('ci-node-collision', 'ci-server')
    server.use(...fixture.mock.handlers)
    await mount(href(fixture.runs.before.scope))
    const canvas = pinnedCanvas()
    const owner = await within(canvas).findByRole('button', { name: `Inspect Run node ${fixture.first.name}` })
    expect(owner.closest('.react-flow__node')).toHaveAttribute('data-id', 'ci-server')
    // jsdom mouse-down events lack the window view required by the canvas drag handlers.
    fireEvent.click(owner)
    await openDetails()
    await userEvent.setup().selectOptions(within(inspector()).getByRole('combobox', { name: 'Run node' }), 'ci-server')
    expect(within(inspector()).getByRole('combobox', { name: 'Run node' })).toHaveValue('ci-server')
    const tower = await within(canvas).findByRole('button', { name: /^CI server, Idle/ })
    expect(tower.closest('.react-flow__node')).not.toBe(owner.closest('.react-flow__node'))
    fireEvent.click(tower)
    expect(await screen.findByRole('dialog', { name: 'CI server' })).toBeVisible()
    expect(fixture.runs.before.version.definition.nodes[0]!.id).toBe('ci-server')
    expect(uncaughtError).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('error', uncaughtError)
  }
})

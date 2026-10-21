import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { type WorkflowDefinitionV3, WorkflowVersionV3Schema, CurrentWorkflowCreateInputSchema, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey, nextDraftDirty } from '../graph/nextDraft/state'
import { attachAgent } from '../graph/nextDraft/model'
import { readBoardStart } from './startOutbox'
import { readBoardStop } from './stopOutbox'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { queryKeys } from '../../shared/api/query'
import { readLocalHumanAccess } from '../../shared/api/settingsExperience'
import { boardDraftContextKey } from './keys'
import { clickConnectionHandles } from '../graph/testConnectionHandles'
import { worktreeFixture } from './worktree.fixtures'

// The route tree, RootShell, sidebar, creation dialog, persisted boundary, Board,
// canvas, form, Query hooks, Zustand store, HTTP clients and schemas are REAL.
// Only HTTP and absent JSDOM measurement/locking APIs are fixtures. This is source
// acceptance, not an authenticated real-browser/PostgreSQL/native success claim.
type Mock = ReturnType<typeof createCurrentBoardMock>
type Shape = 'single' | 'sequential' | 'parallel' | 'conditional' | 'approval' | 'repeat-ready'
const clients: QueryClient[] = []
const unhandledRequests: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => {
  unhandledRequests.push(`${request.method} ${request.url}`)
}
// Scope role queries to small control surfaces instead of repeatedly scanning
// every Agent action and hidden panel in the real React Flow canvas.
const authoring = () => screen.getByRole('region', { name: 'Workflow authoring' })
const controls = () => within(authoring()).getByRole('group', { name: 'Workflow controls' })
const control = (name: string) => within(controls()).getByRole('button', { name })
const saveButton = () => within(screen.getByRole('region', { name: 'Workflow authoring' }))
  .getByRole('button', { name: /^Save workflow$/ })
let fixtureNumber = 0
function newBoardMock(options: Parameters<typeof createCurrentBoardMock>[0] = {}) {
  // Separate synthetic backends must not alias the module-level local-draft cache.
  // A reopen deliberately retains this same factory and workspace identity.
  return createCurrentBoardMock({ ...options, workspaceId: `ws-board-case-${++fixtureNumber}` })
}
function locks() {
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, action: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof action !== 'function') return claim!({ name: key })
    const result = (queues.get(key) ?? Promise.resolve()).then(action)
    queues.set(key, result.catch(() => {
      // ignore: the caller receives the rejection through result; later lock requests must still run.
    }))
    return result
  } } })
}
configure({ asyncUtilTimeout: 5000 })
beforeEach(() => {
  unhandledRequests.length = 0; server.events.on('request:unhandled', recordUnhandled)
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); localStorage.setItem('graphql.chat-instance-binding', `${mockRuntimeIdentity.checkoutId}:${mockRuntimeIdentity.installationId}`); sessionStorage.clear(); locks()
  // DOM infrastructure only; never stub a Board/editor/React Flow component.
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}) }))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  server.events.removeListener('request:unhandled', recordUnhandled)
  expect(unhandledRequests, 'No unhandled Board request may bypass MSW').toEqual([])
})

async function mount(mock: Mock, href = `/workspaces/${mock.workspaceId}`) {
  server.use(...mock.handlers)
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(query)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [href] }), defaultPendingMinMs: 0 })
  // Complete initial memory routing before mounting; do not race a second load
  // against RouterProvider. Query/HTTP work still runs through the real controls.
  await router.load()
  const result = render(<QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>)
  return { ...result, router, query }
}
async function create(mock: Mock, user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'New workflow' }))
  const dialog = await screen.findByRole('dialog', { name: 'New workflow' })
  const name = within(dialog).getByRole('textbox', { name: 'Name' })
  await user.click(name)
  await user.paste('S3 mounted workflow')
  expect(name).toHaveValue('S3 mounted workflow')
  await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }))
  await screen.findByTestId('unified-workflow-board')
  await screen.findByRole('region', { name: 'Workflow authoring' })
  const id = [...mock.workflows.keys()].at(-1)!
  const key = nextDraftKey(mock.workspaceId, id)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  const creation = mock.calls.find((call) => call.method === 'POST' && call.path.endsWith('/workflows'))!
  expect(CurrentWorkflowCreateInputSchema.parse(creation.body).executionSemanticsVersion).toBe(3)
  expect(mock.workflows.get(id)).not.toHaveProperty('repeat')
  return { id, key }
}
function shapeGraph(base: WorkflowDefinitionV3, shape: Shape, mock: Mock): WorkflowDefinitionV3 {
  const count = shape === 'single' ? 1 : shape === 'parallel' ? 5 : shape === 'conditional' ? 3 : 2
  const nodes = mock.agents.slice(0, count).map((agent, i) => ({ id: `node-${agent.id}`, agentId: agent.id, name: agent.name,
    position: { x: i * 250, y: i % 2 * 180 }, ...(shape === 'parallel' && i === 4 ? { join: { mode: 'all' as const } } : {}) }))
  const pairs = shape === 'single' ? [] : shape === 'parallel' ? [[0, 1], [0, 2], [2, 3], [1, 4], [3, 4]]
    : shape === 'conditional' ? [[0, 1], [0, 2]] : [[0, 1]]
  const edges = pairs.map(([from, to], i) => ({ id: `handoff-${i}`, source: nodes[from!]!.id, target: nodes[to!]!.id, kind: 'execution' as const }))
  const graph: WorkflowDefinitionV3 = { ...base, nodes, edges, entryNodeId: nodes[0]!.id, approval: { handler: 'user' },
    executionPolicy: { maxParallelism: 4, maxNodeExecutions: 40 } }
  if (shape === 'conditional') nativeNode(graph.nodes[0]!).choice = { outcomes: edges.map((edge, i) => ({ outcome: i ? 'right' : 'left', target: { kind: 'edge', relationshipId: edge.id } })) }
  if (shape === 'repeat-ready') nativeNode(graph.nodes[1]!).choice = { outcomes: [
    { outcome: 'again', target: { kind: 'branch_end' } }, { outcome: 'done', target: { kind: 'branch_end' } },
  ] }
  if (shape === 'approval') nativeNode(graph.nodes[1]!).initialPrompt = 'Request the configured user approval before a sensitive operation.'
  return graph
}
function stageShape(key: string, shape: Shape, mock: Mock) {
  // Seed the local form through its public Zustand interaction boundary. Save,
  // reopen and Start below still traverse the real mounted controls and HTTP.
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => shapeGraph(graph, shape, mock)))
}
async function save(mock: Mock, user: ReturnType<typeof userEvent.setup>, expectedVersions: number) {
  await user.click(saveButton())
  await waitFor(() => expect(mock.versions.size === expectedVersions
    || !!screen.queryByRole('alertdialog', { name: 'Stop running work and save?' })).toBe(true))
  const dialog = screen.queryByRole('alertdialog', { name: 'Stop running work and save?' })
  if (dialog) await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
  await waitFor(() => expect(mock.versions.size).toBe(expectedVersions))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save workflow' })).not.toBeInTheDocument())
  expect(within(authoring()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
  const version = [...mock.versions.values()].at(-1)!
  expect(WorkflowVersionV3Schema.parse(version).executionSemanticsVersion).toBe(3)
  return version
}
async function start(mock: Mock, user: ReturnType<typeof userEvent.setup>, expectedRuns = 1) {
  const button = control('Start saved version')
  await waitFor(() => expect(button, button.title).toBeEnabled())
  await user.click(button)
  await waitFor(() => expect(mock.runs.size).toBe(expectedRuns))
  const run = [...mock.runs.values()].at(-1)!.run
  await waitFor(() => expect(readBoardStart(nextDraftKey(mock.workspaceId, run.workflowId))).toBeUndefined())
  // A started Run is shown as its saved Board; the retained editor is hidden until the person returns to it.
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reconcile Start', hidden: true })).not.toBeInTheDocument())
  return run
}
async function returnToDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Return to workflow' }))
  await screen.findByRole('region', { name: 'Workflow authoring' })
}

describe('ENG-S3-ONLY actual registered Board / shared current HTTP', () => {
  it('saves the topbar worktree draft and restores its persisted selection when the Board reopens', async () => {
    const mock = newBoardMock()
    const user = userEvent.setup()
    const mounted = await mount(mock)
    const project = worktreeFixture(mock.workspaceId)
    const path = `/api/management/workspaces/${mock.workspaceId}`
    const sourceHandlers = [
      http.get(`${path}/source-roots`, () => HttpResponse.json({ items: [project.root], readiness: 'metadata-only' })),
      http.get(`${path}/root-policies`, () => HttpResponse.json({ workspaceId: mock.workspaceId,
        policies: [project.location.binding], allowlists: [], readiness: 'metadata-only' })),
      http.post(`${path}/sources/get`, () => HttpResponse.json(project.source)),
      http.get(`${path}/repository`, () => HttpResponse.json(project.ready)),
      http.get(path, () => HttpResponse.json({ workspace: { id: mock.workspaceId, name: 'Website', repository: project.repository },
        revision: 2, archivedAt: null, executionLocation: project.location.executionLocation, locationRevision: 1,
        locationValidation: { status: 'ready', checkedAt: project.source.approvedAt } })),
    ]
    server.use(...sourceHandlers)
    mock.handlers.unshift(...sourceHandlers)
    const { id, key } = await create(mock, user)
    stageShape(key, 'single', mock)
    await user.click(screen.getByRole('button', { name: /^Worktree:/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Default worktree' })
    const workspaceProject = await within(dialog).findByRole('button', { name: 'Use workspace project' })
    await waitFor(() => expect(workspaceProject).toBeEnabled())
    await user.click(workspaceProject)
    await user.type(within(dialog).getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/site')
    await user.click(within(dialog).getByRole('button', { name: 'Apply worktree' }))
    // The worktree line marks an unsaved choice until Save.
    const worktree = () => screen.getByRole('button', { name: /^Worktree:/ })
    expect(worktree()).toHaveAccessibleName(/\(unsaved\)$/)
    expect(mock.workflows.get(id)).not.toHaveProperty('defaultWorktree')
    const version = await save(mock, user, 1)
    expect(version.definition.defaultWorktree).toEqual({ rootBinding: project.rootBinding, branchPrefix: 'foreman/site' })
    mounted.unmount()
    await mount(mock, `/workspaces/${mock.workspaceId}?workflowId=${id}`)
    expect(await screen.findByRole('button', { name: /^Worktree:/ })).toHaveTextContent('Main · octo-owner/website')
    expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.defaultWorktree).toEqual(version.definition.defaultWorktree)
    expect(worktree()).not.toHaveAccessibleName(/unsaved/)
  }, 15_000)
  it('puts unavailable update reads in recovery rows without losing local edits or relaxing fresh Start reads', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup()
    const mounted = await mount(mock)
    const { id, key } = await create(mock, user)
    stageShape(key, 'single', mock)
    const saved = await save(mock, user, 1)
    await waitFor(() => expect(control('Start saved version')).toBeEnabled())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let workspaceAvailable = false, draftAvailable = false
    const unavailable = () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Updates unavailable.' } }, { status: 503 })
    server.use(
      http.get(`/api/workspaces/${mock.workspaceId}`, () => workspaceAvailable ? HttpResponse.json(mock.details()) : unavailable()),
      http.get(`/api/management/workspaces/${mock.workspaceId}/workflows/${id}`, () => draftAvailable ? HttpResponse.json(mock.managed(id)) : unavailable()),
    )
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(mock.workspaceId) })
    await mounted.query.invalidateQueries({ queryKey: boardDraftContextKey(mock.workspaceId, id) })
    await mounted.query.invalidateQueries({ queryKey: ['workbench', 'board-start-preflight'] })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflow alerts, 2' })).toBeVisible())
    expect(control('Start saved version')).toBeDisabled()
    expect(readBoardStart(key)).toBeUndefined()
    expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toEqual([])
    expect(screen.queryByText('Workspace updates are unavailable. The local draft is retained.')).not.toBeInTheDocument()
    expect(screen.queryByText('Draft updates are unavailable. Start requires a fresh verified saved read.')).not.toBeInTheDocument()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Retained through unavailable updates' })))
    const local = useGraphDraftStore.getState().nextDrafts[key]!
    await user.click(screen.getByRole('button', { name: 'Workflow alerts, 2' }))
    const dialog = screen.getByRole('dialog', { name: 'Workflow alerts' })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2)
    expect(within(dialog).getByText('Workspace updates unavailable. Local edits are kept.')).toBeVisible()
    expect(within(dialog).getByText('Draft updates unavailable. Running requires a fresh saved read.')).toBeVisible()
    workspaceAvailable = true
    await user.click(within(dialog).getByRole('button', { name: 'Retry workspace updates' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Workflow alerts, 1' })).toBeVisible())
    draftAvailable = true
    await user.click(within(dialog).getByRole('button', { name: 'Retry draft updates' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Workflow alerts/ })).not.toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: 'Workflow alerts' })).not.toBeInTheDocument()
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).toBe(local.graph)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.context.draft.baseWorkflowVersionId).toBe(saved.id)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(true)
    expect(mock.versions.size).toBe(1)
    expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toEqual([])
  }, 20_000)

  it('keeps real alerts outside the top toolbar and opens workflow history from an accessible Activities icon', async () => {
    const mock = newBoardMock(), user = userEvent.setup()
    const mounted = await mount(mock)
    const { key } = await create(mock, user)
    const alert = within(authoring()).getByRole('button', { name: /Workflow alerts, [1-9]/ })
    expect(alert.closest('.board-alerts')?.parentElement).toHaveClass('workflow-graph-canvas')
    expect(alert.closest('.board-topbar')).toBeNull()
    expect(within(controls()).queryByRole('button', { name: /Workflow alerts/ })).not.toBeInTheDocument()
    const activities = control('Activities')
    expect(activities).toHaveClass('n-icon-button')
    expect(activities).toHaveAttribute('title', 'Activities')
    expect(activities.textContent).toBe('')
    expect(activities.querySelector('svg')).toBeInTheDocument()
    const selection = mounted.router.state.location.search
    await user.click(activities)
    const history = screen.getByRole('region', { name: 'Activities popover' })
    expect(history).toHaveTextContent('No runs yet')
    expect(mounted.router.state.location.search).toEqual(selection)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: 'Activities popover' })).not.toBeInTheDocument()
    expect(activities).toHaveFocus()
    stageShape(key, 'single', mock)
    await waitFor(() => expect(within(authoring()).queryByRole('button', { name: /Workflow alerts/ })).not.toBeInTheDocument())
  }, 15_000)

  it('keeps saved Board actions hidden for inspection and no-ops, and hides them again after Undo', async () => {
    const mock = newBoardMock(), user = userEvent.setup()
    await mount(mock)
    const { key } = await create(mock, user)
    stageShape(key, 'single', mock)
    await save(mock, user, 1)
    const initial = useGraphDraftStore.getState().nextDrafts[key]!
    const assertClean = () => {
      expect(screen.queryByRole('group', { name: 'Draft actions' })).not.toBeInTheDocument()
      expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
      expect(useGraphDraftStore.getState().nextDrafts[key]!.history).toHaveLength(initial.history.length)
    }
    await user.keyboard('{Control>}z{/Control}')
    assertClean()
    await user.click(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' }))
    await user.keyboard('Canceled title{Escape}')
    assertClean()
    await user.click(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' }))
    await user.keyboard('{Enter}')
    assertClean()
    await user.click(control('Workflow actions'))
    await user.keyboard('{Escape}')
    assertClean()
    await user.click(control('Workflow settings'))
    await user.click(screen.getByRole('button', { name: 'Close panel' }))
    assertClean()
    const canvas = within(screen.getByLabelText('Editable workflow graph'))
    fireEvent.click(canvas.getByRole('button', { name: new RegExp(`^${mock.agents[0]!.name},`) }))
    await waitFor(() => expect(canvas.getByRole('button', { name: new RegExp(`^${mock.agents[0]!.name},`) })).toHaveAttribute('aria-pressed', 'true'))
    assertClean()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...structuredClone(graph), updatedAt: '2026-10-02T00:00:00Z' })))
    assertClean()
    await user.click(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' }))
    await user.keyboard('Meaningful name{Enter}')
    await user.click(within(await screen.findByRole('dialog', { name: 'Rename workflow?' })).getByRole('button', { name: 'Rename' }))
    expect(screen.getByRole('group', { name: 'Draft actions' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    // Undo leaves only Redo; the Board says what it changed back.
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(within(screen.getByRole('group', { name: 'Draft actions' })).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Redo'])
    expect(await screen.findByText('Undid workflow name “S3 mounted workflow” → “Meaningful name”', { selector: '.board-undo-notice span' })).toBeVisible()
    expect(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' })).toBeVisible()
    expect(mock.versions.size).toBe(1)
  }, 20_000)

  it('offers Save for an unpublished initial definition even without local edits', async () => {
    const mock = newBoardMock(), user = userEvent.setup()
    const workflowId = 'unpublished-initial'
    const graph = shapeGraph({ id: workflowId, workspaceId: mock.workspaceId, name: 'Unpublished initial',
      executionSemanticsVersion: 3, version: 1, nodes: [], edges: [], entryNodeId: null, executionCondition: { kind: 'manual' } }, 'single', mock)
    mock.install(graph, false)
    await mount(mock, `/workspaces/${mock.workspaceId}?workflowId=${workflowId}`)
    const key = nextDraftKey(mock.workspaceId, workflowId)
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(screen.getByRole('group', { name: 'Draft actions' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
    const version = await save(mock, user, 1)
    expect(version.definition.name).toBe(graph.name)
    expect(version.definition.nodes).toEqual(graph.nodes)
  }, 15_000)

  it('renames from the board title, cancels with Escape, and persists through Save beside Discard', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup()
    await mount(mock)
    const { key } = await create(mock, user)
    stageShape(key, 'single', mock)
    const editor = authoring(), canvas = screen.getByLabelText('Editable workflow graph'), href = window.location.href
    const title = screen.getByRole('heading', { name: 'S3 mounted workflow' })
    await user.click(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' }))
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'S3 mounted workflow' })).toBe(title)
    expect(authoring()).toBe(editor); expect(screen.getByLabelText('Editable workflow graph')).toBe(canvas)
    expect(window.location.href).toBe(href)
    await user.keyboard('Canceled name{Escape}')
    expect(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' })).toBeVisible()
    expect(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' })).toHaveFocus()
    await user.click(within(authoring()).getByRole('button', { name: 'S3 mounted workflow' }))
    await user.keyboard('Renamed board{Enter}')
    await user.click(within(await screen.findByRole('dialog', { name: 'Rename workflow?' })).getByRole('button', { name: 'Rename' }))
    expect(screen.getByRole('button', { name: 'Renamed board' })).toBeVisible()
    const actions = within(screen.getByRole('group', { name: 'Draft actions' }))
    expect(actions.getByRole('button', { name: 'Save workflow' })).toBeVisible()
    expect(within(controls()).getByRole('button', { name: 'Workflow actions' })).toBeVisible()
    expect(within(title.parentElement!).queryByRole('button', { name: 'Workflow actions' })).not.toBeInTheDocument()
    const version = await save(mock, user, 1)
    expect(version.definition.name).toBe('Renamed board')
    await user.click(screen.getByRole('button', { name: 'Workflow actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.getByRole('textbox', { name: 'Workflow name' })).toHaveFocus()
    await user.keyboard('Menu renamed board{Enter}')
    await user.click(within(await screen.findByRole('dialog', { name: 'Rename workflow?' })).getByRole('button', { name: 'Rename' }))
    const menuVersion = await save(mock, user, 2)
    expect(menuVersion.definition.name).toBe('Menu renamed board')
    await user.click(screen.getByRole('button', { name: 'Workflow actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove workflow' }))
    const removal = screen.getByRole('dialog', { name: 'Remove Menu renamed board?' })
    expect(removal).toHaveTextContent('Workflows with active runs cannot be removed.')
    await user.click(within(removal).getByRole('button', { name: 'Cancel' }))
    expect(within(authoring()).getByRole('button', { name: 'Menu renamed board' })).toBeVisible()
    server.use(http.delete(`/api/management/workspaces/${mock.workspaceId}/workflows/:workflowId`, () =>
      HttpResponse.json({ error: { code: 'ACTIVE_RUN', message: 'Stop active runs before removing this workflow.' } }, { status: 409 })))
    await user.click(screen.getByRole('button', { name: 'Workflow actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove workflow' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Remove Menu renamed board?' })).getByRole('button', { name: 'Remove workflow' }))
    expect(await screen.findByText('Stop active runs before removing this workflow.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(within(authoring()).getByRole('button', { name: 'Menu renamed board' })).toBeVisible()
  }, 15_000)
  it('saves before starting the exact newly published version from Save and run', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup()
    await mount(mock)
    const { key } = await create(mock, user)
    expect(within(authoring()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
    expect(within(authoring()).queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Zoom In|Zoom Out|Fit View/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(control('Save and run')).toBeDisabled()
    expect(control('Save and run')).toHaveAttribute('title', 'Add an agent before saving and running')
    await user.click(control('Save and run'))
    expect(mock.runs.size).toBe(0)
    expect(mock.versions.size).toBe(0)
    stageShape(key, 'sequential', mock)
    await waitFor(() => expect(control('Save and run')).toBeEnabled())
    expect(screen.queryByText('Start is not ready.')).not.toBeInTheDocument()
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument()
    await user.click(control('Save and run'))
    await waitFor(() => expect(mock.runs.size).toBe(1))
    const version = [...mock.versions.values()].at(-1)!
    expect([...mock.runs.values()][0]!.run.workflowVersionId).toBe(version.id)
    await returnToDraft(user)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(within(authoring()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
  })

  it('adds Agents from the role menu and connects handles with undo and redo', async () => {
    const mock = newBoardMock(), user = userEvent.setup()
    await mount(mock)
    // A node that was never saved has no saved chat target.
    server.use(http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat/target',
      () => HttpResponse.json({ kind: 'unavailable', reason: 'NODE_UNAVAILABLE' })))
    const { key } = await create(mock, user)
    for (let added = 0; added < 2; added++) {
      await user.click(control('Add agent'))
      const worker = within(screen.getByRole('menu', { name: 'Add agent' })).getByRole('menuitem', { name: 'Worker' })
      await waitFor(() => expect(worker).not.toHaveAttribute('aria-disabled'))
      await user.click(worker)
    }
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes.map(node => node.name)).toEqual(['Worker', 'Worker 2'])
    const draftActions = within(screen.getByRole('group', { name: 'Draft actions' }))
    expect(draftActions.getByRole('button', { name: 'Discard changes' })).toBeVisible()
    expect(draftActions.getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Undo', 'Discard changes', 'Save workflow'])
    expect(within(controls()).queryByRole('button', { name: 'Save workflow' })).not.toBeInTheDocument()
    expect(within(controls()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
    await user.keyboard('{Control>}z{/Control}{Control>}z{/Control}')
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes).toHaveLength(0))
    expect(within(authoring()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
    await user.keyboard('{Control>}y{/Control}{Control>}y{/Control}')
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes).toHaveLength(2))
    stageShape(key, 'sequential', mock)
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, edges: [] })))
    const canvas = within(screen.getByLabelText('Editable workflow graph'))
    fireEvent.click(canvas.getByRole('button', { name: new RegExp(`^${mock.agents[0]!.name},`) }))
    await waitFor(() => expect(canvas.getByRole('button', { name: new RegExp(`^${mock.agents[0]!.name},`) })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.queryByRole('dialog', { name: `${mock.agents[0]!.name} chat` })).not.toBeInTheDocument()
    fireEvent.click(canvas.getByRole('button', { name: `Open ${mock.agents[0]!.name} chat` }))
    fireEvent.click(canvas.getByRole('button', { name: `Open ${mock.agents[1]!.name} chat` }))
    const chat = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(chat).toBeVisible()
    expect(screen.queryByRole('dialog', { name: / chat$/ })).not.toBeInTheDocument()
    expect(await within(chat).findByText('This Agent is not present in the selected saved workflow.')).toBeVisible()
    await user.click(within(chat).getByRole('button', { name: 'Back to Board' }))
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.edges).toHaveLength(0)
    clickConnectionHandles(canvas.getByLabelText(`Connect ${mock.agents[0]!.name} to another agent`),
      canvas.getByLabelText(`Connect to ${mock.agents[1]!.name}`))
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.edges).toHaveLength(1))
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.edges).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: `${mock.agents[0]!.name} chat` })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: `${mock.agents[1]!.name} chat` })).not.toBeInTheDocument()
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.edges).toHaveLength(0))
    await user.keyboard('{Control>}y{/Control}')
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.edges).toHaveLength(1))
  }, 20_000)
  it.each<Shape>(['single', 'sequential', 'parallel', 'conditional', 'approval'])('S3-01..04: fresh %s Save/reopen/Start persists V3 without dummy repeat state', async (shape) => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), first = await mount(mock)
    const { id, key } = await create(mock, user)
    if (shape === 'single') {
      // Attach a saved Agent to the empty Board, then exercise the real entry controls.
      const record = useGraphDraftStore.getState().nextDrafts[key]!.context.agents.find(item => item.agent.id === mock.agents[0]!.id)!
      act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => attachAgent(graph, record, 'node-single')))
      await user.click(control('Workflow settings'))
      const node = nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!)
      const settings = within(screen.getByRole('complementary', { name: 'Workflow settings' }))
      await user.selectOptions(settings.getByRole('combobox', { name: 'Starts the workflow' }), node.id)
      await user.click(settings.getByRole('button', { name: 'Close panel' }))
    } else stageShape(key, shape, mock)
    const version = await save(mock, user, 1)
    expect(version.definition).not.toHaveProperty('repeat')
    expect(mock.controls.stopCalls).toBe(0)
    const href = first.router.state.location.href
    first.unmount(); first.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    // Acknowledged form memory is lost. The retained snapshot may restore it,
    // but the remounted Board must still read the exact immutable saved pins.
    const beforeReopen = mock.calls.length
    const second = await mount(mock, href)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => {
      const draft = useGraphDraftStore.getState().nextDrafts[key]?.context.draft
      expect(draft?.baseWorkflowVersionId).toBe(version.id)
      expect(draft?.publishedRevision).toBe(mock.managed(id).revision)
      expect(draft?.revision).toBe(draft?.publishedRevision)
    })
    const run = await start(mock, user)
    expect(mock.calls.slice(beforeReopen).some((call) => call.method === 'GET'
      && call.path.endsWith(`/versions/${version.id}`))).toBe(true)
    await waitFor(() => expect(second.router.state.location.search).toMatchObject({ workflowId: id, runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 3 }))
    const requests = mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.body).not.toHaveProperty('draftId')
    expect(requests[0]!.body).not.toHaveProperty('expectedDraftRevision')
    const request = RunStartV3InputSchema.parse(requests[0]!.body)
    expect(request.expectedAgentConfigurationVersionIds).toEqual(version.agentConfigurationVersionIds)
    expect(request.workflowVersionId).toBe(version.id); expect(request.expectedLocationRevision).toBe(1)
    expect(run).not.toHaveProperty('repeat'); expect(mock.currents.get(run.id)!.topology).not.toHaveProperty('repeat')
    expect(mock.currents.get(run.id)!.state.occurrences).toEqual([])
    expect(mock.currents.get(run.id)!.state.decisions).toEqual([])
    expect(mock.currents.get(run.id)!.state.bindings).toEqual([])
    expect(mock.calls.some((call) => /repeat.*update|convert|promote|\/graph$/.test(call.path))).toBe(false)
    expect(readBoardStart(key)).toBeUndefined()
  }, 15_000)
  it('S3-05: the same form adds and removes finite repeat as separate V3 versions, while past Runs retain exact pins', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { id, key } = await create(mock, user); stageShape(key, 'repeat-ready', mock)
    const ordinary = await save(mock, user, 1), oldRun = await start(mock, user)
    await returnToDraft(user)
    mock.settle(oldRun.id)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(mock.workspaceId) })
    await user.click(control('Repeats'))
    const repeat = screen.getByRole('region', { name: 'Repeat settings' })
    await user.click(within(repeat).getByRole('button', { name: 'Add repeat' }))
    const graph = useGraphDraftStore.getState().nextDrafts[key]!.graph
    for (const node of graph.nodes) await user.click(within(repeat).getByRole('checkbox', { name: node.name! }))
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Entry node' }), nativeNode(graph.nodes[0]!).id)
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Exit node' }), nativeNode(graph.nodes[1]!).id)
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Repeat outcome' }), 'again')
    await user.selectOptions(within(repeat).getByRole('combobox', { name: 'Early-exit outcome' }), 'done')
    const repeated = await save(mock, user, 2)
    expect(repeated.definition.repeat?.blocks[0]).toMatchObject({ maxOccurrences: 2, repeatOutcome: 'again', earlyExitOutcome: 'done', limitExit: { kind: 'branch_end' } })
    const repeatRun = await start(mock, user, 2); await returnToDraft(user); mock.settle(repeatRun.id)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(mock.workspaceId) })
    await user.click(within(repeat).getByRole('button', { name: 'Remove repeat' }))
    const removed = await save(mock, user, 3)
    expect(removed.definition).not.toHaveProperty('repeat'); expect(removed.id).not.toBe(ordinary.id)
    expect(mock.versions.get(repeated.id)!.definition.repeat?.blocks).toHaveLength(1)
    expect(mock.runs.get(oldRun.id)!.run.workflowVersionId).toBe(ordinary.id)
    expect(mock.runs.get(repeatRun.id)!.run.workflowVersionId).toBe(repeated.id)
    expect(mock.workflows.get(id)).not.toHaveProperty('repeat')
    // Current/past selection changes the URL, not the mounted local form.
    const editor = screen.getByRole('region', { name: 'Workflow authoring' })
    await user.click(control('Activities'))
    await user.click(await screen.findByRole('button', { name: new RegExp(`Open Run ${oldRun.id} ·`) }))
    await waitFor(() => expect(mounted.router.state.location.search.workflowVersionId).toBe(ordinary.id))
    expect(screen.getByRole('region', { name: 'Workflow authoring', hidden: true })).toBe(editor)
    await user.click(screen.getByRole('button', { name: 'Clear Run selection' }))
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).not.toHaveProperty('repeat')
    // Three Saves and two Starts on one mounted Board: about twice S3-01's work,
    // measured at 4-6 s idle and 12-16 s in the loaded heavy phase. Keep the heavy-tier limit.
  }, 30_000)
  it('removes finite repeat and reopens the saved Board through the registered route', async () => {
    const mock = newBoardMock()
    const user = userEvent.setup()
    const graph = shapeGraph({ ...currentWorkflowFixture().version.definition,
      id: 'workflow', workspaceId: mock.workspaceId }, 'repeat-ready', mock)
    const entryNodeId = graph.nodes[0]!.id
    const exitNodeId = graph.nodes[1]!.id
    mock.install({ ...graph, repeat: { contractVersion: 1, blocks: [{ id: 'finite-repeat',
      nodeIds: [entryNodeId, exitNodeId], entryNodeId, exitNodeId, maxOccurrences: 2,
      repeatOutcome: 'again', earlyExitOutcome: 'done', limitExit: { kind: 'branch_end' } }] } }, true)
    const key = nextDraftKey(mock.workspaceId, graph.id)
    const href = `/workspaces/${mock.workspaceId}?workflowId=${graph.id}`
    const mounted = await mount(mock, href)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await user.click(control('Repeats'))
    const repeat = within(screen.getByRole('region', { name: 'Repeat settings' }))
    expect(repeat.getByRole('spinbutton', { name: 'Maximum occurrences' })).toHaveValue(2)
    await user.click(repeat.getByRole('button', { name: 'Remove repeat' }))
    expect(repeat.getByText('No repeats.')).toBeVisible()
    const removed = await save(mock, user, 2)
    expect(removed.definition).not.toHaveProperty('repeat')
    mounted.unmount()
    mounted.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    await mount(mock, href)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.context.draft.baseWorkflowVersionId).toBe(removed.id))
    await user.click(control('Repeats'))
    const reopened = within(screen.getByRole('region', { name: 'Repeat settings' }))
    expect(reopened.getByText('No repeats.')).toBeVisible()
    expect(reopened.queryByRole('button', { name: 'Remove repeat' })).not.toBeInTheDocument()
    expect(useGraphDraftStore.getState().nextDrafts[key]!.graph).not.toHaveProperty('repeat')
  }, 15_000)
  it('keeps production capability false without issuing Start, and rejects retired saved tags before definition dispatch', async () => {
    const mock = newBoardMock(), user = userEvent.setup(), mounted = await mount(mock)
    const { id, key } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    expect(control('Start saved version')).toBeDisabled()
    expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toEqual([])
    mounted.unmount(); mounted.query.clear(); act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    for (const tag of [1, 2, 99, undefined]) {
      const details = mock.details(), workflow = details.workflows[0]!
      server.use(http.get(`/api/workspaces/${mock.workspaceId}`, () => HttpResponse.json({ ...details, workflows: [{ ...workflow, executionSemanticsVersion: tag }] })))
      const before = mock.calls.filter((call) => /\/(?:definition|drafts)(?:\/|$)/.test(call.path)).length
      // Mount without replacing the denial override with the fixture handlers.
      const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(query)
      const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/workspaces/${mock.workspaceId}?workflowId=${id}`] }) })
      const view = render(<QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>)
      await waitFor(() => expect(screen.queryByRole('region', { name: 'Workflow authoring' })).not.toBeInTheDocument())
      await waitFor(() => expect(query.getQueryState(queryKeys.workspaceDetails(mock.workspaceId))?.status).toBe('error'))
      expect(mock.calls.filter((call) => /\/(?:definition|drafts)(?:\/|$)/.test(call.path))).toHaveLength(before)
      view.unmount(); query.clear()
    }
  }, 15_000)
  it.each(['denied', 'stale', 'unsupported', 'lost'] as const)('Start %s is fail-closed; reload never fabricates a replacement command', async (mode) => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key } = await create(mock, user); stageShape(key, 'sequential', mock); await save(mock, user, 1)
    const button = control('Start saved version'); await waitFor(() => expect(button).toBeEnabled())
    // Deny in the service AFTER its allowed session/read display: authority is rechecked.
    if (mode === 'denied') {
      const advertised = await readLocalHumanAccess()
      server.use(http.get('/api/local-human', () => HttpResponse.json(advertised)))
      mock.controls.deniedStart = true
    }
    if (mode === 'stale') mock.controls.staleStart = true
    if (mode === 'unsupported') mock.controls.unsupportedStart = true
    if (mode === 'lost') mock.controls.loseStartReply = true
    await user.click(button)
    await waitFor(() => expect(mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toHaveLength(1))
    if (mode === 'unsupported') {
      await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]?.startRejectedVersionId).toBeDefined())
      expect(readBoardStart(key)).toBeUndefined()
      expect(mock.runs.size).toBe(0); expect(control('Start saved version')).toBeDisabled(); return
    }
    await waitFor(() => expect(readBoardStart(key)).toBeDefined())
    const retained = readBoardStart(key)!, href = mounted.router.state.location.href
    if (mode === 'denied' || mode === 'stale') expect(mock.runs.size).toBe(0)
    if (mode !== 'lost') return
    expect(mock.runs.size).toBe(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile Start' })).toBeEnabled())
    mounted.unmount(); mounted.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} })); await mount(mock, href)
    const reconcile = await screen.findByRole('button', { name: 'Reconcile Start' })
    await waitFor(() => expect(reconcile).toBeEnabled())
    await user.click(reconcile)
    await waitFor(() => expect(readBoardStart(key)).toBeUndefined())
    const requests = mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))
    expect(requests.at(-1)!.body).toEqual(retained); expect(mock.runs.size).toBe(1)
  }, 15_000)
  it('Stop receipt replay is not cleanup proof; Discard does not Stop and layout does not publish', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    const run = await start(mock, user), scope = mock.currents.get(run.id)!.scope
    await user.click(screen.getByRole('button', { name: 'Activities' }))
    mock.controls.loseStopReply = true
    const stop = await screen.findByRole('button', { name: 'Stop this Run' })
    await waitFor(() => expect(stop).toBeEnabled()); await user.click(stop)
    await waitFor(() => expect(readBoardStop(scope)?.request).toBeDefined())
    const command = readBoardStop(scope)!.request
    await user.click(await screen.findByRole('button', { name: 'Reconcile Stop' }))
    await waitFor(() => expect(readBoardStop(scope)?.receipt?.status).toBe('accepted'))
    expect(mock.controls.stopCalls).toBe(1); expect(readBoardStop(scope)!.request).toEqual(command)
    expect(readBoardStop(scope)).toBeDefined(); expect(mock.runs.get(run.id)!.cleanupPending).toBe(true)
    mock.settle(run.id); await mounted.query.invalidateQueries()
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    await user.click(screen.getByRole('button', { name: 'Close Activities' }))
    await returnToDraft(user)
    const node = nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!)
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, nodes: [{ ...node, initialPrompt: 'Unpublished change', position: { x: 300, y: -99 } }] })))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0])).toMatchObject({ position: { x: 300, y: -99 } })
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0])).not.toHaveProperty('initialPrompt')
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(mock.versions.size).toBe(1); expect(mock.controls.stopCalls).toBe(1)
    expect(within(authoring()).queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument()
  }, 15_000)
  it('stages before Stop confirmation even when the Board summary misses an active Run', async () => {
    const mock = newBoardMock({ allowSimulatedStart: true }), user = userEvent.setup(), mounted = await mount(mock)
    const { key, id } = await create(mock, user); stageShape(key, 'single', mock); await save(mock, user, 1)
    const run = await start(mock, user)
    await returnToDraft(user)
    const beforeEdit = mock.calls.length
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Next pinned instructions' })) })))
    // Only the summary lies. Stage still discovers the authoritative affected Run.
    server.use(http.get(`/api/workspaces/${mock.workspaceId}`, () => HttpResponse.json({ ...mock.details(), runs: [] })))
    act(() => { mounted.query.setQueryData(queryKeys.workspaceDetails(mock.workspaceId), { ...mock.details(), runs: [] }) })
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    const canceled = await screen.findByRole('alertdialog', { name: 'Stop running work and save?' })
    expect(canceled).toHaveTextContent('1 affected Run requires Stop or cleanup')
    await user.click(within(canceled).getByRole('button', { name: 'Keep it' }))
    expect(mock.record(id).intent?.state).toBe('staged')
    const retained = readEditOutbox(key)!
    expect(retained).toBeDefined()
    expect(mock.controls.stopCalls).toBe(0); expect(mock.versions.size).toBe(1)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(true)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!).initialPrompt).toBe('Next pinned instructions')
    expect(mock.calls.slice(beforeEdit).some((call) => call.method === 'PUT' && call.path.endsWith('/definition'))).toBe(false)
    const saveAgain = screen.getByRole('button', { name: 'Stop affected Runs and save' })
    await waitFor(() => expect(saveAgain).toBeEnabled())
    await user.click(saveAgain)
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop runs and save' }))
    await waitFor(() => expect(mock.record(id).intent?.state).toBe('waiting'))
    const stages = mock.calls.slice(beforeEdit).filter((call) => call.method === 'POST' && call.path.endsWith('/definition/edits')
      && (call.body as { action?: string }).action === 'stage_edits')
    expect(stages.length).toBeGreaterThan(0)
    // Reconciliation replays one exact Stage, always pinned to the saved revision.
    for (const stage of stages) expect(stage.body).toEqual(retained.request)
    expect(retained.request).toMatchObject({ expectedRevision: mock.managed(id).revision,
      expectedWorkflowVersionId: mock.managed(id).currentVersionId })
    expect(mock.controls.stopCalls).toBe(1); expect(mock.versions.size).toBe(1)
    mock.settle(run.id); await mounted.query.invalidateQueries()
    await waitFor(() => expect(mock.versions.size).toBe(2))
    expect(mock.runs.size).toBe(1); expect(mock.runs.get(run.id)!.run.executionState).toBe('completed')
    expect(nativeNode([...mock.versions.values()].at(-1)!.definition.nodes[0]!).initialPrompt).toBe('Next pinned instructions')
  }, 15_000)
})

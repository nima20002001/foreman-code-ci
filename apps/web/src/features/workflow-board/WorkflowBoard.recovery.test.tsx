import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
// @vitest-environment jsdom
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowDefinitionV3Schema, WorkflowRunV3Schema, makeCurrentWorkflowFixture, type GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { queryKeys } from '../../shared/api/query'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey, nextDraftDirty } from '../graph/nextDraft/state'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { readBoardStart, clearBoardStartStorage } from './startOutbox'
import { readBoardStop, clearBoardStopStorage } from './stopOutbox'

// Mounted registered Board, real router/Query/editor/actions/outboxes and clients.
// Only HTTP, DOM measurements and Web Locks are synthetic. The current contract
// has no "recovering" enum: use running/interrupted + authenticated uncertainty
// or cleanup facts. A client reconnect must never invent backend recovery proof.
type Form = 'sequential' | 'repeat'
const forms: Form[] = ['sequential', 'repeat']
const clients: QueryClient[] = []
const unhandled: string[] = []
const onUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
let serial = 0
configure({ asyncUtilTimeout: 5000 })
beforeEach(() => {
  localStorage.clear(); localStorage.setItem('graphql.chat-instance-binding', `${mockRuntimeIdentity.checkoutId}:${mockRuntimeIdentity.installationId}`); sessionStorage.clear(); clearBoardStartStorage(); clearBoardStopStorage()
  useGraphDraftStore.getState().clearAllDrafts()
  unhandled.length = 0; server.events.on('request:unhandled', onUnhandled)
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, work: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof work !== 'function') return claim!({ name: key })
    const task = (tails.get(key) ?? Promise.resolve()).then(work); tails.set(key, task.catch(() => {
      // ignore: the caller receives the rejection; later lock requests must still run.
      return undefined
    })); return task
  } } })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}),
  }))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((query) => query.clear())
  useGraphDraftStore.getState().clearAllDrafts(); clearBoardStartStorage(); clearBoardStopStorage()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  server.events.removeListener('request:unhandled', onUnhandled)
  expect(unhandled, 'No recovery action may escape the explicit HTTP fixtures').toEqual([])
})

function fixture(form: Form) {
  const current = makeCurrentWorkflowFixture(`eng06-board-${++serial}`, form)
  const mock = createCurrentBoardMock({ workspaceId: current.scope.workspaceId, allowSimulatedStart: true })
  const graph = WorkflowDefinitionV3Schema.parse({ ...current.version.definition,
    nodes: current.version.definition.nodes.map((node, index) => ({ ...node, agentId: mock.agents[index]!.id })),
  })
  mock.install(graph, true)
  return { mock, form, workflowId: graph.id, key: nextDraftKey(mock.workspaceId, graph.id) }
}
type Fixture = ReturnType<typeof fixture>
async function mount(f: Fixture, href = `/workspaces/${f.mock.workspaceId}?workflowId=${f.workflowId}`) {
  server.use(...f.mock.handlers)
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(query)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [href] }), defaultPendingMinMs: 0 })
  await router.load()
  const mounted = render(<QueryClientProvider client={query}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[f.key]).toBeDefined())
  return { ...mounted, query, router }
}
const actionRegion = () => screen.getByRole('region', { name: 'Selected Run actions' })
const action = (name: string) => within(actionRegion()).getByRole('button', { name })
const writes = (f: Fixture) => f.mock.calls.filter((call) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method))
async function start(f: Fixture, user: ReturnType<typeof userEvent.setup>) {
  const controls = within(screen.getByRole('region', { name: 'Workflow authoring' })).getByRole('group', { name: 'Workflow controls' })
  const button = within(controls).getByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(button, button.title).toBeEnabled()); await user.click(button)
  await waitFor(() => expect(f.mock.runs.size).toBe(1))
  await waitFor(() => expect(readBoardStart(f.key)).toBeUndefined())
  return [...f.mock.runs.values()][0]!.run
}
// Starting shows the saved Run; edits continue on the draft the Board retained.
async function returnToDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Return to workflow' }))
  await screen.findByRole('region', { name: 'Workflow authoring' })
}
function recover(f: Fixture, runId: string, state: 'running' | 'interrupted') {
  const detail = f.mock.runs.get(runId)!, current = f.mock.currents.get(runId)!
  detail.run = WorkflowRunV3Schema.parse({ ...detail.run, executionState: state, outcome: 'pending' })
  detail.cleanupPending = false
  current.state.run = { ...current.state.run, executionState: state, outcome: 'pending', cleanupPending: false }
  current.asOfSequence = String(BigInt(current.asOfSequence) + 1n)
}
async function showActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Activities' }))
  await screen.findByRole('region', { name: 'Selected Run actions' })
  await waitFor(() => expect(action('Resume execution — unavailable')).toBeDisabled())
  await waitFor(() => expect(action('Stop this Run')).toBeEnabled())
}
function edit(f: Fixture) {
  act(() => useGraphDraftStore.getState().changeNextDraft(f.key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Instructions staged while recovery is unresolved' })),
  })))
}
const saveButton = () => within(screen.getByRole('region', { name: 'Workflow authoring' })).getByRole('button', { name: /^Save workflow$/ })
const editCalls = (f: Fixture, actionName: string) => f.mock.calls.filter((call) => call.method === 'POST'
  && call.path.endsWith('/definition/edits') && (call.body as { action?: string }).action === actionName)

// No future schema fields or recovery-control mocks. These tests protect the
// mounted Board's honest display and write/settlement behavior at current seams.
describe.each(forms)('%s Board recovery', (form) => {
  it.each(['running', 'interrupted'] as const)('%s recovery keeps Stop available, blocks full retry, and reconnects without sending work', async (state) => {
    const f = fixture(form), user = userEvent.setup(), mounted = await mount(f)
    const run = await start(f, user); recover(f, run.id, state)
    await mounted.query.invalidateQueries(); await showActions(user)
    const saved = structuredClone(f.mock.versions.get(run.workflowVersionId)), priorWrites = writes(f)
    const selection = { ...mounted.router.state.location.search }
    expect(action('Review new full Run')).toBeDisabled()
    expect(actionRegion()).toHaveTextContent(`Recorded ${state}`)
    expect(within(actionRegion()).queryByText(/A reconnect or successful refresh/)).not.toBeInTheDocument()
    await user.hover(action('About Execution recovery'))
    expect(screen.getByRole('tooltip')).toHaveTextContent('A reconnect or successful refresh does not prove provider restart recovery.')
    await user.click(action('Refresh / reconnect client state'))
    await waitFor(() => expect(actionRegion()).toHaveTextContent('Client state refreshed.'))
    expect(writes(f)).toEqual(priorWrites)
    expect(f.mock.runs.size).toBe(1); expect(f.mock.versions.size).toBe(1)
    expect(mounted.router.state.location.search).toEqual(selection)
    expect(f.mock.versions.get(run.workflowVersionId)).toEqual(saved)
    expect(f.mock.runs.get(run.id)!.run).not.toHaveProperty('result')
    if (form === 'sequential') {
      expect(saved!.definition).not.toHaveProperty('repeat')
      expect(f.mock.currents.get(run.id)!.state.occurrences).toEqual([])
      expect(f.mock.currents.get(run.id)!.state.decisions).toEqual([])
    } else expect(saved!.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
    await user.click(action('Stop this Run'))
    const scope = f.mock.currents.get(run.id)!.scope
    await waitFor(() => expect(readBoardStop(scope)?.receipt?.status).toBe('accepted'))
    expect(actionRegion()).toHaveTextContent('Stop accepted is not cleanup settled.')
    expect(f.mock.controls.stopCalls).toBe(1)
    expect(f.mock.runs.size).toBe(1)
    expect(readBoardStop(scope)?.request.runId).toBe(run.id)
  }, 30000)

  it('withdraws stale action authority during an uncertain recovery read and restores it only by authenticated refresh', async () => {
    const f = fixture(form), user = userEvent.setup(), mounted = await mount(f)
    const run = await start(f, user); recover(f, run.id, 'running')
    await mounted.query.invalidateQueries(); await showActions(user)
    const before = writes(f), body = structuredClone(f.mock.runs.get(run.id)), current = structuredClone(f.mock.currents.get(run.id))
    let unavailable = true
    server.use(http.get(`*/api/management/workspaces/${f.mock.workspaceId}/runs/${run.id}/executions`, ({ request }) => {
      if (unavailable && new URL(request.url).searchParams.get('limit') === '1') return HttpResponse.json({
        error: { code: 'RUN_INSPECTION_UNAVAILABLE', message: 'The Run inspection store is unavailable.' },
      }, { status: 503 })
      return f.mock.dispatch(request)
    }))
    await mounted.query.invalidateQueries()
    await waitFor(() => expect(actionRegion()).toHaveTextContent('Current Run state is unavailable'))
    expect(actionRegion()).toHaveTextContent('Cached state is not shown as current evidence.')
    expect(within(actionRegion()).queryByRole('button', { name: 'Stop this Run' })).not.toBeInTheDocument()
    expect(within(actionRegion()).queryByRole('button', { name: 'Review new full Run' })).not.toBeInTheDocument()
    await user.click(action('Refresh / reconnect client state'))
    await waitFor(() => expect(actionRegion()).toHaveTextContent('Synchronization failed'))
    expect(writes(f)).toEqual(before)
    unavailable = false
    await user.click(action('Refresh / reconnect client state'))
    await waitFor(() => expect(action('Stop this Run')).toBeEnabled())
    expect(action('Resume execution — unavailable')).toBeDisabled()
    expect(action('Review new full Run')).toBeDisabled()
    expect(writes(f)).toEqual(before)
    expect(f.mock.runs.get(run.id)).toEqual(body); expect(f.mock.currents.get(run.id)).toEqual(current)
  }, 30000)

  it('does not confuse a terminal Run or Stop receipt with cleanup settlement', async () => {
    const f = fixture(form), user = userEvent.setup(), mounted = await mount(f)
    const run = await start(f, user); f.mock.settle(run.id, true)
    await mounted.query.invalidateQueries(); await showActions(user)
    const scope = f.mock.currents.get(run.id)!.scope
    expect(action('Review new full Run')).toBeDisabled()
    expect(actionRegion()).toHaveTextContent('Cleanup pending.')
    await user.click(action('Stop this Run'))
    await waitFor(() => expect(readBoardStop(scope)?.receipt).toBeDefined())
    const command = readBoardStop(scope)!.request
    expect(action('Verify cleanup settlement')).toBeDisabled()
    await user.click(action('Refresh / reconnect client state'))
    await waitFor(() => expect(actionRegion()).toHaveTextContent('Client state refreshed.'))
    expect(readBoardStop(scope)!.request).toEqual(command)
    expect(action('Review new full Run')).toBeDisabled()
    f.mock.settle(run.id, false); await mounted.query.invalidateQueries()
    // Passive settlement requires both the graph and private readback. A status
    // refresh/Stop acceptance alone above was insufficient to clear the journal.
    await waitFor(() => expect(readBoardStop(scope)).toBeUndefined())
    await waitFor(() => expect(action('Review new full Run')).toBeEnabled())
    expect(f.mock.runs.size).toBe(1)
    expect(f.mock.controls.stopCalls).toBe(1)
    expect(f.mock.runs.get(run.id)!.run.result).toEqual({ outcome: 'canceled' })
  }, 30000)

  it.each(['running', 'interrupted'] as const)('Stop-and-save for a %s recovering Run preserves the exact journal and pins through reload until cleanup settles', async (state) => {
    const f = fixture(form), user = userEvent.setup(), mounted = await mount(f)
    const run = await start(f, user), scope = f.mock.currents.get(run.id)!.scope
    await returnToDraft(user)
    recover(f, run.id, state)
    const pinned = structuredClone(f.mock.versions.get(run.workflowVersionId))
    edit(f)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(f.mock.workspaceId) })
    await user.click(saveButton())
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop running work and save?' }))
      .getByRole('button', { name: 'Stop runs and save' }))
    await waitFor(() => expect(f.mock.record(f.workflowId).intent?.state).toBe('waiting'))
    const intent = structuredClone(f.mock.record(f.workflowId).intent)!
    const stage = structuredClone(editCalls(f, 'stage_edits')[0]!.body)
    expect(editCalls(f, 'stage_edits').length).toBeGreaterThan(0)
    for (const replay of editCalls(f, 'stage_edits')) expect(replay.body).toEqual(stage)
    expect(intent.affected).toHaveLength(1)
    expect(intent.affected[0]).toMatchObject(scope)
    expect(intent.affected[0]!.agentConfigurationVersionIds).toEqual(run.agentConfigurationVersionIds)
    expect(intent.saveAttempted).toBe(false)
    expect(f.mock.controls.stopCalls).toBe(1); expect(f.mock.versions.size).toBe(1)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[f.key]!.graph.nodes[0]!).initialPrompt)
      .toBe('Instructions staged while recovery is unresolved')
    // Terminal status is still NOT cleanup settlement. Keep waiting and retain
    // the same intent/advance command rather than saving or starting a new Run.
    f.mock.settle(run.id, true); await mounted.query.invalidateQueries()
    await waitFor(() => expect(f.mock.record(f.workflowId).current[0]).toMatchObject({ terminal: true, settled: false, cleanupPending: true }))
    expect(f.mock.versions.size).toBe(1)
    const href = mounted.router.state.location.href, retained = structuredClone(readEditOutbox(f.key))
    expect(retained).toBeDefined()
    mounted.unmount(); mounted.query.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    const reopened = await mount(f, href)
    const draftId = useGraphDraftStore.getState().nextDrafts[f.key]!.context.draft.id
    await waitFor(() => expect(reopened.query.getQueryData<GraphEditReadResultV3>(
      graphEditIntentKey(f.mock.workspaceId, f.workflowId, draftId))?.intent?.id).toBe(intent.id))
    expect(readEditOutbox(f.key)).toEqual(retained)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[f.key]!.graph.nodes[0]!).initialPrompt)
      .toBe('Instructions staged while recovery is unresolved')
    expect(f.mock.record(f.workflowId).intent?.advanceCommandId).toBe(intent.advanceCommandId)
    expect(f.mock.versions.size).toBe(1); expect(f.mock.controls.stopCalls).toBe(1)
    const advanced = editCalls(f, 'stop_and_save')
    expect(advanced.length).toBeGreaterThan(0)
    expect(advanced.every((call) => (call.body as { commandId: string }).commandId === intent.advanceCommandId)).toBe(true)
    expect(editCalls(f, 'stage_edits').every((call) => JSON.stringify(call.body) === JSON.stringify(stage))).toBe(true)
    f.mock.settle(run.id, false); await reopened.query.invalidateQueries()
    await waitFor(() => expect(f.mock.versions.size).toBe(2))
    await waitFor(() => expect(readEditOutbox(f.key)).toBeUndefined())
    expect(f.mock.record(f.workflowId).intent?.state).toBe('saved')
    expect(f.mock.versions.get(run.workflowVersionId)).toEqual(pinned)
    expect(f.mock.runs.get(run.id)!.run.workflowVersionId).toBe(run.workflowVersionId)
    const newest = [...f.mock.versions.values()].at(-1)!
    expect(newest.id).not.toBe(run.workflowVersionId)
    expect(nativeNode(newest.definition.nodes[0]!).initialPrompt).toBe('Instructions staged while recovery is unresolved')
    expect(newest.definition.repeat).toEqual(pinned!.definition.repeat)
    expect(f.mock.runs.size).toBe(1); expect(f.mock.controls.stopCalls).toBe(1)
    expect(f.mock.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/runs'))).toHaveLength(1)
    expect(reopened.router.state.location.search).not.toHaveProperty('runId')
  }, 30000)

  it('canceling Stop-and-save while recovering preserves edits and sends neither Stop nor Save', async () => {
    const f = fixture(form), user = userEvent.setup(), mounted = await mount(f)
    const run = await start(f, user); await returnToDraft(user); recover(f, run.id, 'interrupted'); edit(f)
    await mounted.query.invalidateQueries({ queryKey: queryKeys.workspaceDetails(f.mock.workspaceId) })
    const before = writes(f), draft = structuredClone(useGraphDraftStore.getState().nextDrafts[f.key]!.graph)
    await user.click(saveButton())
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Stop running work and save?' })).getByRole('button', { name: 'Keep it' }))
    // Save discovers blockers through private Stage, not through the Run summary.
    // Canceling the confirmation must not advance that intent or publish anything.
    expect(writes(f).slice(before.length)).toEqual(editCalls(f, 'stage_edits'))
    expect(editCalls(f, 'stage_edits')).toHaveLength(1)
    expect(editCalls(f, 'stop_and_save')).toEqual([]); expect(f.mock.controls.stopCalls).toBe(0)
    expect(f.mock.record(f.workflowId).intent?.state).toBe('staged')
    expect(readEditOutbox(f.key)?.request).toEqual(editCalls(f, 'stage_edits')[0]!.body)
    expect(useGraphDraftStore.getState().nextDrafts[f.key]!.graph).toEqual(draft)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[f.key]!)).toBe(true)
    expect(f.mock.runs.size).toBe(1); expect(f.mock.versions.size).toBe(1)
  }, 30000)
})

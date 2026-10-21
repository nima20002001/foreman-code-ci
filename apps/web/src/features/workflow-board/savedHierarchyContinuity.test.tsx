// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse, type JsonBodyType } from 'msw'
import { WorkflowHierarchyReadResultSchema } from '@foreman-code/contracts'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_CAPABILITIES, CurrentWorkflowCapabilitiesSchema } from '@foreman-code/contracts/wave25'
import { subagentCapabilities } from '@foreman-code/contracts/subagents'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { pinnedRunHandlers, reply, runA, runsUrl, scope, versionReply } from '../run-board/testFixtures'
import { base, child, message, receipt } from '../run-subagents/testFixtures'
import { subagentsKey } from '../run-subagents/query'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { WorkflowBoard } from './WorkflowBoard'
import { useSidePanelPresentation } from './sidePanelPresentation'
import { clearBoardStopStorage } from './stopOutbox'

configure({ asyncUtilTimeout: 5000 })
const clients: QueryClient[] = []
const hierarchyPath = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/hierarchy'
class ReportSource extends EventTarget {
  static instances: ReportSource[] = []
  closed = false
  close() { this.closed = true }
  constructor() { super(); ReportSource.instances.push(this) }
}
beforeEach(() => {
  installFlowLayout()
  ReportSource.instances = []
  vi.stubGlobal('EventSource', ReportSource)
  useSidePanelPresentation.setState({ collapsedTeams: {}, scroll: {} })
  clearBoardStopStorage()
  localStorage.clear()
  const commands = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, work: () => unknown) => {
    const next = (commands.get(key) ?? Promise.resolve()).then(work)
    commands.set(key, next.catch(() => { /* ignore: callers receive failure; later commands still need the lock. */ }))
    return next
  } } })
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function install() {
  const requests: string[] = []
  const capabilities = subagentCapabilities('codex-collab')
  capabilities.sendInput = { support: 'supported', qualification: 'passed' }
  const nativeChild = child({ parentNodeId: 'node-z', parentAgentId: 'agent-z', nativeMode: 'codex-collab', capabilities })
  const record = { subagent: nativeChild, availableActions: { sendInput: true, interrupt: false, blockedReason: null } }
  const hierarchy = (runId: string) => WorkflowHierarchyReadResultSchema.parse({ ...scope,
    workflowVersionId: runId === 'run-a' ? 'version-a' : 'version-b', revision: 1,
    hierarchy: runId === 'run-a' ? { version: 1, masterNodeId: 'node-x', parents: [
      { workflowNodeId: 'node-y', parentNodeId: 'node-x' }, { workflowNodeId: 'node-z', parentNodeId: 'node-y' },
    ] } : null,
    agents: runA.nodes.map((node, index) => ({ ...scope, workflowNodeId: node.id,
      agentId: `agent-${['x', 'y', 'z'][index]}`, displayName: node.name,
      configurationVersionId: node.kind !== 'job' ? node.agentConfigurationVersionId : undefined,
      productRole: ['master', 'orchestrator', 'coder'][index] })),
    run: { runId, state: 'running' },
  })
  const read = (path: string, body: JsonBodyType) => { requests.push(path); return HttpResponse.json(body) }
  server.use(...pinnedRunHandlers(scope),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries', () => HttpResponse.json({
      items: ['run-a', 'run-b'].map(runId => ({ runId, shortId: runId,
        startedAt: '2026-10-01T00:00:00Z', status: 'succeeded', trigger: 'manual' })), pageInfo: { nextCursor: null },
    })),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot',
      ({ params }) => HttpResponse.json(reply(String(params.runId)))),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/version',
      ({ params }) => HttpResponse.json(versionReply(reply(String(params.runId)).snapshot))),
    http.get(hierarchyPath, ({ request }) => read('hierarchy', hierarchy(new URL(request.url).searchParams.get('runId')!))),
    http.get(`${hierarchyPath}/reports`, ({ request }) => {
      const runId = new URL(request.url).searchParams.get('runId')!
      return read('reports', { ...scope, runId, workflowVersionId: hierarchy(runId).workflowVersionId,
        items: [], nextCursor: null, hasMore: false, revision: 1 })
    }),
    http.get(base, () => read('children', { items: [record], nextCursor: null, projection: 'caught-up' })),
    http.get(`${base}/:subagentId`, () => read('child', record)),
    http.get(`${base}/:subagentId/messages`, () => read('messages', { items: [message()], nextCursor: null, coverage: nativeChild.coverage })),
    http.get(`${base}/:subagentId/tools`, () => read('tools', { items: [], nextCursor: null, coverage: nativeChild.coverage })),
  )
  return { requests, record }
}
async function mount(entry = runsUrl('run-a'), { hasHierarchy = true } = {}) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(cache)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined}
      selectRun={() => undefined} summaries={[]} collaborationSlots={{ memoryBoard: () => <p>Workflow memory content</p> }}>
      <p>Draft editor</p>
    </WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  if (hasHierarchy) await screen.findByRole('button', { name: 'Hide Workers for Y' })
  return { cache, router }
}
const toolbar = () => within(screen.getByRole('navigation', { name: 'Workflow views' }))
const childScope = { ...scope, runId: 'run-a' }

it.each(['graph', 'overview'])('stops an ordinary selected Run from %s and keeps its command after a lost receipt', async view => {
  install()
  const stops: Record<string, unknown>[] = []
  const run = { ...scope, runId: 'run-b', workflowVersionId: 'version-b', executionSemanticsVersion: 3,
    executionState: 'running', outcome: 'pending', createdAt: '2026-10-01T00:00:00Z', cleanupPending: false }
  server.use(
    http.get('*/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
      id: 'operator-test', name: 'Test Operator', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ actions: ['runs:read', 'runs:stop'], scope: { workspaceIds: [scope.workspaceId] } }],
    } }))),
    http.get('*/api/management/workflows/capabilities/v3', () => HttpResponse.json(CurrentWorkflowCapabilitiesSchema.parse({
      ...CURRENT_WORKFLOW_CAPABILITIES, runtimeAdmission: true, meaningfulEdit: true, stopAvailable: true, reasons: [],
      editIntents: { ...CURRENT_WORKFLOW_CAPABILITIES.editIntents, stopUnsettled: true },
    }))),
    http.get('*/api/management/workspaces/:workspaceId/runs/run-b/executions', () => HttpResponse.json({
      run, items: [], pageInfo: { nextCursor: null },
    })),
    http.post('*/api/management/workspaces/:workspaceId/runs/run-b/stop', async ({ request }) => {
      stops.push(await request.json() as Record<string, unknown>)
      if (stops.length === 1) return HttpResponse.error()
      return HttpResponse.json({ runId: 'run-b', status: 'accepted', processStopped: false, replayed: true })
    }),
  )
  await mount(`${runsUrl('run-b')}&boardView=${view}`, { hasHierarchy: false })
  fireEvent.click(await screen.findByRole('button', { name: 'Run controls · Stop' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop this Run' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Stop this Run' }))
  await screen.findByText(/Stop is not confirmed:/)
  expect(stops).toHaveLength(1)
  expect(stops[0]).toMatchObject({ workspaceId: scope.workspaceId, runId: 'run-b' })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile Stop' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Reconcile Stop' }))
  await screen.findByText(/Stop receipt: accepted/)
  expect(stops).toHaveLength(2)
  expect(stops[1]).toEqual(stops[0])
  expect(screen.getByRole('region', { name: 'Stop and cleanup' })).toHaveTextContent('version-b')
})

it('uses saved roles and coordinates, docks one inspector, and navigates teams without changing the Run', async () => {
  install()
  const { router } = await mount()
  const master = screen.getByRole('group', { name: 'X before rename, saved agent, read only' })
  const worker = screen.getByRole('group', { name: 'Z, saved agent, read only' })
  expect(master).toHaveTextContent('Master')
  expect(worker).toHaveTextContent('Worker · Reports to Y')
  const position = worker.style.transform
  fireEvent.click(screen.getByRole('button', { name: 'Inspect Z' }))
  const inspector = await screen.findByRole('region', { name: 'Run node inspector: Z' })
  expect(screen.getAllByRole('complementary', { name: 'Workflow side panel' })).toHaveLength(1)
  expect(within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    .getByRole('region', { name: 'Run node inspector: Z' })).toBe(inspector)
  fireEvent.click(screen.getByRole('button', { name: 'Hide Workers for Y' }))
  expect(screen.queryByRole('button', { name: 'Inspect Z' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Show Workers for Y' }))
  expect(screen.getByRole('group', { name: 'Z, saved agent, read only' }).style.transform).toBe(position)
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Team visibility' })).getByRole('button', { name: 'View team' }))
  await screen.findByRole('region', { name: 'Selected team' })
  expect(router.state.location.search).toMatchObject({ selectedRunId: 'run-a', boardTeamId: 'node-y', boardView: 'overview' })
  fireEvent.click(screen.getByRole('button', { name: 'All teams' }))
  await waitFor(() => expect(router.state.location.search.boardTeamId).toBeUndefined())
  fireEvent.click(toolbar().getByRole('button', { name: 'Graph' }))
  await screen.findByRole('button', { name: 'Inspect Z' })
  expect(screen.getByRole('group', { name: 'Z, saved agent, read only' }).style.transform).toBe(position)
  expect(router.state.location.search.selectedRunId).toBe('run-a')
})

it('retains native-child text through parent collapse, Memory, Overview and access loss without hidden reads', async () => {
  const wire = install()
  const { cache } = await mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Research, Codex, Running' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'Keep this direction' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hide Workers for Y' }))
  expect(screen.queryByRole('dialog', { name: 'Research' })).not.toBeInTheDocument()
  const afterCollapse = wire.requests.filter(path => ['child', 'messages', 'tools'].includes(path)).length
  await act(async () => { await cache.invalidateQueries({ queryKey: [...subagentsKey(childScope), 'child-1'] }) })
  expect(wire.requests.filter(path => ['child', 'messages', 'tools'].includes(path))).toHaveLength(afterCollapse)
  fireEvent.click(screen.getByRole('button', { name: 'Show Workers for Y' }))
  expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toHaveValue('Keep this direction')
  fireEvent.click(toolbar().getByRole('button', { name: 'Memory board' }))
  await screen.findByRole('dialog', { name: 'Memory board' })
  const hiddenReads = wire.requests.length
  await act(async () => { await cache.invalidateQueries({ queryKey: subagentsKey(childScope) }) })
  expect(wire.requests).toHaveLength(hiddenReads)
  expect(screen.queryByRole('dialog', { name: 'Research' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
  expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toHaveValue('Keep this direction')
  fireEvent.click(toolbar().getByRole('button', { name: 'Overview' }))
  await screen.findByRole('region', { name: 'Master Overview' })
  expect(screen.queryByRole('dialog', { name: 'Research' })).not.toBeInTheDocument()
  fireEvent.click(toolbar().getByRole('button', { name: 'Graph' }))
  expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toHaveValue('Keep this direction')
  server.use(http.get(base, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'No access' } }, { status: 403 })))
  await act(async () => { await cache.invalidateQueries({ queryKey: [...subagentsKey(childScope), 'list'] }) })
  await screen.findByText("Couldn't load subagents.")
  expect(screen.queryByText('Child answer')).not.toBeInTheDocument()
  server.use(http.get(base, () => HttpResponse.json({ items: [wire.record], nextCursor: null, projection: 'caught-up' })))
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toHaveValue('Keep this direction')
})

it('keeps a hidden pending command identity and defers failure refresh until its native-child panel is visible', async () => {
  const wire = install()
  const pending = deferred()
  const bodies: Record<string, unknown>[] = []
  server.use(http.post(`${base}/:subagentId/input`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    bodies.push(body)
    if (bodies.length === 1) { await pending.promise; return HttpResponse.error() }
    return HttpResponse.json(receipt({ commandId: body.commandId }))
  }))
  const { cache } = await mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Research, Codex, Running' }))
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message to subagent' }), { target: { value: 'One direction' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(bodies).toHaveLength(1))
  fireEvent.click(toolbar().getByRole('button', { name: 'Memory board' }))
  await screen.findByRole('dialog', { name: 'Memory board' })
  const hiddenReads = wire.requests.filter(path => path === 'child').length
  await act(async () => { pending.resolve() })
  await waitFor(() => expect(cache.isMutating()).toBe(0))
  expect(wire.requests.filter(path => path === 'child')).toHaveLength(hiddenReads)
  fireEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
  expect(await screen.findByRole('textbox', { name: 'Message to subagent' })).toHaveValue('One direction')
  fireEvent.click(await screen.findByRole('button', { name: 'Check again' }))
  await screen.findByText('Message delivered to the subagent.')
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
})

it('suspends Overview reports while Memory is open and restores the selected branch on close', async () => {
  const wire = install()
  const { cache } = await mount()
  fireEvent.click(toolbar().getByRole('button', { name: 'Overview' }))
  await screen.findByRole('region', { name: 'Master Overview' })
  fireEvent.click(screen.getByRole('button', { name: 'View branch · 1' }))
  await screen.findByRole('region', { name: 'Reports to Y' })
  await waitFor(() => expect(ReportSource.instances).toHaveLength(1))
  fireEvent.click(toolbar().getByRole('button', { name: 'Memory board' }))
  await screen.findByRole('dialog', { name: 'Memory board' })
  expect(ReportSource.instances[0]!.closed).toBe(true)
  const reports = wire.requests.filter(path => path === 'reports').length
  await act(async () => { await cache.invalidateQueries({ queryKey: ['workflow-hierarchy'] }) })
  expect(wire.requests.filter(path => path === 'reports')).toHaveLength(reports)
  fireEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
  await screen.findByRole('region', { name: 'Reports to Y' })
  await waitFor(() => expect(ReportSource.instances.filter(source => !source.closed)).toHaveLength(1))
})

it('keeps historical absence separate and restores exact inspector pins and geometry through browser history', async () => {
  install()
  const { router } = await mount(`${runsUrl('run-a')}&boardPanel=agent&boardAgentTab=details&boardNodeId=node-x&boardExecutionId=execution-old`)
  const firstPosition = screen.getByRole('group', { name: 'X before rename, saved agent, read only' }).style.transform
  await screen.findByRole('region', { name: 'Run node inspector: X before rename' })
  fireEvent.click(screen.getByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  fireEvent.click(await within(menu).findByRole('menuitemradio', { name: /run-b/ }))
  await screen.findByRole('group', { name: 'X in B, saved agent, read only' })
  expect(router.state.location.search.selectedRunId).toBe('run-b')
  expect(router.state.location.search.boardExecutionId).toBeUndefined()
  expect(screen.queryByRole('button', { name: 'Hide Workers for Y' })).not.toBeInTheDocument()
  fireEvent.click(toolbar().getByRole('button', { name: 'Overview' }))
  await screen.findByRole('heading', { name: 'No Master in this Run' })
  expect(screen.queryByRole('heading', { name: 'X before rename Master' })).not.toBeInTheDocument()
  await act(async () => { router.history.back() })
  await screen.findByRole('group', { name: 'X in B, saved agent, read only' })
  await act(async () => { router.history.back() })
  await screen.findByRole('region', { name: 'Run node inspector: X before rename' })
  expect(router.state.location.search).toMatchObject({ selectedRunId: 'run-a', boardExecutionId: 'execution-old', boardNodeId: 'node-x' })
  expect(screen.getByRole('group', { name: 'X before rename, saved agent, read only' }).style.transform).toBe(firstPosition)
  expect(screen.getAllByRole('complementary', { name: 'Workflow side panel' })).toHaveLength(1)
})

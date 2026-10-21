import { installBrowserLocks } from '../test/browserLocks'
import { nativeNode } from '../shared/mocks/nativeFixtureTypes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { CurrentWorkspaceDetails as WorkspaceDetailsResponse } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../features/graph/store'

import { routeTree } from '../app/router'
import { queryKeys } from '../shared/api/query'
import { getMockFixture, setMockScenario } from '../shared/mocks/scenarios'
import { server } from '../mocks/server'
import { bindMockInstallation } from '../shared/mocks/handlers'
import { savedClaudeConfiguration } from '../features/settings/claudeSettings.fixtures'
import { savedPlacementFixture } from '../features/node-placement/fixtures'
import { createCurrentBoardMock } from '../shared/mocks/currentBoard'
import canvasStyles from '../shared/ui/nocturne/canvas.css?inline'

function readyWorkspace() {
  const fixture = getMockFixture('workspace-1')
  if (!fixture) throw new Error('Workspace fixture missing')
  return {
    workspace: fixture.workspace, revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
  }
}

const clients: QueryClient[] = []
let restoreBrowserLocks: () => void
async function researcherButton() {
  // Wait for the current Board before querying its canvas; initial route selection
  // and definition loading are separate asynchronous steps.
  const board = await workflowBoard('Research to review')
  const canvas = within(board).getByLabelText('Editable workflow graph')
  const fixture = getMockFixture('workspace-1')!
  const node = fixture.workflows.find((workflow) => workflow.id === 'workflow-content-pipeline')!
    .nodes.map(nativeNode).find((node) => nativeNode(node).agentId === 'agent-researcher')!
  const title = node.name ?? node.label ?? fixture.agents.find((agent) => agent.id === nativeNode(node).agentId)!.name
  return within(canvas).findByRole('button', { name: (name) => name.startsWith(`${title},`) })
}
async function workflowBoard(name: string) {
  const board = await screen.findByRole('region', { name: 'Workflow authoring' }, { timeout: 3000 })
  expect(await within(board).findByRole('heading', { name })).toBeVisible()
  return board
}
async function renderWorkspace(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })
  clients.push(queryClient)
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    defaultPendingMinMs: 0,
  })

  // Load the memory route before mounting instead of racing the initial render.
  await router.load()
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  return { router, queryClient, ...rendered }
}

describe('WorkspaceRouteEntry integration', () => {
  beforeEach(() => {
    restoreBrowserLocks = installBrowserLocks()
    useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); bindMockInstallation(); sessionStorage.clear()
    server.use(http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(readyWorkspace())))
    server.use(
      http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
        evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
        executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      })),
      http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
        workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
      })),
    )
    // JSDOM measurements only: the real mounted Board and React Flow stay intact.
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
    cleanup(); window.dispatchEvent(new Event('pagehide'))
    restoreBrowserLocks()
    clients.splice(0).forEach((client) => client.clear())
    useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
    setMockScenario('normal')
    sessionStorage.clear()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('opens saved authoring in a fresh tab after reloading the selected workflow', async () => {
    const entry = '/workspaces/workspace-1?workflowId=workflow-content-pipeline&agentId=agent-researcher'
    const first = await renderWorkspace(entry)
    expect(await workflowBoard('Research to review')).toBeVisible()
    first.unmount()
    first.queryClient.clear()
    useGraphDraftStore.getState().clearAllDrafts()
    sessionStorage.clear()

    const reloaded = await renderWorkspace(entry)
    const board = await workflowBoard('Research to review')
    expect(within(board).getByLabelText('Editable workflow graph')).toBeVisible()
    expect(reloaded.router.state.location.search.workflowId).toBe('workflow-content-pipeline')
    expect(reloaded.router.state.location.search.agentId).toBe('agent-researcher')
    await waitFor(() => expect(screen.getByRole('button', {
      name: (name) => name.startsWith('Researcher,'),
    })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.queryByRole('heading', { name: 'Authoring unavailable' })).not.toBeInTheDocument()
  })

  it('renders the saved workflow and keeps a valid agent selection in the URL', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline')

    expect(await researcherButton()).toBeVisible()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()

    const nodeButton = await researcherButton()
    fireEvent.click(nodeButton)

    await waitFor(() => expect(router.state.location.search.agentId).toBe('agent-researcher'))
    await waitFor(() => expect(nodeButton).toHaveAttribute('aria-pressed', 'true'))
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('keeps an URL-selected agent in the graph without mounting a context panel', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline&agentId=agent-researcher')

    const node = await researcherButton()
    await waitFor(() => expect(node).toHaveAttribute('aria-pressed', 'true'))
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('agent-context-panel')).not.toBeInTheDocument()
  })

  it('keeps a stale URL selection in the graph without exposing an operator surface', async () => {
    await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline&agentId=agent-old')

    expect(await workflowBoard('Research to review')).toBeVisible()
    expect(screen.queryByTestId('agent-context-stale')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it.each([undefined, 'agent-researcher'])('opens, closes and reopens settings after reload with selection %s', async (agentId) => {
    const user = userEvent.setup()
    const entry = '/workspaces/workspace-1?workflowId=workflow-content-pipeline'
    const { router } = await renderWorkspace(agentId ? `${entry}&agentId=${agentId}` : entry)
    const node = await researcherButton()
    const title = node.getAttribute('aria-label')!.split(',')[0]
    const canvas = screen.getByLabelText('Editable workflow graph')
    const actions = within(canvas).getByRole('group', { name: `${title} actions` })
    const open = within(actions).getByRole('button', { name: `Open ${title} settings` })
    await user.click(open)
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(rail).toBeVisible()
    await user.click(within(rail).getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(rail).not.toBeVisible())
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    expect(router.state.location.search.agentId).toBe('agent-researcher')
    await user.click(open)
    expect(await screen.findByRole('complementary', { name: 'Workflow side panel' })).toBeVisible()
  })

  it('opens an unselected reloaded Claude Agent settings panel while cross-computer choices are unavailable', async () => {
    // Apply the canvas CSS so userEvent checks the same pointer access as the browser.
    render(<style>{canvasStyles}</style>)
    const fixture = getMockFixture('workspace-1')!
    const agent = fixture.agents.find((item) => item.id === 'agent-researcher')!
    agent.harness = 'claude'
    agent.harnessConfiguration = savedClaudeConfiguration
    agent.model = savedClaudeConfiguration.model
    const graph = fixture.workflows.find((item) => item.id === 'workflow-content-pipeline')!
    graph.nodes = graph.nodes.map((node) => nativeNode(node).agentId === agent.id
      ? { ...node, name: 'Main coordinator' } : { ...node, placement: savedPlacementFixture })
    const service = createCurrentBoardMock({ workspaceId: 'workspace-1', agents: fixture.agents,
      initialWorkflow: graph })
    server.use(...service.handlers)
    server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices',
      () => new HttpResponse(null, { status: 503 })))
    const entry = '/workspaces/workspace-1?workflowId=workflow-content-pipeline'
    const first = await renderWorkspace(entry)
    const user = userEvent.setup()
    const before = await workflowBoard('Research to review')
    await user.click(within(before).getByRole('button', { name: 'Research to review' }))
    const name = screen.getByRole('textbox', { name: 'Workflow name' })
    await user.clear(name)
    await user.type(name, 'Activities persisted workflow{Enter}')
    await user.click(await screen.findByRole('button', { name: 'Rename' }))
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    expect(await screen.findByText('Saved.')).toBeVisible()
    first.unmount()
    first.queryClient.clear()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    await renderWorkspace(entry)
    const board = await workflowBoard('Activities persisted workflow')
    const node = await within(board).findByRole('button', { name: /^Main coordinator,/ })
    const title = 'Main coordinator'
    expect(node).toHaveAccessibleName(/Claude/)
    expect(node).toHaveAttribute('aria-pressed', 'false')
    await user.hover(node)
    await user.click(screen.getByRole('button', { name: `Open ${title} settings` }))
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(rail).toBeVisible()
    expect(within(rail).getByRole('textbox', { name: 'Name' })).toHaveValue(agent.name)
    expect(await within(rail).findByText('Computer choices are unavailable.')).toBeVisible()
  }, 15_000)

  it('opens the accepted new workflow while workspace details still serve the old list', async () => {
    const user = userEvent.setup()
    const { router, queryClient } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    expect(await workflowBoard('Research to review')).toBeVisible()

    const oldDetails = queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))
    if (!oldDetails) throw new Error('Workspace details were not loaded')
    server.use(http.get('/api/workspaces/workspace-1', () => HttpResponse.json(oldDetails)))

    await user.click(within(screen.getByRole('region', { name: 'Workspace workflows' })).getByRole('button', { name: 'New workflow' }))
    await user.click(screen.getByRole('textbox', { name: 'Name' }))
    await user.paste('Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    // The sidebar marks a never-published workflow with a "Draft" badge inside its button.
    const sidebar = within(screen.getByRole('region', { name: 'Workspace workflows' }))
    const newLink = await sidebar.findByRole('button', { name: /^Draft workflow/ })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(newLink, { ctrlKey: true })
    const createdId = new URL(open.mock.calls[0]![0] as string, 'http://localhost').searchParams.get('workflowId')
    open.mockRestore()
    expect(createdId).toBeTruthy()
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: queryKeys.workspaceDetails('workspace-1'), type: 'active' })
    })
    expect(queryClient.getQueryData<WorkspaceDetailsResponse>(queryKeys.workspaceDetails('workspace-1'))?.workflows.some((item) => item.id === createdId)).toBe(false)
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    expect(await workflowBoard('Draft workflow')).toBeVisible()
  })

  it('still replaces a genuinely unknown workflow selection', async () => {
    const { router } = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-missing&agentId=agent-researcher')

    await waitFor(() => {
      expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
      expect(router.state.location.search.agentId).toBeUndefined()
    })
  })

  it('renders error, 404 and empty workspace states', async () => {
    setMockScenario('error')
    const error = await renderWorkspace('/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    expect(await screen.findByTestId('workspace-error')).toBeVisible()
    error.unmount()

    setMockScenario('empty')
    const empty = await renderWorkspace('/workspaces/workspace-1')
    expect(await screen.findByTestId('workspace-empty')).toBeVisible()
    empty.unmount()

    const missing = await renderWorkspace('/workspaces/missing?workflowId=workflow-content-pipeline')
    expect(await screen.findByTestId('workspace-not-found')).toBeVisible()
    missing.unmount()
  })

  it.each([403, 404])('stops automatic polling after a terminal %s while keeping manual retry', async (status) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let requests = 0
    server.use(http.get('/api/workspaces/stale-workspace', () => {
      requests += 1
      return HttpResponse.json({
        error: {
          code: status === 404 ? 'WORKSPACE_NOT_FOUND' : 'ACCESS_DENIED',
          message: status === 404 ? 'Workspace not found.' : 'Access denied.',
        },
      }, { status })
    }))

    const stale = await renderWorkspace('/workspaces/stale-workspace?workflowId=workflow-content-pipeline')
    const retry = await screen.findByRole('button', { name: 'Retry workspace request' })
    expect(requests).toBe(1)

    // Advance the polling window to prove terminal errors suppress automatic requests.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_200) })
    expect(requests).toBe(1)

    vi.useRealTimers()
    fireEvent.click(retry)
    await waitFor(() => expect(requests).toBe(2))
    stale.unmount()
  })

})

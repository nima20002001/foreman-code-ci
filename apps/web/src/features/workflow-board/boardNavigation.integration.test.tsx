import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation, useNavigate } from '@tanstack/react-router'
import { WorkspaceBoardSearchSchema, boardSearchForRun, resolveWorkflowBoardLocation } from '@foreman-code/contracts/wave25'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { queryKeys } from '../../shared/api/query'
import { NextDraftEditor } from '../graph/nextDraft/NextDraftEditor'
import { nextDraftKey } from '../graph/nextDraft/state'
import { fixture } from '../graph/nextDraft/core.cases'
import { useGraphDraftStore } from '../graph/store'
import { WorkflowBoardContext } from './context'

const mounts = vi.hoisted(() => ({ canvas: 0, disposed: 0 }))
vi.mock('../graph/nextDraft/DraftCanvas', () => ({
  DraftCanvas: forwardRef(function BufferedCanvas({ pending }: { pending(value: boolean): void }, ref) {
    const [buffered, setBuffered] = useState(false)
    useEffect(() => { mounts.canvas++; return () => { mounts.disposed++ } }, [])
    useImperativeHandle(ref, () => ({ flush: () => { setBuffered(false); pending(false) }, cancel: () => { setBuffered(false); pending(false) } }))
    return <div data-testid="retained-canvas">
      <button type="button" onClick={() => { setBuffered(true); pending(true) }}>Buffer geometry</button>
      {buffered ? <span>Geometry is buffered</span> : null}
    </div>
  }),
}))
vi.mock('../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../shared/api/query')>(), useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const clients: QueryClient[] = []
function Harness() {
  const location = useLocation(), navigate = useNavigate()
  const selected = resolveWorkflowBoardLocation(location.pathname, location.search)
  const workflowId = selected.workflowId!
  return <WorkflowBoardContext.Provider value={{ workspaceId: 'workspace', workflowId, run: selected.run,
    inspection: {}, selectInspection: () => undefined, openLocation: () => undefined, openRuns: () => undefined, activeRuns: 0,
    selectRun: (run) => { void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: 'workspace' }, search: boardSearchForRun(selected.search, workflowId, run) }) },
  }}>
    <p data-testid="selected-run">{selected.run ? `${selected.run.runId}:${selected.run.workflowVersionId}` : 'No Run selected'}</p>
    <NextDraftEditor key={JSON.stringify(['workspace', workflowId])} workspaceId="workspace" workflowId={workflowId} />
  </WorkflowBoardContext.Provider>
}
function setup() {
  const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const workspace = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: WorkspaceBoardSearchSchema, component: Harness })
  const draft = createRoute({ getParentRoute: () => workspace, path: 'workflows/$workflowId/draft' })
  const run = createRoute({ getParentRoute: () => workspace, path: 'workflows/$workflowId/runs/$runId/graph/$workflowVersionId/$executionSemanticsVersion' })
  const away = createRoute({ getParentRoute: () => root, path: '/account', component: () => <p>Elsewhere</p> })
  const tree = root.addChildren([workspace.addChildren([draft, run]), away])
  const history = createMemoryHistory({ initialEntries: ['/workspaces/workspace?workflowId=workflow'] })
  const router = createRouter({ routeTree: tree, history })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' }, locationRevision: 1, locationValidation: { status: 'ready' } })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, client, history }
}

/** Real TanStack route hierarchy, draft owner and navigation guard. Buffered canvas is a test seam,
 * not browser gesture, production authentication or native execution evidence. */
describe('one mounted board across current route aliases', () => {
  beforeEach(() => { mounts.canvas = 0; mounts.disposed = 0; useGraphDraftStore.getState().clearAllDrafts(); useGraphDraftStore.getState().installNextDraft(key, fixture()) })
  afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })
  it('opens an old draft deep link in the same workspace and keeps the editor mounted', async () => {
    const { router, history, client } = setup()
    await screen.findByTestId('retained-canvas')
    const instance = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId/workflows/$workflowId/draft',
      params: { workspaceId: 'workspace', workflowId: 'workflow' }, search: {} }) })
    expect(history.location.pathname).toBe('/workspaces/workspace/workflows/workflow/draft')
    expect(screen.getByTestId('selected-run')).toHaveTextContent('No Run selected')
    expect(screen.getByTestId('retained-canvas')).toBeInTheDocument()
    expect(useGraphDraftStore.getState().nextDrafts[key]?.instanceId).toBe(instance)
    expect(mounts.canvas).toBe(1)
    client.clear()
  })
  it('retains the editor, unsent content and geometry across canonical and old Run URLs and back', async () => {
    const { router, history, client } = setup(), user = userEvent.setup()
    await screen.findByTestId('retained-canvas')
    const instance = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Unpublished next draft' })),
    })))
    await user.click(screen.getByRole('button', { name: 'Buffer geometry' }))
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: 'workspace' },
      search: { workflowId: 'workflow', runId: 'run-one', workflowVersionId: 'version-one', executionSemanticsVersion: 3 } }) })
    expect(screen.getByTestId('selected-run')).toHaveTextContent('run-one:version-one')
    // Old URL shape, current semantics: a retired tag is not a supported Run alias.
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId/workflows/$workflowId/runs/$runId/graph/$workflowVersionId/$executionSemanticsVersion',
      params: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-old', workflowVersionId: 'version-old', executionSemanticsVersion: '3' }, search: {} }) })
    expect(screen.getByTestId('selected-run')).toHaveTextContent('run-old:version-old')
    expect(screen.getByText('Geometry is buffered')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(mounts.canvas).toBe(1); expect(mounts.disposed).toBe(0)
    expect(useGraphDraftStore.getState().nextDrafts[key]?.instanceId).toBe(instance)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0])?.initialPrompt).toBe('Unpublished next draft')
    await act(async () => { history.back() })
    await waitFor(() => expect(screen.getByTestId('selected-run')).toHaveTextContent('run-one:version-one'))
    expect(screen.getByText('Geometry is buffered')).toBeInTheDocument()
    expect(mounts.canvas).toBe(1)
    client.clear()
  })
  it('leaves a recoverable dirty board quietly and keeps its local document', async () => {
    const { router } = setup()
    await screen.findByTestId('retained-canvas')
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Keep me' })) })))
    const kept = useGraphDraftStore.getState().nextDrafts[key]
    await act(async () => { await router.navigate({ to: '/account' }) })
    expect(router.state.location.pathname).toBe('/account')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(useGraphDraftStore.getState().nextDrafts[key]).toBe(kept)
  })
  it('still guards leaving a dirty board it cannot recover, and cancellation keeps the same local document', async () => {
    const { router } = setup()
    await screen.findByTestId('retained-canvas')
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Keep me' })) })))
    const kept = useGraphDraftStore.getState().nextDrafts[key]
    // Without browser storage the edits cannot be resumed after leaving, so departure still asks.
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    act(() => { void router.navigate({ to: '/account' }) })
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    storage.mockRestore()
    fireEvent(screen.getByRole('alertdialog'), new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/workspaces/workspace')
    expect(useGraphDraftStore.getState().nextDrafts[key]).toBe(kept)
    expect(screen.getByTestId('retained-canvas')).toBeInTheDocument()
  })
})

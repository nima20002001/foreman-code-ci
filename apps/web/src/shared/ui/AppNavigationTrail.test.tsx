import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, Outlet, RouterProvider, createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { queryKeys } from '../api/query'
import { AppNavigationHistoryProvider } from './AppNavigationHistory'
import { AppNavigationTrail } from './AppNavigationTrail'
import { UnsavedChangesProvider } from './UnsavedChangesProvider'
import { useUnsavedChanges } from './unsavedChanges'

const clients: QueryClient[] = []
const histories: ReturnType<typeof createBrowserHistory>[] = []
afterEach(() => { cleanup(); histories.splice(0).forEach(history => history.destroy()); clients.splice(0).forEach(client => client.clear()) })
function Editor({ pending = false, uncertain = false }: { pending?: boolean; uncertain?: boolean }) {
  const [dirty, setDirty] = useState(false)
  useUnsavedChanges({ label: 'test settings', dirty, busy: pending && dirty, uncertain: uncertain && dirty,
    save: () => setDirty(false), discard: () => setDirty(false) })
  return <button onClick={() => setDirty(true)}>Edit settings</button>
}
function mount(path: string, editor?: { pending?: boolean; uncertain?: boolean }, unknownPredecessor?: string, browserHistory = false,
  seed?: (client: QueryClient) => void) {
  const root = createRootRoute({ component: () => <AppNavigationHistoryProvider><UnsavedChangesProvider>
    <AppNavigationTrail /><Outlet />
  </UnsavedChangesProvider></AppNavigationHistoryProvider> })
  const paths = ['/workspaces', '/settings/general', '/settings', '/settings/harnesses',
    '/settings/bugs', '/settings/system-prompt', '/workspaces/$workspaceId',
    '/workspaces/$workspaceId/files', '/workspaces/$workspaceId/settings',
    '/workspaces/$workspaceId/workflows', '/workspaces/$workspaceId/workflows/$workflowId/draft',
    '/workspaces/$workspaceId/workflows/$workflowId/runs/$runId/graph/$workflowVersionId/$executionSemanticsVersion']
  // Browser POP owns blocker handling; memory history only blocks push/replace.
  if (browserHistory) window.history.replaceState(null, '', path)
  const history = browserHistory ? createBrowserHistory() : createMemoryHistory({ initialEntries: unknownPredecessor ? [unknownPredecessor, path] : [path] })
  if (browserHistory) histories.push(history)
  const router = createRouter({ routeTree: root.addChildren(paths.map(path => createRoute({ getParentRoute: () => root,
    path, validateSearch: (search: Record<string, unknown>) => search, component: () => <>
      <Link to="/settings/general">Open general</Link><Link to="/settings">Open settings</Link>{editor ? <Editor {...editor} /> : null}
    </> }))), history, defaultPendingMinMs: 0 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  seed?.(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, client }
}

it('goes back to the actual previous app page across unrelated destinations', async () => {
  const { router } = mount('/settings/general')
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'Open settings' }))
  await act(() => router.navigate({ to: '/workspaces/$workspaceId/files', params: { workspaceId: 'workspace-1' } }))
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings/general'))
})

it.each(['?harness=codex', '?harness=codex&section=model', '?harness=claude&section=model&computer=main'])('uses the Harnesses ancestor for a direct model deep link %s', async search => {
  const { router } = mount(`/settings/harnesses${search}`)
  const user = userEvent.setup()
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Harnesses' })).toHaveAttribute('href', '/settings/harnesses')
  expect(breadcrumbs.querySelector('[aria-current="page"]')).toHaveTextContent('Model & speed')
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.search).toEqual({}))
  expect(router.state.location.pathname).toBe('/settings/harnesses')
})

it('shows General in the breadcrumb and returns to Settings from a direct link', async () => {
  const { router } = mount('/settings/general')
  const user = userEvent.setup()
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(breadcrumbs.querySelector('[aria-current="page"]')).toHaveTextContent('General')
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Settings' })).toHaveAttribute('href', '/settings')
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

it.each([
  ['/settings/bugs', 'Bugs'],
  ['/settings/system-prompt', 'System prompt'],
])('shows the settings breadcrumb for %s and returns to Settings', async (path, label) => {
  const { router } = mount(path)
  const user = userEvent.setup()
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(breadcrumbs.querySelector('[aria-current="page"]')).toHaveTextContent(label)
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Settings' })).toHaveAttribute('href', '/settings')
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

it.each(['/sign-in', '/outside-app', '/settings/general'])('does not revisit an unobserved predecessor %s', async predecessor => {
  const { router } = mount('/settings/harnesses?harness=codex&section=model', undefined, predecessor)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Back' }))
  await waitFor(() => expect(router.state.location.search).toEqual({}))
  expect(router.state.location.pathname).toBe('/settings/harnesses')
})

it('shows server names, real ancestors and a non-link current crumb without altering a pinned Run', async () => {
  const path = '/workspaces/workspace-1/workflows/workflow-content-pipeline/runs/run-owned/graph/version-owned/3'
  const { router } = mount(path)
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(await within(breadcrumbs).findByRole('link', { name: 'Go to Website' })).toHaveAttribute('href', '/workspaces/workspace-1')
  expect(await within(breadcrumbs).findByRole('link', { name: 'Go to Research to review' })).toHaveAttribute('href', '/workspaces/workspace-1/workflows/workflow-content-pipeline/draft')
  const current = breadcrumbs.querySelector('[aria-current="page"]')
  expect(current?.tagName).toBe('SPAN')
  expect(current).toHaveTextContent('Run graph')
  expect(router.state.location.pathname).toBe(path)
})

it('never displays private identifiers as workspace labels after a denied read', async () => {
  server.use(http.get('/api/management/workspaces/:workspaceId', () => HttpResponse.json({ code: 'FORBIDDEN', message: 'Denied' }, { status: 403 })))
  mount('/workspaces/private-workspace/files')
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(breadcrumbs).not.toHaveTextContent('private-workspace')
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Workspace' })).toBeVisible()
})

it('hides a previously read private name through authorization and subsequent network failures', async () => {
  const { client } = mount('/workspaces/workspace-1/files')
  await screen.findByRole('link', { name: 'Go to Website' })
  server.use(http.get('/api/management/workspaces/:workspaceId', () => HttpResponse.json({ code: 'FORBIDDEN', message: 'Denied' }, { status: 403 })))
  await act(() => client.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') }))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Go to Website' })).not.toBeInTheDocument())
  server.use(http.get('/api/management/workspaces/:workspaceId', () => HttpResponse.json({ code: 'UNAVAILABLE', message: 'Offline' }, { status: 500 })))
  await act(() => client.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') }))
  expect(screen.getByRole('link', { name: 'Go to Workspace' })).toBeVisible()
})

it('keeps the original destination when a dirty editor cancels previous-page navigation', async () => {
  const { router } = mount('/settings/general', {}, undefined, true)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('link', { name: 'Open settings' }))
  await user.click(screen.getByRole('button', { name: 'Edit settings' }))
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(router.state.location.pathname).toBe('/settings')
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Save changes before leaving?' })).not.toBeInTheDocument())
  await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  expect(router.state.location.pathname).toBe('/settings')
  await user.click(screen.getByRole('button', { name: 'Back' }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings/general'))
})

it.each([{ pending: true }, { uncertain: true }])('locks discard for pending or unconfirmed saves during Back: %j', async editor => {
  const { router } = mount('/settings/harnesses?harness=codex&section=model', editor)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Edit settings' }))
  await user.click(screen.getByRole('button', { name: 'Back' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  expect(router.state.location.search.harness).toBe('codex')
})

it('names a workspace and workflow from cached data before their own reads return, without swapping placeholder words', async () => {
  server.use(
    http.get('/api/management/workspaces/workspace-1', () => new Promise<never>(() => {})),
    http.get('/api/management/workspaces/workspace-1/workflows/workflow-1', () => new Promise<never>(() => {})),
  )
  mount('/workspaces/workspace-1/workflows/workflow-1/draft', undefined, undefined, false, client => {
    client.setQueryData(['workbench', 'workspace', 'workspace-1', 'details'], { workspace: { id: 'workspace-1', name: 'Website' },
      workflows: [{ id: 'workflow-1', name: 'Release notes' }], agents: [], runs: [] })
  })
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Website' })).toBeVisible()
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Release notes' })).not.toHaveClass('is-pending')
})

it('keeps a stable placeholder while an uncached workspace name loads', async () => {
  server.use(http.get('/api/management/workspaces/workspace-2', () => new Promise<never>(() => {})))
  mount('/workspaces/workspace-2/files')
  const breadcrumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' })
  expect(within(breadcrumbs).getByRole('link', { name: 'Go to Workspace' })).toHaveClass('is-pending')
})

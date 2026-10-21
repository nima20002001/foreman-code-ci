import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { WorkflowBoard } from './WorkflowBoard'

it('opens live workflow memory only when requested and keeps the graph mounted on close', async () => {
  let reads = 0
  server.use(http.get('/api/memory-boards', () => {
    reads++
    const page = { items: [], hasMore: false, nextCursor: null, revision: 0 }
    return HttpResponse.json({ board: { id: 'workflow-memory',
      scope: { kind: 'workflow', workspaceId: 'workspace-1', workflowId: 'workflow-1' }, revision: 0 },
      openColumns: ['todo', 'doing', 'blocked'].map(status => ({ ...page, status })), notes: page,
      counts: { todo: 0, doing: 0, blocked: 0, done: 0, completed: 0, dropped: 0, notes: 0 }, sequence: 0 })
  }))
  const root = createRootRoute({ component: Outlet })
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse,
    component: () => <WorkflowBoard workspaceId="workspace-1" workflowId="workflow-1"
      inspection={{}} summaries={[]} selectInspection={() => undefined} selectRun={() => undefined}>
      <label>Graph draft<input defaultValue="Retained graph edit" /></label>
    </WorkflowBoard>,
  })
  const router = createRouter({ routeTree: root.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?workflowId=workflow-1'] }) })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  try {
    const user = userEvent.setup()
    const draft = await screen.findByRole('textbox', { name: 'Graph draft' })
    expect(reads).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Memory board' }))
    const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
    expect(await within(dialog).findByRole('button', { name: 'Add card' })).toBeVisible()
    expect(reads).toBe(2)
    await user.click(within(dialog).getByRole('button', { name: 'Close memory board' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Graph draft' })).toBe(draft)
    expect(draft).toHaveValue('Retained graph edit')
    expect(reads).toBe(2)
  } finally { view.unmount(); cache.clear() }
})

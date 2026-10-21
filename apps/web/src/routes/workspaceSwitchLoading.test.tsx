import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { server } from '../mocks/server'

function renderRoute(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>)
  return { router, queryClient }
}

/** A second workspace whose identity read stays pending until `release` is called. */
async function slowSecondWorkspace() {
  const created = await fetch('/api/management/workspaces', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second' }),
  })
  const id = ((await created.json()) as { value: { workspace: { id: string } } }).value.workspace.id
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  server.use(http.get(`/api/management/workspaces/${id}`, async () => { await gate; return undefined }))
  return { id, release }
}

describe('switching workspaces while the workspace identity loads', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })
  beforeEach(() => {
    server.use(http.get('*/api/workspaces/:workspaceId/reference-files', () =>
      HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
  })

  it('shows the Project files section instead of a page-wide skeleton over it', async () => {
    const { router, queryClient } = renderRoute('/workspaces/workspace-1/files')
    await waitFor(() => expect(screen.getByText('No files.')).toBeVisible())
    const second = await slowSecondWorkspace()
    await queryClient.invalidateQueries()

    await router.navigate({ to: '/workspaces/$workspaceId/files', params: { workspaceId: second.id } })

    const sections = await screen.findByRole('navigation', { name: 'Workspace sections' })
    expect(within(sections).getByRole('link', { name: 'Project files' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('No files.')).toBeVisible()
    expect(screen.queryByText('Loading workspace…')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Workspace actions' })).not.toBeInTheDocument()
    second.release()
    expect(await screen.findByRole('button', { name: 'Rename workspace Second' })).toBeVisible()
    expect(screen.getByText('No files.')).toBeVisible()
  })

  it('keeps the section navigation in place while only the settings actions show their own skeleton', async () => {
    const { router, queryClient } = renderRoute('/workspaces/workspace-1/workflows')
    await waitFor(() => expect(screen.getByTestId('workflow-card-workflow-content-pipeline')).toBeVisible())
    const second = await slowSecondWorkspace()
    await queryClient.invalidateQueries()

    await router.navigate({ to: '/workspaces/$workspaceId/settings', params: { workspaceId: second.id } })

    const sections = await screen.findByRole('navigation', { name: 'Workspace sections' })
    const content = sections.parentElement!.querySelector<HTMLElement>('.workspace-detail-content')!
    const skeleton = await within(content).findByRole('status')
    expect(skeleton).toHaveTextContent('Loading workspace…')
    expect(screen.getAllByRole('status').filter((item) => !content.contains(item))
      .some((item) => item.textContent?.includes('Loading workspace…'))).toBe(false)
    second.release()
    expect(await screen.findByRole('group', { name: 'Workspace actions' })).toBeVisible()
    expect(screen.queryByText('Loading workspace…')).not.toBeInTheDocument()
  })
})

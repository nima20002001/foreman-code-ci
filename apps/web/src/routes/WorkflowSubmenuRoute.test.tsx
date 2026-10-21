import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { routeTree } from '../app/router'
import { setMockScenario } from '../shared/mocks/scenarios'

function renderRoute(path: string) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

describe('workflow submenu route integration', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    setMockScenario('normal')
    sessionStorage.clear()
  })

  it('mounts the nested workflow submenu on workspace section routes', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    const submenu = await screen.findByRole('region', { name: 'Workspace workflows' }, { timeout: 5000 })
    expect(within(submenu).getByRole('button', { name: 'New workflow' })).toBeVisible()
    const workflow = await within(submenu).findByRole('button', { name: /^Research to review/ })
    await userEvent.click(workflow)
    await waitFor(() => expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline'))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
  })

  it('keeps New workflow visible when the workspace has no workflows', async () => {
    setMockScenario('empty')
    renderRoute('/workspaces/workspace-1')

    expect(await screen.findByTestId('workflow-navigation-empty')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Workspace workflows' })).getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('marks the URL-selected workflow active on the graph route', async () => {
    renderRoute('/workspaces/workspace-1?workflowId=workflow-content-pipeline')

    const submenu = await screen.findByRole('region', { name: 'Workspace workflows' })
    const workflow = await within(submenu).findByRole('button', { name: /^Research to review/ })
    expect(workflow).toHaveAttribute('aria-current', 'page')
  })
})

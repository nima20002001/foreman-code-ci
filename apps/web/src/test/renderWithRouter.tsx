import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'

const shellDestinationPaths = [
  '/workspaces',
  '/workspaces/$workspaceId',
  '/workspaces/$workspaceId/workflows',
  '/workspaces/$workspaceId/agents',
  '/workspaces/$workspaceId/files',
  '/workspaces/$workspaceId/tasks',
  '/workspaces/$workspaceId/runs',
  '/workspaces/$workspaceId/terminal',
  '/workspaces/$workspaceId/settings',
  '/terminal',
  '/settings',
  '/settings/general',
] as const

/** Renders UI that uses router-aware links inside a minimal in-memory router. */
export function renderWithRouter(ui: ReactElement) {
  const rootRoute = createRootRoute({ component: Outlet })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => ui,
  })
  const routeTree = rootRoute.addChildren([
    indexRoute,
    ...shellDestinationPaths.map((path) =>
      createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
    ),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return {
    router,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { routeTree } from '../app/router'
import { server } from '../mocks/server'
import { mockRuntimeIdentity } from '../shared/mocks/handlers'

it('opens General settings from the settings directory and keeps the route linkable', async () => {
  server.use(
    http.get('*/api/management/computers/activity', () => HttpResponse.json({
      mainId: mockRuntimeIdentity.installationId, activityComplete: true, truncated: false, computers: [], cloud: [],
    })),
    http.get('*/api/management/file-retention', () => HttpResponse.json({
      preference: { ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0 },
    })),
  )
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/settings'] }) })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  const link = await screen.findByRole('link', { name: 'General' })
  expect(link).toHaveAttribute('href', '/settings/general')
  await userEvent.click(link)
  expect(await screen.findByRole('heading', { name: 'General', level: 1 })).toBeVisible()
  expect(router.state.location.pathname).toBe('/settings/general')
  expect(await screen.findByRole('combobox', { name: 'Theme' })).toHaveValue('dark')
  expect(await screen.findByRole('region', { name: 'Chat retention' })).toBeVisible()
  expect(await screen.findByRole('spinbutton', { name: 'Duration' })).toHaveValue(7)
})

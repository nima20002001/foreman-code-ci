import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { configure, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { routeTree } from './router'
import { server } from '../mocks/server'
import { installBoardTestLifecycle, newBoardQueryClient } from '../features/workflow-board/eng05D.testSupport'

installBoardTestLifecycle()
configure({ asyncUtilTimeout: 1000 })

it('mounts the browser profile manager in production Settings', async () => {
  server.use(
    http.get('/api/devices/main', () => HttpResponse.json({ mainId: '11111111-1111-4111-8111-111111111111',
      mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })),
    http.post('/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: unknown }
      return HttpResponse.json({ computers: [{ target, status: null }] })
    }),
    http.get('/api/browser/profiles', () => HttpResponse.json({
    profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0,
  })))
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/settings/browser-profiles'] }) })
  await router.load()
  render(<QueryClientProvider client={newBoardQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  expect(await screen.findByRole('button', { name: 'Add profile here' })).toBeVisible()
  expect(screen.queryByText('Browser profile management is not available yet.')).not.toBeInTheDocument()
})

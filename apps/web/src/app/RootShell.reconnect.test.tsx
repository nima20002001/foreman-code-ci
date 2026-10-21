import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import type { WorkspaceFolderCreateInput } from '@foreman-code/contracts/management'
import { WorkspaceFolderPicker } from '../features/settings/WorkspaceFolderPicker'
import { server } from '../mocks/server'
import { settingsExperienceKeys } from '../shared/api/settingsExperience'
import { mockRuntimeIdentity } from '../shared/mocks/handlers'
import { RootShell } from './RootShell'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

it.each(['network', 503] as const)('preserves folder selection, pending creation and naming state through %s', async failure => {
  let accessFailure = false
  let loseCreationReply = true
  const creations: WorkspaceFolderCreateInput[] = []
  let identityReads = 0
  server.use(
    http.get('/api/local-human', () => {
      if (accessFailure) {
        if (failure === 'network') return HttpResponse.error()
        return HttpResponse.json({ error: { code: 'SESSION_CHECK_FAILED', message: 'Main is reconnecting.' } },
          { status: failure })
      }
      return HttpResponse.json({ principal: { id: 'owner', name: 'Browser', expiresAt: '2099-01-01T00:00:00Z',
        grants: [{ actions: ['settings:read', 'harnesses:read', 'harnesses:update'], scope: {} }] } })
    }),
    http.get('/api/runtime/identity', () => { identityReads++; return HttpResponse.json(mockRuntimeIdentity) }),
    http.get('/api/management/harnesses/directories', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '/projects'
      return HttpResponse.json({
        roots: [{ id: 'projects', label: 'Projects', path: '/projects' }], rootId: 'projects', path,
        parent: path === '/projects' ? null : '/projects', nextCursor: null,
        directories: path === '/projects' ? [{ name: 'Project', path: '/projects/Project' }] : [],
      })
    }),
    http.post('/api/management/harnesses/directories', async ({ request }) => {
      const input = await request.json() as WorkspaceFolderCreateInput
      creations.push(input)
      return loseCreationReply ? HttpResponse.error()
        : HttpResponse.json({ value: { name: 'New folder', path: `${input.parentPath}/New folder` }, replayed: true })
    }),
  )
  const root = createRootRoute({ component: RootShell })
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => <>
    <input aria-label="Unsaved settings" defaultValue="" />
    <WorkspaceFolderPicker disabled={false} value="" onSelect={() => {}} />
  </> })
  const router = createRouter({ routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  const user = userEvent.setup()
  const settings = await screen.findByRole('textbox', { name: 'Unsaved settings' })
  await user.type(settings, 'Uncommitted settings')
  await user.click(screen.getByRole('button', { name: 'Project folder' }))
  await user.click(await screen.findByRole('button', { name: 'Project' }))
  const destination = screen.getByRole('textbox', { name: 'Destination' })
  await waitFor(() => expect(destination).toHaveValue('/projects/Project'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'New folder' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'New folder' }))
  await screen.findByText('Creation could not be confirmed. Retry creation to resolve the same request.')
  const commandId = creations[0]!.commandId
  const reconnect = async () => {
    accessFailure = true
    await act(async () => { await client.invalidateQueries({ queryKey: settingsExperienceKeys.access(), exact: true }) })
    expect(await screen.findByRole('alert', { name: 'Server connection' })).toBeInTheDocument()
    await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-identity'] }) })
    expect(identityReads).toBeGreaterThan(1)
    accessFailure = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert', { name: 'Server connection' })).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: 'Unsaved settings' })).toBe(settings)
    expect(settings).toHaveValue('Uncommitted settings')
  }
  await reconnect()
  expect(screen.getByRole('textbox', { name: 'Destination' })).toBe(destination)
  expect(destination).toHaveValue('/projects/Project')
  loseCreationReply = false
  await user.click(screen.getByRole('button', { name: 'Retry creation' }))
  const name = await screen.findByRole('textbox', { name: 'Folder name' })
  expect(creations.map(input => input.commandId)).toEqual([commandId, commandId])
  await user.clear(name)
  await user.type(name, 'My unsaved folder name')
  await reconnect()
  expect(screen.getByRole('textbox', { name: 'Folder name' })).toBe(name)
  expect(name).toHaveValue('My unsaved folder name')
})

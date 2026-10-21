import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { deferred } from '../../test/deferred'
import { ReleaseAutoReload, RuntimeInstanceBoundary } from '../../app/RuntimeInstanceBoundary'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { documentBuildIdentity } from '../../shared/api/documentBuildIdentity'
import { finishSessionChange } from '../../shared/api/sessionBoundary'
import { bindProtectedChatInstance } from '../../shared/api/protectedChatStorage'
import { WorkspaceNavigation } from './WorkspaceNavigation'

vi.mock('../../shared/api/protectedChatStorage', async original => ({
  ...await original<typeof import('../../shared/api/protectedChatStorage')>(), bindProtectedChatInstance: vi.fn(() => false),
}))
const identity = { installationId: 'd95abeb8-598a-49a4-8c3c-c6e3533053e8', checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
const created = { value: { workspace: { id: 'workspace-created', name: 'Project' }, revision: 1,
  archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'restricted' } }, replayed: false }
const clients: ReturnType<typeof renderWithRouter>['queryClient'][] = []

beforeEach(() => {
  vi.mocked(bindProtectedChatInstance).mockReturnValue(false)
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json(identity)),
    http.get('*/api/runtime/build-identity/v1', () => HttpResponse.json(documentBuildIdentity)),
    http.get('*/api/management/settings/workspaces/creation', () => HttpResponse.json({
      suggestedName: 'Project', description: '', parentPath: '/projects',
    })))
})
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  finishSessionChange()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function mountCreation() {
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  const mounted = renderWithRouter(<RuntimeInstanceBoundary><UnsavedChangesProvider>
    <ReleaseAutoReload /><WorkspaceNavigation workspaceId="workspace-1" workspaces={[]} workflowsContent={<span />} />
  </UnsavedChangesProvider></RuntimeInstanceBoundary>)
  clients.push(mounted.queryClient)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'New workspace' }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Project'))
  return { ...mounted, reload, user }
}
async function release(client: ReturnType<typeof renderWithRouter>['queryClient']) {
  server.use(http.get('*/api/runtime/build-identity/v1', () =>
    HttpResponse.json({ ...documentBuildIdentity, buildId: 'c'.repeat(64) })))
  await act(async () => { await client.invalidateQueries({ queryKey: ['workbench', 'runtime-build-identity'] }) })
}

it('blocks a release reload for an edited workspace until the draft is closed', async () => {
  const mounted = await mountCreation()
  await mounted.user.type(screen.getByRole('textbox', { name: 'Name' }), ' draft')
  vi.useFakeTimers({ shouldAdvanceTime: true })
  await release(mounted.queryClient)
  expect(await screen.findByText('App updated. Your pending changes are kept until it can reload.')).toBeVisible()
  expect(mounted.reload).not.toHaveBeenCalled()
  await mounted.user.click(within(screen.getByRole('dialog', { name: 'New workspace' })).getByRole('button', { name: 'Close' }))
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(mounted.reload).toHaveBeenCalledOnce()
})

it('retains the workspace command through a pending request and a lost response', async () => {
  const pending = deferred<void>()
  const inputs: unknown[] = []
  server.use(http.post('*/api/management/workspaces', async ({ request }) => {
    inputs.push(await request.json())
    if (inputs.length === 1) { await pending.promise; return HttpResponse.error() }
    return HttpResponse.json({ ...created, replayed: true })
  }))
  const mounted = await mountCreation()
  await mounted.user.click(screen.getByRole('button', { name: 'Create workspace' }))
  await waitFor(() => expect(inputs).toHaveLength(1))
  vi.useFakeTimers({ shouldAdvanceTime: true })
  await release(mounted.queryClient)
  expect(mounted.reload).not.toHaveBeenCalled()
  await act(async () => { pending.resolve() })
  await screen.findByText(/previous request may have succeeded/)
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(mounted.reload).not.toHaveBeenCalled()
  vi.useRealTimers()
  await mounted.user.click(screen.getByRole('button', { name: 'Create workspace' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]).toEqual(inputs[0])
  await waitFor(() => expect(mounted.router.state.location.pathname).toBe('/workspaces/workspace-created/settings'))
})

it('blocks reload while a child folder creation is pending or unconfirmed and retries its command', async () => {
  const pending = deferred<void>()
  const inputs: unknown[] = []
  server.use(http.get('*/api/management/harnesses/directories', () => HttpResponse.json({
    roots: [{ id: 'projects', label: 'Projects', path: '/projects' }], rootId: 'projects', path: '/projects',
    parent: null, directories: [], nextCursor: null,
  })), http.post('*/api/management/harnesses/directories', async ({ request }) => {
    inputs.push(await request.json())
    if (inputs.length === 1) { await pending.promise; return HttpResponse.error() }
    return HttpResponse.json({ value: { path: '/projects/New folder', name: 'New folder' }, replayed: true })
  }))
  const mounted = await mountCreation()
  await mounted.user.click(screen.getByRole('button', { name: 'Location' }))
  await mounted.user.click(await screen.findByRole('button', { name: 'New folder' }))
  await waitFor(() => expect(inputs).toHaveLength(1))
  vi.useFakeTimers({ shouldAdvanceTime: true })
  await release(mounted.queryClient)
  expect(mounted.reload).not.toHaveBeenCalled()
  await act(async () => { pending.resolve() })
  await screen.findByRole('button', { name: 'Retry creation' })
  await act(() => vi.advanceTimersByTimeAsync(5_000))
  expect(mounted.reload).not.toHaveBeenCalled()
  vi.useRealTimers()
  await mounted.user.click(screen.getByRole('button', { name: 'Retry creation' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]).toEqual(inputs[0])
})

it('sends the document installation on creation before the identity poll detects a replacement', async () => {
  let writes = 0
  let installation: string | null = null
  server.use(http.post('*/api/management/workspaces', ({ request }) => {
    installation = request.headers.get('x-foreman-installation-id')
    if (installation === identity.installationId) return HttpResponse.json({
      error: { code: 'INSTALLATION_CHANGED', message: 'Reload the app.' },
    }, { status: 409 })
    writes++
    return HttpResponse.json(created)
  }))
  const mounted = await mountCreation()
  // The origin now serves a replacement database, before the next identity read.
  server.use(http.get('*/api/runtime/identity', () => HttpResponse.json({ ...identity,
    installationId: '8b8fe654-6e4a-4d4c-b451-2795ccbf7074' })))
  await mounted.user.click(screen.getByRole('button', { name: 'Create workspace' }))
  await waitFor(() => expect(installation).toBe(identity.installationId))
  expect(writes).toBe(0)
  await waitFor(() => expect(mounted.reload).toHaveBeenCalledOnce())
  expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
})

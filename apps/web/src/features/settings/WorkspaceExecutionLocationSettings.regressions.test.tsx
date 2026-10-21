import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { boundLocationKeys } from '../../shared/api/workspaceBoundLocation'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { mainRoot, workerRoot, boundRootReadback } from './workspaceBoundLocation.fixtures'
import { deferred } from '../../test/deferred'
const clients: QueryClient[] = []
function workspace(id: string): ManagedWorkspace { return { workspace: { id, name: id }, revision: 1, archivedAt: null,
  executionLocation: { runnerId: 'existing-server-runner', rootPath: `/previous/${id}` }, locationRevision: 1,
  locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00.000Z' } } }
function mount(onSaved = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client)
  for (const id of ['workspace-a', 'workspace-b']) client.setQueryData(queryKeys.managedWorkspace(id), workspace(id))
  const element = (id: string) => <QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId={id} onSaved={onSaved} /></QueryClientProvider>
  const view = render(element('workspace-a'))
  return { client, onSaved, navigate: (id: string) => view.rerender(element(id)) }
}
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Project folder' }))
  const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
  await user.selectOptions(select, select.querySelectorAll('option')[2]!.value)
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  server.use(http.get('/api/management/workspaces/:workspaceId/root-location', ({ params }) => HttpResponse.json({ evidence: 'legacy_missing', workspaceId: params.workspaceId,
    locationRevision: params.workspaceId === 'workspace-a' ? 1 : 7, executionLocation: { runnerId: 'server-original', rootPath: `/previous/${params.workspaceId}` } })),
    http.get('/api/management/workspaces/:workspaceId/root-policies', ({ params }) => HttpResponse.json({ workspaceId: params.workspaceId, readiness: 'metadata-only', policies: [], allowlists: [mainRoot, workerRoot] })))
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('bound workspace location acknowledgement fences', () => {
  it('keeps a late workspace-A save out of workspace B and does not close B’s dialog', async () => {
    const gate = deferred(), started = deferred()
    server.use(http.put('/api/management/workspaces/workspace-a/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; started.resolve(); await gate.promise
      return HttpResponse.json({ value: boundRootReadback(input, workerRoot), replayed: false })
    }))
    const view = mount(); const user = userEvent.setup(); await choose(user)
    await user.type(screen.getByRole('textbox', { name: 'Relative folder on this computer' }), 'from-a')
    await user.click(screen.getByRole('button', { name: 'Select location' })); await started.promise
    view.navigate('workspace-b'); await choose(user)
    await act(async () => { gate.resolve(); await gate.promise })
    await waitFor(() => expect(view.client.isMutating()).toBe(0))
    expect(view.onSaved).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Execution folder' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Relative folder on this computer' })).toHaveValue('')
    expect(view.client.getQueryData<{ locationRevision: number }>(boundLocationKeys.read('workspace-b'))?.locationRevision).toBe(7)
  })
  it('retains the original command after permission to reconcile is withdrawn', async () => {
    const requests: unknown[] = []
    server.use(http.put('/api/management/workspaces/workspace-a/root-location', async ({ request }) => { requests.push(await request.json())
      return HttpResponse.json({ error: { code: requests.length === 1 ? 'INTERNAL' : 'FORBIDDEN', message: 'Outcome cannot be read.' } }, { status: requests.length === 1 ? 503 : 403 }) }))
    mount(); const user = userEvent.setup(); await choose(user); await user.click(screen.getByRole('button', { name: 'Select location' }))
    await user.click(await screen.findByRole('button', { name: 'Reconcile original selection' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual(requests[0])
    expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toBeDisabled()
  })
  it('requires explicit reload after a location conflict and uses the refreshed revision', async () => {
    let currentRevision = 1
    const writes: WorkspaceRootSelection[] = []
    server.use(http.get('/api/management/workspaces/workspace-a/root-location', () => HttpResponse.json({ evidence: 'legacy_missing', workspaceId: 'workspace-a', locationRevision: currentRevision,
      executionLocation: { runnerId: 'existing-server-runner', rootPath: '/changed' } })),
      http.put('/api/management/workspaces/workspace-a/root-location', async ({ request }) => {
        const input = await request.json() as WorkspaceRootSelection; writes.push(input)
        if (writes.length === 1) { currentRevision = 2; return HttpResponse.json({ error: { code: 'LOCATION_REVISION_CONFLICT', message: 'Saved location changed.', details: { currentLocationRevision: 2 } } }, { status: 409 }) }
        return HttpResponse.json({ value: boundRootReadback(input, workerRoot), replayed: false })
      }))
    mount(); const user = userEvent.setup(); await choose(user); await user.click(screen.getByRole('button', { name: 'Select location' }))
    await user.click(await screen.findByRole('button', { name: 'Reload saved location' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toHaveValue(''))
    const select = screen.getByRole('combobox', { name: 'Computer and approved base folder' })
    await user.selectOptions(select, select.querySelectorAll('option')[2]!.value)
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]?.expectedLocationRevision).toBe(2)
  })
})

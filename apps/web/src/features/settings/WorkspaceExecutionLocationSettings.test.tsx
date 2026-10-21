import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceBoundLocationReadback } from '@foreman-code/contracts/workspace-bound-location'
import { server } from '../../mocks/server'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { mainRoot, workerRoot, rootMainId, rootAttestation, boundRootReadback, rootSetReadback } from './workspaceBoundLocation.fixtures'
const clients: QueryClient[] = []
let saved: WorkspaceBoundLocationReadback
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId="workspace-1" /></QueryClientProvider>) }
async function choose(user: ReturnType<typeof userEvent.setup>, remote = true) {
  await user.click(await screen.findByRole('button', { name: 'Project folder' }))
  const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
  const options = select.querySelectorAll('option')
  await user.selectOptions(select, options[remote ? 2 : 1]!.value)
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  saved = boundRootReadback({ workspaceId: 'workspace-1', hostRef: mainRoot.hostRef,
    allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: 'previous',
    accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }, mainRoot)
  server.use(http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json(saved)),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot, workerRoot] })),
    http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => { const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, browse: { relativePath: input.relativePath, directories: [{ name: 'src', relativePath: 'src' }], truncated: false } }) }),
    http.post('/api/management/workspaces/workspace-1/root-location/validate', async ({ request }) => { const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, attestation: rootAttestation(input, input.hostRef.kind === 'main' ? mainRoot : workerRoot), checkedAt: '2026-10-01T00:00:00.000Z' }) }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('authenticated target-local execution folder', () => {
  it.each(['browse', 'validate'])('allows dismissal during a pending %s read', async operation => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(`/api/management/workspaces/workspace-1/root-location/${operation}`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      await pending
      return HttpResponse.json(operation === 'browse'
        ? { workspaceId: input.workspaceId, selection: input, browse: { relativePath: input.relativePath, directories: [], truncated: false } }
        : { workspaceId: input.workspaceId, selection: input, attestation: rootAttestation(input, workerRoot), checkedAt: '2026-10-01T00:00:00.000Z' })
    }))
    mount()
    const user = userEvent.setup()
    await choose(user)
    await user.click(screen.getByRole('button', { name: operation === 'browse' ? 'Browse this computer' : 'Validate candidate folder' }))
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    await user.click(cancel)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { release(); await pending })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('lets an invalid native folder selection be corrected after a definitive rejection', async () => {
    const writes: WorkspaceRootSelection[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      writes.push(input)
      if (input.relativePath === 'project/') return HttpResponse.json({
        error: { code: 'ROOT_RELATIVE_PATH_INVALID', message: 'Choose an unambiguous folder relative to an approved base.' },
      }, { status: 422 })
      saved = boundRootReadback(input, mainRoot)
      return HttpResponse.json({ value: saved, replayed: false })
    }))
    mount()
    const user = userEvent.setup()
    await choose(user, false)
    const field = screen.getByRole('textbox', { name: 'Relative folder on this computer' })
    await user.type(field, 'project/')
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.getAllByText('Choose an unambiguous folder relative to an approved base.').length)
      .toBeGreaterThan(0))
    expect(field).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Reconcile original selection' })).not.toBeInTheDocument()
    await user.clear(field)
    await user.type(field, 'project')
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes.map(write => write.relativePath)).toEqual(['project/', 'project'])
  })
  it('browses and validates on the selected worker, then saves exact binding without a browser runner ID', async () => {
    const writes: WorkspaceRootSelection[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      expect(input.hostRef).toEqual(workerRoot.hostRef); expect(input.allowedBaseId).toBe(workerRoot.bases[0]!.baseId)
      expect(input).not.toHaveProperty('runnerId')
      return HttpResponse.json({ value: rootSetReadback(input, workerRoot), replayed: false })
    }))
    mount(); const user = userEvent.setup(); await choose(user)
    await user.click(screen.getByRole('button', { name: 'Browse this computer' })); await user.click(await screen.findByRole('button', { name: 'src' }))
    await user.click(screen.getByRole('button', { name: 'Validate candidate folder' }))
    expect(await screen.findByText(/Candidate verified on Worker/)).toHaveTextContent('/projects/shared/src. Not saved yet.')
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Execution folder' })).not.toBeInTheDocument())
    expect(screen.getByText('Saved execution computer').nextElementSibling).toHaveTextContent(rootMainId)
    expect(writes[0]).toMatchObject({ relativePath: 'src', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })
  })
  it('reconciles the original command and locks computer/path changes after a lost acknowledgement', async () => {
    const writes: unknown[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Acknowledgement lost.' } }, { status: 503 })
      expect(writes[1]).toEqual(writes[0])
      return HttpResponse.json({ value: rootSetReadback(input, workerRoot), replayed: true })
    }))
    mount(); const user = userEvent.setup(); await choose(user); await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(await screen.findByText(/The save outcome is unknown/)).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Relative folder on this computer' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reconcile original selection' }))
    await waitFor(() => expect(writes).toHaveLength(2))
  })
  it('keeps paths distinct when two computers have identical approved base paths', async () => {
    mount(); const user = userEvent.setup(); await choose(user, false)
    await user.type(screen.getByRole('textbox', { name: 'Relative folder on this computer' }), 'pc-only')
    const select = screen.getByRole('combobox', { name: 'Computer and approved base folder' }); const options = select.querySelectorAll('option')
    await user.selectOptions(select, options[2]!.value)
    expect(screen.getByRole('textbox', { name: 'Relative folder on this computer' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Relative folder on this computer' }), 'worker-only')
    await user.selectOptions(select, options[1]!.value)
    expect(screen.getByRole('textbox', { name: 'Relative folder on this computer' })).toHaveValue('pc-only')
  })
  it('shows denied root metadata and does not expose the local folder browser as a fallback', async () => {
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Root access denied.' } }, { status: 403 })))
    mount()
    expect(await screen.findByText('Project folder or computer roots could not be loaded.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Project folder' })).not.toBeInTheDocument()
  })
})

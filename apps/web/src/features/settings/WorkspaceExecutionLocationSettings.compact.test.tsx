import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceBoundLocationReadback } from '@foreman-code/contracts/workspace-bound-location'
import { server } from '../../mocks/server'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
import { boundLocationKeys } from '../../shared/api/workspaceBoundLocation'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { mainRoot, workerRoot, rootMainId, boundRootReadback } from './workspaceBoundLocation.fixtures'

const clients: QueryClient[] = []
const base = mainRoot.bases[0]!.canonicalPath
let saved: WorkspaceBoundLocationReadback
let folders: string[]
let writes: WorkspaceRootSelection[]
let localRootReads: string[]
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId="workspace-1" presentation="compact" /></QueryClientProvider>)
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  saved = { evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 0,
    executionLocation: { runnerId: 'server-main-runner', rootPath: `${base}/existing` } }
  folders = ['existing', 'target']; writes = []; localRootReads = []
  server.use(
    http.get('/api/runtime/identity', () => HttpResponse.json({ ...mockRuntimeIdentity, installationId: rootMainId })),
    http.get('/api/management/settings/workspaces/creation', () => HttpResponse.json({ suggestedName: 'New workspace', description: '', parentPath: base })),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json(saved)),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot] })),
    // Confirm mutation roots independently; bound browsing still owns navigation.
    http.get('/api/management/harnesses/directories', ({ request }) => {
      localRootReads.push(new URL(request.url).search)
      return HttpResponse.json({ roots: [{ id: 'workspaces', label: 'Workspaces', path: base }], rootId: null, path: null, parent: null, directories: [], nextCursor: null })
    }),
    http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      expect(input.hostRef).toEqual(mainRoot.hostRef)
      expect(input.allowedBaseId).toBe(mainRoot.bases[0]!.baseId)
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, browse: { relativePath: input.relativePath,
        directories: input.relativePath ? [] : folders.map(name => ({ name, relativePath: name })), truncated: false } })
    }),
    http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      saved = boundRootReadback(input, mainRoot)
      return HttpResponse.json({ value: saved, replayed: false })
    }),
  )
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

describe('compact Main folder browser', () => {
  it('reloads a changed location revision from inside the folder picker before browsing and saving again', async () => {
    const requests: WorkspaceRootSelection[] = []
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only',
      policies: saved.evidence === 'bound' ? [saved.binding] : [], allowlists: [mainRoot],
    })), http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      requests.push(input)
      if (input.expectedLocationRevision !== saved.locationRevision) return HttpResponse.json({
        error: { code: 'LOCATION_REVISION_CONFLICT', message: 'The saved location changed.' },
      }, { status: 409 })
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, browse: {
        relativePath: input.relativePath,
        directories: input.relativePath ? [] : folders.map(name => ({ name, relativePath: name })), truncated: false,
      } })
    }))
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Execution location' }))
    await screen.findByRole('button', { name: 'target' })
    saved = boundRootReadback({ workspaceId: 'workspace-1', hostRef: mainRoot.hostRef,
      allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: 'existing',
      accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }, mainRoot)
    await act(async () => { await clients.at(-1)!.invalidateQueries({ queryKey: boundLocationKeys.read('workspace-1') }) })
    await user.click(screen.getByRole('button', { name: 'Reload saved location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Execution location' }))
    await user.click(await screen.findByRole('button', { name: 'target' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    expect(requests.at(-1)).toMatchObject({ expectedLocationRevision: 1, expectedRootPolicyRevision: 1 })
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ relativePath: 'target', expectedLocationRevision: 1, expectedRootPolicyRevision: 1 })
  })
  it('recognizes authoritative Main, navigates with one click and saves the exact approved binding', async () => {
    mount(); const user = userEvent.setup()
    const trigger = await screen.findByRole('button', { name: 'Execution location' })
    expect(trigger).toHaveAttribute('title', `${base}/existing`)
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    expect(dialog).toHaveClass('workspace-folder-dialog--minimal-labels')
    expect(within(dialog).getByRole('heading', { name: 'Choose folder' })).toHaveAttribute('id', dialog.getAttribute('aria-labelledby'))
    expect(within(dialog).queryByRole('heading', { name: 'Folders' })).not.toBeInTheDocument()
    expect(await within(dialog).findByRole('list', { name: 'Folders' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeVisible()
    expect(await within(dialog).findByRole('button', { name: 'New folder' })).toBeVisible()
    expect(dialog).toHaveTextContent('Main')
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    expect(await within(dialog).findByRole('button', { name: 'target' })).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'target' }))
    expect(await within(dialog).findByRole('textbox', { name: 'Destination' })).toHaveValue(`${base}/target`)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(within(dialog).getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose folder' })).not.toBeInTheDocument())
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ workspaceId: 'workspace-1', hostRef: mainRoot.hostRef, allowedBaseId: mainRoot.bases[0]!.baseId,
      configurationRevision: '1', relativePath: 'target', accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 })
    expect(writes[0]).not.toHaveProperty('runnerId')
    expect(screen.getByRole('button', { name: 'Execution location' })).toHaveAttribute('title', `${base}/target`)
    expect(new Set(localRootReads)).toEqual(new Set(['']))
  })

  it('uses existing authenticated folder creation and naming before the bound location save', async () => {
    const creations: unknown[] = [], names: unknown[] = []
    server.use(http.post('/api/management/harnesses/directories', async ({ request }) => {
      creations.push(await request.json()); folders.push('New folder')
      return HttpResponse.json({ value: { path: `${base}/New folder`, name: 'New folder' }, replayed: false })
    }), http.post('/api/management/harnesses/directories/rename', async ({ request }) => {
      const input = await request.json() as { name: string }; names.push(input)
      folders = folders.filter(name => name !== 'New folder').concat(input.name)
      return HttpResponse.json({ value: { path: `${base}/${input.name}`, name: input.name }, replayed: false })
    }))
    mount(); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Execution location' }))
    await screen.findByRole('button', { name: 'target' })
    await user.click(await screen.findByRole('button', { name: 'New folder' }))
    const name = await screen.findByRole('textbox', { name: 'Folder name' })
    expect(name).toHaveFocus()
    await user.clear(name); await user.type(name, 'Created folder{Enter}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(creations[0]).toMatchObject({ parentPath: base })
    expect(names[0]).toMatchObject({ name: 'Created folder', creationCommandId: (creations[0] as { commandId: string }).commandId })
    expect(writes[0]?.relativePath).toBe('Created folder')
    expect(new Set(localRootReads)).toEqual(new Set(['']))
  })

  it('retries the original binding command after lost acknowledgement', async () => {
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Folder acknowledgement lost.' } }, { status: 503 })
      saved = boundRootReadback(input, mainRoot)
      return HttpResponse.json({ value: saved, replayed: true })
    }))
    mount(); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Execution location' }))
    await user.click(await screen.findByRole('button', { name: 'target' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(await screen.findByRole('button', { name: 'Reconcile original selection' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1]).toEqual(writes[0])
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose folder' })).not.toBeInTheDocument())
  })

  it('offers the approved-root picker when no Main shortcut applies, without local browsing', async () => {
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [] })))
    mount(); const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Execution location' }))
    expect(await screen.findByText(/No approved folders are available/)).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument()
    expect(localRootReads).toEqual([])
    expect(writes).toHaveLength(0)
  })
  it('opens the general approved-root picker for a saved worker folder', async () => {
    saved = boundRootReadback({ workspaceId: 'workspace-1', hostRef: workerRoot.hostRef,
      allowedBaseId: workerRoot.bases[0]!.baseId, configurationRevision: workerRoot.configurationRevision,
      relativePath: 'project', accessMode: 'read-write', expectedLocationRevision: 0,
      expectedRootPolicyRevision: 0 }, workerRoot)
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only', policies: saved.evidence === 'bound' ? [saved.binding] : [], allowlists: [mainRoot, workerRoot],
    })))
    mount()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Execution location' }))
    expect(await screen.findByRole('combobox', { name: 'Computer and approved base folder' })).toBeVisible()
    expect(screen.queryByText('Main folder access is unavailable.')).not.toBeInTheDocument()
    expect(writes).toHaveLength(0)
    expect(localRootReads).toEqual([])
  })

  it('denies root metadata without opening a filesystem browser', async () => {
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Root metadata denied.' } }, { status: 403 })))
    mount()
    expect(await screen.findByText('Project folder or computer roots could not be loaded.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Execution location' })).not.toBeInTheDocument()
    expect(localRootReads).toEqual([])
    expect(writes).toHaveLength(0)
  })
})

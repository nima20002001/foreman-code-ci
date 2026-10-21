import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import type { WorkspaceBoundLocationReadback } from '@foreman-code/contracts/workspace-bound-location'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'

import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { boundLocationKeys } from '../../shared/api/workspaceBoundLocation'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { boundRootReadback, mainRoot, workerRoot, rootBinding, rootAttestation } from './workspaceBoundLocation.fixtures'

const checkedAt = '2026-09-19T00:00:00Z'
const workspaceId = 'workspace-select'
const base = mainRoot.bases[0]!
const managed: ManagedWorkspace = {
  workspace: { id: workspaceId, name: 'Selection test' }, revision: 1, archivedAt: null,
  executionLocation: { runnerId: 'runner-local', rootPath: '/projects' }, locationRevision: 1,
  locationValidation: { status: 'ready', checkedAt },
}
// Historical runner-local settings: a real path and revision, but no computer binding.
const legacy: WorkspaceBoundLocationReadback = { evidence: 'legacy_missing', workspaceId, locationRevision: 1, executionLocation: { runnerId: 'runner-local', rootPath: '/projects' } }
const mainSelection = (input: Partial<WorkspaceRootSelection> = {}): WorkspaceRootSelection => ({ workspaceId, hostRef: mainRoot.hostRef, allowedBaseId: base.baseId,
  configurationRevision: mainRoot.configurationRevision, relativePath: '', accessMode: 'read-only', expectedLocationRevision: 1, expectedRootPolicyRevision: 0, ...input })
let readback: WorkspaceBoundLocationReadback
let policies: unknown[]
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace(workspaceId), managed)
  render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId={workspaceId} /></QueryClientProvider>)
  return client
}
async function chooseChild() {
  const user = userEvent.setup()
  const field = await screen.findByRole('button', { name: 'Project folder' })
  await user.click(field)
  const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
  await user.selectOptions(select, select.querySelectorAll('option')[1]!.value)
  await user.type(screen.getByRole('textbox', { name: 'Relative folder on this computer' }), 'Child')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
  return { user, field }
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  readback = legacy; policies = []
  server.use(
    http.get(`/api/management/workspaces/${workspaceId}`, () => HttpResponse.json(managed)),
    http.get(`/api/management/workspaces/${workspaceId}/root-location`, () => HttpResponse.json(readback)),
    http.get(`/api/management/workspaces/${workspaceId}/root-policies`, () => HttpResponse.json({ workspaceId, readiness: 'metadata-only', policies, allowlists: [mainRoot, workerRoot] })),
    http.post(`/api/management/workspaces/${workspaceId}/root-location/validate`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId, selection: input, checkedAt,
        attestation: rootAttestation(input, input.hostRef.kind === 'main' ? mainRoot : workerRoot) })
    }),
  )
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

describe('destination confirmation owns persistence', () => {
  it('shows and copies the historical folder without opening the picker', async () => {
    const user = userEvent.setup()
    mount()
    const field = await screen.findByRole('button', { name: 'Project folder' })
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(screen.queryByText('Saved folder history has no computer binding. Select an approved computer before changing it.')).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Copy folder path' }))
    expect(await navigator.clipboard.readText()).toBe('/projects')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a chosen destination as a draft and Cancel preserves the page value without any write', async () => {
    const writes: unknown[] = []
    server.use(http.put(`/api/management/workspaces/${workspaceId}/root-location`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input); return HttpResponse.json({ value: boundRootReadback(input, mainRoot), replayed: false })
    }))
    const client = mount()
    const { user, field } = await chooseChild()
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(field.parentElement).not.toHaveTextContent('/projects/shared/Child')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field.parentElement).toHaveTextContent('/projects')
    expect(field).toHaveFocus()
    expect(writes).toEqual([])
    expect(client.getQueryData<{ locationRevision: number }>(boundLocationKeys.read(workspaceId))?.locationRevision).toBe(1)
  })

  it('waits for acknowledgement, then shows the destination in the original field', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writes: Record<string, unknown>[] = []
    server.use(http.put(`/api/management/workspaces/${workspaceId}/root-location`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      writes.push(input as unknown as Record<string, unknown>); await gate
      return HttpResponse.json({ value: boundRootReadback(input, mainRoot), replayed: false })
    }))
    const client = mount()
    client.setQueryData(queryKeys.managedWorkspaces, { items: [managed], pageInfo: { nextCursor: null } })
    const { user, field } = await chooseChild()
    try {
      await user.click(screen.getByRole('button', { name: 'Select location' }))
      await waitFor(() => expect(writes).toHaveLength(1))
      expect(field.parentElement).not.toHaveTextContent('/projects/shared/Child')
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    } finally { await act(async () => { release(); await gate }) }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(field.parentElement).toHaveTextContent('/projects/shared/Child')
    expect(field).toHaveFocus()
    expect(client.getQueryState(queryKeys.managedWorkspaces)?.isInvalidated).toBe(true)
    expect(writes[0]).toEqual({ ...mainSelection({ relativePath: 'Child' }), commandId: expect.any(String) })
    expect(writes[0]).not.toHaveProperty('runnerId')
  })

  it('keeps the saved field intact after rejection and allows Cancel', async () => {
    server.use(http.put(`/api/management/workspaces/${workspaceId}/root-location`, () => HttpResponse.json({
      error: { code: 'LOCATION_UNAVAILABLE', message: 'Destination unavailable.' },
    }, { status: 422 })))
    mount()
    const { user, field } = await chooseChild()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.getAllByText('Destination unavailable.').length).toBeGreaterThan(0))
    expect(field.parentElement).not.toHaveTextContent('/projects/shared/Child')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(field.parentElement).toHaveTextContent('/projects')
  })

  it('retries an uncertain save with the same selection, revisions and command identity', async () => {
    const writes: Record<string, unknown>[] = []
    server.use(http.put(`/api/management/workspaces/${workspaceId}/root-location`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      writes.push(input as unknown as Record<string, unknown>)
      return writes.length === 1
        ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Save not confirmed.' } }, { status: 503 })
        : HttpResponse.json({ value: boundRootReadback(input, mainRoot), replayed: true })
    }))
    mount()
    const { user, field } = await chooseChild()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(await screen.findByText(/The save outcome is unknown/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Computer and approved base folder' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Relative folder on this computer' })).toBeDisabled()
    expect(field.parentElement).not.toHaveTextContent('/projects/shared/Child')
    await user.click(screen.getByRole('button', { name: 'Reconcile original selection' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[0]).toEqual({ ...mainSelection({ relativePath: 'Child' }), commandId: expect.any(String) })
    expect(field.parentElement).toHaveTextContent('/projects/shared/Child')
  })

  it('accepts the already-saved ready folder without a redundant write', async () => {
    readback = boundRootReadback(mainSelection(), mainRoot)
    policies = [rootBinding(mainSelection(), mainRoot)]
    let writes = 0
    server.use(http.put(`/api/management/workspaces/${workspaceId}/root-location`, () => {
      writes++; return HttpResponse.json({ value: readback, replayed: false })
    }))
    mount()
    const user = userEvent.setup()
    const field = await screen.findByRole('button', { name: 'Project folder' })
    await user.click(field)
    const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
    await user.selectOptions(select, select.querySelectorAll('option')[1]!.value)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toBe(0)
    expect(field).toHaveFocus()
  })

  it('reselects a replaced folder by validating and saving its changed identity', async () => {
    readback = boundRootReadback(mainSelection(), mainRoot)
    policies = [rootBinding(mainSelection(), mainRoot)]
    const original = structuredClone(readback)
    const writes: WorkspaceRootSelection[] = []
    const replacementHash = 'b'.repeat(64)
    server.use(
      http.post(`/api/management/workspaces/${workspaceId}/root-location/validate`, async ({ request }) => {
        const input = await request.json() as WorkspaceRootSelection
        return HttpResponse.json({ workspaceId, selection: input, checkedAt, attestation: {
          ...rootAttestation(input, mainRoot), filesystem: { device: '1', inode: '4', mountId: '3' },
          directoryIdentityHash: replacementHash,
        } })
      }),
      http.put(`/api/management/workspaces/${workspaceId}/root-location`, async ({ request }) => {
        const input = await request.json() as WorkspaceRootSelection
        writes.push(input)
        const result = boundRootReadback(input, mainRoot)
        if (result.evidence !== 'bound') throw new Error('Expected a bound fixture')
        result.binding.directoryIdentityHash = replacementHash
        result.binding.filesystem.inode = '4'
        readback = result
        return HttpResponse.json({ value: result, replayed: false })
      }),
    )
    mount()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Project folder' }))
    const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
    await user.selectOptions(select, select.querySelectorAll('option')[1]!.value)
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ relativePath: '', expectedLocationRevision: original.locationRevision })
    expect(readback).toMatchObject({ locationRevision: original.locationRevision + 1,
      binding: { directoryIdentityHash: replacementHash } })
    expect(original).toMatchObject({ binding: { directoryIdentityHash: 'a'.repeat(64) } })
  })
})

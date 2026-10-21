import type { ManagedWorkspace, WorkspaceUpdateInput } from '@foreman-code/contracts/management'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { renderWithRouter } from '../../test/renderWithRouter'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { WorkspaceDetailPage } from './WorkspaceDetailPage'

afterEach(clearRevisionedFormPersistence)

function fixture() {
  let current: ManagedWorkspace = {
    workspace: { id: 'workspace-1', name: 'Website', repository: {
      provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main',
    } },
    revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0,
    locationValidation: { status: 'unconfigured' },
  }
  const writes: WorkspaceUpdateInput[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(current)),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
      evidence: 'unconfigured', workspaceId: 'workspace-1', locationRevision: 0, executionLocation: null,
    })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
    })),
    http.patch('/api/management/workspaces/workspace-1', async ({ request }) => {
      const input = await request.json() as WorkspaceUpdateInput
      writes.push(input)
      if (input.expectedRevision !== current.revision) return HttpResponse.json({
        error: { code: 'REVISION_CONFLICT', message: 'The workspace changed since it was read.' },
      }, { status: 409 })
      current = { ...current, revision: current.revision + 1,
        workspace: { ...current.workspace, repository: input.repository ?? undefined } }
      return HttpResponse.json({ value: current, replayed: false })
    }),
  )
  return { writes, read: () => current, change: (value: ManagedWorkspace) => { current = value } }
}

function mount() {
  return renderWithRouter(<UnsavedChangesProvider>
    <WorkspaceDetailPage workspaceId="workspace-1" section="settings" />
  </UnsavedChangesProvider>)
}

describe('repository draft', () => {
  it('retains edits across workspace revisions and requires explicit conflict resolution', async () => {
    const state = fixture()
    const user = userEvent.setup()
    const view = mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.clear(input)
    await user.type(input, 'local-owner/local-repo')
    const newer = { ...state.read(), revision: 2, workspace: { ...state.read().workspace,
      repository: { ...state.read().workspace.repository!, name: 'remote-repo', defaultBranch: 'release' } } }
    state.change(newer)
    act(() => view.queryClient.setQueryData(queryKeys.managedWorkspace('workspace-1'), newer))

    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('local-owner/local-repo')
    expect(await screen.findByText('Repository settings changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save repository' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reapply my edits' }))
    expect(input).toHaveValue('local-owner/local-repo')
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('release')
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    await waitFor(() => expect(state.writes).toHaveLength(1))
    expect(state.writes[0]).toMatchObject({ expectedRevision: 2,
      repository: { owner: 'local-owner', name: 'local-repo', defaultBranch: 'release' } })
  })

  it('refreshes a clean form and lets the user discard a conflicting draft', async () => {
    const state = fixture()
    const user = userEvent.setup()
    const view = mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    const newer = { ...state.read(), revision: 2, workspace: { ...state.read().workspace,
      repository: { ...state.read().workspace.repository!, name: 'remote-repo' } } }
    state.change(newer)
    act(() => view.queryClient.setQueryData(queryKeys.managedWorkspace('workspace-1'), newer))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/remote-repo'))
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-local')
    const latest = { ...newer, revision: 3 }
    state.change(latest)
    act(() => view.queryClient.setQueryData(queryKeys.managedWorkspace('workspace-1'), latest))
    await user.click(await screen.findByRole('button', { name: 'Discard edits and load saved repository' }))
    expect(input).toBeInTheDocument()
    expect(input).toHaveValue('octo-owner/remote-repo')
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main')
    expect(screen.getByRole('button', { name: 'Save repository' })).toBeDisabled()
  })

  it('locks fields during save and installs the persisted result without remounting', async () => {
    const state = fixture()
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    server.use(http.patch('/api/management/workspaces/workspace-1', async () => {
      await pending
      return undefined
    }))
    const user = userEvent.setup()
    mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-release')
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    expect(input).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toBeDisabled()
    finish()
    await waitFor(() => expect(input).toBeEnabled())
    expect(input).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-release')
    expect(screen.getByRole('button', { name: 'Save repository' })).toBeDisabled()
    expect(state.read().workspace.repository?.defaultBranch).toBe('main-release')
  })

  it('guards navigation and keeps the draft when the leave dialog is dismissed', async () => {
    fixture()
    const user = userEvent.setup()
    const { router } = mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-local')
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('You have unsaved changes in repository settings.')
    await user.keyboard('{Escape}')
    expect(input).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-local')
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
  })

  it.each([
    [503, 'Workspace refresh unavailable.'],
    [500, 'Workspace refresh unavailable.'],
  ] as const)('keeps the draft and navigation guard through a failed workspace refresh with HTTP %s', async (status, message) => {
    fixture()
    let fail = true
    const user = userEvent.setup()
    const view = mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-local')
    server.use(http.get('/api/management/workspaces/workspace-1', () => fail
      ? HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Workspace refresh unavailable.' } }, { status })
      : undefined))
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') })
    })
    expect(await screen.findByText(message)).toBeVisible()
    expect(input).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-local')
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('You have unsaved changes in repository settings.')
    await user.keyboard('{Escape}')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument())
    expect(input).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-local')
  })

  it.each([
    [503, 'Workspace refresh unavailable.'],
    [500, 'Workspace refresh unavailable.'],
  ] as const)('retains the original unconfirmed command through a failed workspace refresh with HTTP %s', async (status, message) => {
    const state = fixture()
    const attempts: unknown[] = []
    server.use(http.patch('/api/management/workspaces/workspace-1', async ({ request }) => {
      attempts.push(await request.clone().json())
      if (attempts.length === 1) return HttpResponse.json({
        error: { code: 'INTERNAL_ERROR', message: 'Save response unavailable.' },
      }, { status: 503 })
      return undefined
    }))
    const user = userEvent.setup()
    const view = mount()
    await user.type(await screen.findByRole('textbox', { name: 'Base branch' }), '-release')
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    expect(await screen.findByRole('button', { name: 'Retry repository save' })).toBeEnabled()
    expect(await screen.findByText('Save response unavailable.')).toBeVisible()
    let fail = true
    server.use(http.get('/api/management/workspaces/workspace-1', () => fail
      ? HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Workspace refresh unavailable.' } }, { status })
      : undefined))
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') })
    })
    expect(await screen.findByText(message)).toBeVisible()
    expect(screen.getByText('Save response unavailable.')).toBeVisible()
    expect(screen.getByText('The repository save is unconfirmed. Retry before editing or leaving.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-release')
    expect(screen.getByRole('button', { name: 'Retry repository save' })).toBeEnabled()
    expect(attempts).toHaveLength(1)
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument())
    expect(screen.getByText('Save response unavailable.')).toBeVisible()
    const retry = await screen.findByRole('button', { name: 'Retry repository save' })
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toBeDisabled()
    await user.click(retry)
    await waitFor(() => expect(attempts).toHaveLength(2))
    expect(attempts[1]).toEqual(attempts[0])
    expect(state.read().workspace.repository?.defaultBranch).toBe('main-release')
  })

  it('withholds the repository draft after denial until a successful workspace read', async () => {
    fixture()
    const user = userEvent.setup()
    const view = mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-local')
    let status = 403
    server.use(http.get('/api/management/workspaces/workspace-1', () => status === 200
      ? undefined
      : status === 503 ? new HttpResponse(null, { status })
        : HttpResponse.json({ error: { code: 'READ_UNAVAILABLE', message: 'Workspace read unavailable.' } }, { status })))
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') })
    })
    expect(await screen.findByText('Workspace read unavailable.')).toBeVisible()
    expect(input).not.toBeVisible()
    status = 503
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Updating — reconnecting…')).toBeVisible()
    expect(input).not.toBeVisible()
    status = 200
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(input).toBeVisible())
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-local')
  })

  it('loads a rejected revision without losing the draft and retries after reapplying', async () => {
    const state = fixture()
    const user = userEvent.setup()
    mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.type(screen.getByRole('textbox', { name: 'Base branch' }), '-local')
    state.change({ ...state.read(), revision: 2 })
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    expect(await screen.findByText('Repository settings changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(input).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toHaveValue('main-local')
    await user.click(screen.getByRole('button', { name: 'Reapply my edits' }))
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    await waitFor(() => expect(state.writes).toHaveLength(2))
    expect(state.writes.map(write => write.expectedRevision)).toEqual([1, 2])
    expect(state.writes[0]?.commandId).not.toBe(state.writes[1]?.commandId)
  })

  it('retains an unconfirmed command for retry and prevents discarding it', async () => {
    const state = fixture()
    const attempts: unknown[] = []
    server.use(http.patch('/api/management/workspaces/workspace-1', async ({ request }) => {
      attempts.push(await request.clone().json())
      if (attempts.length === 1) return HttpResponse.json({
        error: { code: 'INTERNAL_ERROR', message: 'Save response unavailable.' },
      }, { status: 503 })
      return undefined
    }))
    const user = userEvent.setup()
    mount()
    await user.type(await screen.findByRole('textbox', { name: 'Base branch' }), '-release')
    await user.click(screen.getByRole('button', { name: 'Save repository' }))
    expect(await screen.findByText('The repository save is unconfirmed. Retry before editing or leaving.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toBeDisabled()
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    const dialog = within(await screen.findByRole('alertdialog'))
    expect(dialog.getByRole('button', { name: 'Discard' })).toBeDisabled()
    await user.click(dialog.getByRole('button', { name: 'Retry original save' }))
    await waitFor(() => expect(attempts).toHaveLength(2))
    expect(attempts[1]).toEqual(attempts[0])
    expect(state.read().workspace.repository?.defaultBranch).toBe('main-release')
  })

  it('persists removal and refreshes the form to an empty repository', async () => {
    const state = fixture()
    const user = userEvent.setup()
    mount()
    const input = await screen.findByRole('textbox', { name: 'Repository' })
    await user.click(screen.getByRole('button', { name: /^Remove$/ }))
    await waitFor(() => expect(state.writes).toHaveLength(1))
    expect(state.writes[0]).toMatchObject({ expectedRevision: 1, repository: null })
    await waitFor(() => expect(input).toHaveValue(''))
    expect(input).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove$/ })).not.toBeInTheDocument()
    expect(state.read().workspace.repository).toBeUndefined()
  })
})

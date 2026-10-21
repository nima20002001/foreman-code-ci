import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import type { WorkspaceRepositoryAddInput, WorkspaceRepositoryReadResult } from '@foreman-code/contracts/workspace-git'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { workspaceGitKeys } from '../../shared/api/workspaceGit'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { renderWithRouter } from '../../test/renderWithRouter'
import { clearRevisionedFormPersistence } from '../settings/revisionedForm'
import { mainRoot } from '../settings/workspaceBoundLocation.fixtures'
import { worktreeFixture } from '../workflow-board/worktree.fixtures'
import { WorkspaceDetailPage } from './WorkspaceDetailPage'

afterEach(clearRevisionedFormPersistence)

function onboardingFixture(metadataOnly = false) {
  const prepared = worktreeFixture()
  const requests: WorkspaceRepositoryAddInput[] = []
  let workspace: ManagedWorkspace = { workspace: { id: 'workspace-1', name: 'Website',
    ...(metadataOnly ? { repository: prepared.repository } : {}) }, revision: 1, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }
  let status: WorkspaceRepositoryReadResult = { workspaceId: 'workspace-1',
    state: metadataOnly ? 'metadata-only' : 'unconfigured', repository: metadataOnly ? prepared.repository : null, revision: 1 }
  const finish = (input: WorkspaceRepositoryAddInput) => {
    requests.push(input)
    status = { ...prepared.ready, revision: input.expectedRevision + 1,
      operation: { ...prepared.ready.operation!, commandId: input.commandId } }
    workspace = { ...workspace, workspace: { ...workspace.workspace, repository: input.repository },
      revision: status.revision, locationRevision: 1, executionLocation: prepared.location.executionLocation,
      locationValidation: { status: 'ready', checkedAt: prepared.source.approvedAt } }
    return HttpResponse.json({ value: status, replayed: false })
  }
  server.use(
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(workspace)),
    http.get('/api/management/workspaces/workspace-1/repository', () => HttpResponse.json(status)),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json(status.location ?? {
      evidence: 'unconfigured', workspaceId: 'workspace-1', locationRevision: 0, executionLocation: null,
    })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', policies: status.state === 'ready' ? [prepared.location.binding] : [],
      allowlists: [mainRoot], readiness: 'metadata-only',
    })),
    http.get('/api/management/workspaces/workspace-1/source-roots', () => HttpResponse.json({
      items: status.state === 'ready' ? [prepared.root] : [], readiness: 'metadata-only',
    })),
    http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) =>
      finish(await request.json() as WorkspaceRepositoryAddInput)),
  )
  return { prepared, requests, finish, setStatus: (value: WorkspaceRepositoryReadResult) => { status = value },
    setWorkspace: (value: ManagedWorkspace) => { workspace = value }, workspace: () => workspace }
}

function mount() {
  return renderWithRouter(<UnsavedChangesProvider>
    <WorkspaceDetailPage workspaceId="workspace-1" section="settings" />
  </UnsavedChangesProvider>)
}

describe('workspace project preparation', () => {
  it('adds a project in one action and shows persisted clone, commit and source readiness after reload', async () => {
    const fixture = onboardingFixture()
    const user = userEvent.setup()
    const view = mount()
    await user.type(await screen.findByRole('textbox', { name: 'Repository' }), 'octo-owner/website')
    const add = screen.getByRole('button', { name: 'Add project' })
    await waitFor(() => expect(add).toBeEnabled())
    expect(screen.queryByText(/approves the supported tracked files/)).not.toBeInTheDocument()
    const projectHint = screen.getByRole('button', { name: 'About Add project' })
    await user.hover(projectHint)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Add project prepares a clone on Main and approves the supported tracked files from this base branch.',
    )
    await user.unhover(projectHint)
    await user.click(add)
    expect(await screen.findByText('Project ready')).toBeVisible()
    const project = within(screen.getByRole('region', { name: 'GitHub repository' }))
    expect(project.getByText(fixture.prepared.location.binding.canonicalProjectRoot)).toBeVisible()
    expect(project.getByText(fixture.prepared.source.manifest.git!.commit)).toBeVisible()
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]).toMatchObject({ expectedRevision: 1, expectedLocationRevision: 0,
      expectedRootPolicyRevision: 0, expectedBindingRevision: 0, allowedBaseId: mainRoot.bases[0]!.baseId,
      repository: fixture.prepared.repository })
    view.unmount()
    mount()
    expect(await screen.findByText('Project ready')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/website')
    const reloadedProject = within(screen.getByRole('region', { name: 'GitHub repository' }))
    expect(reloadedProject.getByText(fixture.prepared.location.binding.canonicalProjectRoot)).toBeVisible()
    expect(reloadedProject.getByText(fixture.prepared.source.manifest.git!.commit)).toBeVisible()
    expect(fixture.requests).toHaveLength(1)
  })

  it('offers Prepare project for metadata and locks inputs while preparation is pending', async () => {
    const fixture = onboardingFixture(true)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      await pending
      return fixture.finish(input)
    }))
    const user = userEvent.setup()
    mount()
    const prepare = await screen.findByRole('button', { name: 'Prepare project' })
    await waitFor(() => expect(prepare).toBeEnabled())
    await user.click(prepare)
    expect(screen.getByRole('textbox', { name: 'Repository' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Base branch' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    release()
    expect(await screen.findByText('Project ready')).toBeVisible()
  })

  it('reads an uncertain attempt and retries its original command and revision inputs', async () => {
    const fixture = onboardingFixture(true)
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      if (fixture.requests.length) return fixture.finish(input)
      fixture.requests.push(input)
      fixture.setStatus({ workspaceId: 'workspace-1', state: 'preparing', revision: 1,
        repository: input.repository, operation: { commandId: input.commandId, phase: 'metadata' } })
      return HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Preparation response unavailable.' } }, { status: 503 })
    }))
    const user = userEvent.setup()
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    const retry = await screen.findByRole('button', { name: 'Retry project preparation' })
    await user.click(screen.getByRole('button', { name: 'Check project status' }))
    expect(await screen.findByText('Last completed step: metadata.')).toBeVisible()
    expect(screen.queryByText('Project ready')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Repository' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    await user.click(retry)
    expect(await screen.findByText('Project ready')).toBeVisible()
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]).toEqual(fixture.requests[0])
  })

  it.each(['no-operation', 'command-not-found'])('retries the same request when the server has no import (%s)', async mode => {
    const fixture = onboardingFixture(true)
    server.use(
      http.get('/api/management/workspaces/workspace-1/repository', ({ request }) => {
        if (mode === 'command-not-found' && new URL(request.url).searchParams.has('commandId') && fixture.requests.length < 2) {
          return HttpResponse.json({ error: { code: 'IMPORT_NOT_FOUND', message: 'Import command was not received.' } }, { status: 404 })
        }
        return undefined
      }),
      http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
        const input = await request.json() as WorkspaceRepositoryAddInput
        if (fixture.requests.length) return fixture.finish(input)
        fixture.requests.push(input)
        return HttpResponse.error()
      }),
    )
    const user = userEvent.setup()
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    const retry = await screen.findByRole('button', { name: 'Retry project preparation' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Repository' })).toBeDisabled()
    await user.click(retry)
    expect(await screen.findByText('Project ready')).toBeVisible()
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]).toEqual(fixture.requests[0])
  })

  it('recovers a preparing import after fresh reload using its authorized canonical input', async () => {
    const fixture = onboardingFixture(true)
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      if (fixture.requests.length) return fixture.finish(input)
      fixture.requests.push(input)
      fixture.setWorkspace({ ...fixture.workspace(), revision: 2,
        locationRevision: 1, executionLocation: fixture.prepared.location.executionLocation,
        locationValidation: { status: 'ready', checkedAt: fixture.prepared.source.approvedAt } })
      fixture.setStatus({ workspaceId: 'workspace-1', state: 'preparing', revision: 2,
        repository: input.repository, location: fixture.prepared.location,
        operation: { commandId: input.commandId, phase: 'location', retryInput: input } })
      return HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Import response lost.' } }, { status: 503 })
    }))
    const user = userEvent.setup()
    const first = mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    await screen.findByRole('button', { name: 'Retry project preparation' })
    first.unmount()
    first.queryClient.clear()
    clearRevisionedFormPersistence()
    mount()
    const retry = await screen.findByRole('button', { name: 'Retry project preparation' })
    await waitFor(() => expect(retry).toBeEnabled())
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/website')
    expect(screen.getByRole('textbox', { name: 'Repository' })).toBeDisabled()
    await user.click(retry)
    expect(await screen.findByText('Project ready')).toBeVisible()
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]).toEqual(fixture.requests[0])
    expect(fixture.requests[1]?.expectedRevision).toBe(1)
    expect(fixture.requests[1]?.expectedLocationRevision).toBe(0)
  })

  it('allows cancelling uncertain navigation and retrying from its guard after the request ended', async () => {
    const fixture = onboardingFixture(true)
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      if (fixture.requests.length) return fixture.finish(input)
      fixture.requests.push(input)
      fixture.setStatus({ workspaceId: 'workspace-1', state: 'preparing', revision: 1,
        repository: input.repository, operation: { commandId: input.commandId, phase: 'metadata' } })
      return HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Import response lost.' } }, { status: 503 })
    }))
    const user = userEvent.setup()
    const view = mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry project preparation' })).toBeEnabled())
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    const guard = await screen.findByRole('alertdialog')
    expect(within(guard).getByRole('button', { name: 'Retry original save' })).toBeEnabled()
    expect(within(guard).getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(within(guard).getByRole('button', { name: 'Close dialog' })).toBeEnabled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(view.router.state.location.pathname).toBe('/')
    await user.click(screen.getByRole('link', { name: /Project files/ }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Retry original save' }))
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    expect(fixture.requests).toHaveLength(2)
    expect(fixture.requests[1]).toEqual(fixture.requests[0])
  })

  it('reconciles a completed uncertain attempt through readback without a second add', async () => {
    const fixture = onboardingFixture(true)
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      fixture.finish(await request.json() as WorkspaceRepositoryAddInput)
      return HttpResponse.json({ error: { code: 'INTERNAL_ERROR', message: 'Ready response unavailable.' } }, { status: 503 })
    }))
    const user = userEvent.setup()
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    await user.click(await screen.findByRole('button', { name: 'Retry project preparation' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Repository' })).toBeEnabled())
    expect(screen.getByText('Project ready')).toBeVisible()
    expect(fixture.requests).toHaveLength(1)
  })

  it('retains input after a capture failure and says when a new import is required', async () => {
    const fixture = onboardingFixture(true)
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      fixture.requests.push(input)
      const status: WorkspaceRepositoryReadResult = { workspaceId: 'workspace-1', state: 'failed', revision: 1,
        repository: input.repository, operation: { commandId: input.commandId, phase: 'location',
          failure: { code: 'UNSUPPORTED_TREE', message: 'The tracked tree contains unsupported files.',
            retryable: false, newCommandRequired: true } } }
      fixture.setStatus(status)
      return HttpResponse.json({ value: status, replayed: false })
    }))
    const user = userEvent.setup()
    mount()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Prepare project' }))
    expect(await screen.findByText('A new import attempt is required.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/website')
    expect(screen.getByRole('textbox', { name: 'Repository' })).toBeEnabled()
    expect(screen.queryByText('Project ready')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry project preparation' })).not.toBeInTheDocument()
  })

  it('withdraws persisted project paths after a denied status refresh', async () => {
    const fixture = onboardingFixture(true)
    fixture.setStatus(fixture.prepared.ready)
    const view = mount()
    expect(await screen.findByText('Project ready')).toBeVisible()
    server.use(http.get('/api/management/workspaces/workspace-1/repository', () => HttpResponse.json({
      error: { code: 'FORBIDDEN', message: 'Project read denied.' },
    }, { status: 403 })))
    await act(async () => { await view.queryClient.invalidateQueries({ queryKey: workspaceGitKeys.scope('workspace-1') }) })
    expect(await screen.findByText('Project status could not be read.')).toBeVisible()
    const project = within(screen.getByRole('region', { name: 'GitHub repository' }))
    expect(project.queryByText(fixture.prepared.location.binding.canonicalProjectRoot)).not.toBeInTheDocument()
  })

  it('preserves an Add draft on revision conflict and uses a new command after reapply', async () => {
    const fixture = onboardingFixture()
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', async ({ request }) => {
      const input = await request.json() as WorkspaceRepositoryAddInput
      if (fixture.requests.length) return fixture.finish(input)
      fixture.requests.push(input)
      fixture.setWorkspace({ ...fixture.workspace(), revision: 2 })
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Workspace changed.' } }, { status: 409 })
    }))
    const user = userEvent.setup()
    const view = mount()
    await user.type(await screen.findByRole('textbox', { name: 'Repository' }), 'octo-owner/website')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await act(async () => { await view.queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspace('workspace-1') }) })
    expect(await screen.findByText('Repository settings changed elsewhere. Your edits are preserved.')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Repository' })).toHaveValue('octo-owner/website')
    await user.click(screen.getByRole('button', { name: 'Reapply my edits' }))
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await screen.findByText('Project ready')
    expect(fixture.requests.map(input => input.expectedRevision)).toEqual([1, 2])
    expect(fixture.requests[0]?.commandId).not.toBe(fixture.requests[1]?.commandId)
  })
})

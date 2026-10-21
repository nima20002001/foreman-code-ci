import { defaultScheduler, notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceRootSelectionSchema, type WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { FileRetentionSaveInputSchema, type FileRetentionPreference } from '@foreman-code/contracts/files'
import { clearRevisionedFormPersistence } from '../features/settings/revisionedForm'
import { clearRetentionCommandMemory } from '../features/retention-settings/retentionCommand'

import { routeTree } from '../app/router'
import { server } from '../mocks/server'
import { setMockScenario } from '../shared/mocks/scenarios'
import { mainRoot } from '../features/settings/workspaceBoundLocation.fixtures'
import { mockRuntimeIdentity } from '../shared/mocks/handlers'
import { CollaborationUIProvider, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { deviceId, deviceTarget, mainId, mainTarget, registration } from '../features/computers/computersTestFixture'

function renderRoute(path: string, slots?: CollaborationUISlots) {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    router,
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <CollaborationUIProvider value={slots}><RouterProvider router={router} /></CollaborationUIProvider>
      </QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  setMockScenario('normal')
  sessionStorage.clear()
  clearRevisionedFormPersistence()
  clearRetentionCommandMemory()
})

function workspacesDestination() {
  return screen.getAllByRole('button', { name: 'Workspaces' })
    .find(button => !button.hasAttribute('aria-expanded'))!
}

function mockApprovedMainFolderBrowser() {
  const browseRequests: WorkspaceRootSelection[] = []
  const approvedRoot = {
    ...mainRoot,
    hostRef: { kind: 'main' as const, mainId: mockRuntimeIdentity.installationId },
    applicationInstallationId: mockRuntimeIdentity.installationId,
  }
  server.use(
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({ evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 0, executionLocation: { runnerId: 'original-runner', rootPath: '/previous' } })),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [approvedRoot] })),
    http.get('/api/management/harnesses/directories', () => HttpResponse.json({
      roots: [{ id: 'workspaces', label: 'Workspaces', path: mainRoot.bases[0]!.canonicalPath }],
      rootId: null, path: null, parent: null, directories: [], nextCursor: null,
    })),
    http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => {
      const selection = WorkspaceRootSelectionSchema.parse(await request.json())
      browseRequests.push(selection)
      return HttpResponse.json({ workspaceId: 'workspace-1', selection,
        browse: { relativePath: '', directories: [], truncated: false } })
    }),
  )
  return browseRequests
}

describe('workspace section routes', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json({
        evidence: 'legacy_missing', workspaceId: 'workspace-1', locationRevision: 1,
        executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      })),
      http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
        workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [],
      })),
      http.get('*/api/workspaces/:workspaceId/reference-files', () => HttpResponse.json({
        items: [], pageInfo: { nextCursor: null },
      })),
      http.get('*/api/management/file-retention', () => HttpResponse.json({
        preference: { ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0 },
      })),
    )
  })

  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  it('opens the workspace Memory board only from the Environment button in the sidebar footer', async () => {
    const workspaceMemoryBoard = vi.fn(({ workspaceId }: { workspaceId: string }) => <div data-testid="workspace-memory-body">Memory for {workspaceId}</div>)
    const workflow = vi.fn(() => ({ memoryBoard: () => <p>Workflow-only modal</p> })), browserProfiles = vi.fn(() => <p>Profile manager</p>)
    const { router, queryClient, unmount } = renderRoute('/workspaces/workspace-1/workflows', { workspaceMemoryBoard, workflow, browserProfiles })
    const sections = within(await screen.findByRole('navigation', { name: 'Workspace sections' }))
    expect(sections.queryByRole('link', { name: 'Memory board' })).not.toBeInTheDocument()
    const sidebar = within(screen.getByRole('complementary', { name: 'Primary navigation' }))
    expect(sidebar.getAllByRole('button', { name: 'Workspace memory board' })).toHaveLength(1)
    expect(sidebar.queryByRole('button', { name: 'Memory board' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-memory-body')).not.toBeInTheDocument()
    await userEvent.click(sidebar.getByRole('button', { name: 'Workspace memory board' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/memory'))
    expect(await screen.findByTestId('workspace-memory-body')).toHaveTextContent('workspace-1')
    expect(sidebar.getByRole('button', { name: 'Workspace memory board' })).toHaveAttribute('aria-current', 'page')
    expect(workspaceMemoryBoard).toHaveBeenLastCalledWith({ workspaceId: 'workspace-1' })
    expect(workflow).not.toHaveBeenCalled(); expect(browserProfiles).not.toHaveBeenCalled()
    unmount(); queryClient.clear()
  })

  it('shows the real workspace Memory board on the Memory route when no slot is supplied', async () => {
    const scopes: unknown[] = []
    server.use(http.get('/api/memory-boards', ({ request }) => {
      const scope = new URL(request.url).searchParams.get('scope')
      if (scope) scopes.push(JSON.parse(scope))
      const page = { items: [], hasMore: false, nextCursor: null, revision: 0 }
      return HttpResponse.json({ board: { id: 'board-workspace', scope: { kind: 'workspace', workspaceId: 'workspace-1' }, revision: 0 },
        openColumns: ['todo', 'doing', 'waiting_for_user', 'blocked'].map(status => ({ ...page, status })), notes: page,
        counts: { todo: 0, doing: 0, waiting_for_user: 0, blocked: 0, done: 0, completed: 0, dropped: 0, notes: 0 }, sequence: 0 })
    }))
    const { queryClient, unmount } = renderRoute('/workspaces/workspace-1/memory')
    expect(await screen.findByRole('button', { name: 'Add card' })).toBeVisible()
    expect(screen.queryByText('Memory board is not available yet.')).not.toBeInTheDocument()
    expect(scopes).toEqual([{ kind: 'workspace', workspaceId: 'workspace-1' }])
    unmount(); queryClient.clear()
  })

  it('opens Browser profiles as its own settings page and preserves an exact registered computer filter', async () => {
    server.use(http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
      http.get('*/api/devices', () => HttpResponse.json({ devices: [registration] })))
    const browserProfiles = vi.fn((scope: Parameters<NonNullable<CollaborationUISlots['browserProfiles']>>[0]) =>
      <p data-testid="profile-manager">{'computer' in scope ? scope.computer?.hostRef.kind ?? 'all' : 'all'} profiles</p>)
    const { router, queryClient, unmount } = renderRoute(`/settings/browser-profiles?mainId=${mainId}&computer=device&deviceId=${deviceId}`, { browserProfiles })
    expect(await screen.findByTestId('profile-manager')).toHaveTextContent('device profiles')
    expect(browserProfiles).toHaveBeenLastCalledWith({ mainId, computer: deviceTarget })
    expect(screen.getAllByTestId('profile-manager')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Browser profiles', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Computers', level: 1 })).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'main')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ mainId, computer: 'main' }))
    expect(router.state.location.search).not.toHaveProperty('deviceId')
    expect(browserProfiles).toHaveBeenLastCalledWith({ mainId, computer: mainTarget })
    await act(async () => { router.history.back() })
    await waitFor(() => expect(browserProfiles).toHaveBeenLastCalledWith({ mainId, computer: deviceTarget }))
    unmount(); queryClient.clear()
  })

  it.each(['unknown-device', 'different-main'])('keeps an unavailable %s Browser profiles deep link explicit until the person selects a computer', async kind => {
    server.use(http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
      http.get('*/api/devices', () => HttpResponse.json({ devices: [registration] })))
    const browserProfiles = vi.fn(() => <p>Unexpected retargeted manager</p>)
    const chosenMain = kind === 'different-main' ? '44444444-4444-4444-8444-444444444444' : mainId
    const chosenDevice = kind === 'unknown-device' ? '55555555-5555-4555-8555-555555555555' : deviceId
    const { router, queryClient, unmount } = renderRoute(`/settings/browser-profiles?mainId=${chosenMain}&computer=device&deviceId=${chosenDevice}`, { browserProfiles })
    await screen.findByText('The selected computer is unavailable. Choose a computer to continue.')
    expect(browserProfiles).not.toHaveBeenCalled()
    expect(router.state.location.search).toMatchObject({ mainId: chosenMain, computer: 'device', deviceId: chosenDevice })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'main')
    await waitFor(() => expect(browserProfiles).toHaveBeenLastCalledWith({ mainId, computer: mainTarget }))
    unmount(); queryClient.clear()
  })

  it('opens the workspace card directory as the default view with child menus closed', async () => {
    const { router } = renderRoute('/')

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible()
    expect(await screen.findByTestId('workspace-card-workspace-1')).toHaveTextContent('Website')
    expect(workspacesDestination()).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('workspace-entry-workspace-1')).not.toHaveClass('nav-item-active')
    expect(screen.getByRole('button', { name: 'Expand Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument()
  })

  it('keeps the temporarily hidden agents directory available by deep link', async () => {
    renderRoute('/workspaces/workspace-1/agents?agentId=agent-researcher')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Researcher, researcher, Available/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Researcher' })).not.toBeInTheDocument()

  })

  it('does not open a centered modal for an unknown agent deep link', async () => {
    renderRoute('/workspaces/workspace-1/agents?agentId=agent-missing')

    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Agent unavailable' })).not.toBeInTheDocument()
  })

  it('shows an honest error state when the agents request fails', async () => {
    setMockScenario('error')
    renderRoute('/workspaces/workspace-1/agents')

    const error = await screen.findByTestId('agents-error')
    expect(error).toHaveTextContent('Agents unavailable')
    expect(error).toHaveTextContent('The selected mock scenario fails read requests.')
    expect(screen.queryByText('No agents yet')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('deep-links unimplemented destinations to conventional coming-soon pages', async () => {
    renderRoute('/workspaces/workspace-1/terminal')

    expect(await screen.findByRole('heading', { name: 'Terminal' })).toBeVisible()
    expect(screen.getByTestId('coming-soon')).toHaveTextContent('Coming soon')
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
  })

  it('opens the workflow directory from the Workflows sidebar button', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Workflows' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/workflows'))
    expect(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
  })

  it('keeps workflow submenu expansion state while workspace routes replace the shell', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/agents')

    await screen.findByRole('heading', { name: 'Agents', level: 1 })
    await user.click(screen.getByRole('button', { name: 'Collapse workflows in Website' }))
    await router.navigate({ to: '/workspaces/$workspaceId/files', params: { workspaceId: 'workspace-1' } })

    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    expect(await screen.findByRole('button', { name: 'Expand workflows in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('deep-links the supported Project files section under the workspaces menu', async () => {
    renderRoute('/workspaces/workspace-1/files')

    expect(await screen.findByRole('heading', { name: 'Project files', level: 1 })).toBeVisible()
    expect(screen.queryByTestId('coming-soon')).not.toBeInTheDocument()
    expect(within(await screen.findByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Project files' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument()
    expect(workspacesDestination()).toHaveClass('nav-item-active')
  })

  it('opens each settings card on its own page instead of below the hub', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Bugs' })).toHaveAttribute('href', '/settings/bugs')
    expect(screen.getByRole('link', { name: 'System prompt' })).toHaveAttribute('href', '/settings/system-prompt')
    expect(screen.getByRole('link', { name: 'Harnesses' })).toHaveAttribute('href', '/settings/harnesses')
    expect(screen.getByRole('link', { name: 'Agents' })).toHaveAttribute('href', '/settings/agents')
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('href', '/settings/workflows')
    expect(screen.getByRole('link', { name: 'Browser profiles' })).toHaveAttribute('href', '/settings/browser-profiles')
    expect(screen.queryByRole('link', { name: /Approval/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Agents' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/agents'))
    expect(await screen.findByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Settings', level: 1 })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
  })

  it('summarizes each computer on a compact card with presence, role and running work', async () => {
    const mainId = '11111111-1111-4111-8111-111111111111'
    const deviceId = '22222222-2222-4222-8222-222222222222'
    const main = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }
    const device = { hostRef: { kind: 'device' as const, mainId, deviceId }, applicationInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1 }
    const agent = { id: 'execution-1', workspaceId: 'workspace', workflowId: 'workflow', workflowName: 'Flow', runId: 'run-1', nodeId: 'node-1', agentName: 'Coder', state: 'running' }
    server.use(
      http.get('*/api/management/computers/activity', () => HttpResponse.json({ mainId, activityComplete: true, truncated: false, cloud: [],
        computers: [{ target: main, name: 'Main PC', online: true, jobs: [], agents: [agent] }, { target: device, name: 'Laptop', online: false, jobs: [], agents: [] }] })),
      http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
        const { target } = await request.json() as { target: typeof main }
        return HttpResponse.json({ preference: { target, revision: 1, buildEnabled: target.hostRef.kind === 'main', buildPriority: 50, buildAllowancePercent: 60 },
          state: 'ready', reasons: [], remoteExecutionEnabled: true })
      }),
    )
    renderRoute('/settings')

    const mainCard = await screen.findByRole('link', { name: /Main PC/ })
    expect(mainCard).toHaveAttribute('href', '/settings/computers')
    expect(await within(mainCard).findByText('CI')).toBeVisible()
    expect(within(mainCard).getByText('Online')).toBeVisible()
    expect(within(mainCard).getByText('Agent host')).toBeVisible()
    expect(within(mainCard).getByText('1 agent running')).toBeVisible()
    const laptopCard = screen.getByRole('link', { name: /Laptop/ })
    expect(laptopCard).toHaveAttribute('href', `/settings/computers/${deviceId}`)
    expect(within(laptopCard).getByText('Offline')).toBeVisible()
    expect(within(laptopCard).queryByText('CI')).not.toBeInTheDocument()
    expect(screen.queryByText(/Listener|change via Operator|environment overrides/)).not.toBeInTheDocument()
  })

  it.each(['/account', '/account/', '/account?tab=sessions'])(
    'redirects the old Account URL %s to General without account controls', async (path) => {
      const { router } = renderRoute(path)
      expect(await screen.findByRole('heading', { name: 'General', level: 1 })).toBeVisible()
      expect(router.state.location.pathname).toBe('/settings/general')
      expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
      expect(screen.queryByText('preview@example.test')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /sign in|sign out|connect browser/i })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    },
  )

  it('opens General from Settings and persists edited chat retention after a cold reload', async () => {
    let preference: FileRetentionPreference = {
      ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0,
    }
    server.use(
      http.get('*/api/management/file-retention', () => HttpResponse.json({ preference })),
      http.post('*/api/management/file-retention', async ({ request }) => {
        const input = FileRetentionSaveInputSchema.parse(await request.json())
        expect(input).toMatchObject({ durationSeconds: 43_200, expectedRevision: 0, applyToExisting: false })
        preference = { ...preference, durationSeconds: input.durationSeconds, revision: preference.revision + 1 }
        return HttpResponse.json({
          value: { preference, updatedFileCount: 0, expiredNowCount: 0 }, replayed: false,
        })
      }),
    )
    const user = userEvent.setup()
    const view = renderRoute('/settings')
    await user.click(await screen.findByRole('link', { name: /General/ }))
    expect(await screen.findByRole('heading', { name: 'General', level: 1 })).toBeVisible()
    expect(view.router.state.location.pathname).toBe('/settings/general')
    const retention = await screen.findByRole('region', { name: 'Chat retention' })
    const duration = await within(retention).findByRole('spinbutton', { name: 'Duration' })
    expect(duration).toHaveValue(7)
    await user.clear(duration)
    await user.type(duration, '12')
    await user.selectOptions(within(retention).getByRole('combobox', { name: 'Unit' }), 'hours')
    const save = within(retention).getByRole('button', { name: 'Save' })
    await waitFor(() => expect(save).toBeEnabled())
    await user.click(save)
    expect(await within(retention).findByText('Saved.')).toBeVisible()
    expect(preference).toMatchObject({ durationSeconds: 43_200, revision: 1 })

    view.unmount()
    view.queryClient.clear()
    clearRevisionedFormPersistence()
    clearRetentionCommandMemory()
    sessionStorage.clear()
    renderRoute('/settings/general')
    expect(await screen.findByRole('spinbutton', { name: 'Duration' })).toHaveValue(12)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('hours')
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
  })

  it('asks for workspace choice at the old global approval URL instead of opening a wider queue', async () => {
    renderRoute('/approvals?interactionId=unscoped-request')
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 1 })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Approval Inbox' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current')
  })

  it('omits the approvals shortcut from workspace settings', async () => {
    renderRoute('/workspaces/workspace-1/settings')
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(screen.queryByTestId('workflow-card-workflow-content-pipeline')).not.toBeInTheDocument()
    expect(within(await screen.findByRole('navigation', { name: 'Workspace sections' })).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('button', { name: /Approvals Review requests in this workspace/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'App connections' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Harness availability' })).toBeVisible()
  })

  it('opens project files through the selected workspace section navigation', async () => {
    const requestedWorkspaces: string[] = []
    server.use(http.get('*/api/workspaces/:workspaceId/reference-files', ({ params }) => {
      requestedWorkspaces.push(String(params.workspaceId))
      return HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })
    }))
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click(await within(await screen.findByRole('navigation', { name: 'Workspace sections' })).findByRole('link', { name: 'Project files' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/files'))
    const files = await screen.findByRole('region', { name: 'Project files' })
    expect(await within(files).findByText('No files.')).toBeVisible()
    expect(requestedWorkspaces).toEqual(['workspace-1'])
  })

  it('confirms workspace removal in settings and returns to the workspace list', async () => {
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')
    await user.click((await screen.findAllByRole('button', { name: 'Remove workspace' }))[0]!)
    let dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    expect(dialog).toHaveTextContent('App-created project folders and their contents will be deleted. Existing folders you selected are kept. Workflow and run history is retained.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
    expect(screen.queryByRole('dialog', { name: 'Remove Website?' })).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Remove workspace' })[0]!)
    dialog = screen.getByRole('dialog', { name: 'Remove Website?' })
    await user.click(within(dialog).getByRole('button', { name: 'Remove workspace' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(await screen.findByTestId('workspace-directory-empty')).toBeVisible()
    expect(screen.queryByTestId('workspace-entry-workspace-1')).not.toBeInTheDocument()
  })

  it('offers workflow management within the selected workspace settings', async () => {
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await within(await screen.findByRole('navigation', { name: 'Workspace sections' })).findByRole('link', { name: 'Workflows' }))
    expect(await screen.findByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Workflows', level: 2 })).not.toBeInTheDocument()
    const section = within(screen.getByRole('region', { name: 'Workflows' }))
    expect(await section.findByTestId('workflow-card-workflow-content-pipeline')).toBeVisible()
    await user.click(section.getByRole('button', { name: 'Open actions for Research to review' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Settings workflow')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(section.getByTestId('workflow-card-workflow-content-pipeline')).toHaveTextContent('Settings workflow'))
    await user.click(section.getByRole('button', { name: 'Select workflows' }))
    expect(section.getByRole('checkbox', { name: 'Select Settings workflow' })).toBeVisible()
    await user.click(section.getByRole('button', { name: 'Selection options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
    await user.click(section.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
  })

  it('redirects an old approval deep link back to its workflow board and opens the panel', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/approvals?workflowId=workflow-content-pipeline&approvalView=history')
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-content-pipeline' })
    expect(await screen.findByRole('dialog', { name: 'Human approval inbox' })).toBeVisible()
  })

  it('has no Browsers destination', async () => {
    const { router } = renderRoute('/workspaces/workspace-1/browsers')
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(router.state.matches.map((match) => match.routeId)).not.toContain('/workspaces/$workspaceId/browsers')
    expect(screen.queryByRole('heading', { name: 'Browsers' })).not.toBeInTheDocument()
  })

  it('opens the approved Main folder browser without navigating away from Settings', async () => {
    mockApprovedMainFolderBrowser()
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    const executionLocation = await screen.findByLabelText('Execution location', { selector: 'button' })
    expect(executionLocation).toBe(screen.getByRole('button', { name: 'Execution location' }))
    expect(executionLocation.closest('.workspace-settings-name-row')).toContainElement(screen.getByRole('button', { name: 'Rename workspace Website' }))
    await user.click(executionLocation)

    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    expect(dialog).toBeVisible()
    expect(await within(dialog).findByRole('textbox', { name: 'Destination' })).toHaveValue(mainRoot.bases[0]!.canonicalPath)
    expect(await within(dialog).findByRole('button', { name: 'New folder' })).toBeVisible()
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
  })

  it('keeps workspace rename available after closing the approved Main folder browser', async () => {
    const browseRequests = mockApprovedMainFolderBrowser()
    const user = userEvent.setup()
    const { router } = renderRoute('/workspaces/workspace-1/settings')

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    const executionLocation = await screen.findByLabelText('Execution location', { selector: 'button' })
    expect(executionLocation).toBe(screen.getByRole('button', { name: 'Execution location' }))
    await user.click(executionLocation)
    const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
    await waitFor(() => expect(browseRequests).toHaveLength(1))
    expect(browseRequests[0]).toMatchObject({
      workspaceId: 'workspace-1',
      hostRef: { kind: 'main', mainId: mockRuntimeIdentity.installationId },
      allowedBaseId: mainRoot.bases[0]!.baseId,
      relativePath: '',
    })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Choose folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    expect(router.state.location.pathname).toBe('/workspaces/workspace-1/settings')
    await user.click(screen.getByRole('button', { name: 'Rename workspace Website' }))
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Website')
    await user.clear(screen.getByRole('textbox', { name: 'Workspace name' }))
    await user.paste('Renamed after folder cancellation')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByRole('button', { name: 'Rename workspace Renamed after folder cancellation' }))
      .toBeVisible()
    await waitFor(() => expect(screen.getByTestId('workspace-entry-workspace-1'))
      .toHaveTextContent('Renamed after folder cancellation'))
  })

  it('uses the same inline rename from the workspace name and settings, with a nearby removal control', async () => {
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    const rename = await screen.findByRole('button', { name: 'Rename workspace Website' })
    const header = rename.closest('header')
    expect(header).not.toBeNull()
    const identity = within(header!)
    const actions = within(screen.getByRole('group', { name: 'Workspace actions' }))
    await user.click(rename)
    expect(identity.getByRole('textbox', { name: 'Workspace name' })).toHaveFocus()
    await user.click(identity.getByRole('button', { name: 'Cancel' }))
    await user.click(actions.getByRole('button', { name: 'Rename workspace' }))
    await user.clear(identity.getByRole('textbox', { name: 'Workspace name' }))
    await user.paste('Workspace header rename')
    await user.click(identity.getByRole('button', { name: 'Save name' }))
    expect(await identity.findByRole('button', { name: 'Rename workspace Workspace header rename' })).toBeVisible()
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumbs' })).getByRole('link', { name: 'Go to Workspace header rename' })).toBeVisible()
    await user.click(actions.getByRole('button', { name: 'Rename workspace' }))
    expect(identity.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Workspace header rename')
    await user.click(identity.getByRole('button', { name: 'Cancel' }))
    await user.click(identity.getByRole('button', { name: 'Remove workspace' }))
    const removal = await screen.findByRole('dialog', { name: 'Remove Workspace header rename?' })
    expect(removal).toBeVisible()
    await user.click(within(removal).getByRole('button', { name: 'Cancel' }))
    expect(identity.getByRole('button', { name: 'Rename workspace Workspace header rename' })).toBeVisible()
  })

  it('retains the original rename command and revision when acknowledgement is lost', async () => {
    const writes: unknown[] = []
    server.use(http.patch('/api/management/workspaces/workspace-1', async ({ request }) => {
      writes.push(await request.clone().json())
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Rename acknowledgement lost.' } }, { status: 503 })
      return undefined
    }))
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Rename workspace Website' }))
    const input = screen.getByRole('textbox', { name: 'Workspace name' })
    await user.clear(input)
    await user.paste('Confirmed retry rename')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Rename acknowledgement lost.')).toBeVisible()
    expect(screen.getByText('The rename may have succeeded. Retry to confirm its outcome.')).toBeVisible()
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry rename' }))
    expect(await screen.findByRole('button', { name: 'Rename workspace Confirmed retry rename' })).toBeVisible()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(writes[0]).toMatchObject({ workspaceId: 'workspace-1', name: 'Confirmed retry rename', expectedRevision: 1 })
  })

  it.each([false, true])('opens removal at the confirmed revision after saving an inline rename through the unsaved guard (deferred query notifications: %s)', async deferNotifications => {
    const removals: unknown[] = []
    server.use(http.delete('/api/management/workspaces/workspace-1', async ({ request }) => {
      removals.push(await request.clone().json())
      return undefined
    }))
    const user = userEvent.setup()
    renderRoute('/workspaces/workspace-1/settings')
    await user.click(await screen.findByRole('button', { name: 'Rename workspace Website' }))
    await user.clear(screen.getByRole('textbox', { name: 'Workspace name' }))
    await user.paste('Name saved before removal')
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    const guard = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
    const notifications: Array<() => void> = []
    if (deferNotifications) notifyManager.setScheduler(callback => notifications.push(callback))
    try {
      await user.click(within(guard).getByRole('button', { name: 'Save' }))
      if (deferNotifications) {
        // The cache accepts the rename before its observers receive their scheduled notifications.
        await screen.findByRole('dialog', { name: /^Remove / })
        notifyManager.setScheduler(defaultScheduler)
        await act(async () => { for (const notify of notifications.splice(0)) notify() })
      }
      const confirmation = await screen.findByRole('dialog', { name: 'Remove Name saved before removal?' })
      await user.click(within(confirmation).getByRole('button', { name: 'Remove workspace' }))
      await waitFor(() => expect(removals).toHaveLength(1))
      expect(removals[0]).toMatchObject({ workspaceId: 'workspace-1', expectedRevision: 2 })
    } finally {
      notifyManager.setScheduler(defaultScheduler)
      await act(async () => { for (const notify of notifications.splice(0)) notify() })
    }
  })
})

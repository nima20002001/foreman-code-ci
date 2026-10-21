import { vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { getManagedHarnessCatalog } from '../api/client'
import { getMockHarnessDefaults, updateMockHarnessDefaults } from '../mocks/scenarios'
import { savedClaudeConfiguration } from '../../features/settings/claudeSettings.fixtures'

import { renderWithRouter } from '../../test/renderWithRouter'
import {
  DEFAULT_NAVIGATION_WIDTH,
  MAX_NAVIGATION_WIDTH,
  useNavigationUiStore,
} from '../../features/workspaces'
import { WorkspaceShell } from './WorkspaceShell'

function expectNewTab(button: HTMLElement, url: string) {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  expect(button).not.toHaveAttribute('href')
  fireEvent.click(button, { ctrlKey: true })
  expect(open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener')
  open.mockRestore()
}

function workspacesDestination() {
  return screen.getAllByRole('button', { name: 'Workspaces' })
    .find(button => !button.hasAttribute('aria-expanded'))!
}

describe('WorkspaceShell', () => {
  it.each([false, true])('keeps OpenCode out of the complete sidebar with collapsed navigation: %s', async collapsed => {
    updateMockHarnessDefaults({ ...getMockHarnessDefaults(), claude: savedClaudeConfiguration })
    const catalog = await getManagedHarnessCatalog()
    expect(catalog.map(entry => entry.harness)).toEqual(['codex', 'claude'])
    act(() => useNavigationUiStore.getState().setCollapsed(collapsed))
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const sidebar = await screen.findByRole('complementary', { name: 'Primary navigation' })
    expect(await within(sidebar).findByRole('button', { name: /^Codex:/ })).toBeVisible()
    expect(await within(sidebar).findByRole('button', { name: /^Claude:/ })).toBeVisible()
    expect(within(sidebar).queryByRole('button', { name: /OpenCode/i })).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('button', { name: /OpenCode/i })).not.toBeInTheDocument()
    expect(sidebar).not.toHaveTextContent(/OpenCode/i)
  })

  it.each([false, true])('keeps the product name accessible with collapsed navigation: %s', async collapsed => {
    const previous = useNavigationUiStore.getState().collapsed
    useNavigationUiStore.getState().setCollapsed(collapsed)
    try {
      renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
      expect(await screen.findByRole('img', { name: 'Foreman Code' })).toBeInTheDocument()
      expect(useNavigationUiStore.getState().collapsed).toBe(collapsed)
      expect(sessionStorage.getItem('graphql-navigation-collapsed')).toBe(String(collapsed))
    } finally { useNavigationUiStore.getState().setCollapsed(previous) }
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it.each([false, true])('submits automatic naming only when the suggested name is untouched (edited: %s)', async (edited) => {
    let submitted: Record<string, unknown> | undefined
    server.use(http.post('/api/management/workspaces', async ({ request }) => {
      submitted = await request.json() as Record<string, unknown>
      return HttpResponse.json({ value: {
        workspace: { id: 'workspace-created', name: edited ? 'New workspace' : 'New workspace (1)' },
        revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0,
        locationValidation: { status: 'restricted' },
      }, replayed: false })
    }))
    const user = userEvent.setup()
    const { router } = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await user.click(await screen.findByRole('button', { name: 'New workspace' }))
    const name = screen.getByRole('textbox', { name: 'Name' })
    await waitFor(() => expect(name).toHaveValue('New workspace'))
    if (edited) {
      await user.clear(name)
      await user.type(name, 'New workspace')
    }
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-created/settings'))
    expect(submitted).toMatchObject({ commandId: expect.any(String), parentPath: '/home/test/.local/share/graphql/workspaces' })
    if (edited) expect(submitted).toHaveProperty('name', 'New workspace')
    else expect(submitted).not.toHaveProperty('name')
  })

  it('submits the selected existing parent path with its trailing whitespace intact', async () => {
    const selected = '/projects/Selected '
    let submitted: Record<string, unknown> | undefined
    server.use(
      http.get('/api/management/harnesses/directories', ({ request }) => {
        const path = new URL(request.url).searchParams.get('path')
        return HttpResponse.json({ roots: [{ id: 'projects', label: 'Projects', path: '/projects' }],
          rootId: 'projects', path: path === selected ? selected : '/projects',
          parent: path === selected ? '/projects' : null, nextCursor: null,
          directories: path === selected ? [] : [{ name: 'Selected ', path: selected }] })
      }),
      http.post('/api/management/workspaces', async ({ request }) => {
        submitted = await request.json() as Record<string, unknown>
        return HttpResponse.json({ value: { workspace: { id: 'workspace-created', name: 'Project' },
          revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0,
          locationValidation: { status: 'restricted' } }, replayed: false })
      }),
    )
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await user.click(await screen.findByRole('button', { name: 'New workspace' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveValue(''))
    await user.click(screen.getByRole('button', { name: 'Location' }))
    await user.click(await screen.findByRole('button', { name: 'Selected' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue(selected))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await user.click(screen.getByRole('button', { name: 'Create workspace' }))
    await waitFor(() => expect(submitted?.parentPath).toBe(selected))
  })

  it('selects the suggested name for replacement and keeps creation fields minimal', async () => {
    server.use(http.get('/api/management/harnesses/directories', () => HttpResponse.json({
      roots: [{ id: 'projects', label: 'Projects', path: '/projects' }], rootId: 'projects', path: '/projects',
      parent: null, directories: [], nextCursor: null,
    })))
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    await user.click(await screen.findByRole('button', { name: 'New workspace' }))
    const location = await screen.findByRole('button', { name: 'Location' })
    await waitFor(() => expect(location.parentElement).toHaveTextContent('/home/test/.local/share/graphql/workspaces'))
    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.keyboard('My Project')
    expect(name).toHaveValue('My Project')
    expect(screen.queryByText(/^Folder:/)).not.toBeInTheDocument()
    expect(screen.queryByText('A project folder will be created for this workspace.')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Description (optional)' })).not.toBeInTheDocument()
    await user.click(location)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(screen.getByRole('button', { name: 'Location' }).parentElement).toHaveTextContent('/projects')
  })

  it('nests the workspace destinations under an active Workspaces menu', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    expect(await screen.findByTestId('workspace-shell')).toBeVisible()

    const workspaces = screen.getByRole('button', { name: 'Workspaces', expanded: true })
    expect(workspaces).toHaveAttribute('aria-expanded', 'true')
    expect(workspacesDestination()).toHaveClass('nav-item-active')

    const workflows = await screen.findByTitle('Workflows')
    expectNewTab(workflows, '/workspaces/workspace-1/workflows')
    expect(workflows).toHaveTextContent('Workflows')

    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument()

    for (const label of ['Files', 'Tasks', 'Runs']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
    expectNewTab(screen.getByRole('button', { name: 'Settings' }), '/settings')
    const settings = screen.getByRole('button', { name: 'Settings' })
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
    expect(settings.parentElement).toContainElement(screen.getByRole('button', { name: /Switch to .* theme/ }))
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveTextContent('')
    expect(screen.queryByRole('button', { name: 'Browsers' })).not.toBeInTheDocument()
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument()
  })

  it('marks Settings as the selected footer destination', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" activeGlobalSection="settings" />)
    await screen.findByTestId('workspace-shell')
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })

  it('expands and collapses the nested submenu from the parent control', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workspaces = await screen.findByRole('button', { name: 'Workspaces', expanded: true })
    await user.click(workspaces)

    expect(workspaces).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument()

    await user.click(workspaces)

    expect(workspaces).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTitle('Workflows')).toBeVisible()
  })

  it('collapses to an accessible icon rail and expands again', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    resize.focus()
    await user.keyboard('{Enter}')

    expect(screen.getByTestId('workspace-shell')).toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute('data-collapsed', 'true')
    expect(workspacesDestination()).toHaveAttribute('title', 'Workspaces')
    expect(screen.getByTitle('Workflows')).toHaveAttribute('title', 'Workflows')
    expect(screen.queryByRole('button', { name: 'New workspace' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()

    expect(resize).toHaveAttribute('tabindex', '0')
    expect(resize).toHaveAttribute('aria-valuenow', '60')
    expect(screen.queryByRole('button', { name: /navigation/ })).not.toBeInTheDocument()
    await user.keyboard('{Enter}')

    expect(screen.getByTestId('workspace-shell')).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(resize).toHaveAttribute('aria-valuenow', '264')
    expect(screen.getByRole('button', { name: 'New workspace' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('renders the product brand above the workspace tree and keeps its name readable when collapsed', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const brand = await screen.findByTestId('sidebar-brand')
    const mark = brand.querySelector('.sidebar-brand-mark')
    expect(brand).toHaveTextContent('Foreman Code')
    expect(mark).toHaveTextContent('F')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(brand.querySelector('.sidebar-brand-name')).toHaveTextContent('Foreman Code')

    screen.getByRole('separator', { name: 'Resize navigation' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.getByTestId('sidebar-brand')).toHaveTextContent('Foreman Code')
    expect(screen.getByTestId('sidebar-brand').querySelector('.sidebar-brand-name')).toHaveTextContent('Foreman Code')
    expect(workspacesDestination()).toHaveAttribute('title', 'Workspaces')
  })

  it('keeps the temporarily hidden Agents route content available by deep link', async () => {
    renderWithRouter(
      <WorkspaceShell workspaceId="workspace-1" activeSection="agents" slots={{ main: <div>Directory</div> }} />,
    )

    expect(await screen.findByRole('region', { name: 'Workspace content' })).toHaveTextContent('Directory')
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument()
    expect(workspacesDestination()).not.toHaveClass('nav-item-active')
    expect(await screen.findByTitle('Workflows')).not.toHaveAttribute('aria-current')
  })

  it('keeps Terminal hidden when its route is active', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" activeGlobalSection="terminal" />)
    await screen.findByTestId('workspace-shell')

    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
    expect(workspacesDestination()).not.toHaveClass('nav-item-active')
    expect(await screen.findByTestId('workspace-entry-workspace-1')).not.toHaveClass('nav-item-active')
  })

  it('expands and collapses each workspace entry independently', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const entry = await screen.findByRole('button', { name: 'Website' })
    const toggle = screen.getByRole('button', { name: 'Collapse Website' })
    expect(entry).toHaveAttribute('data-testid', 'workspace-entry-workspace-1')
    expectNewTab(entry, '/workspaces/workspace-1')
    expect(screen.queryByRole('button', { name: 'Workspace settings' })).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Collapse workflows in Website' })).toBeVisible()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /agents in Website/ })).not.toBeInTheDocument()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByRole('button', { name: 'Collapse workflows in Website' })).toBeVisible()
  })

  it('collapses and expands the nested Workflows submenu while Agents stays hidden', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workflowsToggle = await screen.findByRole('button', { name: 'Collapse workflows in Website' })
    expect(workflowsToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByTestId('agent-navigation')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'New workflow' })).toBeVisible()

    await user.click(workflowsToggle)

    expect(workflowsToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('starts section reordering only from the direct workflow row, not submenu links', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const workflowsRow = (await screen.findByTitle('Workflows')).closest('.nav-item-row')
    expect(workflowsRow).toHaveAttribute('data-reorder-id', 'workflows')

    const nestedWorkflow = await screen.findByRole('button', { name: 'Research to review' })
    expect(nestedWorkflow.closest('[data-reorder-id="workflows"]')).toBeNull()
  })

  it('renders multiple query-shaped workspace entries under the Workspaces parent', async () => {
    const user = userEvent.setup()
    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        workspaces={[
          { id: 'workspace-1', name: 'Website' },
          { id: 'workspace-2', name: 'Docs' },
        ]}
      />,
    )

    const docs = await screen.findByTestId('workspace-entry-workspace-2')
    const docsToggle = screen.getByRole('button', { name: 'Expand Docs' })
    expect(docs).toHaveAccessibleName('Docs')
    expectNewTab(docs, '/workspaces/workspace-2')
    expect(docsToggle).toHaveAttribute('aria-expanded', 'false')

    await user.click(docsToggle)

    expect(docsToggle).toHaveAttribute('aria-expanded', 'true')
    const workflowsLinks = screen.getAllByTitle('Workflows')
    expect(workflowsLinks).toHaveLength(2)
    workflowsLinks.forEach((button, index) => expectNewTab(button, `/workspaces/workspace-${index + 1}/workflows`))
  })

  it('resizes the navigation by pointer and keyboard within safe bounds', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    expect(resize).toHaveAttribute('aria-valuenow', String(DEFAULT_NAVIGATION_WIDTH))

    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: DEFAULT_NAVIGATION_WIDTH })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 })
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 300 })
    expect(resize).toHaveAttribute('aria-valuenow', '300')
    expect(screen.getByTestId('workspace-shell')).toHaveStyle('--navigation-width: 300px')

    resize.focus()
    await user.keyboard('{End}{ArrowRight}')
    expect(resize).toHaveAttribute('aria-valuenow', String(MAX_NAVIGATION_WIDTH))
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-navigation-motion', 'instant')

    await user.dblClick(resize)
    expect(resize).toHaveAttribute('aria-valuenow', String(DEFAULT_NAVIGATION_WIDTH))
  })

  it.each([192, 264, 320, 360])('collapses strictly below half the %spx drag-start width and restores it on reopening', async (startWidth) => {
    useNavigationUiStore.getState().setWidth(startWidth)
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')

    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: startWidth })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: startWidth / 2 })
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(resize).toHaveAttribute('aria-valuenow', String(startWidth / 2))

    fireEvent.pointerMove(window, { pointerId: 7, clientX: startWidth / 2 - 1 })
    expect(shell).toHaveClass('workspace-shell-navigation-collapsed')
    expect(shell).toHaveAttribute('data-navigation-motion', 'manual')
    expect(shell).toHaveStyle(`--navigation-width: ${startWidth}px`)

    fireEvent.pointerUp(window, { pointerId: 7 })
    resize.focus()
    await user.keyboard('{Enter}')
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(resize).toHaveAttribute('aria-valuenow', String(startWidth))
  })

  it('uses the measured sidebar width at drag start rather than a different remembered width', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    vi.spyOn(resize.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 240 } as DOMRect)
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 240 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 120 })
    expect(screen.getByTestId('workspace-shell')).not.toHaveClass('workspace-shell-navigation-collapsed')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 119 })
    expect(screen.getByTestId('workspace-shell')).toHaveClass('workspace-shell-navigation-collapsed')
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(useNavigationUiStore.getState().width).toBe(240)
  })

  it('closes and reopens repeatedly in one held pointer gesture using its original half-width threshold', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    for (const width of [132, 131, 264, 132, 131, 264, 340, 150, 132, 131, 132, 280]) {
      fireEvent.pointerMove(window, { pointerId: 7, clientX: width })
      expect(shell.classList.contains('workspace-shell-navigation-collapsed')).toBe(width < 132)
      expect(resize).toHaveAttribute('aria-valuenow', String(width < 132 ? 60 : width))
      expect(shell).toHaveStyle(`--navigation-width: ${width < 132 ? 264 : width}px`)
      expect(useNavigationUiStore.getState().width).toBe(264)
      expect(sessionStorage.getItem('graphql-navigation-width')).toBeNull()
    }
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: false, width: 280, resizeWidth: null })
    expect(sessionStorage.getItem('graphql-navigation-width')).toBe('280')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 131 })
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
  })

  it.each(['pointerUp', 'pointerCancel', 'blur', 'unmount'])('finishes an auto-collapsed held gesture on %s and retains its remembered width', async (ending) => {
    const view = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 131 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 300 })
    fireEvent.pointerUp(window, { pointerId: 8 })
    expect(useNavigationUiStore.getState().collapsed).toBe(true)
    if (ending === 'unmount') view.unmount()
    else if (ending === 'blur') fireEvent.blur(window)
    else fireEvent[ending as 'pointerUp' | 'pointerCancel'](window, { pointerId: 7 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 })
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: true, width: 264, resizeWidth: null })
    expect(sessionStorage.getItem('graphql-navigation-width')).toBe('264')
  })

  it('ignores other pointers and stops resizing on matching cancellation, external collapse, or unmount', async () => {
    const view = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 50 })
    fireEvent.pointerCancel(window, { pointerId: 8 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 })
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: false, width: 264, resizeWidth: 300 })
    fireEvent.pointerCancel(window, { pointerId: 7 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 50 })
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: false, width: 300 })

    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 300 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 310 })
    act(() => useNavigationUiStore.getState().setCollapsed(true))
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 350 })
    expect(useNavigationUiStore.getState()).toMatchObject({ width: 310, resizeWidth: null, motion: 'instant' })
    act(() => useNavigationUiStore.getState().setCollapsed(false))
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 310 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 320 })
    view.unmount()
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 350 })
    expect(useNavigationUiStore.getState()).toMatchObject({ width: 320, resizeWidth: null })
  })

  it.each(['{Enter}', ' ', '{Control>}b{/Control}', '{Meta>}b{/Meta}'])('keeps keyboard %s activation instant after manual sidebar changes', async (key) => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 131 })
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-navigation-motion', 'manual')
    resize.focus()
    await user.keyboard(key)
    expect(screen.getByTestId('workspace-shell')).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-navigation-motion', 'instant')
    await user.keyboard(key)
    expect(screen.getByTestId('workspace-shell')).toHaveClass('workspace-shell-navigation-collapsed')
    expect(screen.getByTestId('workspace-shell')).toHaveAttribute('data-navigation-motion', 'instant')
  })

  it('reopens the rail gradually and can close and reopen again without releasing the pointer', async () => {
    useNavigationUiStore.getState().setCollapsed(true)
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 60 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 280 })
    expect(shell).toHaveClass('workspace-shell-navigation-collapsed')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 60 })
    expect(shell).toHaveClass('workspace-shell-navigation-collapsed')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 210 })
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(shell).toHaveStyle('--navigation-width: 210px')
    expect(shell).toHaveAttribute('data-navigation-motion', 'manual')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 280 })
    expect(shell).toHaveStyle('--navigation-width: 280px')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 61 })
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(shell).toHaveStyle('--navigation-width: 61px')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 30 })
    expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
    expect(shell).toHaveStyle('--navigation-width: 60px')
    for (const width of [29, 60, 61, 264, 29, 61]) {
      fireEvent.pointerMove(window, { pointerId: 7, clientX: width })
      expect(shell.classList.contains('workspace-shell-navigation-collapsed')).toBe(width <= 60)
      expect(resize).toHaveAttribute('aria-valuenow', String(width <= 60 ? 60 : width))
    }
    fireEvent.pointerUp(window, { pointerId: 7 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 350 })
    expect(shell).toHaveStyle('--navigation-width: 192px')
  })

  it('tracks each shrink and reverse frame below the saved minimum without persisting intermediate widths', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    for (const width of [230, 200, 180, 150, 132, 150, 180, 200, 230, 280]) {
      fireEvent.pointerMove(window, { pointerId: 7, clientX: width })
      expect(shell).toHaveStyle(`--navigation-width: ${width}px`)
      expect(resize).toHaveAttribute('aria-valuenow', String(width))
      expect(useNavigationUiStore.getState().width).toBe(264)
      expect(sessionStorage.getItem('graphql-navigation-width')).toBeNull()
    }
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 280 })
    expect(useNavigationUiStore.getState()).toMatchObject({ width: 280, resizeWidth: null })
    expect(sessionStorage.getItem('graphql-navigation-width')).toBe('280')
  })

  it('opens one pixel at a time from the rail and ignores a second pointer starting a drag', async () => {
    useNavigationUiStore.getState().setCollapsed(true)
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 60 })
    for (const width of [61, 80, 120, 160, 200, 180, 120, 61, 220]) {
      fireEvent.pointerMove(window, { pointerId: 7, clientX: width })
      expect(shell).not.toHaveClass('workspace-shell-navigation-collapsed')
      expect(shell).toHaveStyle(`--navigation-width: ${width}px`)
    }
    fireEvent.pointerDown(resize, { button: 0, pointerId: 8, clientX: 220 })
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 350 })
    fireEvent.pointerUp(window, { pointerId: 8 })
    expect(shell).toHaveStyle('--navigation-width: 220px')
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 240 })
    expect(shell).toHaveStyle('--navigation-width: 240px')
    fireEvent.pointerUp(window, { pointerId: 7 })
    expect(useNavigationUiStore.getState()).toMatchObject({ width: 240, resizeWidth: null })
  })

  it('settles a short expanded drag to the saved minimum and caps live width at the viewport', async () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320)
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    const shell = screen.getByTestId('workspace-shell')
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 150 })
    expect(shell).toHaveStyle('--navigation-width: 150px')
    fireEvent.pointerCancel(window, { pointerId: 7 })
    expect(shell).toHaveStyle('--navigation-width: 192px')
    expect(useNavigationUiStore.getState().resizeWidth).toBeNull()
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 192 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 500 })
    expect(shell).toHaveStyle('--navigation-width: 260px')
    fireEvent.pointerUp(window, { pointerId: 7 })
  })

  it('clears the live gesture on window blur or a keyboard toggle before subsequent pointer frames', async () => {
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
    const resize = await screen.findByRole('separator', { name: 'Resize navigation' })
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 264 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 })
    fireEvent.blur(window)
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 350 })
    expect(useNavigationUiStore.getState()).toMatchObject({ width: 300, resizeWidth: null })
    fireEvent.pointerDown(resize, { button: 0, pointerId: 7, clientX: 300 })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 230 })
    fireEvent.keyDown(resize, { key: 'Enter' })
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 350 })
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: true, width: 230, resizeWidth: null, motion: 'instant' })
  })

  it('keeps Ctrl/Cmd+B out of editable controls and uses arrows to reopen the focused rail instantly', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" slots={{ main: <><input aria-label="Draft name" /><div contentEditable role="textbox" aria-label="Draft notes" /></> }} />)
    await user.click(await screen.findByRole('textbox', { name: 'Draft name' }))
    await user.keyboard('{Control>}b{/Control}')
    expect(useNavigationUiStore.getState().collapsed).toBe(false)
    await user.click(screen.getByRole('textbox', { name: 'Draft notes' }))
    await user.keyboard('{Meta>}b{/Meta}')
    expect(useNavigationUiStore.getState().collapsed).toBe(false)
    const resize = screen.getByRole('separator', { name: 'Resize navigation' })
    resize.focus()
    await user.keyboard('{Enter}{ArrowRight}')
    expect(useNavigationUiStore.getState()).toMatchObject({ collapsed: false, width: 272, motion: 'instant' })
  })

  it('keeps workflow submenu state across shell remounts', async () => {
    const user = userEvent.setup()
    const first = renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    await user.click(await screen.findByRole('button', { name: 'Collapse workflows in Website' }))
    first.unmount()
    renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)

    expect(await screen.findByRole('button', { name: 'Expand workflows in Website' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument()
  })

  it('renders the graph surface without mounted operator or context surfaces', async () => {
    const rendered = renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          runner: <span>Runner one</span>,
          graph: <div>Graph slot</div>,
          terminal: <div>Terminal slot</div>,
        }}
      />,
    )

    expect(await screen.findByTestId('workspace-shell')).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Shared workspace')
    expect(screen.getByTestId('sidebar-brand')).toHaveTextContent('Foreman Code')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Runner one')
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Graph slot')
    expect(screen.getByTestId('workspace-shell')).not.toHaveTextContent('Terminal slot')
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument()

    rendered.unmount()

    renderWithRouter(
      <WorkspaceShell
        workspaceId="workspace-1"
        slots={{
          workspace: <span>Shared workspace</span>,
          graph: <div>Selected agent graph</div>,
        }}
      />,
    )

    expect(await screen.findByTestId('workspace-shell')).toBeInTheDocument()
    expect(document.querySelector('.shell-header')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
    expect(screen.queryByRole('separator', { name: 'Resize workspace context panel' })).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-shell')).toHaveTextContent('Selected agent graph')
  })
})

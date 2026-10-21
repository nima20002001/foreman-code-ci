import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import { renderWithRouter } from '../test/renderWithRouter'
import { server } from '../mocks/server'
import { getMockFixture } from '../shared/mocks/scenarios'
import { WorkspaceRouteView, WorkspaceSelection } from './WorkspaceRoute'

describe('WorkspaceRoute', () => {
  beforeEach(() => {
    const fixture = getMockFixture('workspace-1')
    if (!fixture) throw new Error('Workspace fixture missing')
    server.use(http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({
      workspace: fixture.workspace, revision: 1, archivedAt: null,
      executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: '2026-09-19T00:00:00.000Z' },
    })))
  })

  it('keeps the graph neutral when no agent is selected', async () => {
    renderWithRouter(<WorkspaceSelection workspaceId="workspace-1" />)

    expect(await screen.findByTestId('workspace-ready')).toHaveTextContent('No agent is selected')
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Workspace context' })).not.toBeInTheDocument()
  })

  it('exposes loading, error, and stale selection states through props', async () => {
    const loading = renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="loading" />)
    expect(await screen.findByTestId('workspace-loading')).toBeVisible()
    loading.unmount()

    renderWithRouter(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        state="error"
        stateMessage="Request failed"
      />,
    )
    expect(await screen.findByTestId('workspace-error')).toHaveTextContent('Request failed')
  })

  it('shows a missing workspace error before checking its execution folder', async () => {
    renderWithRouter(<WorkspaceRouteView workspaceId="missing" state="not-found" />)

    expect(await screen.findByTestId('workspace-not-found')).toBeVisible()
    expect(screen.queryByText('Execution folder could not be checked')).not.toBeInTheDocument()
  })

  it('keeps Workspaces active on the graph route and opens the workflows directory', async () => {
    const { router } = renderWithRouter(
      <WorkspaceRouteView
        workspaceId="workspace-1"
        selectedAgentId="agent-old"
        state="stale"
      />,
    )

    expect(await screen.findByTestId('workspace-stale')).toHaveTextContent('agent-old')
    const workflows = await screen.findByRole('button', { name: 'Workflows' })
    expect(workflows).not.toHaveAttribute('aria-current')
    const workspaces = screen.getAllByRole('button', { name: 'Workspaces' })
      .find(button => !button.hasAttribute('aria-expanded'))!
    expect(workspaces).toHaveClass('nav-item-active')
    await userEvent.click(workflows)
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1/workflows'))
  })

  it('offers creation on an empty board without an extra button above an open graph', async () => {
    const empty = renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="empty" />)
    expect(within(await screen.findByTestId('workspace-empty')).getByRole('button', { name: 'New workflow' })).toBeVisible()
    empty.unmount()

    renderWithRouter(<WorkspaceRouteView workspaceId="workspace-1" state="ready" />)
    expect(await screen.findByTestId('workspace-ready')).toBeVisible()
    expect(screen.queryByTestId('workspace-board-actions')).not.toBeInTheDocument()
  })
})

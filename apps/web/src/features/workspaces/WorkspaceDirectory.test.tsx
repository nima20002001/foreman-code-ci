import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { server } from '../../mocks/server'
import { WorkspaceDirectory } from './WorkspaceDirectory'

afterEach(() => {
  vi.unstubAllEnvs()
  sessionStorage.clear()
})

describe('WorkspaceDirectory', () => {
  it('sends an unauthenticated browser to App access', async () => {
    vi.stubEnv('MODE', 'development')
    server.use(http.get('/api/management/workspaces', () => HttpResponse.json({
      error: { code: 'AUTH_REQUIRED', message: 'A bearer credential is required.' },
    }, { status: 401 })))
    renderWithRouter(<WorkspaceDirectory />)

    expect(await screen.findByText('Workspaces unavailable')).toBeVisible()
    expect(screen.getByText('Check the local API connection, then retry the workspace list.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Open App access' })).not.toBeInTheDocument()
  })

  it('lists durable workspaces as simple cards', async () => {
    renderWithRouter(<WorkspaceDirectory />)

    expect(
      within(await screen.findByTestId('workspace-card-workspace-1'))
        .getByRole('link', { name: 'Website' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open actions for Website' })).toBeVisible()
  })

  it('shows an actionable empty state after every card is removed', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }))

    expect(await screen.findByTestId('workspace-directory-empty')).toHaveTextContent(
      'Use New workspace in the navigation',
    )
  })

  it('renames a workspace from its three-dot actions', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Docs')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByTestId('workspace-card-workspace-1')).toHaveTextContent('Docs')
  })
})

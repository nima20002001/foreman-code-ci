import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'

import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'
import { WorkflowDirectory } from '../workflows/WorkflowDirectory'

function workspace(locationValidation: ManagedWorkspace['locationValidation']): ManagedWorkspace {
  return {
    workspace: { id: 'workspace-1', name: 'A workspace with a long, meaningful project name' },
    revision: 1, archivedAt: null, locationRevision: 1,
    executionLocation: locationValidation.status === 'restricted' ? null : { runnerId: 'runner-local', rootPath: '/projects/website' },
    locationValidation,
  }
}

describe('compact workspace and workflow cards', () => {
  it('shows compact workspace names without routine destination text and keeps actions separate from opening', async () => {
    server.use(http.get('/api/management/workspaces', () => HttpResponse.json({
      items: [workspace({ status: 'ready', checkedAt: '2026-09-19T00:00:00Z' })], pageInfo: { nextCursor: null },
    })))
    const { router } = renderWithRouter(<WorkspaceDirectory />)
    const card = await screen.findByTestId('workspace-card-workspace-1')
    expect(within(card).queryByText('/projects/website')).not.toBeInTheDocument()
    const open = within(card).getByRole('link', { name: 'A workspace with a long, meaningful project name' })
    expect(open).toHaveAttribute('href', '/workspaces/workspace-1/settings')
    const actions = within(card).getByRole('button', { name: /Open actions/ })
    expect(open).not.toContainElement(actions)
    const before = router.state.location.pathname
    await userEvent.setup().click(actions)
    expect(await screen.findByRole('dialog', { name: /actions/ })).toBeVisible()
    expect(router.state.location.pathname).toBe(before)
  })

  it('does not describe restricted locations as ready or needing setup', async () => {
    server.use(http.get('/api/management/workspaces', () => HttpResponse.json({
      items: [workspace({ status: 'restricted' })], pageInfo: { nextCursor: null },
    })))
    renderWithRouter(<WorkspaceDirectory />)
    expect(await screen.findByRole('img', { name: 'Location restricted' })).toBeVisible()
    expect(screen.queryByText('Choose a destination')).not.toBeInTheDocument()
    expect(screen.queryByText('/projects/website')).not.toBeInTheDocument()
  })

  it('opens a workflow from its separate directory', async () => {
    const user = userEvent.setup()
    const { router } = renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)
    const open = await screen.findByRole('link', { name: 'Research to review' })
    expect(open).toHaveAttribute('href', '/workspaces/workspace-1?workflowId=workflow-content-pipeline')
    open.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(router.state.location.search).toEqual({ workflowId: 'workflow-content-pipeline' })
  })
})

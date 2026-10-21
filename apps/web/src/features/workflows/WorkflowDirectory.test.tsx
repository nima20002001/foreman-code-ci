import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkflowDirectory } from './WorkflowDirectory'

afterEach(() => {
  sessionStorage.clear()
})

describe('WorkflowDirectory', () => {
  it('keeps populated management actions when its containing page supplies the heading', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" hideHeading />)

    await screen.findByTestId('workflow-card-workflow-content-pipeline')
    expect(screen.queryByRole('heading', { name: 'Workflows' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select workflows' }))
    expect(screen.getByRole('checkbox', { name: 'Select Research to review' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Selection options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
  })

  it('keeps selection controls compact and accessible without losing selected workflows', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" hideHeading />)
    const actions = within(await screen.findByRole('group', { name: 'Workflow actions' }))
    const select = actions.getByRole('button', { name: 'Select workflows' })
    await user.click(select)

    expect(actions.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
    expect(screen.queryByText(/Select workflows to delete/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select all shown' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel selection' })).not.toBeInTheDocument()
    const options = actions.getByRole('button', { name: 'Selection options' })
    options.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Select all shown' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(options).toHaveFocus()

    await user.click(screen.getByRole('checkbox', { name: 'Select Research to review' }))
    expect(actions.getByRole('button', { name: 'Delete selected (1)' })).toBeEnabled()
    await user.click(options)
    await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
    expect(actions.getByRole('button', { name: 'Select workflows' })).toHaveFocus()
    expect(screen.getByRole('link', { name: 'Research to review' })).toBeVisible()
    expect(actions.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('groups the empty start treatment and creation action below the containing page heading', async () => {
    const user = userEvent.setup()
    server.use(http.get('/api/management/workspaces/workspace-1/workflows', () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" hideHeading />)

    const empty = within(await screen.findByTestId('workflow-directory-empty'))
    expect(empty.getByRole('heading', { name: 'No workflows yet' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Workflows' })).not.toBeInTheDocument()
    await user.click(empty.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
  })

  it('offers creation alongside existing workflows', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    await screen.findByTestId('workflow-card-workflow-content-pipeline')
    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument()
  })

  it('offers creation directly in the empty state', async () => {
    const user = userEvent.setup()
    server.use(http.get('/api/management/workspaces/workspace-1/workflows', () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    expect(await screen.findByTestId('workflow-directory-empty')).toHaveTextContent('No workflows yet')
    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()
  })

  it('lists durable workflows as directory cards', async () => {
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    expect(
      within(await screen.findByTestId('workflow-card-workflow-content-pipeline'))
        .getByRole('link', { name: 'Research to review' }),
    ).toHaveAttribute('href', expect.stringContaining('workflowId=workflow-content-pipeline'))
  })

  it('renames and removes workflows from card actions', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Research to review' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Review flow')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByTestId('workflow-card-workflow-content-pipeline')).toHaveTextContent('Review flow')

    await user.click(screen.getByRole('button', { name: 'Open actions for Review flow' }))
    await user.click(screen.getByRole('button', { name: 'Remove workflow' }))
    await waitFor(() => {
      expect(screen.queryByTestId('workflow-card-workflow-content-pipeline')).not.toBeInTheDocument()
    })
  })

  it('keeps an empty rename draft visible and focuses the field without sending an update', async () => {
    const user = userEvent.setup()
    let updateRequests = 0
    server.use(http.patch('/api/management/workspaces/:workspaceId/workflows/:workflowId', () => {
      updateRequests += 1
      return HttpResponse.json({})
    }))
    renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Research to review' }))
    const nameInput = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(nameInput)
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(nameInput).toHaveValue('')
    expect(nameInput).toHaveFocus()
    expect(nameInput).toHaveAccessibleDescription('Enter a workflow name.')
    expect(screen.getByText('Enter a workflow name.')).toBeVisible()
    expect(updateRequests).toBe(0)

    await user.type(nameInput, '   ')
    expect(screen.queryByText('Enter a workflow name.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(nameInput).toHaveValue('   ')
    expect(nameInput).toHaveFocus()
    expect(nameInput).toHaveAccessibleDescription('Enter a workflow name.')
    expect(updateRequests).toBe(0)
  })
})

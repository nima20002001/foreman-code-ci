import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ManagedWorkspace, WorkspaceStorageFolder } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

const registered: ManagedWorkspace = {
  workspace: { id: 'hover-project', name: 'Registered project' }, revision: 7, archivedAt: null,
  executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' },
}
const diskFolder: WorkspaceStorageFolder = {
  name: 'Disk project', path: '/workspaces/Disk project', identity: 'sha256:' + 'a'.repeat(64),
  deletion: { status: 'available' },
}

it('enters shared bulk mode from a card checkbox and restores hover affordances when the last selection clears', async () => {
  const user = userEvent.setup()
  const protectedFolder: WorkspaceStorageFolder = { ...diskFolder, name: 'Protected project', path: '/workspaces/Protected project',
    deletion: { status: 'protected', reason: 'active_run', message: 'An active run uses this folder.' } }
  server.use(
    http.get('/api/management/workspaces', () => HttpResponse.json({ items: [registered], pageInfo: { nextCursor: null } })),
    http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({ rootPath: '/workspaces',
      items: [diskFolder, protectedFolder], pageInfo: { nextCursor: null } })),
  )
  const { router } = renderWithRouter(<WorkspaceDirectory />)
  const workspaceCheckbox = await screen.findByRole('checkbox', { name: 'Select Registered project' })
  const folderCheckbox = await screen.findByRole('checkbox', { name: 'Select folder Disk project' })
  const protectedCheckbox = screen.getByRole('checkbox', { name: 'Select folder Protected project' })
  expect(screen.queryByRole('button', { name: 'Select workspaces' })).not.toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Workspace folders on disk' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument()
  const slot = (checkbox: HTMLElement) => checkbox.closest('.resource-card-selection-slot')
  expect(slot(workspaceCheckbox)).toHaveClass('is-hover-selection')
  expect(slot(folderCheckbox)).toHaveClass('is-hover-selection')
  expect(protectedCheckbox).toBeDisabled()

  const before = router.state.location.pathname
  workspaceCheckbox.focus()
  await user.keyboard(' ')
  expect(workspaceCheckbox).toBeChecked()
  expect(workspaceCheckbox).toHaveFocus()
  expect(router.state.location.pathname).toBe(before)
  expect(slot(workspaceCheckbox)).not.toHaveClass('is-hover-selection')
  expect(slot(folderCheckbox)).not.toHaveClass('is-hover-selection')
  expect(slot(protectedCheckbox)).not.toHaveClass('is-hover-selection')
  expect(screen.getByRole('button', { name: 'Delete selected (1)' })).toBeEnabled()
  expect(screen.queryByText(/Select workspaces and disk folders to delete/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Select all shown' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Cancel selection' })).not.toBeInTheDocument()
  const options = screen.getByRole('button', { name: 'Selection options' })
  options.focus()
  await user.keyboard('{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: 'Select all shown' })).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(options).toHaveFocus()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(within(screen.getByTestId('workspace-card-hover-project')).getByRole('link', { name: 'Registered project' })).toBeVisible()

  await user.click(folderCheckbox)
  expect(workspaceCheckbox).toBeChecked()
  expect(folderCheckbox).toBeChecked()
  expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeEnabled()
  await user.click(workspaceCheckbox)
  expect(slot(workspaceCheckbox)).not.toHaveClass('is-hover-selection')
  await user.click(folderCheckbox)
  expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument()
  expect(slot(workspaceCheckbox)).toHaveClass('is-hover-selection')
  expect(slot(folderCheckbox)).toHaveClass('is-hover-selection')
  expect(folderCheckbox).toHaveFocus()

  await user.click(folderCheckbox)
  expect(screen.getByRole('button', { name: 'Delete selected (1)' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Select all shown' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Clear selection' }))
  expect(folderCheckbox).not.toBeChecked()
  expect(slot(folderCheckbox)).toHaveClass('is-hover-selection')
  expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument()
})

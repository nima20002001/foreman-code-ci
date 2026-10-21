import { screen } from '@testing-library/react'
import { vi } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceExecutionLocationSetup } from './WorkspaceExecutionLocationSetup'

const { workspaceQuery, refetch } = vi.hoisted(() => ({
  workspaceQuery: { current: { data: { workspace: { id: 'workspace-1' }, locationValidation: { status: 'ready' } }, isError: false, isFetching: false } as {
    data?: { workspace: { id: string }; locationValidation: { status: string; error?: { message: string } } }
    isError: boolean
    isFetching: boolean
  } },
  refetch: vi.fn(),
}))

vi.mock('../../shared/api/query', () => ({
  useManagedWorkspaceQuery: () => ({ ...workspaceQuery.current, refetch }),
}))

describe('WorkspaceExecutionLocationSetup', () => {
  beforeEach(() => {
    workspaceQuery.current = { data: { workspace: { id: 'workspace-1' }, locationValidation: { status: 'ready' } }, isError: false, isFetching: false }
    refetch.mockClear()
  })

  function renderBoard(workspaceId = 'workspace-1') {
    return renderWithRouter(<WorkspaceExecutionLocationSetup workspaceId={workspaceId} enabled>
      <section>Workflow graph</section>
    </WorkspaceExecutionLocationSetup>)
  }

  it('keeps the workflow graph in a full-height flex layout', async () => {
    renderBoard()

    const content = (await screen.findByText('Workflow graph')).parentElement
    expect(content).toHaveClass('workspace-execution-content')
    expect(getComputedStyle(content!).display).toBe('flex')
    expect(getComputedStyle(content!).flexDirection).toBe('column')
  })

  it('hides the board until a folder is selected, with a direct setup path', async () => {
    workspaceQuery.current.data = { workspace: { id: 'workspace-1' }, locationValidation: { status: 'unconfigured' } }
    renderBoard()

    expect(screen.queryByText('Workflow graph')).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Choose an execution folder' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Choose execution folder' })).toHaveAttribute('href', '/workspaces/workspace-1/settings/location')
    expect(screen.queryByText(/Configure an available execution folder/)).not.toBeInTheDocument()
  })

  it('keeps an unavailable folder from opening the board and explains why', async () => {
    workspaceQuery.current.data = { workspace: { id: 'workspace-1' }, locationValidation: { status: 'unavailable', error: { message: 'The folder was removed.' } } }
    renderBoard()

    expect(screen.queryByText('Workflow graph')).not.toBeInTheDocument()
    expect(await screen.findByText(/The folder was removed/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Change execution folder' })).toBeVisible()
  })

  it('does not show another workspace’s board while its folder check loads', async () => {
    workspaceQuery.current.data = { workspace: { id: 'workspace-old' }, locationValidation: { status: 'ready' } }
    renderBoard('workspace-1')

    expect(screen.queryByText('Workflow graph')).not.toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent('Checking the execution folder…')
  })

  it('offers retry when the folder cannot be checked', async () => {
    workspaceQuery.current = { data: undefined, isError: true, isFetching: false }
    renderBoard()

    expect(screen.queryByText('Workflow graph')).not.toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Execution folder could not be checked')
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(refetch).toHaveBeenCalledOnce()
  })

  it('does not direct a restricted user into a settings form they cannot read', async () => {
    workspaceQuery.current.data = { workspace: { id: 'workspace-1' }, locationValidation: { status: 'restricted' } }
    renderBoard()

    expect(screen.queryByText('Workflow graph')).not.toBeInTheDocument()
    expect(await screen.findByText(/Ask the workspace owner for access/)).toBeVisible()
    expect(screen.queryByRole('link', { name: /execution folder/i })).not.toBeInTheDocument()
  })
})

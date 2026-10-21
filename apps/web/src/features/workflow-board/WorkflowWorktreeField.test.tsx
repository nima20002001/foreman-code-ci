import { useState } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowWorktreeSettings } from '@foreman-code/contracts/worktree-settings'
import { server } from '../../mocks/server'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { renderWithRouter } from '../../test/renderWithRouter'
import { worktreeFixture } from './worktree.fixtures'
import { WorkflowWorktreeField } from './WorkflowWorktreeField'
import { SavedWorkflowWorktree } from './SavedWorkflowWorktree'

function choicesFixture() {
  const fixture = worktreeFixture()
  server.use(
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json({
      workspace: { id: 'workspace-1', name: 'Website', repository: fixture.repository }, revision: 2,
      archivedAt: null, executionLocation: fixture.location.executionLocation, locationRevision: 1,
      locationValidation: { status: 'ready', checkedAt: fixture.source.approvedAt },
    })),
    http.get('/api/management/workspaces/workspace-1/source-roots', () => HttpResponse.json({
      items: [fixture.root], readiness: 'metadata-only',
    })),
    http.post('/api/management/workspaces/workspace-1/source-roots/get', () => HttpResponse.json(fixture.root)),
    http.post('/api/management/workspaces/workspace-1/sources/get', () => HttpResponse.json(fixture.source)),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({
      workspaceId: 'workspace-1', policies: [fixture.location.binding], allowlists: [], readiness: 'metadata-only',
    })),
    http.get('/api/management/workspaces/workspace-1/repository', () => HttpResponse.json(fixture.ready)),
  )
  return fixture
}

describe('workflow default worktree', () => {
  it('shows the visible control, applies a pinned workspace project and keeps it in the Board draft', async () => {
    const fixture = choicesFixture()
    const change = vi.fn()
    function Field() {
      const [value, setValue] = useState<WorkflowWorktreeSettings>()
      return <WorkflowWorktreeField workspaceId="workspace-1" value={value} onChange={next => {
        change(next)
        setValue(next)
      }} />
    }
    renderWithRouter(<UnsavedChangesProvider><Field /></UnsavedChangesProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Worktree:/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Default worktree' })
    const workspaceProject = await within(dialog).findByRole('button', { name: 'Use workspace project' })
    await waitFor(() => expect(workspaceProject).toBeEnabled())
    expect(within(dialog).queryByText('Each Agent gets its own worktree and unique branch at the selected approved commit.')).not.toBeInTheDocument()
    const hint = within(dialog).getByRole('button', { name: 'About Worktree' })
    await user.hover(hint)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Each Agent gets its own worktree and unique branch at the selected approved commit.')
    await user.unhover(hint)
    await user.click(workspaceProject)
    await user.type(within(dialog).getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/site/review')
    expect(change).not.toHaveBeenCalled()
    expect(within(dialog).getByText(fixture.source.manifest.git!.commit)).toBeVisible()
    expect(within(dialog).getByText(fixture.location.binding.canonicalProjectRoot)).toBeVisible()
    await user.click(within(dialog).getByRole('button', { name: 'Apply worktree' }))
    expect(change).toHaveBeenCalledExactlyOnceWith({ rootBinding: fixture.rootBinding, branchPrefix: 'foreman/site/review' })
    expect(screen.getByRole('button', { name: /^Worktree:/ })).toHaveAccessibleName(/\(unsaved\)$/)
    expect(screen.queryByRole('dialog', { name: 'Default worktree' })).not.toBeInTheDocument()
  })

  it('retains an unavailable saved choice and clears its property only on Apply', async () => {
    const fixture = choicesFixture()
    server.use(http.get('/api/management/workspaces/workspace-1/source-roots', () => HttpResponse.json({
      items: [], readiness: 'metadata-only',
    })))
    const change = vi.fn()
    renderWithRouter(<WorkflowWorktreeField workspaceId="workspace-1" value={{ rootBinding: fixture.rootBinding }}
      savedValue={{ rootBinding: fixture.rootBinding }} onChange={change} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Worktree:/ }))
    const select = await screen.findByRole('combobox', { name: 'Approved source root' })
    expect(select).toHaveValue('retained')
    expect(screen.getByText(/configured source is unavailable/)).toBeVisible()
    expect(change).not.toHaveBeenCalled()
    await user.selectOptions(select, 'workspace')
    expect(change).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Apply worktree' }))
    expect(change).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('guards an edited dialog on backdrop dismissal and locks it during a pending save', async () => {
    const fixture = choicesFixture()
    let lock!: (value: boolean) => void
    function Field() {
      const [disabled, setDisabled] = useState(false)
      lock = setDisabled
      return <WorkflowWorktreeField workspaceId="workspace-1" value={{ rootBinding: fixture.rootBinding }}
        disabled={disabled} onChange={vi.fn()} />
    }
    renderWithRouter(<UnsavedChangesProvider><Field /></UnsavedChangesProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Worktree:/ }))
    await user.type(screen.getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/local')
    const dialog = screen.getByRole('dialog', { name: 'Default worktree' })
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('unsaved changes in default worktree')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('textbox', { name: 'Agent branch prefix' })).toHaveValue('foreman/local')
    act(() => lock(true))
    expect(screen.getByRole('button', { name: 'Apply worktree' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Default worktree' })).toBeVisible()
  })

  it('rejects invalid branch prefixes without changing the draft', async () => {
    const fixture = choicesFixture()
    const change = vi.fn()
    renderWithRouter(<WorkflowWorktreeField workspaceId="workspace-1" value={{ rootBinding: fixture.rootBinding }}
      onChange={change} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /^Worktree:/ }))
    await user.type(screen.getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/../bad')
    await user.click(screen.getByRole('button', { name: 'Apply worktree' }))
    expect(await screen.findByText('Use a valid foreman/ Agent branch prefix.')).toBeVisible()
    expect(change).not.toHaveBeenCalled()
  })

  it('reads a saved reference without substituting the current catalog or workflow setting', async () => {
    const fixture = choicesFixture()
    server.use(http.get('/api/management/workspaces/workspace-1/source-roots', () => HttpResponse.json({
      items: [], readiness: 'metadata-only',
    })))
    renderWithRouter(<SavedWorkflowWorktree workspaceId="workspace-1"
      value={{ rootBinding: fixture.rootBinding, branchPrefix: 'foreman/historical' }} />)
    expect(await screen.findByText(`Main · octo-owner/website · ${fixture.source.manifest.git!.commit.slice(0, 12)}`)).toBeVisible()
    expect(screen.getByText('foreman/historical')).toBeVisible()
  })

  it('labels the worktree computer with its saved name', async () => {
    const fixture = choicesFixture()
    server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({
      mainId: fixture.root.selection.hostRef.mainId, cloud: [], truncated: false, activityComplete: true,
      computers: [{ target: { hostRef: fixture.root.selection.hostRef, applicationInstallationId: fixture.root.selection.hostRef.mainId,
        keyRevision: null, authorizationRevision: null }, name: 'Studio PC', online: true, jobs: [], agents: [] }],
    })))
    renderWithRouter(<SavedWorkflowWorktree workspaceId="workspace-1" value={{ rootBinding: fixture.rootBinding }} />)
    expect(await screen.findByText(`Studio PC · octo-owner/website · ${fixture.source.manifest.git!.commit.slice(0, 12)}`)).toBeVisible()
  })
})

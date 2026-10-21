import { useLayoutEffect, useState } from 'react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { staysOnWorkflowBoard } from '@foreman-code/contracts/wave25'
import { BoardHistoryNavigationBoundary } from './WorkspaceRouteEntry'
import { RunsSelectorSearchSchema, useSelectedRun, type SelectedRunState } from '../features/runs-selector'
import { UnsavedChangesProvider } from '../shared/ui/UnsavedChangesProvider'
import { useUnsavedChanges } from '../shared/ui/unsavedChanges'
import { Dialog } from '../shared/ui/nocturne'

const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline' }
type Form = { dirty: boolean; busy: boolean; uncertain: boolean; surface: boolean; portal: boolean }
let update: (patch: Partial<Form>) => void
let selection: SelectedRunState
const save = vi.fn(), discard = vi.fn()

/** Exercise the unchanged shared guard's registrations and original callbacks.
 * Production Board/draft coverage is in WorkspaceRouteEntry.sch-board.test.tsx.
 */
function FormProbe() {
  const [form, setForm] = useState<Form>({ dirty: true, busy: false, uncertain: false, surface: false, portal: false })
  const selected = useSelectedRun(scope)
  useLayoutEffect(() => {
    selection = selected
    update = (patch) => setForm((value) => ({ ...value, ...patch }))
  }, [selected])
  useUnsavedChanges({ label: 'Board form', scope: form.surface ? 'surface' : undefined,
    dirty: form.dirty, busy: form.busy, uncertain: form.uncertain,
    canResume: () => false,
    save: () => { save(); setForm((value) => ({ ...value, dirty: false, uncertain: false })) },
    discard: () => { discard(); setForm((value) => ({ ...value, dirty: false })) },
  }, form.surface ? undefined : (current, next) => !staysOnWorkflowBoard(
    { ...current, search: { ...current.search, agentId: undefined } },
    { ...next, search: { ...next.search, agentId: undefined } }))
  return <>
    <output aria-label="Selection">{selected.identity.runId ?? 'current'}</output>
    <Dialog open={form.portal} title="Authoring portal" closeLabel="Close authoring portal"
      onOpenChange={(open) => setForm((value) => ({ ...value, portal: open }))}>
      <button type="button">Authoring action</button>
    </Dialog>
  </>
}
async function mount() {
  const root = createRootRoute({ component: () => <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider> })
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema,
    component: () => <BoardHistoryNavigationBoundary><FormProbe /></BoardHistoryNavigationBoundary> })
  const router = createRouter({ routeTree: root.addChildren([board]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: [`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}`] }) })
  await router.load()
  render(<RouterProvider router={router} />)
  await screen.findByLabelText('Selection')
  return router
}
function requestHistory() { act(() => { void selection.selectRun('run-a') }) }
const prompt = () => screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })

beforeEach(() => { save.mockClear(); discard.mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Board history navigation preserves the existing authoring guards', () => {
  it('projects both extended searches so a dirty document survives a selection-only visit', async () => {
    const router = await mount()
    await act(async () => { await selection.selectRun('run-a') })
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    await act(async () => { await selection.selectRun(null) })
    expect(screen.getByLabelText('Selection')).toHaveTextContent('current')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
  })

  it.each(['busy', 'uncertain'] as const)('does not abandon a %s command to enter history', async (flag) => {
    const router = await mount()
    act(() => update({ [flag]: true }))
    requestHistory()
    const dialog = await prompt()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
  })

  it('reviews a dirty contextual form through its original Discard before history navigation', async () => {
    const router = await mount()
    act(() => update({ surface: true }))
    requestHistory()
    const dialog = await prompt()
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(router.state.location.search.selectedRunId).toBe('run-a'))
    expect(discard).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
  })

  it('retains the document departure guard for a different workflow', async () => {
    const router = await mount()
    act(() => { void router.navigate({ href: '/workspaces/workspace-1?workflowId=workflow-other' }) })
    await prompt()
    expect(router.state.location.search.workflowId).toBe(scope.workflowId)
    expect(discard).not.toHaveBeenCalled()
  })

  it('requires an open body portal to close normally before accepting history, never force-dismisses it', async () => {
    const router = await mount()
    act(() => update({ dirty: false, portal: true }))
    const portal = await screen.findByRole('dialog', { name: 'Authoring portal' })
    await act(async () => { void selection.selectRun('run-a') })
    expect(router.state.location.search.selectedRunId).toBeUndefined()
    expect(portal).toBeVisible()
    await userEvent.click(within(portal).getByRole('button', { name: 'Close authoring portal' }))
    await waitFor(() => expect(portal).not.toBeVisible())
    await act(async () => { await selection.selectRun('run-a') })
    expect(router.state.location.search.selectedRunId).toBe('run-a')
    expect(save).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled()
  })
})

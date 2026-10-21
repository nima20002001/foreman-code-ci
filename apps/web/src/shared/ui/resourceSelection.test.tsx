import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from '../../features/workspaces/WorkspaceDirectory'
import { WorkflowDirectory } from '../../features/workflows/WorkflowDirectory'
import { createResourceSelection } from './resourceSelection'

it.each(['workspaces', 'workflows'] as const)('selects and clears all shown %s, including another loaded page', async (kind) => {
  const path = kind === 'workspaces' ? '/api/management/workspaces' : '/api/management/workspaces/workspace-1/workflows'
  const item = (id: string) => kind === 'workspaces'
    ? { workspace: { id, name: id }, revision: 1, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }
    : { workflow: { id, name: id, workspaceId: 'workspace-1', executionSemanticsVersion: 3, entryNodeId: null, nodes: [], edges: [], executionCondition: { kind: 'manual' } }, revision: 1, archivedAt: null, currentVersionId: null }
  server.use(http.get(path, ({ request }) => {
    const more = new URL(request.url).searchParams.has('cursor')
    return HttpResponse.json({ items: (more ? ['Gamma'] : ['Alpha', 'Beta']).map(item), pageInfo: { nextCursor: more ? null : 'Beta' } })
  }))
  const user = userEvent.setup()
  renderWithRouter(kind === 'workspaces' ? <WorkspaceDirectory /> : <WorkflowDirectory workspaceId="workspace-1" />)
  if (kind === 'workspaces') await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha' }))
  else await user.click(await screen.findByRole('button', { name: 'Select workflows' }))
  const chooseSelection = async (name: string) => {
    await user.click(screen.getByRole('button', { name: 'Selection options' }))
    await user.click(screen.getByRole('menuitem', { name }))
  }
  await chooseSelection('Select all shown')
  expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Select Beta' })).toBeChecked()
  expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: `Show more ${kind}` }))
  expect(await screen.findByRole('checkbox', { name: 'Select Gamma' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Select Alpha' })).toBeChecked()
  await chooseSelection('Select all shown')
  expect(screen.getByRole('button', { name: 'Delete selected (3)' })).toBeEnabled()
  await chooseSelection('Clear selection')
  if (kind === 'workspaces') expect(screen.queryByRole('button', { name: /Delete selected/ })).not.toBeInTheDocument()
  else expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  if (kind === 'workspaces') await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  expect(screen.getByRole('menuitem', { name: 'Select all shown' })).toBeEnabled()
  await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
})

it('caps select-all at 100 and retains the revisions originally selected', () => {
  const store = createResourceSelection()
  store.getState().start()
  store.getState().toggle('item-0', 1)
  store.getState().selectMany(Array.from({ length: 105 }, (_, index) => ({ id: `item-${index}`, revision: 2 })))
  expect(Object.keys(store.getState().selected)).toHaveLength(100)
  expect(store.getState().selected['item-0']).toBe(1)
  expect(store.getState().selected['item-99']).toBe(2)
  expect(store.getState().selected['item-100']).toBeUndefined()
  store.getState().deselectAll()
  expect(store.getState().selected).toEqual({})
  expect(store.getState().selecting).toBe(true)
})

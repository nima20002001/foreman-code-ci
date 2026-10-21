import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import type { LeaveTarget } from '../../shared/ui/unsavedChanges'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { mainRoot, workerRoot, rootSetReadback } from './workspaceBoundLocation.fixtures'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'

const blocker = vi.hoisted(() => ({ current: undefined as unknown as {
  shouldBlockFn(input: { current: LeaveTarget; next: LeaveTarget }): Promise<boolean>
} }))
vi.mock('@tanstack/react-router', () => ({ useBlocker: (options: typeof blocker.current) => { blocker.current = options } }))
function leave() {
  let navigation!: Promise<boolean>
  act(() => { navigation = blocker.current.shouldBlockFn({ current: { pathname: '/settings', search: {} }, next: { pathname: '/other', search: {} } }) })
  return navigation
}

it('reconciles an unknown folder command through navigation without unlocking discard or changing the selection', async () => {
  useBoundLocationDraftStore.getState().reset()
  const workspaceId = 'workspace-a'
  const requests: WorkspaceRootSelection[] = []
  server.use(http.get('/api/management/workspaces/:workspaceId/root-location', () => HttpResponse.json({ evidence: 'legacy_missing', workspaceId, locationRevision: 1, executionLocation: { runnerId: 'runner-local', rootPath: '/previous' } })),
    http.get('/api/management/workspaces/:workspaceId/root-policies', () => HttpResponse.json({ workspaceId, readiness: 'metadata-only', policies: [], allowlists: [mainRoot, workerRoot] })),
    http.put('/api/management/workspaces/:workspaceId/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; requests.push(input)
      return requests.length === 1 ? HttpResponse.json({ error: { code: 'INTERNAL', message: 'Folder unconfirmed.' } }, { status: 503 }) : HttpResponse.json({ value: rootSetReadback(input, workerRoot), replayed: true })
    }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace(workspaceId), { workspace: { id: workspaceId, name: 'Workspace' }, revision: 1, archivedAt: null, executionLocation: { runnerId: 'runner-local', rootPath: '/previous' }, locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00Z' } })
  render(<QueryClientProvider client={client}><UnsavedChangesProvider><WorkspaceExecutionLocationSettings workspaceId={workspaceId} /></UnsavedChangesProvider></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Project folder' }))
  const select = await screen.findByRole('combobox', { name: 'Computer and approved base folder' })
  await user.selectOptions(select, select.querySelectorAll('option')[2]!.value)
  await user.type(screen.getByRole('textbox', { name: 'Relative folder on this computer' }), 'original')
  await user.click(screen.getByRole('button', { name: 'Select location' }))
  await screen.findByText(/The save outcome is unknown/)
  const navigation = leave()
  const dialog = screen.getByRole('alertdialog')
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: 'Retry original save' })).toBeEnabled()
  await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  expect(await navigation).toBe(false)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0]?.relativePath).toBe('original')
  client.clear()
})

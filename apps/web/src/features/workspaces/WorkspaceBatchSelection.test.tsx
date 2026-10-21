import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

const workspace = (id: string): ManagedWorkspace => ({ workspace: { id, name: id }, revision: 1,
  archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } })

it('loads pages only on request, retains selection across pages, and sends one batch with safe retry', async () => {
  const cursors: (string | null)[] = [], bodies: unknown[] = []
  let deleted = false, fail = true
  let releaseFailure!: () => void
  const firstResponse = new Promise<void>((resolve) => { releaseFailure = resolve })
  server.use(
    http.get('/api/management/workspaces', ({ request }) => {
      const url = new URL(request.url), cursor = url.searchParams.get('cursor')
      expect(url.searchParams.get('limit')).toBe(cursor ? '10' : '5')
      cursors.push(cursor)
      return HttpResponse.json({ items: deleted ? [] : [workspace(cursor ? 'Beta' : 'Alpha')], pageInfo: { nextCursor: cursor || deleted ? null : 'Alpha' } })
    }),
    http.post('/api/management/workspaces/batch-archive', async ({ request }) => {
      bodies.push(await request.json())
      if (fail) { await firstResponse; fail = false; return HttpResponse.error() }
      deleted = true
      return HttpResponse.json({ value: { workspaceIds: ['Alpha', 'Beta'] }, replayed: true })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkspaceDirectory />)
  await screen.findByRole('link', { name: 'Alpha' })
  expect(cursors).toEqual([null])
  const alpha = screen.getByRole('checkbox', { name: 'Select Alpha' })
  alpha.focus(); await user.keyboard(' ')
  expect(alpha).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Show more workspaces' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Select Beta' }))
  expect(alpha).toBeChecked()
  expect(cursors).toEqual([null, 'Alpha'])
  expect(screen.queryByRole('button', { name: 'Show more workspaces' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Delete selected (2)' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete 2 workspaces?' })
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await user.click(within(dialog).getByRole('button', { name: 'Delete 2 workspaces' }))
  expect(within(dialog).getByRole('button', { name: 'Deleting…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Selection options' })).toBeDisabled()
  expect(alpha).toBeChecked()
  expect(alpha).toBeDisabled()
  releaseFailure()
  const retry = await screen.findByRole('button', { name: 'Retry deletion' })
  expect(screen.getByRole('button', { name: 'Selection options' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeDisabled()
  expect(alpha).toBeChecked()
  expect(alpha).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await user.click(retry)
  await screen.findByText('2 workspaces deleted.')
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(bodies[0]).toMatchObject({ workspaces: [
    { workspaceId: 'Alpha', expectedRevision: 1 }, { workspaceId: 'Beta', expectedRevision: 1 },
  ] })
  await waitFor(() => expect(screen.queryByTestId('workspace-card-Alpha')).not.toBeInTheDocument())
})

it('cancels selection without deleting and reports a definitive batch rejection', async () => {
  server.use(
    http.get('/api/management/workspaces', () => HttpResponse.json({ items: [workspace('Alpha')], pageInfo: { nextCursor: null } })),
    http.post('/api/management/workspaces/batch-archive', () => HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'A selected workspace changed. Nothing was deleted.' } }, { status: 409 })),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkspaceDirectory />)
  expect(screen.queryByRole('button', { name: 'Delete selected' })).not.toBeInTheDocument()
  await user.click(await screen.findByRole('checkbox', { name: 'Select Alpha' }))
  await user.click(screen.getByRole('button', { name: 'Delete selected (1)' }))
  await user.click(screen.getByRole('button', { name: 'Delete 1 workspace' }))
  expect(await screen.findByText('A selected workspace changed. Nothing was deleted.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
  expect(screen.getByRole('link', { name: 'Alpha' })).toBeVisible()
})

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

it('fetches workspace pages on demand and preserves loaded cards when the next page fails', async () => {
  const cursors: (string | null)[] = []
  let fail = true
  const item = (id: string) => ({ workspace: { id, name: id }, revision: 0, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } })
  server.use(http.get('/api/management/workspaces', ({ request }) => {
    const url = new URL(request.url), cursor = url.searchParams.get('cursor')
    expect(url.searchParams.get('limit')).toBe(cursor ? '10' : '5'); cursors.push(cursor)
    if (cursor && fail) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })
    return HttpResponse.json({ items: [item(cursor ? 'Beta' : 'Alpha')], pageInfo: { nextCursor: cursor ? null : 'Alpha' } })
  }))
  const user = userEvent.setup()
  renderWithRouter(<WorkspaceDirectory />)
  expect(await screen.findByRole('link', { name: 'Alpha' })).toBeVisible()
  expect(cursors).toEqual([null])
  await user.click(screen.getByRole('button', { name: 'Show more workspaces' }))
  await screen.findByRole('button', { name: 'Retry loading workspaces' })
  expect(screen.getByRole('link', { name: 'Alpha' })).toBeVisible()
  fail = false
  await user.click(screen.getByRole('button', { name: 'Retry loading workspaces' }))
  expect(await screen.findByRole('link', { name: 'Beta' })).toBeVisible()
  expect(cursors).toEqual([null, 'Alpha', 'Alpha'])
  expect(screen.queryByRole('button', { name: 'Show more workspaces' })).not.toBeInTheDocument()
})

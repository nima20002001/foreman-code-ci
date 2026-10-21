import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDetailPage } from './WorkspaceDetailPage'

it('shows the workspace memory board inline beside its workflows using the workspace scope', async () => {
  const scopes: unknown[] = []
  server.use(http.get('/api/memory-boards', ({ request }) => {
    const scope = new URL(request.url).searchParams.get('scope')
    if (scope) scopes.push(JSON.parse(scope))
    const page = { items: [], hasMore: false, nextCursor: null, revision: 0 }
    return HttpResponse.json({ board: { id: 'board-workspace', scope: { kind: 'workspace', workspaceId: 'workspace-1' }, revision: 0 },
      openColumns: ['todo', 'doing', 'blocked'].map(status => ({ ...page, status })), notes: page,
      counts: { todo: 0, doing: 0, blocked: 0, done: 0, completed: 0, dropped: 0, notes: 0 }, sequence: 0 })
  }))
  renderWithRouter(<WorkspaceDetailPage workspaceId="workspace-1" section="workflows"><p>Workspace workflows</p></WorkspaceDetailPage>)
  expect(await screen.findByRole('heading', { name: /Memory board/ })).toBeVisible()
  expect(await screen.findByRole('button', { name: 'Add card' })).toBeVisible()
  expect(screen.getByText('Workspace workflows')).toBeVisible()
  expect(scopes).toEqual([{ kind: 'workspace', workspaceId: 'workspace-1' }])
})

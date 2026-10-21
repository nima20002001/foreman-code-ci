import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

const identity = 'sha256:' + 'a'.repeat(64)
const folder = { name: 'Missing project', path: '/workspaces/Missing project', identity, deletion: { status: 'available' } }

it('shows unregistered workspace folders, confirms the exact path, retries safely and removes the deleted card', async () => {
  const user = userEvent.setup()
  let deleted = false
  const commands: unknown[] = []
  server.use(
    http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
      rootPath: '/workspaces', items: deleted ? [] : [folder], pageInfo: { nextCursor: null },
    })),
    http.post('/api/management/workspace-storage/folders/delete', async ({ request }) => {
      const body = await request.json()
      commands.push(body)
      if (commands.length === 1) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Connection interrupted' } }, { status: 503 })
      deleted = true
      return HttpResponse.json({ value: { path: folder.path }, replayed: true })
    }),
  )
  renderWithRouter(<WorkspaceDirectory />)
  await screen.findByRole('button', { name: 'Open actions for folder Missing project' })
  const folders = screen.getByTestId('workspace-card-list')
  expect(within(folders).getByText('Missing project', { selector: '.resource-card-name' })).toBeVisible()
  expect(within(folders).getByRole('link', { name: 'Website' })).toBeVisible()
  expect(within(folders).queryByRole('link', { name: folder.name })).not.toBeInTheDocument()
  expect(within(folders).getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getAllByRole('list')).toEqual([folders])
  expect(within(folders).queryByText(folder.path)).not.toBeInTheDocument()
  expect(within(folders).queryByText(/Folder on disk/)).not.toBeInTheDocument()
  await user.click(within(folders).getByRole('button', { name: 'Open actions for folder Missing project' }))
  await user.click(within(screen.getByRole('dialog', { name: 'folder Missing project actions' })).getByRole('button', { name: 'Delete folder' }))
  const confirmation = screen.getByRole('dialog', { name: 'Delete Missing project?' })
  expect(within(confirmation).getByText(folder.path)).toBeVisible()
  expect(confirmation).toHaveTextContent('all its files and subfolders')
  await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }))
  expect(commands).toHaveLength(0)
  await user.click(within(folders).getByRole('button', { name: 'Open actions for folder Missing project' }))
  await user.click(within(screen.getByRole('dialog', { name: 'folder Missing project actions' })).getByRole('button', { name: 'Delete folder' }))
  await user.click(screen.getByRole('button', { name: 'Delete folder and contents' }))
  await user.click(await screen.findByRole('button', { name: 'Retry deletion' }))
  await waitFor(() => expect(screen.queryByText('Missing project')).not.toBeInTheDocument())
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  expect(commands[0]).toMatchObject({ path: folder.path, expectedIdentity: identity })
  expect(await screen.findByRole('link', { name: 'Website' })).toBeVisible()
})

it('keeps protected folders visible with a reason and unavailable deletion', async () => {
  const message = 'An archived workspace still references this folder. Its retained location is protected.'
  server.use(http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
    rootPath: '/workspaces', items: [{ ...folder, deletion: { status: 'protected', reason: 'archived_workspace', message } }],
    pageInfo: { nextCursor: null },
  })))
  const user = userEvent.setup()
  renderWithRouter(<WorkspaceDirectory />)
  await screen.findByRole('button', { name: 'Open actions for folder Missing project' })
  const folders = screen.getByTestId('workspace-card-list')
  expect(within(folders).getByText(folder.name, { selector: '.resource-card-name' })).toBeVisible()
  expect(within(folders).getByRole('img', { name: `Protected folder. ${message}` })).toHaveAttribute('title', message)
  await user.click(within(folders).getByRole('button', { name: 'Open actions for folder Missing project' }))
  const menu = screen.getByRole('dialog', { name: 'folder Missing project actions' })
  expect(menu).toHaveTextContent(message)
  expect(within(menu).getByRole('button', { name: 'Delete folder' })).toBeDisabled()
})

it('keeps registered workspaces available when the caller cannot browse runner folders', async () => {
  server.use(http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
    error: { code: 'SCOPE_DENIED', message: 'This caller cannot browse runner folders.' },
  }, { status: 403 })))
  renderWithRouter(<WorkspaceDirectory />)
  expect(await screen.findByRole('link', { name: 'Website' })).toBeVisible()
  await waitFor(() => expect(screen.queryByText('Checking workspace folders…')).not.toBeInTheDocument())
  expect(within(screen.getByTestId('workspace-card-list')).getAllByRole('listitem')).toHaveLength(1)
  expect(screen.queryByText('Workspace folders unavailable')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Open actions for folder/ })).not.toBeInTheDocument()
})

it('loads more disk folders on request and shows a recoverable discovery error', async () => {
  const user = userEvent.setup()
  const requests: string[] = []
  let unavailable = true
  server.use(http.get('/api/management/workspace-storage/folders', ({ request }) => {
    if (unavailable) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Cannot read folders' } }, { status: 503 })
    const url = new URL(request.url)
    requests.push(url.search)
    return HttpResponse.json({ rootPath: '/workspaces', items: url.searchParams.has('cursor')
      ? [{ ...folder, name: 'Second project', path: '/workspaces/Second project' }] : [folder],
    pageInfo: { nextCursor: url.searchParams.has('cursor') ? null : folder.name } })
  }))
  renderWithRouter(<WorkspaceDirectory />)
  expect(await screen.findByText('Workspace folders unavailable')).toBeVisible()
  unavailable = false
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  await user.click(await screen.findByRole('button', { name: 'Show more workspace folders' }))
  expect(await screen.findByText('Second project', { selector: '.resource-card-name' })).toBeVisible()
  expect(requests).toEqual(['?limit=5', '?limit=10&cursor=Missing+project'])
})

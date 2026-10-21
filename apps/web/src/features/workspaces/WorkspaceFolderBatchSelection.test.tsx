import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { WorkspaceStorageFolder, WorkspaceStorageFolderDeleteInput } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceDirectory } from './WorkspaceDirectory'

const folder = (name: string, identityCharacter = 'a'): WorkspaceStorageFolder => ({
  name, path: `/workspaces/${name}`, identity: 'sha256:' + identityCharacter.repeat(64), deletion: { status: 'available' },
})
const emptyWorkspaces = http.get('/api/management/workspaces', () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } }))

it('selects disk folders across pages, excludes protected folders and preserves identity snapshots with select-all', async () => {
  const user = userEvent.setup()
  const alpha = folder('Alpha'), beta = folder('Beta', 'b')
  const protectedFolder = { ...folder('Protected'), deletion: { status: 'protected', reason: 'active_run', message: 'An active run uses this folder.' } }
  const commands: WorkspaceStorageFolderDeleteInput[] = []
  const deleted = new Set<string>()
  server.use(emptyWorkspaces,
    http.get('/api/management/workspace-storage/folders', ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      const items = cursor ? [{ ...alpha, identity: 'sha256:' + 'c'.repeat(64) }, beta] : [alpha, protectedFolder]
      return HttpResponse.json({ rootPath: '/workspaces', items: items.filter((item) => !deleted.has(item.path)),
        pageInfo: { nextCursor: cursor || deleted.size ? null : alpha.name } })
    }),
    http.post('/api/management/workspace-storage/folders/delete', async ({ request }) => {
      const input = await request.json() as WorkspaceStorageFolderDeleteInput
      commands.push(input); deleted.add(input.path)
      return HttpResponse.json({ value: { path: input.path }, replayed: false })
    }),
  )
  renderWithRouter(<WorkspaceDirectory />)
  await user.click(await screen.findByRole('checkbox', { name: 'Select folder Alpha' }))
  expect(screen.getByRole('checkbox', { name: 'Select folder Protected' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Show more workspace folders' }))
  await screen.findByRole('checkbox', { name: 'Select folder Beta' })
  expect(screen.getByRole('checkbox', { name: 'Select folder Alpha' })).toBeChecked()
  // Overlapping readback changes identity; one card and its original selected snapshot remain.
  expect(screen.getAllByRole('checkbox', { name: 'Select folder Alpha' })).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Select all shown' }))
  expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeEnabled()
  expect(screen.getByRole('checkbox', { name: 'Select folder Protected' })).not.toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Delete selected (2)' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete 2 folders?' })
  expect(dialog).toHaveTextContent(alpha.path)
  expect(dialog).toHaveTextContent(beta.path)
  expect(dialog).toHaveTextContent('permanently deleted with all files and subfolders')
  await user.click(within(dialog).getByRole('button', { name: 'Delete 2 folders' }))
  await screen.findByText('2 folders deleted.')
  expect(commands.map(({ path, expectedIdentity }) => ({ path, expectedIdentity }))).toEqual([
    { path: alpha.path, expectedIdentity: alpha.identity }, { path: beta.path, expectedIdentity: beta.identity },
  ])
  expect(screen.getByRole('img', { name: 'Protected folder. An active run uses this folder.' })).toBeVisible()
})

it('keeps unknown and unattempted folder selections, retries the original command and never repeats confirmed deletion', async () => {
  const user = userEvent.setup()
  const items = [folder('Alpha'), folder('Beta', 'b'), folder('Gamma', 'c')]
  const commands: WorkspaceStorageFolderDeleteInput[] = []
  const deleted = new Set<string>()
  let fail = true
  server.use(emptyWorkspaces,
    http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({ rootPath: '/workspaces',
      items: items.filter((item) => !deleted.has(item.path)), pageInfo: { nextCursor: null } })),
    http.post('/api/management/workspace-storage/folders/delete', async ({ request }) => {
      const input = await request.json() as WorkspaceStorageFolderDeleteInput
      commands.push(input)
      deleted.add(input.path)
      if (input.path === items[1]!.path && fail) { fail = false; return HttpResponse.error() }
      return HttpResponse.json({ value: { path: input.path }, replayed: input.path === items[1]!.path })
    }),
  )
  renderWithRouter(<WorkspaceDirectory />)
  await user.click(await screen.findByRole('checkbox', { name: 'Select folder Alpha' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Select all shown' }))
  await user.click(screen.getByRole('button', { name: 'Delete selected (3)' }))
  await user.click(screen.getByRole('button', { name: 'Delete 3 folders' }))
  const retry = await screen.findByRole('button', { name: 'Retry deletion' })
  const dialog = screen.getByRole('dialog', { name: 'Delete 3 folders?' })
  expect(dialog).toHaveTextContent('1 deleted. 2 remaining selections.')
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Selection options' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Delete selected (2)' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Open actions for folder Gamma' })).toBeDisabled()
  expect(commands.map(({ path }) => path)).toEqual([items[0]!.path, items[1]!.path])
  await user.click(retry)
  await screen.findByText('3 folders deleted.')
  expect(commands.map(({ path }) => path)).toEqual([items[0]!.path, items[1]!.path, items[1]!.path, items[2]!.path])
  expect(commands[2]).toEqual(commands[1])
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

it('keeps definitive failures selected and uses the same selection mode for registered and disk rows', async () => {
  const user = userEvent.setup()
  const alpha = folder('Alpha'), beta = folder('Beta', 'b')
  const archived: unknown[] = []
  let workspaceDeleted = false
  server.use(
    http.get('/api/management/workspaces', () => HttpResponse.json({ items: workspaceDeleted ? [] : [{ workspace: { id: 'registered', name: 'Registered' },
      revision: 7, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }], pageInfo: { nextCursor: null } })),
    http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({ rootPath: '/workspaces', items: [alpha, beta], pageInfo: { nextCursor: null } })),
    http.post('/api/management/workspaces/batch-archive', async ({ request }) => {
      archived.push(await request.json()); workspaceDeleted = true
      return HttpResponse.json({ value: { workspaceIds: ['registered'] }, replayed: false })
    }),
    http.post('/api/management/workspace-storage/folders/delete', () => HttpResponse.json({ error: { code: 'DIRECTORY_CHANGED', message: 'Alpha was replaced. Reload before deleting.' } }, { status: 409 })),
  )
  renderWithRouter(<WorkspaceDirectory />)
  await screen.findByRole('button', { name: 'Open actions for folder Beta' })
  await user.click(screen.getByRole('checkbox', { name: 'Select Registered' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Select all shown' }))
  await user.click(screen.getByRole('button', { name: 'Delete selected (3)' }))
  await user.click(screen.getByRole('button', { name: 'Delete 3 items' }))
  expect(await screen.findByText('Alpha was replaced. Reload before deleting.')).toBeVisible()
  expect(screen.getByRole('dialog')).toHaveTextContent('1 deleted. 2 remaining selections.')
  expect(archived[0]).toMatchObject({ workspaces: [{ workspaceId: 'registered', expectedRevision: 7 }] })
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('checkbox', { name: 'Select folder Alpha' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Select folder Beta' })).toBeChecked()
  expect(screen.queryByRole('checkbox', { name: 'Select Registered' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
  expect(screen.getByRole('button', { name: 'Open actions for folder Alpha' })).toBeEnabled()
})

it('limits mixed select-all to 100 available rows and allows clearing without deletion', async () => {
  const items = Array.from({ length: 101 }, (_, index) => folder(`Folder ${index}`))
  server.use(emptyWorkspaces, http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({ rootPath: '/workspaces', items, pageInfo: { nextCursor: null } })))
  renderWithRouter(<WorkspaceDirectory />)
  const first = await screen.findByRole('checkbox', { name: 'Select folder Folder 0' })
  expect(first).toHaveAttribute('type', 'checkbox')
  await userEvent.setup().click(first)
  expect(first).toBeVisible()
  expect(first).toBeChecked()
  const header = screen.getByRole('heading', { name: 'Workspaces', level: 1 }).closest('header')!
  const controls = within(header)
  fireEvent.click(controls.getByRole('button', { name: 'Selection options' }))
  fireEvent.click(within(screen.getByRole('menu', { name: 'Selection options' }))
    .getByRole('menuitem', { name: 'Select first 100 shown' }))
  expect(controls.getByRole('button', { name: 'Delete selected (100)' })).toBeEnabled()
  const last = screen.getByRole('checkbox', { name: 'Select folder Folder 100' })
  expect(last).toHaveAttribute('type', 'checkbox')
  expect(last).toBeVisible()
  expect(last).toBeDisabled()
  fireEvent.click(controls.getByRole('button', { name: 'Selection options' }))
  fireEvent.click(within(screen.getByRole('menu', { name: 'Selection options' }))
    .getByRole('menuitem', { name: 'Clear selection' }))
  expect(screen.queryByText(/Delete selected/)).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: /^Open actions for folder Folder / })).toHaveLength(101)
}, 30_000)

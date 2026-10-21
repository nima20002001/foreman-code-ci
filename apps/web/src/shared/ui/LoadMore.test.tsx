import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { useWorkflowPages, useWorkspacePages, useWorkspaceStorageFolderPages } from '../api/query'
import { beginSessionChange, finishSessionChange } from '../api/sessionBoundary'
import { LoadMore } from './LoadMore'

type Catalog = 'workspaces' | 'workflows' | 'folders'
const paths: Record<Catalog, string> = {
  workspaces: '/api/management/workspaces',
  workflows: '/api/management/workspaces/workspace-1/workflows',
  folders: '/api/management/workspace-storage/folders',
}
function record(catalog: Catalog, index: number) {
  const name = `Item ${String(index).padStart(2, '0')}`, id = `item-${index}`
  if (catalog === 'workspaces') return { workspace: { id, name }, revision: 1, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'restricted' } }
  if (catalog === 'folders') return { name, path: `/workspaces/${name}`, identity: `sha256:${'a'.repeat(64)}`, deletion: { status: 'available' } }
  return { workflow: { id, name, workspaceId: 'workspace-1', executionSemanticsVersion: 3,
    entryNodeId: null, executionCondition: { kind: 'manual' }, nodes: [], edges: [] },
  revision: 1, archivedAt: null, currentVersionId: null }
}
function pages(catalog: Catalog, total: number, cursors: (string | null)[]) {
  return http.get(paths[catalog], ({ request }) => {
    const url = new URL(request.url), cursor = url.searchParams.get('cursor')
    cursors.push(cursor)
    const start = Number(cursor ?? 0), limit = Number(url.searchParams.get('limit'))
    expect(limit).toBe(cursor ? 10 : 5)
    const end = Math.min(total, start + limit)
    return HttpResponse.json({ ...(catalog === 'folders' ? { rootPath: '/workspaces' } : {}),
      items: Array.from({ length: end - start }, (_, index) => record(catalog, start + index)),
      pageInfo: { nextCursor: end < total ? String(end) : null } })
  })
}
function CatalogList({ catalog, directory = true }: { catalog: Catalog; directory?: boolean }) {
  const view = directory ? 'directory' : 'navigation'
  const workspaces = useWorkspacePages(catalog === 'workspaces', view)
  const workflows = useWorkflowPages('workspace-1', catalog === 'workflows', view)
  const folders = useWorkspaceStorageFolderPages(catalog === 'folders')
  const query = catalog === 'workspaces' ? workspaces : catalog === 'workflows' ? workflows : folders
  const names: string[] = []
  for (const page of query.data?.pages ?? []) for (const item of page.items) {
    names.push('workspace' in item ? item.workspace.name : 'workflow' in item ? item.workflow.name : item.name)
  }
  return <section aria-label={directory ? 'Directory' : 'Sidebar'}>
    <ul>{names.map((name) => <li key={name}>{name}</li>)}</ul>
    <LoadMore label={catalog} loadAll={directory} query={query} />
  </section>
}

it.each<Catalog>(['workspaces', 'workflows', 'folders'])('one directory click exhausts every %s cursor and retains the initial page beyond five pages', async (catalog) => {
  const cursors: (string | null)[] = []
  server.use(pages(catalog, 65, cursors))
  const user = userEvent.setup()
  renderWithRouter(<CatalogList catalog={catalog} />)
  await screen.findByText('Item 00')
  expect(screen.getAllByRole('listitem')).toHaveLength(5)
  expect(screen.getByRole('button', { name: `Show more ${catalog}` })).toHaveTextContent(/^Show more$/)
  await user.click(screen.getByRole('button', { name: `Show more ${catalog}` }))
  await screen.findByText('Item 64')
  expect(screen.getByText('Item 00')).toBeVisible()
  expect(screen.getAllByRole('listitem')).toHaveLength(65)
  expect(cursors).toEqual([null, '5', '15', '25', '35', '45', '55'])
  expect(screen.queryByRole('button', { name: `Show more ${catalog}` })).not.toBeInTheDocument()
})

it.each<Catalog>(['workspaces', 'workflows'])('directory load-all leaves the %s sidebar independently incremental', async (catalog) => {
  const cursors: (string | null)[] = []
  server.use(pages(catalog, 65, cursors))
  const user = userEvent.setup()
  renderWithRouter(<><CatalogList catalog={catalog} /><CatalogList catalog={catalog} directory={false} /></>)
  const directory = within(await screen.findByRole('region', { name: 'Directory' }))
  const sidebar = within(screen.getByRole('region', { name: 'Sidebar' }))
  await directory.findByText('Item 00')
  await sidebar.findByText('Item 00')
  expect(sidebar.getByRole('button', { name: `Show more ${catalog}` })).toHaveTextContent(`Show more ${catalog}`)
  await user.click(directory.getByRole('button', { name: `Show more ${catalog}` }))
  await directory.findByText('Item 64')
  expect(sidebar.getAllByRole('listitem')).toHaveLength(5)
  await user.click(sidebar.getByRole('button', { name: `Show more ${catalog}` }))
  await sidebar.findByText('Item 14')
  expect(sidebar.getAllByRole('listitem')).toHaveLength(15)
  expect(sidebar.queryByText('Item 15')).not.toBeInTheDocument()
  expect(sidebar.getByRole('button', { name: `Show more ${catalog}` })).toBeEnabled()
})

it('stops an all-page request after a later failure and resumes at the failed cursor without losing loaded rows', async () => {
  const cursors: (string | null)[] = []
  let fail = true
  server.use(http.get(paths.workflows, ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor')
    cursors.push(cursor)
    if (cursor === '15' && fail) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })
    const start = Number(cursor ?? 0), end = Math.min(35, start + (cursor ? 10 : 5))
    return HttpResponse.json({ items: Array.from({ length: end - start }, (_, i) => record('workflows', start + i)),
      pageInfo: { nextCursor: end < 35 ? String(end) : null } })
  }))
  const user = userEvent.setup()
  renderWithRouter(<CatalogList catalog="workflows" />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load more workflows')
  expect(screen.getAllByRole('listitem')).toHaveLength(15)
  expect(screen.getByText('Item 00')).toBeVisible()
  expect(cursors).toEqual([null, '5', '15'])
  fail = false
  await user.click(screen.getByRole('button', { name: 'Retry loading workflows' }))
  await screen.findByText('Item 34')
  expect(screen.getAllByRole('listitem')).toHaveLength(35)
  expect(cursors).toEqual([null, '5', '15', '15', '25'])
})

it.each(['navigation', 'session'])('does not keep fetching remaining cursors after %s changes', async (change) => {
  let resolve!: (result: { hasNextPage: boolean; isError: boolean }) => void
  const fetchNextPage = vi.fn(() => new Promise<{ hasNextPage: boolean; isError: boolean }>((done) => { resolve = done }))
  const user = userEvent.setup()
  const rendered = renderWithRouter(<LoadMore loadAll label="workflows" query={{ hasNextPage: true,
    isFetching: false, isFetchNextPageError: false, fetchNextPage }} />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(1))
  try {
    if (change === 'navigation') rendered.unmount()
    else beginSessionChange()
    await act(async () => resolve({ hasNextPage: true, isError: false }))
    expect(fetchNextPage).toHaveBeenCalledTimes(1)
  } finally {
    if (change === 'session') finishSessionChange()
  }
})

it('starts only one all-page request when the button is activated twice before a response', async () => {
  let resolve!: (result: { hasNextPage: boolean; isError: boolean }) => void
  const fetchNextPage = vi.fn(() => new Promise<{ hasNextPage: boolean; isError: boolean }>((done) => { resolve = done }))
  renderWithRouter(<LoadMore loadAll label="workflows" query={{ hasNextPage: true,
    isFetching: false, isFetchNextPageError: false, fetchNextPage }} />)
  const button = await screen.findByRole('button', { name: 'Show more workflows' })
  fireEvent.click(button)
  fireEvent.click(button)
  await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(1))
  await act(async () => resolve({ hasNextPage: false, isError: false }))
  expect(fetchNextPage).toHaveBeenCalledTimes(1)
})

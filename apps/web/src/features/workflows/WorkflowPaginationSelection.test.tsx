import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ManagedWorkflow } from '@foreman-code/contracts/management'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkflowDirectory } from './WorkflowDirectory'
import { WorkflowNavigation } from './WorkflowNavigation'

const workflow = (id: string): ManagedWorkflow => ({ workflow: {
  id, workspaceId: 'workspace-1', name: id, executionSemanticsVersion: 3, entryNodeId: null, executionCondition: { kind: 'manual' }, nodes: [], edges: [],
}, revision: 1, archivedAt: null, currentVersionId: null })

it('loads pages only on request, retains selection across pages, and sends one batch with safe retry', async () => {
  const cursors: (string | null)[] = [], bodies: unknown[] = []
  let deleted = false, fail = true
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', ({ request }) => {
      const url = new URL(request.url), cursor = url.searchParams.get('cursor')
      expect(url.searchParams.get('limit')).toBe(cursor ? '10' : '5')
      cursors.push(cursor)
      return HttpResponse.json({ items: deleted ? [] : [workflow(cursor ? 'Beta' : 'Alpha')], pageInfo: { nextCursor: cursor || deleted ? null : 'Alpha' } })
    }),
    http.post('/api/management/workspaces/workspace-1/workflows/batch-archive', async ({ request }) => {
      bodies.push(await request.json())
      if (fail) { fail = false; return HttpResponse.error() }
      deleted = true
      return HttpResponse.json({ value: { workflowIds: ['Alpha', 'Beta'] }, replayed: true })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)
  await screen.findByRole('link', { name: 'Alpha' })
  expect(cursors).toEqual([null])
  await user.click(screen.getByRole('button', { name: 'Select workflows' }))
  const alpha = screen.getByRole('checkbox', { name: 'Select Alpha' })
  alpha.focus(); await user.keyboard(' ')
  expect(alpha).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Show more workflows' }))
  await user.click(await screen.findByRole('checkbox', { name: 'Select Beta' }))
  expect(alpha).toBeChecked()
  expect(cursors).toEqual([null, 'Alpha'])
  expect(screen.queryByRole('button', { name: 'Show more workflows' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Delete selected (2)' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete 2 workflows?' })
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  await user.click(within(dialog).getByRole('button', { name: 'Delete 2 workflows' }))
  await user.click(await screen.findByRole('button', { name: 'Retry deletion' }))
  await screen.findByText('2 workflows deleted.')
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(bodies[0]).toMatchObject({ workspaceId: 'workspace-1', workflows: [
    { workflowId: 'Alpha', expectedRevision: 1 }, { workflowId: 'Beta', expectedRevision: 1 },
  ] })
  await waitFor(() => expect(screen.queryByTestId('workflow-card-Alpha')).not.toBeInTheDocument())
})

it('keeps cards on a load-more error and lets the sidebar retry the same cursor', async () => {
  let fail = true
  server.use(http.get('/api/management/workspaces/workspace-1/workflows', ({ request }) => {
    if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json({ items: [workflow('Alpha')], pageInfo: { nextCursor: 'Alpha' } })
    if (fail) return HttpResponse.json({ code: 'UNAVAILABLE', message: 'Unavailable' }, { status: 503 })
    return HttpResponse.json({ items: [workflow('Beta')], pageInfo: { nextCursor: null } })
  }))
  const user = userEvent.setup()
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  expect(await screen.findByRole('button', { name: 'Retry loading workflows' })).toBeEnabled()
  expect(screen.getByRole('button', { name: /^Alpha/ })).toBeVisible()
  fail = false
  await user.click(screen.getByRole('button', { name: 'Retry loading workflows' }))
  expect(await screen.findByRole('button', { name: /^Beta/ })).toBeVisible()
})

it('shows each durable workflow once when consecutive directory pages overlap', async () => {
  server.use(http.get('/api/management/workspaces/workspace-1/workflows', ({ request }) => HttpResponse.json({
    items: new URL(request.url).searchParams.has('cursor') ? [workflow('Alpha'), workflow('Beta')] : [workflow('Alpha')],
    pageInfo: { nextCursor: new URL(request.url).searchParams.has('cursor') ? null : 'Alpha' },
  })))
  const user = userEvent.setup()
  renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Show more workflows' }))
  await screen.findByTestId('workflow-card-Beta')
  expect(screen.getAllByTestId('workflow-card-Alpha')).toHaveLength(1)
  expect(within(screen.getByTestId('workflow-card-list')).getAllByRole('listitem')).toHaveLength(2)
})

it('keeps confirmed batch deletion and prefix invalidation consistent across directory and sidebar caches', async () => {
  let deleted = false
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => HttpResponse.json({
      items: deleted ? [workflow('Beta')] : [workflow('Alpha'), workflow('Beta')], pageInfo: { nextCursor: null },
    })),
    http.post('/api/management/workspaces/workspace-1/workflows/batch-archive', () => {
      deleted = true
      return HttpResponse.json({ value: { workflowIds: ['Alpha'] }, replayed: false })
    }),
  )
  const user = userEvent.setup()
  const { queryClient } = renderWithRouter(<><section aria-label="Directory"><WorkflowDirectory workspaceId="workspace-1" /></section>
    <section aria-label="Sidebar"><WorkflowNavigation workspaceId="workspace-1" /></section></>)
  const directory = within(await screen.findByRole('region', { name: 'Directory' }))
  const sidebar = within(screen.getByRole('region', { name: 'Sidebar' }))
  await directory.findByRole('link', { name: 'Alpha' })
  await sidebar.findByRole('button', { name: /^Alpha/ })
  await user.click(directory.getByRole('button', { name: 'Select workflows' }))
  await user.click(directory.getByRole('checkbox', { name: 'Select Alpha' }))
  await user.click(directory.getByRole('button', { name: 'Delete selected (1)' }))
  await user.click(screen.getByRole('button', { name: 'Delete 1 workflow' }))
  await directory.findByText('1 workflow deleted.')
  await waitFor(() => expect(sidebar.queryByRole('button', { name: /^Alpha/ })).not.toBeInTheDocument())
  for (const suffix of [[], ['directory']]) {
    const cached = queryClient.getQueryData<{ pages: { items: ManagedWorkflow[] }[] }>([
      'workbench', 'management', 'workspace', 'workspace-1', 'workflows', 'pages', ...suffix,
    ])
    expect(cached?.pages.flatMap((page) => page.items).map((item) => item.workflow.id)).toEqual(['Beta'])
  }
})

it('cancels selection without deleting and reports a definitive batch rejection', async () => {
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => HttpResponse.json({ items: [workflow('Alpha')], pageInfo: { nextCursor: null } })),
    http.post('/api/management/workspaces/workspace-1/workflows/batch-archive', () => HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'A selected workflow changed. Nothing was deleted.' } }, { status: 409 })),
  )
  const user = userEvent.setup()
  renderWithRouter(<WorkflowDirectory workspaceId="workspace-1" />)
  await user.click(await screen.findByRole('button', { name: 'Select workflows' }))
  expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }))
  await user.click(screen.getByRole('button', { name: 'Delete selected (1)' }))
  await user.click(screen.getByRole('button', { name: 'Delete 1 workflow' }))
  expect(await screen.findByText('A selected workflow changed. Nothing was deleted.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await user.click(screen.getByRole('button', { name: 'Selection options' }))
  await user.click(screen.getByRole('menuitem', { name: 'Cancel selection' }))
  expect(screen.getByRole('link', { name: 'Alpha' })).toBeVisible()
})


it('keeps a deep-linked active workflow visible without fetching intervening pages', async () => {
  let pages = 0, details = 0
  server.use(
    http.get('/api/management/workspaces/workspace-1/workflows', () => {
      pages += 1
      return HttpResponse.json({ items: ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map(workflow), pageInfo: { nextCursor: 'Alpha' } })
    }),
    http.get('/api/management/workspaces/workspace-1/workflows/Zeta', () => {
      details += 1
      return HttpResponse.json(workflow('Zeta'))
    }),
  )
  renderWithRouter(<WorkflowNavigation workspaceId="workspace-1" activeWorkflowId="Zeta" />)
  expect(await screen.findByRole('button', { name: /^Zeta/ })).toHaveAttribute('aria-current', 'page')
  expect(await screen.findByRole('button', { name: /^Alpha/ })).toBeVisible()
  expect(screen.getAllByRole('button').filter(button => button.classList.contains('workflow-navigation-item'))).toHaveLength(6)
  expect(screen.queryByText('Selected workflow')).not.toBeInTheDocument()
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) {
    expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  }
  expect(pages).toBe(1); expect(details).toBe(1)
  expect(screen.getByRole('button', { name: 'Show more workflows' })).toBeVisible()
})

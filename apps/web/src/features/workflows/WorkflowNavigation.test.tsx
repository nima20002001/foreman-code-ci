import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UrlSearchSelectionSchema } from '@foreman-code/contracts'
import { http, HttpResponse } from 'msw'

import { server } from '../../mocks/server'
import { setMockScenario } from '../../shared/mocks/scenarios'
import { WorkflowNavigation } from './WorkflowNavigation'

function renderNavigation(activeWorkflowId?: string, workspaceId = 'workspace-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <WorkflowNavigation workspaceId={workspaceId} activeWorkflowId={activeWorkflowId} />
        <Outlet />
      </>
    ),
  })
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workspaces/$workspaceId',
    validateSearch: UrlSearchSelectionSchema,
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspaceRoute]),
    history: createMemoryHistory({ initialEntries: [`/workspaces/${workspaceId}`] }),
  })

  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

afterEach(() => {
  setMockScenario('normal')
})

// jsdom does not implement the native modal dialog methods used by Nocturne Dialog.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  }
})

describe('WorkflowNavigation', () => {
  it('lists the workspace workflows and marks the URL-selected workflow', async () => {
    renderNavigation('workflow-content-pipeline')

    const link = await screen.findByRole('button', { name: 'Research to review' })
    expect(screen.getByRole('region', { name: 'Workspace workflows' })).toBeVisible()
    expect(link).toHaveAttribute('aria-current', 'page')
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(link, { ctrlKey: true })
    expect(open).toHaveBeenCalledWith(
      '/workspaces/workspace-1?workflowId=workflow-content-pipeline',
      '_blank',
      'noopener',
    )
    open.mockRestore()
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('does not mark a workflow active without a URL selection', async () => {
    renderNavigation()

    const link = await screen.findByRole('button', { name: 'Research to review' })
    expect(link).not.toHaveAttribute('aria-current')
  })

  it('selects a workflow through the URL', async () => {
    const user = userEvent.setup()
    const { router } = renderNavigation()

    await user.click(await screen.findByRole('button', { name: 'Research to review' }))

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ workflowId: 'workflow-content-pipeline' }),
    )
  })

  it('offers direct removal without a separate actions menu', async () => {
    renderNavigation('workflow-content-pipeline')

    expect(await screen.findByRole('button', { name: 'Research to review' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Open actions for/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Research to review' })).toBeEnabled()
  })

  it('clears an agent selection when workflow identity changes', async () => {
    const user = userEvent.setup()
    const { router } = renderNavigation()
    await router.navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: 'workspace-1' },
      search: { agentId: 'agent-researcher' },
    })

    await user.click(await screen.findByRole('button', { name: 'Research to review' }))

    await waitFor(() => {
      expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
      expect(router.state.location.search.agentId).toBeUndefined()
    })
  })

  it('keeps New workflow visible when the workspace has no workflows', async () => {
    setMockScenario('empty')
    renderNavigation()

    expect(await screen.findByTestId('workflow-navigation-empty')).toHaveTextContent('No workflows yet')
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('keeps New workflow visible when workflows cannot be loaded', async () => {
    setMockScenario('error')
    renderNavigation()

    expect(await screen.findByTestId('workflow-navigation-error')).toHaveTextContent('Workflows unavailable')
    expect(screen.getByRole('button', { name: 'New workflow' })).toBeVisible()
  })

  it('opens a compact creation dialog and creates a durable workflow', async () => {
    const user = userEvent.setup()
    renderNavigation()
    const trigger = await screen.findByRole('button', { name: 'New workflow' })

    await user.click(trigger)

    const dialog = await screen.findByRole('dialog', { name: 'New workflow' })
    expect(dialog).not.toHaveTextContent('This empty workflow is stored by the workspace backend.')
    expect(screen.getByRole('button', { name: 'Create workflow' })).toBeEnabled()

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const draftLink = screen.getByRole('button', { name: /^Draft workflow/ })
    expect(draftLink).toBeVisible()
    expect(draftLink).not.toHaveTextContent('Session')
  })

  it('retries opening an accepted workflow without repeating Create when workspace details were unavailable', async () => {
    server.use(http.get('/api/workspaces/workspace-1', () => HttpResponse.json({
      error: { code: 'TEMPORARY', message: 'Workspace unavailable.' },
    }, { status: 503 })))
    const user = userEvent.setup()
    const { router } = renderNavigation('workflow-content-pipeline')
    await screen.findByRole('button', { name: 'Research to review' })

    await user.click(screen.getByRole('button', { name: 'New workflow' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Draft workflow')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    expect(await screen.findByText('Workflow created, but its graph could not be opened. Retry opening it.')).toHaveAttribute('role', 'alert')
    expect(router.state.location.search.workflowId).toBeUndefined()
    expect(screen.queryByRole('button', { name: 'Create workflow' })).not.toBeInTheDocument()
    const newLink = await screen.findByRole('button', { name: /^Draft workflow/ })
    expect(newLink).toBeVisible()

    server.resetHandlers()
    await user.click(screen.getByRole('button', { name: 'Open workflow' }))
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    fireEvent.click(newLink, { ctrlKey: true })
    const createdId = new URL(open.mock.calls[0]![0] as string, 'http://localhost').searchParams.get('workflowId')
    open.mockRestore()
    await waitFor(() => expect(router.state.location.search.workflowId).toBe(createdId))
    expect(screen.getAllByRole('button', { name: /^Draft workflow/ })).toHaveLength(1)
  })

  it('keeps inside presses open and dismisses the creation dialog from its backdrop', async () => {
    const user = userEvent.setup()
    renderNavigation()
    const trigger = await screen.findByRole('button', { name: 'New workflow' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'New workflow' })

    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.pointerDown(name)
    fireEvent.click(name)
    expect(screen.getByRole('dialog', { name: 'New workflow' })).toBeVisible()

    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})


it('marks an unpublished workflow and removes it in one click without another dialog', async () => {
  const user = userEvent.setup()
  const { router } = renderNavigation()
  await user.click(await screen.findByRole('button', { name: 'New workflow' }))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Temporary draft')
  await user.click(screen.getByRole('button', { name: 'Create workflow' }))
  expect(await screen.findByRole('button', { name: /^Temporary draft/ })).toBeVisible()
  screen.getByRole('button', { name: 'Remove Temporary draft' }).focus()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Temporary draft/ })).not.toBeInTheDocument())
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(router.state.location.search.workflowId).toBeUndefined()
})

it.each([500, 503, 'restart'] as const)('keeps an HTTP %s removal failure visible and retries the same command', async (failure) => {
  const message = failure === 'restart' ? 'Updating — reconnecting…' : 'Could not remove workflow.'
  const requests: unknown[] = []
  server.use(http.delete('/api/management/workspaces/workspace-1/workflows/workflow-content-pipeline', async ({ request }) => {
    requests.push(await request.json())
    return failure === 'restart' ? new HttpResponse(null, { status: 503 })
      : HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Could not remove workflow.' } }, { status: failure })
  }))
  const user = userEvent.setup()
  renderNavigation()
  const remove = await screen.findByRole('button', { name: 'Remove Research to review' })
  remove.focus()
  await user.keyboard('{Enter}')
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('button', { name: 'Research to review' })).toBeVisible()
  screen.getByRole('button', { name: 'Retry removing Research to review' }).focus()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toEqual(requests[0])
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

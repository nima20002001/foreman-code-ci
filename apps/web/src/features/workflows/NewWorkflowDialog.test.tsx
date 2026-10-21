import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { server } from '../../mocks/server'
import { apiClient } from '../../shared/api/client'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { renderWithRouter } from '../../test/renderWithRouter'
import { NewWorkflowDialog } from './NewWorkflowDialog'

function renderCreation(workspaceId: string) {
  const onCreated = vi.fn()
  renderWithRouter(<NewWorkflowDialog workspaceId={workspaceId} onCreated={onCreated} onCancel={vi.fn()} />)
  return onCreated
}

describe('NewWorkflowDialog default name', () => {
  it.each(['', '   '])('creates with the displayed default when the name is %j', async (name) => {
    const fixture = createCurrentBoardMock()
    server.use(...fixture.handlers)
    const user = userEvent.setup()
    const onCreated = renderCreation(fixture.workspaceId)
    const input = await screen.findByRole('textbox', { name: 'Name' })

    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', 'Untitled workflow')
    expect(input).not.toBeRequired()
    if (name) await user.type(input, name)
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(fixture.workflows.get(onCreated.mock.calls[0]![0])?.approval).toEqual({ handler: 'native' })
    const details = await apiClient.getWorkspaceDetails({ workspaceId: fixture.workspaceId })
    expect(details.workflows).toEqual([
      expect.objectContaining({ id: onCreated.mock.calls[0]![0], name: 'Untitled workflow' }),
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows and uses an available suffix after reading every page of workspace workflows', async () => {
    const fixture = createCurrentBoardMock()
    server.use(...fixture.handlers)
    for (const name of ['Untitled workflow', 'Untitled workflow (1)', 'Untitled workflow (3)']) {
      await apiClient.createManagedWorkflow({ workspaceId: fixture.workspaceId, name, commandId: crypto.randomUUID() })
    }
    const existing = await apiClient.listManagedWorkflows(fixture.workspaceId)
    expect(existing.items.map((item) => item.workflow.name).sort()).toEqual([
      'Untitled workflow', 'Untitled workflow (1)', 'Untitled workflow (3)',
    ])
    const cursors: Array<string | null> = []
    server.use(http.get(`/api/management/workspaces/${fixture.workspaceId}/workflows`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      return HttpResponse.json(cursor === null
        ? { items: existing.items.slice(0, 1), pageInfo: { nextCursor: 'second-page' } }
        : { items: existing.items.slice(1), pageInfo: { nextCursor: null } })
    }))
    const user = userEvent.setup()
    const onCreated = renderCreation(fixture.workspaceId)
    const input = await screen.findByRole('textbox', { name: 'Name' })

    await waitFor(() => expect(input).toHaveAttribute('placeholder', 'Untitled workflow (2)'))
    expect(input).toHaveValue('')
    expect(cursors).toEqual([null, 'second-page'])
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const details = await apiClient.getWorkspaceDetails({ workspaceId: fixture.workspaceId })
    expect(details.workflows).toHaveLength(4)
    expect(details.workflows.find((workflow) => workflow.id === onCreated.mock.calls[0]![0])?.name)
      .toBe('Untitled workflow (2)')
  })

  it('uses the trimmed custom name instead of the placeholder', async () => {
    const fixture = createCurrentBoardMock()
    server.use(...fixture.handlers)
    const user = userEvent.setup()
    const onCreated = renderCreation(fixture.workspaceId)

    await user.type(await screen.findByRole('textbox', { name: 'Name' }), '  Release checklist  ')
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    const details = await apiClient.getWorkspaceDetails({ workspaceId: fixture.workspaceId })
    expect(details.workflows).toEqual([expect.objectContaining({ name: 'Release checklist' })])
  })

  it('retries the same default name and command after a lost creation response', async () => {
    const fixture = createCurrentBoardMock()
    server.use(...fixture.handlers)
    const requests: unknown[] = []
    server.use(http.post(`/api/management/workspaces/${fixture.workspaceId}/workflows`, async ({ request }) => {
      requests.push(await request.clone().json())
      const response = await fixture.dispatch(request)
      return requests.length === 1 ? HttpResponse.error() : response
    }))
    const user = userEvent.setup()
    const onCreated = renderCreation(fixture.workspaceId)
    await screen.findByRole('textbox', { name: 'Name' })

    await user.click(screen.getByRole('button', { name: 'Create workflow' }))
    await screen.findByText(/The previous request may have succeeded/)
    await user.click(screen.getByRole('button', { name: 'Create workflow' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ name: 'Untitled workflow', commandId: expect.any(String) })
    expect(requests[1]).toEqual(requests[0])
    const details = await apiClient.getWorkspaceDetails({ workspaceId: fixture.workspaceId })
    expect(details.workflows).toEqual([expect.objectContaining({ name: 'Untitled workflow' })])
  })
})

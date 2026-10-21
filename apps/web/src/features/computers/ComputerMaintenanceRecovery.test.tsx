import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ComputerMaintenanceStartInput } from '@foreman-code/contracts/computer-maintenance'
import { ComputerCards } from './ComputerCards'
import { computersFixture, mainId } from './computersTestFixture'

it.each(['sync-mcp', 'sync-plugins'] as const)(
  'reconciles only the unresolved %s sibling with its original identity after the first work completes', async uncertain => {
    const requests: ComputerMaintenanceStartInput[] = []
    const effects = new Set<string>()
    computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
      http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
        const input = await request.json() as ComputerMaintenanceStartInput
        requests.push(input)
        effects.add(input.commandId)
        if (input.task.kind === uncertain && requests.filter(value => value.task.kind === uncertain).length === 1) {
          return HttpResponse.error()
        }
        return HttpResponse.json({ computers: [] })
      }),
    ])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Sync MCP servers and plugins' }))
    await screen.findByRole('button', { name: 'Retry original maintenance request' })
    expect(requests).toHaveLength(2)
    expect(effects.size).toBe(2)
    expect(screen.getByRole('button', { name: 'Update computers' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry original maintenance request' }))
    await waitFor(() => expect(requests).toHaveLength(3))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original maintenance request' }))
      .not.toBeInTheDocument())
    expect(requests[2]).toEqual(requests.find(value => value.task.kind === uncertain))
    expect(effects.size).toBe(2)
    expect(requests.filter(value => value.task.kind !== uncertain)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Update computers' })).toBeEnabled()
  },
)

it('reuses the original maintenance command after response loss and a later permission denial', async () => {
  const requests: ComputerMaintenanceStartInput[] = []
  computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      const input = await request.json() as ComputerMaintenanceStartInput
      requests.push(input)
      if (input.task.kind === 'sync-plugins') return HttpResponse.json({ computers: [] })
      const count = requests.filter(value => value.task.kind === 'sync-mcp').length
      if (count === 1) return HttpResponse.error()
      if (count === 2) {
        return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Readback denied.' } }, { status: 403 })
      }
      return HttpResponse.json({ computers: [] })
    }),
  ])
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Sync MCP servers and plugins' }))
  await screen.findByRole('button', { name: 'Retry original maintenance request' })
  await user.click(screen.getByRole('button', { name: 'Retry original maintenance request' }))
  await screen.findByText('Readback denied.')
  expect(screen.getByRole('button', { name: 'Retry original maintenance request' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Update computers' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Retry original maintenance request' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original maintenance request' }))
    .not.toBeInTheDocument())
  expect(requests[2]).toEqual(requests[0])
  expect(requests[3]).toEqual(requests[0])
})

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { ScheduleSaveInputSchema, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { ScheduleClockButton } from './ScheduleClockButton'
import { schedulePath } from './client'

const scope = { workspaceId: 'refresh-workspace', workflowId: 'refresh-workflow' }
const clients: QueryClient[] = []
const initial: WorkflowSchedule = {
  ...scope, mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true,
  policy: 'latest_saved', revision: 3, nextOccurrenceAt: '2099-08-24T09:00:00.000Z',
}

function mount() {
  let persisted = initial
  let reads = 0
  server.use(
    http.get(schedulePath(scope), () => {
      reads++
      return HttpResponse.json({ schedule: persisted })
    }),
    http.get(`${schedulePath(scope)}/occurrences`, () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ScheduleClockButton {...scope} isSaved /></QueryClientProvider>)
  return {
    user: userEvent.setup(),
    reads: () => reads,
    advance: (value: WorkflowSchedule) => { persisted = value },
  }
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
  await screen.findByRole('switch', { name: 'Enabled' })
}

async function poll() {
  await act(async () => { vi.advanceTimersByTime(5_001) })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
})

describe('open schedule readback refresh', () => {
  it.each([false, true])('refreshes Next while preserving the initialized draft (edited: %s)', async (edited) => {
    const view = mount()
    await open(view.user)
    const time = screen.getByLabelText('Time') as HTMLInputElement
    const draftTime = edited ? '10:15' : time.value
    if (edited) fireEvent.change(time, { target: { value: draftTime } })
    const nextOccurrenceAt = '2099-08-31T09:00:00.000Z'
    view.advance({ ...initial, nextOccurrenceAt, revision: 4, time: '22:00' })

    await poll()
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('.schedule-next time'))
      .toHaveAttribute('datetime', nextOccurrenceAt))
    expect(time).toHaveValue(draftTime)
    if (!edited) return

    server.use(http.put(schedulePath(scope), async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...await request.json() as object })
      expect(input.expectedRevision).toBe(3)
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed.' } }, { status: 409 })
    }))
    await view.user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByText('Schedule changed.')).toBeVisible()
    expect(time).toHaveValue(draftTime)
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
  })

  it('does not poll before opening or after closing the modal', async () => {
    const view = mount()
    await poll()
    expect(view.reads()).toBe(0)
    await open(view.user)
    await poll()
    await waitFor(() => expect(view.reads()).toBeGreaterThan(1))
    await view.user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const closedReads = view.reads()
    await poll()
    expect(view.reads()).toBe(closedReads)
  })

  it('keeps unsaved edits when a background read fails', async () => {
    const view = mount()
    await open(view.user)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
    server.use(http.get(schedulePath(scope), () => HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Unavailable.' },
    }, { status: 503 })))
    await poll()
    expect(await screen.findByText('Next unavailable')).toBeVisible()
    expect(screen.getByLabelText('Time')).toHaveValue('10:15')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled()
  })
})

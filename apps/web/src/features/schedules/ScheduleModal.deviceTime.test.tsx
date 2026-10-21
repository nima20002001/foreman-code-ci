import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { nextOccurrences, ScheduleSaveInputSchema, type ScheduleSaveInput, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { mockDeviceTimezone } from '../../test/deviceTimezone'
import { ScheduleClockButton } from './ScheduleClockButton'
import { schedulePath } from './client'

const scope = { workspaceId: 'device-modal-workspace', workflowId: 'device-modal-workflow' }
const clients: QueryClient[] = []
function mount(value: WorkflowSchedule | null) {
  let persisted = value
  const saves: ScheduleSaveInput[] = []
  server.use(
    http.get(schedulePath(scope), () => HttpResponse.json({ schedule: persisted })),
    http.get(`${schedulePath(scope)}/occurrences`, () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
    http.put(schedulePath(scope), async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...await request.json() as object })
      saves.push(input)
      persisted = { ...input.schedule, ...scope, revision: (persisted?.revision ?? 0) + 1,
        nextOccurrenceAt: nextOccurrences(input.schedule, new Date().toISOString(), 1)[0] ?? null }
      return HttpResponse.json({ value: persisted, replayed: false })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ScheduleClockButton {...scope} isSaved /></QueryClientProvider>)
  return { user: userEvent.setup(), saves }
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
  await screen.findByRole('switch', { name: 'Enabled' })
}
afterEach(() => { clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals() })

describe('device-local Schedule modal', () => {
  it.each([
    ['Asia/Tokyo', '2099-08-25', '00:30'],
    ['America/Los_Angeles', '2099-08-24', '08:30'],
  ])('shows Once and the persisted Next instant in %s without a timezone selector', async (zone, date, time) => {
    mockDeviceTimezone(zone)
    const next = '2099-08-24T15:30:00.000Z'
    const { user, saves } = mount({ ...scope, mode: 'once', localDate: '2099-08-24', time: '15:30', timezone: 'UTC', enabled: true,
      policy: 'latest_saved', revision: 1, nextOccurrenceAt: next })
    await open(user)
    expect(screen.queryByRole('combobox', { name: 'Timezone' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveValue(date)
    expect(screen.getByLabelText('Time')).toHaveValue(time)
    const nextElement = screen.getByRole('dialog').querySelector('time')!
    expect(nextElement).toHaveAttribute('datetime', next)
    expect(nextElement.textContent).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(next)))
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.schedule).toMatchObject({ localDate: '2099-08-24', time: '15:30', timezone: 'UTC' })
  })
  it('discloses foreign weekly calendar intent and the device-calendar consequence of edits', async () => {
    mockDeviceTimezone('Asia/Tokyo')
    const { user, saves } = mount({ ...scope, mode: 'weekly', weekdays: [1], time: '23:30', timezone: 'America/New_York', enabled: true,
      policy: 'latest_saved', revision: 1, nextOccurrenceAt: '2099-08-25T03:30:00.000Z' })
    await open(user)
    expect(screen.getByText(/Saved: Mo at 23:30 \(America\/New_York\)/)).toBeVisible()
    expect(screen.getByLabelText('Time')).toHaveValue('12:30')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '13:15' } })
    expect(screen.getByText(/Changes use this device \(Asia\/Tokyo\)/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.schedule).toMatchObject({ timezone: 'Asia/Tokyo', weekdays: [2], time: '13:15' })
  })
  it('saves a one-second interval and reads back a Next time with seconds', async () => {
    const { user, saves } = mount(null)
    await open(user)
    await user.click(screen.getByRole('tab', { name: 'Interval' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), 'second')
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every' }), { target: { value: '1' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.schedule).toMatchObject({ mode: 'interval', every: 1, unit: 'second' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await open(user)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveValue('second')
    const nextElement = screen.getByRole('dialog').querySelector('time')!
    const next = nextElement.getAttribute('datetime')!
    expect(nextElement.textContent).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(next)))
  })
})

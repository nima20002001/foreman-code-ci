import { StrictMode, type ReactNode } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  ScheduleDisableInputSchema, ScheduleSaveInputSchema, WorkflowScheduleSchema,
  type ScheduleDisableInput, type ScheduleGetResult, type ScheduleSaveInput, type ScheduleSaveResult, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { mockDeviceTimezone } from '../../test/deviceTimezone'
import { UnsavedChangesContext } from '../../shared/ui/unsavedChanges'
import { ScheduleClockButton } from './ScheduleClockButton'
import { schedulePath } from './client'
import { scheduleKeys, useScheduleCommand } from './queries'
import { deferred } from '../../test/deferred'

const scope = { workspaceId: 'workspace-schedule', workflowId: 'workflow-schedule' }
const path = schedulePath(scope)
const next = '2099-08-24T09:00:00.000Z'
const weekly: WorkflowSchedule = {
  ...scope, mode: 'weekly', weekdays: [1, 3], time: '09:00', timezone: 'UTC', enabled: true,
  policy: 'latest_saved', revision: 3, nextOccurrenceAt: next,
}
let persisted: WorkflowSchedule | null
let saves: ScheduleSaveInput[]
let disables: ScheduleDisableInput[]
let reads: number
const clients: QueryClient[] = []

function apply(input: ScheduleSaveInput): ScheduleSaveResult {
  persisted = WorkflowScheduleSchema.parse({ ...input.schedule, ...scope,
    revision: (persisted?.revision ?? 0) + 1, nextOccurrenceAt: input.schedule.enabled ? next : null })
  return { value: persisted, replayed: false }
}
function makeClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return client
}
function mount(client = makeClient()) {
  const user = userEvent.setup()
  const wrapper = ({ children }: { children: ReactNode }) => <StrictMode><QueryClientProvider client={client}>{children}</QueryClientProvider></StrictMode>
  const view = render(<ScheduleClockButton {...scope} isSaved />, { wrapper })
  return { ...view, client, user, wrapper }
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
  await screen.findByRole('switch', { name: 'Enabled' })
  return screen.getByRole('dialog', { name: 'Schedule' })
}

beforeEach(() => {
  // The saved fixtures and displayed times describe a UTC device.
  mockDeviceTimezone('UTC')
  persisted = null; saves = []; disables = []; reads = 0
  const receipts = new Map<string, ScheduleSaveResult>()
  server.use(
    http.get(path, () => { reads++; return HttpResponse.json({ schedule: persisted }) }),
    http.get('/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule/occurrences',
      () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
    http.put(path, async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }); saves.push(input)
      const replay = receipts.get(input.commandId)
      if (replay) return HttpResponse.json({ ...replay, replayed: true })
      if (input.expectedRevision !== (persisted?.revision ?? 0)) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed.' } }, { status: 409 })
      }
      const result = apply(input); receipts.set(input.commandId, result)
      return HttpResponse.json(result)
    }),
    http.post(`${path}/disable`, async ({ request }) => {
      const input = ScheduleDisableInputSchema.parse({ ...scope, ...(await request.json() as object) }); disables.push(input)
      if (!persisted) return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Missing.' } }, { status: 404 })
      persisted = WorkflowScheduleSchema.parse({ ...persisted, enabled: false, revision: persisted.revision + 1, nextOccurrenceAt: null })
      return HttpResponse.json({ value: persisted, replayed: false })
    }),
  )
})
afterEach(() => { for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals() })

describe('schedule clock and compact modal', () => {
  it('keeps an unsaved workflow disabled and labeled without a hover popup', async () => {
    const { user, rerender } = mount()
    rerender(<ScheduleClockButton {...scope} isSaved={false} />)
    const button = screen.getByRole('button', { name: 'Save workflow first' })
    expect(button).toBeDisabled()
    await user.hover(button.parentElement!)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    act(() => button.parentElement!.focus())
    expect(button.parentElement).toHaveAccessibleName('Save workflow first')
    expect(reads).toBe(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('does not open a popup or load schedules on hover or focus', async () => {
    const { user } = mount()
    const button = screen.getByRole('button', { name: 'Schedule workflow' })
    await user.hover(button)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.unhover(button)
    act(() => button.focus())
    expect(button).toHaveFocus()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(reads).toBe(0)
  })
  it.each(['{Enter}', ' '])('opens schedules only after keyboard activation with %s', async (key) => {
    const { user } = mount()
    const button = screen.getByRole('button', { name: 'Schedule workflow' })
    act(() => button.focus())
    await user.keyboard(key)
    const dialog = await screen.findByRole('dialog', { name: 'Schedule' })
    await screen.findByRole('switch', { name: 'Enabled' })
    expect(dialog).toBeVisible()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(reads).toBeGreaterThan(0)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(saves).toHaveLength(0)
    expect(disables).toHaveLength(0)
  })
  it('defaults to the browser timezone and saves Weekly with ISO weekdays', async () => {
    const { user } = mount()
    await open(user)
    expect(screen.queryByRole('combobox', { name: 'Timezone' })).not.toBeInTheDocument()
    for (const day of ['Tuesday', 'Wednesday', 'Thursday', 'Friday']) await user.click(screen.getByRole('button', { name: day }))
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves).toHaveLength(1)
    expect(saves[0]).toMatchObject({ ...scope, expectedRevision: 0, schedule: { mode: 'weekly', weekdays: [1], time: '10:15', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, policy: 'latest_saved' } })
  })
  it.each(['minute', 'hour'])('saves Interval in %s units', async (unit) => {
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('tab', { name: 'Interval' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every' }), { target: { value: '5' } })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Unit' }), unit)
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.schedule).toMatchObject({ mode: 'interval', every: 5, unit, anchorAt: expect.any(String) })
  })
  it('saves Once with a local date and time, not a client-pinned workflow version', async () => {
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('tab', { name: 'Once' }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-08-24' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '13:45' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.schedule).toEqual({ mode: 'once', localDate: '2099-08-24', time: '13:45', timezone: 'UTC', enabled: true, policy: 'latest_saved' })
  })
  it('validates each tab without an HTTP write and keeps invalid inputs', async () => {
    const { user } = mount(); await open(user)
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await user.click(screen.getByRole('button', { name: day }))
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByText('Choose a day.')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Interval' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Every' }), { target: { value: '0' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByRole('spinbutton', { name: 'Every' })).toHaveValue(0)
    expect(screen.getByText('Use a whole number ≥ 1.')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Once' }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2000-01-01' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(screen.getByText('Choose a future date and time.')).toBeVisible()
    expect(saves).toHaveLength(0)
  })
  it('keeps the draft on conflict, then reopens from a fresh server revision', async () => {
    persisted = { ...weekly }
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      persisted = { ...weekly, revision: 4, time: '22:00' }
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Changed.' } }, { status: 409 })
    }))
    const { user } = mount(); await open(user)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Schedule changed.')
    expect(screen.getByLabelText('Time')).toHaveValue('10:15')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(saves).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Cancel' })); await open(user)
    expect(screen.getByLabelText('Time')).toHaveValue('22:00')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled()
  })
  it('keeps inputs editable after a definite rejection', async () => {
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      return HttpResponse.json({ error: { code: 'INVALID_SCHEDULE', message: 'Invalid.' } }, { status: 422 })
    }))
    const { user } = mount(); await open(user)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '12:34' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved.')
    expect(screen.getByLabelText('Time')).toHaveValue('12:34')
    expect(screen.getByLabelText('Time')).toBeEnabled()
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.commandId).not.toBe(saves[0]?.commandId)
  })
  it.each(['weekly', 'past Once'])('disables %s using the dedicated command and reads back disabled', async (mode) => {
    persisted = mode === 'weekly' ? { ...weekly } : { ...scope, mode: 'once', localDate: '2000-01-01', time: '09:00', timezone: 'UTC',
      enabled: true, policy: 'latest_saved', revision: 3, nextOccurrenceAt: null }
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('switch', { name: 'Enabled' }))
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(disables).toHaveLength(1); expect(saves).toHaveLength(0)
    expect(disables[0]).toMatchObject({ ...scope, expectedRevision: 3 })
    await open(user)
    expect(screen.getByRole('switch', { name: 'Enabled' })).not.toBeChecked()
    expect(screen.getByText('Next —')).toBeVisible()
  })
  it('enables a saved disabled schedule through Save', async () => {
    persisted = { ...weekly, enabled: false, nextOccurrenceAt: null }
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('switch', { name: 'Enabled' }))
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toMatchObject({ expectedRevision: 3, schedule: { enabled: true } })
    expect(disables).toHaveLength(0)
  })
  it.each([
    { enabled: true, cursor: '2000-01-01T09:00:00.000Z' },
    { enabled: true, cursor: null },
    { enabled: false, cursor: null },
  ])('saves unchanged elapsed Once settings with enabled=$enabled and cursor=$cursor', async ({ enabled, cursor }) => {
    const original: WorkflowSchedule = { ...scope, mode: 'once', localDate: '2000-01-01', time: '09:00', timezone: 'UTC',
      enabled, policy: 'latest_saved', revision: 3, nextOccurrenceAt: cursor }
    persisted = original
    server.use(http.put(path, async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) })
      saves.push(input)
      persisted = { ...original, enabled: true, revision: original.revision + 1 }
      return HttpResponse.json({ value: persisted, replayed: false })
    }))
    const { user } = mount()
    await open(user)
    if (!enabled) await user.click(screen.getByRole('switch', { name: 'Enabled' }))
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves).toHaveLength(1)
    expect(saves[0]?.schedule).toEqual({ mode: 'once', localDate: '2000-01-01', time: '09:00',
      timezone: 'UTC', enabled: true, policy: 'latest_saved' })
    expect(persisted?.nextOccurrenceAt).toBe(cursor)
  })
  it('shows only the server nextOccurrenceAt, even while editing time/enabled', async () => {
    persisted = { ...weekly }
    const { user } = mount(); const dialog = await open(user)
    expect(dialog.querySelector('time')).toHaveAttribute('datetime', next)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:59' } })
    await user.click(screen.getByRole('switch', { name: 'Enabled' }))
    expect(dialog.querySelector('time')).toHaveAttribute('datetime', next)
    expect(dialog.querySelector('time')?.title).toContain('UTC')
  })
  it('does not reuse an unsaved draft when reopened', async () => {
    persisted = { ...weekly }
    const { user } = mount(); await open(user)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:59' } })
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    persisted = { ...weekly, time: '07:15', revision: 4 }
    const before = reads
    await open(user)
    expect(reads).toBeGreaterThan(before)
    expect(screen.getByLabelText('Time')).toHaveValue('07:15')
  })
  it('does not turn a failed initial GET into an absent schedule', async () => {
    server.use(http.get(path, () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable.' } }, { status: 503 })))
    const { user } = mount()
    await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load.')
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled()
    expect(saves).toHaveLength(0)
  })
  it('uses shared backdrop handling: inside clicks and drags stay open, outside closes and restores focus', async () => {
    const { user } = mount(); const dialog = await open(user)
    await user.click(screen.getByRole('heading', { name: 'Schedule' }))
    expect(dialog).toBeVisible()
    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Schedule' }))
    fireEvent.click(dialog)
    expect(dialog).toBeVisible()
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Schedule workflow' })).toHaveFocus()
  })
  it('honors the shared unsaved-change guard before discarding a dirty form', async () => {
    const request = vi.fn().mockResolvedValue(false)
    const guard = { request, changed: () => {}, surfaces: async () => false, register: () => () => {} }
    const { user, rerender } = mount()
    rerender(<UnsavedChangesContext.Provider value={guard}><ScheduleClockButton {...scope} isSaved /></UnsavedChangesContext.Provider>)
    const dialog = await open(user)
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '23:59' } })
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    await waitFor(() => expect(request).toHaveBeenCalled())
    expect(dialog).toBeVisible()
    expect(screen.getByLabelText('Time')).toHaveValue('23:59')
    request.mockResolvedValue(true)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves).toHaveLength(0)
  })
  it('supports tab arrow, Home and End keys', async () => {
    const { user } = mount(); await open(user)
    const tab = screen.getByRole('tab', { name: 'Weekly' }); tab.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Interval' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Interval' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Once' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Weekly' })).toHaveFocus()
  })
  it('keeps schedule controls and Save usable at a narrow viewport', async () => {
    vi.stubGlobal('innerWidth', 320)
    const { user } = mount(); const dialog = await open(user)
    expect(within(dialog).getAllByRole('tab')).toHaveLength(3)
    expect(within(dialog).getAllByRole('button', { pressed: true })).toHaveLength(5)
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Once' }))
    expect(screen.getByLabelText('Date')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-01-01' } })
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves[0]?.schedule).toMatchObject({ mode: 'once', localDate: '2099-01-01' })
  })
})

describe('schedule command uncertainty and scope', () => {
  it('replays exactly the lost-response command after a remount, despite matching GET readback', async () => {
    let accepted: ScheduleSaveResult | undefined
    server.use(http.put(path, async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }); saves.push(input)
      if (!accepted) { accepted = apply(input); return HttpResponse.error() }
      return HttpResponse.json({ ...accepted, replayed: true })
    }))
    const first = mount(); await open(first.user)
    await first.user.click(screen.getByRole('tab', { name: 'Interval' }))
    await first.user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unconfirmed.')
    expect(screen.getByRole('spinbutton', { name: 'Every' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(saves).toHaveLength(1)
    first.unmount()
    const second = mount(first.client); await open(second.user)
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Interval' })).toHaveAttribute('aria-selected', 'true')
    await second.user.click(screen.getByRole('button', { name: /^Retry$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves).toHaveLength(2); expect(saves[1]).toEqual(saves[0])
    expect(persisted?.revision).toBe(1)
  })
  it('does not turn a confirmed write into an unknown write when its follow-up GET fails', async () => {
    let saved = false
    server.use(http.get(path, () => saved
      ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable.' } }, { status: 503 })
      : HttpResponse.json({ schedule: null })),
    http.put(path, async ({ request }) => {
      const input = ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }); saves.push(input)
      saved = true
      return HttpResponse.json(apply(input))
    }))
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load.')
    expect(screen.queryByText('Save unconfirmed.')).not.toBeInTheDocument()
    expect(saves).toHaveLength(1)
  })
  it.each(['malformed', 'html-409', '408', '429', '500'])('does not automatically resubmit after %s', async (failure) => {
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      return failure === 'malformed' ? HttpResponse.json({ ok: true })
        : failure === 'html-409' ? HttpResponse.text('Gateway response', { status: 409 })
          : HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable.' } }, { status: Number(failure) })
    }))
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unconfirmed.')
    expect(saves).toHaveLength(1)
    expect(screen.getByLabelText('Time')).toBeDisabled()
    expect(screen.getByRole('button', { name: /^Retry$/ })).toBeEnabled()
  })
  it('does not erase earlier uncertainty when an explicit replay receives a later 403', async () => {
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      return saves.length === 1 ? HttpResponse.error()
        : HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied.' } }, { status: 403 })
    }))
    const { user } = mount(); await open(user)
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await screen.findByText('Save unconfirmed.')
    await user.click(screen.getByRole('button', { name: /^Retry$/ }))
    await waitFor(() => expect(saves).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Retry$/ })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('Save unconfirmed.')
    expect(saves[1]).toEqual(saves[0])
    expect(screen.getByLabelText('Time')).toBeDisabled()
  })
  it('fences simultaneous callers synchronously and locks the backdrop while pending', async () => {
    const gate = deferred<ScheduleSaveResult>()
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      return HttpResponse.json(await gate.promise)
    }))
    const { user, wrapper } = mount(); const dialog = await open(user)
    const other = renderHook(() => useScheduleCommand(scope), { wrapper })
    fireEvent.submit(dialog.querySelector('form')!)
    let duplicate: Promise<ScheduleSaveResult | undefined> | undefined
    act(() => { duplicate = other.result.current.submit({ kind: 'save', input: { ...scope, expectedRevision: 0,
      schedule: { mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true, policy: 'latest_saved' } } }) })
    await expect(duplicate).resolves.toBeUndefined()
    await waitFor(() => expect(saves).toHaveLength(1))
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    expect(dialog).toBeVisible()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    const input = saves[0]; if (!input) throw new Error('Expected request')
    await act(async () => { gate.resolve(apply(input)) })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(saves).toHaveLength(1)
  })
  it('does not move a pending save or its readback into another workflow', async () => {
    const gate = deferred<ScheduleSaveResult>()
    const secondScope = { ...scope, workflowId: 'workflow-other' }
    server.use(http.put(path, async ({ request }) => {
      saves.push(ScheduleSaveInputSchema.parse({ ...scope, ...(await request.json() as object) }))
      return HttpResponse.json(await gate.promise)
    }), http.get(schedulePath(secondScope), () => HttpResponse.json({ schedule: { ...weekly, ...secondScope, time: '07:00' } })))
    const { user, rerender, client } = mount(); await open(user)
    await user.click(screen.getByRole('button', { name: /^Save$/ }))
    await waitFor(() => expect(saves).toHaveLength(1))
    rerender(<ScheduleClockButton {...secondScope} isSaved />)
    await open(user)
    const input = saves[0]; if (!input) throw new Error('Expected request')
    await act(async () => { gate.resolve(apply(input)) })
    await waitFor(() => expect(client.getQueryData<ScheduleGetResult>(scheduleKeys.read(scope))?.schedule?.revision).toBe(1))
    expect(screen.getByRole('dialog', { name: 'Schedule' })).toBeVisible()
    expect(screen.getByLabelText('Time')).toHaveValue('07:00')
    expect(client.getQueryData(scheduleKeys.read(secondScope))).toMatchObject({ schedule: { workflowId: secondScope.workflowId, time: '07:00' } })
  })
})

it('shows saved-workflow policy on demand while retaining next-run data', async () => {
  persisted = weekly
  const { user } = mount()
  const dialog = await open(user)
  expect(within(dialog).queryByText('Runs latest saved workflow')).not.toBeInTheDocument()
  const nextRun = within(dialog).getByText('Next', { exact: true })
  expect(nextRun).toBeVisible()
  expect(nextRun.querySelector('time')).toHaveAttribute('datetime', next)
  await user.hover(within(dialog).getByRole('button', { name: 'About Schedule' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Runs latest saved workflow')
})

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { scheduleOccurrenceId, type ScheduleOccurrence, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { server } from '../../mocks/server'
import { ScheduleClockButton } from './ScheduleClockButton'
import { schedulePath } from './client'

const scope = { workspaceId: 'history-workspace', workflowId: 'history-workflow' }
const clients: QueryClient[] = []
const dueAt = '2099-08-24T09:00:00.000Z'
const occurrence = { ...scope, id: scheduleOccurrenceId(scope.workflowId, dueAt), dueAt, scheduleRevision: 3 }
const weekly: WorkflowSchedule = {
  ...scope, mode: 'weekly', weekdays: [1], time: '09:00', timezone: 'UTC', enabled: true,
  policy: 'latest_saved', revision: 3, nextOccurrenceAt: '2099-08-31T09:00:00.000Z',
}

function mount(latest: ScheduleOccurrence | null, schedule: WorkflowSchedule = weekly) {
  let persisted = latest
  let reads = 0
  server.use(
    http.get(schedulePath(scope), () => HttpResponse.json({ schedule })),
    http.get(`${schedulePath(scope)}/occurrences`, ({ request }) => {
      reads++
      expect(new URL(request.url).searchParams.get('limit')).toBe('1')
      return HttpResponse.json({ items: persisted ? [persisted] : [], pageInfo: { nextCursor: null } })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ScheduleClockButton {...scope} isSaved /></QueryClientProvider>)
  return {
    user: userEvent.setup(),
    reads: () => reads,
    advance: (value: ScheduleOccurrence) => { persisted = value },
  }
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Schedule workflow' }))
  await screen.findByRole('switch', { name: 'Enabled' })
  return screen.findByRole('region', { name: 'Last attempt' })
}

function pollingClock() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
})

describe('schedule Last attempt feedback', () => {
  it.each([
    ['schedule_authorization_denied', 'Permission to run this schedule was lost. Restore access, then save the schedule.'],
    ['schedule_authority_missing', 'Save or enable the schedule to authorize future runs.'],
    ['workflow_not_saved', 'Save the workflow before scheduling it.'],
    ['workflow_not_executable', 'Check the saved workflow and agent settings, then save the workflow.'],
  ])('shows an enabled schedule rejection with guidance for %s', async (reason, message) => {
    const view = mount({ ...occurrence, status: 'rejected', reason })
    const section = await open(view.user)
    expect(await within(section).findByText('Rejected')).toBeVisible()
    expect(section).toHaveTextContent(message)
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked()
    expect(within(section).queryByRole('link')).not.toBeInTheDocument()
    expect(section.querySelector('time')).toHaveAttribute('datetime', dueAt)
  })

  it.each(['outside_grace', 'superseded'] as const)('explains a missed attempt: %s', async (reason) => {
    const view = mount({ ...occurrence, status: 'missed', reason })
    const section = await open(view.user)
    expect(await within(section).findByText('Missed')).toBeVisible()
    expect(section).toHaveTextContent(reason === 'outside_grace'
      ? 'The scheduling window passed before this attempt could start.'
      : 'A newer scheduled time replaced this attempt.')
  })

  it.each(['overlap', 'disabled'] as const)('explains a skipped attempt: %s', async (reason) => {
    const view = mount({ ...occurrence, status: 'skipped', reason })
    const section = await open(view.user)
    expect(await within(section).findByText('Skipped')).toBeVisible()
    expect(section).toHaveTextContent(reason === 'overlap'
      ? 'A previous scheduled Run was still active.'
      : 'The schedule was disabled before this attempt could start.')
  })

  it('links an accepted exhausted Once to its persisted Run in a new tab', async () => {
    const runId = 'accepted/run?one&two'
    const once: WorkflowSchedule = {
      ...scope, mode: 'once', localDate: '2099-08-24', time: '09:00', timezone: 'UTC', enabled: true,
      policy: 'latest_saved', revision: 3, nextOccurrenceAt: null,
    }
    const view = mount({ ...occurrence, status: 'accepted', reason: null, runId, workflowVersionId: 'saved-version' }, once)
    const section = await open(view.user)
    expect(await within(section).findByText('Accepted')).toBeVisible()
    expect(screen.getByText('Next —')).toBeVisible()
    const link = within(section).getByRole('link', { name: 'View Run (opens in a new tab)' })
    const url = new URL(link.getAttribute('href')!, window.location.origin)
    expect(url.pathname).toBe(`/workspaces/${scope.workspaceId}`)
    expect(url.searchParams.get('workflowId')).toBe(scope.workflowId)
    expect(url.searchParams.get('selectedRunId')).toBe(runId)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('switch', { name: 'Enabled' })).toBeChecked()
  })

  it('shows an empty history and only polls while open', async () => {
    pollingClock()
    const view = mount(null)
    expect(view.reads()).toBe(0)
    const section = await open(view.user)
    expect(await within(section).findByText('No attempts yet.')).toBeVisible()
    await act(async () => { vi.advanceTimersByTime(5_001) })
    await waitFor(() => expect(view.reads()).toBeGreaterThan(1))
    await view.user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const closedReads = view.reads()
    await act(async () => { vi.advanceTimersByTime(5_001) })
    expect(view.reads()).toBe(closedReads)
  })

  it('refreshes the latest outcome without changing unsaved schedule edits', async () => {
    pollingClock()
    const view = mount({ ...occurrence, status: 'missed', reason: 'outside_grace' })
    const section = await open(view.user)
    await within(section).findByText('Missed')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
    const latestDue = '2099-08-31T09:00:00.000Z'
    view.advance({ ...occurrence, id: scheduleOccurrenceId(scope.workflowId, latestDue), dueAt: latestDue,
      status: 'rejected', reason: 'workflow_not_executable' })
    await act(async () => { vi.advanceTimersByTime(5_001) })
    expect(await within(section).findByText('Rejected')).toBeVisible()
    expect(section.querySelector('time')).toHaveAttribute('datetime', latestDue)
    expect(screen.getByLabelText('Time')).toHaveValue('10:15')
  })

  it('hides cached history after a denied read and allows an explicit retry', async () => {
    pollingClock()
    const view = mount({ ...occurrence, status: 'accepted', reason: null, runId: 'saved-run', workflowVersionId: 'saved-version' })
    const section = await open(view.user)
    await within(section).findByRole('link', { name: /View Run/ })
    server.use(http.get(`${schedulePath(scope)}/occurrences`, () =>
      HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Private server detail.' } }, { status: 403 })))
    await act(async () => { vi.advanceTimersByTime(5_001) })
    expect(await within(section).findByText('Could not load last attempt.')).toBeVisible()
    expect(within(section).queryByRole('link')).not.toBeInTheDocument()
    expect(section).not.toHaveTextContent('Private server detail.')
    server.use(http.get(`${schedulePath(scope)}/occurrences`, () =>
      HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
    await view.user.click(within(section).getByRole('button', { name: 'Retry history' }))
    expect(await within(section).findByText('No attempts yet.')).toBeVisible()
  })

  it.each(['unknown-native-password=private-sentinel', '__proto__'])('does not expose an unrecognized rejection reason: %s', async (reason) => {
    const view = mount({ ...occurrence, status: 'rejected', reason })
    const section = await open(view.user)
    expect(await within(section).findByText('Rejected')).toBeVisible()
    expect(section).toHaveTextContent('The saved workflow could not start. Check its settings, then save the schedule again.')
    expect(section).not.toHaveTextContent(reason)
  })
})

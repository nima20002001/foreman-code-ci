import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ScheduleClockButton } from '../../features/schedules/ScheduleClockButton'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { afterEach, expect, it, vi } from 'vitest'
import { UnsavedChangesProvider } from './UnsavedChangesProvider'
import { useUnsavedChanges, type LeaveTarget } from './unsavedChanges'

const blocker = vi.hoisted(() => ({ current: undefined as unknown as {
  shouldBlockFn(input: { current: LeaveTarget; next: LeaveTarget }): Promise<boolean>
  enableBeforeUnload(): boolean
} }))
vi.mock('@tanstack/react-router', () => ({ useBlocker: (options: typeof blocker.current) => { blocker.current = options } }))
afterEach(cleanup)
function Editor({ retained }: { retained: boolean }) {
  useUnsavedChanges({ label: 'Board', dirty: true, canResume: () => retained, save() {}, discard() {} })
  return null
}
it('allows navigation and reload for recoverable edits without displaying a dialog', async () => {
  render(<UnsavedChangesProvider><Editor retained /></UnsavedChangesProvider>)
  expect(blocker.current.enableBeforeUnload()).toBe(false)
  let blocked = true
  await act(async () => { blocked = await blocker.current.shouldBlockFn({
    current: { pathname: '/workspaces/one', search: {} }, next: { pathname: '/settings', search: {} },
  }) })
  expect(blocked).toBe(false)
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})
it('retains the browser warning when edits cannot be recovered', () => {
  render(<UnsavedChangesProvider><Editor retained={false} /></UnsavedChangesProvider>)
  expect(blocker.current.enableBeforeUnload()).toBe(true)
})
it('guards an invalid schedule draft when returning to a pinned Run alias on the same Board', async () => {
  const schedulePath = '/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule'
  server.use(http.get(schedulePath, () => HttpResponse.json({ schedule: null })),
    http.get(`${schedulePath}/occurrences`, () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><UnsavedChangesProvider>
    <ScheduleClockButton workspaceId="workspace" workflowId="workflow" isSaved />
  </UnsavedChangesProvider></QueryClientProvider>)
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Schedule workflow' }))
    const time = await screen.findByLabelText('Time')
    fireEvent.change(time, { target: { value: '' } })
    let navigation!: Promise<boolean>
    act(() => {
      navigation = blocker.current.shouldBlockFn({
        current: { pathname: '/workspaces/workspace', search: { workflowId: 'workflow' } },
        next: { pathname: '/workspaces/workspace/workflows/workflow/runs/run/graph/version/3', search: {} },
      })
    })
    const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
    expect(time).toHaveValue('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Schedule not saved.')).toBeInTheDocument()
    expect(await screen.findByText('Choose a time.')).toBeInTheDocument()
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    await expect(navigation).resolves.toBe(true)
    expect(screen.getByRole('dialog', { name: 'Schedule' })).toBeInTheDocument()
    expect(time).toHaveValue('')
  } finally { view.unmount(); client.clear() }
})

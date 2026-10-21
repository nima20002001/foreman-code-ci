import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { useRunsSelectorUi } from '../../runs-selector/uiStore'
import { activitiesRoute, activityPage, clients, installSelectedHandlers, mountSelectedActivities } from './sch10.testSupport'
import { deferred } from '../../../test/deferred'

beforeEach(() => { useRunsSelectorUi.getState().setOpen(null) })
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  useRunsSelectorUi.getState().setOpen(null)
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('drops an older Activities page after switching and preserves selectedRunId when filtering', async () => {
    installSelectedHandlers()
    const pending = deferred<ReturnType<typeof activityPage>>(); let requested = false
    server.use(http.get(activitiesRoute, async ({ params, request }) => {
      const id = String(params.runId)
      if (new URL(request.url).searchParams.get('cursor') === 'older-a') { requested = true; return HttpResponse.json(await pending.promise) }
      return HttpResponse.json(activityPage(id, `execution-${id}`, `Run activity ${id}`, '2', id === 'run-a' ? 'older-a' : null))
    }))
    const mounted = await mountSelectedActivities('run-a')
    await screen.findByText('Run activity run-a')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activity kind' }), 'agent_work')
    expect(mounted.router.history.location.href).toContain('selectedRunId=run-a')
    expect(mounted.router.history.location.href).toContain('#chat')
    const region = screen.getByRole('region', { name: 'Activities' })
    await userEvent.click(within(region).getByRole('button', { name: 'More' }))
    await waitFor(() => expect(requested).toBe(true))
    await mounted.select('run-b'); await screen.findByText('Run activity run-b')
    await act(async () => { pending.resolve(activityPage('run-a', 'execution-run-a', 'Old Activities')); await pending.promise })
    expect(screen.queryByText('Old Activities')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Activities' })).toHaveAttribute('data-run-id', 'run-b')
  })

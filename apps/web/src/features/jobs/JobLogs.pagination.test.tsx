import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { JobLogs } from './JobLogs'
import { execution, logPage } from './fixtures'

let client: QueryClient

afterEach(() => {
  cleanup()
  client.clear()
})

it('loads the next cursor page and keeps earlier output visible', async () => {
  const cursors: string[] = []
  const later = { ...logPage, chunks: [{ ...logPage.chunks[0]!, sequence: 2, text: 'Later build failure' }], nextCursor: 2 }
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/executions/:id/logs', ({ request }) => {
    const query = new URL(request.url).searchParams
    const cursor = query.get('afterSequence')!
    cursors.push(cursor)
    expect(query.get('limit')).toBe('50')
    if (cursor === '0') return HttpResponse.json(logPage)
    if (cursor === '1') return HttpResponse.json(later)
    return new HttpResponse(null, { status: 400 })
  }))
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}>
    <JobLogs workspaceId={execution.workspaceId} executionId={execution.id} attemptId={execution.attemptId} enabled />
  </QueryClientProvider>)
  expect(await screen.findByText(/build failed/)).toBeVisible()
  expect(screen.getByText('1 loaded chunks.')).toBeVisible()
  expect(screen.queryByText('Searches only the loaded window, up to 250 chunks.')).not.toBeInTheDocument()
  const user = userEvent.setup()
  const hint = screen.getByRole('button', { name: 'About Search loaded logs' })
  await user.hover(hint)
  expect(screen.getByRole('tooltip')).toHaveTextContent('Searches only the loaded window, up to 250 chunks.')
  await user.unhover(hint)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Follow tail' }))
  fireEvent.click(screen.getByRole('button', { name: 'Load next log page' }))
  expect(await screen.findByText('Later build failure')).toBeVisible()
  expect(screen.getByText(/build failed/)).toBeVisible()
  expect(cursors).toEqual(['0', '1'])
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load next log page' })).toBeEnabled())
})

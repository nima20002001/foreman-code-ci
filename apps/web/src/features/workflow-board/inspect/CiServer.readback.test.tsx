import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../../mocks/server'
import { CiServerDialog } from './CiServer'
import { runCiApi } from './ciServer'
import { ciResultJob, ciResultTests } from './ciResults.testSupport'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 as const }
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers() })

function Readback() {
  const query = useQuery({ queryKey: ['ci-readback'],
    queryFn: ({ signal }) => runCiApi.list(scope, { signal }), refetchInterval: 1500 })
  return <CiServerDialog open onOpenChange={() => {}} scope={scope} jobs={query.data?.jobs ?? []}
    names={new Map()} truncated={false} error={query.isError} loading={query.isPending} />
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><Readback /></QueryClientProvider>)
}

it('reads test files collected after the terminal job summary changes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let collected = false
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, tests: collected ? ciResultTests.summary : null }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({
      ticketId: ciResultJob.ticketId, tests: collected ? ciResultTests : null })),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of/ }))
  await screen.findByText('No test results for this job')
  collected = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(await screen.findByText('failing example')).toBeVisible()
})

it.each([
  ['running', 'CI_EXECUTOR_UNAVAILABLE: Worker disconnected; execution ownership retained.'],
  ['queued', 'No compatible build computer is available.'],
] as const)('shows the API diagnostic for a %s job in the table and detail header', async (state, message) => {
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, message, ci: { ...ciResultJob.ci, state } }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({
      ticketId: ciResultJob.ticketId, tests: null })),
  )
  mount()
  await screen.findByRole('button', { name: /Show tests of/ })
  expect(screen.getByText(message)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /Show tests of/ }))
  expect(await screen.findByText(message)).toBeVisible()
})

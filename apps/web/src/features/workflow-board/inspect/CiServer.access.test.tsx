import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { CiRunJob } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { server } from '../../../mocks/server'
import { CiServerDialog } from './CiServer'
import { runInspectionQueryKey } from './queries'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace', workflowId: 'workflow',
  runId: 'run', workflowVersionId: 'version', executionSemanticsVersion: 3 }
const ticketId = '00000000-0000-4000-8000-000000000001'
const summary = { passed: 0, failed: 1, skipped: 0 }
const job: CiRunJob = { ticketId, scope: 'affected', placement: 'host', message: null, tests: summary,
  requester: { executionId: 'execution', agentId: 'agent', nodeId: 'node', nodeName: 'Builder' },
  ci: { id: ticketId, groupId: '00000000-0000-4000-8000-000000000002', suite: 'unit', part: 'unit-api',
    partition: null, state: 'failed', exitCode: 1, computer: null, step: null,
    queuedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:01.000Z',
    finishedAt: '2026-10-01T00:00:02.000Z' } }
const caches: QueryClient[] = []
afterEach(() => caches.splice(0).forEach(cache => cache.clear()))

async function mount() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  caches.push(cache)
  render(<QueryClientProvider client={cache}><CiServerDialog open onOpenChange={() => undefined}
    scope={scope} jobs={[job]} names={new Map()} truncated={false} error={false} loading={false} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Show tests of unit · unit-api requested by Builder' }))
  return cache
}

describe('CI details after access changes', () => {
  it.each([401, 403])('removes cached test messages and counts after HTTP %s, and keeps them hidden after a network failure', async status => {
    let responseStatus = 200
    server.use(http.get(`/api/management/workspaces/workspace/ci/${ticketId}/tests`, () =>
      responseStatus === 200 ? HttpResponse.json({ ticketId, tests: { summary, truncated: false,
        files: [{ file: 'build.test.ts', status: 'failed', durationMs: 1,
          tests: [{ name: 'protected test', status: 'failed', durationMs: 1, message: 'protected failure detail' }] }] } })
        : HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'CI read denied' } }, { status: responseStatus })))
    const cache = await mount()
    await screen.findByText('protected failure detail')
    expect(screen.getByRole('button', { name: 'Failed 1' })).toBeVisible()
    for (const next of [status, 503]) {
      responseStatus = next
      await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-tests'] }) })
      await waitFor(() => expect(screen.queryByText('protected failure detail')).not.toBeInTheDocument())
      expect(screen.getByRole('button', { name: 'Failed' })).toBeVisible()
      expect(screen.getByText('Test results are unavailable.')).toBeVisible()
    }
    responseStatus = 200
    await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-tests'] }) })
    expect(await screen.findByText('protected failure detail')).toBeVisible()
  })

  it('removes a cached log after denial, while a transient failure retains the log with a warning', async () => {
    let responseStatus = 200
    server.use(
      http.get(`/api/management/workspaces/workspace/ci/${ticketId}/tests`, () => HttpResponse.json({ ticketId, tests: null })),
      http.get(`/api/management/workspaces/workspace/ci/${ticketId}/logs`, () => responseStatus === 200
        ? HttpResponse.json({ text: 'protected log text', nextOffset: 18, logBytes: 18, maxBytes: 32768 })
        : HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'CI read failed' } }, { status: responseStatus })),
    )
    const cache = await mount()
    await userEvent.click(screen.getByRole('tab', { name: 'Log' }))
    await screen.findByText('protected log text')
    responseStatus = 503
    await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-log'] }) })
    expect(await screen.findByText('Showing the last log read.')).toBeVisible()
    expect(screen.getByText('protected log text')).toBeVisible()
    for (const next of [403, 503]) {
      responseStatus = next
      await act(async () => { await cache.refetchQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-log'] }) })
      await waitFor(() => expect(screen.queryByText('protected log text')).not.toBeInTheDocument())
      expect(screen.getByText('The log is unavailable right now.')).toBeVisible()
    }
  })
})

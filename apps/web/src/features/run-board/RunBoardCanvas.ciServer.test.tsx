import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActivitySnapshotV1, CiRunJob } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { RunBoardCanvas } from './RunBoardCanvas'
import { ciResultTests } from '../workflow-board/inspect/ciResults.testSupport'
import { runA } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const ticketId = '00000000-0000-4000-8000-000000000001'
const job: CiRunJob = { ticketId, scope: 'affected', placement: 'host', message: null,
  tests: { passed: 0, failed: 1, skipped: 0 },
  requester: { executionId: 'execution', agentId: 'agent-x', nodeId: 'node-x', nodeName: 'X before rename' },
  ci: { id: ticketId, groupId: '00000000-0000-4000-8000-000000000002', suite: 'unit', part: 'unit-api',
    partition: null, state: 'failed', exitCode: 1, computer: null, step: null,
    queuedAt: '2026-10-01T00:00:00.000Z', startedAt: '2026-10-01T00:00:01.000Z',
    finishedAt: '2026-10-01T00:00:02.000Z' } }

beforeEach(() => {
  installFlowLayout()
  server.use(http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
    HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

// The Run's subagent overlay reads its selection from the router.
async function mount(activitySnapshot?: ActivitySnapshotV1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({ routeTree: createRootRoute({ component: () => <RunBoardCanvas snapshot={runA} activitySnapshot={activitySnapshot} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
}

it('shows the CI server on a saved Run Board and opens the Run CI jobs', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) =>
    HttpResponse.json({ runId: new URL(request.url).searchParams.get('runId'), jobs: [job], truncated: false })))
  await mount()
  // fireEvent: a real pointer press would start React Flow's zoom drag, which jsdom cannot host.
  fireEvent.click(await screen.findByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  const dialog = await screen.findByRole('dialog', { name: 'CI server' })
  expect(await within(dialog).findByRole('button', { name: 'Show tests of unit · unit-api requested by X before rename' })).toBeVisible()
})

it('keeps the CI server on a saved Run Board when CI cannot be read', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', () =>
    HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'CI read denied' } }, { status: 403 })))
  await mount()
  expect(await screen.findByRole('button', { name: /^CI server, CI unavailable/ })).toBeVisible()
})

it.each(['idle', 'failed read'] as const)('discovers CI after an initial %s while the Run is active', async initial => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let requested = false
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', () => {
    if (!requested && initial === 'failed read') return HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Temporary interruption' } }, { status: 503 })
    return HttpResponse.json({ runId: runA.runId, jobs: requested ? [job] : [], truncated: false })
  }))
  await mount({ schemaVersion: 1, scope: { kind: 'workflow_run', workspaceId: runA.workspaceId,
    workflowId: runA.workflowId, runId: runA.runId, workflowVersionId: runA.workflowVersionId },
    revision: '1', active: [], queued: [{ kind: 'run', workspaceId: runA.workspaceId,
      workflowId: runA.workflowId, runId: runA.runId, workflowVersionId: runA.workflowVersionId }],
    latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } })
  await screen.findByRole('button', { name: initial === 'idle' ? /^CI server, Idle/ : /^CI server, CI unavailable/ })
  requested = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  fireEvent.click(screen.getByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  expect(await screen.findByRole('button', { name: /Show tests of unit/ })).toBeVisible()
})

it('reads test results collected after a finished Run and its terminal ticket', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let collected = false
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: runA.runId, truncated: false,
      jobs: [{ ...job, tests: collected ? ciResultTests.summary : null, collection: collected ? 'complete' : 'pending' }] })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({
      ticketId, tests: collected ? ciResultTests : null })),
  )
  await mount({ schemaVersion: 1, scope: { kind: 'workflow_run', workspaceId: runA.workspaceId,
    workflowId: runA.workflowId, runId: runA.runId, workflowVersionId: runA.workflowVersionId },
    revision: '1', active: [], queued: [], latest: null, pendingInteractions: [], activities: [],
    page: { before: null, nextCursor: null, hasMore: false } })
  fireEvent.click(await screen.findByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of unit/ }))
  await screen.findByText('No test results for this job')
  collected = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(await screen.findByText('failing example')).toBeVisible()
})

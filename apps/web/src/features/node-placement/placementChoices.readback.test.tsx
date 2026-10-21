import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { useComputerMaintenance } from '../../shared/api/computerMaintenance'
import { useComputerActivity } from '../../shared/api/computerActivity'
import { usePlacementChoices } from './usePlacementChoices'
import { savedPlacementFixture as placement } from './fixtures'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', nodeId: 'node-a',
  agentConfigurationVersionId: 'configuration-old' }
const pendingReason = 'The selected harness profile is being checked. Retry Run start shortly.'
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers() })
function Choices() {
  const query = usePlacementChoices(scope, 'visit-a')
  return <><span>{query.isSuccess ? 'Choices loaded' : 'Loading choices'}</span>
    <select aria-label="Computer">{query.options.map(option => <option key={option.label}
      disabled={Boolean(option.unavailableReason)}>{option.label}: {option.unavailableReason ?? 'Ready'}</option>)}</select></>
}
function Activity() {
  const query = useComputerActivity()
  return <span>{query.isSuccess ? 'Activity loaded' : 'Loading activity'}</span>
}
const target = { hostRef: placement.hostRef,
  applicationInstallationId: '30000000-0000-4000-8000-000000000001', keyRevision: 1, authorizationRevision: 1 }
function Maintenance() {
  const query = useComputerMaintenance([target])[0]!
  return <span>{query.isSuccess ? 'Maintenance loaded' : 'Loading maintenance'}</span>
}
function mount({ activity = false, maintenance = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const view = render(<QueryClientProvider client={client}>
    {activity ? <Activity /> : null}{maintenance ? <Maintenance /> : null}<Choices />
  </QueryClientProvider>)
  return { client, view }
}
function discovery(readback: () => { ready: boolean; omitted?: boolean; reason?: string; pending?: boolean }) {
  let reads = 0
  server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices', () => {
    reads++
    const { ready, omitted, reason = pendingReason, pending = !ready && !omitted && reason === pendingReason } = readback()
    return HttpResponse.json({ ...scope, pending, choices: omitted ? [] : [{ id: 'choice-a', label: 'Paired computer', placement,
      availability: ready ? 'ready' : 'unavailable', reason: ready ? null : reason }] })
  }))
  return () => reads
}

it('polls a pending check until ready and then stops discovery polling', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let ready = false
  const reads = discovery(() => ({ ready }))
  mount()
  await screen.findByRole('option', { name: `Paired computer: ${pendingReason}` })
  expect(reads()).toBe(1)
  ready = true
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(await screen.findByRole('option', { name: 'Paired computer: Ready' })).toBeEnabled()
  expect(reads()).toBe(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(reads()).toBe(2)
})

it('polls while a computer omitted from the choices is still being checked', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let ready = false
  const reads = discovery(() => ({ ready, omitted: !ready, pending: !ready }))
  mount()
  await screen.findByText('Choices loaded')
  expect(screen.queryByRole('option')).toBeNull()
  ready = true
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(await screen.findByRole('option', { name: 'Paired computer: Ready' })).toBeEnabled()
  expect(reads()).toBe(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(reads()).toBe(2)
})

it.each(['ready', 'unavailable', 'empty'] as const)('does not poll a settled %s response', async state => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const reads = discovery(() => ({ ready: state === 'ready', omitted: state === 'empty',
    reason: 'The matching harness profile needs qualification on this computer.' }))
  mount()
  await screen.findByText('Choices loaded')
  expect(reads()).toBe(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(reads()).toBe(1)
})

it.each(['omitted', 'ready'] as const)('refreshes a mounted %s choice when computer presence changes', async initial => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let online = initial === 'ready'
  const reads = discovery(() => ({ ready: online, omitted: !online && initial === 'omitted', reason: 'Worker disconnected' }))
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({
    mainId: placement.hostRef.mainId, computers: [{ target: { hostRef: placement.hostRef,
      applicationInstallationId: '30000000-0000-4000-8000-000000000001', keyRevision: 1, authorizationRevision: 1 },
    online, name: 'Paired computer', jobs: [], agents: [] }], cloud: [], truncated: false, activityComplete: true,
  })))
  const { client } = mount({ activity: true })
  await screen.findByText('Activity loaded')
  await screen.findByText('Choices loaded')
  if (online) await screen.findByRole('option', { name: 'Paired computer: Ready' })
  const settledReads = reads()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(reads()).toBe(settledReads)
  online = !online
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-activity'] }) })
  const option = await screen.findByRole('option', { name: online ? 'Paired computer: Ready' : /Worker disconnected/ })
  if (online) expect(option).toBeEnabled()
  else expect(option).toBeDisabled()
  expect(reads()).toBe(settledReads + 1)
})

it('rediscovers an omitted computer when existing Worker readiness readback changes', async () => {
  let ready = false
  let observedAt = '2026-10-01T00:00:00.000Z'
  const reads = discovery(() => ({ ready, omitted: !ready }))
  const identity = { version: '1.0.0', target: { os: 'linux', osRelease: 'test', arch: 'x64', libc: 'glibc', node: '24' },
    manifestSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64) }
  server.use(http.post('*/api/management/computers/maintenance/read', () => HttpResponse.json({ computers: [{ target,
    status: { observedAt, harnesses: [], tasks: [],
      system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } },
    workerReadiness: { ready, code: ready ? null : 'WORKER_VERSION_SKEW', expected: identity,
      running: { ...identity, contentSha256: ready ? identity.contentSha256 : 'c'.repeat(64) },
      updatePhase: 'current', publicationError: null },
  }] })))
  const { client } = mount({ maintenance: true })
  await screen.findByText('Maintenance loaded')
  await screen.findByText('Choices loaded')
  const settledReads = reads()
  observedAt = '2026-10-01T00:01:00.000Z'
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-maintenance'] }) })
  expect(reads()).toBe(settledReads)
  ready = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-maintenance'] }) })
  expect(await screen.findByRole('option', { name: 'Paired computer: Ready' })).toBeEnabled()
  expect(reads()).toBe(settledReads + 1)
})

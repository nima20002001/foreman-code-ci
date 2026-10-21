// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowHierarchyReadResultSchema, HierarchyReportSchema, type HierarchyReport,
  type WorkflowHierarchyCoordination } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { MasterOverview } from './MasterOverview'
import { hierarchyKey } from './queries'
import { deferred } from '../../test/deferred'

const scope = { workspaceId: 'overview-workspace', workflowId: 'overview-workflow' }
const path = `*/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/hierarchy`
const clients: QueryClient[] = []
class ReportSource extends EventTarget {
  static instances: ReportSource[] = []
  closed = false
  constructor(readonly url: string) { super(); ReportSource.instances.push(this) }
  close() { this.closed = true }
  change(revision: number, cursor = revision.toString(16).padStart(64, '0')) { this.dispatchEvent(new MessageEvent('changed', {
    data: JSON.stringify({ runId: 'past-run', workflowVersionId: 'past-version', revision, cursor: `sha256:${cursor}` }),
  })) }
}
beforeEach(() => { ReportSource.instances = []; vi.stubGlobal('EventSource', ReportSource) })
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

function install(options: { reports?: 'empty' | 'error'; waitForReports?: Promise<void>; noHierarchy?: boolean;
  coordination?: WorkflowHierarchyCoordination } = {}) {
  const hierarchyReads: URL[] = [], reportReads: URL[] = []
  let denied = false, hierarchyStatus = 200
  let replacedMaster = false
  let coordination = options.coordination
  const agents = [
    { workflowNodeId: 'master-node', agentId: 'master-agent', displayName: 'Saved Master', productRole: 'master' as const },
    { workflowNodeId: 'orchestrator-node', agentId: 'orchestrator-agent', displayName: 'Saved Orchestrator', productRole: 'orchestrator' as const },
    { workflowNodeId: 'worker-node', agentId: 'worker-agent', displayName: 'Saved Worker', productRole: 'coder' as const },
  ].map(agent => ({ ...scope, ...agent, configurationVersionId: `${agent.agentId}-historical` }))
  const report = (index: number, parentNodeId: string): HierarchyReport => HierarchyReportSchema.parse({
    id: `report-${index}`, agent: agents[index], execution: { runId: 'past-run', workflowVersionId: 'past-version',
      executionId: `past-execution-${index}`, activationId: `past-activation-${index}`, attempt: 1 },
    parentNodeId, parentRequestId: `past-request-${index}`, state: index === 1 ? 'returned' : 'blocked',
    summary: index === 1 ? 'Accepted child summary' : 'Needs a decision', cardIds: ['linked-card'],
    sourceEventKey: `event-${index}`, updatedAt: '2026-10-01T00:00:00Z',
  })
  server.use(http.get(path, ({ request }) => {
    const url = new URL(request.url); hierarchyReads.push(url)
    if (hierarchyStatus !== 200) return HttpResponse.json({ error: {
      code: hierarchyStatus === 403 ? 'ACCESS_DENIED' : 'TEMPORARILY_UNAVAILABLE', message: 'Hierarchy unavailable',
    } }, { status: hierarchyStatus })
    return HttpResponse.json(WorkflowHierarchyReadResultSchema.parse({ ...scope,
      workflowVersionId: 'past-version', revision: 8, hierarchy: options.noHierarchy ? null : replacedMaster ? {
        version: 1, masterNodeId: 'orchestrator-node', parents: [
          { workflowNodeId: 'master-node', parentNodeId: 'orchestrator-node' },
          { workflowNodeId: 'worker-node', parentNodeId: 'master-node' },
        ],
      } : { version: 1, masterNodeId: 'master-node', parents: [
        { workflowNodeId: 'orchestrator-node', parentNodeId: 'master-node' },
        { workflowNodeId: 'worker-node', parentNodeId: 'orchestrator-node' },
      ] }, agents: agents.map(agent => !replacedMaster || agent.productRole === 'coder' ? agent : {
        ...agent, productRole: agent.productRole === 'master' ? 'orchestrator' : 'master',
      }), ...(url.searchParams.has('runId') ? { run: { runId: 'past-run', state: 'running',
        ...(coordination ? { coordination } : {}) } } : {}) }))
  }), http.get(`${path}/reports`, async ({ request }) => {
    const url = new URL(request.url); reportReads.push(url)
    await options.waitForReports
    if (denied) return HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Access was revoked' } }, { status: 403 })
    if (options.reports === 'error') return HttpResponse.json({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Try again' } }, { status: 500 })
    const parent = url.searchParams.get('parentNodeId')
    return HttpResponse.json({ ...scope, runId: 'past-run', workflowVersionId: 'past-version',
      items: options.reports === 'empty' ? [] : [parent === 'master-node' ? report(1, 'master-node') : report(2, 'orchestrator-node')],
      nextCursor: null, hasMore: false, revision: 1 })
  }))
  return { hierarchyReads, reportReads, report, deny: () => { denied = true },
    replaceMaster: () => { replacedMaster = true },
    setCoordination: (next: WorkflowHierarchyCoordination) => { coordination = next },
    failHierarchy: () => { hierarchyStatus = 500 }, denyAll: () => { denied = true; hierarchyStatus = 403 } }
}
function mount(runId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const actions = { onChat: vi.fn(), onSettings: vi.fn(), onReport: vi.fn(), onExecution: vi.fn(), onCard: vi.fn(),
    onChooseMaster: vi.fn(), onCurrentWorkflow: vi.fn() }
  const view = render(<QueryClientProvider client={client}><MasterOverview {...scope} runId={runId} {...actions} /></QueryClientProvider>)
  return { ...view, actions, client }
}

it('shows configuration with No run selected and never reads reports or subscribes without a Run', async () => {
  const wire = install(), view = mount()
  await screen.findByRole('heading', { name: 'Saved Master Master' })
  expect(screen.getAllByText('No run selected').length).toBeGreaterThan(0)
  await userEvent.click(screen.getByRole('button', { name: 'View branch · 1' }))
  expect(await screen.findByText(/Saved Worker/)).toBeInTheDocument()
  expect(wire.reportReads).toEqual([])
  expect(ReportSource.instances).toEqual([])
  await userEvent.click(screen.getByRole('button', { name: 'Ask master' }))
  expect(view.actions.onChat).toHaveBeenCalledTimes(1)
  expect(view.actions.onChat).toHaveBeenCalledWith('master-node')
})

it('refreshes another client’s saved Master and membership with bounded visible-only reads', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const wire = install()
  const view = mount()
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Saved Master Master' })).toBeVisible())
  wire.replaceMaster()
  await act(async () => { await vi.advanceTimersByTimeAsync(29_000) })
  expect(wire.hierarchyReads).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Saved Orchestrator Master' })).toBeVisible())
  expect(wire.hierarchyReads).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Ask master' }))
  expect(view.actions.onChat).toHaveBeenLastCalledWith('orchestrator-node')
  fireEvent.click(screen.getByRole('button', { name: 'View branch · 1' }))
  expect(screen.getByRole('region', { name: 'Reports to Saved Master' })).toHaveTextContent('Saved Worker')
  view.rerender(<QueryClientProvider client={view.client}>
    <MasterOverview {...scope} {...view.actions} visible={false} />
  </QueryClientProvider>)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(wire.hierarchyReads).toHaveLength(2)
  expect(wire.reportReads).toEqual([])
  expect(ReportSource.instances).toEqual([])
})

it('refreshes the newest history on reopen and fills new cursor gaps without losing older pages or selection', async () => {
  const wire = install()
  const current = wire.report(1, 'master-node')
  const report = (round: number): HierarchyReport => ({ ...current, id: `round-${round}`,
    summary: `Round ${round} summary`, parentRequestId: `request-round-${round}`,
    execution: { ...current.execution, executionId: `execution-round-${round}`, attempt: round },
    updatedAt: `2026-10-0${round}T00:00:00Z`,
  })
  let latestRound = 2
  const reads: (string | null)[] = []
  server.use(http.get(`${path}/reports`, ({ request }) => {
    const query = new URL(request.url).searchParams
    if (!query.has('workflowNodeId')) return HttpResponse.json({ ...scope, runId: 'past-run',
      workflowVersionId: 'past-version', items: [current], nextCursor: null, hasMore: false, revision: latestRound })
    const cursor = query.get('cursor')
    reads.push(cursor)
    const round = cursor === 'older-window' ? 1 : cursor === 'missing-round' ? 3 : latestRound
    const nextCursor = round === 1 ? null : round === 4 ? 'missing-round' : 'older-window'
    return HttpResponse.json({ ...scope, runId: 'past-run', workflowVersionId: 'past-version',
      items: [report(round)], nextCursor, hasMore: nextCursor !== null, revision: latestRound })
  }))
  const view = mount('past-run')
  await screen.findByText('Accepted child summary')
  await userEvent.click(screen.getByRole('button', { name: 'Report history' }))
  let dialog = await screen.findByRole('dialog', { name: 'Saved Orchestrator · Report history' })
  await within(dialog).findByText('Round 2 summary')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Load earlier reports' }))
  await within(dialog).findByText('Round 1 summary')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Close report history' }))
  latestRound = 4
  await userEvent.click(screen.getByRole('button', { name: 'Report history' }))
  dialog = await screen.findByRole('dialog', { name: 'Saved Orchestrator · Report history' })
  await within(dialog).findByText('Round 4 summary')
  expect(within(dialog).getByText('Round 1 summary')).toBeVisible()
  expect(within(dialog).getByText('Round 2 summary')).toBeVisible()
  expect(reads).toEqual([null, 'older-window', null])
  await userEvent.click(within(dialog).getByRole('button', { name: /request-round-1/ }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Load earlier reports' }))
  await within(dialog).findByText('Round 3 summary')
  expect(reads).toEqual([null, 'older-window', null, 'missing-round'])
  expect(within(dialog).getByRole('button', { name: /request-round-1/ })).toHaveAttribute('aria-pressed', 'true')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Refresh reports' }))
  await waitFor(() => expect(reads).toEqual([null, 'older-window', null, 'missing-round', null]))
  expect(within(dialog).getByRole('button', { name: /request-round-1/ })).toHaveAttribute('aria-pressed', 'true')
  expect(within(dialog).getByRole('list', { name: 'Report rounds' })).toHaveTextContent('Round 3 summary')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Show execution' }))
  expect(view.actions.onReport).toHaveBeenLastCalledWith(report(1))
})

it('offers explicit Master authoring for a saved workflow with no hierarchy', async () => {
  const wire = install({ noHierarchy: true }), view = mount()
  await screen.findByRole('heading', { name: 'No Master in this workflow' })
  expect(view.actions.onChooseMaster).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Choose Master' }))
  expect(view.actions.onChooseMaster).toHaveBeenCalledOnce()
  expect(view.actions.onCurrentWorkflow).not.toHaveBeenCalled()
  expect(wire.reportReads).toEqual([])
  expect(ReportSource.instances).toEqual([])
})

it('keeps a historical No Master selection until the person chooses Current workflow', async () => {
  const wire = install({ noHierarchy: true }), view = mount('past-run')
  await screen.findByRole('heading', { name: 'No Master in this Run' })
  expect(view.actions.onCurrentWorkflow).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Choose Master' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Current workflow' }))
  expect(view.actions.onCurrentWorkflow).toHaveBeenCalledOnce()
  expect(view.actions.onChooseMaster).not.toHaveBeenCalled()
  expect(wire.hierarchyReads[0]!.searchParams.get('runId')).toBe('past-run')
  expect(wire.reportReads).toEqual([])
  expect(ReportSource.instances).toEqual([])
})

it('reads only direct children before expansion and opens the exact historical execution', async () => {
  const wire = install(), view = mount('past-run')
  await screen.findByText('Accepted child summary')
  expect(wire.hierarchyReads[0]!.searchParams.get('runId')).toBe('past-run')
  expect(wire.reportReads).toHaveLength(1)
  expect(wire.reportReads[0]!.searchParams.get('parentNodeId')).toBe('master-node')
  expect(wire.reportReads[0]!.searchParams.get('limit')).toBe('50')
  expect(screen.queryByText(/Saved Worker/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'View report' }))
  expect(await screen.findByRole('dialog', { name: 'Team report' })).toHaveTextContent('past-request-1')
  expect(screen.getByRole('region', { name: 'Selected immutable report' })).toHaveTextContent('orchestrator-agent-historical')
  await userEvent.click(screen.getByRole('button', { name: 'Open card linked-card' }))
  expect(view.actions.onCard).toHaveBeenCalledWith('linked-card', wire.report(1, 'master-node'))
  await userEvent.click(screen.getByRole('button', { name: 'Show execution' }))
  expect(view.actions.onReport).toHaveBeenCalledWith(wire.report(1, 'master-node'))
  await userEvent.click(screen.getByRole('button', { name: 'View branch · 1' }))
  await screen.findByText('Needs a decision')
  expect(wire.reportReads).toHaveLength(2)
  expect(wire.reportReads[1]!.searchParams.get('parentNodeId')).toBe('orchestrator-node')
  expect(ReportSource.instances).toHaveLength(1)
  view.unmount()
  expect(ReportSource.instances[0]!.closed).toBe(true)
})

it('refreshes once per committed cursor and hides protected stale reports after denial', async () => {
  const wire = install(); mount('past-run')
  await screen.findByText('Accepted child summary')
  await waitFor(() => expect(ReportSource.instances).toHaveLength(1))
  const source = ReportSource.instances[0]!
  act(() => source.change(2))
  await waitFor(() => expect(wire.reportReads).toHaveLength(2))
  act(() => source.change(2))
  expect(wire.reportReads).toHaveLength(2)
  act(() => source.dispatchEvent(new Event('error')))
  expect(await screen.findByText('Connection lost · showing saved status')).toBeInTheDocument()
  expect(screen.getByText(/Last updated/)).toBeInTheDocument()
  wire.deny()
  act(() => source.dispatchEvent(new MessageEvent('unavailable', { data: '{}' })))
  await screen.findByText('Reports are no longer available with your access.')
  expect(screen.queryByText('Accepted child summary')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Saved Master Master' })).toBeInTheDocument()
  expect(source.closed).toBe(true)
})

it('shows No reports yet only after a successful empty response', async () => {
  const pending = deferred<void>()
  install({ reports: 'empty', waitForReports: pending.promise }); mount('past-run')
  await screen.findByText('Loading report…')
  expect(screen.queryByText('No reports yet')).not.toBeInTheDocument()
  pending.resolve()
  await screen.findByText('No reports yet')
  expect(screen.queryByText('Loading report…')).not.toBeInTheDocument()
})

it('distinguishes an unavailable first report read from a verified empty result', async () => {
  install({ reports: 'error' }); mount('past-run')
  await screen.findByText('Reports unavailable')
  expect(screen.queryByText('No reports yet')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
})

it('retains permitted last-known hierarchy on refresh failure', async () => {
  const wire = install(), view = mount('past-run')
  await screen.findByText('Accepted child summary')
  wire.failHierarchy()
  await act(() => view.client.invalidateQueries({ queryKey: hierarchyKey({ ...scope, runId: 'past-run' }), exact: true }))
  await screen.findByText('Couldn’t refresh the hierarchy.')
  expect(screen.getByRole('heading', { name: 'Saved Master Master' })).toBeInTheDocument()
  expect(screen.getByText('Accepted child summary')).toBeInTheDocument()
})

it('reauthorizes hierarchy and reports after the server closes an unavailable stream', async () => {
  const wire = install(); mount('past-run')
  await screen.findByText('Accepted child summary')
  await waitFor(() => expect(ReportSource.instances).toHaveLength(1))
  const source = ReportSource.instances[0]!
  wire.denyAll()
  act(() => source.dispatchEvent(new MessageEvent('unavailable', { data: '{}' })))
  await screen.findByText('Overview is no longer available with your access.')
  expect(screen.queryByRole('heading', { name: 'Saved Master Master' })).not.toBeInTheDocument()
  expect(screen.queryByText('Accepted child summary')).not.toBeInTheDocument()
  expect(source.closed).toBe(true)
})

const sourceExecution = { runId: 'past-run', workflowVersionId: 'past-version', executionId: 'master-source',
  activationId: 'master-source-activation', attempt: 1 }
const heldExecution = { ...sourceExecution, executionId: 'master-held', activationId: 'master-held-activation' }
const latestDeliverable = { execution: sourceExecution, resultDigest: `sha256:${'a'.repeat(64)}` }

it('keeps a findings wait nonfinal and sends both Continue and Ask master to the real held execution', async () => {
  install({ coordination: { state: 'waiting_for_direction', summary: 'Choose the supported release target.',
    sourceExecution, latestDeliverable, direction: { directionId: 'direction-1',
      activationId: heldExecution.activationId, execution: heldExecution } } })
  const view = mount('past-run')
  await screen.findByRole('heading', { name: 'Waiting for direction' })
  expect(screen.queryByRole('button', { name: 'Read final answer' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Continue with direction' }))
  await userEvent.click(screen.getByRole('button', { name: 'Ask master' }))
  expect(view.actions.onChat.mock.calls).toEqual([['master-node', heldExecution], ['master-node', heldExecution]])
  await userEvent.click(screen.getByRole('button', { name: 'Read latest deliverable' }))
  expect(view.actions.onExecution).toHaveBeenCalledWith(expect.objectContaining({ workflowNodeId: 'master-node',
    configurationVersionId: 'master-agent-historical' }), sourceExecution)
})

it('offers the final answer only for the authoritative completed root projection', async () => {
  install({ coordination: { state: 'succeeded', summary: 'All requested work is accepted.', sourceExecution, latestDeliverable } })
  const view = mount('past-run')
  await screen.findByRole('heading', { name: 'Completed' })
  expect(screen.queryByRole('button', { name: 'Continue with direction' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Read final answer' }))
  expect(view.actions.onExecution).toHaveBeenCalledWith(expect.objectContaining({ workflowNodeId: 'master-node' }), sourceExecution)
})

it('updates root completion and direction release when the child report revision stays unchanged', async () => {
  const wire = install({ coordination: { state: 'waiting_for_direction', summary: 'A decision is needed.',
    sourceExecution, latestDeliverable, direction: { directionId: 'direction-1',
      activationId: heldExecution.activationId, execution: heldExecution } } })
  mount('past-run')
  await screen.findByRole('heading', { name: 'Waiting for direction' })
  await waitFor(() => expect(ReportSource.instances).toHaveLength(1))
  const source = ReportSource.instances[0]!
  act(() => source.change(1, 'a'.repeat(64)))
  await waitFor(() => expect(wire.hierarchyReads).toHaveLength(2))
  wire.setCoordination({ state: 'active', summary: 'Accepted direction; continuing.', sourceExecution, latestDeliverable })
  act(() => source.change(1, 'b'.repeat(64)))
  await screen.findByText('Accepted direction; continuing.')
  expect(screen.queryByRole('button', { name: 'Continue with direction' })).not.toBeInTheDocument()
  wire.setCoordination({ state: 'succeeded', summary: 'Final accepted work.', sourceExecution, latestDeliverable })
  act(() => source.change(1, 'c'.repeat(64)))
  await screen.findByRole('button', { name: 'Read final answer' })
  const reads = wire.hierarchyReads.length
  act(() => source.change(1, 'c'.repeat(64)))
  expect(wire.hierarchyReads).toHaveLength(reads)
  expect(wire.reportReads.every(url => url.searchParams.get('parentNodeId') === 'master-node')).toBe(true)
})

it('loads earlier rounds only for the selected node and retains exact selection and scroll during live refresh', async () => {
  const wire = install(), historyReads: URL[] = []
  const current = wire.report(1, 'master-node')
  const earlier = (number: number): HierarchyReport => ({ ...current, id: `old-report-${number}`,
    parentRequestId: `old-request-${number}`, summary: `Earlier round ${number}`,
    execution: { ...current.execution, executionId: `old-execution-${number}`, activationId: `old-activation-${number}`, attempt: number },
    updatedAt: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z` })
  server.use(http.get(`${path}/reports`, ({ request }) => {
    const url = new URL(request.url)
    if (!url.searchParams.has('workflowNodeId')) {
      wire.reportReads.push(url)
      return HttpResponse.json({ ...scope, runId: 'past-run', workflowVersionId: 'past-version', items: [current],
        nextCursor: null, hasMore: false, revision: 7 })
    }
    historyReads.push(url)
    return HttpResponse.json({ ...scope, runId: 'past-run', workflowVersionId: 'past-version',
      items: url.searchParams.has('cursor') ? [earlier(1)] : [current, earlier(2)],
      nextCursor: url.searchParams.has('cursor') ? null : 'retained-window-cursor',
      hasMore: !url.searchParams.has('cursor'), revision: 7 })
  }))
  const view = mount('past-run')
  await screen.findByText('Accepted child summary')
  expect(historyReads).toHaveLength(0)
  await userEvent.click(screen.getByRole('button', { name: 'Report history' }))
  const dialog = await screen.findByRole('dialog', { name: 'Saved Orchestrator · Report history' })
  await within(dialog).findByText('Earlier round 2')
  expect(historyReads[0]!.searchParams.get('workflowNodeId')).toBe('orchestrator-node')
  expect(historyReads[0]!.searchParams.get('limit')).toBe('20')
  expect(historyReads[0]!.searchParams.has('parentNodeId')).toBe(false)
  await userEvent.click(within(dialog).getByRole('button', { name: /old-request-2/ }))
  const rounds = within(dialog).getByRole('list', { name: 'Report rounds' })
  rounds.scrollTop = 120
  await userEvent.click(within(dialog).getByRole('button', { name: 'Load earlier reports' }))
  await within(dialog).findByText('Earlier round 1')
  expect(historyReads[1]!.searchParams.get('cursor')).toBe('retained-window-cursor')
  expect(rounds.scrollTop).toBe(120)
  expect(within(dialog).getByRole('button', { name: /old-request-2/ })).toHaveAttribute('aria-pressed', 'true')
  act(() => ReportSource.instances[0]!.change(8))
  await waitFor(() => expect(wire.reportReads).toHaveLength(2))
  expect(historyReads).toHaveLength(2)
  expect(rounds.scrollTop).toBe(120)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Show execution' }))
  expect(view.actions.onReport).toHaveBeenCalledWith(earlier(2))
  expect(screen.queryByRole('dialog', { name: 'Saved Orchestrator · Report history' })).not.toBeInTheDocument()
})

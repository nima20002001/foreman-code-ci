import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunActivityPublicSchema, type RepeatGraphScopeV3, type RunActivitiesPage,
  type RunActivityPublic } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { Activities } from './Activities'
import { runActivitiesKey, type RunActivityFeed } from './runActivitiesQuery'
import { deferred } from '../../test/deferred'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a',
  workflowVersionId: 'version-a', runId: 'run-a', executionSemanticsVersion: 3 }
const agent = { agentId: 'agent-builder', agentName: 'Builder', nodeId: 'agent-node', nodeName: 'Agent node' }
const job = { kind: 'job' as const, nodeId: 'job-node', nodeName: 'Build release',
  jobDefinitionId: 'agent-builder', jobDefinitionRevision: 2, jobDefinitionVersionId: 'job-version' }
const event = (sequence: string, summary: string, participants: Pick<RunActivityPublic, 'actor' | 'subject'>,
  kind: RunActivityPublic['kind'] = 'job_work') => RunActivityPublicSchema.parse({
  id: `activity-${sequence}`, scope, sequence, occurredAt: '2026-10-01T12:00:00.000Z',
  source: 'backend', kind, status: 'recorded', severity: 'info', summary, refs: {}, ...participants,
})
const items = [
  event('1', 'Job ran', { actor: job }),
  event('2', 'Agent worked', { actor: agent }, 'agent_work'),
  event('3', 'Job notified Agent', { actor: job, subject: agent }, 'work_notice'),
  event('4', 'Job was queued', { subject: job }),
  event('5', 'Run recorded', {}, 'run'),
]
const clients: QueryClient[] = []
let reads = 0

async function mount({ timed = false, expectedText = 'Job ran', focusAgentId = undefined as string | undefined } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema, component: () => <Activities scope={scope} focusAgentId={focusAgentId} /> })
  const router = createRouter({ routeTree: root.addChildren([route]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-a?workflowId=workflow-a&selectedRunId=run-a'] }) })
  await router.load()
  if (timed) vi.useFakeTimers()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await act(async () => { await vi.waitFor(() => expect(screen.getByText(expectedText)).toBeVisible()) })
  return router
}

const activitiesPath = '*/api/management/workspaces/workspace-a/runs/run-a/activities'
function page(overrides: Partial<RunActivitiesPage> = {}): RunActivitiesPage {
  return { scope, items, mode: 'initial', highWater: '5', retainedFrom: '1',
    nextCursor: 'cursor-5', olderCursor: 'older-1', hasMore: false, ...overrides }
}
function cachedFeed() {
  return clients.at(-1)!.getQueryData<RunActivityFeed>(runActivitiesKey(scope))
}
async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}
async function eventually(assertion: () => void) {
  await act(async () => { await vi.waitFor(assertion) })
}

beforeEach(() => {
  reads = 0
  server.use(http.get('*/api/management/workspaces/workspace-a/runs/run-a/activities', () => {
    reads++
    return HttpResponse.json({ scope, items, mode: 'initial', highWater: '5', retainedFrom: '1',
      nextCursor: 'cursor-5', olderCursor: null, hasMore: false })
  }))
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.useRealTimers()
})

describe('Activities shared Agent and Job actors', () => {
  it('renders CI lifecycle, partition and computer details under the initiating Agent without merging tickets', async () => {
    const ci = { id: '00000000-0000-4000-8000-000000000001',
      groupId: '00000000-0000-4000-8000-000000000002', suite: 'integration' as const,
      part: null, partition: { index: 0, count: 2 }, state: 'running' as const,
      computer: { hostRef: { kind: 'main' as const, mainId: 'synthetic-main' }, label: 'Build computer' },
      step: 'integration', exitCode: null, queuedAt: '2026-10-01T12:00:00.000Z',
      startedAt: '2026-10-01T12:00:01.000Z', finishedAt: null }
    const ciItems = ['1', '2'].map((sequence, index) => RunActivityPublicSchema.parse({
      ...event(sequence, 'CI integration running', { actor: agent }), status: 'running',
      refs: { executionId: 'agent-execution', ciTicketId: index === 0 ? ci.id : ci.groupId, ciGroupId: ci.groupId },
      ci: { ...ci, id: index === 0 ? ci.id : ci.groupId, partition: { index, count: 2 } },
    }))
    server.use(http.get(activitiesPath, () => HttpResponse.json(page({ items: ciItems }))))
    await mount({ expectedText: 'Partition 1 of 2 · Build computer · integration' })
    expect(screen.getAllByText('CI integration running')).toHaveLength(2)
    expect(screen.getByText('Partition 2 of 2 · Build computer · integration')).toBeVisible()
    for (const row of screen.getAllByRole('listitem')) expect(within(row).getByText('Builder')).toBeVisible()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), agent.agentId)
    expect(screen.getAllByText('CI integration running')).toHaveLength(2)
  })
  it('shows recorded results and remaining findings on needs-direction rows', async () => {
    const workResult = { outcome: 'done', latestDeliverable: 'Implemented the requested change',
      remainingFindings: ['Review needs a decision', { message: 'One finding remains' }] }
    const resultItems = [
      { ...event('1', 'Work result recorded', { actor: agent }, 'agent_work'), workResult },
      { ...event('2', 'Work needs direction', { actor: agent }, 'needs_direction'), workResult },
    ]
    server.use(http.get(activitiesPath, () => HttpResponse.json(page({ items: resultItems }))))
    await mount({ expectedText: 'Work result recorded' })
    for (const item of resultItems) {
      const row = within(screen.getByText(item.summary).closest('li')!)
      expect(row.getByText('Outcome: done')).toBeVisible()
      expect(row.getByText('Implemented the requested change')).toBeVisible()
      expect(row.getByText('Review needs a decision')).toBeVisible()
      expect(row.getByText(/One finding remains/)).toBeVisible()
    }
  })

  it('renders readable native summaries and safe details from the shared Activities response', async () => {
    const nativeItems = [
      { ...event('1', 'Command: git completed', { actor: agent }, 'tool_action'), detail: 'Exit code: 0.' },
      { ...event('2', 'File change completed', { actor: agent }, 'tool_action'), detail: 'Changes cover 2 files.' },
      { ...event('3', 'Agent message completed', { actor: agent }, 'agent_work'), detail: 'Progress update.' },
      { ...event('4', 'Agent message updated', { actor: agent }, 'tool_log'), detail: 'Received 15 characters.' },
      event('5', 'Tool: workspace_list completed', { actor: agent }, 'tool_action'),
    ]
    server.use(http.get(activitiesPath, () => HttpResponse.json(page({ items: nativeItems }))))
    await mount({ expectedText: 'Command: git completed' })
    for (const item of nativeItems) {
      const row = screen.getByText(item.summary).closest('li')!
      expect(within(row).getByText('Builder')).toBeVisible()
      if (item.detail) expect(within(row).getByText(item.detail)).toBeVisible()
    }
    expect(screen.queryByText('Native activity recorded; details unavailable')).not.toBeInTheDocument()
  })

  it('folds consecutive identical rows and focuses one Agent without its filters', async () => {
    const repeated = [1, 2, 3].map((index) => ({ ...event(String(index), 'Subagent: Command: bash completed', { actor: agent }, 'tool_action'), detail: 'Exit code: 0.' }))
    server.use(http.get(activitiesPath, () => HttpResponse.json(page({ items: [...repeated, event('4', 'Job ran', { actor: job }), event('5', 'Agent worked', { actor: agent }, 'agent_work')] }))))
    await mount({ expectedText: 'Agent worked', focusAgentId: agent.agentId })
    const row = screen.getByText('Subagent: Command: bash completed').closest('li')!
    expect(row).toHaveTextContent('×3')
    expect(screen.getAllByText('Subagent: Command: bash completed')).toHaveLength(1)
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    expect(within(row).queryByText('Builder')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Agent' })).not.toBeInTheDocument()
  })
  it('keeps approvals in their Agent filter and renders uncertainty and cancellation', async () => {
    const other = { agentId: 'agent-reviewer', agentName: 'Reviewer', nodeId: 'reviewer-node', nodeName: 'Reviewer' }
    const approval = RunActivityPublicSchema.parse({
      ...event('6', 'Approval delivery uncertain', { actor: agent }, 'approval'),
      status: 'unknown', severity: 'warning', refs: { executionId: 'builder-execution', interactionId: 'builder-approval' },
    })
    const canceled = RunActivityPublicSchema.parse({
      ...event('7', 'Approval canceled', { actor: other }, 'approval'),
      status: 'canceled', refs: { executionId: 'reviewer-execution', interactionId: 'reviewer-approval' },
    })
    server.use(http.get(activitiesPath, () => HttpResponse.json(page({
      items: [items[4]!, approval, canceled], highWater: '7', nextCursor: 'cursor-7',
    }))))
    await mount({ expectedText: 'Approval delivery uncertain' })
    const uncertainRow = screen.getByText('Approval delivery uncertain').closest('li')!
    expect(within(uncertainRow).getByText('Builder')).toBeVisible()
    expect(within(uncertainRow).getByText('unknown')).toHaveClass('is-warning')
    expect(within(screen.getByText('Approval canceled').closest('li')!).getByText('canceled')).toBeVisible()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), agent.agentId)
    await waitFor(() => expect(screen.queryByText('Approval canceled')).not.toBeInTheDocument())
    expect(screen.getByText('Approval delivery uncertain')).toBeVisible()
    expect(screen.queryByText('Run recorded')).not.toBeInTheDocument()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), other.agentId)
    await waitFor(() => expect(screen.queryByText('Approval delivery uncertain')).not.toBeInTheDocument())
    expect(screen.getByText('Approval canceled')).toBeVisible()
  })

  it('labels Job actors and subjects while listing only true Agents in the Agent filter', async () => {
    await mount()
    for (const summary of ['Job ran', 'Job notified Agent', 'Job was queued']) {
      const row = screen.getByText(summary).closest('li')!
      expect(within(row).getByText('Job · Build release')).toBeVisible()
      expect(within(row).queryByText('Workflow')).not.toBeInTheDocument()
    }
    expect(within(screen.getByText('Agent worked').closest('li')!).getByText('Builder')).toBeVisible()
    expect(within(screen.getByText('Run recorded').closest('li')!).getByText('Workflow')).toBeVisible()
    const options = within(screen.getByRole('combobox', { name: 'Agent' }))
    expect(options.getByRole('option', { name: /^Builder$/ })).toHaveValue(agent.agentId)
    expect(options.queryByRole('option', { name: /Build release/ })).not.toBeInTheDocument()
  })

  it('matches real Agent actors or subjects without treating a Job definition ID as an Agent ID', async () => {
    const router = await mount()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), agent.agentId)
    await waitFor(() => expect(screen.queryByText('Job ran')).not.toBeInTheDocument())
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(screen.getByText('Job notified Agent')).toBeVisible()
    expect(screen.queryByText('Job was queued')).not.toBeInTheDocument()
    expect(screen.queryByText('Run recorded')).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ activityAgentId: agent.agentId, selectedRunId: 'run-a', workflowId: 'workflow-a' })
  })

  it('keeps the existing kind filter and refresh action usable for Job activity', async () => {
    const router = await mount()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Activity kind' }), 'job_work')
    await waitFor(() => expect(screen.queryByText('Agent worked')).not.toBeInTheDocument())
    expect(screen.getByText('Job ran')).toBeVisible()
    expect(screen.getByText('Job was queued')).toBeVisible()
    const previous = reads
    await userEvent.click(screen.getByRole('button', { name: 'Refresh Activities' }))
    await waitFor(() => expect(reads).toBeGreaterThan(previous))
    expect(await screen.findByText('Job ran')).toBeVisible()
    expect(router.state.location.search).toMatchObject({ activityKind: 'job_work', selectedRunId: 'run-a' })
  })
})

describe('Activities pagination and refresh', () => {
  it('merges refreshed events while retaining all loaded older pages and their cursor', async () => {
    const history = Array.from({ length: 150 }, (_, index) => event(String(index + 1), `Work ${index + 1}`, {}))
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor === 'older-101') return HttpResponse.json(page({ items: history.slice(50, 100),
        mode: 'older', highWater: '150', nextCursor: 'cursor-150', olderCursor: 'older-51' }))
      if (cursor === 'cursor-150') return HttpResponse.json(page({ items: [event('151', 'New work', {})],
        mode: 'newer', highWater: '151', nextCursor: 'cursor-151', olderCursor: null }))
      if (cursor === 'older-51') return HttpResponse.json(page({ items: history.slice(0, 50),
        mode: 'older', highWater: '151', nextCursor: 'cursor-151', olderCursor: null }))
      return HttpResponse.json(page({ items: history.slice(100), highWater: '150',
        nextCursor: 'cursor-150', olderCursor: 'older-101' }))
    }))
    await mount({ expectedText: 'Work 101' })
    const region = screen.getByRole('region', { name: 'Activities' })
    const user = userEvent.setup()
    expect(within(region).getAllByRole('listitem')).toHaveLength(50)
    await user.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(100))
    await user.click(screen.getByRole('button', { name: 'Refresh Activities' }))
    expect(await screen.findByText('New work')).toBeVisible()
    expect(within(region).getAllByRole('listitem')).toHaveLength(101)
    expect(screen.getByText('Work 51')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(151))
    expect(screen.getByText('Work 1')).toBeVisible()
  })

  it('finishes a pending poll before accepting an older-page read', async () => {
    const poll = deferred<RunActivitiesPage>()
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, async ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      if (cursor === 'cursor-5') return HttpResponse.json(await poll.promise)
      if (cursor === 'older-1') return HttpResponse.json(page({ items: [event('1', 'Earlier work', {})],
        mode: 'older', olderCursor: null }))
      return HttpResponse.json(page({ items: items.slice(1) }))
    }))
    await mount({ timed: true, expectedText: 'Agent worked' })
    await advance(3000)
    await eventually(() => expect(requests).toEqual([null, 'cursor-5']))
    const more = screen.getByRole('button', { name: 'Load older Activities' })
    expect(more).toBeDisabled()
    fireEvent.click(more)
    expect(requests).toEqual([null, 'cursor-5'])
    poll.resolve(page({ items: [event('6', 'New work', {})], mode: 'newer', highWater: '6',
      nextCursor: 'cursor-6', olderCursor: null }))
    await eventually(() => expect(more).toBeEnabled())
    fireEvent.click(more)
    await eventually(() => expect(screen.getByText('Earlier work')).toBeVisible())
    expect(screen.getByText('New work')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', olderCursor: null, retainedFrom: '1' })
    expect(cachedFeed()?.items.map((item) => item.sequence)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it('waits for an older page cache write before polling the merged feed', async () => {
    const olderPage = deferred<RunActivitiesPage>()
    const poll = deferred<RunActivitiesPage>()
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, async ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      if (cursor === 'older-1') return HttpResponse.json(await olderPage.promise)
      if (cursor === 'cursor-5') return HttpResponse.json(await poll.promise)
      return HttpResponse.json(page({ items: items.slice(1) }))
    }))
    await mount({ timed: true, expectedText: 'Agent worked' })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(requests).toEqual([null, 'older-1']))
    await advance(3000)
    expect(requests).toEqual([null, 'older-1'])
    olderPage.resolve(page({ items: [event('1', 'Earlier work', {})], mode: 'older', olderCursor: null }))
    await eventually(() => expect(requests).toEqual([null, 'older-1', 'cursor-5']))
    expect(screen.getByText('Earlier work')).toBeVisible()
    poll.resolve(page({ items: [event('6', 'New work', {})], mode: 'newer', highWater: '6',
      nextCursor: 'cursor-6', olderCursor: null }))
    await eventually(() => expect(screen.getByText('New work')).toBeVisible())
    expect(screen.getByText('Earlier work')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', olderCursor: null, retainedFrom: '1' })
    expect(cachedFeed()?.items.map((item) => item.sequence)).toEqual(['1', '2', '3', '4', '5', '6'])
  })

  it.each(['older first', 'refresh first'] as const)(
    'fences an older response from Refresh with %s response order', async (order) => {
      const olderPage = deferred<RunActivitiesPage>()
      const refreshed = deferred<RunActivitiesPage>()
      let initialReads = 0
      let olderReads = 0
      server.use(http.get(activitiesPath, async ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') === 'older-1') {
          olderReads++
          return HttpResponse.json(await olderPage.promise)
        }
        initialReads++
        return HttpResponse.json(initialReads === 1 ? page() : await refreshed.promise)
      }))
      await mount({ timed: true })
      fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
      await eventually(() => expect(olderReads).toBe(1))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh Activities' }))
      await eventually(() => expect(initialReads).toBe(2))
      const stale = page({ items: [event('1', 'Stale older work', {})], mode: 'older',
        olderCursor: 'stale-older', retainedFrom: '1' })
      const fresh = page({ items: [event('6', 'Refreshed work', {})], highWater: '6', retainedFrom: '6',
        olderCursor: null, nextCursor: 'fresh-next' })
      if (order === 'older first') {
        olderPage.resolve(stale)
        await advance(0)
        refreshed.resolve(fresh)
      } else {
        refreshed.resolve(fresh)
        await eventually(() => expect(screen.getByText('Refreshed work')).toBeVisible())
        olderPage.resolve(stale)
      }
      await eventually(() => expect(screen.getByText('Refreshed work')).toBeVisible())
      await advance(0)
      expect(screen.queryByText('Stale older work')).not.toBeInTheDocument()
      expect(cachedFeed()).toMatchObject({ items: fresh.items, nextCursor: 'fresh-next',
        olderCursor: null, retainedFrom: '6' })
    },
  )

  it('retires an older cursor after a poll advances retention while keeping retained rows', async () => {
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      return HttpResponse.json(cursor ? page({ items: [event('6', 'New retained work', {})],
        mode: 'newer', highWater: '6', retainedFrom: '2', nextCursor: 'cursor-6', olderCursor: null }) : page())
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(screen.getByText('New retained work')).toBeVisible())
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load older Activities' })).not.toBeInTheDocument()
    expect(requests).toEqual([null, 'cursor-5'])
    expect(cachedFeed()).toMatchObject({ olderCursor: null, nextCursor: 'cursor-6', retainedFrom: '2' })
  })

  it('keeps the current feed visible when its historical cursor expires before the next poll', async () => {
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor === 'older-1') return new HttpResponse(null, { status: 410 })
      return HttpResponse.json(cursor ? page({ items: [event('6', 'Continued work', {})], mode: 'newer',
        highWater: '6', nextCursor: 'cursor-6', retainedFrom: '2', olderCursor: null }) : page())
    }))
    await mount({ timed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(screen.getByText('Activity history has a retention gap.')).toBeVisible())
    expect(screen.getByText('Job ran')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Load older Activities' })).not.toBeInTheDocument()
    await advance(3000)
    await eventually(() => expect(screen.getByText('Continued work')).toBeVisible())
    expect(screen.getByText('Agent worked')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', olderCursor: null, retainedFrom: '2' })
  })

  it('refreshes from retained history after a cursor expires', async () => {
    let initialReads = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor) return new HttpResponse(null, { status: 410 })
      initialReads++
      return HttpResponse.json(initialReads === 1 ? page() : page({
        items: [event('6', 'Retained work', {})], highWater: '6', retainedFrom: '6',
        nextCursor: 'cursor-6', olderCursor: null,
      }))
    }))
    await mount()
    await userEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    expect(await screen.findByText('Activity history has a retention gap.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh Activities' }))
    expect(await screen.findByText('Retained work')).toBeVisible()
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    expect(screen.queryByText('Activity history has a retention gap.')).not.toBeInTheDocument()
    expect(initialReads).toBe(2)
  })
})

describe('Activities automatic recovery', () => {
  it('reports an exhausted older-page request separately from recovered live polling', async () => {
    let olderReads = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      if (cursor === 'older-1') {
        olderReads++
        if (olderReads <= 3) return new HttpResponse(null, { status: 503 })
        return HttpResponse.json(page({ items: [event('1', 'Recovered older work', {})],
          mode: 'older', olderCursor: null }))
      }
      return HttpResponse.json(cursor ? page({ items: [event('6', 'Live work', {})],
        mode: 'newer', highWater: '6', nextCursor: 'cursor-6', olderCursor: null }) : page({ items: items.slice(1) }))
    }))
    await mount({ timed: true, expectedText: 'Agent worked' })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(olderReads).toBe(1))
    await advance(1000)
    await eventually(() => expect(olderReads).toBe(2))
    await advance(2000)
    await eventually(() => expect(screen.getByText('Older Activities couldn’t be loaded.')).toBeVisible())
    await advance(3000)
    await eventually(() => expect(screen.getByText('Live work')).toBeVisible())
    expect(screen.queryByText('Refresh failed. Retrying automatically.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry older Activities' }))
    await eventually(() => expect(screen.getByText('Recovered older work')).toBeVisible())
    expect(screen.queryByText('Older Activities couldn’t be loaded.')).not.toBeInTheDocument()
    expect(olderReads).toBe(4)
  })

  it('retries one failed poll with backoff and recovers without navigation or browser events', async () => {
    let polls = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json(page())
      polls++
      if (polls === 1) return new HttpResponse(null, { status: 503 })
      return HttpResponse.json(page({ items: [event('6', 'Recovered work', {})], mode: 'newer',
        highWater: '6', nextCursor: 'cursor-6', olderCursor: null }))
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(polls).toBe(1))
    expect(screen.getByText('Job ran')).toBeVisible()
    await advance(500)
    expect(polls).toBe(1)
    await advance(500)
    await eventually(() => expect(screen.getByText('Recovered work')).toBeVisible())
    expect(polls).toBe(2)
    expect(screen.getByText('Job ran')).toBeVisible()
    expect(cachedFeed()).toMatchObject({ nextCursor: 'cursor-6', retainedFrom: '1' })
  })

  it('keeps loaded rows and automatic polling after exhausting a bounded retry cycle', async () => {
    let polls = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json(page())
      polls++
      if (polls <= 3) return new HttpResponse(null, { status: 503 })
      return HttpResponse.json(page({ items: [event('6', 'Service restored', {})], mode: 'newer',
        highWater: '6', nextCursor: 'cursor-6', olderCursor: null }))
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(polls).toBe(1))
    await advance(1000)
    await eventually(() => expect(polls).toBe(2))
    await advance(2000)
    await eventually(() => expect(screen.getByText('Refresh failed. Retrying automatically.')).toBeVisible())
    expect(polls).toBe(3)
    expect(screen.getByText('Job ran')).toBeVisible()
    await advance(3000)
    await eventually(() => expect(screen.getByText('Service restored')).toBeVisible())
    expect(screen.queryByText('Activities are unavailable.')).not.toBeInTheDocument()
  })

  it.each([401, 403, 404])('hides rows and stops polling after HTTP %s', async (status) => {
    let polls = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json(page())
      polls++
      return new HttpResponse(null, { status })
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(screen.queryByText('Job ran')).not.toBeInTheDocument())
    expect(polls).toBe(1)
    await advance(60_000)
    expect(polls).toBe(1)
  })

  it('hides rows and stops retrying a same-user response for another Run', async () => {
    let polls = 0
    server.use(http.get(activitiesPath, ({ request }) => {
      if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json(page())
      polls++
      return HttpResponse.json(page({ scope: { ...scope, runId: 'run-b' }, items: [] }))
    }))
    await mount({ timed: true })
    await advance(3000)
    await eventually(() => expect(screen.getByText('Activities are unavailable.')).toBeVisible())
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    await advance(60_000)
    expect(polls).toBe(1)
  })

  it('also withdraws loaded rows and automatic reads after an older-page denial', async () => {
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      return cursor ? new HttpResponse(null, { status: 403 }) : HttpResponse.json(page())
    }))
    await mount({ timed: true })
    fireEvent.click(screen.getByRole('button', { name: 'Load older Activities' }))
    await eventually(() => expect(screen.getByText('Activities access was withdrawn.')).toBeVisible())
    expect(screen.queryByText('Job ran')).not.toBeInTheDocument()
    await advance(60_000)
    expect(requests).toEqual([null, 'older-1'])
  })
})

describe('Activities idle polling cadence', () => {
  it.each([5, 50])('reduces polling for a completed Run left open with %s events', async (size) => {
    const history = Array.from({ length: size - 1 }, (_, index) =>
      event(String(index + 1), index === 0 ? 'Job ran' : `Work ${index + 1}`, {}))
    history.push({ ...event(String(size), 'Run completed', {}, 'run'), status: 'completed' })
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      return HttpResponse.json(page({ items: cursor ? [] : history, mode: cursor ? 'newer' : 'initial',
        highWater: String(size), nextCursor: `cursor-${size}`, olderCursor: null }))
    }))
    await mount({ timed: true })
    for (const [index, interval] of [3000, 6000, 12_000, 24_000, 48_000, 60_000].entries()) {
      await advance(interval)
      await eventually(() => {
        expect(cachedFeed()?.unchangedReads).toBe(Math.min(index + 1, 5))
        expect(requests).toHaveLength(index + 2)
      })
    }
    expect(requests).toEqual([null, ...Array(6).fill(`cursor-${size}`)])
    expect(screen.getByText('Run completed')).toBeVisible()
    expect(cachedFeed()?.items).toEqual(history)
  })

  it('returns to the active cadence after an event arrives during idle polling', async () => {
    let published = false
    const requests: Array<string | null> = []
    server.use(http.get(activitiesPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requests.push(cursor)
      if (!cursor) return HttpResponse.json(page({ olderCursor: null }))
      return HttpResponse.json(page({
        items: published && cursor === 'cursor-5' ? [event('6', 'New idle-period work', {})] : [],
        mode: 'newer', highWater: published ? '6' : '5', nextCursor: published ? 'cursor-6' : 'cursor-5',
        olderCursor: null,
      }))
    }))
    await mount({ timed: true })
    for (const [index, interval] of [3000, 6000, 12_000, 24_000, 48_000].entries()) {
      await advance(interval)
      await eventually(() => expect(cachedFeed()?.unchangedReads).toBe(index + 1))
    }
    published = true
    await advance(60_000)
    await eventually(() => expect(screen.getByText('New idle-period work')).toBeVisible())
    expect(cachedFeed()?.unchangedReads).toBe(0)
    const count = requests.length
    await advance(3000)
    await eventually(() => expect(requests).toHaveLength(count + 1))
    expect(requests.at(-1)).toBe('cursor-6')
  })
})

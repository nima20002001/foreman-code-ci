import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepLatestRunResponse, shareRunResponseOrSelection } from './runLiveCache'
import { makeSyntheticRun } from '../../features/graph/fixtures/scaleData'
import { selectGraphNodeActivity } from '../../features/graph/runtimeIndex'

const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }
const queryKey = ['graph-sharing-regression'] as const
const selectFirst = (response: GetRunResponse) => selectGraphNodeActivity(response, scope, 'synthetic-node-0', 'synthetic-agent-0')

afterEach(() => { vi.useRealTimers() })

describe('Run response and select-result structural sharing', () => {
  it('retains the existing stale, exact-bigint, terminal, cleanup, and version gates', () => {
    const current = makeSyntheticRun(2, '9007199254740993')
    expect(shareRunResponseOrSelection(current, makeSyntheticRun(2, '9007199254740992'))).toBe(current)
    const wrongVersion = structuredClone(current)
    wrongVersion.run.workflowVersionId = 'other'
    expect(shareRunResponseOrSelection(current, wrongVersion)).toBe(current)
    const terminal = { ...current, run: { ...current.run, executionState: 'completed' as const }, cleanupPending: true }
    expect(shareRunResponseOrSelection(terminal, current)).toBe(terminal)
    const settled = { ...terminal, cleanupPending: false,
      liveActivity: { ...terminal.liveActivity!, sequence: '9007199254740994', eventCount: '9007199254740994' } }
    expect(shareRunResponseOrSelection(settled, terminal)).toBe(settled)
    expect(shareRunResponseOrSelection(terminal, settled).cleanupPending).toBe(false)
    expect(keepLatestRunResponse(current, terminal)).toBe(terminal)
    const missing = { ...current, liveActivity: undefined }
    expect(shareRunResponseOrSelection(current, missing)).toBe(current)
  })

  it('shares unchanged nested records by ID, including reordering', () => {
    const before = makeSyntheticRun(3)
    const next = structuredClone(before)
    next.liveActivity!.sequence = '2'
    next.liveActivity!.eventCount = '2'
    next.liveActivity!.nodes[0] = { ...next.liveActivity!.nodes[0], state: 'working',
      action: { kind: 'reading_file', label: 'Reading file…' }, event: { id: 'event-2', sequence: '2' } }
    const shared = shareRunResponseOrSelection(before, next)
    expect(shared.run).toBe(before.run)
    expect(shared.activity).toBe(before.activity)
    expect(shared.executions).toBe(before.executions)
    expect(shared.liveActivity!.nodes[1]).toBe(before.liveActivity!.nodes[1])
    expect(shared.liveActivity!.nodes[0]).not.toBe(before.liveActivity!.nodes[0])
    const reordered = structuredClone(shared)
    reordered.liveActivity!.nodes.reverse()
    const again = shareRunResponseOrSelection(shared, reordered)
    expect(again.liveActivity!.nodes[0]).toBe(shared.liveActivity!.nodes[2])
    expect(shareRunResponseOrSelection(again, structuredClone(again))).toBe(again)
  })

  it('does not run full-response-only guards on scalars, undefined, or selected nodes', () => {
    expect(shareRunResponseOrSelection('old', 'new')).toBe('new')
    expect(shareRunResponseOrSelection(undefined, undefined)).toBeUndefined()
    const node = makeSyntheticRun(1).liveActivity!.nodes[0]
    expect(shareRunResponseOrSelection(node, { ...node })).toBe(node)
    expect(shareRunResponseOrSelection(node, undefined)).toBeUndefined()
    const otherRun = makeSyntheticRun(1)
    otherRun.run.id = 'new-run'
    expect(shareRunResponseOrSelection(makeSyntheticRun(1), otherRun)).toBe(otherRun)
  })

  it('exercises the installed QueryObserver select path, not a mocked implementation', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    client.setQueryData(queryKey, makeSyntheticRun(2))
    const nodeObserver = new QueryObserver<GetRunResponse, Error, RunNodeLiveActivity | undefined>(client, {
      queryKey, enabled: false, select: selectFirst, structuralSharing: shareRunResponseOrSelection,
    })
    const scalarObserver = new QueryObserver<GetRunResponse, Error, string>(client, {
      queryKey, enabled: false, select: (data) => data.run.executionState, structuralSharing: shareRunResponseOrSelection,
    })
    const unsubscribeNode = nodeObserver.subscribe(() => undefined)
    const unsubscribeScalar = scalarObserver.subscribe(() => undefined)
    try {
      const first = nodeObserver.getCurrentResult().data
      const next = makeSyntheticRun(2, '2')
      client.setQueryData(queryKey, next)
      expect(nodeObserver.getCurrentResult().data).toBe(first)
      expect(nodeObserver.getCurrentResult().error).toBeNull()
      expect(scalarObserver.getCurrentResult().data).toBe('running')
      expect(scalarObserver.getCurrentResult().error).toBeNull()
      next.run = { ...next.run, executionState: 'completed' }
      client.setQueryData(queryKey, { ...next })
      expect(scalarObserver.getCurrentResult().data).toBe('completed')
    } finally { unsubscribeNode(); unsubscribeScalar(); client.clear() }
  })

  it.each([1, 300, 500])('keeps one polling owner with %i cache-only node observers', async (count) => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    let sequence = 0
    const fetch = vi.fn(async () => makeSyntheticRun(count, String(++sequence)))
    const owner = new QueryObserver<GetRunResponse>(client, {
      queryKey, queryFn: fetch, refetchInterval: 1_000, refetchIntervalInBackground: true,
      structuralSharing: shareRunResponseOrSelection,
    })
    const unsubscribeOwner = owner.subscribe(() => undefined)
    const leaves = Array.from({ length: count }, (_, index) => new QueryObserver<GetRunResponse, Error, RunNodeLiveActivity | undefined>(client, {
      queryKey, enabled: false, refetchInterval: false, refetchOnMount: false, refetchOnReconnect: false,
      refetchOnWindowFocus: false, structuralSharing: shareRunResponseOrSelection,
      select: (data) => selectGraphNodeActivity(data, scope, `synthetic-node-${index}`, `synthetic-agent-${index}`),
    }))
    const cleanups = leaves.map((leaf) => leaf.subscribe(() => undefined))
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3_100)
      expect(fetch).toHaveBeenCalledTimes(4)
      unsubscribeOwner()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { unsubscribeOwner(); cleanups.forEach((dispose) => dispose()); client.clear() }
  })
})

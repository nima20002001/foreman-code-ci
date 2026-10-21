// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { RepeatGraphScopeV3, RunActivitiesPage, RunActivityPublic } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { ApiError } from '../../shared/api/client'
import { isTransientRunActivityError, mergeOlderRunActivities, mergeRunActivities,
  readRunActivities, readRunActivityFeed, runActivitiesRefetchInterval } from './runActivitiesQuery'

const scope: RepeatGraphScopeV3 = { workspaceId: 'workspace-a', workflowId: 'workflow-a',
  workflowVersionId: 'version-a', runId: 'run-a', executionSemanticsVersion: 3 }
const item = (sequence: string): RunActivityPublic => ({ id: `run-a:${sequence}`, scope,
  sequence, occurredAt: '2026-09-28T00:00:00.000Z', source: 'backend', kind: 'work_notice',
  status: 'delivered', severity: 'info', summary: 'Notice delivered', refs: {} })

describe('bounded public Run Activities client', () => {
  it.each([408, 429, 500, 503])('identifies HTTP %s as transient', (status) => {
    expect(isTransientRunActivityError(new ApiError({ code: 'HTTP_ERROR', message: 'Try again' }, status))).toBe(true)
  })
  it('identifies a transport failure as transient', () => {
    expect(isTransientRunActivityError(new ApiError({ code: 'NETWORK_ERROR', message: 'Offline' }))).toBe(true)
  })
  it.each([401, 403, 404, 409, 410])('does not retry HTTP %s as a transient failure', (status) => {
    expect(isTransientRunActivityError(new ApiError({ code: 'HTTP_ERROR', message: 'Read rejected' }, status))).toBe(false)
  })
  it('does not retry identity, contract, session, or cancellation errors', () => {
    expect(isTransientRunActivityError(new ApiError({ code: 'INVALID_RESPONSE', message: 'Wrong Run' }, 200))).toBe(false)
    expect(isTransientRunActivityError(new ApiError({ code: 'NETWORK_ERROR', message: 'No access' }, 403))).toBe(false)
    expect(isTransientRunActivityError(new DOMException('Selection changed', 'AbortError'))).toBe(false)
  })
  it('coalesces overlap, sorts out-of-order arrivals by full server sequence, and bounds memory', () => {
    const high = '9007199254740994', low = '9007199254740993'
    expect(mergeRunActivities([item(high)], [item(low), item(high)]).map((event) => event.sequence)).toEqual([low, high])
    expect(mergeRunActivities(Array.from({ length: 1000 }, (_, i) => item(String(i + 1))), [item('1001')]))
      .toHaveLength(1000)
    expect(() => mergeRunActivities([item('1')], [{ ...item('1'), id: 'changed-identity' }])).toThrow(/identity/)
  })

  it('rejects a same-user response for another Run before it reaches the Board', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () =>
      HttpResponse.json({ scope: { ...scope, runId: 'run-b' }, items: [], mode: 'initial',
        highWater: '0', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false })))
    await expect(readRunActivities(scope)).rejects.toThrow(/different Run/)
  })
  it('catches up through overlapping newer pages before exposing the next feed', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      const sequences = cursor === 'cursor-1' ? ['2', '3'] : ['3', '4']
      return HttpResponse.json({ scope, items: sequences.map(item), mode: 'newer',
        highWater: '4', retainedFrom: '1', nextCursor: cursor === 'cursor-1' ? 'cursor-2' : 'cursor-4',
        olderCursor: null, hasMore: cursor === 'cursor-1' })
    }))
    const feed = await readRunActivityFeed(scope, { items: [item('1')], olderCursor: null,
      nextCursor: 'cursor-1', retainedFrom: '1', unchangedReads: 4 })
    expect(feed.items.map((event) => event.sequence)).toEqual(['1', '2', '3', '4'])
    expect(feed.nextCursor).toBe('cursor-4')
    expect(feed.unchangedReads).toBe(0)
  })
  it('catches every byte-budgeted newer page through a frozen retained window', async () => {
    let reads = 0
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, ({ request }) => {
      const after = Number(new URL(request.url).searchParams.get('cursor')!.slice('cursor-'.length))
      const sequence = after + 1
      reads++
      return HttpResponse.json({ scope, items: [item(String(sequence))], mode: 'newer',
        highWater: '40', retainedFrom: '1', nextCursor: `cursor-${sequence}`,
        olderCursor: null, hasMore: sequence < 40 })
    }))
    const feed = await readRunActivityFeed(scope, { items: [item('1')], olderCursor: null,
      nextCursor: 'cursor-1', retainedFrom: '1', unchangedReads: 0 })
    expect(reads).toBe(39)
    expect(feed.items.map(event => event.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => String(index + 1)))
    expect(feed.nextCursor).toBe('cursor-40')
  })

  it('retires the older cursor when a newer read advances retention, without losing retained rows', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () =>
      HttpResponse.json({ scope, items: [item('4')], mode: 'newer', highWater: '4', retainedFrom: '2',
        nextCursor: 'cursor-4', olderCursor: null, hasMore: false })))
    const feed = await readRunActivityFeed(scope, { items: [item('1'), item('2'), item('3')],
      olderCursor: 'older-1', nextCursor: 'cursor-3', retainedFrom: '1', unchangedReads: 4 })
    expect(feed.items.map((event) => event.sequence)).toEqual(['2', '3', '4'])
    expect(feed).toMatchObject({ olderCursor: null, nextCursor: 'cursor-4', retainedFrom: '2', unchangedReads: 0 })
  })

  it('preserves the older cursor while retention is unchanged', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () =>
      HttpResponse.json({ scope, items: [], mode: 'newer', highWater: '3', retainedFrom: '1',
        nextCursor: 'cursor-3', olderCursor: null, hasMore: false })))
    const feed = await readRunActivityFeed(scope, { items: [item('2'), item('3')], olderCursor: 'older-2',
      nextCursor: 'cursor-3', retainedFrom: '1', unchangedReads: 0 })
    expect(feed).toMatchObject({ olderCursor: 'older-2', nextCursor: 'cursor-3', retainedFrom: '1' })
  })

  it('keeps a retained older anchor when the floor advances below the loaded history', async () => {
    const cursors: Array<string | null> = []
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      return HttpResponse.json({ scope, items: cursor === 'older-951'
        ? Array.from({ length: 50 }, (_, index) => item(String(901 + index))) : [item('1001')],
      mode: cursor === 'older-951' ? 'older' : 'newer', highWater: '1001', retainedFrom: '2',
      nextCursor: 'cursor-1001', olderCursor: cursor === 'older-951' ? 'older-901' : null, hasMore: false })
    }))
    const feed = await readRunActivityFeed(scope, {
      items: Array.from({ length: 50 }, (_, index) => item(String(951 + index))),
      olderCursor: 'older-951', nextCursor: 'cursor-1000', retainedFrom: '1', unchangedReads: 0,
    })
    expect(feed.olderCursor).toBe('older-951')
    const older = mergeOlderRunActivities(feed, await readRunActivities(scope, feed.olderCursor))
    expect(older.olderCursor).toBe('older-901')
    expect(older.items.map((event) => event.sequence)).toEqual(
      Array.from({ length: 101 }, (_, index) => String(901 + index)))
    expect(cursors).toEqual(['cursor-1000', 'older-951'])
  })

  it.each(['older page', 'newer page'] as const)('keeps retention monotonic when the %s has a later floor', (later) => {
    const page: RunActivitiesPage = { scope, items: later === 'older page' ? [item('3')] : [item('2'), item('3')],
      mode: 'older', highWater: '5',
      retainedFrom: later === 'older page' ? '3' : '1', nextCursor: 'stale-next',
      olderCursor: 'older-2', hasMore: true }
    const feed = mergeOlderRunActivities({ items: [item('1'), item('4'), item('5')],
      olderCursor: 'older-4', nextCursor: 'cursor-5', retainedFrom: later === 'newer page' ? '3' : '1',
      unchangedReads: 0 }, page)
    expect(feed.items.map((event) => event.sequence)).toEqual(['3', '4', '5'])
    expect(feed).toMatchObject({ nextCursor: 'cursor-5', retainedFrom: '3',
      olderCursor: later === 'older page' ? 'older-2' : null })
  })

  it.each([5, 1000])('backs off unchanged public reads with %s loaded rows up to one minute', async (size) => {
    const cursors: Array<string | null> = []
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, ({ request }) => {
      cursors.push(new URL(request.url).searchParams.get('cursor'))
      return HttpResponse.json({ scope, items: [], mode: 'newer', highWater: String(size), retainedFrom: '1',
        nextCursor: 'unchanged-next', olderCursor: null, hasMore: false })
    }))
    let feed = { items: Array.from({ length: size }, (_, index) => item(String(index + 1))),
      olderCursor: null, nextCursor: 'unchanged-next', retainedFrom: '1', unchangedReads: 0 }
    const delays = [runActivitiesRefetchInterval(feed)]
    for (let count = 0; count < 6; count++) {
      const next = await readRunActivityFeed(scope, feed)
      expect(next.items).toEqual(feed.items)
      feed = { ...next, olderCursor: null }
      delays.push(runActivitiesRefetchInterval(feed))
    }
    expect(delays).toEqual([3000, 6000, 12_000, 24_000, 48_000, 60_000, 60_000])
    expect(cursors).toEqual(Array(6).fill('unchanged-next'))
  })

  it('resets the idle cadence when retention alone advances', async () => {
    server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () =>
      HttpResponse.json({ scope, items: [], mode: 'newer', highWater: '3', retainedFrom: '2',
        nextCursor: 'cursor-3', olderCursor: null, hasMore: false })))
    const feed = await readRunActivityFeed(scope, { items: [item('1'), item('2'), item('3')],
      olderCursor: 'older-1', nextCursor: 'cursor-3', retainedFrom: '1', unchangedReads: 5 })
    expect(feed.items.map((event) => event.sequence)).toEqual(['2', '3'])
    expect(runActivitiesRefetchInterval(feed)).toBe(3000)
  })
})
it('rejects a cross-Run projection even if the outer page has the selected authorized scope', async () => {
  server.use(http.get(`/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () => HttpResponse.json({
    scope, items: [], mode: 'initial', highWater: '0', retainedFrom: '0', nextCursor: 'cursor', olderCursor: null, hasMore: false,
    activitySnapshot: { schemaVersion: 1, revision: '1', scope: { kind: 'workflow_run', workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: 'other-run', workflowVersionId: scope.workflowVersionId },
      active: [], queued: [], latest: null, pendingInteractions: [], activities: [], page: { before: null, nextCursor: null, hasMore: false } },
  })))
  await expect(readRunActivities(scope)).rejects.toThrow(/another Run/)
})

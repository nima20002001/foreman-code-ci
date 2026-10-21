// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { currentRunKey, useCurrentRunQuery } from './currentRunQuery'
import { WorkflowBoardContext } from './context'
import { useSelectedRunRecord } from './runFacts'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { useExecutionPages } from './inspect/queries'
import {
  advanceCurrentSequence, currentIdle, installBoardTestLifecycle, intervalTick,
  isCurrentRequest, measureBoardWire, newBoardQueryClient, setRunState,
  type InspectionFixture,
} from './eng05D.testSupport'

installBoardTestLifecycle()
let serial = 0
let fixture: InspectionFixture
let cache: ReturnType<typeof newBoardQueryClient>
function wrapper({ children }: { children: ReactNode }) {
  const scope = fixture.runs.before.scope
  return <QueryClientProvider client={cache}><WorkflowBoardContext.Provider value={{
    workspaceId: scope.workspaceId, workflowId: scope.workflowId, run: scope, inspection: {}, activeRuns: 1,
    selectRun: () => undefined, selectInspection: () => undefined, openLocation: () => undefined, openRuns: () => undefined,
  }}>{children}</WorkflowBoardContext.Provider></QueryClientProvider>
}
beforeEach(async () => {
  fixture = await inspectionBoardFixture(`eng05d-poll-${++serial}`)
  cache = newBoardQueryClient()
})

const unavailable = (status: number) => HttpResponse.json({
  error: { code: status === 503 ? 'TEMPORARILY_UNAVAILABLE' : 'ACCESS_UNAVAILABLE', message: 'ENG05-D deterministic read failure' },
}, { status })

describe('ENG05-D current-state polling measured at MSW', () => {
  it.each([401, 403, 404])('stops automatic current reads after HTTP %i, with no history fallback', async (status) => {
    const scope = fixture.runs.before.scope
    setRunState(fixture, scope, 'running')
    const wire = measureBoardWire(fixture.mock, (request) => isCurrentRequest(request) ? unavailable(status) : undefined)
    const { result } = renderHook(() => useCurrentRunQuery(scope), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(wire.current()).toHaveLength(1)
    expect(wire.current()[0]).toMatchObject({ status })
    await intervalTick(9_000)
    await currentIdle(cache, currentRunKey(scope))
    expect(wire.current(), 'Six polling opportunities must not retry an authority/not-found response').toHaveLength(1)
    expect(wire.samples).toHaveLength(1)
    expect(wire.activity()).toHaveLength(0)
    expect(wire.executions()).toHaveLength(0)
    wire.report(`current-${status}-stopped`)
  })

  it('continues after a transient failure and publishes fresh facts, not retained stale data', async () => {
    const scope = fixture.runs.before.scope
    setRunState(fixture, scope, 'running')
    let failNext = false
    const wire = measureBoardWire(fixture.mock, (request) => {
      if (!isCurrentRequest(request)) return undefined
      if (failNext) { failNext = false; return unavailable(503) }
      advanceCurrentSequence(fixture, scope)
      return undefined
    })
    const { result } = renderHook(() => ({ query: useCurrentRunQuery(scope), displayed: useSelectedRunRecord() }), { wrapper })
    await waitFor(() => expect(result.current.displayed?.asOfSequence).toBe('1'))
    failNext = true
    await intervalTick()
    await waitFor(() => expect(result.current.query.isError).toBe(true))
    expect(result.current.displayed, 'Cache retention is not current evidence after a failed refresh').toBeUndefined()
    expect(wire.current()).toHaveLength(2)
    await intervalTick()
    await waitFor(() => expect(result.current.displayed?.asOfSequence).toBe('2'))
    expect(result.current.query.isError).toBe(false)
    expect(wire.current().map((sample) => sample.status)).toEqual([200, 503, 200])
    expect(wire.activity()).toHaveLength(0)
    expect(wire.executions()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    wire.report('transient-current-recovery')
  })

  it('keeps polling completed work while cleanup is pending, then stops after fresh cleanup proof', async () => {
    const scope = fixture.runs.before.scope
    setRunState(fixture, scope, 'completed', true)
    const wire = measureBoardWire(fixture.mock)
    // Read data during render like the Board does; tracked query props only
    // re-render for fields a component has read.
    const { result } = renderHook(() => { const query = useCurrentRunQuery(scope); void query.data; return query }, { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await intervalTick()
    await waitFor(() => expect(wire.current()).toHaveLength(2))
    await currentIdle(cache, currentRunKey(scope))
    setRunState(fixture, scope, 'completed', false)
    advanceCurrentSequence(fixture, scope)
    await intervalTick()
    await waitFor(() => expect(result.current.data?.state.run.cleanupPending).toBe(false))
    expect(wire.current()).toHaveLength(3)
    await intervalTick(6_000)
    await currentIdle(cache, currentRunKey(scope))
    expect(wire.current()).toHaveLength(3)
    expect(wire.activity()).toHaveLength(0)
    wire.report('cleanup-polling-budget')
  })

  it('refetches current state on reconnect without replaying explicitly loaded execution history', async () => {
    const scope = fixture.runs.before.scope
    const wire = measureBoardWire(fixture.mock, (request) => {
      if (isCurrentRequest(request)) advanceCurrentSequence(fixture, scope)
      return undefined
    })
    const { result } = renderHook(() => {
      const current = useCurrentRunQuery(scope, false), pages = useExecutionPages(scope, {}, true)
      void current.data; void pages.data
      return { current, pages }
    }, { wrapper })
    await waitFor(() => expect(result.current.current.isSuccess && result.current.pages.isSuccess).toBe(true))
    const pages = result.current.pages.data
    expect(wire.current()).toHaveLength(1)
    expect(wire.executions()).toHaveLength(1)
    await act(async () => { onlineManager.setOnline(false) })
    await intervalTick(6_000)
    expect(wire.current()).toHaveLength(1)
    await act(async () => { onlineManager.setOnline(true) })
    await waitFor(() => expect(result.current.current.data?.asOfSequence).toBe('2'))
    expect(wire.current()).toHaveLength(2)
    expect(wire.executions()).toHaveLength(1)
    expect(result.current.pages.data).toBe(pages)
    expect(wire.activity()).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    wire.report('reconnect-not-history-replay')
  })

  it('withholds regressed current evidence and recovers on the next valid bounded cut', async () => {
    const scope = fixture.runs.before.scope
    setRunState(fixture, scope, 'running')
    fixture.mock.currents.get(scope.runId)!.asOfSequence = '9'
    const wire = measureBoardWire(fixture.mock)
    const { result } = renderHook(() => ({ query: useCurrentRunQuery(scope), displayed: useSelectedRunRecord() }), { wrapper })
    await waitFor(() => expect(result.current.displayed?.asOfSequence).toBe('9'))
    fixture.mock.currents.get(scope.runId)!.asOfSequence = '8'
    await intervalTick()
    await waitFor(() => expect(result.current.query.isError).toBe(true))
    expect(result.current.displayed).toBeUndefined()
    fixture.mock.currents.get(scope.runId)!.asOfSequence = '10'
    await intervalTick()
    await waitFor(() => expect(result.current.displayed?.asOfSequence).toBe('10'))
    expect(wire.current()).toHaveLength(3)
    expect(wire.samples.every((sample) => sample.responseBytes < 16 * 1024)).toBe(true)
    expect(wire.activity()).toHaveLength(0)
    wire.report('regressed-cut-recovery')
  })
})

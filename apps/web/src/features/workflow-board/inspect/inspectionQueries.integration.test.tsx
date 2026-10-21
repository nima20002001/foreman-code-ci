import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import {
  CurrentRunDetailsSchema, RunExecutionDetailSchema, RunExecutionBindingSchema,
  WorkflowVersionV3Schema, type RunExecutionDetail, type RunInputSourceSchema,
} from '@foreman-code/contracts/wave25'
import { server } from '../../../mocks/server'
import { digestCurrentValue, readRunExecution } from '../runDetailsClient'
import { currentRunKey, useCurrentRunQuery } from '../currentRunQuery'
import { useSelectedRunRecord } from '../runFacts'
import { WorkflowBoardContext } from '../context'
import { inspectionBoardFixture } from './inspectionFixtures'
import { executionPagesKey, bindingsPagesKey, useExecutionPages, useBindingPages, refreshFirstInspectionPage } from './queries'

let number = 0
let fixture: Awaited<ReturnType<typeof inspectionBoardFixture>>
let cache: QueryClient
const calls = (tail: string) => fixture.mock.calls.filter((call) => call.method === 'GET' && call.path.endsWith(tail))
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={cache}>{children}</QueryClientProvider>
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto)
  fixture = await inspectionBoardFixture(`query-inspection-${++number}`)
  server.use(...fixture.mock.handlers)
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(() => {
  cleanup(); cache.clear(); focusManager.setFocused(undefined)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

async function manyExecutions(count: number) {
  const items = await Promise.all(Array.from({ length: count }, (_, index) =>
    fixture.execution(fixture.runs.before, 0, undefined, index + 1)))
  for (const item of items.slice(0, -1)) item.detail = RunExecutionDetailSchema.parse({
    ...item.detail, execution: { ...item.detail.execution, acceptedResultAvailable: false },
    acceptedResult: { status: 'not_accepted' },
  })
  fixture.mock.inspection.set(fixture.runs.before.run.id, items)
}

/** A valid static V3 fan-out/all-required join with twelve actual predecessor
 * relationships. Not twelve copies of a fictional binding or repeat round. */
async function joinWithBindingPages(): Promise<RunExecutionDetail> {
  const owner = fixture.runs.after
  const original = fixture.mock.inspection.get(owner.run.id)![0]!
  const first = nativeNode(owner.version.definition.nodes[0]!), join = nativeNode(owner.version.definition.nodes[1]!)
  const additions = Array.from({ length: 11 }, (_, i) => ({
    id: `source-node-${i}`, agentId: `source-agent-${i}`, name: `Predecessor ${i}`,
  }))
  const pins = { ...owner.version.agentConfigurationVersionIds,
    ...Object.fromEntries(additions.map((node, i) => [node.agentId, `source-config-${i}`])) }
  const version = WorkflowVersionV3Schema.parse({ ...owner.version, agentConfigurationVersionIds: pins,
    definition: { ...owner.version.definition,
      nodes: [first, { ...join, join: { mode: 'all' } }, ...additions],
      edges: [...owner.version.definition.edges, ...additions.flatMap((node, i) => [
        { id: `fanout-${i}`, kind: 'execution', source: first.id, target: node.id },
        { id: `join-${i}`, kind: 'execution', source: node.id, target: join.id },
      ])], executionPolicy: { maxParallelism: 12, maxNodeExecutions: 13 } } })
  const current = fixture.mock.runs.get(owner.run.id)!
  fixture.mock.versions.set(version.id, version)
  fixture.mock.runs.set(owner.run.id, CurrentRunDetailsSchema.parse({
    ...current, run: { ...current.run, agentConfigurationVersionIds: pins },
  }))
  const value = structuredClone(original.detail.acceptedInput.value)
  if ('work' in value || 'tick' in value) throw new Error('Fan-in fixture requires an ordinary input.')
  for (const [i, node] of additions.entries()) {
    const result = { outcome: 'succeeded' as const, output: { text: node.name } }
    const source: ReturnType<typeof RunInputSourceSchema.parse> = {
      relationshipId: `join-${i}`,
      execution: { workflowNodeId: node.id, executionId: `source-execution-${i}`, agentId: node.agentId,
        agentConfigurationVersionId: pins[node.agentId]!, attempt: 1 },
      occurrence: null, acceptedResult: result, acceptedResultDigest: await digestCurrentValue(result),
    }
    value.predecessors.push(source)
  }
  const detail = RunExecutionDetailSchema.parse({
    ...original.detail, acceptedInput: { value, digest: await digestCurrentValue(value) },
  })
  const { executionId, workflowNodeId, agentId, agentConfigurationVersionId, attempt } = nativeNode(detail.execution)
  const bindings = value.predecessors.map((source, ordinal) => RunExecutionBindingSchema.parse({
    bindingId: `joined-binding-${ordinal}`, recipient: { executionId, workflowNodeId, agentId, agentConfigurationVersionId, attempt },
    recipientOccurrence: null, inputDigest: detail.acceptedInput.digest, ordinal, kind: 'predecessor', source,
  }))
  fixture.mock.inspection.set(owner.run.id, [{ detail, bindings }])
  return readRunExecution(owner.scope, executionId)
}

describe('explicit paged inspection Query ownership', () => {
  it('does not read history until enabled, and neither focus nor rerender reloads its pages', async () => {
    const scope = fixture.runs.before.scope
    const { result, rerender } = renderHook(({ enabled }) => useExecutionPages(scope, {}, enabled),
      { wrapper, initialProps: { enabled: false } })
    expect(calls('/executions')).toHaveLength(0)
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(calls('/executions')).toHaveLength(1)
    await act(async () => {
      focusManager.setFocused(false); focusManager.setFocused(true)
    })
    rerender({ enabled: true })
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(calls('/executions')).toHaveLength(1)
  })

  it('resets a multi-page refresh to one first-page request rather than replaying the page chain', async () => {
    await manyExecutions(31)
    const scope = fixture.runs.before.scope
    const { result } = renderHook(() => useExecutionPages(scope, {}, true), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.pages[0]?.items).toHaveLength(25)
    await act(async () => {
      const next = await result.current.fetchNextPage()
      expect(next.isError).toBe(false)
      expect(next.data?.pages.map((page) => page.items.length)).toEqual([25, 6])
    })
    // The fetch promise settles before Query's batched React notification.
    await waitFor(() => expect(result.current.data?.pages.map((page) => page.items.length)).toEqual([25, 6]))
    expect(calls('/executions')).toHaveLength(2)
    await act(async () => { await refreshFirstInspectionPage(cache, executionPagesKey(scope, {})) })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(calls('/executions')).toHaveLength(3)
    expect(result.current.data?.pageParams).toEqual([null])
  })

  it('retains at most five pages and can explicitly restart from the first page', async () => {
    await manyExecutions(151)
    const scope = fixture.runs.before.scope
    const { result } = renderHook(() => useExecutionPages(scope, {}, true), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    for (let page = 0; page < 6; page++) {
      const previousCursor = result.current.data?.pageParams.at(-1)
      await act(async () => {
        const next = await result.current.fetchNextPage()
        expect(next.isError).toBe(false)
        expect(next.data?.pages).toHaveLength(Math.min(page + 2, 5))
      })
      // A five-page window keeps the same length after eviction; wait for its
      // cursor to advance, not merely for another already-true length check.
      await waitFor(() => expect(result.current.data?.pageParams.at(-1)).not.toBe(previousCursor))
    }
    expect(calls('/executions')).toHaveLength(7)
    expect(result.current.data?.pages).toHaveLength(5)
    expect(result.current.hasNextPage).toBe(false)
    expect(result.current.data?.pages.flatMap((page) => page.items)).toHaveLength(101)
    await act(async () => { await refreshFirstInspectionPage(cache, executionPagesKey(scope, {})) })
    await waitFor(() => expect(result.current.data?.pageParams).toEqual([null]))
    expect(calls('/executions')).toHaveLength(8)
    expect(result.current.data?.pages[0]?.items).toHaveLength(25)
  })

  it('never returns another Run’s retained pages while its new selection is loading or fails', async () => {
    const { result, rerender } = renderHook(({ scope }) => useExecutionPages(scope, {}, true),
      { wrapper, initialProps: { scope: fixture.runs.before.scope } })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    server.use(http.get(`/api/management/workspaces/${fixture.mock.workspaceId}/runs/${fixture.runs.repeated.run.id}/executions`,
      () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Historical read failed' } }, { status: 503 })))
    rerender({ scope: fixture.runs.repeated.scope })
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
    expect(cache.getQueryData(executionPagesKey(fixture.runs.before.scope, {}))).toBeDefined()
  })

  it('pages and refreshes bindings for one exact accepted input identity', async () => {
    const detail = await joinWithBindingPages(), scope = fixture.runs.after.scope
    const { result, rerender } = renderHook(({ enabled }) => useBindingPages(scope, detail, enabled),
      { wrapper, initialProps: { enabled: false } })
    expect(calls('/bindings')).toHaveLength(0)
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.pages[0]?.items).toHaveLength(10)
    await act(async () => {
      const next = await result.current.fetchNextPage()
      expect(next.isError).toBe(false)
      expect(next.data?.pages.map((page) => page.items.length)).toEqual([10, 2])
    })
    await waitFor(() => expect(result.current.data?.pages.map((page) => page.items.length)).toEqual([10, 2]))
    expect(result.current.data?.pages.every((page) => page.inputDigest === detail.acceptedInput.digest)).toBe(true)
    await act(async () => { await refreshFirstInspectionPage(cache, bindingsPagesKey(scope, detail)) })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(result.current.data?.pageParams).toEqual([null])
    expect(calls('/bindings')).toHaveLength(3)
    expect(result.current.data?.pages[0]?.items.map((binding) => binding.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('lets cache-only canvas subscribers observe facts without replacing the fetch owner', async () => {
    const scope = fixture.runs.before.scope
    function context({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={cache}><WorkflowBoardContext.Provider value={{
        workspaceId: scope.workspaceId, workflowId: scope.workflowId, run: scope, inspection: {}, activeRuns: 0,
        selectRun: () => undefined, selectInspection: () => undefined, openLocation: () => undefined, openRuns: () => undefined,
      }}>{children}</WorkflowBoardContext.Provider></QueryClientProvider>
    }
    const subscriber = renderHook(() => useSelectedRunRecord(), { wrapper: context })
    expect(subscriber.result.current).toBeUndefined()
    expect(calls('/current')).toHaveLength(0)
    const owner = renderHook(() => useCurrentRunQuery(scope), { wrapper: context })
    await waitFor(() => expect(owner.result.current.isSuccess).toBe(true))
    expect(calls('/current')).toHaveLength(1)
    expect(subscriber.result.current).toEqual(owner.result.current.data)
    await act(async () => { await cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true }) })
    expect(calls('/current')).toHaveLength(2)
    expect(owner.result.current.isError).toBe(false)
    expect(subscriber.result.current).toEqual(owner.result.current.data)
  })

  it('refreshes only bounded current state while historical execution pages stay unchanged', async () => {
    const scope = fixture.runs.before.scope, current = fixture.mock.currents.get(scope.runId)!
    current.state.run = { ...current.state.run, executionState: 'running', outcome: 'pending' }
    current.asOfSequence = '1'
    const { result, rerender } = renderHook(({ live }) => ({
      current: useCurrentRunQuery(scope, live),
      pages: useExecutionPages(scope, {}, true),
    }), { wrapper, initialProps: { live: false } })
    await waitFor(() => expect(result.current.current.isSuccess && result.current.pages.isSuccess).toBe(true))
    const pages = result.current.pages.data
    const firstCurrentCount = calls('/current').length
    expect(firstCurrentCount).toBeGreaterThan(0)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    rerender({ live: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    vi.useRealTimers()
    await waitFor(() => expect(calls('/current').length).toBeGreaterThan(firstCurrentCount))
    await waitFor(() => expect(result.current.current.fetchStatus).toBe('idle'))
    expect(calls('/executions')).toHaveLength(1)
    expect(calls('/events')).toHaveLength(0)
    expect(calls('/bindings')).toHaveLength(0)
    expect(result.current.pages.data).toBe(pages)
    const runDetailsPath = `/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}`
    expect(fixture.mock.calls.some((call) => call.path === runDetailsPath)).toBe(false)
  }, 10_000)
})

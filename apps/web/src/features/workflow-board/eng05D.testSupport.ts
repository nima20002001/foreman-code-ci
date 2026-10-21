import { bindMockInstallation } from '../../shared/mocks/handlers'
import { Buffer } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { createElement } from 'react'
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { http } from 'msw'
import {
  boardSearchForInspection, CANONICAL_RUN_GRAPH_ROUTES, CurrentRunDetailsSchema, RepeatGraphCurrentV3Schema,
  type RepeatGraphScopeV3, type WorkspaceBoardInspection,
} from '@foreman-code/contracts/wave25'
import { routeTree } from '../../app/router'
import { server } from '../../mocks/server'
import { useGraphDraftStore } from '../graph/store'
import { useInspectionPresentation } from './inspect/presentation'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { clearBoardStartStorage } from './startOutbox'
import { clearBoardStopStorage } from './stopOutbox'

export type InspectionFixture = Awaited<ReturnType<typeof inspectionBoardFixture>>
export type BoardMock = InspectionFixture['mock']
export type WireSample = {
  method: string; path: string; query: URLSearchParams; status: number
  requestBytes: number; responseBytes: number; itemCount?: number; body: unknown
}
export type ReplyOverride = (request: Request) => Response | undefined | Promise<Response | undefined>

/** Count the actual requests and serialized response bytes INSIDE MSW. The
 * fixture's dispatch still owns responses, shared schema parsing and cursors.
 * This must be installed after mock.handlers. It never bypasses MSW to fetch. */
export function measureBoardWire(mock: BoardMock, override?: ReplyOverride) {
  const samples: WireSample[] = []
  const handler = http.all('*', async ({ request }) => {
    const requestText = ['GET', 'HEAD'].includes(request.method) ? '' : await request.clone().text()
    const response = await override?.(request) ?? await mock.dispatch(request)
    if (!response) return undefined
    const text = await response.clone().text()
    let body: unknown
    try { body = JSON.parse(text) } catch { body = text }
    const items = body !== null && typeof body === 'object' && 'items' in body ? body.items : undefined
    const url = new URL(request.url)
    samples.push({ method: request.method, path: url.pathname, query: url.searchParams, status: response.status,
      requestBytes: Buffer.byteLength(requestText, 'utf8'), responseBytes: Buffer.byteLength(text, 'utf8'),
      ...(Array.isArray(items) ? { itemCount: items.length } : {}), body })
    return response
  })
  server.use(...mock.handlers)
  server.use(handler)
  const matching = (predicate: (sample: WireSample) => boolean) => samples.filter(predicate)
  return {
    samples, matching,
    current: () => matching(isCurrentRead),
    executions: (limit = '25') => matching((sample) => sample.method === 'GET'
      && sample.path.endsWith('/executions') && sample.query.get('limit') === limit),
    activity: () => matching((sample) => sample.method === 'GET' && sample.path.endsWith('/events')),
    runLists: () => matching((sample) => sample.method === 'GET' && sample.path.endsWith('/runs')),
    writes: () => matching((sample) => !['GET', 'HEAD'].includes(sample.method)),
    report(label: string) {
      const groups: Record<string, { requests: number; bytes: number; maxBytes: number; maxItems: number }> = {}
      for (const sample of samples) {
        const key = `${sample.method} ${sample.path} limit=${sample.query.get('limit') ?? '-'} cursor=${sample.query.has('cursor')}`
        const group = groups[key] ??= { requests: 0, bytes: 0, maxBytes: 0, maxItems: 0 }
        group.requests++; group.bytes += sample.responseBytes
        group.maxBytes = Math.max(group.maxBytes, sample.responseBytes)
        group.maxItems = Math.max(group.maxItems, sample.itemCount ?? 0)
      }
      console.info(`ENG05-D_WIRE ${JSON.stringify({ label, groups })}`)
    },
  }
}
const currentRoute = new RegExp(`^${CANONICAL_RUN_GRAPH_ROUTES.current.split('/').map((part) =>
  part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`)
export function isCurrentRead(sample: Pick<WireSample, 'method' | 'path'>) {
  return sample.method === 'GET' && currentRoute.test(sample.path)
}
export function isCurrentRequest(request: Request) {
  return isCurrentRead({ method: request.method, path: new URL(request.url).pathname })
}

/** Fixture state only. Never copy these server facts to a local presentation store. */
export function setRunState(fixture: InspectionFixture, scope: RepeatGraphScopeV3,
  state: 'running' | 'completed', cleanupPending = false) {
  const detail = fixture.mock.runs.get(scope.runId)!
  const { finishedAt: _finishedAt, result: _result, ...run } = detail.run
  void _finishedAt; void _result
  fixture.mock.runs.set(scope.runId, CurrentRunDetailsSchema.parse({ ...detail, cleanupPending,
    run: { ...run, executionState: state, outcome: state === 'running' ? 'pending' : 'succeeded',
      ...(state === 'completed' ? { finishedAt: fixture.before.createdAt,
        result: { outcome: 'succeeded', output: { test: 'ENG05-D terminal fixture' } } } : {}) } }))
  const current = fixture.mock.currents.get(scope.runId)!
  fixture.mock.currents.set(scope.runId, RepeatGraphCurrentV3Schema.parse({ ...current,
    state: { ...current.state, run: { ...current.state.run, executionState: state,
      outcome: state === 'running' ? 'pending' : 'succeeded', cleanupPending } } }))
}
export function advanceCurrentSequence(fixture: InspectionFixture, scope: RepeatGraphScopeV3) {
  const current = fixture.mock.currents.get(scope.runId)!
  fixture.mock.currents.set(scope.runId, RepeatGraphCurrentV3Schema.parse({ ...current,
    asOfSequence: String(BigInt(current.asOfSequence) + 1n) }))
}
export function boardHref(scope: RepeatGraphScopeV3, inspection: WorkspaceBoardInspection = {}) {
  const search = boardSearchForInspection({}, scope.workflowId, scope, inspection)
  const params = new URLSearchParams(Object.entries(search).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]))
  return `/workspaces/${scope.workspaceId}?${params}`
}

const clients: QueryClient[] = []
const unhandled: string[] = []
const recordUnhandled = ({ request }: { request: Request }) => unhandled.push(`${request.method} ${request.url}`)
export function newBoardQueryClient() {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(cache)
  return cache
}
export async function mountMeasuredBoard(url: string) {
  const cache = newBoardQueryClient()
  const history = createMemoryHistory({ initialEntries: [url] })
  const router = createRouter({ routeTree, history, defaultPendingMinMs: 0 })
  await router.load()
  const view = render(createElement(QueryClientProvider, { client: cache }, createElement(RouterProvider, { router })))
  await screen.findByTestId('unified-workflow-board')
  return { ...view, cache, router, history }
}
export async function openRunDetails() {
  if (!screen.queryByRole('button', { name: 'Close Activities' })) {
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Activities' }))
  }
  return screen.findByRole('region', { name: 'Exact execution inputs and results' })
}
export async function intervalTick(milliseconds = 1500) {
  // Only intervals are faked. Fetch, MSW, Query's batched notifications and
  // Testing Library's waitFor keep real microtask/timeout scheduling.
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}
export async function currentIdle(cache: QueryClient, key: readonly unknown[]) {
  await waitFor(() => expect(cache.getQueryState(key)).toMatchObject({ fetchStatus: 'idle' }))
}

/** Same JSDOM-only infrastructure as the existing mounted Board tests. */
const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval
export function installBoardTestLifecycle() {
  configure({ asyncUtilTimeout: 5000 })
  beforeEach(() => {
    unhandled.length = 0; server.events.on('request:unhandled', recordUnhandled)
    localStorage.clear(); bindMockInstallation(); sessionStorage.clear(); clearBoardStartStorage(); clearBoardStopStorage()
    useGraphDraftStore.getState().clearAllDrafts(); useInspectionPresentation.setState({ open: {} })
    vi.stubGlobal('crypto', webcrypto)
    const queues = new Map<string, Promise<unknown>>()
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, work: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof work !== 'function') return claim!({ name: key })
      const result = (queues.get(key) ?? Promise.resolve()).then(work)
      queues.set(key, result.catch(() => { /* ignore: a failed lock holder must not block the next one */ })); return result
    } } })
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly notify: ResizeObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver))
      }
      unobserve() {} disconnect() {}
    })
    if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(720)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720, toJSON: () => ({}),
    }))
    focusManager.setFocused(true); onlineManager.setOnline(true)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    // Testing Library's waitFor/findBy poll with setInterval. Keep that one poll
    // on real time so faking the Board's own intervals cannot starve assertions.
    const fakeSetInterval = globalThis.setInterval, fakeClearInterval = globalThis.clearInterval
    const realHandles = new WeakSet<object>()
    vi.stubGlobal('setInterval', ((callback: TimerHandler, delay?: number, ...rest: unknown[]) => {
      if (typeof callback !== 'function' || callback.name !== 'checkRealTimersCallback') {
        return fakeSetInterval(callback as () => void, delay, ...rest)
      }
      const handle = { id: realSetInterval(callback as () => void, delay, ...rest) }
      realHandles.add(handle)
      return handle
    }) as typeof setInterval)
    vi.stubGlobal('clearInterval', ((handle?: unknown) => {
      if (handle && typeof handle === 'object' && realHandles.has(handle)) {
        return realClearInterval((handle as { id: ReturnType<typeof realSetInterval> }).id)
      }
      return fakeClearInterval(handle as Parameters<typeof clearInterval>[0])
    }) as typeof clearInterval)
  })
  afterEach(() => {
    cleanup(); clients.splice(0).forEach((cache) => cache.clear())
    clearBoardStartStorage(); clearBoardStopStorage()
    useGraphDraftStore.getState().clearAllDrafts(); useInspectionPresentation.setState({ open: {} })
    focusManager.setFocused(undefined); onlineManager.setOnline(true)
    server.events.removeListener('request:unhandled', recordUnhandled)
    vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks()
    expect(unhandled, 'No ENG05-D request may escape the MSW backend').toEqual([])
  })
}

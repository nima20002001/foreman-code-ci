import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { TelemetryReadResultSchema, telemetrySelectorKey, type TelemetryReadResult, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { resourceTelemetryFixtures as fixtures, telemetryComputerFixture, telemetryOwnedFixture, telemetrySelectionRaceFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { resourceTelemetryKeys, useResourceTelemetryQuery } from '../../shared/api/resourceTelemetry'
import { beginSessionChange, finishSessionChange, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ResourceTelemetryPanel, ScopedResourceTelemetry } from './ResourceTelemetryCards'
import { sampleClock } from './telemetryView'
import { deferred } from '../../test/deferred'

const route = '*/api/management/resource-telemetry/read'
let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
const fresh = () => { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }) }
const keyOf = (selector: TelemetrySelector) => telemetrySelectorKey(selector)
const noSample = (selector: TelemetrySelector): Extract<TelemetryReadResult, { kind: 'no-sample' }> => ({ kind: 'no-sample', selector, selectorKey: keyOf(selector), reason: 'not-yet-sampled', identity: null })
/** Re-addresses a fixture sample to another selector so the shared selector-key invariant still holds. */
const forSelector = (result: TelemetryReadResult, selector: TelemetrySelector): TelemetryReadResult => result.kind !== 'sample' ? result
  : { kind: 'sample', sample: { ...result.sample, selector, selectorKey: keyOf(selector) }, lastKnown: null }

afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); if (sessionIsSwitching()) finishSessionChange() })

describe('useResourceTelemetryQuery', () => {
  it('POSTs the full selector and returns the validated fresh zero reading', async () => {
    fresh()
    let body: unknown
    server.use(http.post(route, async ({ request }) => { body = await request.json(); return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    expect(body).toEqual(JSON.parse(JSON.stringify(telemetryOwnedFixture)))
    expect(result.current.data?.selectorKey).toBe(keyOf(telemetryOwnedFixture))
    expect(result.current.data?.receivedMonoMs).toBeGreaterThanOrEqual(0)
  })
  it.each([5000.25, 7000.5])('counts %s ms request transit before first display and keeps actual server deadlines', async duration => {
    fresh(); let mono = 10.25
    vi.spyOn(performance, 'now').mockImplementation(() => mono)
    server.use(http.post(route, async ({ request }) => { await request.json(); mono += duration; return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    const received = result.current.data!
    expect(received).toMatchObject({ receivedMonoMs: mono, requestDurationMs: duration })
    if (received.result.kind !== 'sample') throw new Error('sample')
    expect(received.result.sample.serverNowUnixMs).toBe(1001); expect(received.result.sample.freshUntilUnixMs).toBe(7000)
    expect(received.result.sample.ageUpperBoundMs).toBe(1)
    render(<ResourceTelemetryPanel scope="owned" title="Delayed execution" received={received} elapsedMs={0} />)
    const panel = screen.getByRole('region', { name: 'Delayed execution' })
    expect(within(panel).queryAllByText('Fresh')).toHaveLength(duration < 5999 ? 2 : 0)
    expect(within(panel).queryAllByText('Freshness deadline passed')).toHaveLength(duration < 5999 ? 0 : 2)
    const clock = sampleClock(received.result.sample, duration + 500)
    expect(clock.ageMs).toBe(1 + duration + 500); expect(clock.nowMs).toBe(1001 + duration + 500)
  })

  it('rejects a response that belongs to another selection', async () => {
    fresh()
    const other = { ...telemetryOwnedFixture, attributionRevision: '2' }
    server.use(http.post(route, () => HttpResponse.json(fixtures.freshZero)))
    const { result } = renderHook(() => useResourceTelemetryQuery(other), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('rejects a no-sample response whose selector disagrees with its selected key', async () => {
    fresh()
    const other = { ...telemetryOwnedFixture, attributionRevision: '2' }
    server.use(http.post(route, () => HttpResponse.json({ ...noSample(other), selectorKey: keyOf(telemetryOwnedFixture) })))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })

  it('maps HTTP 403 to a caller denial without values', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.denied, { status: 403 })))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('denied'))
  })

  it('replaces a previously authorized value with caller denial on refresh', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.freshZero)))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    server.use(http.post(route, () => HttpResponse.json(fixtures.denied, { status: 403 })))
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.data?.result).toEqual(fixtures.denied))
    expect(client.getQueryData(resourceTelemetryKeys.read(keyOf(telemetryOwnedFixture)))).toMatchObject({ result: fixtures.denied })
  })

  it('clears private readings during a session change and reads again only after it finishes', async () => {
    fresh()
    let requests = 0
    server.use(http.post(route, () => { requests += 1; return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('sample'))
    await act(async () => { beginSessionChange() })
    expect(result.current.data).toBeUndefined()
    expect(client.getQueriesData({ queryKey: resourceTelemetryKeys.root }).every(([, value]) => value === undefined)).toBe(true)
    expect(requests).toBe(1)
    server.use(http.post(route, () => { requests += 1; return HttpResponse.json(fixtures.denied, { status: 403 }) }))
    await act(async () => { finishSessionChange() })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('denied'))
    expect(requests).toBe(2)
  })

  it('aborts an in-flight read when its Info surface unmounts', async () => {
    fresh()
    let signal: AbortSignal | undefined
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(route, async ({ request }) => { signal = request.signal; await pending; return HttpResponse.json(fixtures.freshZero) }))
    const view = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(signal).toBeDefined())
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => { release(); await pending })
    expect(client.getQueryData(resourceTelemetryKeys.read(keyOf(telemetryOwnedFixture)))).toBeUndefined()
  })

  it('rejects an earlier session read that resolves after a session change', async () => {
    fresh()
    let signal: AbortSignal | undefined
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(route, async ({ request }) => { signal = request.signal; await pending; return HttpResponse.json(fixtures.freshZero) }))
    const { result } = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    await waitFor(() => expect(signal).toBeDefined())
    await act(async () => { beginSessionChange(); release(); await pending })
    expect(signal?.aborted).toBe(true)
    expect(result.current.data).toBeUndefined()
    expect(client.getQueriesData({ queryKey: resourceTelemetryKeys.root }).every(([, value]) => value === undefined)).toBe(true)
  })

  it('does not query without a selector', () => {
    fresh()
    const { result } = renderHook(() => useResourceTelemetryQuery(undefined), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.data).toBeUndefined()
  })

  it('ignores late A and B responses after A→B→A, even on revisit', async () => {
    fresh()
    const [a1, b, a2] = telemetrySelectionRaceFixture
    let aRequests = 0
    let bRequests = 0
    const lateA = deferred<void>()
    const lateB = deferred<void>()
    let lateResponses = 0
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      if (keyOf(selector) === keyOf(b!.selector as TelemetrySelector)) {
        bRequests += 1
        await lateB.promise
        lateResponses += 1
        return HttpResponse.json(noSample(selector))
      }
      aRequests += 1
      if (aRequests === 1) {
        await lateA.promise
        lateResponses += 1
        return HttpResponse.json(a1!.response)
      }
      return HttpResponse.json(a2!.response)
    }))
    const initialProps: { selector: TelemetrySelector } = { selector: a1!.selector }
    const { result, rerender } = renderHook(({ selector }: { selector: TelemetrySelector }) => useResourceTelemetryQuery(selector), { wrapper, initialProps })
    await waitFor(() => expect(aRequests).toBe(1))
    rerender({ selector: b!.selector as TelemetrySelector })
    expect(result.current.data).toBeUndefined()
    await waitFor(() => expect(bRequests).toBe(1))
    rerender({ selector: a2!.selector })
    await waitFor(() => expect(result.current.data?.result).toEqual(a2!.response))
    await act(async () => {
      lateB.resolve(undefined)
      lateA.resolve(undefined)
      await waitFor(() => expect(lateResponses).toBe(2))
    })
    await waitFor(() => expect(client.isFetching()).toBe(0))
    expect(result.current.data?.selectorKey).toBe(keyOf(a2!.selector))
    expect(result.current.data?.result.kind).toBe('no-sample')
  })

  it('ignores a delayed sample from a replaced Worker installation', async () => {
    fresh()
    const old = { ...telemetryOwnedFixture, host: { ...telemetryOwnedFixture.host,
      hostRef: { kind: 'device' as const, mainId: telemetryOwnedFixture.mainId,
        deviceId: telemetryOwnedFixture.host.deviceId },
      applicationInstallationId: 'old-worker', keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 } }
    const replacement = { ...old, host: { ...old.host, applicationInstallationId: 'replacement-worker',
      bootId: '44444444-4444-4444-8444-444444444444', connectionGeneration: 2 } }
    const sample = forSelector(fixtures.freshZero!, old)
    if (sample.kind !== 'sample') throw new Error('Expected a captured Worker sample')
    sample.sample.identity = { mainId: old.mainId, host: old.host }
    const oldSample = TelemetryReadResultSchema.parse(sample)
    const gate = { release: () => {} }
    const pending = new Promise<void>(resolve => { gate.release = resolve })
    let oldRequested = false
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      if (keyOf(selector) === keyOf(old)) {
        oldRequested = true
        await pending
        return HttpResponse.json(oldSample)
      }
      return HttpResponse.json(noSample(replacement))
    }))
    const { result, rerender } = renderHook(({ selector }) => useResourceTelemetryQuery(selector),
      { wrapper, initialProps: { selector: old } })
    await waitFor(() => expect(oldRequested).toBe(true))
    rerender({ selector: replacement })
    await waitFor(() => expect(result.current.data?.result.kind).toBe('no-sample'))
    await act(async () => { gate.release(); await pending })
    expect(result.current.data?.selectorKey).toBe(keyOf(replacement))
    expect(result.current.data?.result).toEqual(noSample(replacement))
  })

  it('keeps two nodes of the same Agent on separate selector keys and readings', async () => {
    fresh()
    const node2 = { ...telemetryOwnedFixture, owner: { ...telemetryOwnedFixture.owner, nodeId: 'node-2' } } as TelemetrySelector
    expect(keyOf(node2)).not.toBe(keyOf(telemetryOwnedFixture))
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      return HttpResponse.json(keyOf(selector) === keyOf(node2) ? forSelector(fixtures.warmup!, node2) : fixtures.freshZero)
    }))
    const one = renderHook(() => useResourceTelemetryQuery(telemetryOwnedFixture), { wrapper })
    const two = renderHook(() => useResourceTelemetryQuery(node2), { wrapper })
    await waitFor(() => expect(one.result.current.data && two.result.current.data).toBeTruthy())
    expect(one.result.current.data?.selectorKey).toBe(keyOf(telemetryOwnedFixture))
    expect(two.result.current.data?.selectorKey).toBe(keyOf(node2))
    expect(two.result.current.data?.result).not.toEqual(one.result.current.data?.result)
  })
})

describe('ScopedResourceTelemetry', () => {
  const context = { phase: 'observed', computerName: 'Main computer', computerId: telemetryComputerFixture.host.deviceId } as const

  it('shows context, whole computer and execution scopes separately', async () => {
    fresh()
    server.use(http.post(route, async ({ request }) => {
      const selector = await request.json() as TelemetrySelector
      return HttpResponse.json(selector.scope === 'computer' ? fixtures.computerZero : fixtures.freshZero)
    }))
    render(<ScopedResourceTelemetry context={context} computerSelector={telemetryComputerFixture as Extract<TelemetrySelector, { scope: 'computer' }>} ownedSelector={telemetryOwnedFixture} />, { wrapper })
    expect(screen.getByText('Execution observed on')).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Computer' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Execution' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('0.0%')).toHaveLength(2))
  })

  it('labels the live computer reading "Computer now" in history and never shows it as the Run metrics', async () => {
    fresh()
    server.use(http.post(route, () => HttpResponse.json(fixtures.computerZero)))
    render(<ScopedResourceTelemetry mode="historical" context={{ ...context, phase: 'accepted' }}
      computerSelector={telemetryComputerFixture as Extract<TelemetrySelector, { scope: 'computer' }>} ownedSelector={telemetryOwnedFixture} />, { wrapper })
    expect(await screen.findByRole('region', { name: 'Computer now' })).toBeInTheDocument()
    expect(screen.getByText('Historical metrics unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Execution' })).toBeNull()
  })

  it('renders a stored captured sample only as last known history', () => {
    fresh()
    render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.freshZero} />, { wrapper })
    expect(screen.getByRole('region', { name: 'Captured execution metrics' })).toHaveTextContent('Historical capture · not current')
  })
  it.each(['ended', 'staleOnline'])('renders authorized retained values for %s history with their captured qualifiers', name => {
    fresh(); const captured = structuredClone(fixtures[name]!)
    if (captured.kind !== 'sample' || !captured.lastKnown || captured.lastKnown.memory.state !== 'fresh') throw new Error('sample fixture')
    captured.lastKnown.coverage = { boundary: 'partial', shared: true, reasons: ['limit', 'process-tree-partial'] }
    captured.lastKnown.memory.value = { kind: 'rss-sum', bytes: 4096, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true }
    render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={captured} ownedSelector={telemetryOwnedFixture} />, { wrapper })
    const history = screen.getByRole('region', { name: 'Captured execution metrics' })
    expect(history).toHaveTextContent('Historical capture · not current'); expect(history).toHaveTextContent('CPU 0.0%')
    expect(history).toHaveTextContent('RAM <0.01 MiB'); expect(history).toHaveTextContent('RSS sum (shared pages may be double counted)')
    expect(within(history).getByText('Shared')).toBeInTheDocument(); expect(within(history).getByText('Partial')).toBeInTheDocument()
    expect(history).toHaveTextContent('Server limit reached'); expect(history).toHaveTextContent('Process tree partially observed')
    expect(screen.queryByText('Fresh')).toBeNull()
  })
  it('keeps historical caller denial explicit with no captured values', () => {
    fresh(); render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.denied} />, { wrapper })
    expect(screen.getByText('Access denied')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
    expect(screen.queryByText(/CPU 0.0%/)).toBeNull()
  })
  it.each(['ended', 'evicted', 'shared-restricted'] as const)('keeps historical no-sample reason %s explicit', reason => {
    fresh(); render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={{ ...noSample(telemetryOwnedFixture), reason }} />, { wrapper })
    expect(screen.getByText({ ended: 'Execution ended', evicted: 'Evicted from server cache', 'shared-restricted': 'Shared processes restricted' }[reason])).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
  })
  it('retains OS denial reasons when history contains no captured values', () => {
    fresh(); render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.permissionDenied} />, { wrapper })
    expect(screen.getByText(/Operating system denied the read/)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
  })
  it('rejects whole-computer lastKnown and a captured sample for another historical selection', () => {
    fresh(); const ended = fixtures.ended!, computer = fixtures.computerZero!
    if (ended.kind !== 'sample' || computer.kind !== 'sample') throw new Error('sample fixtures')
    const view = render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={{ ...ended, lastKnown: computer.sample }} />, { wrapper })
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
    view.rerender(<ScopedResourceTelemetry mode="historical" context={context} ownedSelector={{ ...telemetryOwnedFixture, attributionRevision: '2' }} capturedOwned={fixtures.freshZero} />)
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
  })

  it('does not label a whole-computer sample as captured execution metrics', () => {
    fresh()
    render(<ScopedResourceTelemetry mode="historical" context={context} capturedOwned={fixtures.computerZero} />, { wrapper })
    expect(screen.getByText('Historical metrics unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Captured execution metrics' })).toBeNull()
  })
})

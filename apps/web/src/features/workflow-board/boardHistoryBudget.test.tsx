// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpResponse } from 'msw'
import { RunActivitySchema } from '@foreman-code/contracts'
import { CurrentRunDetailsSchema, RunExecutionDetailSchema } from '@foreman-code/contracts/wave25'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { executionPagesKey } from './inspect/queries'
import {
  boardHref, installBoardTestLifecycle, intervalTick, measureBoardWire, mountMeasuredBoard, openRunDetails,
  type InspectionFixture,
} from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture
let serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`eng05d-budget-${++serial}`) })

async function seedLongHistory() {
  const owner = fixture.runs.before
  const attempts = await Promise.all(Array.from({ length: 151 }, (_, index) => fixture.execution(owner, 0, undefined, index + 1)))
  for (const item of attempts.slice(0, -1)) {
    item.detail = RunExecutionDetailSchema.parse({ ...item.detail,
      execution: { ...item.detail.execution, acceptedResultAvailable: false },
      acceptedResult: { status: 'not_accepted' },
      reportedResult: { outcome: 'failed', error: { code: 'TEST_INTERRUPTED_ATTEMPT', message: 'Technical retry, not another repetition', retryable: true } } })
  }
  fixture.mock.inspection.set(owner.run.id, attempts)
  fixture.mock.history.set(owner.run.id, Array.from({ length: 252 }, (_, sequence) => RunActivitySchema.parse({
    id: `eng05d-event-${sequence}`, runId: owner.run.id, sequence, source: 'backend', kind: 'result_recorded',
    occurredAt: fixture.before.createdAt, payload: { text: `Event ${sequence}: ${'bounded fixture payload '.repeat(8)}` },
  })))
  // Additional independent, schema-valid V3 Run records, not invented repeat rounds.
  const originals = [...fixture.mock.runs.values()]
  for (let index = 0; index < 61; index++) {
    const base = originals[index % originals.length]!
    const runId = `eng05d-history-run-${index.toString().padStart(3, '0')}`
    fixture.mock.runs.set(runId, CurrentRunDetailsSchema.parse({ ...base, run: { ...base.run, id: runId } }))
  }
}

// The selected Run's one polled live read is its saved-Board snapshot (every three seconds).
const snapshotKeys = ['runs-selector', 'snapshot'] as const
const isSnapshotRead = (request: Request) => request.method === 'GET' && new URL(request.url).pathname.endsWith('/snapshot')
const snapshotState = (cache: QueryClient) => cache.getQueryCache().find({ queryKey: snapshotKeys })?.state
const snapshotIdle = (cache: QueryClient) => waitFor(() => expect(snapshotState(cache)).toMatchObject({ fetchStatus: 'idle' }))

function totals(samples: readonly { responseBytes: number }[]) {
  return { requests: samples.length, bytes: samples.reduce((sum, sample) => sum + sample.responseBytes, 0) }
}

async function expectLoadedHistoryItems(container: HTMLElement, count: number) {
  // Role queries check styles and ancestors for every row. Keep that work out of
  // retries while MSW and React are still delivering the requested page.
  await waitFor(() => expect(container.querySelectorAll('li')).toHaveLength(count), {
    container,
    mutationObserverOptions: { childList: true, subtree: true },
  })
  expect(within(container).getAllByRole('listitem')).toHaveLength(count)
}

describe('mounted Board bounded-history wire budgets', () => {
  it('waits for the loaded page before checking every history row for accessibility', async () => {
    const rows = (count: number) => <ol>{Array.from({ length: count }, (_, index) =>
      <li key={index}>Recorded activity {index}</li>)}</ol>
    const view = render(rows(250))
    const list = screen.getByRole('list')
    const styleReads = vi.spyOn(window, 'getComputedStyle')
    let styleReadsBeforePage = 0
    queueMicrotask(() => {
      styleReadsBeforePage = styleReads.mock.calls.length
      view.rerender(rows(251))
    })

    await expectLoadedHistoryItems(list, 251)

    // A role scan of the old page must not compete with rendering the next page.
    expect(styleReadsBeforePage).toBe(0)
    expect(styleReads.mock.calls.length).toBeGreaterThan(0)
  })

  it('preserves loaded history while recovering a failed live Run read', async () => {
    await seedLongHistory()
    const scope = fixture.runs.before.scope
    let restarting = false
    const wire = measureBoardWire(fixture.mock, (request) => {
      if (restarting && isSnapshotRead(request)) {
        return new HttpResponse(null, { status: 503 })
      }
      return undefined
    })
    const live = () => wire.matching((sample) => sample.method === 'GET' && sample.path.endsWith('/snapshot'))
    const user = userEvent.setup()
    const { cache } = await mountMeasuredBoard(boardHref(scope))
    const inspector = await openRunDetails()
    await expectLoadedHistoryItems(inspector, 25)
    await user.click(within(inspector).getByRole('button', { name: 'Load more executions' }))
    await expectLoadedHistoryItems(inspector, 50)
    const history = screen.getByText('Run activity history').closest('details')!
    fireEvent.click(within(history).getByText('Run activity history'))
    await expectLoadedHistoryItems(history, 50)
    await user.click(within(history).getByRole('button', { name: 'Load more activity' }))
    await expectLoadedHistoryItems(history, 100)
    await user.click(screen.getByRole('button', { name: 'Load more Runs' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more Runs' })).toBeEnabled())
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(wire.executions()).toHaveLength(2)
    expect(wire.activity()).toHaveLength(2)
    expect(wire.runLists()).toHaveLength(2)

    restarting = true
    await act(async () => { await cache.invalidateQueries({ queryKey: snapshotKeys }) })
    expect(await screen.findByRole('alert', { name: 'Server connection' }))
      .toHaveTextContent('Updating — reconnecting…')
    const currentBefore = live().length
    restarting = false
    await intervalTick(1000)
    await waitFor(() => expect(snapshotState(cache)).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    await waitFor(async () => {
      await intervalTick(1000)
      expect(screen.queryByRole('alert', { name: 'Server connection' })).not.toBeInTheDocument()
    })
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(live().length).toBeGreaterThan(currentBefore)
    expect(wire.executions()).toHaveLength(2)
    expect(wire.activity()).toHaveLength(2)
    expect(wire.runLists()).toHaveLength(2)
    expect(within(inspector).getAllByRole('listitem')).toHaveLength(50)
    expect(within(history).getAllByRole('listitem')).toHaveLength(100)
    expect(wire.writes()).toHaveLength(0)
  }, 30_000)

  it('keeps five loaded page windows off the live Run polling path and refreshes each from one bounded first page', async () => {
    await seedLongHistory()
    const scope = fixture.runs.before.scope
    const wire = measureBoardWire(fixture.mock)
    const live = () => wire.matching((sample) => sample.method === 'GET' && sample.path.endsWith('/snapshot'))
    const user = userEvent.setup()
    const { cache } = await mountMeasuredBoard(boardHref(scope))
    const inspector = await openRunDetails()
    await expectLoadedHistoryItems(inspector, 25)
    expect(within(inspector).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
    expect(wire.activity()).toHaveLength(0)
    const loadMoreExecutions = within(inspector).getByRole('button', { name: 'Load more executions' })
    const refreshExecutions = within(inspector).getByRole('button', { name: 'Refresh executions' })
    const loadMoreRuns = screen.getByRole('button', { name: 'Load more Runs' })
    const refreshRuns = screen.getByRole('button', { name: 'Refresh Runs' })
    for (let page = 2; page <= 5; page++) {
      await user.click(loadMoreExecutions)
      await expectLoadedHistoryItems(inspector, page * 25)
    }
    const history = screen.getByText('Run activity history').closest('details')!
    fireEvent.click(within(history).getByText('Run activity history'))
    await expectLoadedHistoryItems(history, 50)
    for (let page = 2; page <= 5; page++) {
      await user.click(within(history).getByRole('button', { name: 'Load more activity' }))
      await expectLoadedHistoryItems(history, page * 50)
    }
    await waitFor(() => expect(wire.runLists()).toHaveLength(1))
    await user.click(loadMoreRuns)
    await waitFor(() => expect(wire.runLists()).toHaveLength(2))
    await waitFor(() => expect(loadMoreRuns).toBeEnabled())

    expect(wire.executions()).toHaveLength(5)
    expect(wire.activity()).toHaveLength(5)
    expect(wire.executions().map((sample) => sample.query.has('cursor'))).toEqual([false, true, true, true, true])
    expect(wire.activity().map((sample) => sample.query.has('cursor'))).toEqual([false, true, true, true, true])
    for (const sample of wire.executions()) {
      expect(sample.query.get('limit')).toBe('25')
      expect(sample.itemCount).toBe(25)
      expect(sample.responseBytes).toBeGreaterThan(0)
      expect(sample.responseBytes).toBeLessThan(64 * 1024)
      // These are metadata pages, never accepted inputs/results or provider bodies.
      expect(JSON.stringify(sample.body)).not.toMatch(/acceptedInput|nativeSession|credential|workingDirectory/)
    }
    for (const sample of wire.activity()) {
      expect(sample.query.get('limit')).toBe('50')
      expect(sample.itemCount).toBe(50)
      expect(sample.responseBytes).toBeLessThan(64 * 1024)
    }
    for (const sample of wire.runLists()) {
      expect(sample.query.get('limit')).toBe('20')
      expect(sample.itemCount).toBeLessThanOrEqual(20)
    }
    const historyBefore = { executions: totals(wire.executions()), events: totals(wire.activity()), runs: totals(wire.runLists()) }
    const retainedPages = cache.getQueryData(executionPagesKey(scope, {}))
    const currentBefore = live().length
    for (let tick = 1; tick <= 8; tick++) {
      await intervalTick(3000)
      await waitFor(() => expect(live()).toHaveLength(currentBefore + tick))
      await snapshotIdle(cache)
    }
    expect({ executions: totals(wire.executions()), events: totals(wire.activity()), runs: totals(wire.runLists()) }).toEqual(historyBefore)
    expect(cache.getQueryData(executionPagesKey(scope, {}))).toBe(retainedPages)
    expect(live().slice(currentBefore).every((sample) => sample.responseBytes > 0 && sample.responseBytes < 16 * 1024)).toBe(true)
    expect(wire.writes()).toHaveLength(0)

    // Reconnect is automatic current evidence, not permission to replay five pages.
    // Explicit refresh below must discard the old cursor chain, not refetch it.
    await user.click(refreshExecutions)
    await expectLoadedHistoryItems(inspector, 25)
    expect(wire.executions()).toHaveLength(6)
    expect(wire.executions().at(-1)!.query.has('cursor')).toBe(false)
    await user.click(within(history).getByRole('button', { name: 'Refresh activity' }))
    await expectLoadedHistoryItems(history, 50)
    expect(wire.activity()).toHaveLength(6)
    expect(wire.activity().at(-1)!.query.has('cursor')).toBe(false)
    await user.click(refreshRuns)
    await waitFor(() => expect(wire.runLists()).toHaveLength(3))
    expect(wire.runLists().at(-1)!.query.has('cursor')).toBe(false)
    wire.report('mounted-151-attempts-252-events-64-runs-eight-ticks')
  }, 30_000)

  it('isolates live Run refresh requests from unopened history collections', async () => {
    const scope = fixture.runs.before.scope
    const wire = measureBoardWire(fixture.mock)
    const live = () => wire.matching((sample) => sample.method === 'GET' && sample.path.endsWith('/snapshot'))
    const { cache } = await mountMeasuredBoard(boardHref(scope))
    await waitFor(() => expect(live()).toHaveLength(1))
    await snapshotIdle(cache)
    const bytes = live()[0]!.responseBytes
    const eventsBefore = wire.activity().length
    await seedLongHistory()
    // The current mock is fixed: this checks UI request isolation. Persisted
    // history payload growth is covered through the real API integration test.
    await act(async () => { await cache.invalidateQueries({ queryKey: snapshotKeys }) })
    await waitFor(() => expect(live()).toHaveLength(2))
    expect(live()[1]!.responseBytes).toBe(bytes)
    expect(wire.activity()).toHaveLength(eventsBefore)
    expect(wire.matching((sample) => sample.query.has('cursor'))).toHaveLength(0)
    expect(wire.writes()).toHaveLength(0)
    wire.report('lifetime-growth-does-not-grow-current-cut')
  }, 15_000)
})

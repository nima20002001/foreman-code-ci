// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { actionKey } from './actions/state'
import { currentRunKey } from './currentRunQuery'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  boardHref, currentIdle, installBoardTestLifecycle, intervalTick, measureBoardWire, mountMeasuredBoard,
  openRunDetails, setRunState, type InspectionFixture,
} from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`eng05d-actions-${++serial}`) })

async function actionReadFailure() {
  const scope = fixture.runs.before.scope
  setRunState(fixture, scope, 'running')
  let failNext = false
  const wire = measureBoardWire(fixture.mock, (request) => {
    const url = new URL(request.url)
    if (failNext && url.pathname.endsWith('/executions') && url.searchParams.get('limit') === '1') {
      failNext = false
      return HttpResponse.json({ error: { code: 'RUN_INSPECTION_UNAVAILABLE', message: 'Task-owned transient outage' } }, { status: 503 })
    }
    return undefined
  })
  const mounted = await mountMeasuredBoard(boardHref(scope))
  await openRunDetails()
  const key = actionKey(scope, 'status', scope.workflowVersionId)
  await waitFor(() => expect(mounted.cache.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  await currentIdle(mounted.cache, currentRunKey(scope))
  failNext = true
  await act(async () => { await mounted.cache.invalidateQueries({ queryKey: key, exact: true }) })
  await waitFor(() => expect(mounted.cache.getQueryState(key)).toMatchObject({ status: 'error', fetchStatus: 'idle' }))
  expect(wire.executions('1').at(-1)?.status).toBe(503)
  return { ...mounted, scope, key, wire }
}

describe('contextual action recovery on the mounted Board', () => {
  it('keeps the five-second status polling cadence during a transient endpoint failure', async () => {
    const { key, wire, cache } = await actionReadFailure()
    const before = wire.executions('1').length
    const historyBefore = wire.executions().length
    await intervalTick(4000)
    expect(wire.executions('1')).toHaveLength(before)
    expect(cache.getQueryState(key)).toMatchObject({ status: 'error', fetchStatus: 'idle' })
    expect(screen.getByRole('region', { name: 'Selected Run actions' }))
      .toHaveTextContent('Cached state is not shown as current evidence')
    await intervalTick(1000)
    await waitFor(() => expect(cache.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    expect(wire.executions('1')).toHaveLength(before + 1)
    expect(wire.executions()).toHaveLength(historyBefore)
    expect(wire.writes()).toHaveLength(0)
    expect(wire.activity()).toHaveLength(0)
  }, 15_000)

  it('regression: retries bounded contextual status after a transient failure without a user click', async () => {
    const { key, wire, cache } = await actionReadFailure()
    const before = wire.executions('1').length
    const historyBefore = wire.executions().length
    await intervalTick(5000)
    // A failed current-state read must not leave otherwise active Run actions
    // permanently frozen. At 97f9ccd RunActions.tsx stops on *any* error (D-02).
    try { await waitFor(() => expect(wire.executions('1')).toHaveLength(before + 1)) }
    finally { wire.report('contextual-status-after-transient-error') }
    await waitFor(() => expect(cache.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    expect(wire.executions()).toHaveLength(historyBefore)
    expect(wire.writes()).toHaveLength(0)
    wire.report('contextual-status-transient-recovery')
  }, 15_000)

  it('keeps manual client reconnect read-only and does not advertise unsupported Resume', async () => {
    const { key, wire, cache } = await actionReadFailure()
    const controls = screen.getByRole('region', { name: 'Selected Run actions' })
    expect(controls).toHaveTextContent('Cached state is not shown as current evidence')
    const before = wire.executions('1').length
    const historyBefore = wire.executions().length
    await userEvent.setup().click(within(controls).getByRole('button', { name: 'Refresh / reconnect client state' }))
    await waitFor(() => expect(cache.getQueryState(key)).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
    await within(controls).findByText('Client state refreshed.')
    expect(wire.executions('1')).toHaveLength(before + 1)
    expect(wire.executions()).toHaveLength(historyBefore)
    expect(within(controls).getByRole('button', { name: 'Resume execution — unavailable' })).toBeDisabled()
    expect(wire.writes()).toHaveLength(0)
    expect(wire.activity()).toHaveLength(0)
    wire.report('manual-client-reconnect-is-not-native-recovery')
  }, 15_000)
})

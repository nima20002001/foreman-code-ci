import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ComputerMaintenanceStartInput, MaintenanceStatus } from '@foreman-code/contracts/computer-maintenance'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, deviceName, deviceTarget, mainId, mainTarget, registration } from './computersTestFixture'

type WorkerStatus = NonNullable<MaintenanceStatus['worker']>
const worker: WorkerStatus = {
  currentVersion: '0.0.56', targetVersion: '0.0.56', state: 'current', lastError: null,
}
/** A Worker whose published target is newer than the version it runs. */
const behind: WorkerStatus = { ...worker, targetVersion: '0.0.57' }

function status(workerStatus?: WorkerStatus): MaintenanceStatus {
  return {
    observedAt: new Date().toISOString(), harnesses: [], tasks: [],
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null },
    ...(workerStatus ? { worker: workerStatus } : {}),
  }
}

afterEach(() => vi.useRealTimers())

it('retries a failed Worker task even when the updater still reports its current version', async () => {
  const requests: ComputerMaintenanceStartInput[] = []
  const maintenance = status(worker)
  maintenance.tasks.push({ id: crypto.randomUUID(), kind: 'update-worker', state: 'failed',
    startedAt: '2026-10-17T14:00:00.000Z', finishedAt: '2026-10-17T14:01:00.000Z',
    summary: 'Download failed', outputTail: '' })
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [{ target: deviceTarget, status: maintenance }] }),
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      requests.push(await request.json() as ComputerMaintenanceStartInput)
      return HttpResponse.json({ computers: [] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByRole('img', { name: 'Update: update failed' })).toBeVisible()
  const update = within(device).getByRole('button', { name: 'Update' })
  expect(update).toBeEnabled()
  await userEvent.click(update)
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ task: { kind: 'update-worker' }, targets: [deviceTarget] })
})

it('shows the GitHub publication failure and does not offer a Worker update until a published target is available', async () => {
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      return HttpResponse.json({ computers: [{ target, status: status(behind),
        workerPublication: { version: '0.0.57', state: 'failed',
          lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: GitHub asset not found' },
      }] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByRole('alert')).toHaveTextContent('GitHub asset not found')
  expect(within(device).getByRole('alert')).toHaveTextContent('Worker 0.0.57 publication failed')
  expect(within(device).getByRole('button', { name: 'Update' })).toBeDisabled()
})

it('shows current and target Worker versions only on paired computers', async () => {
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [
      { target: mainTarget, status: status(worker) }, { target: deviceTarget, status: status(worker) },
    ] }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Current 0.0.56')).toBeVisible()
  expect(within(device).getByText('Target 0.0.56')).toBeVisible()
  expect(within(device).getByRole('status')).toHaveTextContent('Up to date')
  expect(within(device).getByRole('img', { name: 'Update: up to date' })).toBeVisible()
  const main = screen.getByRole('article', { name: 'Main PC' })
  expect(within(main).queryByText('Current 0.0.56')).not.toBeInTheDocument()
  expect(within(main).queryByText('Worker')).not.toBeInTheDocument()
})

it.each([
  ['pending', 'Update pending'],
  ['draining', 'Waiting for current work to finish'],
  ['downloading', 'Downloading update'],
  ['installing', 'Installing update'],
  ['restarting', 'Restarting Worker'],
] as const)('shows %s progress and prevents a second Worker update', async (state, label) => {
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [
      { target: deviceTarget, status: status({ ...worker, targetVersion: '0.0.57', state }) },
    ] }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText(label)).toBeVisible()
  expect(within(device).getByRole('img', { name: 'Update: updating…' })).toBeVisible()
  expect(within(device).getByRole('button', { name: 'Update' })).toBeDisabled()
})

it.each(['failed', 'rolled-back'] as const)('shows the %s error and retries the paired Worker', async state => {
  const requests: ComputerMaintenanceStartInput[] = []
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [
      { target: deviceTarget, status: status({ ...worker, targetVersion: '0.0.57', state,
        lastError: 'Artifact digest did not match.' }) },
    ] }),
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      requests.push(await request.json() as ComputerMaintenanceStartInput)
      return HttpResponse.json({ computers: [] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Last error: Artifact digest did not match.')).toBeVisible()
  expect(within(device).getByRole('status')).toHaveTextContent(
    state === 'failed' ? 'Update failed' : 'Rolled back to previous version',
  )
  expect(within(device).getByRole('img', { name: 'Update: update failed' })).toBeVisible()
  await userEvent.click(within(device).getByRole('button', { name: 'Update' }))
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toMatchObject({ task: { kind: 'update-worker' }, targets: [deviceTarget] })
})

it('can request an update while work is running and shows the server drain readback', async () => {
  let workerStatus: WorkerStatus = behind
  const requests: ComputerMaintenanceStartInput[] = []
  const { activity } = computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      return HttpResponse.json({ computers: [{ target,
        status: target.hostRef.kind === 'device' ? status(workerStatus) : null,
      }] })
    }),
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      requests.push(await request.json() as ComputerMaintenanceStartInput)
      workerStatus = { ...worker, targetVersion: '0.0.57', state: 'draining' }
      return HttpResponse.json({ computers: [] })
    }),
  ])
  activity.computers[1]!.agents = [{
    id: 'execution-1', workspaceId: 'workspace', workflowId: 'workflow', workflowName: 'Website',
    runId: 'run-1', nodeId: 'node-1', agentName: 'Coder', state: 'running',
  }]
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('1 agent running · 1 workflow')).toBeVisible()
  const update = within(device).getByRole('button', { name: 'Update' })
  expect(update).toBeEnabled()
  await userEvent.click(update)
  expect(await within(device).findByText('Waiting for current work to finish')).toBeVisible()
  expect(within(device).getByText('Target 0.0.57')).toBeVisible()
  expect(update).toBeDisabled()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ task: { kind: 'update-worker' }, targets: [deviceTarget] })
})

it('shows unavailable Worker observations and disables updates until status is available', async () => {
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [
      { target: deviceTarget, status: status() },
    ] }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Status unavailable')).toBeVisible()
  expect(within(device).queryByText(/Current /)).not.toBeInTheDocument()
  expect(within(device).getByRole('button', { name: 'Update' })).toBeDisabled()
})

it('locks Worker updates after a failed status refresh and restores them after readback succeeds', async () => {
  let fail = false
  const { client } = computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      if (target.hostRef.kind === 'device' && fail) {
        return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Worker disconnected.' } }, { status: 503 })
      }
      return HttpResponse.json({ computers: [{ target,
        status: target.hostRef.kind === 'device' ? status(behind) : null,
      }] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  await within(device).findByText('Current 0.0.56')
  const update = within(device).getByRole('button', { name: 'Update' })
  expect(update).toBeEnabled()
  fail = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-maintenance'] }) })
  expect(await within(device).findByRole('alert')).toHaveTextContent('Showing last confirmed details')
  expect(update).toBeDisabled()
  fail = false
  await userEvent.click(within(device).getByRole('button', { name: 'Retry maintenance' }))
  await waitFor(() => expect(update).toBeEnabled())
  expect(within(device).queryByRole('alert')).not.toBeInTheDocument()
})

it('locks new actions during a pending or uncertain Worker request and retries the original command', async () => {
  const requests: ComputerMaintenanceStartInput[] = []
  let finishRequest: ((response: Response) => void) | undefined
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [
      { target: deviceTarget, status: status(behind) },
    ] }),
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      requests.push(await request.json() as ComputerMaintenanceStartInput)
      if (requests.length === 1) return new Promise<Response>(resolve => { finishRequest = resolve })
      return HttpResponse.json({ computers: [] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  const update = await within(device).findByRole('button', { name: 'Update' })
  await userEvent.click(update)
  await waitFor(() => expect(finishRequest).toBeDefined())
  expect(update).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Update computers' })).toBeDisabled()
  await act(async () => { finishRequest!(HttpResponse.error()) })
  const retry = await screen.findByRole('button', { name: 'Retry original maintenance request' })
  expect(update).toBeDisabled()
  await userEvent.click(retry)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry original maintenance request' }))
    .not.toBeInTheDocument())
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(update).toBeEnabled()
})

it('polls automatic Worker updates without a maintenance task and reads the completed version', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let workerStatus: WorkerStatus = { ...worker, targetVersion: '0.0.57', state: 'downloading' }
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      return HttpResponse.json({ computers: [{ target,
        status: target.hostRef.kind === 'device' ? status(workerStatus) : null,
      }] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Downloading update')).toBeVisible()
  workerStatus = { ...worker, currentVersion: '0.0.57', targetVersion: '0.0.57', state: 'current' }
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(await within(device).findByText('Current 0.0.57')).toBeVisible()
  expect(within(device).getByRole('status')).toHaveTextContent('Up to date')
  expect(within(device).getByRole('img', { name: 'Update: up to date' })).toBeVisible()
})

it('keeps polling and update actions locked while the restarting Worker reconnects', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let maintenanceStatus: MaintenanceStatus | null = status({
    ...worker, targetVersion: '0.0.57', state: 'restarting',
  })
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      return HttpResponse.json({ computers: [{ target,
        status: target.hostRef.kind === 'device' ? maintenanceStatus : null,
      }] })
    }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  expect(await within(device).findByText('Restarting Worker')).toBeVisible()
  const update = within(device).getByRole('button', { name: 'Update' })
  expect(update).toBeDisabled()
  maintenanceStatus = null
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(await within(device).findByText('Status unavailable')).toBeVisible()
  expect(update).toBeDisabled()
  maintenanceStatus = status({ ...worker, currentVersion: '0.0.57', targetVersion: '0.0.57' })
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(await within(device).findByText('Current 0.0.57')).toBeVisible()
  expect(within(device).getByRole('status')).toHaveTextContent('Up to date')
  expect(within(device).getByRole('img', { name: 'Update: up to date' })).toBeVisible()
})

it.each([
  ['WORKER_VERSION_SKEW', 'current', 'Worker update required'],
  ['WORKER_BUNDLE_UNPUBLISHED', 'current', 'Worker bundle unavailable'],
  ['WORKER_UPDATING', 'downloading', 'Downloading update'],
] as const)('shows %s readiness alongside updater progress', async (code, state, message) => {
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [{ target: deviceTarget, status: status({ ...worker, state }),
      workerReadiness: { ready: false, code, expected: null, running: null,
        updatePhase: state, publicationError: null },
    }] }),
  ])
  const device = await screen.findByRole('article', { name: deviceName })
  await within(device).findByText('Current 0.0.56')
  expect(within(device).getByRole('status')).toHaveTextContent(message)
  expect(within(device).getByRole('status')).not.toHaveTextContent('Up to date')
})

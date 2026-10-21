import { onlineManager } from '@tanstack/react-query'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import type { MaintenanceStatus, MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { computerKey } from '../../shared/api/computerActivity'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, deviceName, deviceTarget, mainId, mainTarget, registration } from './computersTestFixture'

afterEach(() => onlineManager.setOnline(true))

function status(tasks: MaintenanceTask[] = []): MaintenanceStatus {
  return { observedAt: new Date().toISOString(), tasks,
    harnesses: [{ harness: 'codex', installed: true, version: '1.0', latest: '2.0' }],
    system: { packageUpdates: 2, rebootRequired: true, sudo: true,
      disk: { path: '/home/owner', freeBytes: 40e9, totalBytes: 100e9 } } }
}

function task(kind: MaintenanceTask['kind'], state: MaintenanceTask['state']): MaintenanceTask {
  return { id: crypto.randomUUID(), kind, state, startedAt: new Date().toISOString(),
    finishedAt: state === 'running' ? null : new Date().toISOString(),
    summary: state === 'failed' ? 'Package download failed' : 'Finished', outputTail: '' }
}

it('shows only the newest task of each kind from the shared maintenance response', async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({ ...task('sync-mcp', 'succeeded'), summary: `Sync ${index}`,
    startedAt: new Date(Date.UTC(2026, 9, 17, 12, index)).toISOString() }))
  tasks.push({ ...task('update-system', 'running') }, { ...task('sync-plugins', 'running') })
  let requestedLimit: unknown
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} only={registration.deviceId} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const input = await request.json() as { target: DeviceProvisioningTarget; taskLimit?: number }
      requestedLimit = input.taskLimit
      return HttpResponse.json({ computers: [{ target: input.target, status: status(tasks), tasksOmitted: 11 }] })
    }),
  ])
  const card = await screen.findByRole('article', { name: deviceName })
  expect(await within(card).findByText('MCP sync: Sync 4')).toBeVisible()
  expect(requestedLimit).toBe(5)
  for (let index = 0; index < 4; index++) expect(within(card).queryByText(`MCP sync: Sync ${index}`)).not.toBeInTheDocument()
  expect(within(card).queryByText(/older maintenance task/)).not.toBeInTheDocument()
  expect(within(card).getByText('System update…')).toBeVisible()
  expect(within(card).getByText('Plugin sync…')).toBeVisible()
})

it.each(['succeeded', 'running'] as const)('keeps an older failed sibling visible beside a newer %s task on detail', async state => {
  const upkeep = status([task('update-system', state), task('update-harnesses', 'failed')])
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} only={registration.deviceId} />, [
    computerReadHandler('maintenance', { computers: [{ target: deviceTarget, status: upkeep }] }),
  ])
  const card = await screen.findByRole('article', { name: deviceName })
  expect(await within(card).findByText('Harness update: Package download failed')).toBeVisible()
  if (state === 'running') expect(within(card).getByText('System update…')).toBeVisible()
})

it.each(['running', 'succeeded'] as const)('qualifies cached %s maintenance after a refresh error and recovers through retry', async state => {
  let fail = false
  const upkeep = status([task('update-system', state)])
  const { client } = computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    http.post('*/api/management/computers/maintenance/read', () => fail
      ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Maintenance disconnected.' } }, { status: 503 })
      : HttpResponse.json({ computers: [{ target: mainTarget, status: upkeep }] })),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  await within(card).findByText('40 GB free of 100 GB')
  fail = true
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-maintenance'] }) })
  expect(await within(card).findByRole('alert')).toHaveTextContent('Showing last confirmed details')
  expect(within(card).getByRole('alert')).toHaveTextContent('Current task state is unknown')
  expect(within(card).getByRole('status')).toHaveTextContent('Last confirmed: System update')
  expect(within(card).getByRole('button', { name: 'Restart' })).toBeDisabled()
  fail = false
  await userEvent.click(within(card).getByRole('button', { name: 'Retry maintenance' }))
  await waitFor(() => expect(within(card).queryByRole('alert')).not.toBeInTheDocument())
  expect(within(card).getByRole('button', { name: 'Restart' })).toBeEnabled()
})

it('explains an initial maintenance read failure without implying cached facts', async () => {
  computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    http.post('*/api/management/computers/maintenance/read', () =>
      HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Disconnected.' } }, { status: 503 })),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  expect(await within(card).findByRole('alert')).toHaveTextContent('Maintenance could not be refreshed.')
  expect(within(card).getByRole('alert')).not.toHaveTextContent('Showing last confirmed')
})

it('distinguishes stale browser observations from a fresh Offline server observation', async () => {
  const { activity, client } = computersFixture(<ComputerCards mainId={mainId} devices={[]} />)
  const card = await screen.findByRole('article', { name: 'Main PC' })
  await within(card).findByText('Online')
  act(() => onlineManager.setOnline(false))
  expect(within(card).getByText('Status stale')).toBeVisible()
  expect(within(card).queryByText('Offline')).not.toBeInTheDocument()
  expect(within(card).getByText(/Last observed: 0 agents running/)).toBeVisible()
  activity.computers[0]!.online = false
  act(() => onlineManager.setOnline(true))
  await act(async () => { await client.invalidateQueries({ queryKey: ['computer-activity'] }) })
  expect(await within(card).findByText('Offline')).toBeVisible()
})

it.each(['jobs', 'restricted', 'truncated'] as const)('warns about %s work before restart without claiming full visibility', async kind => {
  const { activity } = computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: status() }] }),
  ])
  if (kind === 'jobs') activity.computers[0]!.jobs.push({ id: 'job', name: 'Build', workspaceId: 'workspace',
    workspaceName: 'Workspace', phase: 'running', startedAt: new Date().toISOString() })
  if (kind === 'restricted') activity.activityComplete = false
  if (kind === 'truncated') activity.truncated = true
  const card = await screen.findByRole('article', { name: 'Main PC' })
  await userEvent.click(await within(card).findByRole('button', { name: 'Restart' }))
  if (kind === 'jobs') expect(within(card).getByRole('button', { name: 'Restart and stop 1 job?' })).toBeVisible()
  else {
    expect(within(card).getByText(/Visible activity: 0 agents running/)).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Restart? Other work may be running' })).toBeVisible()
  }
})

it('reads healthy observations and releases acknowledged maintenance while another computer is slow', async () => {
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const reads: string[] = []
  computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      reads.push(computerKey(target))
      if (target.hostRef.kind === 'device') await slow
      return HttpResponse.json({ computers: [{ target, status: status(),
        connections: { mcp: { codex: 'installed', claude: 'installed' }, accounts: { observedAt: new Date().toISOString(),
          accounts: [{ tool: 'github', installed: true, signedIn: true, account: 'healthy-owner', details: [] }] } } }] })
    }),
    http.post('*/api/management/computers/maintenance/start', () => HttpResponse.json({ computers: [] })),
  ])
  try {
    const card = await screen.findByRole('article', { name: 'Main PC' })
    expect(await within(card).findByRole('img', { name: 'GitHub: signed in' })).toBeVisible()
    await within(card).findByText('40 GB free of 100 GB')
    expect(reads).toContain(computerKey(deviceTarget))
    await userEvent.click(within(card).getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update computers' })).toBeEnabled())
  } finally {
    await act(async () => { release(); await slow })
  }
})

it('withholds an incomplete fleet rank and reads only the selected detail maintenance', async () => {
  let release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const selectedReads: string[] = []
  const { statuses } = computersFixture(<ComputerCards mainId={mainId} devices={[registration]} only={registration.deviceId} />, [
    http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      if (target.hostRef.kind === 'main') await slow
      return HttpResponse.json(statuses.get(computerKey(target)))
    }),
    http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: DeviceProvisioningTarget }
      selectedReads.push(computerKey(target))
      return HttpResponse.json({ computers: [{ target, status: null }] })
    }),
  ])
  const card = await screen.findByRole('article', { name: deviceName })
  expect(await within(card).findByText('Fleet priority loading · up to 60% CPU and RAM')).toBeVisible()
  expect(within(card).queryByText(/1st of 1/)).not.toBeInTheDocument()
  await waitFor(() => expect(selectedReads).toHaveLength(1))
  expect(selectedReads.every(value => value === computerKey(deviceTarget))).toBe(true)
  await act(async () => { release(); await slow })
  expect(await within(card).findByText('2nd of 2 · up to 60% CPU and RAM')).toBeVisible()
  expect(screen.queryByRole('article', { name: 'Main PC' })).not.toBeInTheDocument()
})

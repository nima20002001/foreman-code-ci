import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { MaintenanceStatus } from '@foreman-code/contracts/computer-maintenance'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, deviceName, deviceTarget, mainTarget, registration } from './computersTestFixture'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'

afterEach(() => useOperatorChatStore.getState().reset())

it('summarizes each computer on one card in build order with harnesses, GitHub, builds and activity', async () => {
  const { activity } = computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />)
  activity.computers[0]!.agents = [
    { id: 'execution-1', workspaceId: 'workspace', workflowId: 'workflow-a', workflowName: 'A', runId: 'run-1', nodeId: 'node-1', agentName: 'Coder', state: 'running' },
    { id: 'execution-2', workspaceId: 'workspace', workflowId: 'workflow-a', workflowName: 'A', runId: 'run-1', nodeId: 'node-2', agentName: 'Reviewer', state: 'running' },
  ]
  const main = await screen.findByRole('article', { name: 'Main PC' })
  const device = screen.getByRole('article', { name: deviceName })
  expect(await within(main).findByText('1st of 2 · up to 60% CPU and RAM')).toBeVisible()
  const cards = screen.getAllByRole('article')
  expect(cards.indexOf(main)).toBeLessThan(cards.indexOf(device))
  expect(within(main).getByText('Online')).toBeVisible()
  expect(await within(main).findByRole('img', { name: 'GitHub: signed in' })).toBeVisible()
  expect(within(main).getByRole('img', { name: 'Codex: signed in' })).toBeVisible()
  expect(within(main).getByRole('img', { name: 'Claude: signed out' })).toBeVisible()
  expect(within(main).queryByText(/OpenCode/)).not.toBeInTheDocument()
  expect(within(device).getByText('2nd of 2 · up to 60% CPU and RAM')).toBeVisible()
  expect(within(main).getByText('2 agents running · 1 workflow')).toBeVisible()
  expect(within(main).queryByRole('combobox')).not.toBeInTheDocument()
  expect(within(main).queryByRole('switch')).not.toBeInTheDocument()
})

it('asks the Operator to fix a signed-out harness and drafts a settings change without sending it', async () => {
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />)
  const main = await screen.findByRole('article', { name: 'Main PC' })
  await userEvent.click(await within(main).findByRole('button', { name: 'Sign in to Claude' }))
  expect(useOperatorChatStore.getState()).toMatchObject({ open: true, request: { content: 'Sign Claude in on Main PC.', send: true } })
  await userEvent.click(within(main).getByRole('button', { name: 'Ask Operator to change…' }))
  expect(useOperatorChatStore.getState().request).toMatchObject({ content: 'On Main PC: ', send: false })
})

it.each([
  { observation: 'null', version: '1.0' },
  { observation: 'absent', version: '1.0' },
  { observation: 'null', version: null },
] as const)('shows unknown sign-in without sign-in prompts ($observation, $version)', async ({ observation, version }) => {
  const accounts = observation === 'absent' ? [] : (['codex', 'claude', 'github'] as const).map(tool => ({
    tool, installed: true, signedIn: null, account: null, details: [],
  }))
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget,
      connections: { accounts: { observedAt: new Date().toISOString(), accounts }, mcp: { codex: 'installed', claude: 'installed' } },
      status: { observedAt: new Date().toISOString(), tasks: [],
        harnesses: (['codex', 'claude'] as const).map(harness => ({ harness, installed: true, version, latest: version })),
        system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } } }] }),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  expect(await within(card).findByRole('img', { name: 'Codex: sign-in unknown' })).toBeVisible()
  expect(within(card).getByRole('img', { name: 'Claude: sign-in unknown' })).toBeVisible()
  expect(within(card).getByRole('img', { name: observation === 'absent' ? 'GitHub: unknown' : 'GitHub: sign-in unknown' })).toBeVisible()
  expect(within(card).queryByRole('img', { name: /signed out/i })).not.toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: /Sign in/ })).not.toBeInTheDocument()
})

it('offers GitHub sign-in for an explicit signed-out observation', async () => {
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: null,
      connections: { mcp: { codex: null, claude: null }, accounts: { observedAt: new Date().toISOString(), accounts: [
        { tool: 'github', installed: true, signedIn: false, account: null, details: [] },
      ] } } }] }),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  expect(await within(card).findByRole('img', { name: 'GitHub: signed out' })).toBeVisible()
  await userEvent.click(within(card).getByRole('button', { name: 'Sign in to GitHub' }))
  expect(useOperatorChatStore.getState().request).toMatchObject({
    content: 'Sign GitHub in on Main PC and set up git to use it.', send: true,
  })
})

it.each([['pending', 'Pairing pending'], ['revoked', 'Access revoked']] as const)('shows a %s computer as a short registration card', async (status, label) => {
  const device: DeviceRegistration = { ...registration, status }
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[device]} />)
  const card = await screen.findByRole('article', { name: /^Computer / })
  expect(within(card).getByText(label)).toBeVisible()
})

it('shows versions, OS updates, restart need and disk, and starts maintenance on that computer in one click', async () => {
  const started: unknown[] = []
  const status: MaintenanceStatus = { observedAt: new Date().toISOString(), tasks: [{ id: '77777777-7777-4777-8777-777777777777', kind: 'update-system',
      state: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: '4 packages upgraded', outputTail: '' }],
    harnesses: [{ harness: 'codex', installed: true, version: '0.160.0', latest: '0.161.0' }, { harness: 'claude', installed: false, version: null, latest: '2.1.294' }],
    system: { packageUpdates: 3, rebootRequired: true, sudo: true, disk: { path: '/home/owner', freeBytes: 41e9, totalBytes: 193e9 } } }
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status }, { target: deviceTarget, status: null }] }),
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => { started.push(await request.json()); return HttpResponse.json({ computers: [] }) }),
  ])
  const main = await screen.findByRole('article', { name: 'Main PC' })
  expect(await within(main).findByRole('img', { name: 'Claude: not installed' })).toBeVisible()
  expect(within(main).getByRole('img', { name: 'Update: 3 updates' })).toBeVisible()
  expect(within(main).getByText('Restart needed')).toBeVisible()
  expect(within(main).getByText('41 GB free of 193 GB')).toBeVisible()
  expect(within(main).getByRole('status')).toHaveTextContent('System update: 4 packages upgraded')
  expect(within(screen.getByRole('article', { name: deviceName })).queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
  await userEvent.click(within(main).getByRole('button', { name: 'Update' }))
  await waitFor(() => expect(within(main).getByRole('button', { name: 'Restart' })).toBeEnabled())
  await userEvent.click(within(main).getByRole('button', { name: 'Restart' }))
  await userEvent.click(within(main).getByRole('button', { name: 'Confirm restart' }))
  await userEvent.click(screen.getByRole('button', { name: 'Update computers' }))
  await waitFor(() => expect(started).toHaveLength(5))
  expect(started.slice(0, 2).map(value => (value as { task: unknown }).task)).toEqual(expect.arrayContaining([
    { kind: 'update-harnesses', harnesses: ['codex', 'claude'] }, { kind: 'update-system' }]))
  expect(started.slice(0, 2).every(value => (value as { targets?: unknown[] }).targets?.length === 1)).toBe(true)
  expect(started.slice(2).map(value => (value as { task: unknown; targets?: unknown[] }))).toEqual([
    expect.objectContaining({ task: { kind: 'restart' }, targets: [mainTarget] }),
    expect.objectContaining({ task: { kind: 'update-harnesses', harnesses: ['codex', 'claude'] } }),
    expect.objectContaining({ task: { kind: 'update-system' } }),
  ])
  expect((started[3] as { targets?: unknown }).targets).toBeUndefined()
  expect((started[4] as { targets?: unknown }).targets).toBeUndefined()
})

it('reports unavailable computers from both update requests instead of silently succeeding', async () => {
  computersFixture(<ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} />, [
    http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
      const input = await request.json() as { task: { kind: string } }
      return HttpResponse.json({ computers: [{ target: deviceTarget, task: null,
        error: input.task.kind === 'update-harnesses' ? 'Harness update unavailable.' : 'System update unavailable.' }] })
    }),
  ])
  await userEvent.click(await screen.findByRole('button', { name: 'Update computers' }))
  expect(await screen.findByText(`${deviceName}: Harness update unavailable.`)).toBeVisible()
  expect(await screen.findByText(`${deviceName}: System update unavailable.`)).toBeVisible()
})

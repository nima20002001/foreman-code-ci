import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ComputerConnections, ComputerMaintenanceStartInput, MaintenanceStatus, MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, mainId, mainTarget } from './computersTestFixture'

type Harnesses = MaintenanceStatus['harnesses']
const current: Harnesses = [{ harness: 'codex', installed: true, version: '1.0', latest: '1.0' },
  { harness: 'claude', installed: true, version: '2.0', latest: '2.0' }]

function status(overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus {
  return { observedAt: new Date().toISOString(), tasks: [], harnesses: current,
    system: { packageUpdates: 0, rebootRequired: false, sudo: true, disk: null }, ...overrides }
}
function accounts(...entries: [tool: 'codex' | 'claude' | 'github', installed: boolean, signedIn: boolean | null][]): ComputerAccounts {
  return { observedAt: new Date().toISOString(), accounts: entries.map(([tool, installed, signedIn]) => ({
    tool, installed, signedIn, account: signedIn ? 'owner@example.com' : null, details: [] })) }
}
function task(kind: MaintenanceTask['kind'], state: MaintenanceTask['state'], startedAt: string, summary: string): MaintenanceTask {
  return { id: crypto.randomUUID(), kind, state, startedAt, finishedAt: state === 'running' ? null : startedAt, summary, outputTail: '' }
}
async function renderMain(value: MaintenanceStatus | null, connections?: ComputerConnections,
  extra: Parameters<typeof computersFixture>[1] = []) {
  computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: value, ...(connections ? { connections } : {}) }] }),
    ...extra,
  ])
  return screen.findByRole('article', { name: 'Main PC' })
}
const chip = (card: HTMLElement, name: string) => within(card).findByRole('img', { name })

it.each([
  ['Codex', 'codex', 'not installed', 'not-installed'],
  ['Claude', 'claude', 'not installed', 'not-installed'],
] as const)('marks %s as not installed with its own state', async (label, tool, text, state) => {
  const installed = (name: 'codex' | 'claude') => ({ harness: name, installed: name !== tool, version: name !== tool ? '1.0' : null, latest: '1.0' })
  const card = await renderMain(status({ harnesses: [installed('codex'), installed('claude')] }),
    { accounts: accounts(['codex', tool !== 'codex', true], ['claude', tool !== 'claude', true], ['github', true, true]),
      mcp: { codex: 'installed', claude: 'installed' } })
  expect(await chip(card, `${label}: ${text}`)).toHaveAttribute('data-state', state)
})

it.each([
  ['Codex', 'codex'],
  ['Claude', 'claude'],
  ['GitHub', 'github'],
] as const)('flags %s as installed but signed out, with a sign-in request for the Operator', async (label, tool) => {
  const entries = (signedIn: boolean) => accounts(['codex', true, tool === 'codex' ? signedIn : true],
    ['claude', true, tool === 'claude' ? signedIn : true], ['github', true, tool === 'github' ? signedIn : true])
  const out = await renderMain(status(), { accounts: entries(false), mcp: { codex: 'installed', claude: 'installed' } })
  expect(await chip(out, `${label}: signed out`)).toHaveAttribute('data-state', 'signed-out')
  expect(within(out).getByRole('button', { name: `Sign in to ${label}` })).toBeVisible()
})

it('shows Codex, Claude and GitHub signed in with the account in the tooltip', async () => {
  const card = await renderMain(status(), { accounts: accounts(['codex', true, true], ['claude', true, true], ['github', true, true]),
    mcp: { codex: 'installed', claude: 'installed' } })
  for (const label of ['Codex', 'Claude', 'GitHub']) {
    expect(await chip(card, `${label}: signed in`)).toHaveAttribute('data-state', 'signed-in')
  }
  await userEvent.hover(within(card).getByRole('img', { name: 'GitHub: signed in' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('signed in as owner@example.com')
  expect(within(card).queryByRole('button', { name: /Sign in to/ })).not.toBeInTheDocument()
})

it('shows GitHub CLI missing', async () => {
  const card = await renderMain(status(), { accounts: accounts(['codex', true, true], ['claude', true, true], ['github', false, null]),
    mcp: { codex: 'installed', claude: 'installed' } })
  expect(await chip(card, 'GitHub: not installed')).toHaveAttribute('data-state', 'not-installed')
})

it.each([
  [{ codex: 'installed', claude: 'installed' }, 'Foreman MCP: installed', 'installed'],
  [{ codex: 'installed', claude: 'missing' }, 'Foreman MCP: Claude not set up', 'missing'],
  [{ codex: 'missing', claude: 'missing' }, 'Foreman MCP: not set up', 'missing'],
  [{ codex: 'mismatch', claude: 'installed' }, 'Foreman MCP: needs repair', 'repair'],
  [{ codex: null, claude: null }, 'Foreman MCP: unknown', 'unknown'],
] as const)('shows the Foreman MCP state %j', async (mcp, name, state) => {
  const card = await renderMain(status(), { accounts: accounts(['codex', true, true], ['claude', true, true], ['github', true, true]), mcp })
  expect(await chip(card, name)).toHaveAttribute('data-state', state)
})

it('ignores the MCP state of a harness that is not installed', async () => {
  const card = await renderMain(status({ harnesses: [current[0]!, { harness: 'claude', installed: false, version: null, latest: '2.0' }] }),
    { accounts: accounts(['codex', true, true], ['claude', false, null], ['github', true, true]),
      mcp: { codex: 'installed', claude: 'missing' } })
  expect(await chip(card, 'Foreman MCP: installed')).toHaveAttribute('data-state', 'installed')
})

it('shows up to date when nothing is pending', async () => {
  const connections = { accounts: accounts(['codex', true, true], ['claude', true, true], ['github', true, true]),
    mcp: { codex: 'installed', claude: 'installed' } } as const
  expect(await chip(await renderMain(status(), connections), 'Update: up to date')).toHaveAttribute('data-state', 'current')
})

it('counts available updates across OS packages and harnesses', async () => {
  const card = await renderMain(status({ system: { packageUpdates: 3, rebootRequired: false, sudo: true, disk: null },
    harnesses: [{ harness: 'codex', installed: true, version: '1.0', latest: '1.1' }, current[1]!] }))
  const updates = await chip(card, 'Update: 2 updates')
  expect(updates).toHaveAttribute('data-state', 'available')
  await userEvent.hover(updates)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('3 OS packages, Codex 1.0 → 1.1')
})

it('offers installation as an available update when a harness is missing', async () => {
  const card = await renderMain(status({ harnesses: [current[0]!,
    { harness: 'claude', installed: false, version: null, latest: '2.0' }] }))
  const updates = await chip(card, 'Update: 1 update')
  expect(updates).toHaveAttribute('data-state', 'available')
  await userEvent.hover(updates)
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Install Claude')
  expect(within(card).getByRole('button', { name: 'Update' })).toBeEnabled()
})

it('shows a running update while a maintenance task runs', async () => {
  const card = await renderMain(status({ tasks: [task('update-system', 'running', '2026-10-17T15:00:00.000Z', 'Running…')] }))
  expect(await chip(card, 'Update: updating…')).toHaveAttribute('data-state', 'running')
  expect(within(card).getByRole('button', { name: 'Update' })).toBeDisabled()
})

it('shows a failed update with plain words and the raw code in the tooltip', async () => {
  const raw = 'Unknown system error -122: Unknown system error -122, write'
  const card = await renderMain(status({ tasks: [task('update-harnesses', 'failed', '2026-10-09T08:00:00.000Z', raw)] }))
  const failed = await chip(card, 'Update: update failed')
  expect(failed).toHaveAttribute('data-state', 'failed')
  expect(within(card).getByRole('status')).toHaveTextContent('Harness update: Disk quota exceeded')
  expect(within(card).getByRole('status')).not.toHaveTextContent('Unknown system error')
  await userEvent.hover(within(card).getByText('Harness update: Disk quota exceeded'))
  expect(await screen.findByRole('tooltip')).toHaveTextContent(raw)
})

it('hides a failure that a later success of the same kind superseded', async () => {
  const card = await renderMain(status({ tasks: [
    task('update-worker', 'failed', '2026-10-17T14:31:00.000Z', 'worker_update_restart_pending'),
    task('update-worker', 'succeeded', '2026-10-17T15:14:00.000Z', 'Worker 0.0.57 installed'),
  ] }))
  expect(await within(card).findByText('Worker update: Worker 0.0.57 installed')).toBeVisible()
  expect(within(card).queryByText('Worker update: Restarting to finish the update')).not.toBeInTheDocument()
  expect(within(card).queryByText('worker_update_restart_pending')).not.toBeInTheDocument()
  expect(within(card).getAllByRole('status')).toHaveLength(1)
  expect(await chip(card, 'Update: up to date')).toHaveAttribute('data-state', 'current')
})

it('says a pending Worker restart in plain words', async () => {
  const card = await renderMain(status({ tasks: [task('update-worker', 'failed', '2026-10-17T14:31:00.000Z', 'worker_update_restart_pending')] }))
  expect(await within(card).findByText('Worker update: Restarting to finish the update')).toBeVisible()
})

it('starts the full maintenance for that computer with one Update click and locks the button while it runs', async () => {
  const started: ComputerMaintenanceStartInput[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const card = await renderMain(status({
    system: { packageUpdates: 4, rebootRequired: false, sudo: true, disk: null },
    harnesses: [{ harness: 'codex', installed: true, version: '1.0', latest: '1.1' }, { harness: 'claude', installed: false, version: null, latest: '2.0' }] }),
  undefined, [http.post('*/api/management/computers/maintenance/start', async ({ request }) => {
    started.push(await request.json() as ComputerMaintenanceStartInput)
    await gate
    return HttpResponse.json({ computers: [] })
  })])
  const update = await within(card).findByRole('button', { name: 'Update' })
  expect(update).toBeEnabled()
  await userEvent.click(update)
  await waitFor(() => expect(started).toHaveLength(2))
  expect(started.map(value => value.task)).toEqual(expect.arrayContaining([
    { kind: 'update-harnesses', harnesses: ['codex', 'claude'] }, { kind: 'update-system' }]))
  expect(started.every(value => value.targets?.length === 1)).toBe(true)
  expect(await chip(card, 'Update: updating…')).toHaveAttribute('data-state', 'running')
  expect(update).toBeDisabled()
  release()
})

it('disables Update when nothing needs updating', async () => {
  const card = await renderMain(status())
  expect(await within(card).findByRole('button', { name: 'Update' })).toBeDisabled()
})

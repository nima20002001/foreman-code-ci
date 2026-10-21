import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onlineManager } from '@tanstack/react-query'
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { resourceTelemetryFixtures } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { telemetrySelectorKey, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { server } from '../../mocks/server'
import { SidebarComputers } from './SidebarComputers'
import { computerReadHandler, computersFixture, deviceId, deviceName, deviceTarget, mainId, mainTarget, registration } from './computersTestFixture'
import computerStyles from './computers.css?inline'
import shellStyles from '../../styles.css?inline'

function inRouter() {
  const root = createRootRoute({ component: Outlet })
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: SidebarComputers }),
    createRoute({ getParentRoute: () => root, path: '/settings/computers', component: () => <h1>Computers settings</h1> }),
    createRoute({ getParentRoute: () => root, path: '/settings/computers/$deviceId', component: () => <h1>Computer details</h1> }),
  ]) })
  return { router, element: <RouterProvider router={router} /> }
}
async function openGroup(name: 'Computers' | 'Cloud CI' = 'Computers') {
  if (!screen.queryByRole('dialog', { name })) {
    const button = await screen.findByRole('button', { name })
    act(() => button.focus())
  }
  return screen.findByRole('dialog', { name })
}
async function findComputer(name: string | RegExp) {
  await openGroup()
  return screen.findByRole('button', { name })
}
async function findCloud(name: string | RegExp) {
  await openGroup('Cloud CI')
  return screen.findByRole('button', { name })
}
function cpuReading(percent: number) {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample' || sample.sample.cpu.state !== 'fresh') throw new Error('Expected a fresh sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.sample.cpu.value.hostCapacityPercent = percent
  sample.lastKnown = null
  return [http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(sample))]
}
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')
const cancelAnimation = vi.fn()
const animate = vi.fn(() => ({ cancel: cancelAnimation }))
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate }))
beforeEach(() => {
  animate.mockClear()
  cancelAnimation.mockClear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => {
  onlineManager.setOnline(true)
  vi.unstubAllGlobals()
})
afterAll(() => {
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate')
})

it('groups physical computers behind one icon and names and colors each computer load', async () => {
  const f = computersFixture(inRouter().element)
  const main = await findComputer('Main PC, Main, Plenty of capacity')
  expect(main.closest('li')).toHaveAttribute('data-load', 'calm')
  const device = screen.getByRole('button', { name: `${deviceName}, Worker, Offline` })
  expect(device.closest('li')).toHaveAttribute('data-load', 'offline')
  expect(device).toHaveTextContent(deviceName)
  expect(screen.getByRole('button', { name: 'Computers' }).textContent).toBe('')
  f.activity.computers[0]!.agents.push({ id: 'execution-1', workspaceId: 'workspace-1', workflowId: 'workflow-1',
    workflowName: 'Release', runId: 'run-1', nodeId: 'review', agentName: 'Reviewer', state: 'waiting' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Some load, 1 running Agent or CI job')).toHaveTextContent(/^Main PC1$/)
})
it.each([false, true])('keeps computer and cloud activity controls at 32px with collapsed=%s', async (collapsed) => {
  const { router, element } = inRouter()
  const f = computersFixture(<>
    <style>{computerStyles}{shellStyles}</style>
    <div className={collapsed ? 'workspace-shell workspace-shell-navigation-collapsed' : 'workspace-shell'}>
      <aside className="shell-sidebar"><div className="sidebar-footer">{element}</div></aside>
    </div>
  </>)
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1',
    workspaceName: 'Store', phase: 'running', startedAt: null })
  f.activity.cloud.push({ provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 1 })
  const main = await screen.findByRole('button', { name: 'Computers' })
  const cloud = screen.getByRole('button', { name: 'Cloud CI' })
  const computers = screen.getByRole('list', { name: 'Computers' })
  expect(within(computers).getAllByRole('button')).toHaveLength(2)
  for (const button of within(computers).getAllByRole('button')) {
    const style = getComputedStyle(button)
    expect(style.width).toBe('32px')
    expect(style.height).toBe('32px')
    expect(button).toBeEnabled()
  }
  expect(within(main).getByText('1')).toBeVisible()
  expect(within(cloud).getByText('1')).toBeVisible()
  await userEvent.setup().click(cloud)
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings/computers'))
})
it('derives the level from live CPU and shows the reading in the detail card', async () => {
  computersFixture(inRouter().element, cpuReading(95))
  const main = await findComputer('Main PC, Main, Near its limits')
  expect(main.closest('li')).toHaveAttribute('data-load', 'saturated')
  act(() => main.focus())
  expect(await within(await screen.findByRole('tooltip')).findByRole('meter', { name: 'CPU' })).toBeInTheDocument()
})
it('shows a detail card on hover with role, load, utilization, running work and versions', async () => {
  const f = computersFixture(inRouter().element, [computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: {
    harnesses: [{ harness: 'codex', installed: true, version: '0.162.1', latest: '0.162.1' },
      { harness: 'claude', installed: false, version: null, latest: null }],
    system: { packageUpdates: 0, rebootRequired: false, sudo: true, disk: null }, tasks: [], observedAt: new Date().toISOString() } }] })])
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  for (const index of [1, 2, 3, 4]) f.activity.computers[0]!.agents.push({ id: `execution-${index}`, workspaceId: 'workspace-1',
    workflowId: 'workflow-1', workflowName: 'Release', runId: 'run-1', nodeId: `node-${index}`, agentName: `Agent ${index}`, state: 'running' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const user = userEvent.setup()
  const main = await findComputer('Main PC, Main, Some load, 5 running Agents and CI jobs')
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  await user.hover(main)
  const card = await screen.findByRole('tooltip')
  expect(main).toHaveAttribute('aria-describedby', card.id)
  expect(within(card).getByText('Main')).toBeInTheDocument()
  expect(within(card).getByText('Online · Some load')).toBeInTheDocument()
  expect(within(card).getByRole('meter', { name: 'CPU' })).toBeInTheDocument()
  const agents = within(card).getByRole('region', { name: 'Agents' })
  expect(within(agents).getByText('4')).toBeInTheDocument()
  expect(within(agents).getByText('Agent 1 · Release')).toBeInTheDocument()
  expect(within(agents).queryByText('Agent 4 · Release')).not.toBeInTheDocument()
  expect(within(agents).getByText('and 1 more')).toBeInTheDocument()
  expect(within(within(card).getByRole('region', { name: 'CI jobs' })).getByText('Web build · Store')).toBeInTheDocument()
  expect(await within(card).findByText('0.162.1')).toBeInTheDocument()
  expect(within(card).getByText('Not installed')).toBeInTheDocument()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
})
it('opens the card on keyboard focus with a Worker last seen time and app version, and links to its settings', async () => {
  const lastSeenAt = new Date(Date.now() - 125_000).toISOString()
  const { router, element } = inRouter()
  computersFixture(element, [
    computerReadHandler('maintenance', { computers: [{ target: deviceTarget, status: {
      worker: { currentVersion: '9.9.1', targetVersion: null, state: 'current', lastError: null }, harnesses: [],
      system: { packageUpdates: 0, rebootRequired: false, sudo: true, disk: null }, tasks: [], observedAt: lastSeenAt } }] }),
    http.get('*/api/management/harnesses/registry', () => HttpResponse.json({ instances: [], installations: [], hostMetadata: {
      hostRef: deviceTarget.hostRef, applicationInstallationId: registration.workerInstallationId, platform: null, workspaceRoots: null,
      connection: { binding: { mainId, deviceId, workerInstallationId: registration.workerInstallationId,
        bootId: '44444444-4444-4444-8444-444444444444', keyRevision: 1, authorizationRevision: 1, connectionGeneration: 2,
        connectionEpoch: '55555555-5555-4555-8555-555555555555' },
      phase: 'offline', dispatch: false, transfer: false, appVersion: '9.9.0', protocolVersion: 1, lastSeenAt } } })),
  ])
  const device = await findComputer(`${deviceName}, Worker, Offline`)
  const user = userEvent.setup()
  await user.tab()
  await user.tab()
  expect(device).toHaveFocus()
  // The previously focused computer's card lingers briefly; read the card this button describes.
  await waitFor(() => expect(device).toHaveAttribute('aria-describedby'))
  const card = document.getElementById(device.getAttribute('aria-describedby')!)!
  expect(card).toHaveRole('tooltip')
  expect(within(card).getByText('Worker')).toBeInTheDocument()
  expect(await within(card).findByText('· last seen 2 min ago')).toBeInTheDocument()
  expect(await within(card).findByText('9.9.1')).toBeInTheDocument()
  expect(within(card).queryByRole('meter')).not.toBeInTheDocument()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(router.state.location.pathname).toBe(`/settings/computers/${deviceId}`))
})
it('stops presenting load as current while activity reads fail or the browser is offline', async () => {
  const f = computersFixture(inRouter().element)
  await findComputer('Main PC, Main, Plenty of capacity')
  act(() => onlineManager.setOnline(false))
  expect(screen.getByRole('button', { name: 'Main PC, Main, Status unknown' }).closest('li')).toHaveAttribute('data-load', 'unknown')
  act(() => onlineManager.setOnline(true))
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({
    error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 })))
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Status unknown')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: `${deviceName}, Worker, Status unknown` })).toBeInTheDocument()
})
it('shows cloud CI services by machines in use', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push({ provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 12 },
    { provider: 'circleci', name: 'CircleCI', ready: false, slots: 24, running: 0 })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const github = await findCloud('GitHub Actions, Cloud CI, Heavy load, 12 running Agents and CI jobs')
  const circle = screen.getByRole('button', { name: 'CircleCI, Cloud CI, Not logged in on Main' })
  expect(circle.closest('li')).toHaveAttribute('data-load', 'offline')
  await userEvent.setup().hover(github)
  expect(await within(await screen.findByRole('tooltip')).findByText('12 of 16 CI machines in use')).toBeInTheDocument()
})

it('shows the estimated credits left when hovering or focusing a CircleCI org', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'circleci', account: 'acme', name: 'CircleCI acme', ready: true, slots: 30, running: 0,
      credits: { total: 400000, used: 5690, remaining: 394310, asOf: new Date(Date.now() - 6 * 60_000).toISOString() } },
    { provider: 'circleci', account: 'beta', name: 'CircleCI beta', ready: true, slots: 30, running: 0,
      credits: null, creditsUnavailable: 'CircleCI is not logged in on Main.' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const acme = await findCloud(/^CircleCI acme, Cloud CI/)
  const user = userEvent.setup()
  await user.hover(acme)
  expect(await within(await screen.findByRole('tooltip')).findByText(
    '≈ 394,310 of 400,000 credits left · updated 6 min ago')).toBeInTheDocument()
  await user.unhover(acme)
  const beta = screen.getByRole('button', { name: /^CircleCI beta, Cloud CI/ })
  await act(() => beta.focus())
  await waitFor(() => expect(beta).toHaveAttribute('aria-describedby'))
  const card = within(document.getElementById(beta.getAttribute('aria-describedby')!)!)
  expect(await card.findByText('Credits unavailable (CircleCI is not logged in on Main.)')).toBeInTheDocument()
})

it('shows server roles separately from account readiness on cloud rows and keyboard details', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'circleci', circleAccountId: 'default', account: 'acme', name: 'CircleCI Build pool / acme',
      ready: true, slots: 30, running: 2, schedulingRole: 'active',
      schedulingReason: 'Primary capacity is available.' },
    { provider: 'circleci', circleAccountId: 'overflow', account: 'beta', name: 'CircleCI Overflow pool / beta',
      ready: true, slots: 30, running: 0, schedulingRole: 'standby',
      schedulingReason: 'Waiting for primary credit exhaustion.' },
    { provider: 'circleci', circleAccountId: 'default', account: 'gamma', name: 'CircleCI Build pool / gamma',
      ready: true, slots: 30, running: 1, schedulingRole: 'exhausted',
      schedulingReason: 'Estimated credits are at the 20,000 reserve.' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const active = await findCloud(/^CircleCI Build pool \/ acme, Cloud CI, Active/)
  expect(within(active).getByText('Active')).toBeVisible()
  const standby = screen.getByRole('button', { name: /^CircleCI Overflow pool \/ beta, Cloud CI, Standby/ })
  expect(within(standby).getByText('Standby')).toBeVisible()
  const exhausted = screen.getByRole('button', { name: /^CircleCI Build pool \/ gamma, Cloud CI, Out of credits/ })
  expect(within(exhausted).getByText('Out of credits')).toBeVisible()
  const user = userEvent.setup()
  act(() => standby.focus())
  const details = await screen.findByRole('tooltip')
  expect(within(details).getByText('Standby')).toBeVisible()
  expect(within(details).getByText('Waiting for primary credit exhaustion.')).toBeVisible()
  expect(within(details).queryByText(/Not logged in/)).not.toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('keeps account and org row identity when recovered rows are reordered', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'circleci', circleAccountId: 'default', account: 'acme', name: 'CircleCI Build pool / acme',
      ready: true, slots: 30, running: 1, schedulingRole: 'exhausted' },
    { provider: 'circleci', circleAccountId: 'overflow', account: 'acme', name: 'CircleCI Overflow pool / acme',
      ready: true, slots: 30, running: 0, schedulingRole: 'standby' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const primary = await findCloud(/^CircleCI Build pool \/ acme, Cloud CI/)
  const standby = screen.getByRole('button', { name: /^CircleCI Overflow pool \/ acme, Cloud CI/ })
  f.activity.cloud.reverse()
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  await waitFor(() => {
    const rows = within(screen.getByRole('list', { name: 'Cloud runner groups' })).getAllByRole('button')
    expect(rows[0]).toHaveAccessibleName(/^CircleCI Overflow pool \/ acme, Cloud CI/)
  })
  expect(screen.getByRole('button', { name: /^CircleCI Build pool \/ acme, Cloud CI/ })).toBe(primary)
  expect(screen.getByRole('button', { name: /^CircleCI Overflow pool \/ acme, Cloud CI/ })).toBe(standby)
})

it('retains a running legacy row alongside exhausted and replacement orgs', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'circleci', name: 'CircleCI', ready: true, slots: 30, running: 1 },
    { provider: 'circleci', account: 'acme', name: 'CircleCI acme', ready: true, slots: 30, running: 1,
      schedulingRole: 'exhausted' },
    { provider: 'circleci', circleAccountId: 'overflow', account: 'beta', name: 'CircleCI beta',
      ready: true, slots: 30, running: 2, schedulingRole: 'active' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const legacy = await findCloud(/^CircleCI, Cloud CI/)
  expect(within(legacy).getByText('1')).toBeVisible()
  expect(screen.getByRole('button', { name: /^CircleCI acme, Cloud CI, Out of credits/ }))
    .toHaveAccessibleName(/1 running Agent or CI job/)
  expect(screen.getByRole('button', { name: /^CircleCI beta, Cloud CI, Active/ }))
    .toHaveAccessibleName(/2 running Agents and CI jobs/)
})

it('keeps standby capacity out of free slots and reports draining jobs separately', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'circleci', account: 'acme', name: 'CircleCI acme', ready: true, slots: 30, running: 2,
      schedulingRole: 'active' },
    { provider: 'circleci', circleAccountId: 'overflow', account: 'beta', name: 'CircleCI beta',
      ready: true, slots: 30, running: 1, schedulingRole: 'standby' },
    { provider: 'circleci', account: 'gamma', name: 'CircleCI gamma', ready: true, slots: 30, running: 2,
      schedulingRole: 'exhausted' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const group = await openGroup('Cloud CI')
  expect(within(group).getByText('90 slots · 2 busy · 28 free · 60 unavailable')).toBeVisible()
  expect(within(group).getByText('3 jobs draining on standby or exhausted orgs.')).toBeVisible()
})

it('counts Agents and CI jobs, caps the badge, and pulses on starts including a replacement at the same count', async () => {
  const f = computersFixture(inRouter().element)
  const main = await findComputer('Main PC, Main, Plenty of capacity')
  const computer = f.activity.computers[0]!
  expect(animate).not.toHaveBeenCalled()
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
  computer.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Some load, 1 running Agent or CI job')).toBe(main)
  expect(within(main).getByText('1')).toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(1)
  expect(animate).toHaveBeenLastCalledWith([
    { transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' },
  ], { duration: 300, easing: 'ease-out' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(animate).toHaveBeenCalledTimes(1)
  computer.jobs[0]!.id = 'job-2'
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(animate).toHaveBeenCalledTimes(2)
  for (let index = 0; index < 9; index++) computer.agents.push({ id: `execution-${index}`, workspaceId: 'workspace-1',
    workflowId: 'workflow-1', workflowName: 'Release', runId: 'run-1', nodeId: `node-${index}`, agentName: `Agent ${index}`, state: 'running' })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Heavy load, 10 running Agents and CI jobs')).toBe(main)
  expect(within(main).getByText('9+')).toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(3)
  computer.agents = []
  computer.jobs = []
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Plenty of capacity')).toBe(main)
  expect(within(main).queryByText('9+')).not.toBeInTheDocument()
  expect(animate).toHaveBeenCalledTimes(3)
})
it('hides activity indicators when offline or stale even if the last observation has running work', async () => {
  const f = computersFixture(inRouter().element)
  await findComputer('Main PC, Main, Plenty of capacity')
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const main = await findComputer('Main PC, Main, Some load, 1 running Agent or CI job')
  act(() => onlineManager.setOnline(false))
  expect(main).toHaveAccessibleName('Main PC, Main, Status unknown')
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
  act(() => onlineManager.setOnline(true))
  f.activity.computers[0]!.online = false
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await findComputer('Main PC, Main, Offline')).toBe(main)
  expect(within(main).queryByText('1')).not.toBeInTheDocument()
})
it('keeps the running badge and skips the start pulse when reduced motion is preferred', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const f = computersFixture(inRouter().element)
  await findComputer('Main PC, Main, Plenty of capacity')
  f.activity.computers[0]!.jobs.push({ id: 'job-1', name: 'Web build', workspaceId: 'workspace-1', workspaceName: 'Store',
    phase: 'running', startedAt: null })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const main = await findComputer('Main PC, Main, Some load, 1 running Agent or CI job')
  expect(within(main).getByText('1')).toBeInTheDocument()
  expect(animate).not.toHaveBeenCalled()
})

it('totals physical CPU and RAM from both computers and keeps missing readings explicit', async () => {
  const telemetry = http.post('*/api/management/resource-telemetry/selector', async ({ request }) => {
    const { hostRef } = await request.json() as { hostRef: typeof mainTarget.hostRef | typeof deviceTarget.hostRef }
    const worker = hostRef.kind === 'device'
    const target = worker ? deviceTarget : mainTarget
    const fixture = structuredClone(resourceTelemetryFixtures.computerZero!)
    if (fixture.kind !== 'sample') throw new Error('Expected sample')
    const selector: TelemetrySelector = { ...fixture.sample.selector,
      host: { ...fixture.sample.selector.host, hostRef, applicationInstallationId: target.applicationInstallationId,
        keyRevision: target.keyRevision, authorizationRevision: target.authorizationRevision,
        connectionGeneration: worker ? 1 : null } }
    return HttpResponse.json({ kind: 'selector', selector })
  })
  const reading = http.post('*/api/management/resource-telemetry/read', async ({ request }) => {
    const selector = await request.json() as TelemetrySelector
    const worker = selector.host.hostRef.kind === 'device'
    const fixture = structuredClone(resourceTelemetryFixtures.computerZero!)
    if (fixture.kind !== 'sample' || fixture.sample.cpu.state !== 'fresh' || fixture.sample.memory.state !== 'fresh') {
      throw new Error('Expected fresh CPU and RAM')
    }
    fixture.sample.selector = selector
    fixture.sample.identity.host = selector.host
    fixture.sample.selectorKey = telemetrySelectorKey(selector)
    fixture.sample.cpu.value.logicalCpuCount = worker ? 16 : 8
    fixture.sample.cpu.value.hostCapacityPercent = worker ? 25 : 50
    const total = (worker ? 32 : 16) * 1024 ** 3
    fixture.sample.memory.value = { kind: 'host-used-estimate', bytes: total / 4, totalBytes: total,
      availableBytes: total * 3 / 4, sharedPagesMayDoubleCount: false }
    fixture.lastKnown = null
    return HttpResponse.json(fixture)
  })
  const f = computersFixture(inRouter().element, [telemetry, reading])
  f.activity.computers[1]!.online = true
  const group = await openGroup()
  expect(await within(group).findByText('24 cores · 8 busy · 16 free')).toBeInTheDocument()
  expect(within(group).getByText('48 GiB · 12 used · 36 free')).toBeInTheDocument()
  f.activity.computers[1]!.online = false
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  expect(await within(group).findByText('8 cores · 4 busy · 4 free')).toBeInTheDocument()
  expect(within(group).getByText('1 of 2 computers reporting')).toBeInTheDocument()
  act(() => onlineManager.setOnline(false))
  expect(within(group).queryByText(/cores ·/)).not.toBeInTheDocument()
  expect(within(group).getByText('CPU unavailable')).toBeInTheDocument()
  expect(within(group).getByText('RAM unavailable')).toBeInTheDocument()
})

it('totals cloud slots and each organization’s own credits', async () => {
  const f = computersFixture(inRouter().element)
  const asOf = new Date().toISOString()
  const credits = { total: 400000, used: 125000, remaining: 275000, asOf }
  f.activity.cloud.push(
    { provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 12 },
    { provider: 'circleci', account: 'acme', name: 'CircleCI acme', ready: true, slots: 30, running: 2,
      credits },
    { provider: 'circleci', account: 'beta', name: 'CircleCI beta', ready: true, slots: 30, running: 1,
      credits: { total: 400000, used: 380000, remaining: 20000, asOf } },
    { provider: 'circleci', account: 'gamma', name: 'CircleCI gamma', ready: true, slots: 30, running: 0,
      credits: null, creditsUnavailable: 'Usage unavailable' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const group = await openGroup('Cloud CI')
  expect(within(group).getByText('106 slots · 15 busy · 91 free')).toBeInTheDocument()
  expect(within(group).getByText('≈ 295,000 credits left (2 of 3 orgs)')).toBeInTheDocument()
  const user = userEvent.setup()
  await user.hover(within(group).getByRole('button', { name: /^CircleCI beta, Cloud CI/ }))
  const details = await screen.findByRole('tooltip')
  expect(within(details).getByText(/≈ 20,000 of 400,000 credits left · updated/)).toBeInTheDocument()
  await user.hover(within(group).getByRole('button', { name: /^CircleCI acme, Cloud CI/ }))
  expect(await screen.findByText(/≈ 275,000 of 400,000 credits left · updated/)).toBeInTheDocument()
  await user.hover(within(group).getByRole('button', { name: /^CircleCI gamma, Cloud CI/ }))
  expect(await screen.findByText('Credits unavailable (Usage unavailable)')).toBeInTheDocument()
  act(() => onlineManager.setOnline(false))
  expect(within(group).getByText('Slots unavailable')).toBeInTheDocument()
})

it('keeps both popovers open while crossing gaps and closes both after leaving or pressing Escape', async () => {
  computersFixture(inRouter().element)
  const user = userEvent.setup()
  const icon = await screen.findByRole('button', { name: 'Computers' })
  await user.hover(icon)
  const group = await screen.findByRole('dialog', { name: 'Computers' })
  await user.hover(group)
  await act(() => new Promise(resolve => setTimeout(resolve, 200)))
  expect(group).toBeInTheDocument()
  const row = within(group).getByRole('button', { name: /^Main PC, Main/ })
  await user.hover(row)
  const details = await screen.findByRole('tooltip')
  await user.hover(details)
  await act(() => new Promise(resolve => setTimeout(resolve, 200)))
  expect(group).toBeInTheDocument()
  expect(details).toBeInTheDocument()
  await user.hover(document.body)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  act(() => icon.focus())
  await screen.findByRole('dialog', { name: 'Computers' })
  await user.tab()
  const focused = screen.getByRole('button', { name: /^Main PC, Main/ })
  expect(focused).toHaveFocus()
  await screen.findByRole('tooltip')
  await act(() => new Promise(resolve => setTimeout(resolve, 200)))
  expect(screen.getByRole('dialog', { name: 'Computers' })).toBeInTheDocument()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(icon).toHaveFocus()
  fireEvent.blur(icon)
})

it('keeps unavailable cloud capacity out of free slots', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push(
    { provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 4 },
    { provider: 'circleci', name: 'CircleCI', ready: false, slots: 30, running: 0, credits: null,
      creditsUnavailable: 'Not logged in' },
  )
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const group = await openGroup('Cloud CI')
  expect(within(group).getByText('46 slots · 4 busy · 12 free · 30 unavailable')).toBeInTheDocument()
  expect(within(group).getByText('Credits unavailable')).toBeInTheDocument()
})


it('closes both groups on Escape when focus switches before the previous group finishes closing', async () => {
  const f = computersFixture(inRouter().element)
  f.activity.cloud.push({ provider: 'github', name: 'GitHub Actions', ready: true, slots: 16, running: 0 })
  await act(() => f.client.invalidateQueries({ queryKey: ['computer-activity'] }))
  const physical = await screen.findByRole('button', { name: 'Computers' })
  const cloud = screen.getByRole('button', { name: 'Cloud CI' })
  vi.useFakeTimers()
  try {
    act(() => physical.focus())
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole('dialog', { name: 'Computers' })).toBeInTheDocument()
    act(() => cloud.focus())
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole('dialog', { name: 'Computers' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Cloud CI' })).toBeInTheDocument()
    fireEvent.keyDown(cloud, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(cloud).toHaveFocus()
  } finally {
    vi.useRealTimers()
  }
})

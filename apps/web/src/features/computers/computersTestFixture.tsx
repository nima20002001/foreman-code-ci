import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { http, HttpResponse, type HttpHandler } from 'msw'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { BuildComputerStatus } from '@foreman-code/contracts/build-computers'
import type { ComputerActivityList } from '@foreman-code/contracts/computer-activity'
import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ComputerConnections, ComputerMaintenanceListSchema } from '@foreman-code/contracts/computer-maintenance'
import type { z } from 'zod'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { server } from '../../mocks/server'
import { computerKey } from '../../shared/api/computerActivity'

export const mainId = '11111111-1111-4111-8111-111111111111'
export const deviceId = '22222222-2222-4222-8222-222222222222'
export const deviceName = 'Computer 22222222'
export const registration: DeviceRegistration = { mainId, deviceId,
  workerInstallationId: '33333333-3333-4333-8333-333333333333', keyRevision: 1, authorizationRevision: 1,
  status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
export const mainTarget = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }
export const deviceTarget = { hostRef: { kind: 'device' as const, mainId, deviceId },
  applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }

export function computerReadHandler(_kind: 'maintenance', result: z.input<typeof ComputerMaintenanceListSchema>) {
  return http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
    const { target } = await request.json() as { target: DeviceProvisioningTarget }
    const computer = result.computers.find(value => computerKey(value.target) === computerKey(target))
      ?? { target, status: null }
    return HttpResponse.json({ computers: [computer] })
  })
}

/** Provider accounts as the Main computer reports them. */
export const mainAccounts: ComputerAccounts = { observedAt: new Date().toISOString(), accounts: [
  { tool: 'codex', installed: true, signedIn: true, account: 'coder@example.com', details: ['ChatGPT'] },
  { tool: 'claude', installed: true, signedIn: false, account: null, details: [] },
  { tool: 'github', installed: true, signedIn: true, account: 'octo-owner', details: [] },
] }
export const mainConnections: ComputerConnections = { accounts: mainAccounts, mcp: { codex: 'installed', claude: 'installed' } }

export function computersFixture(children: React.ReactNode, handlers: HttpHandler[] = []) {
  const statuses = new Map<string, BuildComputerStatus>([mainTarget, deviceTarget].map((target, index) => [
    computerKey(target), { preference: { target, revision: 1, buildEnabled: true, buildPriority: 100 - index * 50,
      buildAllowancePercent: 60 },
    state: 'ready', reasons: [], remoteExecutionEnabled: true },
  ]))
  const activity: ComputerActivityList = { mainId, activityComplete: true, truncated: false, cloud: [],
    computers: [mainTarget, deviceTarget].map((target, index) => ({ target, name: index ? deviceName : 'Main PC',
      online: !index, jobs: [], agents: [] })) }
  server.use(...handlers,
    http.post('*/api/management/settings/build-computers/read', async ({ request }) => {
      const { target } = await request.json() as { target: typeof mainTarget }
      return HttpResponse.json(statuses.get(computerKey(target)))
    }),
    http.get('*/api/management/computers/activity', () => HttpResponse.json(activity)),
    computerReadHandler('maintenance', { computers: [
      { target: mainTarget, status: null, connections: mainConnections },
      { target: deviceTarget, status: null, connections: { accounts: null, mcp: { codex: 'installed', claude: 'missing' } } },
    ] }),
    http.post('*/api/management/computers/sync/status', async ({ request }) => {
      const { target } = await request.json() as { target: typeof mainTarget }
      return HttpResponse.json({ target, installed: false, running: false, message: null, folders: [] })
    }),
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'unavailable' })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const rendered = render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
  return { client, rendered, statuses, activity }
}

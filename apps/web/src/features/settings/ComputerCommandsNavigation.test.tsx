import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { encodeWorkerIdentityRequest } from '@foreman-code/contracts/device-setup'
import { server } from '../../mocks/server'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { ComputerPairingForm } from './ComputerPairingForm'
import { ComputerRevokeButton } from './ComputerRevokeButton'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: deviceId, publicKeyFingerprint: 'a'.repeat(64),
  keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
const commands = [
  { kind: 'pairing', path: '/api/devices/setup-codes', label: 'Approve this computer', reconcile: 'Reconcile original pairing command' },
  { kind: 'revoke', path: '/api/devices/revoke', label: 'Revoke worker access', reconcile: 'Reconcile original revoke command' },
] as const
type Command = typeof commands[number]
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

async function mount(command: Command) {
  let updateRegistration!: (value: DeviceRegistration) => void
  function Computer() {
    const [value, setValue] = useState(registration)
    updateRegistration = setValue
    return command.kind === 'pairing' ? <ComputerPairingForm mainId={mainId} /> : <ComputerRevokeButton registration={value} />
  }
  const root = createRootRoute({ component: () => <UnsavedChangesProvider>
    <Link to="/settings">Settings</Link><Link to="/settings/computers">Computers</Link><Outlet />
  </UnsavedChangesProvider> })
  const computers = createRoute({ getParentRoute: () => root, path: '/settings/computers', component: Computer })
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: () => <h1>Settings overview</h1> })
  const router = createRouter({ routeTree: root.addChildren([computers, settings]), defaultPendingMinMs: 0,
    history: createMemoryHistory({ initialEntries: ['/settings/computers'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  if (command.kind === 'pairing') server.use(
    http.get('/api/devices/setup-options', () => HttpResponse.json({ endpoint: 'wss://192.168.1.10:8443/device/connect', available: true, reason: null })),
    http.get('/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'main-key', mainPublicKeyFingerprint: 'b'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })))
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('button', { name: command.label })
  const user = userEvent.setup()
  if (command.kind === 'pairing') {
    await user.click(screen.getByRole('textbox', { name: 'Computer request code' }))
    await user.paste(encodeWorkerIdentityRequest({ version: 1, kind: 'identity-request', workerInstallationId: deviceId, publicKey: 'public-key', publicKeyFingerprint: 'a'.repeat(64) }))
    await waitFor(() => expect(screen.getByRole('button', { name: command.label })).toBeEnabled())
  }
  return { router, user, updateRegistration }
}

it.each(commands)('holds pending $kind navigation and reconciles the same command after an unknown acknowledgement and permission loss', async command => {
  const requests: Record<string, unknown>[] = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  server.use(http.post(command.path, async ({ request }) => {
    requests.push(await request.json() as Record<string, unknown>)
    if (requests.length === 1) {
      await pending
      return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Command unconfirmed.' } }, { status: 503 })
    }
    if (requests.length === 2) return HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Reconciliation denied.' } }, { status: 403 })
    return HttpResponse.json(command.kind === 'pairing'
      ? { registration: { ...registration, status: 'pending' }, enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() }
      : { ...registration, status: 'revoked', authorizationRevision: 2 })
  }))
  const { router, user, updateRegistration } = await mount(command)
  await user.click(screen.getByRole('button', { name: command.label }))
  await waitFor(() => expect(requests).toHaveLength(1))
  await user.click(screen.getByRole('link', { name: 'Settings' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(router.state.location.pathname).toBe('/settings/computers')
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: 'Saving…' })).toBeDisabled()
  await act(async () => { release(); await pending })
  await within(dialog).findByRole('button', { name: 'Retry original save' })
  if (command.kind === 'revoke') act(() => updateRegistration({ ...registration, status: 'revoked', authorizationRevision: 2 }))
  expect(screen.getByRole('button', { name: command.reconcile })).toBeEnabled()
  await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }))
  await within(dialog).findByText('Reconciliation denied.')
  expect(router.state.location.pathname).toBe('/settings/computers')
  expect(within(dialog).getByRole('button', { name: 'Discard' })).toBeDisabled()
  await user.click(within(dialog).getByRole('button', { name: 'Retry original save' }))
  await screen.findByRole('heading', { name: 'Settings overview' })
  expect(router.state.location.pathname).toBe('/settings')
  expect(requests).toHaveLength(3)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[2]).toEqual(requests[0])
})

it.each(commands)('allows departure after a definitive initial $kind authorization denial', async command => {
  server.use(http.post(command.path, () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Command denied.' } }, { status: 403 })))
  const { user } = await mount(command)
  await user.click(screen.getByRole('button', { name: command.label }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('link', { name: 'Settings' }))
  await screen.findByRole('heading', { name: 'Settings overview' })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

it.each(commands)('releases an unknown $kind after the actual device revision conflict', async command => {
  const requests: Record<string, unknown>[] = []
  server.use(http.post(command.path, async ({ request }) => {
    requests.push(await request.json() as Record<string, unknown>)
    return HttpResponse.json({ error: { code: requests.length === 1 ? 'INTERNAL' : 'conflict', message: 'Revision changed.' } }, { status: requests.length === 1 ? 503 : 403 })
  }))
  const { user, updateRegistration } = await mount(command)
  await user.click(screen.getByRole('button', { name: command.label }))
  await screen.findByRole('button', { name: command.reconcile })
  act(() => updateRegistration({ ...registration, authorizationRevision: 2 }))
  await user.click(screen.getByRole('button', { name: command.reconcile }))
  await screen.findByRole('button', { name: command.label })
  await user.click(screen.getByRole('button', { name: command.label }))
  await waitFor(() => expect(requests).toHaveLength(3))
  expect(requests[1]).toEqual(requests[0])
  if (command.kind === 'revoke') expect(requests[2]?.expectedRevision).toBe(2)
  expect(requests[2]?.commandId).not.toBe(requests[0]?.commandId)
  await screen.findByRole('button', { name: command.label })
  await user.click(screen.getByRole('link', { name: 'Settings' }))
  await screen.findByRole('heading', { name: 'Settings overview' })
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
})

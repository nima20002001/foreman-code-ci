import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { encodeWorkerIdentityRequest, type DeviceSetupApproveInput } from '@foreman-code/contracts/device-setup'
import { server } from '../../mocks/server'
import { computerSettingsKeys } from '../../shared/api/computerSettings'
import { ComputerPairingForm } from './ComputerPairingForm'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const registration: DeviceRegistration = { mainId, deviceId, workerInstallationId: deviceId,
  publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1, authorizationRevision: 4,
  status: 'revoked', scopes: ['connect', 'heartbeat'] }
const requestCode = encodeWorkerIdentityRequest({ version: 1, kind: 'identity-request',
  workerInstallationId: deviceId, publicKey: 'public-key', publicKeyFingerprint: 'a'.repeat(64) })
const clients: QueryClient[] = []
afterEach(() => { for (const client of clients.splice(0)) client.clear(); vi.useRealTimers() })

async function mount(devices: DeviceRegistration[] = []) {
  const state = { devices, available: true }
  server.use(
    http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'main-key',
      mainPublicKeyFingerprint: 'b'.repeat(64) })),
    http.get('*/api/devices/setup-options', () => HttpResponse.json(state.available
      ? { available: true, endpoint: 'wss://192.168.1.10:8443/device/connect', reason: null }
      : { available: false, endpoint: null, reason: 'listener-not-started' })),
    http.get('*/api/devices', () => HttpResponse.json({ devices: state.devices })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><ComputerPairingForm mainId={mainId} /></QueryClientProvider>)
  const user = userEvent.setup()
  await user.click(screen.getByRole('textbox', { name: 'Computer request code' }))
  await user.paste(requestCode)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve this computer' })).toBeEnabled())
  return { client, state, user }
}

it.each([false, true])('uses the current revoked installation revision for re-enrollment (key recovery %s)', async changedKey => {
  const requests: DeviceSetupApproveInput[] = []
  server.use(http.post('*/api/devices/setup-codes', async ({ request }) => {
    requests.push(await request.json() as DeviceSetupApproveInput)
    return HttpResponse.json({ registration: { ...registration, status: 'pending', authorizationRevision: 5 },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }))
  const { user } = await mount([{ ...registration, publicKeyFingerprint: (changedKey ? 'c' : 'a').repeat(64) }])
  expect(screen.getByText(/access was revoked.*Confirm the fingerprints/)).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await screen.findByText(/Computer pending/)
  expect(requests[0]).toMatchObject({ identityRequestCode: requestCode, expectedAuthorizationRevision: 4,
    endpoint: 'wss://192.168.1.10:8443/device/connect', scopes: ['connect', 'heartbeat'] })
})

it('refreshes a rejected revision before a new approval and keeps the server revision guard', async () => {
  const requests: DeviceSetupApproveInput[] = []
  const { user, state } = await mount([registration])
  server.use(http.post('*/api/devices/setup-codes', async ({ request }) => {
    requests.push(await request.json() as DeviceSetupApproveInput)
    if (requests.length === 1) {
      state.devices = [{ ...registration, authorizationRevision: 6 }]
      return HttpResponse.json({ error: { code: 'conflict', message: 'Device revision changed.' } }, { status: 403 })
    }
    return HttpResponse.json({ registration: { ...registration, authorizationRevision: 7, status: 'pending' },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }))
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await screen.findByText('Device revision changed.')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve this computer' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await screen.findByText(/Computer pending/)
  expect(requests.map(value => value.expectedAuthorizationRevision)).toEqual([4, 6])
  expect(requests[1]!.commandId).not.toBe(requests[0]!.commandId)
})

it('reconciles an original approval when setup prerequisites become unavailable', async () => {
  const requests: DeviceSetupApproveInput[] = []
  const { user, state, client } = await mount()
  server.use(http.post('*/api/devices/setup-codes', async ({ request }) => {
    requests.push(await request.json() as DeviceSetupApproveInput)
    if (requests.length === 1) return HttpResponse.error()
    return HttpResponse.json({ registration: { ...registration, status: 'pending' },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }))
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await screen.findByRole('button', { name: 'Reconcile original pairing command' })
  state.available = false
  await act(async () => { await client.invalidateQueries({ queryKey: computerSettingsKeys.setupOptions(mainId) }) })
  expect(screen.getByRole('button', { name: 'Reconcile original pairing command' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Reconcile original pairing command' }))
  await screen.findByText(/Computer pending/)
  expect(requests[1]).toEqual(requests[0])
})

it.each(['pending', 'paired'] as const)('uses revoked readback after a %s approval result and hides its unusable secret', async initial => {
  const { user, state, client } = await mount()
  server.use(http.post('*/api/devices/setup-codes', () => {
    state.devices = [{ ...registration, status: initial }]
    return HttpResponse.json({ registration: { ...registration, status: 'pending' },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }))
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await screen.findByRole('button', { name: initial === 'paired' ? 'Done' : 'Discard pairing code' })
  state.devices = [{ ...registration, status: 'revoked', authorizationRevision: 5 }]
  await act(async () => { await client.invalidateQueries({ queryKey: computerSettingsKeys.devices(mainId) }) })
  expect(await screen.findByText(/Computer access revoked/)).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Private pairing code · secret' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Show pairing code' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Done' })).toBeVisible()
})

it('keeps confirmed pairing visible after the enrollment secret expires', async () => {
  const { state } = await mount()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync })
  server.use(http.post('*/api/devices/setup-codes', () => {
    state.devices = [{ ...registration, status: 'paired' }]
    return HttpResponse.json({ registration: { ...registration, status: 'pending' },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 300).toISOString() })
  }))
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  expect(await screen.findByText('Computer paired.')).toBeVisible()
  await act(async () => { await vi.advanceTimersByTimeAsync(350) })
  expect(screen.getByText('Computer paired.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Done' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Approve this computer' })).not.toBeInTheDocument()
})

it('hides the original enrollment secret when readback observes a newer pending approval', async () => {
  const { user, state, client } = await mount()
  server.use(http.post('*/api/devices/setup-codes', () => {
    state.devices = [{ ...registration, status: 'pending' }]
    return HttpResponse.json({ registration: { ...registration, status: 'pending' },
      enrollmentCode: 'GQLWE1.secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })
  }))
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await user.click(await screen.findByRole('button', { name: 'Show pairing code' }))
  expect(screen.getByRole('textbox', { name: 'Private pairing code · secret' })).toHaveValue('GQLWE1.secret')
  state.devices = [{ ...registration, status: 'pending', authorizationRevision: 6 }]
  await act(async () => { await client.invalidateQueries({ queryKey: computerSettingsKeys.devices(mainId) }) })
  expect(await screen.findByText(/pending from a newer approval/)).toBeVisible()
  expect(screen.queryByDisplayValue('GQLWE1.secret')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy pairing code' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Done' })).toBeVisible()
})

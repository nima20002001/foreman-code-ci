import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { server } from '../../mocks/server'
import { computerSettingsKeys, useRegisteredComputersQuery, useHostHarnessRegistryQuery, useCreateComputerPairingGrant, useApproveComputerSetup, useComputerSetupOptionsQuery } from './computerSettings'
import { beginSessionChange, finishSessionChange } from './sessionBoundary'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const registration = { mainId, deviceId, workerInstallationId: deviceId, publicKeyFingerprint: 'a'.repeat(64),
  keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }
const clients: QueryClient[] = []
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return { client, Wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
describe('computer HTTP query boundary', () => {
  it('rejects registration readback from another main', async () => {
    server.use(http.get('/api/devices', () => HttpResponse.json({ devices: [registration] })))
    const { Wrapper } = wrapper()
    const query = renderHook(() => useRegisteredComputersQuery(deviceId), { wrapper: Wrapper })
    await waitFor(() => expect(query.result.current.isError).toBe(true))
    expect(query.result.current.data).toBeUndefined()
  })
  it('preserves a denied caller response without manufacturing computer choices', async () => {
    server.use(http.get('/api/devices', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Computer access denied.' } }, { status: 403 })))
    const { Wrapper } = wrapper()
    const query = renderHook(() => useRegisteredComputersQuery(mainId), { wrapper: Wrapper })
    await waitFor(() => expect(query.result.current.isError).toBe(true))
    expect(query.result.current.error?.message).toBe('Computer access denied.')
    expect(query.result.current.data).toBeUndefined()
  })
  it('uses distinct session/main/device inventory cache identities', () => {
    const pc = computerSettingsKeys.inventory({ kind: 'main', mainId })
    expect(pc).not.toEqual(computerSettingsKeys.inventory({ kind: 'device', mainId, deviceId }))
    expect(pc).not.toEqual(computerSettingsKeys.inventory({ kind: 'main', mainId: deviceId }))
    beginSessionChange(); finishSessionChange()
    expect(pc).not.toEqual(computerSettingsKeys.inventory({ kind: 'main', mainId }))
  })
  it('does not expose a one-use grant returned for another main', async () => {
    server.use(http.post('/api/devices/pairing-grants', () => HttpResponse.json({ registration: { ...registration, mainId: deviceId, status: 'pending' }, grant: 'a'.repeat(43), expiresAt: '2099-10-01T00:00:00.000Z' })))
    const { Wrapper } = wrapper()
    const grant = renderHook(() => useCreateComputerPairingGrant(mainId), { wrapper: Wrapper })
    await act(async () => {
      await expect(grant.result.current.mutateAsync({ workerInstallationId: deviceId, publicKey: 'public-key', expectedFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'], commandId: 'original-command' })).rejects.toThrow('different main')
    })
    expect(grant.result.current.data).toBeUndefined()
  })
  it('does not expose a setup approval returned for another main', async () => {
    server.use(http.post('/api/devices/setup-codes', () => HttpResponse.json({ registration: { ...registration, mainId: deviceId, status: 'pending' }, enrollmentCode: 'GQLWE1.secret', expiresAt: '2099-10-01T00:00:00.000Z' })))
    const { Wrapper } = wrapper()
    const approval = renderHook(() => useApproveComputerSetup(mainId), { wrapper: Wrapper })
    await act(async () => {
      await expect(approval.result.current.mutateAsync({ commandId: 'original-command', identityRequestCode: 'GQLWR1.x', endpoint: 'wss://192.168.1.10:8443/device/connect', scopes: ['connect', 'heartbeat'] })).rejects.toThrow('different main')
    })
    expect(approval.result.current.data).toBeUndefined()
  })
  it('reads the server-configured setup endpoint without guessing one', async () => {
    server.use(http.get('/api/devices/setup-options', () => HttpResponse.json({ endpoint: null, available: false, reason: 'listener-unconfigured' })))
    const { Wrapper } = wrapper()
    const query = renderHook(() => useComputerSetupOptionsQuery(mainId), { wrapper: Wrapper })
    await waitFor(() => expect(query.result.current.isSuccess).toBe(true))
    expect(query.result.current.data).toEqual({ endpoint: null, available: false, reason: 'listener-unconfigured' })
  })
  it('rejects a late grant after an authentication session switch', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    let entered!: () => void
    const started = new Promise<void>(done => { entered = done })
    server.use(http.post('/api/devices/pairing-grants', async () => { entered(); await pending; return HttpResponse.json({ registration: { ...registration, status: 'pending' }, grant: 'a'.repeat(43), expiresAt: '2099-10-01T00:00:00.000Z' }) }))
    const { Wrapper } = wrapper()
    const grant = renderHook(() => useCreateComputerPairingGrant(mainId), { wrapper: Wrapper })
    const result = grant.result.current.mutateAsync({ workerInstallationId: deviceId, publicKey: 'public-key', expectedFingerprint: 'a'.repeat(64), scopes: ['connect'], commandId: 'original-command' }).catch(error => error)
    await started
    await act(async () => { beginSessionChange(); finishSessionChange(); resolve(); await pending; await result })
    expect(await result).toBeInstanceOf(Error)
    expect(grant.result.current.data).toBeUndefined()
  })
  it('does not display a late PC inventory in the laptop query', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(done => { resolve = done })
    server.use(http.get('/api/management/harnesses/registry', async ({ request }) => {
      const query = new URL(request.url).searchParams
      if (query.get('kind') === 'main') { await pending; return HttpResponse.json({ instances: [{ instanceId: 'pc-only', instanceRevision: 'r1', driverId: 'codex', enabled: false, configuration: null, availability: 'disabled' }], installations: [] }) }
      expect(query.get('deviceId')).toBe(deviceId)
      return HttpResponse.json({ instances: [], installations: [] })
    }))
    const { Wrapper } = wrapper()
    const query = renderHook(({ remote }) => useHostHarnessRegistryQuery(remote ? { kind: 'device', mainId, deviceId } : { kind: 'main', mainId }), { wrapper: Wrapper, initialProps: { remote: false } })
    query.rerender({ remote: true })
    await waitFor(() => expect(query.result.current.isSuccess).toBe(true))
    await act(async () => { resolve(); await pending })
    expect(query.result.current.data?.instances).toEqual([])
  })
})

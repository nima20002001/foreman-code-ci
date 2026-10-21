import { afterEach, expect, it, vi } from 'vitest'
import { endpointFixture, browserSubjects } from '../browser-runtime/endpoints.test-support.js'
import { createBrowserSessionRouter, type BrowserSessionLocations, type BrowserSessionTransport } from '../browser-runtime/sessionRouter.js'
import type { BrowserSessionService } from '../browser-runtime/service.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

let fixture: Awaited<ReturnType<typeof endpointFixture>> | undefined
afterEach(async () => { await fixture?.close(); vi.restoreAllMocks() })

it('routes a healthy remote browser when the local native installation is unavailable', async () => {
  const remote = fixture = await endpointFixture()
  const records = new Map<string, Awaited<ReturnType<BrowserSessionLocations['session']>>>()
  const transport: BrowserSessionTransport<ManagementPrincipal> = {
    invoke: async (_binding, method, principal, args) => Reflect.apply(remote.sessions[method], remote.sessions, [principal, ...args]),
  }
  const router = createBrowserSessionRouter({ localComputerId: 'unavailable-local',
    local: new Proxy({} as BrowserSessionService<ManagementPrincipal>, { get() { throw new Error('Local browser runtime is unavailable') } }),
    locations: { session: async id => records.get(id), save: async (session, installationId) => { records.set(session.id, { session, installationId }) },
      view: async () => undefined, saveView: async () => { throw new Error('Unexpected viewer') } },
    pairing: { current: async computerId => ({ computerId, installationId: 'installation', connectionId: 'connection' }),
      assertCurrent: async () => undefined, assertInstallation: async () => undefined,
      wrappingKey: async () => { throw new Error('Unexpected key operation') } },
    authority: { callerId: principal => principal.id, actor: async () => 'viewer',
      subject: async () => undefined, session: async () => undefined, setup: async () => undefined },
    computers: async () => ['main'], subjectComputer: async () => 'main', transport,
    media: () => { throw new Error('Unexpected media') },
  })
  const input = remote.bindSubject(browserSubjects()[0]!)
  const prepared = await router.open(remote.owner, input)
  expect(prepared.kind).toBe('ready')
  if (prepared.kind !== 'ready') throw new Error('The remote fixture did not prepare')
  expect((await router.list(remote.owner, { subject: input.subject })).sessions).toEqual([prepared.session])
  expect((await router.get(remote.owner, prepared.session.id)).session).toEqual(prepared.session)
  const control = await router.acquire(remote.owner, { sessionId: prepared.session.id, viewerId: 'viewer', commandId: 'take', browserGeneration: prepared.session.browserGeneration })
  expect(control.controllingViewerId).toBe('viewer')
  expect(await router.release(remote.owner, { sessionId: prepared.session.id, viewerId: 'viewer', epoch: control.epoch, commandId: 'return' }))
    .toMatchObject({ state: 'agent', controllingViewerId: null })
})

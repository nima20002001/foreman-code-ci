import type { SqlQuery } from '../../infrastructure/transaction.js'
import { resolveBrowserTarget } from './browserTargets.js'
import type pg from 'pg'
import { canonicalJson, type AgentSubject } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { requireAuthorization } from '../access/policy.js'
import { readChatPrincipal } from '../access/conversationCredentials.js'
import { DomainError } from '../errors.js'
import { createBrowserProfiles } from '../browser-profiles/factory.js'
import type { BrowserProfileEndpoint, BrowserProfileTransport } from '../browser-profiles/host.js'
import type { BrowserInstallationBinding } from '../browser-profiles/keys.js'
import { createBrowserOperationHandlers } from '../browser-runtime/operations.js'
import { BrowserSessionService, type BrowserSessionPort } from '../browser-runtime/service.js'
import { createBrowserSessionLocations, createBrowserSessionRouter,
  type BrowserSessionTransport } from '../browser-runtime/sessionRouter.js'
import { localBrowserMediaSource, type BrowserMediaSource } from '../browser-runtime/mediaSocket.js'
import type { BrowserLifecyclePort } from './ports.js'
import { BrowserAuthority } from './browserAuthority.js'
import { MainBrowserPairing } from './browserPairing.js'
import { MainBrowserRuntime } from './mainBrowserRuntime.js'
import { createBrowserCanonicalCodecs } from './browserCodecs.js'

export interface BrowserRemote {
  profiles: BrowserProfileTransport
  sessions: BrowserSessionTransport<ManagementPrincipal>
  media(binding: BrowserInstallationBinding): BrowserMediaSource<ManagementPrincipal>
  ready(computerId: string): Promise<boolean>
  prepare: BrowserLifecyclePort['prepare']
  release: BrowserLifecyclePort['release']
}
export interface BrowserCompositionOptions {
  pool: pg.Pool; stateDirectory: string; runtimeRoot?: string | undefined
  binding(deviceId: string): DeviceSessionBinding | null
  assertHostOwnership(): Promise<void>
  reportFailure(error: unknown): void
  remote(pairing: MainBrowserPairing, authority: BrowserAuthority): BrowserRemote
}

export function createProductionBrowser(options: BrowserCompositionOptions) {
  let mainId: string | undefined
  const identity = () => {
    if (!mainId) throw new DomainError('BROWSER_STARTING', 'Browser services are still starting.', 503)
    return mainId
  }
  const pairing = new MainBrowserPairing(options.pool, identity, options.binding)
  const computers = async (principal: ManagementPrincipal, sql: SqlQuery = options.pool) => {
    requireAuthorization(await readChatPrincipal(sql, principal.id), 'settings:read')
    const rows = await sql.query<{ record: unknown }>('select record from device_registrations where main_id=$1', [identity()])
    return [{ id: identity(), online: true }, ...rows.rows.map(row => DeviceRegistrationSchema.parse(row.record))
      .filter(device => device.status === 'paired').map(device => ({ id: device.deviceId, online: !!options.binding(device.deviceId) }))]
  }
  const authority: BrowserAuthority = new BrowserAuthority(options.pool, identity, () => profiles.service.repository,
    computerId => computerId === identity() ? Promise.resolve(runtime.status().ready) : remote.ready(computerId))
  const remote: BrowserRemote = options.remote(pairing, authority)
  const runtime: MainBrowserRuntime = new MainBrowserRuntime({ stateDirectory: options.stateDirectory,
    get computerId() { return identity() }, get installationId() { return identity() },
    runtimeRoot: options.runtimeRoot, subjectAuthority: authority, pairing,
    keys: { exportKey: (binding, input) => profiles.keyService.exportKey(binding, input),
      snapshotKey: (binding, transfer, jobId) => profiles.keyService.snapshotKey(binding, transfer, jobId) },
    assertHostOwnership: options.assertHostOwnership, reportFailure: options.reportFailure })
  const localEndpoint = new Proxy({} as BrowserProfileEndpoint, {
    get: (_target, name: keyof BrowserProfileEndpoint) => {
      if (name === 'status' && !runtime.status().ready) return async () => 'runtime_missing'
      const endpoint = runtime.getHost().profileEndpoint
      return endpoint[name].bind(endpoint)
    },
  })
  const profiles: ReturnType<typeof createBrowserProfiles> = createBrowserProfiles({ pool: options.pool, stateDirectory: options.stateDirectory, pairing,
    authority: { computers, authorize: async (principal, action, ids, sql) => {
      requireAuthorization(await readChatPrincipal(sql ?? options.pool, principal.id), action)
      for (const id of ids) await pairing.current(id, sql)
    } }, transport: { endpoint: binding => binding.computerId === identity()
      ? Promise.resolve(localEndpoint) : remote.profiles.endpoint(binding) }, reportFailure: options.reportFailure })
  let local: BrowserSessionService<ManagementPrincipal> | undefined
  const localService = () => {
    const host = runtime.getHost()
    if (!local || local.broker !== host.broker) local = new BrowserSessionService(host.broker, host.media, host.files, authority)
    return local
  }
  const localProxy = new Proxy({} as BrowserSessionService<ManagementPrincipal>, { get: (_target, property) => {
    const service = localService()
    const value: unknown = Reflect.get(service, property)
    return typeof value === 'function' ? value.bind(service) : value
  } })
  const locations = createBrowserSessionLocations(options.pool)
  let router: BrowserSessionPort<ManagementPrincipal> | undefined
  const sessions = new Proxy({} as BrowserSessionPort<ManagementPrincipal>, { get: (_target, property) => {
    if (!router) throw new DomainError('BROWSER_STARTING', 'Browser session routing is still starting.', 503)
    const method = Reflect.get(router, property) as (...args: unknown[]) => unknown
    return method.bind(router)
  } })
  const handlers = createBrowserOperationHandlers(profiles.service, sessions)
  const codecs = createBrowserCanonicalCodecs()
  const lifecycle: BrowserLifecyclePort = {
    async prepare(input) {
      const details = await authority.details(input.subject)
      if (details.computerId !== input.computerId || canonicalJson(details.browser) !== canonicalJson(input.browser)) {
        throw new DomainError('BROWSER_SUBJECT_CHANGED', 'The browser launch differs from its saved node and computer.', 409)
      }
      const result = input.computerId === identity()
        ? runtime.status().ready ? await runtime.getHost().broker.prepare(input)
          : { kind: 'unavailable' as const, reason: 'runtime_missing' as const, retryable: true }
        : await remote.prepare(input)
      if (result.kind === 'ready') await locations.save(result.session, (await pairing.current(input.computerId)).installationId)
      return result
    },
    async release(input) {
      const saved = await locations.session(input.sessionId)
      if (!saved || canonicalJson(saved.session.subject) !== canonicalJson(input.subject)) {
        throw new DomainError('BROWSER_SUBJECT_CHANGED', 'The browser release does not match its retained subject.', 409)
      }
      await pairing.assertInstallation(saved.session.computerId, saved.installationId)
      const result = await (saved.session.computerId === identity() ? runtime.getHost().broker.release(input) : remote.release(input))
      if (result.state !== 'pending') authority.forget(input.subject)
      return result
    },
  }
  return { profiles, authority, pairing, sessions, handlers, codecs, lifecycle, runtime, locations,
    target: (principal: ManagementPrincipal, input: unknown) => resolveBrowserTarget(options.pool, authority, principal, input),
    async start(id: string) {
      mainId = id
      await runtime.start()
      router = createBrowserSessionRouter({ localComputerId: id, local: localProxy, pairing, locations,
        transport: remote.sessions, authority, computers: async principal => (await computers(principal)).map(computer => computer.id),
        subjectComputer: async (_principal, subject: AgentSubject) => (await authority.details(subject)).computerId,
        media: binding => binding.computerId === id ? localBrowserMediaSource(localService()) : remote.media(binding) })
      profiles.start()
    },
    media: { async open(principal: ManagementPrincipal, sessionId: string, viewId: string, changed: () => void) {
      const saved = await locations.session(sessionId)
      if (!saved || await locations.view(viewId) !== sessionId) throw new DomainError('BROWSER_VIEW_SCOPE', 'The view belongs to another session.', 403)
      await authority.session(principal, saved.session, false)
      const binding = await pairing.current(saved.session.computerId)
      await pairing.assertInstallation(binding.computerId, saved.installationId)
      const source = binding.computerId === identity() ? localBrowserMediaSource(localService()) : remote.media(binding)
      return source.open(principal, sessionId, viewId, changed)
    } },
    stopAdmission: () => runtime.stopAdmission(),
    async stop() { await profiles.stop(); await runtime.stop() },
  }
}

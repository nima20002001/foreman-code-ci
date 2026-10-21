import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeHistory } from '../harnesses/port.js'
import { CodexAppServerSessionManager } from '../harnesses/codexAppServer.js'
import * as workerMcpEndpoint from '../runs/remote/workerMcpEndpoint.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { constructionFixture } from '../runs/remote/__tests__/installedWorkflowHost.js'
import { managedMcpChannelFixture } from '../../../test/helpers/managedMcpChannel.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

// Managed launcher installation is outside these in-process transport tests.
vi.mock('../harnesses/installedWorkerManagedMcp.js', () => ({
  createInstalledWorkerManagedMcp: () => ({ worker: {}, ensureReady: async () => {} }),
}))

async function fixture() {
  const f = await constructionFixture()
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(f.root, name), { initializeNewInstallation: true })
    await journal.close()
  }
  const binding = f.context.binding
  const mounted = await createInstalledWorkerDomains({ stateDirectory: f.root, configuration: null,
    pairing: { formatVersion: 1, mainId: binding.mainId, deviceId: binding.deviceId,
      workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://worker.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64),
      credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
    bootId: binding.bootId, approvedRoots: async () => f.approvedRoots, codexSuiteRevision: 'codex-live-4',
    connection: () => ({ currentBinding: f.currentBinding, linkLostAt: f.linkLostAt, mainNow: () => Date.now(),
      captureRequest: () => {
        const live = f.currentBinding()
        return live && { binding: live, request: async () => ({
          payload: { version: 1, operation: 'sources.authorize', owner: f.owner },
        }) }
      } }),
  })
  const sourceExtension = mounted.extensions.find(extension => extension.namespace === 'source-operations-v1')!
  return { ...f, mounted, sourceExtension }
}

describe('installed source operations across Worker link reconnection', () => {
  it.each(['mainId', 'bootId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)(
    'rejects a source context with a changed %s', async field => {
      const f = await fixture()
      const binding = { ...f.context.binding }
      if (field === 'keyRevision' || field === 'authorizationRevision') binding[field]++
      else binding[field] = randomUUID()
      try {
        await expect(f.sourceExtension.handle!({ version: 1, operation: 'sources.verify',
          record: f.nativePlacement.materialization, relativeCwd: '' }, { ...f.context, binding }))
          .rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CONFLICT' })
      } finally {
        await f.host.close()
        await f.mounted.close()
      }
    })

  it('finishes the original execution after the link closes during source verification', async () => {
    const f = await fixture()
    const entered = deferred()
    const release = deferred()
    // Forward the host source port through the production installed source extension.
    vi.spyOn(f.sources, 'handle').mockImplementation(async (payload, context) => {
      entered.resolve()
      await release.promise
      return (await f.sourceExtension.handle!(payload, context)).payload as Awaited<ReturnType<typeof f.sources.handle>>
    })
    const closed = { ...f.launch, lifecycle: 'closed' as const, closureEvidence: 'cgroup_v2_empty' as const }
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(f.session)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
      residency: { session: f.session, connectionId: 'native-connection', runtimeGeneration: 1,
        nativeTurnId: undefined }, assertCurrent: () => {},
    })
    const event = { sequence: 1, type: 'native.notification', occurredAt: new Date().toISOString(),
      payload: { text: 'Work completed.' } }
    const history: NativeHistory = { events: [], pendingInteractions: [], correlationId: 'execution:execution' }
    vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (_session, turn) {
      await turn.onSubmitted?.('original-turn')
      history.events = [event]
      history.nativeTurnId = 'original-turn'
      history.terminalTurn = { correlationId: 'execution:execution', providerId: 'original-turn',
        result: { outcome: 'succeeded' } }
      yield event
    })
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockResolvedValue(history)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => ({
      ...f.registry.scope(owner), launchId: f.launch.launchId,
    }))
    vi.spyOn(f.registry, 'abandonReservedLaunch').mockResolvedValue(false)
    vi.spyOn(f.registry, 'closeRegistration').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
      f.snapshot.mockReturnValue({ revision: 'closed', launches: [closed] })
      return true
    })
    vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
      endpoint: 'http://worker.example/mcp', close: async () => {}, bindRelay: async () => {},
      refreshLease: () => relay.refresh!(),
    }))
    let channel = managedMcpChannelFixture(f.context.binding, f.host.extensions[0]!)
    const prepare = { method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
      executionPlacement: f.nativePlacement, applicationAccess: { kind: 'scoped-worker-mcp', token: 'original-token',
        executionId: f.intent.executionId, agentId: f.request.configuration.agentId, operationId: f.intent.operationId,
        attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash } }
    const pending = channel.main.request('execution-v1', prepare).catch(error => error)
    try {
      await entered.promise
      f.currentBinding.mockReturnValue(undefined)
      f.linkLostAt.mockReturnValue(Date.now())
      await channel.close()
      expect(await pending).toMatchObject({ code: 'transport' })
      const replacement = { ...f.context.binding, connectionGeneration: f.context.binding.connectionGeneration + 1,
        connectionEpoch: randomUUID() }
      f.currentBinding.mockReturnValue(replacement)
      f.linkLostAt.mockReturnValue(undefined)
      channel = managedMcpChannelFixture(replacement, f.host.extensions[0]!)
      release.resolve()
      const prepared = await channel.main.request('execution-v1', prepare)
      expect(prepared.payload).toMatchObject({ session: f.session, status: {
        receipt: { connection: { connectionGeneration: f.context.binding.connectionGeneration } },
      } })
      await channel.close()
      const next = { ...replacement, connectionGeneration: replacement.connectionGeneration + 1,
        connectionEpoch: randomUUID() }
      f.currentBinding.mockReturnValue(next)
      channel = managedMcpChannelFixture(next, f.host.extensions[0]!)
      const reconnected = await channel.main.request('execution-v1', {
        method: 'history', intent: f.intent, placement: f.placement,
      })
      expect(reconnected.payload).toMatchObject({ status: {
        receipt: { connection: { connectionGeneration: f.context.binding.connectionGeneration } },
      } })
      await channel.main.request('execution-v1', { method: 'start-turn', intent: f.intent, placement: f.placement,
        prompt: 'Complete the work.', correlationId: 'execution:execution' })
      await vi.waitFor(async () => {
        expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'known',
          receipt: { terminal: { kind: 'completed' } } })
      })
      expect(create).toHaveBeenCalledOnce()
    } finally {
      release.resolve()
      await channel.close()
      await f.host.close()
      await f.mounted.close()
    }
  })
})

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'
import { constructionFixture } from './__tests__/installedWorkflowHost.js'

it('closes the reserved native launch of a Run stopped before entry so source cleanup and the update drain settle', async () => {
  const f = await constructionFixture()
  // A real registry on disk; the host's registry delegates to it.
  const registry = new NativeProcessRegistry(join(f.root, 'native-registry'))
  vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => registry.reserveLaunch(owner))
  vi.spyOn(f.registry, 'abandonReservedLaunch').mockImplementation(scope => registry.abandonReservedLaunch(scope))
  vi.spyOn(f.registry, 'closeOwner').mockImplementation((owner, signal) => registry.closeOwner(owner, signal))
  vi.spyOn(f.registry, 'closeRegistration').mockImplementation((scope, id, signal) =>
    registry.closeRegistration(scope, id, signal))
  vi.spyOn(f.registry, 'closedRegistration').mockImplementation((owner, id) => registry.closedRegistration(owner, id))
  f.snapshot.mockImplementation(() => registry.snapshot())
  vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
    endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
  }))
  // Main stops the Run after the Worker accepted it but before native entry.
  await f.journal.accept(f.intent, DeviceConnectionIdentitySchema.strip().parse(f.context.binding), randomUUID())
  await f.journal.control({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop-before-entry',
    operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
    bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } })
  const access = { kind: 'scoped-worker-mcp', token: 'original-token', executionId: f.intent.executionId,
    agentId: f.request.configuration.agentId, operationId: f.intent.operationId, attemptId: f.intent.attemptId,
    bindingHash: f.intent.bindingHash }
  try {
    await expect(f.handler({ method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
      executionPlacement: f.nativePlacement, applicationAccess: access }, f.context)).rejects.toThrow()
    const owner = `execution:${f.intent.executionId}`
    expect(registry.snapshot().launches.filter(launch => launch.owner === owner)).toEqual([
      expect.objectContaining({ lifecycle: expect.not.stringMatching(/^closed$/) })])
    expect(await f.journal.isWorkerUpdateIdle(registry.snapshot().launches)).toBe(false)

    await f.host.drainForUpdate()
    expect(registry.snapshot().launches.filter(launch => launch.owner === owner)).toEqual([
      expect.objectContaining({ lifecycle: 'closed', closureEvidence: 'native_not_started' })])
    expect(await f.journal.isWorkerUpdateIdle(registry.snapshot().launches)).toBe(true)
    expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)

    const cleanup = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
    expect(await f.host.preparationClosed(cleanup)).toBe(true)
    expect(registry.snapshot().launches.filter(launch => launch.owner === owner)).toEqual([
      expect.objectContaining({ lifecycle: 'closed', closureEvidence: 'native_not_started' })])
    expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
    expect(await f.journal.isWorkerUpdateIdle(registry.snapshot().launches)).toBe(true)
    // A retried reclamation reads back the same closure.
    expect(await f.host.preparationClosed(cleanup)).toBe(true)
  } finally { await f.host.close() }
})


it.each(['status-only', 'rejected-preparation'] as const)(
  'drains a stopped %s resident without inventing a native launch certificate', async phase => {
    const f = await constructionFixture()
    const registry = new NativeProcessRegistry(join(f.root, 'native-registry'))
    vi.spyOn(f.registry, 'scope').mockImplementation(owner => registry.scope(owner))
    vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(owner => registry.reserveLaunch(owner))
    vi.spyOn(f.registry, 'abandonReservedLaunch').mockImplementation(scope => registry.abandonReservedLaunch(scope))
    vi.spyOn(f.registry, 'closeOwner').mockImplementation((owner, signal) => registry.closeOwner(owner, signal))
    vi.spyOn(f.registry, 'closedRegistration').mockImplementation((owner, id) => registry.closedRegistration(owner, id))
    f.snapshot.mockImplementation(() => registry.snapshot())
    const frame = { intent: f.intent, placement: f.placement }
    const owner = `execution:${f.intent.executionId}`
    try {
      if (phase === 'status-only') {
        await expect(f.handler({ ...frame, method: 'status' }, f.context))
          .resolves.toMatchObject({ payload: { status: 'unknown' } })
      } else {
        await expect(f.handler({ ...frame, method: 'prepare',
          request: { ...f.request, runtimeDirectory: join(f.root, 'outside-runtime') },
          executionPlacement: f.nativePlacement }, f.context)).rejects.toThrow('runtime')
      }
      expect(registry.snapshot().launches).toEqual([])
      await expect(f.handler({ ...frame, method: 'control', command: {
        schemaVersion: 1, protocolVersion: 1, commandId: 'stop-unreserved', operationId: f.intent.operationId,
        executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
        owner: f.intent.owner, action: { kind: 'stop' },
      } }, f.context)).resolves.toMatchObject({ payload: { status: 'known',
        receipt: { stopFence: true, entryAttempted: false } } })

      await expect(f.host.drainForUpdate()).resolves.toBeUndefined()
      const closed = await f.journal.status(f.intent.operationId)
      expect(closed).toMatchObject({ status: 'known', receipt: {
        entryAttempted: false, stopFence: true, terminal: { kind: 'not_started' },
      } })
      expect(closed.status === 'known' && closed.receipt.native).toBeUndefined()
      expect(registry.snapshot().launches).toEqual([])
      expect(registry.closedRegistration(owner)).toBeUndefined()
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(false)
      expect(await f.journal.isWorkerUpdateIdle(registry.snapshot().launches)).toBe(true)
      await expect(f.host.drainForUpdate()).resolves.toBeUndefined()
      expect(await f.journal.status(f.intent.operationId)).toEqual(closed)
      const cleanup = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
      expect(await f.host.preparationClosed(cleanup)).toBe(true)
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      expect(registry.closedRegistration(owner)).toBeUndefined()
    } finally {
      await f.host.close()
      registry.closeRetention()
    }
  })

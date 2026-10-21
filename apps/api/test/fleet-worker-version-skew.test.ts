import { expect, it } from 'vitest'
import { COMPUTER_MAINTENANCE_NAMESPACE, WORKER_UPDATE_NAMESPACE,
  MaintenanceReplySchema } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer, fakeFleet } from './helpers/fleetSync.js'

it.each([true, false])('uses Worker content identity to schedule updates (same content: %s)', async sameContent => {
  const computer = fakeComputer()
  const fleet = fakeFleet(computer)
  Object.assign(fleet.sources, {
    workerManifestSha256s: async () => ['b'.repeat(64)],
    workerContentSha256s: async () => ['c'.repeat(64)],
  })
  fleet.endpoint.capabilities = () => [
    { namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
    { namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false },
  ]
  const original = fleet.endpoint.request
  let observed: unknown
  fleet.endpoint.request = async (device, namespace, payload) => {
    const reply = await original(device, namespace, payload)
    if (!reply.payload.status) return reply
    const response = { payload: { ...reply.payload, status: { ...reply.payload.status, worker: {
      currentVersion: '1.0.0', targetVersion: null, lastError: null, state: 'current' as const,
      manifestSha256: 'a'.repeat(64), contentSha256: (sameContent ? 'c' : 'd').repeat(64),
    } } } }
    observed = response.payload
    return response
  }
  await fleet.fleet.syncChangedSources()
  // Status rejection must not masquerade as skipping an unavailable Worker.
  expect(MaintenanceReplySchema.parse(observed).operation).toBe('status')
  expect(computer.calls).toContainEqual({ binary: 'sudo', args: ['-n', 'true'] })
  expect(fleet.requested.filter(task => task.kind === 'update-worker')).toHaveLength(sameContent ? 0 : 1)
})

it('keeps automatic Worker maintenance distinct from an explicit Retry', async () => {
  const computer = fakeComputer()
  const fleet = fakeFleet(computer)
  Object.assign(fleet.sources, { workerManifestSha256s: async () => ['b'.repeat(64)] })
  fleet.endpoint.capabilities = () => [
    { namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
    { namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false },
  ]
  computer.ports.workerUpdate = {
    status: async () => ({ currentVersion: '1.0.0', targetVersion: '1.1.0', state: 'rolled-back',
      lastError: 'worker_update_startup_timeout', manifestSha256: 'a'.repeat(64) }),
    start: async () => 'Worker update needs a retry.',
  }
  await fleet.fleet.syncChangedSources()
  expect(fleet.requested.filter(task => task.kind === 'update-worker')).toEqual([
    { kind: 'update-worker', retry: false },
  ])
})

it.each([undefined, 'a'.repeat(64)])('prompts a same-version Worker with stale manifest %s and backs off retries', async manifest => {
  const computer = fakeComputer()
  let now = Date.now()
  const fleet = fakeFleet(computer, () => now)
  Object.assign(fleet.sources, { workerManifestSha256s: async () => ['b'.repeat(64)] })
  const capabilities = [{ namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
    { namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false }]
  fleet.endpoint.capabilities = () => capabilities
  const original = fleet.endpoint.request
  const updates: unknown[] = []
  fleet.endpoint.request = async (device, namespace, payload) => {
    const input = payload as { operation: string; commandId?: string; task?: { kind: string } }
    if (input.operation === 'status') {
      const reply = await original(device, namespace, payload)
      if (!reply.payload.status) throw new Error('Expected maintenance status.')
      return { payload: { ...reply.payload, status: { ...reply.payload.status, worker: {
        currentVersion: '1.0.0', targetVersion: '1.0.0', state: 'rolled-back' as const,
        lastError: 'worker_update_startup_timeout', ...(manifest ? { manifestSha256: manifest } : {}),
      } } } }
    }
    if (input.task?.kind === 'update-worker') {
      updates.push(payload)
      return { payload: { operation: 'start', task: { id: input.commandId!, kind: 'update-worker' as const, state: 'failed' as const,
        startedAt: new Date(now).toISOString(), finishedAt: new Date(now).toISOString(),
        summary: 'Retry later.', outputTail: '' } } }
    }
    return original(device, namespace, payload)
  }
  await fleet.fleet.syncChangedSources()
  expect(updates).toHaveLength(1)
  await fleet.fleet.syncChangedSources()
  expect(updates).toHaveLength(1)
  now += 5 * 60_000
  await fleet.fleet.syncChangedSources()
  expect(updates).toHaveLength(2)
})

it.each(['current', 'updating', 'unsupported'] as const)('leaves a %s Worker alone', async condition => {
  const computer = fakeComputer()
  const fleet = fakeFleet(computer)
  Object.assign(fleet.sources, { workerManifestSha256s: async () => ['b'.repeat(64)] })
  fleet.endpoint.capabilities = () => [
    { namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
    ...(condition === 'unsupported' ? [] : [{ namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false }]),
  ]
  const original = fleet.endpoint.request
  fleet.endpoint.request = async (device, namespace, payload) => {
    const reply = await original(device, namespace, payload)
    if (!reply.payload.status) return reply
    return { payload: { ...reply.payload, status: { ...reply.payload.status, worker: {
      currentVersion: '1.0.0', targetVersion: '1.0.0', lastError: null,
      state: condition === 'updating' ? 'restarting' as const : 'current' as const,
      manifestSha256: condition === 'current' ? 'b'.repeat(64) : 'a'.repeat(64),
    } } } }
  }
  await fleet.fleet.syncChangedSources()
  expect(fleet.requested.some(task => task.kind === 'update-worker')).toBe(false)
})

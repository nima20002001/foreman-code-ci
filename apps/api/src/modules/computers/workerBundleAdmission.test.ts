import { expect, it, vi } from 'vitest'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { DEVICE_APPLICATION_IN_FLIGHT } from '@foreman-code/contracts/device-application'
import { workerBundleFixture } from '../../../test/support/workerBundle.js'
import { buildComputerFixture } from '../../../test/helpers/buildComputerFixture.js'
import { JobComputerSelection } from '../jobs/computerSelection.js'
import type { BuildComputerSettings } from '../settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import type { JobSql } from '../jobs/repository.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'

it.each([
  ['execution-v1', { method: 'prepare' }],
  ['execution-v1', { method: 'start-turn' }],
  ['execution-v1', { method: 'prepare-review' }],
  ['execution-v1', { method: 'conversation.initial-turn' }],
  ['execution-v1', { method: 'conversation.start-turn' }],
  ['execution-v1', { method: 'job-dispatch' }],
  ['execution-prepare', { method: 'prepare' }],
  ['ci-host-v1', { operation: 'start' }],
])('rejects stale new work on %s with identities and phase', async (namespace, payload) => {
  const f = await workerBundleFixture()
  try {
    await expect(f.request(namespace as string, payload)).rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW', details: {
      expected: f.expected, running: { manifestSha256: f.status.worker.manifestSha256 }, updatePhase: 'current',
    } })
    expect(f.handled).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('checks captured requests again and never follows a replacement connection', async () => {
  const f = await workerBundleFixture()
  try {
    f.match()
    const captured = f.endpoint.captureRequest(f.identity.deviceId, 'execution-v1')!
    await expect(captured.request({ method: 'start-turn' })).resolves.toBeDefined()
    f.status.worker.contentSha256 = 'e'.repeat(64)
    f.status.worker.manifestSha256 = 'd'.repeat(64)
    await expect(captured.request({ method: 'start-turn' })).rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
    f.match()
    await f.reconnect()
    await expect(captured.request({ method: 'start-turn' })).rejects.toThrow()
  } finally { await f.close() }
})

it('allows equivalent content for the same target and rejects identities belonging to another target', async () => {
  const f = await workerBundleFixture()
  try {
    f.status.worker.contentSha256 = f.expected.contentSha256
    await expect(f.request('execution-v1', { method: 'start-turn' })).resolves.toBeDefined()
    f.status.worker.target = { ...f.status.worker.target, arch: 'arm64' }
    await expect(f.request('execution-v1', { method: 'start-turn' }))
      .rejects.toMatchObject({ code: 'WORKER_BUNDLE_UNPUBLISHED' })
  } finally { await f.close() }
})

it.each(['downloading', 'draining', 'installing', 'restarting'])('reports update phase %s without admitting stale work', async phase => {
  const f = await workerBundleFixture()
  try {
    f.status.worker.state = phase
    await expect(f.request('ci-host-v1', { operation: 'start' })).rejects.toMatchObject({
      code: 'WORKER_UPDATING', details: { expected: f.expected, updatePhase: phase },
    })
    f.match()
    if (phase === 'downloading') {
      await expect(f.request('ci-host-v1', { operation: 'start' })).resolves.toBeDefined()
    } else {
      await expect(f.request('ci-host-v1', { operation: 'start' })).rejects.toMatchObject({ code: 'WORKER_UPDATING' })
    }
  } finally { await f.close() }
})

it('keeps renewals, readback, ACK, Stop and update requests available during skew', async () => {
  const f = await workerBundleFixture()
  try {
    for (const method of ['renew-owner', 'status', 'history', 'physical-ack', 'control', 'conversation.stop',
      'conversation.compact-read', 'conversation.reconcile', 'conversation.refresh-mcp']) {
      await expect(f.request('execution-v1', { method })).resolves.toEqual({ payload: { method } })
    }
    await expect(f.request('execution-v1', { method: 'conversation.file-copy', copy: { phase: 'close' } }))
      .resolves.toBeDefined()
    await expect(f.request(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start', task: { kind: 'update-worker' } }))
      .resolves.toBeDefined()
    await expect(f.request('ci-host-v1', { operation: 'status' })).resolves.toBeDefined()
    await expect(f.request('execution-v1', { method: 'start-turn' })).rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
  } finally { await f.close() }
})

it('checks the selected Job computer through the same connected bundle check', async () => {
  const f = await workerBundleFixture()
  const { candidate } = buildComputerFixture(f.identity.mainId, 'workspace', f.identity.deviceId)
  const settings = { requireEnabled: vi.fn(async () => {}) } as unknown as BuildComputerSettings
  const selection = new JobComputerSelection(settings, { candidates: async () => ({ candidates: [], diagnosticCodes: [] }) },
    new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }), undefined,
    async host => { if (host.kind === 'device') await f.endpoint.assertWorkerBundleReady(host.deviceId) })
  try {
    await expect(selection.validateFixed({} as JobSql, candidate.spec))
      .rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
    f.match()
    await expect(selection.validateFixed({} as JobSql, candidate.spec)).resolves.toMatchObject({ valid: true })
  } finally { await f.close() }
})

it('preserves identities and phase when Worker admission rejects over the authenticated channel', async () => {
  const f = await workerBundleFixture()
  f.match()
  const details = { ready: false, code: 'WORKER_UPDATING', expected: f.expected,
    running: f.expected, updatePhase: 'draining', publicationError: null }
  f.handled.mockRejectedValue(new DomainError('WORKER_UPDATING', 'The Worker is draining.', 409, details))
  try {
    await expect(f.request('execution-v1', { method: 'prepare' })).rejects.toMatchObject({
      code: 'WORKER_UPDATING', retryable: true, details,
    })
  } finally { await f.close() }
})

it('reports persisted publication failure even when the running identity matches', async () => {
  const f = await workerBundleFixture()
  try {
    f.match()
    f.index.publication = { state: 'failed', lastError: 'Release asset missing' }
    await f.publish()
    await expect(f.request('execution-v1', { method: 'prepare' })).rejects.toMatchObject({
      code: 'WORKER_BUNDLE_UNPUBLISHED', details: { publicationError: 'Release asset missing',
        running: { manifestSha256: f.expected.manifestSha256 }, updatePhase: 'current' },
    })
  } finally { await f.close() }
})

it('rejects conflicting content even when the reported manifest matches', async () => {
  const f = await workerBundleFixture()
  try {
    f.status.worker.manifestSha256 = f.expected.manifestSha256
    await expect(f.request('execution-v1', { method: 'start-turn' }))
      .rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
  } finally { await f.close() }
})

it('rechecks queued work without blocking maintenance probes behind occupied request slots', async () => {
  const f = await workerBundleFixture()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  f.match()
  f.handled.mockImplementation(async payload => {
    if ((payload as { method: string }).method === 'prepare') await pending
    return { payload }
  })
  const occupied = Array.from({ length: 8 }, () => f.request('execution-v1', { method: 'prepare' }))
  let queued: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(f.handled).toHaveBeenCalledTimes(8))
    queued = f.request('execution-v1', { method: 'start-turn' })
    const rejected = expect(queued).rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
    f.status.worker.contentSha256 = 'e'.repeat(64)
    release()
    await rejected
    expect(f.handled).toHaveBeenCalledTimes(8)
  } finally {
    release()
    await Promise.allSettled(occupied)
    await f.close()
    await Promise.allSettled(queued ? [queued] : [])
  }
})

it('checks the running bundle without waiting for slow full maintenance inspections', async () => {
  const f = await workerBundleFixture()
  const release = f.holdFullStatus()
  try {
    f.match()
    await expect(f.endpoint.assertWorkerBundleReady(f.identity.deviceId)).resolves.toBeUndefined()
    await expect(f.request('execution-v1', { method: 'start-turn' })).resolves.toEqual({ payload: { method: 'start-turn' } })
    f.status.worker.contentSha256 = 'e'.repeat(64)
    f.status.worker.manifestSha256 = 'd'.repeat(64)
    await expect(f.endpoint.assertWorkerBundleReady(f.identity.deviceId))
      .rejects.toMatchObject({ code: 'WORKER_VERSION_SKEW' })
  } finally {
    release()
    await f.close()
  }
}, 20_000)

it('checks bundle readiness while startup requests occupy every ordinary device slot', async () => {
  const f = await workerBundleFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  f.match()
  f.handled.mockImplementation(async payload => {
    await held
    return { payload }
  })
  const occupied: Promise<unknown>[] = []
  let readiness: Promise<unknown> | undefined
  try {
    for (let index = 0; index < DEVICE_APPLICATION_IN_FLIGHT - 1; index++) {
      occupied.push(f.request('ci-host-v1', { operation: 'status' }))
    }
    await vi.waitFor(() => expect(f.handled).toHaveBeenCalledTimes(DEVICE_APPLICATION_IN_FLIGHT - 1))
    occupied.push(f.request('execution-v1', { method: 'status' }))
    await vi.waitFor(() => expect(f.handled).toHaveBeenCalledTimes(DEVICE_APPLICATION_IN_FLIGHT))

    readiness = f.endpoint.assertWorkerBundleReady(f.identity.deviceId).then(() => 'ready', (error: unknown) => error)
    await vi.waitFor(() => expect(f.bundleStatus).toHaveBeenCalledOnce())
    expect(await readiness).toBe('ready')
    expect(f.handled).toHaveBeenCalledTimes(DEVICE_APPLICATION_IN_FLIGHT)
  } finally {
    release()
    await Promise.allSettled([...occupied, ...(readiness ? [readiness] : [])])
    await f.close()
  }
})

it('reports a Worker that cannot report its running bundle as a retryable domain error', async () => {
  const f = await workerBundleFixture()
  try {
    f.match()
    f.failStatus(new DeviceApplicationError('unavailable'))
    const failure = await f.endpoint.assertWorkerBundleReady(f.identity.deviceId).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({ code: 'WORKER_STATUS_UNAVAILABLE', status: 503,
      details: { retryable: true, reason: 'unavailable' } })
  } finally { await f.close() }
})

it('treats a Worker that predates bundle-only status as running an unknown bundle', async () => {
  const f = await workerBundleFixture()
  try {
    f.match()
    // An older Worker's strict request schema rejects the scoped status request.
    f.bundleStatus.mockRejectedValue(new Error('Unrecognized key: scope'))
    await expect(f.endpoint.assertWorkerBundleReady(f.identity.deviceId)).rejects.toMatchObject({
      code: 'WORKER_VERSION_SKEW', details: { expected: { version: f.expected.version }, running: null, updatePhase: null } })
  } finally { await f.close() }
})

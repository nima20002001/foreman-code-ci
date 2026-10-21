import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { DeviceSessionBindingSchema } from '@foreman-code/contracts/device-connection'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'

const ports = vi.hoisted(() => ({ qualification: vi.fn(), open: vi.fn(), close: vi.fn(), jobs: vi.fn(), recover: vi.fn(), handle: vi.fn(), shutdown: vi.fn(), inputs: vi.fn() }))
vi.mock('../jobs/workerQualificationCarrier.js', () => ({ createWorkerQualificationExtension: ports.qualification }))
vi.mock('../runs/remote/operationJournal.js', () => ({ RemoteOperationJournal: { open: ports.open } }))
vi.mock('../runs/remote/installedWorkflowHost.js', () => ({ createInstalledWorkflowHost: async () => ({ kind: 'unavailable' }) }))
vi.mock('../jobs/executorInstalled.js', () => ({ createInstalledJobExecutionHost: ports.jobs }))
vi.mock('../files/jobInputs/workerFactory.js', () => ({ createWorkerJobInputPort: () => ({ prepare: ports.inputs, close: async () => {} }) }))
vi.mock('../runs/remote/workerJobOutputs.js', () => ({ createWorkerJobOutputCollector: () => async () => {} }))
import { createInstalledWorkerDomains } from './installedWorkerDomains.js'

describe('original installed Job qualification composition, no native entry', () => {
  it('opens the established Job journal and closes it once without borrowing workflow ownership', async () => {
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unconnected.example/device/connect',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    ports.qualification.mockReturnValue({ namespace: 'job-runtime-qualification-v1', version: 1, role: 'duplex', maxJsonBytes: 1, maxBinaryBytes: 0, drain: async () => {} })
    ports.open.mockResolvedValue({ close: ports.close, pendingQualifications: async () => [] } as unknown as RemoteOperationJournal)
    const mounted = await createInstalledWorkerDomains({ stateDirectory: '/original-worker-state', pairing, bootId: randomUUID(),
      configuration: null, jobConfiguration: { path: '/original-worker-state/job-runtime.json', ownerUid: 1000 },
      // This test exercises composition only; the injected host never parses or uses root authority.
      approvedRoots: async () => ({} as ApprovedRootAllowlist), connection: () => undefined, codexSuiteRevision: 'source-test-suite' })
    const qualification = ports.qualification.mock.calls[0]![0] as { journal(): Promise<RemoteOperationJournal>; registry: { snapshot(): unknown } }
    const journal = await qualification.journal()
    expect(await qualification.journal()).toBe(journal)
    expect(ports.open).toHaveBeenCalledExactlyOnceWith('/original-worker-state/job-runtime-operations.json', {
      now: expect.any(Function), retentionNow: expect.any(Function),
    })
    const clock = ports.open.mock.calls[0]![1] as { now(): number; retentionNow(): number | undefined }
    expect(clock.now()).toBeTypeOf('number')
    expect(clock.retentionNow()).toBeUndefined()
    expect(qualification.registry.snapshot()).toMatchObject({ launches: [] })
    await mounted.close(); await mounted.close()
    expect(ports.close).toHaveBeenCalledTimes(1)
  })
})

it('recovers the original Job host before routing an authenticated Job frame, with no native entry', async () => {
  vi.clearAllMocks()
  const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const binding = DeviceSessionBindingSchema.parse({ mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: pairing.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 3, connectionEpoch: randomUUID() })
  const calls: string[] = []
  ports.recover.mockImplementation(async () => { calls.push('recover') })
  ports.handle.mockImplementation(async () => { calls.push('handle'); return { status: 'unit-routed' } })
  ports.jobs.mockReturnValue({ recover: ports.recover, handle: ports.handle, shutdown: ports.shutdown })
  ports.open.mockResolvedValue({ close: ports.close, pendingQualifications: async () => [] } as unknown as RemoteOperationJournal)
  ports.qualification.mockReturnValue({ namespace: 'job-runtime-qualification-v1', version: 1, role: 'duplex', maxJsonBytes: 1, maxBinaryBytes: 0, drain: async () => {} })
  const mainTime = Date.now() + 60_000
  let connected = true
  const mounted = await createInstalledWorkerDomains({ stateDirectory: '/original-worker-state', pairing, bootId: binding.bootId, configuration: null,
    jobConfiguration: { path: '/original-worker-state/job-runtime.json', ownerUid: 1000 }, approvedRoots: async () => ({} as ApprovedRootAllowlist),
    connection: () => connected
      ? { currentBinding: () => binding, captureRequest: () => undefined, mainNow: () => mainTime }
      : undefined,
    codexSuiteRevision: 'unit-suite' })
  expect(ports.jobs).not.toHaveBeenCalled()
  const job = jobExecution()
  const request = RemoteJobExecutionRpcRequestRecordSchema.parse({ method: 'job-status', intent: {
    schemaVersion: 1, protocolVersion: 1, mainId: job.acceptedSpec.target.mainId,
    subject: { kind: 'manual-job', workspaceId: job.workspaceId, jobExecutionId: job.id,
      definitionId: job.acceptedSpec.definitionId }, executionId: job.id, attemptId: job.attemptId,
    operationId: job.operationId, bindingHash: job.acceptedSpec.bindingHash,
    inputDigest: `sha256:${job.acceptedSpec.specDigest}`, owner: job.owner,
  } })
  const execution = mounted.extensions.find(extension => extension.namespace === 'execution-v1')!
  const context = { binding, signal: new AbortController().signal }
  await expect(execution.handle!(request, context)).resolves.toEqual({ payload: { status: 'unit-routed' } })
  await execution.handle!(request, context)
  expect(calls).toEqual(['recover', 'handle', 'handle'])
  expect(ports.jobs).toHaveBeenCalledTimes(1)
  expect(ports.jobs.mock.calls[0]![0]).toMatchObject({ connection: binding, journal: await ports.open.mock.results[0]!.value })
  expect(ports.open).toHaveBeenCalledExactlyOnceWith('/original-worker-state/job-runtime-operations.json', {
    now: expect.any(Function), retentionNow: expect.any(Function),
  })
  const clock = ports.open.mock.calls[0]![1] as { now(): number; retentionNow(): number | undefined }
  vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(125).mockReturnValue(150)
  expect(clock.now()).toBe(mainTime + 25)
  expect(clock.retentionNow()).toBe(mainTime)
  await expect(execution.handle!(request, { ...context, binding: { ...binding, connectionGeneration: 4 } })).rejects.toThrow('actual authenticated')
  connected = false
  expect(clock.retentionNow()).toBeUndefined()
  expect(clock.now()).toBe(mainTime + 50)
  await mounted.close()
  expect(ports.shutdown).toHaveBeenCalledOnce()
  vi.restoreAllMocks()
})

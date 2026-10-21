import { randomUUID } from 'node:crypto'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { WorkerPairingConfigurationSchema } from '@foreman-code/contracts/device-identity'
import { ApprovedRootAllowlistSchema } from '@foreman-code/contracts/workspace-root-policies'
import { RemoteJobConnectionIdentitySchema, type RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { createInstalledWorkerDomains } from '../../devices/installedWorkerDomains.js'

it('journals the complete authenticated Worker connection used by the installed Job composition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'job-epoch-'))
  const journal = await RemoteOperationJournal.open(join(directory, 'operations.json'), { initializeNewInstallation: true })
  let closed = false
  const execution = jobExecution(), deviceId = randomUUID(), registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  execution.acceptedSpec.target.hostRef = { kind: 'device', mainId: execution.acceptedSpec.target.mainId, deviceId }
  execution.acceptedSpec.target.registration = registration
  const connection: DeviceSessionBinding = { mainId: execution.acceptedSpec.target.mainId, deviceId, ...registration, bootId: randomUUID(), connectionGeneration: 1, connectionEpoch: randomUUID() }
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: connection.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
    bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner }
  const host = new RemoteJobExecutionHost({ journal, connection, incarnationId: randomUUID(),
    // The regression ends at original durable acceptance, before OCI entry.
    supervisor: async () => { throw new Error('No native entry in connection regression.') },
    source: { verify: async () => { throw new Error('No source execution.') } }, inputs: { prepare: async () => { throw new Error('No inputs.') } },
    authorize: async () => {}, observeReceipt: async () => {}, appendLog: async () => {}, collectOutputs: async () => {},
  })
  try {
    const status = await host.handle({ method: 'job-dispatch', intent, execution })
    expect(status.status).toBe('known')
    if (status.status !== 'known') throw new Error('The original connection was not durably accepted.')
    expect(status.receipt.connection).toEqual(connection)
    expect(status.receipt.entryAttempted).toBe(false)
    expect(status.receipt.native).toBeUndefined()
    expect(status.receipt.execution.acceptedSpec).toEqual(execution.acceptedSpec)
    expect(RemoteJobConnectionIdentitySchema.safeParse({ ...connection, connectionEpoch: 'invalid' }).success).toBe(false)
    expect(RemoteJobConnectionIdentitySchema.safeParse({ ...connection, untrusted: true }).success).toBe(false)
    const historical = Object.fromEntries(Object.entries(connection).filter(([key]) => key !== 'connectionEpoch'))
    expect(RemoteJobConnectionIdentitySchema.parse(historical)).toEqual(historical)
    const replay = await journal.jobAccept(intent, execution, { ...connection, connectionEpoch: randomUUID() }, randomUUID())
    expect(replay.connection).toEqual(connection)
    await host.shutdown(); await journal.close(); closed = true
    // Exercise the actual installed constructor and execution-v1 mount when
    // reopening a retained historical operation. No new-dispatch admission or
    // real Main/OCI authorization is fabricated by this metadata seam.
    const pairing = WorkerPairingConfigurationSchema.parse({ formatVersion: 1, ...registration, mainId: connection.mainId, deviceId,
      endpoint: 'wss://unconnected.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const filesystem = { device: '1', inode: '1', mountId: '1' }
    const approved = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: execution.acceptedSpec.target.hostRef,
      applicationInstallationId: registration.workerInstallationId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: join(directory, 'source'), filesystem, accessModes: ['read-write'] }],
      managedRuntimeRoot: join(directory, 'runtime'), runtimeFilesystem: filesystem })
    // The installed constructor uses its original fixed journal filename.
    await rename(join(directory, 'operations.json'), join(directory, 'job-runtime-operations.json'))
    const mounted = await createInstalledWorkerDomains({ stateDirectory: directory, pairing, bootId: connection.bootId, configuration: null,
      jobConfiguration: { path: join(directory, 'unconfigured-job-runtime.json'), ownerUid: process.getuid!() }, approvedRoots: async () => approved,
      connection: () => ({ currentBinding: () => connection, mainNow: Date.now,
        captureRequest: namespace => ({ binding: connection, request: async raw => {
        const frame = raw as { method: string; action?: string; receipt?: { sequence: number; connection: unknown } }
        expect(namespace).toBe('execution-v1')
        // Reading the retained operation closes its abandoned preparation and reports that receipt to Main.
        if (frame.method === 'job-report') {
          expect(frame.receipt?.connection).toEqual(connection)
          return { payload: { persistedSequence: frame.receipt!.sequence } }
        }
        expect(frame).toMatchObject({ method: 'job-authorize', action: 'read' })
        return { payload: { authorized: true, operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner } }
      } }) }), codexSuiteRevision: 'connection-regression' })
    try {
      const handler = mounted.extensions.find(extension => extension.namespace === 'execution-v1')!
      const result = await handler.handle!({ method: 'job-status', intent }, { binding: connection, signal: new AbortController().signal })
      expect(result.payload).toMatchObject({ status: 'known', receipt: { connection, entryAttempted: false } })
    } finally { await mounted.close() }
  } finally { if (!closed) { await host.shutdown(); await journal.close() }; await rm(directory, { recursive: true, force: true }) }
})

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteJobDispatchIntentSchema, type RemoteJobOwnerControl } from '@foreman-code/contracts/remote-job-execution'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { JOB_PRIVATE_GIT_LAYOUT } from '../../jobs/privateGitMounts.js'
import type { QualifiedJobProfile } from '../../jobs/executor.js'
import { privateFixtureDirectory } from '../../../../test/helpers/privateFixtureDirectory.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { DomainError } from '../../errors.js'
import { JobRepository } from '../../jobs/repository.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { RemoteJobCarrierDispatch } from './jobCarrierDispatch.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await privateFixtureDirectory('job-dispatch-recovery-')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
  cleanups.push(() => journal.close())
  const execution = jobExecution()
  Object.assign(execution.acceptedSpec, jobSpecDigests(execution.acceptedSpec, execution.acceptedSpec.workflowInput))
  const connection = { kind: 'main' as const, mainId: execution.acceptedSpec.target.mainId,
    mainInstallationId: execution.acceptedSpec.target.mainInstallationId!, bootId: randomUUID() }
  const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    mainId: connection.mainId, executionId: execution.id, operationId: execution.operationId,
    attemptId: execution.attemptId, bindingHash: execution.acceptedSpec.bindingHash,
    inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId,
      jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
  const authorize = vi.fn(async () => {})
  const source = { verify: vi.fn(async () => { throw new DomainError('SOURCE_IDENTITY_MISMATCH', 'Pinned source changed', 409) }) }
  const policy = execution.acceptedSpec.policy
  const qualifiedProfile: QualifiedJobProfile = { workspaceLayout: JOB_PRIVATE_GIT_LAYOUT,
    policyId: policy.isolationPolicyId, policyRevision: policy.isolationPolicyRevision,
    imageDigest: policy.imageDigest, toolchainDigest: policy.toolchainDigest,
    runtimeVersion: 'fixture', ociRuntimeVersion: 'fixture', kernelVersion: 'fixture',
    qualificationId: 'fixture', rootless: true, cgroupV2: true, filesystemBounded: true,
    descendantContainment: true, network: 'none', cpuLimit: 1, memoryBytes: 1024,
    pidsLimit: 16, diskBytes: 1024 }
  const host = new RemoteJobExecutionHost({ journal, connection, incarnationId: randomUUID(),
    supervisor: { qualifiedProfile } as never, source, inputs: {} as never, authorize,
    observeReceipt: async () => {}, appendLog: async () => {}, collectOutputs: async () => {} })
  cleanups.push(() => host.drain())
  const command: RemoteJobOwnerControl = { schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(),
    operationId: intent.operationId, executionId: execution.id, attemptId: intent.attemptId,
    bindingHash: intent.bindingHash, subject: intent.subject, owner: intent.owner, action: { kind: 'stop' } }
  return { journal, path, execution, connection, intent, command, host, authorize, source }
}

it('replays a lost dispatch through the original journal once status confirms absence', async () => {
  const f = await fixture()
  vi.spyOn(JobRepository.prototype, 'execution').mockResolvedValue(f.execution)
  const release = vi.fn()
  const pool = { connect: async () => ({ release }) } as unknown as pg.Pool
  const frames: unknown[] = []
  const carrier = new RemoteJobCarrierDispatch(pool, { request: async () => { throw new Error('Unused device') } },
    { handle: async frame => { frames.push(frame); return f.host.handle(frame) } })
  expect(await carrier.reconcile(f.intent)).toMatchObject({ status: 'known' })
  await f.host.drain()
  expect(frames).toMatchObject([{ method: 'job-status' }, { method: 'job-dispatch', intent: f.intent }])
  expect(await carrier.reconcile(f.intent)).toMatchObject({ status: 'known' })
  expect(f.source.verify).toHaveBeenCalledTimes(1)
})

it('records cancellation of an undelivered Job without preparing or launching it', async () => {
  const f = await fixture()
  expect(await f.host.handle({ method: 'job-control', intent: f.intent, execution: f.execution,
    command: f.command })).toMatchObject({ status: 'known', receipt: {
    entryAttempted: false, stopFence: true, terminal: { outcome: 'cancelled', processStopped: true },
    publication: 'complete',
  } })
  expect(f.authorize).toHaveBeenCalledWith(f.intent, f.execution, 'control')
  expect(f.source.verify).not.toHaveBeenCalled()
  await f.journal.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  cleanups.push(() => reopened.close())
  expect((await reopened.jobReserveEntry(f.intent.operationId)).reserved).toBe(false)
})

it('denies undelivered cancellation before creating a journal record', async () => {
  const f = await fixture()
  f.authorize.mockRejectedValue(new Error('Control denied'))
  await expect(f.host.handle({ method: 'job-control', intent: f.intent, execution: f.execution,
    command: f.command })).rejects.toThrow('Control denied')
  expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'unknown' })
})

it('waits for concurrent admission before cancelling its still-active input writer', async () => {
  const f = await fixture()
  let allowStart!: () => void
  let finishWriter!: () => void
  let authorizedControl!: () => void
  let writerStarted!: () => void
  const startGate = new Promise<void>(resolve => { allowStart = resolve })
  const writerGate = new Promise<void>(resolve => { finishWriter = resolve })
  const controlling = new Promise<void>(resolve => { authorizedControl = resolve })
  const writing = new Promise<void>(resolve => { writerStarted = resolve })
  f.authorize.mockImplementation(async (...args: unknown[]) => {
    if (args[2] === 'start') await startGate
    if (args[2] === 'control') authorizedControl()
  })
  f.source.verify.mockImplementation(async () => {
    writerStarted()
    await writerGate
    throw new Error('Writer stopped')
  })
  const delivering = f.host.deliver(f.intent, f.execution)
  const cancelling = f.host.handle({ method: 'job-control', intent: f.intent, execution: f.execution,
    command: f.command })
  try {
    await Promise.race([controlling, cancelling])
    allowStart()
    await delivering
    await writing
    expect(await cancelling).not.toHaveProperty('receipt.terminal')
  } finally {
    allowStart()
    finishWriter()
    await Promise.all([delivering, cancelling])
    await f.host.drain()
  }
  expect(await f.host.handle({ method: 'job-status', intent: f.intent })).toMatchObject({ status: 'known',
    receipt: { terminal: { outcome: 'cancelled', processStopped: true } } })
})

it.each(['startup', 'status'] as const)('settles accepted pre-entry preparation after a restart through %s', async read => {
  const f = await fixture()
  await f.journal.jobAccept(f.intent, f.execution, f.connection, randomUUID())
  if (read === 'startup') await f.host.recover()
  // A status read re-delivers a received Job whose preparation never started, so it prepares and fails once.
  await f.host.handle({ method: 'job-status', intent: f.intent })
  await f.host.drain()
  expect(await f.host.handle({ method: 'job-status', intent: f.intent })).toMatchObject({ status: 'known',
    receipt: { entryAttempted: false, terminal: { outcome: 'preparation_failed', processStopped: true },
      publication: 'complete' } })
  expect((await f.journal.jobReserveEntry(f.intent.operationId)).reserved).toBe(false)
  expect(f.source.verify).toHaveBeenCalledTimes(read === 'status' ? 1 : 0)
})

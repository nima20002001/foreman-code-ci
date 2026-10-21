import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VerificationJobExecutionSchema, JobVerificationReportSchema } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { JobVerificationRepositoryContextSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { SourcePreparationClosure } from '@foreman-code/contracts/source-admission'
import type { RemoteJobDispatchIntent, RemoteJobTerminalEvidence } from '@foreman-code/contracts/remote-job-execution'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { createVerificationPublication } from './verificationPublication.js'
import { reserveVerificationReportSpace } from './executorOutputs.js'
import { jobSupervisorIdentity } from './executor.js'
import { jobLifecycleSignal } from './lifecycle.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

it.each(['main', 'device'] as const)('permits runtime refresh after failed publication and verified quota reclamation on %s', async location => {
  const f = await fixture(location)
  try {
    await f.journal.jobPublication(f.execution.operationId, 'failed')
    await expect(f.journal.assertRuntimeQuiescent()).rejects.toThrow('unfinished work')
    const execution = f.execution, target = execution.acceptedSpec.target
    const name = jobSupervisorIdentity(execution), containerId = 'a'.repeat(64), bootId = bootIdentity()
    await f.journal.jobContainerIntent(execution.operationId, name, execution.acceptedSpec.specDigest)
    await f.journal.jobBindContainer(execution.operationId, name, containerId)
    await f.journal.jobCertificate(execution.operationId, {
      scope: { subject: { kind: 'job', executionId: execution.id, attemptId: execution.attemptId,
        operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash },
        leaseId: execution.operationId, owner: execution.owner, bootId,
        observedDeviceId: target.hostRef.kind === 'device' ? target.hostRef.deviceId : null,
        observedInstallationId: target.registration?.workerInstallationId ?? target.mainInstallationId },
      containerId, process: { pid: 42, startTicks: '123', bootId },
      boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/libpod-${containerId}.scope`, device: '1', inode: '2' },
      helpers: [], lifecycle: 'closed',
    })
    const closure: SourcePreparationClosure = {
      version: 1, reconciliationId: randomUUID(), operationId: execution.operationId,
      executionId: execution.id, attemptId: execution.attemptId, rootId: randomUUID(), bindingRevision: 1,
      materializationId: execution.acceptedSpec.source.materializationId!, mainId: target.mainId,
      deviceId: target.hostRef.kind === 'device' ? target.hostRef.deviceId : null,
      workerInstallationId: target.registration?.workerInstallationId ?? null,
      keyRevision: target.registration?.keyRevision ?? null, authorizationRevision: target.registration?.authorizationRevision ?? null,
      filesystem: { device: '1', inode: '2', mountId: '3' }, admissionClosed: true, childrenClosed: true,
      claimReleased: true, evidencePreserved: true, quotaReclaimed: true, observedAt: new Date().toISOString(),
    }
    await expect(f.journal.jobSourceReclaimed(execution.operationId, { ...closure, attemptId: randomUUID() })).rejects.toThrow()
    await expect(f.journal.jobSourceReclaimed(execution.operationId, { ...closure, quotaReclaimed: undefined })).rejects.toThrow()
    await f.journal.jobSourceReclaimed(execution.operationId, closure)
    await expect(f.journal.assertRuntimeQuiescent()).resolves.toBeUndefined()
    expect((await f.journal.jobNativeOwner(execution.operationId))?.verification?.finalizedAt).toBeNull()
    expect(await f.journal.jobStatus(execution.operationId)).toMatchObject({ status: 'known', receipt: { publication: 'failed' } })
    await f.journal.close()
    f.journal = await RemoteOperationJournal.open(f.journalPath)
    await expect(f.journal.assertRuntimeQuiescent()).resolves.toBeUndefined()
    await f.journal.jobReserveProcess(execution.operationId, { launchId: randomUUID(), binary: '/usr/bin/podman', argv: ['container', 'exists'] })
    await expect(f.journal.assertRuntimeQuiescent()).rejects.toThrow('unfinished work')
  } finally { await f.journal.close() }
})

async function fixture(location: 'main' | 'device') {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'verification-publication-'))
  directories.push(directory)
  const parent = join(directory, 'materialization')
  const root = join(parent, 'tree')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const f = verificationRuntimeFixture()
  const createdAt = new Date(Date.now() - 1000).toISOString()
  const target = structuredClone(f.spec.target)
  target.destination.canonicalProjectRoot = root
  target.destination.canonicalCwd = root
  if (location === 'device') {
    target.hostRef = { kind: 'device', mainId: target.mainId, deviceId: randomUUID() }
    target.registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  }
  const policy = { ...f.spec.policy, maxOutputBytes: 114688, publicationTimeoutMs: 60000, cleanupTimeoutMs: 60000 }
  const execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), operationId: randomUUID(), schemaVersion: 2, createdAt,
    acceptedSpec: { ...f.spec, target, policy, lifecycle: verificationJobLifecycle(createdAt, policy),
      outputs: [
        { path: '.logs/verification/summary.json', mediaType: 'application/json', kind: 'suite-summary', maxBytes: 16384, required: true },
        { path: '.logs/verification/junit.xml', mediaType: 'application/xml', kind: 'junit', maxBytes: 16384, required: true },
        { path: '.logs/verification/vitest.json', mediaType: 'application/json', kind: 'vitest-json', maxBytes: 16384, required: true },
        { path: '.logs/verification/logs.tar.gz', mediaType: 'application/gzip', kind: 'logs-archive', maxBytes: 65536, required: true },
      ] } })
  const spec = execution.acceptedSpec
  const context = JobVerificationRepositoryContextSchema.parse({
    requiredPortions: [{ key: 'root:test', kind: 'node', files: ['observed.test.mjs'] }], identity: {
    commit: spec.source.commit, manifestDigest: spec.source.manifestDigest, definitionVersionId: spec.definitionVersionId,
    suite: spec.verification.suite, executionId: execution.id, attemptId: execution.attemptId,
    target: spec.target, profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
  }, privateGit: { sourceCommit: spec.source.commit, generatedCommit: 'c'.repeat(40),
    repositoryReceiptDigest: 'a'.repeat(64), configDigest: 'a'.repeat(64), indexDigest: 'a'.repeat(64) },
  executionTimeoutMs: spec.policy.executionTimeoutMs, cancellationTimeoutMs: spec.policy.cancellationGraceMs,
  qualifiedUnitWorkers: 1, limits: { summaryBytes: 16384, junitBytes: 16384, vitestBytes: 16384,
    logsArchiveBytes: 65536, logBytes: 4096 }, mutableDirectory: '/job-scratch', storeDirectory: '/job-scratch/pnpm-store',
  preseedReceipt: { lockfileSha256: 'a'.repeat(64), pnpmVersion: '11.27.0', platform: 'linux', architecture: 'x64',
    provenanceDigest: 'a'.repeat(64), minimumReleaseAgeMinutes: 2880, releaseAgeVerified: true } })
  const journalPath = join(directory, 'journal')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  const intent: RemoteJobDispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: target.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: spec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
    bindingHash: spec.bindingHash, inputDigest: `sha256:${spec.specDigest}`, owner: execution.owner }
  const connection = target.hostRef.kind === 'main'
    ? { kind: 'main' as const, mainId: target.mainId, mainInstallationId: target.mainInstallationId, bootId: bootIdentity() }
    : { mainId: target.mainId, deviceId: target.hostRef.deviceId, ...target.registration!, bootId: bootIdentity(),
      connectionGeneration: 1, connectionEpoch: randomUUID() }
  await journal.jobAccept(intent, execution, connection, randomUUID())
  const reserve = await reserveVerificationReportSpace(execution)
  await journal.jobPrepareVerification(execution.operationId, { context, reserve, finalizedAt: null,
    contextPin: { relativePath: 'verification.json', sha256: 'a'.repeat(64), byteSize: 100 } })
  await journal.jobReserveEntry(execution.operationId)
  await journal.jobAcknowledgeLaunch(execution.operationId, { containerId: 'a'.repeat(64),
    supervisorIdentity: 'original-supervisor', processIdentityDigest: 'a'.repeat(64), startedAt: createdAt })
  const terminal: RemoteJobTerminalEvidence = { finishedAt: new Date().toISOString(), outcome: 'timed_out',
    exitCode: 124, signal: null, processStopped: true, closureEvidenceDigest: 'a'.repeat(64), resultDigest: 'a'.repeat(64),
    logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [] }
  await journal.jobTerminal(execution.operationId, terminal)
  const reports = join(root, '.logs/verification')
  const parts = join(reports, 'parts')
  await mkdir(parts, { mode: 0o700 })
  await writeFile(join(parts, 'state.json'), JSON.stringify({ identity: context.identity, startedAt: createdAt,
    expected: [{ key: 'root:test', kind: 'node' }] }))
  await writeFile(join(parts, 'root_test.inventory.json'), JSON.stringify(['observed.test.mjs']))
  await writeFile(join(parts, 'root_test.node.ndjson'), JSON.stringify({ type: 'test:pass',
    file: '/workspace/observed.test.mjs', name: 'observed pass', testType: 'test', duration: 1 }) + '\n')
  await mkdir(join(parent, 'job-scratch'), { mode: 0o700 })
  await writeFile(join(parent, 'job-scratch/cache'), 'discardable closed workload cache')
  return { directory, root, reports, execution, journalPath, journal, reserve, terminal }
}

describe('trusted verification publication after interruption', () => {
  it.each(['main', 'device'] as const)('finalizes retained portions on %s and replays unchanged after restart', async location => {
    const f = await fixture(location)
    try {
      await createVerificationPublication(f.journal)(f.execution, f.terminal)
      const bytes = await readFile(join(f.reports, 'summary.json'))
      const summary = JobVerificationReportSchema.parse(JSON.parse(bytes.toString('utf8')))
      expect(summary).toMatchObject({ executionId: f.execution.id, attemptId: f.execution.attemptId,
        outcome: 'timed_out', completeness: 'partial', finishedAt: f.terminal.finishedAt,
        totals: { total: 1, passed: 1, failed: 0, skipped: 0 } })
      for (const name of ['junit.xml', 'vitest.json', 'logs.tar.gz']) {
        expect((await readFile(join(f.reports, name))).length).toBeGreaterThan(0)
      }
      await expect(readFile(join(f.reserve.parent, f.reserve.name))).rejects.toMatchObject({ code: 'ENOENT' })
      await f.journal.close()
      f.journal = await RemoteOperationJournal.open(f.journalPath)
      await createVerificationPublication(f.journal)(f.execution, f.terminal)
      expect(hash(await readFile(join(f.reports, 'summary.json')))).toBe(hash(bytes))
    } finally { await f.journal.close() }
  })
  it.each(['commands', 'files', 'summary'] as const)('cannot credit a workload-replaced %s inventory after restart', async change => {
    const f = await fixture('main')
    try {
      const parts = join(f.reports, 'parts')
      if (change === 'commands') {
        await writeFile(join(parts, 'state.json'), JSON.stringify({
          identity: (await f.journal.jobNativeOwner(f.execution.operationId))!.verification!.context.identity,
          startedAt: f.execution.createdAt, expected: [{ key: 'fake', kind: 'command' }],
        }))
        await writeFile(join(parts, 'fake.command.json'), JSON.stringify({ key: 'fake', code: 0,
          startedAt: f.execution.createdAt, finishedAt: f.terminal.finishedAt }))
      }
      if (change === 'files') {
        await writeFile(join(parts, 'root_test.inventory.json'), JSON.stringify(['fake.test.mjs']))
        await writeFile(join(parts, 'root_test.node.ndjson'), JSON.stringify({ type: 'test:pass',
          file: '/workspace/fake.test.mjs', name: 'fake pass', testType: 'test', duration: 1 }) + '\n')
      }
      if (change === 'summary') {
        const context = (await f.journal.jobNativeOwner(f.execution.operationId))!.verification!.context
        await writeFile(join(f.reports, 'summary.json'), JSON.stringify({ schemaVersion: 1, ...context.identity,
          startedAt: f.execution.createdAt, finishedAt: f.terminal.finishedAt,
          totals: { total: 1, passed: 1, failed: 0, skipped: 0 }, firstPassFailed: 0,
          expectedPortions: 1, completedPortions: 1, disallowedSkipped: 0, completeness: 'complete', outcome: 'passed' }))
      }
      await f.journal.close()
      f.journal = await RemoteOperationJournal.open(f.journalPath)
      await createVerificationPublication(f.journal)(f.execution, { ...f.terminal, outcome: 'succeeded', exitCode: 0 })
      const report = JobVerificationReportSchema.parse(JSON.parse(await readFile(join(f.reports, 'summary.json'), 'utf8')))
      expect(report.outcome).toBe('incomplete')
      expect(report.completeness).toBe('partial')
      expect(report.completedPortions).toBe(0)
    } finally { await f.journal.close() }
  })
  it('retains original absolute deadlines through restart and refuses new publication work after expiry', async () => {
    const f = await fixture('main')
    try {
      const expired = VerificationJobExecutionSchema.parse({ ...f.execution, acceptedSpec: {
        ...f.execution.acceptedSpec, lifecycle: verificationJobLifecycle(new Date(0).toISOString(), f.execution.acceptedSpec.policy),
      } })
      expect(jobLifecycleSignal(expired, 'publication').aborted).toBe(true)
      expect(jobLifecycleSignal(expired, 'cleanup').aborted).toBe(true)
      await expect(createVerificationPublication(f.journal)(expired, f.terminal)).rejects.toThrow('deadline expired')
      expect((await f.journal.jobNativeOwner(f.execution.operationId))?.verification?.finalizedAt).toBeNull()
      expect((await readFile(join(f.reserve.parent, f.reserve.name))).length).toBe(f.reserve.bytes)
    } finally { await f.journal.close() }
  })
})

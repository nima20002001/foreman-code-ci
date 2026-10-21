import { DomainError } from '../errors.js'
import { readBoundedJobFile } from './executorOutputs.js'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT, type VerifiedJobGitMounts } from './privateGitMounts.js'
import { createHash } from 'node:crypto'
import { JOB_INPUT_DIRECTORY,type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest } from '@foreman-code/contracts/job-inputs-node'
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { JobDefinition, ResolvedJobDefinitionSpec, JobExecution, RunInput } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { JobExecutionSchema } from '@foreman-code/contracts/jobs'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { JobPreparationService, type JobPreparationSources } from './preparation.js'
import { JobService } from './service.js'
import type { JobSql } from './repository.js'
import type { JobDispatchPort } from './ports.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import {
  executeJob,
  executeVerificationJob,
  type VerificationJobExecutorPorts,
  jobSpecDigests,
  jobSupervisorIdentity,
  type JobExecutorPorts,
  type JobSupervisedProcess,
  type QualifiedJobProfile,
} from './executor.js'
import { podmanCreateArgv } from './executorPodman.js'
import {
  readDeclaredJobOutputs,
  readAvailableVerificationOutputs,
  reserveVerificationReportSpace,
  writeVerificationInterruptionReport,
} from './executorOutputs.js'
import { AcceptedVerificationJobSpecSchema, VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import type { RemoteJobTerminalEvidence } from '@foreman-code/contracts/remote-job-execution'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'

const id = '00000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
const profile: QualifiedJobProfile = { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT, policyId: id, policyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest,
  runtimeVersion: 'qualified-test', ociRuntimeVersion: 'qualified-test', kernelVersion: 'qualified-test', qualificationId: id,
  rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none',
  cpuLimit: 1, memoryBytes: 1024, pidsLimit: 64, diskBytes: 1024 }

describe('verification interruption reports with real private files, no container qualification', () => {
  it.each(['cancelled', 'timed_out'] as const)('publishes an honest partial summary after %s and reuses its original reserve', async outcome => {
    const root = await mkdtemp(join(tmpdir(), 'verification-report-'))
    try {
      await chmod(root, 0o700)
      const source = join(root, 'tree')
      await mkdir(source, { mode: 0o700 })
      const f = verificationFixture()
      const raw = execution()
      const job = VerificationJobExecutionSchema.parse({ ...raw, schemaVersion: 2,
        acceptedSpec: { ...f.acceptedBuild, ...f.spec, schemaVersion: 2,
          source: f.acceptedBuild.source, profile: f.profile, reservationId: id, lifecycle: f.lifecycle,
          resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
          target: { ...f.spec.target, destination: { ...f.spec.target.destination,
            canonicalProjectRoot: source, canonicalCwd: source } } } })
      const reserve = await reserveVerificationReportSpace(job)
      expect(await reserveVerificationReportSpace(job)).toEqual(reserve)
      const terminal: RemoteJobTerminalEvidence = { outcome, finishedAt: '2026-10-04T12:01:00.000Z',
        processStopped: true, exitCode: null, signal: 'SIGKILL', closureEvidenceDigest: digest, resultDigest: digest,
        logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [] }
      await writeVerificationInterruptionReport({ execution: job, reserve, terminal })
      const outputs = await readDeclaredJobOutputs(source, job.acceptedSpec)
      expect(outputs).toHaveLength(1)
      const report = JSON.parse(outputs[0]!.bytes.toString('utf8'))
      expect(report).toMatchObject({ outcome, completeness: 'partial', completedPortions: 0,
        executionId: job.id, attemptId: job.attemptId, commit: job.acceptedSpec.source.commit,
        totals: { total: 0, passed: 0, failed: 0, skipped: 0 } })
      await expect(readFile(join(reserve.parent, reserve.name))).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await stat(join(source, job.acceptedSpec.outputs[0]!.path))).ino).toBe(reserve.inode)
      await writeVerificationInterruptionReport({ execution: job, reserve, terminal })
      expect(await readDeclaredJobOutputs(source, job.acceptedSpec)).toEqual(outputs)
      const incomplete = AcceptedVerificationJobSpecSchema.parse({ ...job.acceptedSpec,
        policy: { ...job.acceptedSpec.policy, maxOutputBytes: 5120 },
        outputs: [...job.acceptedSpec.outputs, { path: 'reports/logs.tar.gz', required: true,
          mediaType: 'application/gzip', kind: 'logs-archive', maxBytes: 1024 }] })
      await expect(readDeclaredJobOutputs(source, incomplete)).rejects.toThrow()
      expect(await readAvailableVerificationOutputs(source, incomplete)).toEqual(outputs)
      await writeFile(join(source, 'reports/logs.tar.gz'), Buffer.alloc(1025))
      await expect(readDeclaredJobOutputs(source, incomplete)).rejects.toThrow('budget rejected')
      expect(await readAvailableVerificationOutputs(source, incomplete)).toEqual(outputs)
      await rm(join(source, 'reports/logs.tar.gz'))
      await symlink('/etc/passwd', join(source, 'reports/logs.tar.gz'))
      await expect(readDeclaredJobOutputs(source, incomplete)).rejects.toThrow()
      expect(await readAvailableVerificationOutputs(source, incomplete)).toEqual(outputs)
      await expect(writeVerificationInterruptionReport({ execution: job, reserve,
        terminal: { ...terminal, processStopped: false } as unknown as RemoteJobTerminalEvidence })).rejects.toThrow('confirmed closed')
      await expect(writeVerificationInterruptionReport({ execution: job,
        reserve: { ...reserve, inode: reserve.inode + 1 }, terminal })).rejects.toThrow('could not be written')
      const reportPath = join(source, job.acceptedSpec.outputs[0]!.path)
      await rm(reportPath)
      await symlink('/etc/passwd', reportPath)
      await expect(writeVerificationInterruptionReport({ execution: job, reserve, terminal })).rejects.toThrow('could not be written')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps required per-report limits on the existing output collector', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verification-output-'))
    try {
      const f = verificationFixture()
      await mkdir(join(root, 'reports'))
      await writeFile(join(root, 'reports/summary.json'), Buffer.alloc(4097))
      const spec = AcceptedVerificationJobSpecSchema.parse({ ...f.acceptedBuild, ...f.spec,
        schemaVersion: 2, source: f.acceptedBuild.source, profile: f.profile, reservationId: id, lifecycle: f.lifecycle,
        resourcePolicyRevision: 1, resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1 })
      await expect(readDeclaredJobOutputs(root, spec)).rejects.toThrow('budget rejected')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
function execution(): JobExecution {
  const job: JobExecution = { schemaVersion: 1, id, workspaceId: id, operationId: id, attemptId: id, owner: { grantId: id, epoch: '1' }, workflow: null,
    process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false }, transport: 'connected', publication: 'pending',
    cancelRequestedAt: null, startedAt: null, finishedAt: null, lastSeenAt: null, resultIssue: null,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', acceptedSpec: {
      workflowInput: null, definitionId: id, definitionRevision: 1, definitionVersionId: id, scriptDigest: digest, outputSpecDigest: digest, specDigest: digest, bindingHash: digest,
      source: { approvedSourceId: id, snapshotId: id, commit: 'a'.repeat(40), manifestDigest: digest, materializationId: id, materializationDigest: digest },
      target: { schemaVersion: 1, mainId: id, hostRef: { kind: 'main', mainId: id }, registration: null, mainInstallationId: id,
        destination: { canonicalProjectRoot: `/private/${id}/tree`, canonicalCwd: `/private/${id}/tree`, managedRuntimeRoot: '/private/runtime', directoryIdentityHash: digest,
          rootPolicyId: id, rootPolicyRevision: '1', locationRevision: '1', attestationId: id, attestationHash: digest } },
      argv: ['node', 'fixture.mjs', '$(touch /escape); &'], inputs: [], outputs: [],
      policy: { isolationPolicyId: id, isolationPolicyRevision: 1, imageDigest: `sha256:${digest}`, toolchainDigest: digest, environmentScopeRefs: [], network: 'none',
        queueTimeoutMs: 10000, preparationTimeoutMs: 1000, executionTimeoutMs: 1000, cancellationGraceMs: 1, maxLogChunkBytes: 8,
        maxLogBytes: 1024, maxWorkerSpoolBytes: 1024, logOverflow: 'stop', maxOutputBytes: 1024, retentionSeconds: 3600 } } }
  repin(job)
  return job
}
function repin(job: JobExecution) {
  const { source, target, argv, inputs, policy, outputs, relativeCwd, workflowInput } = job.acceptedSpec
  Object.assign(job.acceptedSpec, jobSpecDigests({ source, target, argv, inputs, policy, outputs, ...(relativeCwd ? { relativeCwd } : {}) }, workflowInput))
}
async function* chunks(value = '') { if (value) yield Buffer.from(value) }
/** Trusted input adapter double for executor-only tests. Real copied bytes and
 * inode checks are independently exercised in job-input-consumer.test.ts. */
function inputReceipt(execution:JobExecution):JobInputDeliveryReceipt {
  const spec=execution.acceptedSpec,workflow=Buffer.from(JSON.stringify(spec.workflowInput)),manifest=Buffer.from(JSON.stringify({version:1,inputSnapshotDigest:jobInputSnapshotDigest(execution),workflowInput:spec.workflowInput,files:spec.inputs.map(input=>({relativePath:`files/${input.path}`,fileId:input.fileId,revisionId:input.revisionId,sha256:input.sha256,byteSize:input.byteSize}))}))
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
  return {version:1,bindingId:'9'.repeat(64),recipient:{workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,bindingHash:spec.bindingHash,specDigest:spec.specDigest,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest},inputSnapshotDigest:jobInputSnapshotDigest(execution),manifestSha256:hash(manifest),manifestByteSize:manifest.length,directory:{relativePath:JOB_INPUT_DIRECTORY,device:'1',inode:'2',mountId:'3'},files:[{relativePath:'manifest.json',sha256:hash(manifest),byteSize:manifest.length},{relativePath:'workflow-input.json',sha256:hash(workflow),byteSize:workflow.length},...spec.inputs.map(input=>({relativePath:`files/${input.path}`,sha256:input.sha256,byteSize:input.byteSize}))],readonlyMountRequired:true}
}
function ports(exit: { exitCode: number | null; signal: string | null; execError?: string; timedOut?: boolean } = { exitCode: 0, signal: null }): JobExecutorPorts {
  let current:JobExecution|undefined
  const process: JobSupervisedProcess = { stdout: chunks('stdout'), stderr: chunks('stderr'), exited: Promise.resolve(exit),
    stop: vi.fn(async () => true), proveStopped: vi.fn(async () => true) }
  return { authority: { recheck: vi.fn(async execution=>{current=execution}), claim: vi.fn(async () => 'launch' as const), launched: vi.fn(async () => {}) },
    inputs:{prepare:vi.fn(async execution=>inputReceipt(execution))},
    source: { verify: vi.fn(async spec => ({ privateRepositoryRoot: spec.target.destination.canonicalProjectRoot, directoryIdentityHash: spec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1024,gitMounts:mountFixture(current!) })) },
    supervisor: { qualifiedProfile: profile, launch: vi.fn(async () => process) }, appendLog: vi.fn(async () => {}), collectOutputs: vi.fn(async () => {}) }
}

async function admit(workflowInput: RunInput | null) {
  const fixture = execution()
  const { source, target, argv, policy, outputs } = fixture.acceptedSpec
  const selectedSource = { approvedSourceId: source.approvedSourceId, snapshotId: source.snapshotId, commit: source.commit, manifestDigest: source.manifestDigest }
  const definition: JobDefinition & { spec: ResolvedJobDefinitionSpec } = { schemaVersion: 1, id, workspaceId: id, name: 'Accepted producer fixture', revision: 1, versionId: id,
    createdAt: fixture.createdAt, updatedAt: fixture.updatedAt, spec: { source: selectedSource, target: structuredClone(target), argv, policy, outputs,
      relativeCwd: 'build', inputs: [{ path: 'inputs/config.json', fileId: id, revisionId: id, sha256: digest, byteSize: 12 }] } }
  definition.spec.target.destination.canonicalCwd = `/private/${id}/tree/build`
  const principal = ManagementPrincipalSchema.parse({ id, name: 'Accepted node actor', audience: 'operator',
    grants: [{ actions: ['runs:start'], scope: { workspaceIds: [id] } }], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null })
  const query = vi.fn<JobSql['query']>(async () => ({ command: 'INSERT', rowCount: 1, oid: 0, fields: [], rows: [] }))
  const sql = { query } as unknown as JobSql
  const materialize = vi.fn<JobPreparationSources['materialize']>(async (_sql, _principal, _workspaceId, spec, identity) => ({ ...spec,
    target:{...spec.target,destination:{...spec.target.destination,canonicalProjectRoot:`/private/${identity.executionId}/tree`,canonicalCwd:`/private/${identity.executionId}/tree${spec.relativeCwd?'/'+spec.relativeCwd:''}`}},source: { ...spec.source, materializationId: identity.executionId, materializationDigest: digest } }))
  const adoptFinalBinding = vi.fn(async () => {})
  const preparation = new JobPreparationService({
    revalidateAccepted:async()=>{},
    choices: async () => ({ targets: [{ id, label: 'Approved main', target: definition.spec.target, ready: true, reasons: [] }],
      sources: [definition.spec.source], policies: [definition.spec.policy] }), materialize, adoptFinalBinding,
  })
  const accept = vi.fn<JobDispatchPort['accept']>(async (_sql, input) => ({ operationId: input.operationId, attemptId: input.attemptId, owner: { grantId: id, epoch: '1' } }))
  const service = new JobService({} as pg.Pool, {} as PostgresCommandCoordinator,
    { preparation, dispatch: { accept, cancelForRunCleanup:async()=>{throw new Error('No Run cleanup in this admission fixture')}, cancel: async () => {}, wake: async () => {} }, artifacts: { read: vi.fn(), list: async () => [] } })
  const workflow = workflowInput === null ? null : { workflowId: id, runId: id, nodeId: id, nodeExecutionId: id }
  const job = JobExecutionSchema.parse(await service.admit(sql, principal, definition, workflow, workflowInput))
  return { job, definition, query, materialize, adoptFinalBinding, accept }
}

describe('real main admission to worker executor contract (SQL/source/supervisor doubles)', () => {
  it('executes the unchanged published CI-B manual receipt', async () => {
    const job = jobExecution(), p = ports(), spec = job.acceptedSpec
    spec.target.destination.canonicalProjectRoot=`/approved/${spec.source.materializationId}/tree`;spec.target.destination.canonicalCwd=spec.target.destination.canonicalProjectRoot;repin(job)
    p.supervisor.qualifiedProfile = { ...profile, policyId: spec.policy.isolationPolicyId, imageDigest: spec.policy.imageDigest,
      toolchainDigest: spec.policy.toolchainDigest, diskBytes: 4096 }
    p.source.verify = vi.fn(async () => ({ privateRepositoryRoot: spec.target.destination.canonicalProjectRoot,
      directoryIdentityHash: spec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1024,gitMounts:mountFixture(job) }))
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('succeeded')
    expect(p.supervisor.launch).toHaveBeenCalledOnce()
  })
  it.each([null, { request: { text: 'Build the accepted revision', parameters: [1, true, null] } },
    { z: { 'a!': 1, Z: 2, a: 3, A: 4 }, '9': 'numeric key', '!': 'punctuation' }])(
    'executes real preparation/admission with exact manual/workflow input %j', async workflowInput => {
      const accepted = await admit(workflowInput), p = ports()
      expect(accepted.job.acceptedSpec.workflowInput).toEqual(workflowInput)
      expect(accepted.materialize.mock.calls[0]![4]).toEqual({ executionId: accepted.job.id,
        attemptId: accepted.job.attemptId, operationId: accepted.job.operationId })
      expect(accepted.query).toHaveBeenCalledOnce()
      const persisted = JSON.parse(accepted.query.mock.calls[0]![1]![6] as string)
      expect(persisted).toEqual(accepted.job.acceptedSpec)
      expect(accepted.adoptFinalBinding).toHaveBeenCalledWith(expect.anything(), expect.anything(), accepted.job)
      expect((await executeJob(accepted.job, p, new AbortController().signal)).outcome).toBe('succeeded')
      expect(p.source.verify).toHaveBeenCalledWith(accepted.job.acceptedSpec, expect.any(AbortSignal))
      const plan = vi.mocked(p.supervisor.launch).mock.calls[0]![0]
      expect(plan.execution.acceptedSpec).toEqual(persisted)
      expect(plan.cwd).toBe(`${accepted.job.acceptedSpec.target.destination.canonicalProjectRoot}/build`)
      expect(plan.execution.acceptedSpec.inputs[0]!.path).toBe('inputs/config.json')
    })
  it('denies a private Git boolean without original mount metadata before inputs or native claim', async () => {
    const job = execution(), p = ports()
    p.source.verify = vi.fn(async spec => ({ privateRepositoryRoot: spec.target.destination.canonicalProjectRoot,
      directoryIdentityHash: spec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1024 }))
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.inputs.prepare).not.toHaveBeenCalled()
    expect(p.authority.claim).not.toHaveBeenCalled()
    expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it('denies refused immutable input delivery before native claim',async()=>{
    const job=execution(),p=ports();p.inputs.prepare=vi.fn(async()=>{throw new DomainError('ACCESS_DENIED', 'Exact file scope denied', 403)})
    expect((await executeJob(job,p,new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.authority.claim).not.toHaveBeenCalled();expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it('denies switched input receipts before native claim',async()=>{
    const job=execution(),p=ports();p.inputs.prepare=vi.fn(async()=>({...inputReceipt(job),recipient:{...inputReceipt(job).recipient,operationId:'switched'}}))
    expect((await executeJob(job,p,new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.authority.claim).not.toHaveBeenCalled();expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it('rejects differing Run input before any source verification or launch claim', async () => {
    const { job } = await admit({ request: 'accepted' }), p = ports()
    job.acceptedSpec.workflowInput = { request: 'different' }
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.authority.recheck).not.toHaveBeenCalled()
    expect(p.source.verify).not.toHaveBeenCalled()
    expect(p.authority.claim).not.toHaveBeenCalled()
    expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it.each(['path', 'revisionId', 'sha256', 'byteSize'] as const)('rejects changed immutable file input %s', async field => {
    const { job } = await admit(null), p = ports(), input = job.acceptedSpec.inputs[0]!
    if (field === 'byteSize') input.byteSize++
    else input[field] = field === 'sha256' ? 'b'.repeat(64) : 'changed'
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.source.verify).not.toHaveBeenCalled()
    expect(p.authority.claim).not.toHaveBeenCalled()
  })
  it.each([null, { request: 'accepted' }])('rejects inconsistent manual/workflow binding even with recomputed digests %j', async workflowInput => {
    const { job } = await admit(workflowInput), p = ports()
    job.acceptedSpec.workflowInput = workflowInput === null ? {} : null
    repin(job)
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.authority.claim).not.toHaveBeenCalled()
  })
  it('rejects missing accepted workflow input instead of applying a compatibility default', async () => {
    const { job } = await admit({ request: 'accepted' }), p = ports()
    const missing = structuredClone(job) as unknown as { acceptedSpec: Record<string, unknown> }
    delete missing.acceptedSpec.workflowInput
    await expect(executeJob(missing as unknown as JobExecution, p, new AbortController().signal)).rejects.toThrow()
    expect(p.authority.claim).not.toHaveBeenCalled()
  })
  it('still requires source authority for the accepted immutable inputs', async () => {
    const { job } = await admit({ request: 'accepted' }), p = ports()
    p.source.verify = vi.fn(async () => { throw new DomainError('SOURCE_IDENTITY_MISMATCH', 'Pinned input bytes unavailable', 409) })
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.source.verify).toHaveBeenCalledOnce()
    expect(p.authority.claim).not.toHaveBeenCalled()
    expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
})

describe('noninteractive worker job executor (supervisor doubles, not live isolation proof)', () => {
  it('preserves argv and closes stdin without inherited credentials', async () => {
    const p = ports()
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result.outcome).toBe('succeeded')
    const plan = vi.mocked(p.supervisor.launch).mock.calls[0]![0]
    expect(plan.argv[2]).toBe('$(touch /escape); &')
    expect(plan.environment).toEqual({ HOME: '/tmp/job-home', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', CI: '1',...JOB_GIT_ENVIRONMENT,FOREMAN_CODE_JOB_INPUT_MANIFEST:'/workspace/.graphql-job-inputs/manifest.json',GRAPHQL_JOB_INPUT_MANIFEST:'/workspace/.graphql-job-inputs/manifest.json' })
    expect(plan.stdin).toBe('closed')
    expect(plan.pty).toBe(false)
    const argv = podmanCreateArgv(plan)
    expect(argv).toContain('--network=none')
    expect(argv).toContain('--pull=never')
    expect(argv.at(-1)).toBe('$(touch /escape); &')
  })
  it.each([[{ exitCode: 7, signal: null }, 'build_failed'], [{ exitCode: null, signal: null, execError: 'ENOENT' }, 'spawn_failed']] as const)('distinguishes exec failure from exit7', async (exit, outcome) => {
    expect((await executeJob(execution(), ports(exit), new AbortController().signal)).outcome).toBe(outcome)
  })
  it('fails closed on unavailable isolation or changed root before any claim/spawn', async () => {
    for (const rootChanged of [false, true]) {
      const p = ports()
      if (rootChanged) p.source.verify = async () => ({ privateRepositoryRoot: '/other', directoryIdentityHash: digest, privateGit: true, diskQuotaBytes: 1024 })
      else p.supervisor.qualifiedProfile = null
      expect((await executeJob(execution(), p, new AbortController().signal)).outcome).toBe('preparation_failed')
      expect(p.authority.claim).not.toHaveBeenCalled()
      expect(p.supervisor.launch).not.toHaveBeenCalled()
    }
  })
  it('queued cancellation produces zero spawn', async () => {
    const p = ports(); const cancel = new AbortController(); cancel.abort()
    expect((await executeJob(execution(), p, cancel.signal)).outcome).toBe('cancelled')
    expect(p.supervisor.launch).not.toHaveBeenCalled()
  })
  it('running cancellation settles only after the supervisor confirms descendant closure', async () => {
    const p = ports(); const cancel = new AbortController(); const proof: string[] = []
    let finish!: (exit: { exitCode: number | null; signal: string | null }) => void
    p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: new Promise(resolve => { finish = resolve }), proveStopped: async () => false,
      stop: async () => { proof.push('TERM', 'KILL', 'container-descendants-empty'); finish({ exitCode: null, signal: 'SIGKILL' }); return true } })
    p.authority.launched = async () => { cancel.abort() }
    p.collectOutputs = async () => { expect(proof).toContain('container-descendants-empty') }
    expect(await executeJob(execution(), p, cancel.signal)).toMatchObject({ outcome: 'cancelled', processStopped: true })
  })
  it('bounded cancellation closes even when the exit transport never replies', async () => {
    const p = ports(), cancel = new AbortController()
    p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: new Promise(() => {}), proveStopped: async () => true, stop: async () => true })
    p.authority.launched = async () => { cancel.abort() }
    expect(await executeJob(execution(), p, cancel.signal)).toMatchObject({ outcome: 'cancelled', processStopped: true, exitCode: null })
  })
  it('rejects accepted argv tampering and stale launch authority without spawning', async () => {
    const p = ports(); const job = execution(); job.acceptedSpec.argv.push('changed')
    expect((await executeJob(job, p, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(p.supervisor.launch).not.toHaveBeenCalled()
    const denied = ports(); denied.authority.recheck = async () => { throw new DomainError('AUTH_REVOKED', 'stale owner', 401) }
    expect((await executeJob(execution(), denied, new AbortController().signal)).outcome).toBe('preparation_failed')
    expect(denied.authority.claim).not.toHaveBeenCalled()
  })
  it.each(['source', 'inputs'] as const)(
    'joins an abort-ignoring %s producer before confirming preparation closure', async stage => {
      const p = ports()
      const job = execution()
      const cancel = new AbortController()
      let release!: () => void
      let began!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<void>(resolve => { began = resolve })
      const originalSource = p.source.verify
      const originalInputs = p.inputs.prepare
      if (stage === 'source') {
        p.source.verify = async (spec, signal) => {
          began()
          await gate
          return originalSource(spec, signal)
        }
      } else {
        p.inputs.prepare = async (current, source, signal) => {
          began()
          await gate
          return originalInputs(current, source, signal)
        }
      }
      vi.useFakeTimers()
      let settled = false
      const executing = executeJob(job, p, cancel.signal).then(result => {
        settled = true
        return result
      })
      try {
        await started
        await vi.advanceTimersByTimeAsync(job.acceptedSpec.policy.preparationTimeoutMs)
        expect(settled).toBe(false)
        expect(p.authority.claim).not.toHaveBeenCalled()
        release()
        expect(await executing).toMatchObject({ outcome: 'preparation_failed', processStopped: true })
        expect(p.supervisor.launch).not.toHaveBeenCalled()
      } finally {
        release()
        await executing
        vi.useRealTimers()
      }
    },
  )
  it('does not rewrite a natural exit when cancellation arrives after observed completion', async () => {
    const p = ports(); const cancel = new AbortController()
    p.authority.launched = async () => { await Promise.resolve(); cancel.abort() }
    expect((await executeJob(execution(), p, cancel.signal)).outcome).toBe('succeeded')
  })
  it('preserves UTF8 split across pipe chunks and exact serialized byte sizes', async () => {
    const p = ports()
    async function* unicode() { yield Buffer.from([0xf0, 0x9f]); yield Buffer.from([0x98, 0x80]) }
    p.supervisor.launch = async () => ({ stdout: unicode(), stderr: chunks(), exited: Promise.resolve({ exitCode: 0, signal: null }), stop: async () => true, proveStopped: async () => true })
    await executeJob(execution(), p, new AbortController().signal)
    expect(vi.mocked(p.appendLog).mock.calls.map(([chunk]) => chunk.text).join('')).toBe('😀')
    expect(vi.mocked(p.appendLog).mock.calls[0]![0].byteSize).toBe(4)
  })
  it('explicit truncation caps persisted logs without silently losing their status', async () => {
    const p = ports(); const job = execution(); job.acceptedSpec.policy.maxLogBytes = 4; job.acceptedSpec.policy.logOverflow = 'explicit-truncation'; repin(job)
    const result = await executeJob(job, p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'succeeded', logsTruncated: true })
    expect(p.appendLog).not.toHaveBeenCalled()
  })
  it('duplicate dispatch or restart requires reconciliation and never launches again', async () => {
    const p = ports(); p.authority.claim = async () => 'reconcile'
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result.recoveryRequired).toBe(true)
    expect(result.processStopped).toBe(false)
    expect(p.supervisor.launch).not.toHaveBeenCalled()
    expect(jobSupervisorIdentity(execution())).toBe(jobSupervisorIdentity(execution()))
  })
  it('lost launch acknowledgment preserves observed exit', async () => {
    const p = ports({ exitCode: 7, signal: null }); p.authority.launched = async () => { throw Error('offline') }
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'build_failed', exitCode: 7, recoveryRequired: true })
  })
  it('offline deadline requires descendant stop proof before terminal timeout', async () => {
    const p = ports(); const job = execution(); job.transport = 'offline'; job.acceptedSpec.policy.executionTimeoutMs = 5
    repin(job)
    let resolveExit!: (exit: { exitCode: number | null; signal: string | null }) => void
    p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: new Promise(resolve => { resolveExit = resolve }),
      stop: async () => { resolveExit({ exitCode: null, signal: 'SIGKILL' }); return false }, proveStopped: async () => false })
    const result = await executeJob(job, p, new AbortController().signal)
    expect(result).toMatchObject({ processStopped: false, outcome: null, recoveryRequired: true })
    expect(p.collectOutputs).not.toHaveBeenCalled()
  })
  it('retains a concrete supervisor deadline even if its watchdog wins the executor timer race', async () => {
    expect((await executeJob(execution(), ports({ exitCode: 143, signal: null, timedOut: true }), new AbortController().signal)).outcome).toBe('timed_out')
  })
  it('bounds logs and keeps exit outcome when spool/publication fail', async () => {
    const p = ports({ exitCode: 7, signal: null }); p.appendLog = async () => { throw Error('disk full') }
    p.collectOutputs = async () => { throw Error('output missing') }
    const result = await executeJob(execution(), p, new AbortController().signal)
    expect(result).toMatchObject({ outcome: 'build_failed', exitCode: 7, logError: true, outputCollectionError: true })
  })
  it('refuses escaped or unproven descendants after natural exit', async () => {
    const p = ports(); p.supervisor.launch = async () => ({ stdout: chunks(), stderr: chunks(), exited: Promise.resolve({ exitCode: 0, signal: null }),
      stop: async () => false, proveStopped: async () => false })
    expect(await executeJob(execution(), p, new AbortController().signal)).toMatchObject({ outcome: null, recoveryRequired: true, processStopped: false })
    expect(p.collectOutputs).not.toHaveBeenCalled()
  })
  it('refuses ancestor symlinks and oversized diagnostic files before returning bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'job-diagnostic-output-'))
    const source = join(directory, 'source')
    const outside = join(directory, 'outside')
    try {
      await mkdir(source)
      await mkdir(outside)
      await writeFile(join(outside, 'summary.json'), 'private controller state')
      await symlink(outside, join(source, 'reports'))
      await expect(readBoundedJobFile(source, 'reports/summary.json', 4096)).rejects.toThrow()
      await rm(join(source, 'reports'))
      await mkdir(join(source, 'reports'))
      await writeFile(join(source, 'reports/summary.json'), 'retained diagnostic')
      await expect(readBoundedJobFile(source, 'reports/summary.json', 3)).rejects.toThrow('byte budget')
      expect((await readBoundedJobFile(source, 'reports/summary.json', 4096)).toString()).toBe('retained diagnostic')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects output symlinks and enforces declared total bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'job-output-test-'))
    try {
      await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/result'), 'result'); await symlink('result', join(root, 'dist/link'))
      const spec = execution().acceptedSpec; spec.outputs = [{ path: 'dist/link', required: true, mediaType: 'text/plain' }]
      await expect(readDeclaredJobOutputs(root, spec)).rejects.toThrow()
      spec.outputs[0]!.path = 'dist/result'; spec.policy.maxOutputBytes = 3
      await expect(readDeclaredJobOutputs(root, spec)).rejects.toThrow('byte budget')
      spec.policy.maxOutputBytes = 20
      expect((await readDeclaredJobOutputs(root, spec))[0]!.bytes.toString()).toBe('result')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

// Structured source authority double; real receipt/inode guards are tested in sources/repository.test.ts.
function mountFixture(execution:JobExecution,filesystem={device:'1',inode:'2',mountId:'3'}):VerifiedJobGitMounts {
  const spec=execution.acceptedSpec,parent=dirname(spec.target.destination.canonicalProjectRoot),digest='a'.repeat(64)
  return {version:1,layout:JOB_PRIVATE_GIT_LAYOUT,workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,owner:execution.owner,specDigest:spec.specDigest,bindingHash:spec.bindingHash,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest,
    git:{directory:join(parent,'repository'),filesystem,generatedCommit:'4'.repeat(40),sourceCommit:spec.source.commit,repositoryReceiptDigest:digest,configDigest:digest,indexDigest:digest,mountpoint:filesystem},scheduler:{directory:join(parent,'job-heavy-jobs'),filesystem},receiptDigest:digest}
}

describe('Job preparation infrastructure retries', () => {
  it.each(['authority', 'source', 'inputs', 'outputs'] as const)(
    'retries transient %s preparation before native entry with the original Job', async stage => {
      const job = execution()
      const p = ports()
      p.prepareOutputs = vi.fn(async () => undefined)
      const failure = new DomainError('DEVICE_TRANSPORT_ERROR', 'Main is reconnecting', 503, { retryable: true })
      if (stage === 'authority') vi.mocked(p.authority.recheck).mockRejectedValueOnce(failure)
      if (stage === 'source') vi.mocked(p.source.verify).mockRejectedValueOnce(failure)
      if (stage === 'inputs') vi.mocked(p.inputs.prepare).mockRejectedValueOnce(failure)
      if (stage === 'outputs') vi.mocked(p.prepareOutputs).mockRejectedValueOnce(failure)
      const accepted = structuredClone(job)
      expect(await executeJob(job, p, new AbortController().signal)).toMatchObject({ outcome: 'succeeded' })
      expect(p.authority.claim).toHaveBeenCalledOnce()
      expect(p.supervisor.launch).toHaveBeenCalledOnce()
      expect(vi.mocked(p.supervisor.launch).mock.calls[0]![0].execution).toEqual(accepted)
    },
  )

  it('keeps an exhausted transient preparation cause retryable without native entry', async () => {
    const job = execution()
    const p = ports()
    const failure = new DomainError('DEVICE_TRANSPORT_ERROR', 'Main is unavailable', 503, { retryable: true })
    vi.mocked(p.authority.recheck).mockRejectedValue(failure)
    vi.useFakeTimers()
    try {
      const result = executeJob(job, p, new AbortController().signal)
        .then(value => ({ value }), error => ({ error }))
      await vi.advanceTimersByTimeAsync(job.acceptedSpec.policy.preparationTimeoutMs + 1)
      expect(await result).toEqual({ error: failure })
      expect(p.authority.claim).not.toHaveBeenCalled()
      expect(p.supervisor.launch).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('retries verification authority and spec reads before returning a confirmed denial', async () => {
    const f = verificationFixture()
    const job = VerificationJobExecutionSchema.parse({ ...execution(), schemaVersion: 2, acceptedSpec: {
      ...f.acceptedBuild, ...f.spec, schemaVersion: 2, source: f.acceptedBuild.source,
      profile: f.profile, reservationId: id, lifecycle: f.lifecycle, resourcePolicyRevision: 1,
      resourcePolicyDigest: digest, runtimeApprovalId: id, runtimeApprovalRevision: 1,
    } })
    const failure = new DomainError('DEVICE_TRANSPORT_ERROR', 'Main is reconnecting', 503, { retryable: true })
    const recheck = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const verifyAcceptedSpec = vi.fn().mockRejectedValueOnce(failure)
      .mockRejectedValue(new DomainError('ACCESS_DENIED', 'Spec authorization revoked', 403))
    const p = { ...ports(), authority: { ...ports().authority, recheck },
      verifyAcceptedSpec } as unknown as VerificationJobExecutorPorts
    expect(await executeVerificationJob(job, p, new AbortController().signal)).toMatchObject({ outcome: 'preparation_failed' })
    expect(recheck).toHaveBeenCalledTimes(2)
    expect(verifyAcceptedSpec).toHaveBeenCalledTimes(2)
    expect(p.authority.claim).not.toHaveBeenCalled()
  })
})

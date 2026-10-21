import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { prepareJobRepositoryFixture } from '../../../test/helpers/jobRepositoryFixture.js'
import { JOB_PRIVATE_GIT_LAYOUT, JOB_GIT_ENVIRONMENT } from './privateGitMounts.js'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { constants } from 'node:fs'
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JOB_INPUT_DIRECTORY, type JobInputDeliveryReceipt } from '@foreman-code/contracts/job-inputs'
import { jobInputSnapshotDigest } from '@foreman-code/contracts/job-inputs-node'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { identity } from '../sources/privateFilesystem.js'
import { jobSupervisorIdentity, type JobLaunchPlan, type QualifiedJobProfile } from './executor.js'
import { OwnedOCIContainer, type OCIContainerOwnership, type OCIHostCertificate } from './executorContainerOwner.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { PodmanJobSupervisor, podmanCreateArgv, type PodmanCommandRunner } from './executorPodman.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(exitCode=7) {
  const root = await privateFixtureDirectory('ci-oci-input-'); roots.push(root)
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot, { mode: 0o700 })
  const execution = jobExecution()
  execution.acceptedSpec.inputs = []
  execution.acceptedSpec.workflowInput = null
  execution.workflow = null
  const { sourceRoot, gitMounts } = await prepareJobRepositoryFixture(execution, root, runtimeRoot)
  const inputRoot = join(sourceRoot, JOB_INPUT_DIRECTORY)
  await mkdir(inputRoot, { mode: 0o700 })
  const inputsHandle = await open(inputRoot, constants.O_RDONLY | constants.O_DIRECTORY)
  const inputIdentity = await identity(inputsHandle)
  await inputsHandle.close()
  const digest = 'a'.repeat(64)
  const inputDigest = jobInputSnapshotDigest(execution)
  const files = [{ relativePath: 'manifest.json', bytes: Buffer.from(JSON.stringify({ version: 1, inputSnapshotDigest: inputDigest, workflowInput: null, files: [] })) }, { relativePath: 'workflow-input.json', bytes: Buffer.from('null') }]
  for (const file of files) await writeFile(join(inputRoot, file.relativePath), file.bytes, { mode: 0o444 })
  const spec = execution.acceptedSpec
  const receipt: JobInputDeliveryReceipt = { version: 1, recipient: { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, owner: { ...execution.owner }, bindingHash: spec.bindingHash, specDigest: spec.specDigest, materializationId: spec.source.materializationId, materializationDigest: spec.source.materializationDigest }, bindingId: digest, inputSnapshotDigest: inputDigest, manifestSha256: hash(files[0]!.bytes), manifestByteSize: files[0]!.bytes.length, directory: { relativePath: JOB_INPUT_DIRECTORY, ...inputIdentity }, files: files.map(file => ({ relativePath: file.relativePath, sha256: hash(file.bytes), byteSize: file.bytes.length })), readonlyMountRequired: true }
  const profile: QualifiedJobProfile = { workspaceLayout:JOB_PRIVATE_GIT_LAYOUT, policyId: spec.policy.isolationPolicyId, policyRevision: spec.policy.isolationPolicyRevision, imageDigest: spec.policy.imageDigest, toolchainDigest: spec.policy.toolchainDigest, qualificationId: 'unit-double', runtimeVersion: 'unit-double', ociRuntimeVersion: 'unit-double', kernelVersion: 'unit-double', rootless: true, cgroupV2: true, filesystemBounded: true, descendantContainment: true, network: 'none', cpuLimit: 1, memoryBytes: 1024, pidsLimit: 64, diskBytes: 1024 * 1024 }
  const source = { privateRepositoryRoot: sourceRoot, directoryIdentityHash: spec.target.destination.directoryIdentityHash, privateGit: true as const, diskQuotaBytes: 1024 * 1024,gitMounts }
  const plan: JobLaunchPlan = { identity: jobSupervisorIdentity(execution), execution, verifiedSource: source, inputs: receipt, privateRepositoryRoot: sourceRoot, cwd: sourceRoot, argv: ['node', 'failure.mjs'], environment: {}, stdin: 'closed', pty: false, profile }
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  let stopped = false; let resolveWait: ((value: { exitCode: number; stdout: string }) => void) | undefined
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('create')) return { exitCode: 0, stdout: digest }
    if (argv[0] === 'wait') return new Promise<{ exitCode: number; stdout: string }>(resolve => { resolveWait = resolve; if (stopped) resolve({ exitCode: 0, stdout: String(exitCode) }) })
    return { exitCode: 0, stdout: JSON.stringify([{ Id: digest, Config: { Labels: { 'graphql.job.identity': plan.identity, 'graphql.job.spec': spec.specDigest, 'graphql.job.attempt': execution.attemptId } }, State: { Running: !stopped, Pid: stopped ? 0 : 100, ExitCode: exitCode, Status: stopped ? 'exited' : 'running' } }]) }
  })
  const commands: PodmanCommandRunner = { run, attach: vi.fn(async () => child as unknown as Awaited<ReturnType<PodmanCommandRunner['attach']>>) }
  const ownership = { reserveContainerIntent: vi.fn(), assertCurrent: vi.fn(), bindContainer: vi.fn(), launchHelpers: vi.fn(), readCertificate: vi.fn(), publish: vi.fn() } as unknown as OCIContainerOwnership
  // Boundary supervision doubles only. Physical PID/cgroup certificate tests are separate.
  vi.spyOn(OwnedOCIContainer.prototype, 'entered').mockImplementation(async () => { throw new Error('unit boundary marker') })
  vi.spyOn(OwnedOCIContainer.prototype, 'close').mockResolvedValue(false)
  const supervisor = new PodmanJobSupervisor(profile, commands, async () => ownership)
  return { root, inputRoot, execution, receipt, plan, supervisor, run, ownership, commands, child, stop: () => { stopped = true; resolveWait?.({ exitCode: 0, stdout: String(exitCode) }) } }
}
describe('OCI immutable input consumer with command/boundary doubles, no live qualification', () => {
  it('emits the exact retained input RO submount and fixed manifest environment', async () => {
    const f = await fixture(); const argv = podmanCreateArgv(f.plan)
    expect(argv).toContain(`type=bind,src=${f.inputRoot},dst=/workspace/${JOB_INPUT_DIRECTORY},ro`)
    expect(argv).toContain('FOREMAN_CODE_JOB_INPUT_MANIFEST=/workspace/.graphql-job-inputs/manifest.json')
    expect(argv).toContain('GRAPHQL_JOB_INPUT_MANIFEST=/workspace/.graphql-job-inputs/manifest.json')
    expect(argv).toContain('--remote=false')
    expect(argv.filter(value=>value.startsWith('type=bind,'))).toHaveLength(4)
    expect(argv).toContain(`type=bind,src=${f.plan.verifiedSource.gitMounts!.git.directory},dst=/graphql-job-git,ro`)
    expect(argv).toContain(`type=bind,src=${f.plan.verifiedSource.gitMounts!.scheduler.directory},dst=/graphql-job-git/graphql-heavy-jobs,rw`)
    for(const [key,value] of Object.entries(JOB_GIT_ENVIRONMENT))expect(argv).toContain(`${key}=${value}`)
  })
  it('rehashes physical bytes before any create or ownership publication', async () => {
    const f = await fixture(); await chmod(join(f.inputRoot, 'workflow-input.json'), 0o644); await writeFile(join(f.inputRoot, 'workflow-input.json'), 'true')
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('Accepted job inputs rejected')
    expect(f.run).not.toHaveBeenCalled(); expect(f.ownership.bindContainer).not.toHaveBeenCalled()
  })
  it('rejects stale owner/input receipts before native entry', async () => {
    const f = await fixture(); f.plan.inputs.recipient.owner.epoch = '999'
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('original execution')
    expect(f.run).not.toHaveBeenCalled()
  })
  it('does not launch user work successfully when owned boundary entry is unconfirmed', async () => {
    const f = await fixture()
    await expect(f.supervisor.launch(f.plan)).rejects.toThrow('unit boundary marker')
    expect(f.ownership.bindContainer).toHaveBeenCalledWith(f.plan.identity, 'a'.repeat(64))
    expect(f.run.mock.calls.some(([argv])=>argv[0]==='exec')).toBe(false)
    f.stop()
  })
  it('rearms the persisted deadline on recovery and stops locally without a launch', async () => {
    const f = await fixture(), markTimeout = vi.fn(), deadlineMs = vi.fn(async () => Date.now() + 5)
    const recovered = new PodmanJobSupervisor(f.plan.profile, f.commands, async () => f.ownership, { deadlineMs, markTimeout, isTimedOut: async () => false })
    const stop = vi.spyOn(recovered, 'stopExecution').mockResolvedValue(true)
    vi.useFakeTimers()
    try {
      expect(await recovered.reconcile(f.execution)).toMatchObject({ stopped: false, exitCode: null })
      await vi.advanceTimersByTimeAsync(10)
      expect(markTimeout).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledWith(f.execution, f.execution.acceptedSpec.policy.cancellationGraceMs, 'a'.repeat(64))
      expect(f.run.mock.calls.some(([argv]) => argv.includes('create') || argv.includes('start'))).toBe(false)
    } finally { vi.useRealTimers() }
  })

})

describe('original command release after durable entry proof, OCI boundary observations doubled',()=>{
  it.each([0,7])('retains immediate exit %i and reconciles from the reopened original journal',async exitCode=>{
    const f=await fixture(exitCode),path=join(f.root,'operations.json'),bootId=bootIdentity(),containerId='a'.repeat(64)
    let journal=await RemoteOperationJournal.open(path,{initializeNewInstallation:true})
    const execution=f.execution,intent={schemaVersion:1 as const,protocolVersion:1 as const,mainId:execution.acceptedSpec.target.mainId,subject:{kind:'manual-job' as const,workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner}
    await journal.jobAccept(intent,execution,{kind:'main',mainId:intent.mainId,mainInstallationId:execution.acceptedSpec.target.mainInstallationId,bootId},randomUUID());await journal.jobReserveEntry(execution.operationId)
    const certificate:OCIHostCertificate={scope:{subject:{kind:'job',executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:intent.bindingHash},leaseId:execution.operationId,owner:execution.owner,observedDeviceId:null,observedInstallationId:execution.acceptedSpec.target.mainInstallationId,bootId},containerId,process:{pid:100,startTicks:'123',bootId},boundary:{kind:'cgroup-v2',path:`/sys/fs/cgroup/graphql-test-absent-${randomUUID()}-libpod-${containerId}.scope`,device:'1',inode:'2'},helpers:[],lifecycle:'active'}
    Object.assign(f.ownership,{scope:certificate.scope,reserveContainerIntent:(identity:string,fingerprint:string)=>journal.jobContainerIntent(execution.operationId,identity,fingerprint),bindContainer:(identity:string,id:string)=>journal.jobBindContainer(execution.operationId,identity,id),readCertificate:async()=> (await journal.jobNativeOwner(execution.operationId))?.container?.certificate??null,publish:(value:OCIHostCertificate)=>journal.jobCertificate(execution.operationId,value),closeHelpers:async()=>true})
    vi.mocked(OwnedOCIContainer.prototype.entered).mockImplementation(async()=>{
      const observed=JSON.parse((await f.commands.run(['container','inspect',containerId])).stdout)[0]
      if(!observed.State.Running||observed.State.Pid<=0)throw new Error('Original entry already exited before its certificate.')
      await f.ownership.publish(certificate);return certificate
    })
    vi.mocked(OwnedOCIContainer.prototype.close).mockRestore()
    const original=f.run.getMockImplementation()!
    let gated=false
    vi.mocked(f.commands.attach).mockImplementation(async()=>{if(!gated)f.stop();return f.child as unknown as Awaited<ReturnType<PodmanCommandRunner['attach']>>})
    f.run.mockImplementation(async argv=>{
      if(argv.includes('create'))gated=argv.includes('/tmp/graphql-job-start')
      if(argv[0]==='exec'){
        expect((await journal.jobNativeOwner(execution.operationId))?.container?.certificate).toEqual(certificate)
        f.stop();return {exitCode:0,stdout:''}
      }
      return original(argv)
    })
    try{
      const launched=await f.supervisor.launch(f.plan)
      expect(f.run.mock.calls.some(([argv])=>argv[0]==='exec')).toBe(true)
      expect(await launched.exited).toMatchObject({exitCode,signal:null})
      await journal.close();journal=await RemoteOperationJournal.open(path)
      const recovered=new PodmanJobSupervisor(f.plan.profile,f.commands,async()=>f.ownership)
      expect(await recovered.reconcile(execution)).toMatchObject({stopped:true,exitCode})
      expect((await journal.jobNativeOwner(execution.operationId))?.container?.certificate?.lifecycle).toBe('closed')
    }finally{f.stop();await journal.close()}
  })
  it.each([0,7])('runs the emitted Node bootstrap only after release and preserves exit %i',async exitCode=>{
    const f=await fixture(),argv=podmanCreateArgv(f.plan),entry=argv.indexOf('--entrypoint'),args=argv.slice(entry+3),gate=join(f.root,'release')
    expect(args[0]).toBe('-e');expect(args[2]).toBe('--');expect(args[3]).toBe('/tmp/graphql-job-start')
    const child=spawn(process.execPath,['-e',args[1]!,'--',gate,process.execPath,'-e',`process.exit(${exitCode})`],{stdio:['ignore','pipe','pipe']})
    const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    try{
      await new Promise(resolve=>setTimeout(resolve,50));expect(child.exitCode).toBeNull()
      await writeFile(gate,'');expect(await exited).toBe(exitCode)
    }finally{if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');await exited}
  })
})

it('denies historical two-mount profile and arbitrary host Git before any create',async()=>{
  const f=await fixture();delete f.plan.profile.workspaceLayout
  await expect(f.supervisor.launch(f.plan)).rejects.toThrow('Qualified isolation unavailable')
  expect(f.run).not.toHaveBeenCalled()
  f.plan.profile.workspaceLayout=JOB_PRIVATE_GIT_LAYOUT;f.plan.verifiedSource.gitMounts!.git.directory='/unrelated/.git'
  expect(()=>podmanCreateArgv(f.plan)).toThrow('Original qualified')
})

it('prepares verifiable private Git and scheduler ownership under a group-writable host umask', async () => {
  const root = await privateFixtureDirectory('job-git-permissions-')
  roots.push(root)
  const program = `
    import { mkdir } from 'node:fs/promises'
    import { join } from 'node:path'
    import { jobExecution } from './test/helpers/jobFixture.ts'
    import { prepareJobRepositoryFixture } from './test/helpers/jobRepositoryFixture.ts'
    import { verifyPrivateJobRepositoryMounts } from './src/modules/sources/repository.ts'
    import { qualifiedGit } from './src/modules/sources/capture.ts'
    process.umask(0o002)
    const root = process.argv[1]
    const runtime = join(root, 'runtime')
    await mkdir(runtime, { mode: 0o700 })
    const execution = jobExecution()
    const { gitMounts } = await prepareJobRepositoryFixture(execution, root, runtime)
    await verifyPrivateJobRepositoryMounts(execution, gitMounts)
    const source = (await qualifiedGit(gitMounts.git.directory, ['show', 'HEAD:fixture.txt'])).toString()
    console.log(JSON.stringify({ verified: true, source }))
  `
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, root], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 30_000,
    })
  expect(JSON.parse(stdout)).toEqual({ verified: true, source: 'Approved fixture source\n' })
}, 35_000)

import { DomainError } from '../../errors.js'
import { privateFixtureDirectory } from '../../../../test/helpers/privateFixtureDirectory.js'
import { prepareJobRepositoryFixture } from '../../../../test/helpers/jobRepositoryFixture.js'
import { JOB_PRIVATE_GIT_LAYOUT } from '../../jobs/privateGitMounts.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { PostgresJobDispatch } from '../../jobs/dispatch.js'
import { projectJobReceiptLocked } from '../../jobs/receiptProjection.js'
import type { JobSql } from '../../jobs/repository.js'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import { jobInputSnapshotDigest } from '@foreman-code/contracts/job-inputs-node'
import { JOB_INPUT_DIRECTORY, JobBuildInputManifestSchema } from '@foreman-code/contracts/job-inputs'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { jobSupervisorIdentity, type QualifiedJobProfile } from '../../jobs/executor.js'
import { PodmanJobSupervisor, type PodmanCommandRunner } from '../../jobs/executorPodman.js'
import { identity } from '../../sources/privateFilesystem.js'
import { OwnedOCIContainer, type OCIContainerOwnership } from '../../jobs/executorContainerOwner.js'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { JobOutputCollectionError } from '../../jobs/executorOutputs.js'
const roots: string[] = [], journals: RemoteOperationJournal[] = [], hosts: RemoteJobExecutionHost[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(hosts.splice(0).map(host => host.drain())); await Promise.all(journals.splice(0).map(journal => journal.close())); await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))) })
async function fixture(loseClosureAck = false, denyPublication = false, wrongInput = false, loseCollectionAck = false,
  options: { outputs?: ReturnType<typeof jobExecution>['acceptedSpec']['outputs']; preparationTimeoutMs?: number } = {}) {
  const root = await privateFixtureDirectory('w08-job-'); roots.push(root)
  const journal = await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true}); journals.push(journal)
  const execution = jobExecution()
  if (options.outputs) execution.acceptedSpec.outputs = options.outputs
  if (options.preparationTimeoutMs !== undefined) execution.acceptedSpec.policy.preparationTimeoutMs = options.preparationTimeoutMs
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot, { mode: 0o700 })
  const { sourceRoot, gitMounts } = await prepareJobRepositoryFixture(execution, root, runtimeRoot)
  const intent: RemoteJobDispatchIntent = { schemaVersion:1,protocolVersion:1,mainId:execution.acceptedSpec.target.mainId,
    subject:{kind:'manual-job',workspaceId:execution.workspaceId,jobExecutionId:execution.id,definitionId:execution.acceptedSpec.definitionId},executionId:execution.id,
    attemptId:execution.attemptId,operationId:execution.operationId,bindingHash:execution.acceptedSpec.bindingHash,inputDigest:`sha256:${execution.acceptedSpec.specDigest}`,owner:execution.owner }
  const state = { loseClosureAck, loseCollectionAck, creates:0, collected:0, closureAccepted:false, reports:[] as string[], allowed:true,
    containerPresent: false, removals: 0, removalFailures: 0,
    collectionError: null as Error | null, publicationError: null as Error | null, sourceFailures: 0, verifications: 0 }
  let executionGate: Promise<void> | undefined
  let preparationGate: Promise<void> | undefined
  let preparationBegan: ((signal: AbortSignal) => void) | undefined
  let started = false, released = false
  const waiting: Array<() => void> = []
  const cid='c'.repeat(64),policy=execution.acceptedSpec.policy
  const profile: QualifiedJobProfile = {workspaceLayout:JOB_PRIVATE_GIT_LAYOUT, policyId:policy.isolationPolicyId,policyRevision:policy.isolationPolicyRevision,imageDigest:policy.imageDigest,toolchainDigest:policy.toolchainDigest,
    runtimeVersion:'unit',ociRuntimeVersion:'unit',kernelVersion:'unit',qualificationId:'unit-qualified',rootless:true,cgroupV2:true,filesystemBounded:true,descendantContainment:true,network:'none',cpuLimit:1,memoryBytes:1048576,pidsLimit:64,diskBytes:1048576 }
  const runner: PodmanCommandRunner = { run:async argv => {
    if(argv.includes('create')){state.creates++;state.containerPresent=true;return{exitCode:0,stdout:cid}}
    if (argv[0] === 'rm') {
      expect(await journal.jobStatus(intent.operationId)).toMatchObject({
        status: 'known', receipt: { terminal: { processStopped: true, exitCode: 7 } },
      })
      if (state.removalFailures > 0) {
        state.removalFailures--
        return { exitCode: 1, stdout: '' }
      }
      state.removals++
      state.containerPresent = false
      return { exitCode: 0, stdout: cid }
    }
    if (argv[0] === 'container' && argv[1] === 'exists') {
      return { exitCode: state.containerPresent ? 0 : 1, stdout: '' }
    }
    if (argv[0] === 'container' && argv[1] === 'inspect' && !state.containerPresent) {
      return { exitCode: 1, stdout: '' }
    }
    if(argv[0]==='wait')return new Promise(resolve => { waiting.push(() => resolve({exitCode:0,stdout:'7'})) })
    if(argv[0]==='exec'){await executionGate;released=true;for(const finish of waiting.splice(0))finish();return{exitCode:0,stdout:''}}
    return{exitCode:0,stdout:JSON.stringify([{Id:cid,Config:{Labels:{'graphql.job.identity':jobSupervisorIdentity(execution),'graphql.job.spec':execution.acceptedSpec.specDigest,'graphql.job.attempt':execution.attemptId}},State:{Running:started&&!released,Pid:started&&!released?100:0,ExitCode:7,Status:released?'exited':started?'running':'created'}}])}
  },attach:async()=>{started=true;const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});waiting.push(()=>{child.stdout.end('build exit7');child.stderr.end();child.emit('close',7)});return child as unknown as Awaited<ReturnType<PodmanCommandRunner['attach']>>} }
  // OCI boundary authority is a unit double; this suite proves journal/input sequencing, not physical qualification.
  const ownership={reserveContainerIntent:vi.fn(),assertCurrent:vi.fn(),bindContainer:vi.fn(),launchHelpers:vi.fn(),readCertificate:vi.fn(),publish:vi.fn()} as unknown as OCIContainerOwnership
  vi.spyOn(OwnedOCIContainer.prototype,'entered').mockResolvedValue(undefined as never)
  vi.spyOn(OwnedOCIContainer.prototype,'close').mockResolvedValue(true)
  const supervisor=new PodmanJobSupervisor(profile,runner,async()=>ownership)
  const host=new RemoteJobExecutionHost({journal,connection:{kind:'main',mainId:intent.mainId,mainInstallationId:execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},incarnationId:randomUUID(),supervisor,
    source:{verify:async()=>{
      state.verifications++
      if (state.sourceFailures-- > 0) throw new DomainError('DEVICE_TRANSPORT_ERROR', 'Source is reconnecting', 503)
      return {privateRepositoryRoot:execution.acceptedSpec.target.destination.canonicalProjectRoot,directoryIdentityHash:execution.acceptedSpec.target.destination.directoryIdentityHash,privateGit:true,diskQuotaBytes:1024,gitMounts}
    }},
    inputs:{prepare:async (current, _source, signal)=>{
      preparationBegan?.(signal)
      await preparationGate
      const spec=current.acceptedSpec,hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
      const manifest=Buffer.from(JSON.stringify(JobBuildInputManifestSchema.parse({version:1,inputSnapshotDigest:jobInputSnapshotDigest(current),workflowInput:spec.workflowInput,files:[]}))),workflow=Buffer.from(JSON.stringify(spec.workflowInput))
      const inputRoot=join(sourceRoot,JOB_INPUT_DIRECTORY);await mkdir(inputRoot,{mode:0o700});await writeFile(join(inputRoot,'manifest.json'),manifest,{mode:0o444});await writeFile(join(inputRoot,'workflow-input.json'),workflow,{mode:0o444})
      const inputHandle=await open(inputRoot,constants.O_RDONLY|constants.O_DIRECTORY),inputIdentity=await identity(inputHandle);await inputHandle.close()
      return {version:1,bindingId:'1'.repeat(64),recipient:{workspaceId:current.workspaceId,executionId:current.id,attemptId:wrongInput?'wrong':current.attemptId,operationId:current.operationId,owner:current.owner,bindingHash:spec.bindingHash,specDigest:spec.specDigest,materializationId:spec.source.materializationId,materializationDigest:spec.source.materializationDigest},inputSnapshotDigest:jobInputSnapshotDigest(current),manifestSha256:hash(manifest),manifestByteSize:manifest.length,directory:{relativePath:JOB_INPUT_DIRECTORY,...inputIdentity},files:[{relativePath:'manifest.json',sha256:hash(manifest),byteSize:manifest.length},{relativePath:'workflow-input.json',sha256:hash(workflow),byteSize:workflow.length}],readonlyMountRequired:true}
    }},
    authorize:async(_intent,_execution,action)=>{if(action==='publish'&&state.publicationError)throw state.publicationError;if(denyPublication&&action==='publish')throw new DomainError('ACCESS_DENIED','cleanup cannot publish',403);if(!state.allowed)throw new Error('revoked')},appendLog:async()=>{},observeReceipt:async receipt=>{state.reports.push(`${receipt.phase}:${receipt.publication}`);if(state.loseCollectionAck&&receipt.publication==='collecting')throw new Error('lost collecting ACK');if(receipt.terminal){if(state.loseClosureAck)throw new Error('lost process ACK');state.closureAccepted=true}},
    collectOutputs:async()=>{expect(state.closureAccepted).toBe(true);state.collected++;if(state.collectionError)throw state.collectionError} });hosts.push(host)
  return {root,journal,execution,intent,state,host,supervisor,
    holdExecution(gate: Promise<void>) { executionGate = gate },
    holdPreparation(gate: Promise<void>, onStart: (signal: AbortSignal) => void) {
      preparationGate = gate
      preparationBegan = onStart
    } }
}
describe('actual OCI job adapter with command doubles, no installed runtime claim',()=>{
  it.each(['deadline', 'cancel'] as const)(
    'keeps terminal publication and drain pending while an input writer ignores %s', async interruption => {
      const f = await fixture()
      let release!: () => void
      let began!: (signal: AbortSignal) => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const started = new Promise<AbortSignal>(resolve => { began = resolve })
      f.holdPreparation(gate, began)
      vi.useFakeTimers()
      try {
        await f.host.deliver(f.intent, f.execution)
        const preparationSignal = await started
        if (interruption === 'deadline') {
          await vi.advanceTimersByTimeAsync(f.execution.acceptedSpec.policy.preparationTimeoutMs)
        } else {
          await f.host.handle({ method: 'job-control', intent: f.intent, command: {
            schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(),
            executionId: f.execution.id, attemptId: f.execution.attemptId, operationId: f.execution.operationId,
            bindingHash: f.execution.acceptedSpec.bindingHash, subject: f.intent.subject,
            owner: f.execution.owner, action: { kind: 'stop' },
          } })
        }
        expect(preparationSignal.aborted).toBe(true)
        let drained = false
        const draining = f.host.beginDrain().then(() => { drained = true })
        vi.useRealTimers()
        await new Promise<void>(resolve => { setTimeout(resolve, 25) })
        expect(drained).toBe(false)
        const pending = await f.journal.jobStatus(f.intent.operationId)
        expect(pending).toMatchObject({ status: 'known', receipt: {
          publication: 'pending', entryAttempted: false,
        } })
        if (pending.status !== 'known') throw new Error('Accepted Job status unavailable')
        expect(pending.receipt.terminal).toBeUndefined()
        expect(f.state.closureAccepted).toBe(false)
        release()
        await draining
        expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
          terminal: { outcome: interruption === 'deadline' ? 'preparation_failed' : 'cancelled', processStopped: true },
          publication: 'complete', entryAttempted: false,
        } })
        expect(f.state.creates).toBe(0)
      } finally {
        release()
        vi.useRealTimers()
        await f.host.drain()
      }
    },
  )

  it('recovers a closed never-started container without inventing a command exit result', async () => {
    const f = await fixture()
    await f.journal.jobAccept(f.intent, f.execution, { kind: 'main', mainId: f.intent.mainId,
      mainInstallationId: f.execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() }, randomUUID())
    await f.journal.jobReserveEntry(f.intent.operationId)
    const reconcile = vi.spyOn(f.supervisor, 'reconcile').mockResolvedValue({
      containerId: 'c'.repeat(64), stopped: true, neverStarted: true,
      exitCode: null, execError: false, timedOut: false, logGapPossible: true,
    })
    const remove = vi.spyOn(f.supervisor, 'removeExecution').mockResolvedValue()
    const launch = vi.spyOn(f.supervisor, 'launch')
    await f.host.handle({ method: 'job-status', intent: f.intent })
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      terminal: { outcome: 'preparation_failed', exitCode: null, processStopped: true }, publication: 'complete',
    } })
    expect(remove).toHaveBeenCalledWith(f.execution, 'c'.repeat(64))
    expect(launch).not.toHaveBeenCalled()
    await f.host.deliver(f.intent, f.execution)
    expect(reconcile).toHaveBeenCalledOnce()
    expect(launch).not.toHaveBeenCalled()
  })

  it('persists never-started closure, rejects a late start and removes its retained ID on recovery', async () => {
    const f = await fixture()
    const containerId = 'c'.repeat(64)
    await f.journal.jobAccept(f.intent, f.execution, { kind: 'main', mainId: f.intent.mainId,
      mainInstallationId: f.execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() }, randomUUID())
    await f.journal.jobReserveEntry(f.intent.operationId)
    const identity = jobSupervisorIdentity(f.execution)
    await f.journal.jobContainerIntent(f.intent.operationId, identity, f.execution.acceptedSpec.specDigest)
    await f.journal.jobBindContainer(f.intent.operationId, identity, containerId)
    const launchId = randomUUID()
    await f.journal.jobReserveProcess(f.intent.operationId, {
      launchId, binary: '/usr/bin/podman', argv: ['--remote=false', 'create', '--name', identity],
    })
    await expect(f.journal.jobConfirmUnreleasedClosure(f.intent.operationId, containerId))
      .rejects.toThrow('closure is unconfirmed')
    await f.journal.jobProcessClosed(f.intent.operationId, launchId, { exitCode: 0, signal: null })
    await f.journal.jobConfirmUnreleasedClosure(f.intent.operationId, containerId)
    await f.journal.close()
    const recovered = await RemoteOperationJournal.open(join(f.root, 'journal'))
    journals.push(recovered)
    expect(await recovered.jobNativeOwner(f.intent.operationId)).toMatchObject({ nonEntryConfirmed: true,
      container: { containerId, unreleasedClosureConfirmed: true } })
    await expect(recovered.jobReserveProcess(f.intent.operationId, { launchId: randomUUID(),
      binary: '/usr/bin/podman', argv: ['--remote=false', 'start', containerId] }))
      .rejects.toThrow('cannot start a native process')
    const remove = vi.fn(async () => {})
    const host = new RemoteJobExecutionHost({ journal: recovered,
      connection: { kind: 'main', mainId: f.intent.mainId,
        mainInstallationId: f.execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() },
      incarnationId: randomUUID(), supervisor: { removeExecution: remove } as never,
      authorize: async () => {}, observeReceipt: async () => {}, appendLog: async () => {},
      source: {} as never, inputs: {} as never, collectOutputs: async () => {},
    })
    await host.handle({ method: 'job-status', intent: f.intent })
    expect(await recovered.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      native: { containerId }, terminal: { outcome: 'preparation_failed', exitCode: null }, publication: 'complete',
    } })
    expect(remove).toHaveBeenCalledWith(f.execution, containerId)
  })

  it('stops new admissions and lets an active Job finish with its original outcome during runtime drain', async () => {
    const f = await fixture()
    let finish!: () => void
    f.holdExecution(new Promise<void>(resolve => { finish = resolve }))
    try {
      await f.host.deliver(f.intent, f.execution)
      const drained = f.host.beginDrain()
      await expect(f.host.deliver(f.intent, f.execution)).rejects.toThrow('draining')
      expect((await f.journal.jobStatus(f.intent.operationId)).status).toBe('known')
      finish()
      await drained
      expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
        terminal: { outcome: 'build_failed', exitCode: 7, processStopped: true }, publication: 'complete',
      } })
      expect(f.state.creates).toBe(1)
    } finally { finish() }
  })

  it.each([false, true])('removes the owned container after its terminal result, including publication denial %s', async denied => {
    const f = await fixture(false, denied)
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    expect(f.state.containerPresent).toBe(false)
    expect(f.state.removals).toBe(1)
    await f.host.deliver(f.intent, f.execution)
    expect(f.state.removals).toBe(1)
    expect(f.state.creates).toBe(1)
  })

  it('retries failed container removal without publishing completion or rerunning the Job', async () => {
    const f = await fixture()
    f.state.removalFailures = 1
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    expect(f.state.containerPresent).toBe(true)
    expect(f.state.collected).toBe(0)
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({
      status: 'known', receipt: { publication: 'pending', terminal: { exitCode: 7 } },
    })
    await f.host.deliver(f.intent, f.execution)
    expect(f.state.containerPresent).toBe(false)
    expect(f.state.removals).toBe(1)
    expect(f.state.creates).toBe(1)
    expect(f.state.collected).toBe(1)
  })

  it('records expired publication as failed without changing native outcome or rerunning it', async () => {
    const f = await fixture()
    f.state.collectionError = new JobOutputCollectionError('The output transfer expired before publication.')
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    await f.host.deliver(f.intent, f.execution)
    const status = await f.journal.jobStatus(f.intent.operationId)
    expect(status).toMatchObject({ status: 'known', receipt: {
      publication: 'failed', terminal: { exitCode: 7, processStopped: true },
    } })
    expect(f.state.creates).toBe(1)
    expect(f.state.collected).toBe(1)
  })
  it('runs one genuine manual job and commits physical exit before publication',async()=>{const f=await fixture();await f.host.deliver(f.intent,f.execution);await f.host.deliver(f.intent,f.execution);await f.host.drain();expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(1);const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('complete');expect(f.state.reports[0]).toBe('confirmed_terminal:pending');expect(status.status==='known'&&status.receipt.intent.subject.kind).toBe('manual-job')})
  it('publication denial retains physical terminal and records failed output status',async()=>{const f=await fixture(false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.phase).toBe('confirmed_terminal');expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('failed');expect(f.state.collected).toBe(0);expect(f.state.reports.at(-1)).toBe('confirmed_terminal:failed')})
  it('lost collection ACK remains transport uncertainty without inventing output failure',async()=>{const f=await fixture(false,false,false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7);expect(status.status==='known'&&status.receipt.publication).toBe('collecting');expect(f.state.collected).toBe(0)})
  it('changed accepted input tuple denies claim and native entry',async()=>{const f=await fixture(false,false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain();const status=await f.journal.jobStatus(f.intent.operationId);expect(f.state.creates).toBe(0);expect(status.status==='known'&&status.receipt.entryAttempted).toBe(false);expect(status.status==='known'&&status.receipt.terminal?.outcome).toBe('preparation_failed')})
  it('lost main closure ACK retains pending publication and never reruns native work',async()=>{const f=await fixture(true);await f.host.deliver(f.intent,f.execution);await f.host.drain();await expect(f.host.deliver(f.intent,f.execution)).rejects.toThrow('lost process ACK');expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(0);const status=await f.journal.jobStatus(f.intent.operationId);expect(status.status==='known'&&status.receipt.publication).toBe('pending');expect(status.status==='known'&&status.receipt.terminal?.processStopped).toBe(true)})
  it('retries the original closure acknowledgment and publication without another OCI launch',async()=>{
    const f=await fixture(true);await f.host.deliver(f.intent,f.execution);await f.host.drain()
    f.state.loseClosureAck=false
    await f.host.handle({method:'job-status',intent:f.intent})
    expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(1)
    const status=await f.journal.jobStatus(f.intent.operationId)
    expect(status.status==='known'&&status.receipt.publication).toBe('complete')
    await f.host.deliver(f.intent,f.execution)
    expect(f.state.collected).toBe(1)
  })
  it('resumes after a lost collecting ACK, preserving the measured nonzero exit',async()=>{
    const f=await fixture(false,false,false,true);await f.host.deliver(f.intent,f.execution);await f.host.drain()
    f.state.loseCollectionAck=false;await f.host.handle({method:'job-status',intent:f.intent})
    expect(f.state.creates).toBe(1);expect(f.state.collected).toBe(1)
    const status=await f.journal.jobStatus(f.intent.operationId)
    expect(status.status==='known'&&status.receipt.terminal?.exitCode).toBe(7)
    expect(status.status==='known'&&status.receipt.publication).toBe('complete')
  })
  it('denies wrong subject and revoked authority before any OCI start',async()=>{const f=await fixture();await expect(f.host.deliver({...f.intent,executionId:'fake-run'},f.execution)).rejects.toThrow('subject');f.state.allowed=false;await expect(f.host.deliver(f.intent,f.execution)).rejects.toThrow('revoked');expect(f.state.creates).toBe(0)})
  it('offline startup only recovers original supervisors; it never authorizes or launches fresh work',async()=>{
    const f=await fixture();await f.journal.jobAccept(f.intent,f.execution,{kind:'main',mainId:f.intent.mainId,mainInstallationId:f.execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},randomUUID())
    await f.journal.jobReserveEntry(f.intent.operationId);f.state.allowed=false
    const reconcile=vi.spyOn(f.supervisor,'reconcile').mockResolvedValue({containerId:'c'.repeat(64),stopped:false,exitCode:null,execError:false,timedOut:false,logGapPossible:true})
    await f.host.recover()
    expect(reconcile).toHaveBeenCalledWith(f.execution);expect(f.state.creates).toBe(0);expect(f.state.collected).toBe(0)
  })
  it('recovers a confirmed unentered container without hashing absent identifiers or launching it', async () => {
    const f = await fixture(), operationId = f.intent.operationId
    await f.journal.jobAccept(f.intent, f.execution, { kind: 'main', mainId: f.intent.mainId,
      mainInstallationId: f.execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID() }, randomUUID())
    await f.journal.jobReserveEntry(operationId)
    const identity = jobSupervisorIdentity(f.execution), binary = '/usr/bin/podman'
    await f.journal.jobContainerIntent(operationId, identity, f.execution.acceptedSpec.specDigest)
    for (const [operation, exitCode] of [['inspect', 125], ['exists', 1]] as const) {
      const launchId = randomUUID()
      await f.journal.jobReserveProcess(operationId, { launchId, binary,
        argv: ['--remote=false', 'container', operation, identity] })
      await f.journal.jobProcessClosed(operationId, launchId, { exitCode, signal: null })
    }
    await f.journal.jobConfirmContainerNonEntry(operationId, binary)
    const laterInspection = randomUUID()
    await f.journal.jobReserveProcess(operationId, { launchId: laterInspection, binary,
      argv: ['--remote=false', 'container', 'inspect', identity] })
    await f.journal.jobProcessClosed(operationId, laterInspection, { exitCode: 125, signal: null })
    const inspect = vi.spyOn(f.supervisor, 'reconcile').mockRejectedValue(new Error('must not inspect again'))
    const stop = vi.spyOn(f.supervisor, 'stopExecution').mockRejectedValue(new Error('must not allocate another control command'))
    await f.host.recover()
    expect(await f.journal.jobStatus(operationId)).toMatchObject({ status: 'known', receipt: {
      terminal: { outcome: 'preparation_failed', processStopped: true }, publication: 'pending' } })
    await f.host.deliver(f.intent, f.execution)
    expect(await f.journal.jobStatus(operationId)).toMatchObject({ status: 'known', receipt: {
      entryAttempted: true, terminal: { outcome: 'preparation_failed', processStopped: true }, publication: 'complete' } })
    expect(f.state.creates).toBe(0)
    expect(inspect).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('worker journal negative fence and restart retain original job identity',async()=>{const f=await fixture();await f.journal.jobAccept(f.intent,f.execution,{kind:'main',mainId:f.intent.mainId,mainInstallationId:f.execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},randomUUID());await f.journal.jobControl({schemaVersion:1,protocolVersion:1,commandId:'stop',operationId:f.intent.operationId,attemptId:f.intent.attemptId,executionId:f.intent.executionId,bindingHash:f.intent.bindingHash,subject:f.intent.subject,owner:f.intent.owner,action:{kind:'stop'}});await f.journal.close();const recovered=await RemoteOperationJournal.open(join(f.root,'journal'));journals.push(recovered);expect((await recovered.jobReserveEntry(f.intent.operationId)).reserved).toBe(false);expect((await recovered.jobStatus(f.intent.operationId)).status).toBe('known');expect(f.state.creates).toBe(0)})
  it('spools exact log sequences in the same durable operation journal before main acknowledgment',async()=>{const f=await fixture();await f.journal.jobAccept(f.intent,f.execution,{kind:'main',mainId:f.intent.mainId,mainInstallationId:f.execution.acceptedSpec.target.mainInstallationId,bootId:randomUUID()},randomUUID());const chunk={executionId:f.execution.id,attemptId:f.execution.attemptId,sequence:1,stream:'stdout' as const,text:'a',byteSize:1,createdAt:new Date().toISOString()};await f.journal.jobAppendLog(f.intent.operationId,chunk);expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([chunk]);await f.journal.jobAcknowledgeLog(f.intent.operationId,1);expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([]);await expect(f.journal.jobAppendLog(f.intent.operationId,{...chunk,text:'different',byteSize:9})).rejects.toThrow('conflict')})
})

/** Actual worker closure and main receipt writer, with SQL persistence modeled; no DB/authentication proof. */
async function acceptedClosure(wrongInput=false) {
  const f=await fixture(false,false,wrongInput);await f.host.deliver(f.intent,f.execution);await f.host.drain()
  const status=await f.journal.jobStatus(f.intent.operationId)
  if(status.status!=='known')throw new Error('Actual journal receipt required')
  const row={record:structuredClone(f.execution) as JobExecutionRecord,accepted_spec:structuredClone(f.execution.acceptedSpec),intent:structuredClone(f.intent),last_receipt:status.receipt as RemoteJobOperationReceiptRecord|null,receipt_sequence:String(status.receipt.sequence)}
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    if(text.startsWith('select intent,receipt_sequence'))return {rows:[row]}
    if(text.startsWith('update job_dispatch_intents set receipt_sequence')) {
      row.receipt_sequence=String(values![1]);row.last_receipt=JSON.parse(String(values![2])) as RemoteJobOperationReceiptRecord
      return {rows:[]}
    }
    if(text.startsWith('update job_executions set record')) {row.record=JSON.parse(String(values![2])) as JobExecutionRecord;return {rows:[]}}
    if(text.startsWith('select e.record,e.accepted_spec')) {
      const expected=[row.record.workspaceId,row.record.id,row.record.attemptId,row.record.operationId,row.intent.bindingHash,row.intent.owner.grantId,row.intent.owner.epoch]
      return {rows:JSON.stringify(values)===JSON.stringify(expected)?[row]:[]}
    }
    throw new Error('Unexpected SQL in closure fixture')
  })
  const sql={query} as unknown as JobSql,pool=new pg.Pool()
  const forbidden=vi.fn(async()=>{throw new Error('Closure getter must not contact hosts or acquire runtime authority')})
  const dispatch=new PostgresJobDispatch(pool,{deliver:forbidden,reconcile:forbidden,control:forbidden},{revalidate:forbidden,authorizeControl:forbidden,observe:forbidden})
  try {
    await projectJobReceiptLocked(sql,structuredClone(f.execution),status.receipt,{verifyRequiredOutputs:async()=>{}})
  } finally {await pool.end()}
  const input={workspaceId:f.execution.workspaceId,executionId:f.execution.id,attemptId:f.execution.attemptId,operationId:f.execution.operationId,bindingHash:f.execution.acceptedSpec.bindingHash,owner:f.execution.owner}
  return {dispatch,sql,row,input,receipt:status.receipt,forbidden}
}
describe('SQL-only current accepted job closure receipts',()=>{
  it('reads actual host/journal closure only after the exact main receipt writer and process projection',async()=>{
    const f=await acceptedClosure();expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toEqual(f.receipt);expect(f.forbidden).not.toHaveBeenCalled()
    f.row.last_receipt=null;expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toBeNull()
  })
  it('accepts positive journaled pre-entry failure without interpreting missing native identity as closure',async()=>{
    const f=await acceptedClosure(true);expect(f.receipt.entryAttempted).toBe(false);expect(f.receipt.terminal?.outcome).toBe('preparation_failed');expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toEqual(f.receipt)
  })
  it.each(['workspaceId','executionId','attemptId','operationId','bindingHash'] as const)('never reads another %s tuple',async field=>{
    const f=await acceptedClosure();expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,{...f.input,[field]:'foreign'})).toBeNull()
  })
  it.each(['grantId','epoch'] as const)('never reads another owner %s',async field=>{
    const f=await acceptedClosure();expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,{...f.input,owner:{...f.input.owner,[field]:'foreign'}})).toBeNull()
  })
  it('pending or unprojected closure never counts as closed',async()=>{
    const f=await acceptedClosure();f.row.record=structuredClone(f.receipt.execution);expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toBeNull()
    f.row.last_receipt={...f.receipt,phase:'running',terminal:undefined};expect(await f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).toBeNull()
  })
  it.each(['acceptedSpec','intent','sequence','terminal','host','native'] as const)('rejects conflicting persisted %s evidence',async field=>{
    const f=await acceptedClosure()
    if(field==='acceptedSpec')f.row.accepted_spec.argv=['foreign']
    if(field==='intent')f.row.last_receipt={...f.receipt,intent:{...f.receipt.intent,inputDigest:`sha256:${'2'.repeat(64)}`}}
    if(field==='sequence')f.row.receipt_sequence=String(f.receipt.sequence+1)
    if(field==='terminal')f.row.record.finishedAt='2026-10-02T00:00:00.000Z'
    if(field==='host')f.row.last_receipt={...f.receipt,connection:{kind:'main',mainId:f.receipt.intent.mainId,mainInstallationId:'foreign-main',bootId:randomUUID()}}
    if(field==='native')f.row.last_receipt={...f.receipt,native:undefined}
    await expect(f.dispatch.readAcceptedClosureReceipt(f.sql,f.input)).rejects.toMatchObject({code:expect.stringMatching(/^JOB_CLOSURE_/)})
  })
})

describe('remote Job infrastructure retries', () => {
  it.each([
    new DomainError('DEVICE_CHANNEL_BACKPRESSURE', 'Main is busy', 503),
    Object.assign(new Error('Database lock timed out'), { code: '55P03' }),
    new Error('Main connection closed'),
  ])('retains successful outputs after transient publication authorization failure %#', async failure => {
    const f = await fixture(false, false, false, false, {
      outputs: [{ path: 'result.json', mediaType: 'application/json', required: true }],
    })
    f.state.publicationError = failure
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      terminal: { processStopped: true, exitCode: 7 }, publication: 'process_recorded',
    } })
    expect(f.state.collected).toBe(0)
    const command = await f.journal.jobOutputCommand(f.intent.operationId, {
      path: 'result.json', mediaType: 'application/json', sha256: '1'.repeat(64), byteSize: 2,
    })
    f.state.publicationError = null
    await f.host.handle({ method: 'job-status', intent: f.intent })
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      terminal: { processStopped: true, exitCode: 7 }, publication: 'complete',
    } })
    expect(await f.journal.jobOutputCommand(f.intent.operationId, {
      path: 'result.json', mediaType: 'application/json', sha256: '1'.repeat(64), byteSize: 2,
    })).toBe(command)
    expect(f.state.creates).toBe(1)
    expect(f.state.collected).toBe(1)
  })

  it('retries transient source preparation in the same accepted operation before native entry', async () => {
    const f = await fixture()
    f.state.sourceFailures = 1
    await f.host.deliver(f.intent, f.execution)
    await f.host.drain()
    expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
      intent: f.intent, execution: { id: f.execution.id, attemptId: f.execution.attemptId },
      publication: 'complete', terminal: { outcome: 'build_failed', processStopped: true },
    } })
    expect(f.state.verifications).toBe(2)
    expect(f.state.creates).toBe(1)
  })
})

it('resumes the original Job from status after transient preparation exhausts its local deadline', async () => {
  const f = await fixture(false, false, false, false, { preparationTimeoutMs: 1000 })
  f.state.sourceFailures = Infinity
  await f.host.deliver(f.intent, f.execution)
  await f.host.drain()
  const pending = await f.journal.jobStatus(f.intent.operationId)
  expect(pending).toMatchObject({ status: 'known', receipt: {
    phase: 'received', entryAttempted: false, publication: 'pending',
  } })
  if (pending.status !== 'known') throw new Error('Original Job receipt missing')
  expect(pending.receipt.terminal).toBeUndefined()
  expect(f.state.creates).toBe(0)
  f.state.sourceFailures = 0
  await f.host.handle({ method: 'job-status', intent: f.intent })
  await f.host.drain()
  expect(await f.journal.jobStatus(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
    intent: f.intent, publication: 'complete', terminal: { outcome: 'build_failed', processStopped: true },
  } })
  expect(f.state.creates).toBe(1)
})

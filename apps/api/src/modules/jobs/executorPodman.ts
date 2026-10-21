import { JOB_GIT_ENVIRONMENT, JOB_GIT_CONTAINER_DIRECTORY, JOB_PRIVATE_GIT_LAYOUT, requireJobGitMounts, verifyJobGitMounts } from './privateGitMounts.js'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import { VerificationJobExecutionSchema, JobVerificationParametersSchema } from '@foreman-code/contracts/job-verification'
import type { JobVerificationRuntimeMeasurement } from '@foreman-code/contracts/job-verification-runtime'
import { JobResourceRequestSchema, type JobResourceRequest } from '@foreman-code/contracts/job-verification-policy'
import { JOB_INPUT_DIRECTORY } from '@foreman-code/contracts/job-inputs'
import { JOB_INPUT_MANIFEST_CONTAINER_PATH, verifyJobInputDirectory } from './inputs.js'
import { OwnedOCIContainer, type OCIContainerOwnership, type PodmanCommandRunner } from './executorContainerOwner.js'
import type { QualificationNativeOwner, JobQualificationAuthority } from './qualificationPorts.js'
import type { JobQualificationCandidate } from '@foreman-code/contracts/job-runtime'
import type { JobExecution } from '@foreman-code/contracts'
import { jobSupervisorIdentity, requireVerificationRuntime, type JobLaunchPlan, type JobSupervisor,
  type QualifiedJobProfile, type RuntimeJobExecution, type VerificationExecution } from './executor.js'
import { ignoreError, fallbackOnError } from '../diagnostics/ignoredError.js'

export interface PodmanIsolationInput {
  identity: string
  sourceRoot: string
  runtimeRoot: string
  cwd: string
  argv: readonly string[]
  profile: Pick<QualifiedJobProfile, 'pidsLimit' | 'memoryBytes' | 'cpuLimit' | 'imageDigest'>
  spoolBytes: number
  labels: Record<string, string>
  inputRoot: string
  gitDirectory:string
  schedulerDirectory:string
  verification?: { resources: JobResourceRequest; scratchDirectory: string;
    parameters?: z.infer<typeof JobVerificationParametersSchema>; qualifiedIntegrationShards?: number }
}
const JOB_COMMAND_GATE='/tmp/graphql-job-start'
// The qualified image already contains Node. Its original PID/cgroup remains
// alive until the controller durably captures ownership and releases user argv.
const JOB_COMMAND_BOOTSTRAP=`const fs=require('node:fs'),cp=require('node:child_process'),os=require('node:os');
const [gate,...argv]=process.argv.slice(1);let child;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(child)child.kill(signal);else process.exit(128+os.constants.signals[signal])});
const timer=setInterval(()=>{if(!fs.existsSync(gate))return;clearInterval(timer);child=cp.spawn(argv[0],argv.slice(1),{shell:false,stdio:['ignore','inherit','inherit']});
child.once('error',error=>{console.error(error.message);process.exitCode=127});child.once('exit',(code,signal)=>{process.exitCode=code??(128+(os.constants.signals[signal]??0))})},10);`
const JOB_COMMAND_RELEASE="require('node:fs').writeFileSync(process.argv[1],'',{flag:'wx',mode:0o600})"
/** Shared by actual jobs and explicitly admitted model-free qualification. */
export function podmanIsolationCreateArgv(input: PodmanIsolationInput): string[] {
  const relative = input.cwd.slice(input.sourceRoot.length)
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(input.identity) || !input.sourceRoot.startsWith('/') ||
    input.sourceRoot.includes(',') || input.sourceRoot.includes('\0') ||
    !input.cwd.startsWith(`${input.sourceRoot}/`) && input.cwd !== input.sourceRoot ||
    relative.split('/').some(component => component === '..') || !input.argv[0] || input.argv.some(arg => arg.includes('\0')) ||
    !input.runtimeRoot.startsWith('/') || input.runtimeRoot.includes(',') || input.runtimeRoot.includes('\0') || input.runtimeRoot === input.sourceRoot ||
    input.runtimeRoot.startsWith(`${input.sourceRoot}/`) || !Number.isSafeInteger(input.spoolBytes) || input.spoolBytes < 8) {
    throw new Error('Invalid noninteractive container plan.')
  }
  if (input.gitDirectory!==join(input.sourceRoot,'..','repository')||input.schedulerDirectory!==join(input.sourceRoot,'..','job-heavy-jobs')
    ||[input.gitDirectory,input.schedulerDirectory].some(path=>path.includes(',')||path.includes('\0')))throw new Error('Original bounded Git/scheduler siblings required.')
  if (input.inputRoot !== join(input.sourceRoot, JOB_INPUT_DIRECTORY)) throw new Error('Exact retained immutable input directory required.')
  let temporary = ['--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864']
  let environment: Record<string, string> = { HOME: '/tmp/job-home' }
  if (input.verification) {
    const resources = JobResourceRequestSchema.parse(input.verification.resources)
    const scratch = input.verification.scratchDirectory
    if (scratch !== join(input.sourceRoot, '..', 'job-scratch') || /[:,\0]/.test(scratch)
      || ['cpuLimit', 'memoryBytes', 'pidsLimit'].some(key =>
        Reflect.get(input.profile, key) !== Reflect.get(resources.limits, key))
      || input.spoolBytes > resources.spoolBytes
      || resources.controlTempBytes + resources.shmBytes > resources.limits.memoryBytes) {
      throw new Error('Verification mounts and resources must match the reserved private boundary.')
    }
    const execution = resources.scratchExecutable ? 'exec' : 'noexec'
    temporary = ['--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${resources.controlTempBytes}`,
      '--shm-size', String(resources.shmBytes),
      '--tmpfs', `/dev/shm:rw,nosuid,nodev,noexec,size=${resources.shmBytes}`,
      '--volume', `${scratch}:/job-scratch:rw,nosuid,nodev,${execution},rprivate`]
    environment = { FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
      HOME: '/job-scratch/home', TMPDIR: '/job-scratch/tmp',
      XDG_CACHE_HOME: '/job-scratch/cache', XDG_CONFIG_HOME: '/job-scratch/config', XDG_DATA_HOME: '/job-scratch/data' }
    if (input.verification.parameters) {
      const parameters = JobVerificationParametersSchema.parse(input.verification.parameters)
      const maximum = input.verification.qualifiedIntegrationShards
      if (!Number.isSafeInteger(maximum) || !maximum || maximum < parameters.integrationShards || maximum > 12) {
        throw new Error('Measured integration shard allowance required.')
      }
      environment.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS = String(parameters.unitWorkers)
      environment.FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS = String(parameters.integrationShards)
      environment.FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS = String(maximum)
    }
  }
  return ['--remote=false', `--hooks-dir=${join(input.runtimeRoot, 'ci-empty-oci-hooks')}`, 'create', '--name', input.identity, '--pull=never', '--restart=no', '--read-only', '--read-only-tmpfs=false',
    '--image-volume=ignore', '--http-proxy=false', '--network=none', '--stop-signal=SIGTERM',
    ...Object.entries(input.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pid=private', '--ipc=private', '--cgroupns=private', '--userns=keep-id',
    // Podman's confined systemd mode delegates only the private container cgroup.
    ...(input.verification ? ['--systemd=always'] : []),
    '--pids-limit', String(input.profile.pidsLimit), '--memory', String(input.profile.memoryBytes),
    '--cpus', String(input.profile.cpuLimit), '--memory-swap', String(input.profile.memoryBytes),
    '--log-driver=k8s-file', '--log-opt', `max-size=${Math.floor(input.spoolBytes / 2)}`,
    '--log-opt', `path=${input.runtimeRoot}/${input.identity}.oci.log`,
    '--mount', `type=bind,src=${input.sourceRoot},dst=/workspace,rw`,
    '--mount', `type=bind,src=${input.inputRoot},dst=/workspace/${JOB_INPUT_DIRECTORY},ro`,
    '--mount', `type=bind,src=${input.gitDirectory},dst=${JOB_GIT_CONTAINER_DIRECTORY},ro`,
    '--mount', `type=bind,src=${input.schedulerDirectory},dst=${JOB_GIT_CONTAINER_DIRECTORY}/graphql-heavy-jobs,rw`,
    ...temporary,
    '--workdir', `/workspace${relative}`, '--unsetenv-all',
    ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env', 'LANG=C.UTF-8', '--env', 'CI=1', ...Object.entries(JOB_GIT_ENVIRONMENT).flatMap(([key,value])=>['--env',`${key}=${value}`]), '--env', `FOREMAN_CODE_JOB_INPUT_MANIFEST=${JOB_INPUT_MANIFEST_CONTAINER_PATH}`, '--env', `GRAPHQL_JOB_INPUT_MANIFEST=${JOB_INPUT_MANIFEST_CONTAINER_PATH}`, '--entrypoint', input.argv[0]!,
    input.profile.imageDigest, ...input.argv.slice(1)]
}

/** The installed carrier supplies the complete verification execution and current physical evidence. */
export function podmanVerificationCreateArgv(input: Omit<PodmanIsolationInput, 'verification' | 'profile' | 'labels'> & {
  execution: z.infer<typeof VerificationJobExecutionSchema>
  measurement: JobVerificationRuntimeMeasurement
  runtime: QualifiedJobProfile
  dispatchAt: string
}): string[] {
  const execution = VerificationJobExecutionSchema.parse(input.execution)
  const spec = execution.acceptedSpec
  requireVerificationRuntime(spec, input.measurement, input.runtime, Date.now(), input.dispatchAt)
  if (input.sourceRoot !== spec.target.destination.canonicalProjectRoot
    || input.runtimeRoot !== spec.target.destination.managedRuntimeRoot
    || input.cwd !== spec.target.destination.canonicalCwd || !isDeepStrictEqual(input.argv, spec.argv)
    || input.spoolBytes !== spec.policy.maxWorkerSpoolBytes) {
    throw new Error('Verification launch differs from its complete accepted execution.')
  }
  const identity = jobSupervisorIdentity(execution)
  if (input.identity !== identity) throw new Error('Original verification supervisor identity changed.')
  return podmanIsolationCreateArgv({ ...input,
    argv: ['node', '-e', JOB_COMMAND_BOOTSTRAP, '--', JOB_COMMAND_GATE, ...spec.argv],
    profile: input.runtime, labels: { 'graphql.job.identity': identity,
      'graphql.job.spec': spec.specDigest, 'graphql.job.attempt': execution.attemptId },
    verification: { resources: spec.verification.resources, scratchDirectory: join(input.sourceRoot, '..', 'job-scratch'),
      parameters: spec.verification.parameters,
      qualifiedIntegrationShards: input.measurement.suites.find(suite => suite.suite === spec.verification.suite)!.maxIntegrationShards },
  })
}

/** Storage preparation stays inside the already accepted quota namespace; it never provisions a host volume. */
export async function prepareVerificationScratchDirectory(
  raw: z.infer<typeof VerificationJobExecutionSchema>,
  measurement: JobVerificationRuntimeMeasurement,
): Promise<string> {
  const execution = VerificationJobExecutionSchema.parse(raw)
  const source = execution.acceptedSpec.target.destination.canonicalProjectRoot
  if (source !== join(source, '..', 'tree') || !source.startsWith(`${measurement.fingerprint.root.binding.canonicalPath}/`)
    || await realpath(source) !== source) throw new Error('Original private verification namespace required.')
  const directory = await open(join(source, '..'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const parent = await directory.stat()
    if (parent.uid !== process.getuid?.() || parent.mode & 0o077
      || String(parent.dev) !== measurement.fingerprint.root.binding.filesystem.device) {
      throw new Error('Verification scratch escaped its qualified private filesystem.')
    }
    const scratch = `/proc/self/fd/${directory.fd}/job-scratch`
    await mkdir(scratch, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const handle = await open(scratch, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (info.uid !== parent.uid || info.mode & 0o077 || info.dev !== parent.dev) {
        throw new Error('Private verification scratch ownership changed.')
      }
      for (const name of ['home', 'tmp', 'cache', 'config', 'data']) {
        const path = `/proc/self/fd/${handle.fd}/${name}`
        await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try {
          const childInfo = await child.stat()
          if (childInfo.uid !== parent.uid || childInfo.mode & 0o077 || childInfo.dev !== parent.dev) {
            throw new Error('Private verification state escaped its scratch boundary.')
          }
        } finally { await child.close() }
      }
      await handle.sync()
    } finally { await handle.close() }
    await directory.sync()
    return join(source, '..', 'job-scratch')
  } finally { await directory.close() }
}

/** Application-owned empty hook directory inside the already approved runtime root. */
export async function ensureEmptyPodmanHooks(runtimeRoot: string) {
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error('Canonical runtime root required.')
  const root = await open(runtimeRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await root.stat()
    if (metadata.uid !== process.getuid?.() || metadata.mode & 0o022) throw new Error('Runtime root ownership rejected.')
    const hooks = join(runtimeRoot, 'ci-empty-oci-hooks')
    await mkdir(hooks, { mode: 0o700 }).catch(error => { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error })
    const details = await stat(hooks)
    if (await realpath(hooks) !== hooks || !details.isDirectory() || details.uid !== metadata.uid || details.mode & 0o077 || (await readdir(hooks)).length) throw new Error('Empty owned hook directory required.')
    return hooks
  } finally { await root.close() }
}
/** No pulling, setup, host networking, home, socket or credentials are implied. */
export function podmanCreateArgv(plan: JobLaunchPlan): string[] {
  if (plan.stdin !== 'closed' || plan.pty) throw new Error('Noninteractive job required.')
  if(!plan.argv[0])throw new Error('Invalid noninteractive container plan.')
  if(plan.profile.workspaceLayout!==JOB_PRIVATE_GIT_LAYOUT)throw new Error('Qualified private Git workspace layout unavailable.')
  const mounts=requireJobGitMounts(plan.execution,plan.verifiedSource)
  return podmanIsolationCreateArgv({ identity: plan.identity, sourceRoot: plan.privateRepositoryRoot,
    runtimeRoot: plan.execution.acceptedSpec.target.destination.managedRuntimeRoot, cwd: plan.cwd,
    argv: ['node','-e',JOB_COMMAND_BOOTSTRAP,'--',JOB_COMMAND_GATE,...plan.argv],
    profile: plan.profile, spoolBytes: plan.execution.acceptedSpec.policy.maxWorkerSpoolBytes,
    inputRoot: join(plan.privateRepositoryRoot, JOB_INPUT_DIRECTORY),gitDirectory:mounts.git.directory,schedulerDirectory:mounts.scheduler.directory,
    labels: { 'graphql.job.identity': plan.identity, 'graphql.job.spec': plan.execution.acceptedSpec.specDigest, 'graphql.job.attempt': plan.execution.attemptId } })
}

/** W07 supplies the absolute qualified runtime path and nonsecret controller env. */
export function spawnPodmanCommand(executable: string, argv: string[], environment: Record<string, string>) {
  if (!executable.startsWith('/') || Object.keys(environment).some(key => !['PATH', 'XDG_RUNTIME_DIR', 'LANG'].includes(key))) {
    throw new Error('Runtime command environment must be explicitly allowlisted.')
  }
  return spawn(executable, argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
}

export type { PodmanCommandRunner }

/** Bounded control replies. Job logs go through the executor's bounded streaming sink. */
export function nodePodmanCommandRunner(executable: string, environment: Record<string, string>): PodmanCommandRunner {
  return { attach: async argv => spawnPodmanCommand(executable, argv, environment), run: (argv, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const child = spawnPodmanCommand(executable, argv, environment)
    let stdout = ''; let bytes = 0
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Runtime control deadline exceeded.')) }, timeoutMs)
    const capture = (chunk: Buffer, output: boolean) => {
      bytes += chunk.length
      if (bytes > 65536) { child.kill('SIGKILL'); reject(new Error('Runtime control reply exceeded budget.')) }
      else if (output) stdout += chunk.toString('utf8')
    }
    child.stdout.on('data', chunk => capture(chunk, true))
    child.stderr.on('data', chunk => capture(chunk, false))
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', code => { clearTimeout(deadline); resolve({ exitCode: code ?? 1, stdout }) })
  }) }
}

/** Installed physical factory uses guarded original ownership and fresh entry checks. */
export function guardedPodmanCommandRunner(candidate: JobQualificationCandidate, authority: JobQualificationAuthority, owner: QualificationNativeOwner): PodmanCommandRunner {
  const prepare = async (argv: string[]) => {
    const { assertJobRuntimeEntryContext } = await import('./qualification.js')
    await authority.assertCurrent(candidate)
    await assertJobRuntimeEntryContext(candidate)
    return argv[0] === '--remote=false' ? argv : ['--remote=false', ...argv]
  }
  return {
    async run(argv, timeoutMs = 30000) {
      const { runQualificationCommand } = await import('./qualification.js')
      return runQualificationCommand(owner, candidate.fingerprint.runtimeExecutable, await prepare(argv), candidate.controllerEnvironment, AbortSignal.timeout(timeoutMs))
    },
    async attach(argv) {
      const exact = await prepare(argv)
      const reservation = await owner.reserveProcess(candidate.fingerprint.runtimeExecutable, exact)
      const child = owner.spawnProcess(reservation, candidate.fingerprint.runtimeExecutable, exact,
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: candidate.controllerEnvironment })
      if (!child.stdout || !child.stderr) throw new Error('Guarded output pipes unavailable.')
      return child
    },
  }
}

interface ContainerEvidence { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Pid: number; ExitCode: number; Status: string; Error?: string } }
function evidence(stdout: string, execution: RuntimeJobExecution): ContainerEvidence {
  const rows: unknown = JSON.parse(stdout)
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Container identity unavailable.')
  const row = rows[0] as ContainerEvidence
  if (!/^[a-f0-9]{64}$/.test(row.Id) || row.Config?.Labels?.['graphql.job.identity'] !== jobSupervisorIdentity(execution) ||
    row.Config.Labels['graphql.job.spec'] !== execution.acceptedSpec.specDigest || row.Config.Labels['graphql.job.attempt'] !== execution.attemptId ||
    typeof row.State?.Running !== 'boolean' || !Number.isInteger(row.State.Pid) || !Number.isInteger(row.State.ExitCode)) {
    throw new Error('Owned container evidence mismatch.')
  }
  return row
}

/** Only use with a persisted, human-approved qualification record; never probes/installs/pulls. */
export interface JobSupervisorDeadline {
  deadlineMs(): Promise<number>
  markTimeout(): Promise<void>
  isTimedOut(): Promise<boolean>
}
export interface VerificationSupervisorValidation {
  measurement: JobVerificationRuntimeMeasurement
  dispatchAt: string
  verifyGit(execution: VerificationExecution, source: JobLaunchPlan['verifiedSource']): Promise<void>
  verifyInputs(execution: VerificationExecution, source: JobLaunchPlan['verifiedSource'],
    receipt: JobLaunchPlan['inputs'], signal: AbortSignal): Promise<void>
}
export class PodmanJobSupervisor<Execution extends RuntimeJobExecution = JobExecution> implements JobSupervisor<Execution> {
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  private async watch(execution: Execution, stop: () => Promise<boolean>) {
    const end = this.timing ? await this.timing.deadlineMs() : Date.now() + execution.acceptedSpec.policy.executionTimeoutMs
    if (!this.watchdogs.has(execution.operationId)) {
      const timer = setTimeout(() => {
        void (async () => { try { await this.timing?.markTimeout() } finally { await stop() } })().catch(ignoreError('jobs', 'stop container after timeout', { operationId: execution.operationId }))
      }, Math.max(0, end - Date.now()))
      timer.unref(); this.watchdogs.set(execution.operationId, timer)
    }
    return end
  }
  private clearWatch(execution: Execution) {
    const timer = this.watchdogs.get(execution.operationId)
    if (timer) clearTimeout(timer)
    this.watchdogs.delete(execution.operationId)
  }
  constructor(readonly qualifiedProfile: QualifiedJobProfile | null, private readonly commands: PodmanCommandRunner,
    private readonly ownership: (execution: Execution) => Promise<OCIContainerOwnership>, private readonly timing?: JobSupervisorDeadline,
    private readonly verification?: VerificationSupervisorValidation) {}

  async reconcile(execution: Execution): Promise<{ containerId: string; stopped: boolean; exitCode: number | null; execError: boolean; timedOut: boolean; logGapPossible: true; neverStarted?: boolean } | null> {
    const reply = await this.commands.run(['container', 'inspect', jobSupervisorIdentity(execution)])
    if (reply.exitCode !== 0) return null // Missing is uncertainty, never permission to relaunch.
    const row = evidence(reply.stdout, execution)
    if (row.State.Running) await this.watch(execution, () => this.stopExecution(execution, execution.acceptedSpec.policy.cancellationGraceMs, row.Id))
    const neverStarted = row.State.Status === 'created' || row.State.Status === 'configured'
    const inspectStopped = !row.State.Running && row.State.Pid === 0 && (row.State.Status === 'exited' || neverStarted)
    const stopped = inspectStopped && await this.stopExecution(execution, 0, row.Id)
    return { containerId: row.Id, stopped, exitCode: stopped && !neverStarted ? row.State.ExitCode : null,
      execError: Boolean(row.State.Error), timedOut: await this.timing?.isTimedOut() ?? false,
      logGapPossible: true, neverStarted }
  }

  /** W08 recovery/control uses original execution scope, including after worker restart. */
  async stopExecution(execution: Execution, graceMs: number, expectedContainerId?: string): Promise<boolean> {
    const owned = new OwnedOCIContainer({ identity: jobSupervisorIdentity(execution), labels: {
      'graphql.job.identity': jobSupervisorIdentity(execution), 'graphql.job.spec': execution.acceptedSpec.specDigest,
      'graphql.job.attempt': execution.attemptId } }, this.commands, await this.ownership(execution))
    if (expectedContainerId) await owned.bind(expectedContainerId)
    const stopped = await owned.close(graceMs)
    if (stopped) this.clearWatch(execution)
    return stopped
  }

  /** Terminal evidence is persisted before removal; retries retain the original exit result. */
  async removeExecution(execution: Execution, containerId: string): Promise<void> {
    const owned = new OwnedOCIContainer({ identity: jobSupervisorIdentity(execution), originalContainerId: containerId,
      labels: { 'graphql.job.identity': jobSupervisorIdentity(execution),
        'graphql.job.spec': execution.acceptedSpec.specDigest, 'graphql.job.attempt': execution.attemptId } },
    this.commands, await this.ownership(execution))
    await owned.remove()
  }

  async launch(plan: JobLaunchPlan<Execution>) {
    if (!this.qualifiedProfile || this.qualifiedProfile.workspaceLayout!==JOB_PRIVATE_GIT_LAYOUT || plan.profile !== this.qualifiedProfile) throw new Error('Qualified isolation unavailable.')
    let createArgv: string[]
    const execution: RuntimeJobExecution = plan.execution
    if (execution.schemaVersion === 2) {
      if (!this.verification || !this.timing) throw new Error('Qualified verification validation and original deadlines unavailable.')
      requireVerificationRuntime(execution.acceptedSpec, this.verification.measurement, this.qualifiedProfile,
        Date.now(), this.verification.dispatchAt)
      requireJobGitMounts(execution, plan.verifiedSource)
      await this.verification.verifyGit(execution, plan.verifiedSource)
      await this.verification.verifyInputs(execution, plan.verifiedSource, plan.inputs,
        AbortSignal.timeout(execution.acceptedSpec.policy.preparationTimeoutMs))
      await prepareVerificationScratchDirectory(execution, this.verification.measurement)
      createArgv = podmanVerificationCreateArgv({ identity: plan.identity, execution, measurement: this.verification.measurement,
        dispatchAt: this.verification.dispatchAt,
        runtime: this.qualifiedProfile, sourceRoot: plan.privateRepositoryRoot,
        runtimeRoot: execution.acceptedSpec.target.destination.managedRuntimeRoot, cwd: plan.cwd, argv: plan.argv,
        inputRoot: join(plan.privateRepositoryRoot, JOB_INPUT_DIRECTORY),
        gitDirectory: plan.verifiedSource.gitMounts!.git.directory,
        schedulerDirectory: plan.verifiedSource.gitMounts!.scheduler.directory,
        spoolBytes: execution.acceptedSpec.policy.maxWorkerSpoolBytes })
    } else {
      await verifyJobGitMounts(execution, plan.verifiedSource)
      await verifyJobInputDirectory(execution, plan.verifiedSource, plan.inputs,
        AbortSignal.timeout(execution.acceptedSpec.policy.preparationTimeoutMs))
      createArgv = podmanCreateArgv({ ...plan, execution })
    }
    const ownership = await this.ownership(plan.execution)
    await ownership.reserveContainerIntent(plan.identity, plan.execution.acceptedSpec.specDigest)
    const owned = new OwnedOCIContainer({ identity: plan.identity, labels: { 'graphql.job.identity': plan.identity,
      'graphql.job.spec': plan.execution.acceptedSpec.specDigest, 'graphql.job.attempt': plan.execution.attemptId } }, this.commands, ownership)
    await ensureEmptyPodmanHooks(plan.execution.acceptedSpec.target.destination.managedRuntimeRoot)
    const created = await this.commands.run(createArgv, plan.execution.acceptedSpec.policy.preparationTimeoutMs)
    const containerId = created.stdout.trim()
    if (created.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Container create uncertain; reconcile original identity.')
    await owned.bind(containerId)
    const inspect = async () => {
      const reply = await this.commands.run(['container', 'inspect', containerId])
      if (reply.exitCode !== 0) throw new Error('Container inspection unavailable.')
      const row = evidence(reply.stdout, plan.execution)
      if (row.Id !== containerId) throw new Error('Container ID changed.')
      return row
    }
    await inspect()
    // Attachment carries only output; controller lifetime is provided by the W07 durable worker service.
    const end = await this.watch(plan.execution, () => owned.close(plan.execution.acceptedSpec.policy.cancellationGraceMs))
    if (end <= Date.now()) throw new Error('Original Job execution deadline exceeded before start')
    const attached = await this.commands.attach(['start', '--attach', '--sig-proxy=false', containerId])
    const { stdout, stderr } = attached
    if (!stdout || !stderr) throw new Error('Guarded container output pipes unavailable.')
    attached.once('error', error => stdout.destroy(error))
    const proveStopped = async () => {
      const row = await inspect()
      return !row.State.Running && row.State.Pid === 0 && row.State.Status === 'exited' && await owned.close(0)
    }
    const stop = async (graceMs: number) => {
      const stopped = await owned.close(graceMs)
      if (stopped) this.clearWatch(plan.execution)
      return stopped
    }
    const exited = this.commands.run(['wait', '--condition=exited', containerId], Math.max(1, end - Date.now()) + plan.execution.acceptedSpec.policy.cancellationGraceMs + 30000).then(async waited => {
      const row = await inspect()
      if (row.State.Running || row.State.Pid !== 0 || row.State.Status !== 'exited') throw new Error('Wait ended without stopped container proof.')
      this.clearWatch(plan.execution)
      if (waited.exitCode !== 0 || Number(waited.stdout.trim()) !== row.State.ExitCode) throw new Error('Container wait evidence mismatch.')
      return { exitCode: row.State.ExitCode, signal: null, ...(await this.timing?.isTimedOut() ? { timedOut: true } : {}), ...(row.State.Error ? { execError: 'Container command launch failed.' } : {}) }
    })
    void exited.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    try {
      const entryDeadline=Math.min(end,Date.now()+plan.execution.acceptedSpec.policy.preparationTimeoutMs)
      while(true){
        const row=await inspect()
        if(row.State.Running&&row.State.Pid>0)break
        if(row.State.Status==='exited'||Date.now()>=entryDeadline)throw new Error('Original gated container did not enter before its deadline.')
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      await owned.entered()
      await ownership.assertCurrent()
      if(Date.now()>=end||await this.timing?.isTimedOut())throw new Error('Original Job execution deadline exceeded before command release.')
      const release=await this.commands.run(['exec',containerId,'node','-e',JOB_COMMAND_RELEASE,'--',JOB_COMMAND_GATE],Math.min(plan.execution.acceptedSpec.policy.preparationTimeoutMs,Math.max(1,end-Date.now())))
      if(release.exitCode!==0)throw new Error('Original Job command release unconfirmed.')
    } catch (error) {
      const closed = await owned.close(plan.execution.acceptedSpec.policy.cancellationGraceMs).catch(fallbackOnError(
        false, 'jobs', 'close failed job container', { operationId: plan.execution.operationId },
      ))
      if (closed) this.clearWatch(plan.execution)
      throw error
    }
    return { containerId, stdout, stderr, exited, proveStopped, stop }
  }
}

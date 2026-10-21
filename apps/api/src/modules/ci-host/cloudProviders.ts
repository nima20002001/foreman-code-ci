import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CiHostRequest, CiDurations, CiExecutionSuite, CiHostRun, CiPart, CiScope, CiSuite, CiTestResults, CiUserSystemd } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { HostCiPorts } from './runner.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { providerCommand } from './providerPoll.js'
import { CloudHttp, type CloudRestOptions } from './cloudHttp.js'
import { GitHubRest } from './cloudGithub.js'
import { CircleRest } from './cloudCircle.js'
import { circleCiIntegrationResults } from './circleCiResults.js'
import { isCircleCreditRefusal } from './circleCreditRefusal.js'

export interface CloudRun {
  circleAccountId?: string
  runId: string; repository: string; mirror: string; commit: string; suite: CiSuite; startedAt: string
  providerRunId: string | null; state: CiHostRun['state']; finishedAt: string | null; exitCode: number | null
  message: string | null; durations?: CiDurations; testResults?: CiTestResults
  integrationCoverage?: string
  selection?: CiHostRun['selection']
  transport?: CiHostRun['transport']
  testsStarted?: boolean
  scope?: CiScope; files?: string[]; part?: CiPart; baseCommit?: string
  dispatch?: { input?: CloudDispatchInput; attempts: number; at: string; uncertain?: boolean; cancelAccepted?: boolean
    notSent?: boolean }
  reconciliation?: { attempts: number; at: string; since?: string; previousMessage: string | null }
  publicationRequest?: Extract<CiHostRequest, { operation: 'start' }>
  mirrorPublication?: CiHostRun['mirrorPublication']
  mirrorBranch?: string
  workflowStarted?: boolean
  /** When the provider was first seen holding the workflow in its own queue, without starting a job. */
  providerQueuedAt?: string
  /** Cancellation of the provider-queued workflow was requested; the ticket is requeued only once that is confirmed. */
  queueCancelRequested?: boolean
  lastProgressAt?: string
  provenance?: CiHostRun['provenance']
  collection?: { log: boolean; artifacts: boolean; unavailableAt?: string
    retry?: { since: string; attempts: number; nextAttemptAt: string } }
  cancellation?: { at: string; canceledIds: string[]; completedAt?: string; requeue?: boolean }
  /** First fresh empty observation after requesting cancellation of each accepted pipeline. */
  emptyPipelineCancellations?: Record<string, string>
  dispatchHistory?: { at: string; providerRunId: string | null; terminated?: true
    failure?: { message: string; configError: boolean } }[]
  /** Live progress kept while the run is followed: steps already written to the log, the running step's output
   * bytes written so far, and bytes written in all. */
  live?: { step: string | null; seen: string[]; output?: { key: string; bytes: number }; bytes: number }
}
export const CLOUD_START_TIMEOUT_MS = 75_000
export const CIRCLE_EMPTY_PIPELINE_RECHECK_MS = 4_000
export const CLOUD_LOG_LIMIT = 4 * 1024 * 1024
const LIVE_OUTPUT_POLL_MS = 60_000

/** One step of the provider's job; `key` stays the same across polls. */
export interface CloudStep { key: string; name: string; state: 'running' | 'passed' | 'failed' | 'skipped' }
/** The run's state with its live progress: the job's steps and, where the provider streams it, the running step's
 * output so far. */
export type CloudStatus = ({ done: false } | {
  done: true; conclusion: 'success' | 'failure' | 'cancelled'; finishedAt: string; message?: string; notStarted?: true
  /** Empty observations allow recovery, but the accepted pipeline still needs to be followed. */
  terminationUnconfirmed?: true
}) & { steps?: CloudStep[]; output?: { key: string; text: string }
  /** CircleCI has started compute; creating a pipeline or queueing a job is insufficient. */
  executionStarted?: true
  /** The provider holds the workflow in its queue: no job has started. */
  queued?: boolean }
export interface CloudDispatchInput {
  mirror: string; branch: string; snapshotCommit?: string; runId: string; suite: CiExecutionSuite; slice: string
  expectedDurationMs?: number
  gate?: boolean
  scope?: CiScope; files?: string; defaultBranch?: string; baseCommit?: string; partition?: string; durations?: string
  workflowRef?: string; workflowCommit?: string
}

/** A further CircleCI org of Main's login: a GitHub owner with a copy of the workspace mirror under the same name. */
export interface CloudAccount {
  readonly owner: string
  readonly circleAccountId?: string | undefined
  readonly role?: 'primary' | 'standby' | undefined
  registered?: boolean
  /** Mirror repository names the org has a CircleCI project for; discovery keeps it current. */
  readonly mirrorNames: Set<string>
}

/** The slot key segment of a cloud CI service: the provider, and the GitHub owner of a further CircleCI org. */
export function cloudCiId(provider: { id: string; circleAccountId?: string | undefined;
  account?: { owner: string; circleAccountId?: string | undefined } | undefined }): string {
  const login = provider.circleAccountId ?? provider.account?.circleAccountId ?? 'default'
  const prefix = provider.id === 'circleci' && login !== 'default' ? `circleci~${login}` : provider.id
  return provider.account ? `${prefix}@${provider.account.owner}` : prefix
}

/** One cloud CI service: how Main starts a run of a mirror branch and reads it back, through the service's CLI login. */
export interface CloudProvider {
  readonly id: 'github' | 'circleci'
  readonly label: string
  /** Absent for the service on the workspace mirror's own owner. */
  readonly account?: CloudAccount | undefined
  readonly circleAccountId?: string | undefined
  recoveryOnly?: boolean
  readonly transport?: CiHostRun['transport']
  /** Longest accepted pipeline parameter value, when the provider caps it. */
  readonly parameterLimit?: number
  /** Jobs the service runs at once for a public repository on its free plan, less a few kept for retries. */
  readonly slots: number
  readonly cpus: number
  readonly memoryBytes: number
  readonly loginHint: string
  readonly userSystemd: CiUserSystemd
  ready(): Promise<boolean>
  /** Starts a run; returns the service's run id when it is known at once. */
  dispatch(input: CloudDispatchInput): Promise<string | null>
  /** The service's run id once a workflow exists; a pipeline alone is not a started run. */
  find(run: CloudRun): Promise<string | null>
  /** All pipelines for this execution, including submissions whose trigger reply was lost. */
  discover?(run: CloudRun): Promise<string[]>
  status(run: CloudRun): Promise<CloudStatus>
  log(run: CloudRun): Promise<string>
  /** The measured test file durations and structured test results the run left as an artifact. */
  artifacts(run: CloudRun, directory: string): Promise<CloudArtifacts>
  /** An empty pipeline needs a second observation before ownership can be released. */
  cancel(run: CloudRun): Promise<void | false | { empty: true }>
}

export function validateProviderParameters(provider: Pick<CloudProvider, 'label' | 'parameterLimit'>,
  input: CloudDispatchInput): void {
  const limit = provider.parameterLimit ?? Number.POSITIVE_INFINITY
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > limit) {
      throw new DomainError('CI_CLOUD_UNAVAILABLE',
        `${provider.label} cannot accept ${name} longer than ${limit} characters; use another executor.`, 409)
    }
  }
}

/** The service refused because its API rate limit is spent; callers back off instead of retrying at once. */
function rateLimited(label: string, text: string, details?: Record<string, unknown>) {
  return /rate limit|\b429\b|too many requests/i.test(text)
    ? new DomainError('CI_CLOUD_RATE_LIMITED', `${label} rate limit reached; polling paused.`, 503, details) : null
}

function confirmedDispatchRefusal(file: string, args: string[], text: string): boolean {
  if (file === 'gh' && args[0] === 'workflow' && args[1] === 'run') {
    return /could not create workflow dispatch event: HTTP (?:400|401|403|404|422|429)\b/.test(text)
  }
  if (!(file === 'circleci' && args[0] === 'run' && args[1] === 'trigger')) return false
  if (/^(?:error:\s*)?(?:HTTP(?:\/\d(?:\.\d)?)?\s+|API returned\s+)(?:401|403|404|429)\b/im.test(text)) {
    return true
  }
  try {
    const failure = JSON.parse(text) as { error?: unknown; code?: unknown; message?: unknown } | null
    if (failure?.error !== true) return false
    if (failure.code === 'auth.token_invalid' || failure.code === 'run.not_found') return true
    return failure.code === 'api.error' && typeof failure.message === 'string'
      && /^API returned (?:401|403|404|429):/.test(failure.message)
  } catch {
    // Non-JSON transport errors cannot establish that the provider refused the trigger.
    return false
  }
}

async function command(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs = 120_000) {
  return providerCommand(ports, file, args, () => executeCommand(ports, label, file, args, timeoutMs))
}

async function executeCommand(ports: HostCiPorts, label: string, file: string, args: string[], timeoutMs: number) {
  const result = await ports.run(file, args, { timeoutMs })
  if (result.code !== 0) {
    // gh resolves the workflow with a GET before it sends the dispatch POST.
    const githubDispatch = file === 'gh' && args[0] === 'workflow' && args[1] === 'run'
    const workflowLookupFailed = githubDispatch
      && result.stderr.trimStart().startsWith(
        `Get "https://api.github.com/repos/${args[args.indexOf('-R') + 1]}/actions/workflows/${args[2]}":`)
    const dispatchRejected = confirmedDispatchRefusal(file, args, result.stderr)
    const notSent = workflowLookupFailed || dispatchRejected
    const limited = rateLimited(label, result.stderr, notSent ? { notSent: true } : undefined)
    if (limited) throw limited
    const noCircleArtifacts = file === 'circleci' && args[0] === 'job' && args[1] === 'artifact'
      && /\bartifacts\.not_found\b/.test(result.stderr)
    if (noCircleArtifacts) return '[]'
    const completedGitHubRun = file === 'gh' && args[0] === 'run' && args[1] === 'cancel'
      && /\bCannot cancel a workflow run that is completed\b/i.test(result.stderr)
    if (completedGitHubRun) return ''
    const noActiveWorkflows = file === 'circleci' && args[0] === 'run'
      && (args[1] === 'get' || args[1] === 'cancel') && /\bno active workflows\b/i.test(result.stderr)
    if (noActiveWorkflows) {
      if (args[1] === 'cancel') {
        throw new DomainError('CI_CLOUD_CANCEL_NOT_ACCEPTED', 'CircleCI has no active workflows to cancel.', 502)
      }
      throw new DomainError('CI_CLOUD_RUN_UNREADABLE',
        'CircleCI reports no active workflows; the final outcome is not visible yet.', 502)
    }
    const missingRun = file === 'circleci' && args[0] === 'run' && args[1] === 'get'
      && /\brun\.not_found\b/.test(result.stderr)
    if (missingRun) {
      throw new DomainError('CI_CLOUD_RUN_NOT_FOUND', 'CircleCI run is not visible.', 502, { resource: 'pipeline' })
    }
    const lookup = file === 'circleci' && args[1] === 'get' && (args[0] === 'run' || args[0] === 'job')
    const denied = /permission denied|not authorized|unauthori[sz]ed|forbidden|authentication|invalid (?:api )?token|\b40[13]\b/i
    if (lookup && denied.test(result.stderr)) {
      throw new DomainError('CI_CLOUD_RUN_UNREADABLE', `${label} execution is not readable: `
        + result.stderr.trim().slice(0, 300), 502)
    }

    const code = notSent ? 'CI_CLOUD_DISPATCH_NOT_SENT' : 'CI_CLOUD_FAILED'
    throw new DomainError(code, `${label} did not accept ${file} ${args[0]} ${args[1]}: `
      + `${result.stderr.trim().slice(0, 300)}`, 502)
  }
  return result.stdout
}

async function findFile(directory: string, name: string): Promise<string | null> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name)
  }
  return null
}

export interface CloudArtifacts {
  durations: unknown; testResults: unknown; watchdogFailure?: unknown; suiteLog?: string
  integrationCoverage?: unknown; selection?: unknown
}
const ARTIFACT_VISIBILITY_MS = 5 * 60_000
const noArtifacts: CloudArtifacts = { durations: null, testResults: null }

async function readArtifacts(directory: string): Promise<CloudArtifacts> {
  const read = async (name: string) => {
    const path = await findFile(directory, name)
    return path ? JSON.parse(await readFile(path, 'utf8')) as unknown : null
  }
  const suiteLog = await findFile(directory, 'suite.log')
  return { durations: await read('durations.json'), testResults: await read('test-results.json'),
    integrationCoverage: await read('integration-coverage.json'), selection: await read('selection.json'),
    watchdogFailure: await read('watchdog-message.json'),
    ...(suiteLog ? { suiteLog: await readFile(suiteLog, 'utf8') } : {}) }
}

const WORKFLOW = 'ci.yml'
const GITHUB_QUEUED = new Set(['queued', 'waiting', 'requested', 'pending'])

interface GitHubJob { id: number; status: string; steps?: { number: number; name: string; status: string; conclusion: string | null }[] }

/** Standard public-repository runners: 4 vCPUs and 16 GB; a free account runs 20 jobs at once. */
/** A timed out probe is a failed check, not proof that the login is gone. */
function loginProbe(result: { code: number; timedOut?: boolean }, command: string) {
  if (result.timedOut) throw new Error(`${command} timed out`)
  return result.code === 0
}

export class GitHubActionsProvider implements CloudProvider {
  readonly id = 'github' as const
  readonly label = 'GitHub Actions'
  readonly userSystemd = { supported: true, reason: null }
  readonly slots = 20
  readonly cpus = 4
  readonly memoryBytes = 16 * 2 ** 30
  readonly loginHint = 'Log in to GitHub on Main (gh auth login) to run CI on GitHub Actions.'
  private readonly jobsCache = new Map<string, { etag: string; jobs: GitHubJob[] }>()

  private readonly rest: GitHubRest

  get transport() { return this.rest.transport }

  constructor(private readonly ports: HostCiPorts, options: CloudRestOptions = {}) {
    this.rest = new GitHubRest(new CloudHttp(ports, 'github', options))
  }

  private gh(args: string[], timeoutMs = 120_000) {
    return providerCommand(this.ports, 'gh', args, async () => {
      let result: string | null = null
      const mirror = args[args.indexOf('-R') + 1]!
      if (args[0] === 'run' && args[1] === 'list') {
        const limit = Number(args[args.indexOf('--limit') + 1])
        const cliPage = limit > 200 ? (path: string, remaining: number) =>
          executeCommand(this.ports, this.label, 'gh', ['api', path], remaining) : undefined
        result = await this.rest.list(mirror, args[args.indexOf('--branch') + 1]!, limit, cliPage)
      } else if (args[0] === 'run' && args[1] === 'view') {
        result = args.includes('--log') ? await this.rest.log(mirror, args[2]!) : await this.rest.view(mirror, args[2]!)
      }
      return result ?? executeCommand(this.ports, this.label, 'gh', args, timeoutMs)
    })
  }

  async ready() {
    return loginProbe(await this.ports.run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 }), 'gh auth status')
  }

  async dispatch(input: CloudDispatchInput) {
    await this.gh(['workflow', 'run', WORKFLOW, '-R', input.mirror, '--ref', input.workflowRef ?? input.branch,
      '-f', `ref=${input.workflowRef ?? input.branch}`,
      '-f', `run_id=${input.runId}`, '-f', `suite=${input.suite}`, '-f', `slice=${input.slice}`,
      '-f', `expected_duration_ms=${input.expectedDurationMs ?? 0}`,
      ...(input.gate ? ['-f', 'gate=1'] : []),
      ...(input.scope ? ['-f', `scope=${input.scope}`] : []), ...(input.files !== undefined ? ['-f', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['-f', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['-f', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['-f', `partition=${input.partition}`] : []),
      ...(input.durations ? ['-f', `durations=${input.durations}`] : [])])
    return null
  }

  private async matches(run: CloudRun, options: { requireComplete?: boolean } = {}) {
    const branch = run.dispatch?.input?.workflowRef ?? run.dispatch?.input?.branch ?? 'main'
    const limit = options.requireComplete ? 1000 : 200
    const listed = JSON.parse(await this.gh(['run', 'list', '-R', run.mirror, '--workflow', WORKFLOW, '--branch', branch,
      '--event', 'workflow_dispatch', '--limit', String(limit), '--json', 'databaseId,displayTitle,status,headSha'], 15_000)) as
      { databaseId: number; displayTitle: string; status?: string; headSha: string }[]
    return listed.filter(value => value.displayTitle === `ci ${run.runId}`)
      .sort((left, right) => left.databaseId - right.databaseId)
  }

  async discover(run: CloudRun) {
    return (await this.matches(run, { requireComplete: true })).map(match => String(match.databaseId))
  }

  async find(run: CloudRun) {
    const matches = await this.matches(run)
    const match = matches.find(value => String(value.databaseId) === run.providerRunId) ?? matches[0]
    if (match && run.provenance && match.headSha !== run.provenance.workflowCommit) {
      await this.cancel({ ...run, providerRunId: String(match.databaseId) })
      throw new DomainError('CI_CLOUD_PROVENANCE_MISMATCH', 'The provider workflow does not match the pinned snapshot.', 409)
    }
    for (const duplicate of matches) {
      if (duplicate === match || duplicate.status === 'completed') continue
      await this.cancel({ ...run, providerRunId: String(duplicate.databaseId) })
    }
    return match ? String(match.databaseId) : null
  }

  /** The run's jobs and steps by a conditional request: an unchanged answer (304) costs no rate limit. */
  private async jobs(run: CloudRun): Promise<GitHubJob[]> {
    const id = run.providerRunId!
    const cached = this.jobsCache.get(id)
    const response = await this.rest.jobs(run.mirror, id, cached?.etag)
    if (response) {
      if (response.status === 304 && cached) return cached.jobs
      const jobs = (await this.rest.readJobs(response)).jobs
      this.cacheJobs(id, jobs, response.headers.get('etag'))
      return jobs
    }
    const result = await this.ports.run('gh', ['api', '-i', ...(cached ? ['-H', `If-None-Match: ${cached.etag}`] : []),
      `repos/${run.mirror}/actions/runs/${id}/jobs?per_page=100`], { timeoutMs: 15_000 })
    const split = /\r?\n\r?\n/.exec(result.stdout)
    const head = split ? result.stdout.slice(0, split.index) : result.stdout
    const status = Number(/^HTTP\/\S+ (\d{3})/.exec(head)?.[1])
    if (status === 304 && cached) return cached.jobs
    if (result.code !== 0 || status !== 200) {
      const limited = rateLimited(this.label, `${result.stderr}\n${status === 429 || /^x-ratelimit-remaining:\s*0\s*$/im.test(head)
        ? 'rate limit' : ''}`)
      throw limited ?? new DomainError('CI_CLOUD_FAILED', `${this.label} did not return the run's jobs: `
        + `${result.stderr.trim().slice(0, 300)}`, 502)
    }
    const jobs = (JSON.parse(result.stdout.slice(split!.index + split![0].length)) as { jobs: GitHubJob[] }).jobs
    const etag = /^etag:\s*(.+?)\s*$/im.exec(head)?.[1]
    this.cacheJobs(id, jobs, etag)
    return jobs
  }

  private cacheJobs(id: string, jobs: GitHubJob[], etag: string | null | undefined) {
    this.jobsCache.delete(id)
    if (etag) this.jobsCache.set(id, { etag, jobs })
    if (this.jobsCache.size > 200) this.jobsCache.delete(this.jobsCache.keys().next().value!)
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    const jobs = await this.jobs(run)
    const steps = jobs.flatMap(job => (job.steps ?? []).flatMap(step => {
      const state = step.status === 'in_progress' ? 'running' as const : step.status !== 'completed' ? null
        : step.conclusion === 'success' ? 'passed' as const : step.conclusion === 'skipped' ? 'skipped' as const : 'failed' as const
      return state ? [{ key: `${job.id}:${step.number}`, name: step.name, state }] : []
    }))
    // Only a finished-looking run costs an unconditional read of its conclusion.
    if (jobs.some(job => job.status !== 'completed')) {
      return { done: false, steps, ...(jobs.every(job => GITHUB_QUEUED.has(job.status)) ? { queued: true } : {}) }
    }
    const view = JSON.parse(await this.gh(['run', 'view', run.providerRunId!, '-R', run.mirror, '--json',
      'status,conclusion,updatedAt'])) as { status: string; conclusion: string; updatedAt: string }
    if (view.status !== 'completed') return { done: false, steps }
    this.jobsCache.delete(run.providerRunId!)
    return { done: true, finishedAt: view.updatedAt, steps,
      conclusion: view.conclusion === 'success' ? 'success' : view.conclusion === 'cancelled' ? 'cancelled' : 'failure' }
  }

  async log(run: CloudRun) {
    return this.gh(['run', 'view', run.providerRunId!, '-R', run.mirror, '--log'], 300_000)
  }

  async artifacts(run: CloudRun, directory: string) {
    await rm(directory, { recursive: true, force: true })
    const artifacts = await this.rest.artifacts(run.mirror, run.providerRunId!, directory)
    if (artifacts !== null) return artifacts ? readArtifacts(directory) : noArtifacts
    const downloaded = await this.ports.run('gh', ['run', 'download', run.providerRunId!, '-R', run.mirror,
      '-n', 'durations', '-D', directory], { timeoutMs: 120_000 })
    if (downloaded.code === 0) return readArtifacts(directory)
    if (/^no artifact|^no valid artifacts/i.test(downloaded.stderr.trim())) return noArtifacts
    throw rateLimited(this.label, downloaded.stderr)
      ?? new DomainError('CI_CLOUD_FAILED', 'GitHub Actions artifacts could not be downloaded.', 502)
  }

  async cancel(run: CloudRun) { await this.gh(['run', 'cancel', run.providerRunId!, '-R', run.mirror]) }
}

function circleConclusion(outcome: string | undefined): 'success' | 'failure' | 'cancelled' | null {
  if (outcome === 'succeeded') return 'success'
  if (outcome === 'canceled') return 'cancelled'
  const failures = ['failed', 'errored', 'unauthorized', 'not_run', 'skipped', 'infrastructure_fail', 'timedout']
  return failures.includes(outcome ?? '') ? 'failure' : null
}

interface CirclePipelineView {
  state?: string; phase?: string; outcome?: string; current_outcome?: string
  created_at?: string; stopped_at?: string; notStarted?: boolean
  errors?: { type: string; message: string }[]
  workflows?: { phase?: string; outcome?: string; stopped_at?: string; jobs?: { id: string }[] }[]
}

function circlePipelinePending(view: CirclePipelineView) {
  if (view.notStarted) return false
  const pendingState = [view.state, view.phase].some(state => state === 'created' || state === 'setup-pending')
  const notStarted = (view.outcome ?? view.current_outcome) === 'not_run' && !view.errors?.length
  return !view.workflows?.length && (pendingState || notStarted)
}

function circleEmptyPipeline(view: CirclePipelineView) {
  const outcome = view.outcome ?? view.current_outcome
  return view.workflows !== undefined && view.workflows.length === 0
    && (view.state === 'created' || view.phase === 'created') && (outcome === undefined || outcome === 'not_run')
}

/** Large Linux machines (4 vCPUs, 15 GB); the free plan runs 30 jobs at once and open-source Linux builds are free. */
/** The free plan runs 30 jobs at once. */
export class CircleCiProvider implements CloudProvider {
  recoveryOnly = false
  readonly id = 'circleci' as const
  readonly label: string
  readonly userSystemd = { supported: true, reason: null }
  /** CircleCI rejects pipeline parameter values longer than 512 characters. */
  readonly parameterLimit = 500
  readonly slots = 30
  readonly cpus = 4
  readonly memoryBytes = 15 * 2 ** 30
  readonly loginHint = 'Log in to CircleCI on Main (circleci auth login) and follow the CI mirror project to run CI there.'

  private readonly rest: CircleRest
  private readonly outputPolls = new Map<string, { key: string; at: number }>()

  get transport() { return this.rest.transport }
  get circleAccountId() { return this.account?.circleAccountId ?? 'default' }

  constructor(private readonly ports: HostCiPorts, options: CloudRestOptions & { http?: CloudHttp } = {}, readonly account?: CloudAccount) {
    this.label = account ? `CircleCI ${account.owner}` : 'CircleCI'
    this.rest = new CircleRest(options.http ?? new CloudHttp(ports, 'circleci', options))
  }

  private circleci(args: string[], timeoutMs = 120_000) {
    return providerCommand(this.ports, 'circleci', args, async () => {
      const result = await this.rest.command(args, timeoutMs)
      return result ?? executeCommand(this.ports, this.label, 'circleci', args, timeoutMs)
    })
  }

  async ready() {
    await this.rest.available()
    return loginProbe(await this.ports.run('circleci', ['auth', 'me'], { timeoutMs: 15_000 }), 'circleci auth me')
  }

  async dispatch(input: CloudDispatchInput) {
    validateProviderParameters(this, input)
    const started = JSON.parse(await this.circleci(['run', 'trigger', '--project', `gh/${input.mirror}`,
      '--branch', input.workflowRef ?? input.branch,
      '--parameter', `run_id=${input.runId}`, '--parameter', `suite=${input.suite}`,
      '--parameter', `slice=${input.slice}`, '--parameter', `expected_duration_ms=${input.expectedDurationMs ?? 0}`, ...(input.scope ? ['--parameter', `scope=${input.scope}`] : []),
      ...(input.gate ? ['--parameter', 'gate=1'] : []),
      ...(input.files !== undefined ? ['--parameter', `files=${input.files}`] : []),
      ...(input.defaultBranch ? ['--parameter', `default_branch=${input.defaultBranch}`] : []),
      ...(input.baseCommit ? ['--parameter', `base_commit=${input.baseCommit}`] : []),
      ...(input.partition ? ['--parameter', `partition=${input.partition}`] : []),
      ...(input.durations ? ['--parameter', `durations=${input.durations}`] : []), '--json'])) as { id: string }
    return started.id
  }

  async discover(run: CloudRun) {
    const branch = run.dispatch?.input?.workflowRef
    if (!branch || branch !== `ci/${run.commit}-${run.runId}`) {
      throw new DomainError('CI_CLOUD_SUBMISSION_UNCERTAIN',
        'CircleCI submission has no execution-specific ref; ownership retained.', 503)
    }
    const matches: { id: string; revision: string | undefined }[] = []
    const tokens = new Set<string>()
    let page: string | null = null
    let pages = 0
    do {
      if (pages++ === 10) {
        throw new DomainError('CI_CLOUD_DISCOVERY_INCOMPLETE', 'CircleCI discovery reached its page limit; ownership retained.', 503)
      }
      const query = `branch=${encodeURIComponent(branch)}`
        + (page ? `&page-token=${encodeURIComponent(page)}` : '')
      const listed = JSON.parse(await this.circleci(['api',
        `api/v2/project/gh/${run.mirror}/pipeline?${query}`, '--method', 'GET'], 15_000)) as {
        items: { id: string; vcs?: { branch?: string; revision?: string }; trigger?: { type?: string } }[]
        next_page_token?: string | null
      }
      const next = listed.next_page_token
      if (!Array.isArray(listed.items) || next !== null
        && (typeof next !== 'string' || !next || tokens.has(next))) {
        throw new DomainError('CI_CLOUD_DISCOVERY_INCOMPLETE', 'CircleCI discovery is incomplete; ownership retained.', 503)
      }
      for (const pipeline of listed.items) {
        // Publishing the ref can also create a VCS-triggered pipeline with no ticket parameters.
        if (pipeline.vcs?.branch === branch && pipeline.trigger?.type === 'api') {
          matches.push({ id: pipeline.id, revision: pipeline.vcs.revision })
        }
      }
      if (next) tokens.add(next)
      page = next
    } while (page)
    if (matches.some(pipeline => pipeline.revision !== run.provenance?.workflowCommit)) {
      throw new DomainError('CI_CLOUD_PROVENANCE_MISMATCH',
        'The CircleCI pipeline does not match the pinned snapshot.', 409)
    }
    return matches.map(pipeline => pipeline.id)
  }

  async find(run: CloudRun) {
    if (!run.providerRunId) return null
    const view = await this.pipeline(run, 15_000)
    if (view.notStarted || circleEmptyPipeline(view)) return null
    const terminal = view.phase === 'ended' && circleConclusion(view.outcome ?? view.current_outcome) !== null
    return view.workflows?.length || terminal ? run.providerRunId : null
  }

  private async readPipeline(run: CloudRun, timeoutMs?: number): Promise<CirclePipelineView> {
    return JSON.parse(await this.circleci(['run', 'get', run.providerRunId!, '--json'], timeoutMs)) as CirclePipelineView
  }

  private async pipeline(run: CloudRun, timeoutMs?: number) {
    const view = await this.readPipeline(run, timeoutMs)
    // A CLI placeholder outcome cannot finish a pipeline that is still waiting for workflows.
    if (circlePipelinePending(view)) {
      const pending = { ...view, phase: 'started' }
      if (pending.state === undefined && view.phase !== undefined) pending.state = view.phase
      return pending
    }
    const canceling = run.cancellation && !run.cancellation.completedAt
    if (!canceling && view.errors?.length && (view.phase === 'ended' || view.current_outcome === 'not_run')) {
      const message = view.errors.map(error => `${error.type}: ${error.message}`).join('; ')
      throw new DomainError('CI_CLOUD_PIPELINE_FAILED', `${this.label} pipeline failed: ${message}`, 502,
        { configError: view.errors.some(error => error.type === 'config'),
          creditRefused: view.errors.some(isCircleCreditRefusal) })
    }
    return view
  }

  private async missingPipelineConfirmed(run: CloudRun, error: unknown): Promise<boolean> {
    if (!(error instanceof DomainError && error.code === 'CI_CLOUD_RUN_NOT_FOUND'
      && error.details?.resource === 'pipeline')) return false
    if (!run.cancellation && ['starting', 'running'].includes(run.state)) return false
    const submittedAt = run.dispatch?.at ?? run.startedAt
    const since = Math.max(Date.parse(submittedAt), Date.parse(run.cancellation?.at ?? submittedAt))
    const elapsed = this.ports.now().getTime() - since
    if (!Number.isFinite(elapsed) || elapsed < CLOUD_START_TIMEOUT_MS) return false
    // CircleCI also reports missing pipelines when the credentials cannot access their project.
    const project = JSON.parse(await this.circleci(['api', `api/v2/project/gh/${run.mirror}`,
      '--method', 'GET'], 15_000)) as { slug?: string }
    return typeof project.slug === 'string' && project.slug.toLowerCase() === `gh/${run.mirror}`.toLowerCase()
  }

  private async job(run: CloudRun) {
    const view = await this.pipeline(run)
    return { job: view.workflows?.flatMap(workflow => workflow.jobs ?? [])[0] ?? null }
  }

  async status(run: CloudRun): Promise<CloudStatus> {
    let view: CirclePipelineView
    try {
      view = await this.pipeline(run)
    } catch (error) {
      if (!await this.missingPipelineConfirmed(run, error)) throw error
      return { done: true, conclusion: 'failure', notStarted: true,
        finishedAt: this.ports.now().toISOString(), message: `${this.label} has no such pipeline.` }
    }
    const empty = circleEmptyPipeline(view)
    if (empty) {
      const since = run.emptyPipelineCancellations?.[run.providerRunId!]
      if (!since || this.ports.now().getTime() - Date.parse(since) < CIRCLE_EMPTY_PIPELINE_RECHECK_MS) {
        return { done: false, steps: [] }
      }
    }
    if (view.notStarted || empty) {
      return { done: true, conclusion: 'failure', notStarted: true, steps: [],
        ...(empty ? { terminationUnconfirmed: true as const } : {}),
        finishedAt: view.stopped_at ?? this.ports.now().toISOString(),
        message: `${this.label} pipeline created no workflows or jobs.` }
    }
    const workflows = view.workflows ?? []
    const pipelineEnded = view.phase === 'ended'
    const workflowsEnded = workflows.length > 0 && workflows.every(workflow => workflow.phase === 'ended')
    const ended = pipelineEnded || workflowsEnded
    if (ended) this.outputPolls.delete(run.runId)
    let finalOutcomes: (string | undefined)[] = []
    const pipelineOutcome = view.outcome ?? view.current_outcome
    if (pipelineEnded && pipelineOutcome !== undefined) finalOutcomes = [pipelineOutcome]
    else if (ended) finalOutcomes = workflows.map(workflow => workflow.outcome)
    const stopped = [view.stopped_at, ...workflows.map(workflow => workflow.stopped_at)]
      .filter((value): value is string => value !== undefined).sort().at(-1)
    const hasFinalOutcome = finalOutcomes.some(outcome => outcome !== undefined)
    // Terminal parent status wins over child records that CircleCI has not updated yet.
    if (ended && workflows.every(workflow => !workflow.jobs?.length)) {
      return this.completed(finalOutcomes, stopped, [])
    }
    let jobs
    try {
      jobs = await Promise.all(workflows.flatMap(workflow => workflow.jobs ?? []).map(async job => ({
        id: job.id,
        detail: JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as {
          phase: string; outcome?: string; stopped_at?: string
          executions?: { steps?: { num: number; name: string; phase: string; outcome?: string }[] }[]
        },
      })))
    } catch (error) {
      // The parent outcome still settles a finished pipeline when its step details are unavailable.
      if (ended && hasFinalOutcome) {
        logIgnoredError('jobs', 'read CircleCI job details', error, { runId: run.runId })
        return this.completed(finalOutcomes, stopped, [])
      }
      throw error
    }
    const raw = jobs.flatMap(job => job.detail.executions?.flatMap(execution =>
      (execution.steps ?? []).map(step => ({ ...step, jobId: job.id }))) ?? [])
    const key = (step: { jobId: string; num: number }) => `${step.jobId}:${step.num}`
    const steps = raw.map(step => ({ key: key(step), name: step.name, state: step.phase !== 'ended' ? 'running' as const
      : step.outcome === 'succeeded' ? 'passed' as const : step.outcome === 'skipped' ? 'skipped' as const : 'failed' as const }))
    const executionStarted = jobs.some(job => job.detail.phase === 'started')
      || raw.some(step => step.phase === 'started' || step.phase === 'ended'
        && ['succeeded', 'failed', 'errored'].includes(step.outcome ?? ''))
    const progress = { steps, ...(executionStarted ? { executionStarted: true as const } : {}) }
    if (ended && hasFinalOutcome) return { ...this.completed(finalOutcomes, stopped, steps), ...progress }
    const pending = !ended && (view.phase !== undefined && view.phase !== 'ended'
      || workflows.some(workflow => workflow.phase !== undefined && workflow.phase !== 'ended'
        || !workflow.jobs?.length && workflow.phase !== 'ended' && view.phase !== 'ended')
      || jobs.some(job => job.detail.phase !== 'ended') || !workflows.length)
    if (pending) {
      // CircleCI serves the whole running step log; status polling stays frequent while output reads are bounded.
      const current = raw.findLast(step => step.phase !== 'ended')
      if (!current || (run.live?.bytes ?? 0) >= CLOUD_LOG_LIMIT) return { done: false, ...progress }
      const previous = this.outputPolls.get(run.runId)
      const now = this.ports.now().getTime()
      if (previous?.key === key(current) && now - previous.at < LIVE_OUTPUT_POLL_MS) {
        return { done: false, ...progress }
      }
      this.outputPolls.set(run.runId, { key: key(current), at: now })
      const output = await this.rest.output(current.jobId, current.num, 60_000)
      if (output !== null) {
        return { done: false, ...progress, ...(output.ok ? { output: { key: key(current), text: output.text } } : {}) }
      }
      const result = await this.ports.run('circleci', ['job', 'output', 'get', current.jobId, '--step-num', String(current.num)],
        { timeoutMs: 60_000 })
      if (result.code !== 0) {
        const limited = rateLimited(this.label, result.stderr)
        if (limited) throw limited
        logIgnoredError('jobs', 'read CircleCI live output', new DomainError('CI_CLOUD_OUTPUT_UNAVAILABLE',
          `CircleCI live output exited ${result.code}.`, 502), { runId: run.runId })
        return { done: false, ...progress }
      }
      return { done: false, ...progress, output: { key: key(current), text: result.stdout } }
    }
    const outcomes = [view.outcome, ...workflows.map(workflow => workflow.outcome),
      ...jobs.filter(job => job.detail.phase === 'ended').map(job => job.detail.outcome)]
      .filter((outcome): outcome is string => outcome !== undefined)
    const finishedAt = [stopped, ...jobs.map(job => job.detail.stopped_at)]
      .filter((value): value is string => value !== undefined).sort().at(-1)
    return { ...this.completed(outcomes, finishedAt, steps), ...progress }
  }

  private completed(outcomes: (string | undefined)[], stopped: string | undefined, steps: CloudStep[]): CloudStatus {
    const conclusions = outcomes.map(circleConclusion)
    const failed = conclusions.includes('failure')
    if (!failed && (!conclusions.length || conclusions.includes(null))) return { done: false, steps }
    let conclusion: 'success' | 'failure' | 'cancelled' = 'success'
    if (failed) conclusion = 'failure'
    else if (conclusions.includes('cancelled')) conclusion = 'cancelled'
    return { done: true, finishedAt: stopped ?? this.ports.now().toISOString(), steps, conclusion,
      ...(conclusion === 'success' ? { executionStarted: true as const } : {}) }
  }

  async log(run: CloudRun) {
    const view = await this.pipeline(run)
    const logs = await Promise.all((view.workflows ?? []).flatMap(workflow => workflow.jobs ?? []).map(async job => {
      const detail = JSON.parse(await this.circleci(['job', 'get', job.id, '--json'])) as {
        executions?: { steps?: { num: number; name: string; outcome?: string }[] }[]
      }
      const suite = (detail.executions ?? []).flatMap((execution, index) => (execution.steps ?? [])
        .filter(step => step.name === 'Suite' && step.outcome !== 'skipped')
        .map(step => ({ ...step, execution: index })))
      if (!suite.length) return this.circleci(['job', 'output', 'list', job.id, '--tail', '0'], 300_000)
      // Terminal replay can erase stderr failure lines; raw output preserves both streams.
      const output = await Promise.all(suite.map(step => this.circleci(['job', 'output', 'get', job.id,
        '--step-num', String(step.num), '--execution', String(step.execution), '--strip-ansi=false'], 300_000)))
      return `Suite\n${output.join('\n')}`
    }))
    return logs.join('\n')
  }

  async artifacts(run: CloudRun, directory: string) {
    const { job } = await this.job(run)
    if (!job) return noArtifacts
    // Read result metadata, not the per-slot logs and archives, which can outlast the download timeout.
    const listed = await this.rest.artifacts(job.id)
      ?? await this.circleci(['job', 'artifact', job.id, '--json'], 60_000)
    const finishedAt = Date.parse(run.finishedAt ?? '')
    if ((JSON.parse(listed) as unknown[]).length === 0 && run.state === 'passed'
      && !(this.ports.now().getTime() - finishedAt >= ARTIFACT_VISIBILITY_MS)) {
      // CircleCI lists a finished job's uploads with a delay; a passed job must not complete without its results.
      throw new DomainError('CI_CLOUD_FAILED', 'CircleCI job artifacts are not visible yet.', 502)
    }
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    const resultPaths = new Set(['durations/durations.json', 'durations/test-results.json',
      'durations/integration-coverage.json', 'durations/selection.json',
      'durations/watchdog-message.json', 'durations/suite.log'])
    for (const artifact of (JSON.parse(listed) as { path: string; url: string }[])
      .filter(value => resultPaths.has(value.path) || run.suite === 'integration'
        && /^integration-logs\/[^/]+\/summary\.json$/.test(value.path))) {
      if (await this.rest.download(artifact.url, join(directory, basename(artifact.path)))) continue
      await command(this.ports, this.label, 'curl',
        ['-fsSL', '--max-time', '60', '-o', join(directory, basename(artifact.path)), artifact.url], 70_000)
    }
    const artifacts = await readArtifacts(directory)
    if (run.suite === 'integration') {
      const summary = await findFile(directory, 'summary.json')
      artifacts.testResults = circleCiIntegrationResults(artifacts.testResults,
        summary ? JSON.parse(await readFile(summary, 'utf8')) as unknown : null)
    }
    return artifacts
  }

  async cancel(run: CloudRun): Promise<void | false | { empty: true }> {
    this.outputPolls.delete(run.runId)
    let view: CirclePipelineView | null
    try {
      view = await this.readPipeline(run, 15_000)
    } catch (error) {
      if (await this.missingPipelineConfirmed(run, error)) return
      if (!(error instanceof DomainError
        && ['CI_CLOUD_RUN_NOT_FOUND', 'CI_CLOUD_RUN_UNREADABLE'].includes(error.code))) throw error
      // Cancellation of the known pipeline does not require a successful status lookup.
      view = null
    }
    const terminal = view?.phase === 'ended' && !circlePipelinePending(view)
      && circleConclusion(view.outcome ?? view.current_outcome) !== null
    const workflowsEnded = view?.workflows?.length && view.workflows.every(workflow => workflow.phase === 'ended'
      && circleConclusion(workflow.outcome) !== null)
    if (view && !circleEmptyPipeline(view) && (view.notStarted || terminal || workflowsEnded)) return
    let accepted = true
    try {
      await this.circleci(['run', 'cancel', run.providerRunId!, '--force'], 15_000)
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'CI_CLOUD_CANCEL_NOT_ACCEPTED')) throw error
      accepted = false
    }
    if (!accepted) {
      // The real cancellation invalidated the poll cache, including a no-active-workflows reply.
      // Re-read through either transport: the pre-request snapshot cannot confirm emptiness.
      const after = await this.readPipeline(run, 15_000)
      if (circleEmptyPipeline(after)) return { empty: true }
    }
    if (!accepted) return false
  }
}

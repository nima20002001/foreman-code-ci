import { RetryBackoff } from '../../infrastructure/retryBackoff.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { inTransaction, withTransaction, type SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { waitForCiDispatch, withCiDatabasePriority, withoutCiDatabaseDeadline,
  withoutCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'
import { CI_DISPATCH_PASS_MS, CiDispatchDeadlineError, withCiDispatchDeadline } from './dispatchDeadline.js'
import { withProviderPoll } from './providerPoll.js'
import { CI_HOST_NAMESPACE, CiComputerRefSchema, CiRunRecordSchema, CiRunOutputSchema,
  WorkspaceSchema,
  type CiCoverageSelection, type CiDurations, type CiHostRequest, type CiHostRun, type CiHostStatus, type CiRunRecord, type CiRunInput,
  type CiCancellation, type Workspace } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../jobs/ciAuthority.js'
import { DomainError } from '../errors.js'
import { errorMessage } from '../../shared/errorMessage.js'
import { componentLogger } from '../diagnostics/logger.js'
import { reportServiceFailure, trackService } from '../diagnostics/serviceHealth.js'
import { planCiParts, runsOnCircleCi, unitPartOf } from './parts.js'
import { planIntegrationParts } from './integrationParts.js'
import { readCiSlots } from './planningCapacity.js'
import { CiPlanningSnapshot, isBackgroundYield } from './planningSnapshot.js'
import { CiComputerStatuses } from './computerStatus.js'
import { HostCiReads, retryRead } from './readQueries.js'
import { CI_QUEUE_ORDER, ciQueueReason, compareCiQueue } from './priority.js'
import { prepareCiSupersession, validateCiSupersession, supersedeCiRuns } from './supersession.js'
import { gatePartStealer, gateQueueBlock, planCiGate, readCiComputerStatus } from './gate.js'
import { CLOUD_GATE_JOB_BUDGET_MS, expectedCloudGateDurationMs } from './cloudJobLimits.js'
import { buildComputerGatePart, splitUnavailableGateParts } from './gateFallback.js'
import { buildComputerIntegrationShards, gateDispatchShards } from './capacity.js'
import { saveQueuedCiRun, ciMessages, withCiTicketLock, structuralCiStartRejection, type CiTicketSql } from './dispatch.js'
import { reconcileCiHostStart, sendCiDispatch, type CiDispatchState } from './dispatchRecovery.js'
import { CiDispatchRejections } from './dispatchRejections.js'
import { CiPrewarm } from './prewarm.js'
import { collectCiResults } from './resultCollection.js'
import { IntegrationCoverageStore } from './coverageStore.js'
import { sanitizeCiText, serializeCiJson } from './text.js'
import { isGitHubComputer, needsSystemdExecutor, supportsUserSystemd } from './computerCapabilities.js'
import { weighCiPartitions } from './partitionPlanning.js'
import { invalidateExecutorSpeeds, readExecutorSpeeds } from './executorSpeed.js'
import { readComputerNames } from '../computers/names.js'
import { readCiGateReservation, readQueuedCiRuns } from './queuedRuns.js'
import { expireCloudDispatch, requestCloud } from './cloudDispatch.js'
import { claimCiSlot, reservedCloudSlotKeys } from './cloudSlots.js'
import { cloudCiId } from './cloudProviders.js'
import { cancelAssignedCiTicket } from './assignedCancellation.js'
import { ciExecutionRunId } from './executionAttempt.js'
import { CI_RETAINED_EXECUTORS, CiExecutorObservationError, CiRetainedExecutors,
  ciExecutorOutageLimit, ciTransportUnavailable, recordCiExecutorStatus } from './executorRecovery.js'
import { CI_BUSY_TICKET, expireOverdueCiRuns } from './deadlines.js'
import { ciCachedNotice, planCachedSelection, recordCiResultCache, type CachedSelection } from './resultCacheStore.js'
import { ciRequestKey, joinCiRequest, registerCiRequest, releaseCiRequester, releaseStoppedRun,
  spareSharedSupersession } from './requestSharing.js'
import type { AgentSnapshots, CiCommits, CiMirrorInput, HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'
import type { CircleCreditsReader, CircleCreditsReading } from './circleCredits.js'
import { CircleStandby, circleOrgKey, type CircleSchedulingReading } from './circleStandby.js'

export type { AgentSnapshots, CiCommits, HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const log = componentLogger('jobs')
type PolicySnapshots = Map<string, ReadonlyMap<string, CircleSchedulingReading> | undefined>

/** Elapsed milliseconds per named phase, each measured from the previous mark. */
function phaseTimer() {
  let last = performance.now()
  const phases: Record<string, number> = {}
  return { phases, mark(name: string) { const now = performance.now(); phases[name] = Math.round(now - last); last = now } }
}

type CiRunPhase = 'dispatchWaitMs' | 'prepareMs' | 'insertMs' | 'postMs'

interface PreparedCiRuns {
  repository: NonNullable<Workspace['repository']>
  runs: CiRunRecord[]
  durations: CiDurations | null
  coverage?: CiCoverageSelection
  publication?: CiMirrorInput
  /** Result cache keys of the files the runs execute, and the log tail of a request the cache completed. */
  cacheKeys?: Record<string, string>
  logTail?: string
}

interface RunStopAudit {
  principalId: string
  source: 'http' | 'mcp'
  commandId: string
  runId: string
}

/** Runs work over every item with at most `limit` in flight. */
async function inBatches<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  }))
}

/** Main resolves and publishes the commit, then queues suite parts and integration partitions for idle CI computers. */
export class HostCiService {
  private dispatching: Promise<void> | undefined
  private dispatchRequested = false
  private cleaningTickets: Promise<void> | undefined
  private readonly observingRuns = new Map<string, Promise<void>>()
  private readonly cancelingTickets = new Map<string, Promise<{ run: CiRunRecord }>>()
  /** Observed runs whose execution is settled and whose logs and results are still being collected. */
  private readonly collectingRuns = new Set<string>()
  private observationOffset = 0
  private readonly observingComputers = new Map<string, Promise<void>>()
  private readonly cloudDispatches = new Map<string, ReturnType<typeof sendCiDispatch>>()
  private readonly policyRefreshes = new Map<string, Promise<void>>()
  private readonly computerStatusRetries = new Map<string, RetryBackoff>()
  private readonly mirrorPublications = new Map<string, { settled: boolean }>()
  /** Computers that still had a free slot after the last dispatch pass: where a canceled provider-queued ticket can go. */
  private spareComputers: HostCiComputer[] = []
  private readonly dispatchRejections = new CiDispatchRejections()
  private readonly dispatchRetry = new RetryBackoff({ initialMs: 1000, maxMs: 300_000 })
  private timer: NodeJS.Timeout | undefined
  private stoppingRuns = 0
  private readonly endpoint: HostCiEndpoint
  private readonly planningEndpoint: CiPlanningSnapshot
  /** Cloud slots kept free for non-gate tickets while a gate is queued or running. */
  private readonly reservedCloudSlots: number
  private readonly reads: HostCiReads
  private readonly circleCredits: CircleCreditsReader | undefined
  private readonly circleStandby: CircleStandby | undefined
  private readonly prewarm: CiPrewarm
  private readonly retainedExecutors: CiRetainedExecutors
  private readonly coverage = new IntegrationCoverageStore()

  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly authority: CiAuthority, private readonly commits: CiCommits,
    endpoint: HostCiEndpoint, private readonly snapshots?: AgentSnapshots, options: {
      reservedCloudSlots?: number; circleCredits?: CircleCreditsReader; circleStandby?: CircleStandby
    } = {}) {
    this.circleCredits = options.circleCredits
    this.circleStandby = options.circleStandby
    this.reservedCloudSlots = options.reservedCloudSlots ?? 0
    const statusKey = (computer: HostCiComputer) => endpoint.statusKey?.(computer) ?? canonicalJson(computer)
    const statuses = new CiComputerStatuses(this.pool,
      computer => computer.hostRef.kind === 'cloud' ? endpoint.statusKey?.(computer) : undefined,
      async (run, computer, status) => {
        await this.reconcileHostStart(run, computer, status)
        await recordCiExecutorStatus(this.pool, run, computer, status)
      })
    this.endpoint = {
      statusKey,
      computers: async () => {
        const computers = await waitForCiDispatch(() => endpoint.computers())
        this.planningEndpoint.observeComputers(computers)
        return computers
      },
      ...(endpoint.publishMirror ? { publishMirror: endpoint.publishMirror.bind(endpoint) } : {}),
      request: async (computer, request, options) => {
        const send = () => {
          const requestHost = () => options ? endpoint.request(computer, request, options) : endpoint.request(computer, request)
          // A persisted start can finish after its caller stops waiting for the reply.
          return request.operation === 'start' ? withoutCiDatabaseDeadline(requestHost) : requestHost()
        }
        if (request.operation !== 'status') {
          try {
            const reply = await waitForCiDispatch(send)
            this.planningEndpoint.observeStatus(computer, reply)
            return reply
          } catch (error) {
            if (!isBackgroundYield(error)) this.planningEndpoint.invalidate(computer)
            throw error
          }
        }
        try {
          const reply = await statuses.read(computer, () => waitForCiDispatch(send))
          this.planningEndpoint.observeStatus(computer, reply)
          return reply
        } catch (error) {
          // Yielding to foreground work says nothing about the computer; its last-known readiness stays bounded by age.
          if (!isBackgroundYield(error)) this.planningEndpoint.invalidate(computer)
          throw error
        }
      },
    }
    this.planningEndpoint = new CiPlanningSnapshot(this.endpoint)
    this.prewarm = new CiPrewarm(this.endpoint)
    this.reads = new HostCiReads(pool, authority, {
      endpoint: this.endpoint,
      computer: hostRef => this.computer(hostRef),
      smokeTargets: runs => this.smokeTargets(runs),
    })
    this.retainedExecutors = new CiRetainedExecutors(pool, this.endpoint, hostRef => this.computer(hostRef))
  }

  start(intervalMs = 1000) {
    if (this.timer) return
    this.timer = setInterval(() => { void this.dispatch() }, intervalMs)
    this.timer.unref()
    void this.dispatch()
  }

  async close() {
    clearInterval(this.timer)
    this.timer = undefined
    this.stoppingRuns += 1
    this.reads.close()
    await Promise.all([this.drain(), this.circleCredits?.close?.()])
  }

  /** Resolves when dispatch, ticket cleanup, observations and readiness reads have finished, including work they start. */
  async drain() {
    for (;;) {
      const pending = [this.dispatching, this.cleaningTickets, this.prewarm.drain(),
        ...this.observingRuns.values(), ...this.observingComputers.values(), ...this.cloudDispatches.values(),
        ...this.policyRefreshes.values(), ...this.retainedExecutors.work()]
        .filter(work => work !== undefined)
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  async run(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string | undefined }, source: 'mcp' | 'http' = 'mcp') {
    return withCiDatabasePriority(() => this.admit(caller, input, source))
  }

  private async admit(caller: ManagementPrincipal, input: CiRunInput & { workspaceId?: string | undefined },
    source: 'mcp' | 'http') {
    const started = performance.now()
    const timings = { dispatchWaitMs: 0, prepareMs: 0, insertMs: 0, postMs: 0 }
    let phase: CiRunPhase = 'prepareMs'
    let phaseStarted = started
    const markPhase = (next: CiRunPhase) => {
      const now = performance.now()
      timings[phase] += now - phaseStarted
      phase = next
      phaseStarted = now
    }
    let pausedDispatch = false
    let authorized = false
    let ticketId: string | undefined
    try {
      if ((input.gate || input.smokeComputer) && caller.audience !== 'operator') {
        if (source === 'http') await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
        throw new DomainError('ACCESS_DENIED', 'Only an Operator can request a CI gate or target a smoke computer.', 403)
      }
      const actions = CI_RUN_ACTIONS
      const scope = await this.authority.resolve(caller, input.workspaceId, actions).catch(async error => {
        if (source === 'http' && error instanceof DomainError && [401, 403, 404].includes(error.status)) {
          await this.commands.recordDenied(caller.id, source, 'ci.run', input.workspaceId ?? 'ci')
        }
        throw error
      })
      authorized = true
      const result = await this.enqueue(caller, input, source, scope, actions, markPhase, async () => {
        if (pausedDispatch) return
        // Drain an active start only when admission can supersede its ticket.
        pausedDispatch = true
        this.stoppingRuns += 1
        markPhase('dispatchWaitMs')
        try {
          await this.dispatching
        } finally {
          markPhase('prepareMs')
        }
      })
      markPhase('postMs')
      ticketId = result.ticketId
      return result
    } finally {
      if (pausedDispatch) this.stoppingRuns -= 1
      if (authorized) {
        // Dispatch owns executor cleanup; the request returns its persisted tickets.
        this.start()
        void this.dispatch()
      }
      markPhase('postMs')
      log.info({ operation: 'ci_run', source, workspaceId: input.workspaceId, commandId: input.commandId,
        ticketId, suite: input.suite, gate: input.gate ?? false, outcome: ticketId ? 'succeeded' : 'failed',
        ...timings, totalMs: performance.now() - started }, 'CI run admission timing')
    }
  }

  private async enqueue(caller: ManagementPrincipal, input: CiRunInput,
    source: 'mcp' | 'http', scope: Awaited<ReturnType<CiAuthority['resolve']>>, actions: ManagementAction[],
    markPhase: (phase: CiRunPhase) => void, pauseDispatch: () => Promise<void>) {
    const commandId = input.commandId ?? randomUUID()
    let prepared: PreparedCiRuns | undefined
    let supersession: Map<string, boolean> | undefined
    let superseded: CiRunRecord[] = []
    markPhase('insertMs')
    const outcome = await this.commands.execute({ principal: caller, source, operation: 'ci.run',
      commandId, targetKey: scope.workspaceId, payload: input,
      prepare: async () => {
        markPhase('prepareMs')
        try {
          prepared ??= await this.prepareRuns(caller, input, scope)
          supersession = input.gate ? undefined
            : await prepareCiSupersession(this.pool, this.commits, prepared.runs[0]!)
          if (supersession && [...supersession.values()].some(Boolean)) await pauseDispatch()
        } finally {
          markPhase('insertMs')
        }
      },
      preparedMutation: {
        resourceLock: `ci-admission:${scope.workspaceId}:${scope.executionId ?? caller.id}`,
        validate: async client => {
          const workspace = WorkspaceSchema.parse((await client.query<{ record: unknown }>(
            'select record from workspaces where id=$1 for share', [scope.workspaceId])).rows[0]?.record)
          if (!isDeepStrictEqual(workspace.repository, prepared!.repository)) {
            throw new DomainError('REVISION_CONFLICT', 'The workspace repository changed while preparing CI. Retry the request.', 409)
          }
          if (scope.executionId) {
            // Hold the Run lock through ticket insertion so Stop sees every admitted ticket.
            const row = (await client.query<{ stopped: boolean }>(`select
              r.stop_requested_at is not null or r.worker_credentials_closed_at is not null
                or r.execution_state='completed' as stopped
              from runs r join harness_executions e on e.run_id=r.id
              where e.id=$1 and r.workspace_id=$2 for share of r`,
            [scope.executionId, scope.workspaceId])).rows[0]
            if (!row || row.stopped) {
              throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run no longer accepts CI tickets.', 409)
            }
          }
          const candidates = await validateCiSupersession(client, prepared!.runs[0]!, supersession)
          if (!candidates) return false
          superseded = candidates
          return true
        },
      },
      authorize: async () => { await this.authority.resolve(caller, scope.workspaceId, actions) },
      perform: async client => {
        const { runs, durations, cacheKeys, logTail, coverage } = prepared!
        const { groupId, commit, priority, priorityReason, cachedFiles, initiator } = runs[0]!
        // An identical request already queued or running in this workspace is joined instead of queueing tickets.
        const requestKey = runs[0]!.state === 'queued' ? ciRequestKey(input, runs[0]!) : null
        const shared = requestKey ? await joinCiRequest(client, scope.workspaceId, requestKey, initiator, commandId) : null
        const result = shared?.output ?? CiRunOutputSchema.parse({ ticketId: runs[0]!.id,
          selection: runs[0]!.selection,
          ...(runs.length > 1 ? { partitions: runs.map(run => ({ ticketId: run.id })) } : {}),
          ...(cachedFiles?.length ? { cachedFiles } : {}) })
        if (!input.gate) {
          await supersedeCiRuns(client, { ...runs[0]!, id: result.ticketId },
            await spareSharedSupersession(client, superseded, initiator), { source, commandId })
        }
        if (shared) {
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,$2,'ci.join',$3,'succeeded',$4::jsonb)`, [caller.id, source, scope.workspaceId,
            JSON.stringify({ commandId, groupId: shared.groupId, ticketId: result.ticketId })])
          markPhase('postMs')
          return result
        }
        if (requestKey) await registerCiRequest(client, scope.workspaceId, groupId, requestKey, result)
        for (const [index, run] of runs.entries()) {
          await client.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations,result_cache_keys,log_tail,integration_selection)
            values($1,$2,$3,$6,$4::jsonb,$5::jsonb,$7::jsonb,$8,$9::jsonb)`, [run.id, run.workspaceId, groupId, serializeCiJson(run),
            durations ? serializeCiJson(durations) : null, run.state,
            cacheKeys && Object.keys(cacheKeys).length ? JSON.stringify(cacheKeys) : null, logTail ?? '',
            index === 0 && coverage ? JSON.stringify(coverage) : null])
        }
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.priority',$3,'succeeded',$4::jsonb)`, [caller.id, source, scope.workspaceId,
          JSON.stringify({ commandId, groupId, commit, priority, priorityReason,
            requestedPriority: input.priority ?? 'normal',
            ...(input.smokeComputer ? { smokeComputer: input.smokeComputer } : {}) })])
        // Receipts, commit and coordinator cleanup are visible in the post-insert phase.
        markPhase('postMs')
        return result
      },
    })
    if (prepared?.publication && !outcome.replayed && !outcome.value.joined
      && outcome.value.ticketId === prepared.runs[0]!.id) this.publishMirror(prepared.publication)
    return outcome.value
  }

  private async prepareRuns(caller: ManagementPrincipal, input: CiRunInput,
    scope: Awaited<ReturnType<CiAuthority['resolve']>>): Promise<PreparedCiRuns> {
    const workspace = WorkspaceSchema.parse((await this.pool.query<{ record: unknown }>(
      'select record from workspaces where id=$1', [scope.workspaceId])).rows[0]?.record)
    if (!workspace.repository) throw new DomainError('SOURCE_REPOSITORY_REQUIRED',
      'CI runs on build computers from GitHub. Set the workspace GitHub repository (workspace_update).', 409)
    const smokeTarget = input.smokeComputer
      ? (await this.planningEndpoint.computers()).find(computer => isDeepStrictEqual(computer.hostRef, input.smokeComputer))
      : undefined
    if (input.smokeComputer && !smokeTarget) {
      // An enabled computer drops out of the list while its Worker reconnects, for example after an API restart.
      const enabled = (await this.pool.query<{ build_enabled: boolean }>(
        "select build_enabled from build_computer_preferences where target->'hostRef'=$1::jsonb",
        [JSON.stringify(input.smokeComputer)])).rows[0]?.build_enabled
      if (enabled) throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE',
        'The smoke computer is not connected yet. Retry shortly.', 503, { retryable: true })
      throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is disabled or unavailable.', 409)
    }
    const repository = `${workspace.repository.owner}/${workspace.repository.name}`
    const defaultBranch = workspace.repository.defaultBranch
    // An Agent's CI tests its current files; they are published to GitHub so build computers can fetch them.
    const timing = phaseTimer()
    const snapshot = scope.executionId && !input.commit && this.snapshots ? await this.snapshots(scope.executionId) : null
    const commit = await this.commits.resolve(repository, defaultBranch, input.commit, snapshot)
    timing.mark('commitMs')
    const inventories = Promise.all([
      ['unit', 'integration'].includes(input.suite) ? this.learnedDurations(repository) : null,
      input.suite === 'integration' ? this.commits.integrationInventory?.(repository, commit) : undefined,
    ])
    const mirror = workspace.ciMirror ? `${workspace.ciMirror.owner}/${workspace.ciMirror.name}` : undefined
    const planning = this.planningForMirror(workspace.ciMirror?.name)
    // Unit and gate durations are only final once the unit inventory is read; they publish then, so dispatch reuses the push.
    const prepareCoverage = input.suite === 'integration' && (input.scope ?? 'affected') === 'affected'
      && input.files === undefined
    const publishLater = input.suite === 'unit' || input.gate === true || prepareCoverage
    const publishEarly = (finalDurations: CiDurations, deriveFiles: boolean) => {
      if (!mirror || !this.endpoint.publishMirror) return
      this.publishMirror({ repository, mirror, commit,
        ...(deriveFiles && !input.baseCommit ? { defaultBranch } : {}),
        ...(deriveFiles && input.baseCommit ? { baseCommit: input.baseCommit } : {}),
        durations: finalDurations })
    }
    if (!publishLater) {
      void inventories.then(([learned, integration]) => {
        const merged = { ...integration?.durations, ...learned }
        const durations = input.suite === 'integration' && integration
          ? Object.fromEntries(integration.files.filter(file => merged[file] !== undefined)
            .map(file => [file, merged[file]!])) : learned ?? {}
        publishEarly(input.suite === 'integration' ? durations : {},
          (input.scope ?? 'affected') === 'affected' && input.files === undefined)
      }).catch(error => {
        log.warn({ err: error, commit, mirror }, 'Early CI mirror publication failed; dispatch will retry')
      })
    }
    const [infrastructure, branch, capabilities, [earlyLearned, earlyIntegration]] = await Promise.all([
      this.commits.infrastructureOnly?.(repository, commit) ?? false,
      this.commits.branch?.(repository, defaultBranch, commit),
      this.commits.capabilities(repository, commit),
      inventories,
    ])
    timing.mark('commitFactsMs')
    const priority = input.gate || infrastructure || input.priority === 'high' ? 'high' : 'normal'
    let priorityReason: CiRunRecord['priorityReason'] = 'normal'
    if (input.gate) priorityReason = 'gate'
    else if (infrastructure) priorityReason = 'ci-infrastructure'
    else if (input.priority === 'high') priorityReason = 'requested'
    const groupId = randomUUID()
    const now = new Date().toISOString()
    const [inventory, learned, integration] = await Promise.all([
      capabilities.parts && (input.suite === 'unit' || input.gate)
        ? this.commits.unitInventory?.(repository, commit) : undefined,
      earlyLearned,
      capabilities.integrationPartitions ? earlyIntegration : undefined,
    ])
    timing.mark('inventoryMs')
    if (input.gate && (!capabilities.parts || !integration || !inventory)) {
      throw new DomainError('CI_GATE_UNSUPPORTED', 'This repository must provide CI suite hooks and complete test inventories for a gate.', 409)
    }
    let durations = input.suite === 'integration' ? learned : null
    if (integration) {
      const merged = { ...integration.durations, ...learned }
      durations = Object.fromEntries(integration.files.filter(file => merged[file] !== undefined)
        .map(file => [file, merged[file]!]))
    }
    const unitDurations = { ...inventory?.durations, ...learned }
    const supportsSelection = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.affected
    if (smokeTarget && !supportsSelection) {
      throw new DomainError('CI_SMOKE_UNSUPPORTED', 'CI smoke requires a repository with affected test selection.', 409)
    }
    if (!supportsSelection && (input.scope === 'affected' || input.files !== undefined)) {
      throw new DomainError('CI_SELECTION_UNSUPPORTED',
        'This repository has no affected test selection. Request scope full and omit files.', 409)
    }
    const selectionScope = supportsSelection ? input.scope ?? 'affected' : 'full'
    const deriveFiles = selectionScope === 'affected' && input.files === undefined
    const coverage = deriveFiles && input.suite === 'integration'
      ? await this.coverage.selection(repository, commit, this.commits) : undefined
    const selection = { ...input, scope: selectionScope, files: selectionScope === 'affected' ? input.files : [] }
    // Gates, full scope and smoke runs always run every file; only explicit affected test selections use the cache.
    let cache: CachedSelection | undefined
    if (!input.gate && !smokeTarget && selectionScope === 'affected' && input.files?.length && this.commits.testTree
      && (input.suite === 'unit' || input.suite === 'integration')) {
      const testTree = this.commits.testTree.bind(this.commits)
      cache = await planCachedSelection(this.pool, { workspaceId: scope.workspaceId, repository, commit,
        suite: input.suite, files: input.files, tree: signal => testTree(repository, commit, signal),
        partOf: file => input.suite === 'unit' && capabilities.parts ? unitPartOf(file, inventory?.heavy ?? []) : input.suite })
      selection.files = cache.files
    }
    const cachedFiles = cache?.cached.length ? cache.cached : undefined
    const empty = selectionScope === 'affected' && selection.files?.length === 0
    const split = input.suite === 'integration' ? capabilities.integrationPartitions : capabilities.parts
    let parts: { part: CiRunRecord['part']; partition: CiRunRecord['partition']; files: string[];
      expectedDurationMs?: number; suite?: CiRunRecord['suite']; plannedHostKey?: string;
      integrationShards?: number; requiresBuildComputer?: boolean }[] = split ? planCiParts(selection, unitDurations, inventory)
      : [{ part: null, partition: null, files: selection.files ?? [] }]
    let smokeShards: number | undefined
    if (smokeTarget && input.suite === 'integration') {
      const status = await planning.request(smokeTarget, { operation: 'status' }).catch(error => {
        if (error instanceof DomainError) throw error
        // A Worker that is still reconnecting after a restart is temporarily unavailable, not an API failure.
        throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is not reachable yet. Retry shortly.', 503,
          { retryable: true }, { cause: error })
      })
      if (status.operation !== 'status' || !status.ready) {
        throw new DomainError('CI_SMOKE_COMPUTER_UNAVAILABLE', 'The smoke computer is not ready.', 409)
      }
      smokeShards = buildComputerIntegrationShards(status, smokeTarget.buildAllowancePercent)
      const fleet = await planning.computers()
      if (integration && fleet.some(computer => computer.hostRef.kind !== 'cloud')
        && fleet.some(computer => computer.hostRef.kind === 'cloud')) {
        const smokeUnit = await this.commits.unitInventory?.(repository, commit)
        if (smokeUnit) {
          try { await planCiGate(input, integration, smokeUnit, unitDurations, planning, new Map(), this.reservedCloudSlots) }
          catch (error) {
            if (!(error instanceof DomainError) || error.code !== 'CI_GATE_CAPACITY_REQUIRED') throw error
            log.info({ reason: error.message }, 'CI smoke has no complete ready gate fleet')
          }
        }
      }
      parts = [{ part: null, partition: null, files: input.files! }]
    } else if (input.gate) {
      const speeds = await readExecutorSpeeds(this.pool, planning)
      timing.mark('speedsMs')
      const slots = await readCiSlots(this.pool, planning)
      timing.mark('slotsMs')
      parts = await planCiGate(input, { ...integration!, durations: durations! }, inventory!, unitDurations, planning,
        speeds, this.reservedCloudSlots, slots.ordinary, slots.usedByComputer)
    } else if (integration) {
      const slots = await readCiSlots(this.pool, planning)
      parts = planIntegrationParts(selection, { ...integration, durations: durations! }, slots.eligible, slots.ordinary)
    }
    if (!input.gate && input.suite === 'unit' && split) {
      parts = planCiParts(selection, unitDurations, inventory, (await readCiSlots(this.pool, planning)).eligible.ordinary)
    }
    timing.mark('planMs')
    log.info({ gate: input.gate === true, suite: input.suite, ...timing.phases }, 'CI run preparation timing')
    let selectionReason = 'Caller supplied the affected files.'
    if (selectionScope === 'full') selectionReason = 'Full scope requested; every file in the suite or partition runs.'
    if (deriveFiles) selectionReason = 'Affected files will be selected on the runner.'
    const runs = parts.map((planned, index) => CiRunRecordSchema.parse({
      ...planned,
      ...(index === 0 && cachedFiles ? { cachedFiles } : {}),
      expectedDurationMs: planned.expectedDurationMs ?? (input.suite === 'unit' ? 210_000 : 150_000),
      ...(smokeTarget ? { plannedHostKey: smokeTarget.key,
        ...(smokeShards !== undefined ? { integrationShards: smokeShards } : {}) } : {}),
      id: randomUUID(), workspaceId: scope.workspaceId,
      suite: planned.suite ?? input.suite, scope: selectionScope, commit, repository, groupId,
      selection: { scope: selectionScope, files: planned.files ?? input.files ?? [], reason: selectionReason },
      ciMirror: workspace.ciMirror ? `${workspace.ciMirror.owner}/${workspace.ciMirror.name}` : null,
      priority, priorityReason,
      ...(input.gate ? { gate: true, noSupersede: true } : {}),
      defaultBranch,
      ...(branch !== undefined ? { branch } : {}),
      ...(!input.gate && input.noSupersede !== undefined ? { noSupersede: input.noSupersede } : {}),
      ...(smokeTarget ? { noSupersede: true } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(deriveFiles ? { deriveFiles } : {}),
      state: empty ? 'passed' : 'queued', computer: null, step: empty ? input.suite : null,
      exitCode: empty ? 0 : null,
      message: empty ? (cachedFiles ? `All ${cachedFiles.length} selected files already passed with identical inputs; `
        + 'see cachedFiles.' : 'No affected files for this suite.') : null,
      queuedAt: now, startedAt: empty ? now : null, finishedAt: empty ? now : null,
      initiator: { principalId: caller.id, executionId: scope.executionId ?? null } }))
    const measuredUnitDurations = Object.fromEntries((inventory?.files ?? []).filter(file => unitDurations[file] !== undefined)
      .map(file => [file, unitDurations[file]!]))
    if (Object.keys(measuredUnitDurations).length) durations = { ...durations, ...measuredUnitDurations }
    if (publishLater && !prepareCoverage) publishEarly(durations ?? {}, !input.gate && deriveFiles)
    const publication: CiMirrorInput | undefined = prepareCoverage && mirror ? {
      repository, mirror, commit, durations: durations ?? {},
      ...(deriveFiles && input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(deriveFiles && !input.baseCommit ? { defaultBranch } : {}),
      ...(coverage ? { integrationCoverage: coverage } : {}),
    } : undefined
    return { repository: workspace.repository, runs, durations,
      ...(coverage ? { coverage } : {}), ...(publication ? { publication } : {}),
      ...(cache && !empty ? { cacheKeys: cache.keys } : {}),
      ...(empty && cachedFiles ? { logTail: ciCachedNotice(cachedFiles) } : {}) }
  }

  private async smokeTargets(runs: CiRunRecord[]): Promise<Map<string, HostRef>> {
    const groups = [...new Set(runs.filter(run => run.noSupersede && run.plannedHostKey && !run.gate)
      .map(run => run.groupId))]
    if (!groups.length) return new Map()
    // Audit details preserve the target without changing the record shape read by a retained release.
    const rows = (await this.pool.query<{ group_id: string; target: unknown }>(`select
      details->>'groupId' as group_id, details->'smokeComputer' as target from management_audit
      where action='ci.priority' and details->>'groupId'=any($1::text[]) and details ? 'smokeComputer'`,
    [groups])).rows
    return new Map(rows.map(row => [row.group_id, CiComputerRefSchema.parse(row.target)]))
  }

  /** The repository's learned test file durations, most recently measured first, within the start request's
   * bound. Files no run has measured use the planner's median or equal-weight fallback. */
  private async learnedDurations(repository: string): Promise<CiDurations | null> {
    const rows = (await this.pool.query<{ file: string; duration_ms: number }>(`select file,duration_ms from ci_file_durations
      where repository=$1 order by updated_at desc,file limit 1000`, [repository])).rows
    return rows.length ? Object.fromEntries(rows.map(row => [row.file, row.duration_ms])) : null
  }

  /** Folds a finished run's measured file durations into the repository's history: an exponential moving
   * average per file, so one slow run moves the expectation only halfway. */
  private async learnDurations(repository: string, durations: CiDurations, sql: SqlQuery) {
    const files = Object.keys(durations)
    if (!files.length) return
    await sql.query(`insert into ci_file_durations(repository,file,duration_ms)
      select $1,file,greatest(1,round(ms))::integer from unnest($2::text[],$3::double precision[]) as measured(file,ms)
      on conflict (repository,file) do update set
        duration_ms=greatest(1,round((ci_file_durations.duration_ms+excluded.duration_ms)/2.0))::integer,
        samples=ci_file_durations.samples+1, updated_at=now()`, [repository, files, files.map(file => durations[file])])
  }

  private async read(id: string, workspaceId: string, sql: SqlQuery = this.pool): Promise<CiRunRecord> {
    const row = (await sql.query<{ record: unknown }>('select record from ci_runs where id=$1 and workspace_id=$2',
      [id, workspaceId])).rows[0]
    if (!row) throw new DomainError('CI_RUN_NOT_FOUND', 'No such CI run in this workspace.', 404)
    return CiRunRecordSchema.parse(row.record)
  }

  get(caller: ManagementPrincipal, input: Parameters<HostCiReads['get']>[1], signal?: AbortSignal) {
    return this.reads.get(caller, input, signal)
  }

  tests(caller: ManagementPrincipal, input: Parameters<HostCiReads['tests']>[1]) {
    return this.reads.tests(caller, input)
  }

  list(caller: ManagementPrincipal, input: Parameters<HostCiReads['list']>[1]) {
    return this.reads.list(caller, input)
  }

  logs(caller: ManagementPrincipal, input: Parameters<HostCiReads['logs']>[1]) {
    return this.reads.logs(caller, input)
  }

  async cancel(caller: ManagementPrincipal,
    input: { workspaceId?: string | undefined; ticketId: string; commandId?: string | undefined },
    source: 'http' | 'mcp' = 'mcp'): Promise<{ run: CiRunRecord; detached?: { remainingRequesters: number } }> {
    const scope = await this.authority.resolve(caller, input.workspaceId, CI_RUN_ACTIONS)
    const row = await this.reads.readTicket(caller, scope, { ticketId: input.ticketId, logTail: false })
    const run = CiRunRecordSchema.parse(row.record)
    if (['queued', 'starting', 'running'].includes(run.state)) {
      // A requester of a group that identical requests share only leaves it while others still need it.
      const remainingRequesters = await releaseCiRequester(this.pool, run,
        { principalId: caller.id, executionId: scope.executionId ?? null })
      if (remainingRequesters) return { run, detached: { remainingRequesters } }
    }
    this.stoppingRuns += 1
    try {
      // Persist intent before trying the executor lock, even while its start reply is pending.
      return await this.cancelTicket(scope.workspaceId, run.id, {
        principalId: caller.id, source, commandId: input.commandId ?? randomUUID(), reason: 'direct',
      })
    } finally {
      this.stoppingRuns -= 1
    }
  }

  /** The persisted, authorized Stop intent authorizes cleanup of its Agents' tickets. */
  async cancelStoppedRun(runId: string): Promise<void> {
    const intent = (await this.pool.query<{ workspace_id: string; record: RunStopAudit }>(
      `select workspace_id,record from workflow_stop_intents where run_id=$1
        order by principal_id,command_id limit 1`, [runId])).rows[0]
    if (!intent) return
    this.stoppingRuns += 1
    try {
      // Groups other requesters still share keep running; the Run's Agents only leave them.
      const groups = await releaseStoppedRun(this.pool, runId, intent.workspace_id)
      const tickets = async () => groups.length ? (await this.pool.query<{ id: string }>(`select id from ci_runs
        where workspace_id=$1 and group_id=any($2::uuid[]) and state in ('queued','starting','running')
        order by id`, [intent.workspace_id, groups])).rows : []
      const audit: CiCancellation = {
        principalId: intent.record.principalId,
        source: intent.record.source,
        commandId: intent.record.commandId,
        runId,
        reason: 'run_stop',
      }
      const assigned = await tickets()
      const initial = await Promise.allSettled(assigned.map(ticket =>
        this.cancelTicket(intent.workspace_id, ticket.id, audit)))
      // Stop reaches assigned executors before pending Start replies release their dispatch claims.
      await this.dispatching
      const retryIds = initial.flatMap((result, index) =>
        result.status === 'rejected' ? [assigned[index]!.id] : [])
      const remaining = new Set([...retryIds, ...(await tickets()).map(ticket => ticket.id)])
      const results = await Promise.allSettled([...remaining].map(id =>
        this.cancelTicket(intent.workspace_id, id, audit)))
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Run CI cancellation is incomplete.')
    } finally {
      this.stoppingRuns -= 1
    }
  }

  private cancelTicket(workspaceId: string, ticketId: string,
    audit?: CiCancellation): Promise<{ run: CiRunRecord }> {
    const pending = this.cancelingTickets.get(ticketId)
    if (pending) return pending
    // Cleanup and observations share one delivery while its executor reply is pending.
    const cancellation = this.cancelTicketAttempt(workspaceId, ticketId, audit)
      .finally(() => { this.cancelingTickets.delete(ticketId) })
    this.cancelingTickets.set(ticketId, cancellation)
    return cancellation
  }

  private async cancelTicketAttempt(workspaceId: string, ticketId: string,
    audit?: CiCancellation): Promise<{ run: CiRunRecord }> {
    let run = await this.read(ticketId, workspaceId)
    audit = run.cancellation ?? audit
    if (run.state === 'queued') {
      const message = run.supersededBy ? `superseded by ${run.supersededBy}` : 'Canceled.'
      const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message,
        cancellation: undefined, dispatchRequest: undefined }
      const hostKey = run.executorCleanupPending ? 'host_key' : 'null'
      const saved = await this.saveCancellation(`update ci_runs set state='canceled', host_key=${hostKey}, record=$2::jsonb
        where id=$1 and state='queued' and record->>'supersededBy' is not distinct from $3`,
      [run.id, serializeCiJson(canceled), run.supersededBy ?? null], canceled, audit)
      if (!saved.rowCount) return this.cancelTicketAttempt(workspaceId, ticketId, audit)
      return { run: canceled }
    }
    if (run.computer && ['starting', 'running'].includes(run.state)) {
      if (!run.cancellation) {
        const cancellation = audit ?? { principalId: run.initiator.principalId, source: 'mcp' as const,
          commandId: randomUUID(), reason: 'superseded' as const }
        const pending = { ...run, cancellation }
        const saved = await this.pool.query(`update ci_runs set record=$2::jsonb
          where id=$1 and state in ('starting','running') and record=$3::jsonb`,
        [run.id, JSON.stringify(pending), JSON.stringify(run)])
        if (!saved.rowCount) return this.cancelTicketAttempt(workspaceId, ticketId, audit)
        run = pending
        audit = cancellation
      }
      const handled = await withCiTicketLock(this.pool, run.id, async client => {
        const current = await this.read(run.id, workspaceId, client)
        if (current.computer && ['starting', 'running'].includes(current.state)) {
          await this.cancelAssignedTicket(current, client, current.cancellation ?? audit)
        }
        return true
      })
      if (!handled) {
        // Start can hold the claim while waiting on I/O. Signal Stop now; only the claim owner may settle.
        const current = await this.read(run.id, workspaceId)
        if (current.cancellation && current.computer && ['starting', 'running'].includes(current.state)) {
          const computer = await this.computer(current.computer.hostRef)
          await cancelAssignedCiTicket(this.endpoint, computer, current)
        }
      }
    }
    const current = await this.read(run.id, workspaceId)
    const reassigned = ['starting', 'running'].includes(current.state)
      && JSON.stringify(current.computer) !== JSON.stringify(run.computer)
    if (current.state === 'queued' || reassigned) return this.cancelTicketAttempt(workspaceId, ticketId, audit)
    if ((audit || run.supersededBy) && ['starting', 'running'].includes(current.state)) {
      throw new DomainError('CI_CANCEL_PENDING', 'The build computer has not canceled the CI ticket.', 409)
    }
    return { run: current }
  }

  private async cancelAssignedTicket(run: CiRunRecord, sql: CiTicketSql, audit?: CiCancellation) {
    const computer = await this.computer(run.computer!.hostRef)
    const state = await cancelAssignedCiTicket(this.endpoint, computer, run)
    await sql.transaction(async client => {
      // Observations can update the ticket while the executor acknowledges cancellation.
      await client.query('select id from ci_runs where id=$1 for update', [run.id])
      const current = await this.read(run.id, run.workspaceId, client)
      if (!['starting', 'running'].includes(current.state)
        || !isDeepStrictEqual(current.computer?.hostRef, run.computer!.hostRef)
        || ciExecutionRunId(current) !== ciExecutionRunId(run)) return
      await this.settle(current, computer, state, { client, audit })
    })
  }

  private async cancelObsoleteTickets() {
    const rows = (await this.pool.query<{ record: unknown }>(`select record from ci_runs
      where state in ('queued','starting','running') and (record->>'supersededBy' is not null
        or record->>'gate'='true' and exists (
          select 1 from ci_runs failed where failed.workspace_id=ci_runs.workspace_id
            and failed.group_id=ci_runs.group_id and failed.state='failed' and failed.record->>'gate'='true'))`)).rows
    const runs = rows.map(row => CiRunRecordSchema.parse(row.record))
    let canceled = false
    await inBatches(runs, 8, async run => {
      try {
        const audit: CiCancellation | undefined = run.supersededBy ? undefined : {
          principalId: run.initiator.principalId, source: 'mcp', commandId: randomUUID(), reason: 'gate_failed',
        }
        const result = await this.cancelTicket(run.workspaceId, run.id, audit)
        if (result.run.state === 'canceled') canceled = true
      } catch (error) {
        log.warn({ err: error, runId: run.id }, 'CI ticket cleanup failed; retrying')
      }
    })
    if (canceled) void this.dispatch()
  }

  private async saveCancellation(sql: string, parameters: unknown[], run: CiRunRecord,
    audit?: CiCancellation, client?: pg.PoolClient) {
    if (!audit || run.state !== 'canceled') return (client ?? this.pool).query(sql, parameters)
    return inTransaction(this.pool, client, async client => {
      const saved = await client.query(sql, parameters)
      if (saved.rowCount) {
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'ci.cancel',$3,'succeeded',$4::jsonb)`,
        [audit.principalId, audit.source, `ci:${run.id}`, JSON.stringify({
          commandId: audit.commandId, runId: audit.runId, ticketId: run.id,
          executionId: run.initiator.executionId, reason: audit.reason,
        })])
      }
      return saved
    })
  }

  async computers(caller: ManagementPrincipal, input: { workspaceId?: string | undefined }) {
    return retryRead(async () => {
      const scope = await this.authority.resolve(caller, input.workspaceId, CI_GET_ACTIONS)
      const queued = (await this.pool.query<{ record: unknown; position: number }>(`select record,position from
        (select record,row_number() over (order by ${CI_QUEUE_ORDER})::integer as position
          from ci_runs where state='queued') queue where record->>'workspaceId'=$1
          and ($2::text is null or record#>>'{initiator,executionId}'=$2)
        order by position limit 501`, [scope.workspaceId,
        caller.audience === 'worker' ? scope.executionId ?? '' : null])).rows
      const queue = queued.slice(0, 500).map(row => {
        const run = CiRunRecordSchema.parse(row.record)
        return { ticketId: run.id, priority: run.priority, priorityReason: run.priorityReason,
          position: row.position, reason: ciQueueReason(run) }
      })
      const active = (await this.pool.query<{ id: string; host_key: string; record: unknown }>(
        `select id,host_key,record from ci_runs where state in ('starting','running') and host_key is not null
          order by created_at,id`)).rows
      const readComputer = async (computer: HostCiComputer) => {
        const assigned = active.filter(run => run.host_key === computer.key)
        // A starting ticket needs a live status: it can acknowledge a start whose reply was lost.
        const starting = assigned.some(run => CiRunRecordSchema.parse(run.record).state === 'starting')
        const status = await (starting ? this.endpoint : this.planningEndpoint).request(computer, { operation: 'status' })
          .catch(error => error as Error)
        const running = []
        for (const row of assigned) {
          const previous = CiRunRecordSchema.parse(row.record)
          const current = previous.state === 'starting' && !previous.startedAt
            ? await this.read(row.id, previous.workspaceId) : previous
          if (['starting', 'running'].includes(current.state)) running.push(row.id)
        }
        return status instanceof Error
          ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            buildAllowancePercent: computer.buildAllowancePercent ?? 100,
            ready: false, reasons: [status.message], running, slotsUsed: running.length,
            slotsTotal: Math.max(1, running.length) }
          : status.operation === 'status' ? { label: computer.label, hostRef: computer.hostRef, priority: computer.priority,
            buildAllowancePercent: status.buildAllowancePercent ?? computer.buildAllowancePercent ?? 100,
            allowedCpuCount: status.cpuCount,
            ready: status.ready, reasons: status.reasons, cpuCount: status.cpuCount, memoryBytes: status.memoryBytes,
            availableMemoryBytes: status.availableMemoryBytes,
            ...(status.userSystemd ? { userSystemd: status.userSystemd } : {}),
            slotsUsed: Math.max(running.length, status.slotsUsed ?? 0), slotsTotal: status.slotsTotal ?? 1,
            running } : null
      }
      const fleet = await this.endpoint.computers()
      // Bound status requests and ticket readback before they acquire shared-pool connections.
      const concurrency = Math.min(8, Math.max(1, Math.floor((this.pool.options?.max ?? 10) / 2)))
      const result: Awaited<ReturnType<typeof readComputer>>[] = []
      for (let offset = 0; offset < fleet.length; offset += concurrency) {
        result.push(...await Promise.all(fleet.slice(offset, offset + concurrency).map(readComputer)))
      }
      const readings = new Map<string, Promise<CircleCreditsReading>>()
      const computers = result.flatMap(computer => {
        if (!computer) return []
        const host = computer.hostRef
        if (!this.circleCredits || host.kind !== 'cloud' || host.provider !== 'circleci') return [Promise.resolve(computer)]
        const key = circleOrgKey(host.account ?? '', host.circleAccountId)
        if (!readings.has(key)) readings.set(key, host.account && this.circleStandby
          ? this.circleStandby.reading(host.account, host.circleAccountId)
          : this.circleCredits.reading(host.account, host.circleAccountId))
        return [readings.get(key)!.then(reading => ({ ...computer, ...reading }))]
      })
      return { computers: await Promise.all(computers), queue, queueTruncated: queued.length > 500 }
    })
  }

  private refreshSchedulingPolicy(mirrorName?: string) {
    const selector = this.circleStandby!
    const key = mirrorName ?? ''
    if (this.policyRefreshes.has(key)) return
    const previous = selector.snapshot(mirrorName)
    const refresh = selector.roles(mirrorName).then(roles => {
      const changed = !previous || previous.size !== roles.size
        || [...roles].some(([owner, reading]) => previous.get(owner)?.schedulingRole !== reading.schedulingRole)
      if (changed) void this.dispatch()
    }).catch(error => {
      log.warn({ operation: 'refresh CircleCI scheduling policy', err: error }, 'CircleCI scheduling policy refresh failed')
    }).finally(() => { this.policyRefreshes.delete(key) })
    this.policyRefreshes.set(key, refresh)
  }

  private async schedulingFleet(computers: HostCiComputer[], options: {
    mirrorName?: string | undefined; snapshots?: PolicySnapshots
  } = {}): Promise<HostCiComputer[]> {
    if (!this.circleStandby) return computers
    const { mirrorName, snapshots } = options
    let roles: ReadonlyMap<string, CircleSchedulingReading> | undefined
    if (snapshots) {
      const key = mirrorName ?? ''
      if (!snapshots.has(key)) {
        this.refreshSchedulingPolicy(mirrorName)
        snapshots.set(key, this.circleStandby.snapshot(mirrorName))
      }
      roles = snapshots.get(key)
    } else roles = await this.circleStandby.roles(mirrorName)
    const probes = new Set<string>()
    return computers.filter(computer => {
      const host = computer.hostRef
      if (host.provider !== 'circleci') return true
      if (!host.account) return false
      const key = circleOrgKey(host.account, host.circleAccountId)
      const reading = roles?.get(key)
      if (reading?.schedulingRole === 'active') return true
      if (!reading?.creditProbeAvailable || probes.has(key)) return false
      probes.add(key)
      return true
    })
  }

  private planningForMirror(mirrorName?: string): HostCiEndpoint & Pick<CiPlanningSnapshot, 'lastStatus'> {
    return {
      computers: async () => this.schedulingFleet(await this.planningEndpoint.computers(), { mirrorName }),
      request: (computer, request) => this.planningEndpoint.request(computer, request),
      lastStatus: computer => this.planningEndpoint.lastStatus(computer),
    }
  }

  private async computer(hostRef: HostRef) {
    const computer = (await this.endpoint.computers()).find(value => JSON.stringify(value.hostRef) === JSON.stringify(hostRef))
    if (computer) return computer
    // Disabling future builds does not prevent reading or cancelling an assigned run.
    if (hostRef.kind === 'main') {
      const key = `${hostRef.mainId}:main`
      return { key, hostRef, label: (await readComputerNames(this.pool, hostRef.mainId)).get(key) ?? 'Main computer', priority: 0 }
    }
    if (hostRef.kind === 'device' && hostRef.deviceId) {
      const key = `${hostRef.mainId}:${hostRef.deviceId}`
      return { key, hostRef, priority: 0,
        label: (await readComputerNames(this.pool, hostRef.mainId)).get(key) ?? `Computer ${hostRef.deviceId.slice(0, 8)}` }
    }
    if (hostRef.kind === 'cloud' && hostRef.provider) {
      const account = hostRef.account ? { owner: hostRef.account } : undefined
      return { key: `${hostRef.mainId}:cloud:${cloudCiId({ id: hostRef.provider, account,
        circleAccountId: hostRef.circleAccountId })}:${hostRef.slot ?? 0}`, hostRef,
        label: hostRef.provider === 'github' ? 'GitHub Actions' : account ? `CircleCI ${account.owner}` : 'CircleCI', priority: 0 }
    }
    throw new DomainError('CI_COMPUTER_OFFLINE', 'The build computer running this CI run is offline.', 409)
  }

  private async settle(run: CiRunRecord, computer: HostCiComputer, state: { state: string; step: string | null
    exitCode: number | null; startedAt: string | null; finishedAt: string | null; message: string | null
    collection?: CiHostRun['collection']; provenance?: CiHostRun['provenance'];
    mirrorPublication?: CiHostRun['mirrorPublication']; testsStarted?: CiHostRun['testsStarted'];
    executorCleanupPending?: CiHostRun['executorCleanupPending'];
    transport?: CiHostRun['transport']; selection?: CiHostRun['selection'] },
    options: { logTail?: string | undefined; audit?: CiCancellation | undefined;
      client?: pg.PoolClient | undefined; observation?: CiRunRecord['observation']; retainExecutor?: boolean } = {}) {
    const { logTail, audit, client } = options
    const executorCleanupPending = state.executorCleanupPending ?? run.executorCleanupPending
    const setupRequeue = computer.hostRef.kind === 'cloud' && state.state === 'failed'
      && state.testsStarted === false && !executorCleanupPending
      && !run.setupRetry && !run.cancellation && !run.supersededBy
    let setupRetry = run.setupRetry
    if (setupRequeue) {
      const reason = sanitizeCiText(state.message ?? 'Cloud setup failed before the first test started.').slice(0, 2000)
      setupRetry = { runId: randomUUID(), failedComputer: computer.hostRef, reason }
      state = { state: 'queued', step: null, exitCode: null, startedAt: null, finishedAt: null,
        message: `Queued once on another slot after setup failure: ${reason}`.slice(0, 2000) }
    }
    const requeued = state.state === 'queued' && !executorCleanupPending
    const executionHistory = [...run.executionHistory ?? []]
    if (requeued) {
      const previousRunId = ciExecutionRunId(run)
      const retained = executionHistory.some(attempt => attempt.runId === previousRunId
        && isDeepStrictEqual(attempt.hostRef, computer.hostRef))
      if (!retained) executionHistory.push({ runId: previousRunId, hostRef: computer.hostRef })
    }
    let executionRunId = run.executionRunId
    if (requeued) executionRunId = setupRequeue ? setupRetry!.runId : randomUUID()
    const retainedExecutions = [...run.retainedExecutions ?? []]
    if (requeued && options.retainExecutor) {
      retainedExecutions.push({ runId: ciExecutionRunId(run), hostKey: computer.key,
        computer: { hostRef: computer.hostRef, label: computer.label }, executor: 'retained',
        nextAttemptAt: new Date().toISOString() })
    }
    const unstartedProviders = new Set(run.unstartedProviders ?? [])
    // A workflow the provider only queued is moved when another computer has room; that does not rule the provider out.
    if (requeued && !setupRequeue && !options.retainExecutor && computer.hostRef.provider && run.step !== 'queued') {
      unstartedProviders.add(computer.hostRef.provider)
    }
    const messages = ciMessages(run, state.message === null ? null : sanitizeCiText(state.message))
    const terminal = !['queued', 'starting', 'running'].includes(state.state)
    const next = CiRunRecordSchema.parse({ ...run, state: state.state, step: state.step, exitCode: state.exitCode,
      computer: requeued ? null : { hostRef: computer.hostRef, label: computer.label },
      startedAt: requeued ? null : run.startedAt ?? state.startedAt,
      finishedAt: state.finishedAt, ...messages, dispatchRequest: undefined,
      dispatchedAt: state.state === 'starting' ? run.dispatchedAt ?? run.startedAt ?? run.queuedAt : undefined,
      dispatchHostKey: undefined,
      setupRetry,
      executionRunId,
      ...(executionHistory.length ? { executionHistory } : {}),
      ...(retainedExecutions.length ? { retainedExecutions } : {}),
      ...(options.observation ? { observation: options.observation } : {}),
      ...(state.transport ? { transport: state.transport } : {}),
      ...(state.selection ? { selection: state.selection } : {}),
      ...(executorCleanupPending !== undefined ? { executorCleanupPending } : {}),
      ...(setupRequeue || options.retainExecutor ? { dispatchAttempts: undefined, collection: undefined,
        provenance: undefined, mirrorPublication: undefined } : {}),
      ...(options.retainExecutor ? { observation: undefined } : {}),
      cancellation: terminal ? undefined : run.cancellation,
      ...(state.collection ? { collection: state.collection } : {}),
      ...(state.provenance ? { provenance: state.provenance } : {}),
      ...(state.mirrorPublication ? { mirrorPublication: state.mirrorPublication } : {}),
      ...(unstartedProviders.size ? { unstartedProviders: [...unstartedProviders] } : {}) })
    const hostKey = ['starting', 'running'].includes(next.state) || next.executorCleanupPending ? computer.key : null
    let savedLogTail = logTail === undefined ? null : sanitizeCiText(logTail)
    if (setupRequeue || options.retainExecutor) savedLogTail = ''
    // Reusing the stored JSON keeps its TOAST value when only the log changes.
    const record = serializeCiJson(next)
    // Cleanup can change an earlier execution while this execution's result is in flight. Preserve those
    // independent slot facts; all other ticket fields still participate in the compare-and-set.
    const recordAssignment = canonicalJson(run) === canonicalJson(JSON.parse(record)) ? '' : `record=$4::jsonb ||
      case when record ? 'retainedExecutions' or $11::jsonb is not null then jsonb_build_object('retainedExecutions',
        coalesce(record->'retainedExecutions','[]'::jsonb) || coalesce($11::jsonb,'[]'::jsonb)) else '{}'::jsonb end, `
    // Durations are partition inputs: setup retries must keep the original file membership.
    const saved = await this.saveCancellation(`update ci_runs set state=$2, host_key=$3, ${recordAssignment}log_tail=coalesce($6,log_tail),
        test_results=case when $10 then null else test_results end
      where id=$1 and (state in ('queued','starting','running') or state=$8
        and (record->>'collection'='pending' or record#>>'{observation,status}'='unavailable'
          or record->>'executorCleanupPending'='true'))
        and host_key is not distinct from $5
        and record->>'supersededBy' is not distinct from $7
        and record - 'retainedExecutions'=$9::jsonb - 'retainedExecutions'
        and (state is distinct from $2 or host_key is distinct from $3
          or record - 'retainedExecutions' is distinct from $4::jsonb - 'retainedExecutions'
          or $11::jsonb is not null
          or ($6::text is not null and log_tail is distinct from $6))`,
      [run.id, next.state, hostKey, record,
        ['starting', 'running'].includes(run.state) || run.executorCleanupPending ? computer.key : null,
        savedLogTail,
        run.supersededBy ?? null, run.state, JSON.stringify(run), setupRequeue || options.retainExecutor === true,
        options.retainExecutor ? JSON.stringify(retainedExecutions.slice(-1)) : null],
      next, run.cancellation ?? audit, client)
    if (terminal && run.gate && run.suite === 'integration') invalidateExecutorSpeeds(this.planningEndpoint)
    if (requeued && saved.rowCount) log.warn({ runId: run.id, provider: computer.hostRef.provider, message: messages.message },
      'CI ticket queued for another computer')
    return Boolean(saved.rowCount)
  }

  /** Refresh running runs and dispatch queued work, retaining wake-ups during an active pass. */
  dispatch(): Promise<void> {
    if (!this.dispatchRetry.ready()) return Promise.resolve()
    this.dispatchRequested = true
    if (this.stoppingRuns) return this.dispatching ?? Promise.resolve()
    this.dispatching ??= (async () => {
      while (this.dispatchRequested && !this.stoppingRuns) {
        this.dispatchRequested = false
        await trackService('ci-dispatch', { cadenceMs: 1000, deadlineMs: CI_DISPATCH_PASS_MS },
          () => withCiDispatchDeadline(() => withProviderPoll(() => this.dispatchOnce())))
        this.dispatchRetry.reset()
      }
    })().catch(error => {
      // Slow work has already spent the pass budget; other errors still need an increasing retry delay.
      const nextRetryMs = error instanceof CiDispatchDeadlineError ? 0 : this.dispatchRetry.fail()
      log.warn({ err: error, nextRetryMs }, 'CI dispatch failed; retry scheduled')
    })
      .finally(() => { this.dispatching = undefined })
    return this.dispatching
  }

  private dispatchServices(computer: HostCiComputer, status = this.planningEndpoint.dispatchStatus(computer)) {
    return { pool: this.pool, endpoint: this.endpoint,
      read: (id: string, workspaceId: string, sql: SqlQuery) => this.read(id, workspaceId, sql),
      rejected: (run: CiRunRecord, rejectedComputer: HostCiComputer, error: unknown) => {
        const message = errorMessage(error, 'CI start was refused.')
        this.dispatchRejections.record(run.id, rejectedComputer, status, message,
          { structural: structuralCiStartRejection(error) })
      },
      settle: (run: CiRunRecord, computer: HostCiComputer, state: CiDispatchState,
        options: { client: CiTicketSql }) => options.client.transaction(
        client => this.settle(run, computer, state, { client })),
    }
  }

  private sendDispatch(run: CiRunRecord, computer: HostCiComputer) {
    if (computer.hostRef.kind !== 'cloud') return sendCiDispatch(this.dispatchServices(computer), run, computer)
    const pending = this.cloudDispatches.get(run.id)
    if (pending) return pending
    const delivery = sendCiDispatch(this.dispatchServices(computer), run, computer)
      .finally(() => { this.cloudDispatches.delete(run.id) })
    this.cloudDispatches.set(run.id, delivery)
    return delivery
  }

  private reconcileHostStart(run: CiRunRecord, computer: HostCiComputer, status: CiHostStatus | null) {
    return reconcileCiHostStart(this.dispatchServices(computer, status ?? undefined), run, computer, status)
  }

  expireOverdueRuns(now = new Date()): Promise<number> {
    return expireOverdueCiRuns(this.pool, now, async (run, hostKey) => {
      try {
        await this.refreshRun({ record: run, host_key: hostKey }, await this.endpoint.computers(), { observeOnly: true })
      } catch (error) {
        await this.recordObservationFailure(run, error, hostKey)
      }
      return this.read(run.id, run.workspaceId)
    })
  }

  private spareElsewhere(run: CiRunRecord, computer: HostCiComputer) {
    return this.spareComputers.some(spare => spare.key !== computer.key
      && (spare.hostRef.kind !== 'cloud' || !run.unstartedProviders?.includes(spare.hostRef.provider!))
      && (spare.hostRef.provider !== 'circleci' || runsOnCircleCi(run))
      && (!needsSystemdExecutor(run) || supportsUserSystemd(spare)))
  }

  private async refreshRun(row: { record: unknown; host_key: string | null }, computers: HostCiComputer[],
    options: { observeOnly?: boolean; onCollecting?: () => void } = {}) {
    let run = CiRunRecordSchema.parse(row.record)
    if (!options.observeOnly && !run.cancellation && run.observation?.nextAttemptAt
      && Date.now() < Date.parse(run.observation.nextAttemptAt)) return
    let computer = computers.find(value => value.key === row.host_key)
      ?? computers.find(value => run.collection === 'pending' && run.computer
        && value.hostRef.kind === run.computer.hostRef.kind && value.hostRef.mainId === run.computer.hostRef.mainId
        && value.hostRef.deviceId === run.computer.hostRef.deviceId && value.hostRef.provider === run.computer.hostRef.provider
        && value.hostRef.account === run.computer.hostRef.account
        && (value.hostRef.circleAccountId ?? 'default') === (run.computer.hostRef.circleAccountId ?? 'default')
        && value.hostRef.slot === run.computer.hostRef.slot)
      ?? (run.computer ? await this.computer(run.computer.hostRef) : null)
    if (!computer) throw new CiExecutorObservationError(
      new DomainError('CI_COMPUTER_OFFLINE', 'The CI executor is unavailable.', 503))
    if (row.host_key) computer = { ...computer, key: row.host_key }
    if (run.deadlineExceeded?.executor === 'retained') {
      await this.releaseRetainedExecutor(run, computer)
      return
    }
    if (run.cancellation) {
      await this.cancelTicket(run.workspaceId, run.id, run.cancellation)
      return
    }
    if (!options.observeOnly && computer.hostRef.kind !== 'cloud' && run.state === 'starting' && !run.startedAt) {
      try {
        await this.endpoint.request(computer, { operation: 'status' }, { priority: 'background' })
      } catch (error) {
        throw new CiExecutorObservationError(error)
      }
      return
    }
    if (!options.observeOnly
      && (run.dispatchRequest || computer.hostRef.kind === 'cloud' && run.state === 'starting' && !run.startedAt)) {
      await this.sendDispatch(run, computer)
      return
    }
    const request: CiHostRequest = { operation: 'read', runId: ciExecutionRunId(run), afterOffset: 0, maxBytes: 32_768,
      ...(['integration', 'unit'].includes(run.suite) ? { durations: true } : {}),
      ...(computer.hostRef.kind === 'cloud' && run.step === 'queued' && this.spareElsewhere(run, computer)
        ? { reassign: true } : {}) }
    const reply = await (computer.hostRef.kind === 'cloud'
      ? requestCloud(this.endpoint, computer, request)
      : this.endpoint.request(computer, request, { priority: 'background' })).catch(error => {
        throw new CiExecutorObservationError(error)
      })
    if (computer.hostRef.kind === 'cloud' && run.state === 'starting') {
      const recovered = await expireCloudDispatch(this.endpoint, computer, run,
        reply?.operation === 'read' ? reply.run : undefined)
      if (recovered && !['starting', 'running'].includes(recovered.state)) {
        await this.settle(run, computer, recovered)
        return
      }
    }
    if (reply.operation !== 'read') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'Expected a CI run observation.', 502)
    }
    if (reply.run.runId !== ciExecutionRunId(run)) {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The CI executor replied for a different execution.', 502)
    }
    const finished = !['queued', 'starting', 'running'].includes(reply.run.state)
    const awaitsSetupDecision = computer.hostRef.kind === 'cloud' && reply.run.state === 'failed'
      && (reply.run.testsStarted === false || reply.run.testsStarted === undefined && reply.run.collection === 'pending')
    if (finished && !awaitsSetupDecision) {
      // The execution outcome settles first, releasing the executor slot; logs and results follow without
      // holding an observation slot, so slow collection cannot delay tracking of other tickets.
      if (['unit', 'integration'].includes(run.suite) && ['queued', 'starting', 'running'].includes(run.state)) {
        const saved = await this.settle(run, computer, { ...reply.run, collection: 'pending' })
        const current = await this.read(run.id, run.workspaceId)
        // A different dispatcher may abandon this execution while its read is in flight.
        if (ciExecutionRunId(current) !== ciExecutionRunId(run)) return
        if (saved) {
          run = current
          void this.dispatch()
        }
      }
      options.onCollecting?.()
    }
    let logError: unknown
    let logTail: string | undefined = reply.text
    if (reply.run.logBytes > 32_768) {
      const tail = await this.endpoint.request(computer, { operation: 'read', runId: ciExecutionRunId(run),
        afterOffset: reply.run.logBytes - 32_768, maxBytes: 32_768 }, { priority: 'background' }).catch(error => {
          logError = error
          return null
        })
      if (tail?.operation === 'read') logTail = tail.text
      else {
        logTail = undefined
        logError ??= new DomainError('CI_HOST_REPLY_INVALID', 'Expected a CI log tail.', 502)
      }
    }
    const now = Date.now()
    const lastSuccessAt = run.observation?.status === 'available' && run.observation.lastSuccessAt
      && now - Date.parse(run.observation.lastSuccessAt) < 60_000
      ? run.observation.lastSuccessAt : new Date(now).toISOString()
    const observation: CiRunRecord['observation'] = logError ? undefined : { status: 'available',
      lastSuccessAt, lastError: null, consecutiveFailures: 0, nextAttemptAt: null }
    if (computer.hostRef.kind === 'cloud' && reply.run.state === 'failed') {
      if (reply.run.testsStarted === false && !run.setupRetry && !run.cancellation && !run.supersededBy) {
        await this.settle(run, computer, reply.run, { logTail, observation })
        if (logError) throw logError
        return
      }
      // Wait for the failure metadata before deciding whether this attempt used its setup retry.
      if (reply.run.testsStarted === undefined && reply.run.collection === 'pending') {
        if (logError) throw logError
        return
      }
    }
    const terminal = !['queued', 'starting', 'running'].includes(reply.run.state)
    const collected = terminal ? await collectCiResults(this.pool, this.endpoint, computer, run, reply, this.coverage)
      : { run: reply.run, durations: reply.durations, error: undefined }
    let observationError = logError ?? collected.error
    if (!['queued', 'starting', 'running'].includes(run.state)) {
      collected.run = { ...collected.run, state: run.state, exitCode: run.exitCode, finishedAt: run.finishedAt }
    }
    if (terminal && collected.run.collection === 'complete') {
      try {
        await recordCiResultCache(this.pool, run, collected.run.state)
      } catch (error) {
        collected.run = { ...collected.run, collection: 'pending' }
        observationError ??= error
        log.warn({ err: error, runId: run.id }, 'CI result cache recording remains pending')
      }
    }
    if (terminal && collected.run.collection === 'pending') {
      observationError ??= new DomainError('CI_COLLECTION_PENDING', 'CI test reports are not available yet.', 503)
    }
    const settlement = { logTail, observation: observationError ? undefined : observation }
    const collecting = ['queued', 'starting', 'running'].includes(run.state) || run.collection === 'pending'
    const durations = terminal && collecting && collected.run.collection !== 'pending' ? collected.durations : undefined
    if (durations && Object.keys(durations).length) {
      // A finished run's durations count once: only the observation whose write ends its collection folds them
      // in, atomically with that write. A concurrent or stale observation of the same run loses the write and adds
      // no second sample; a failed fold leaves the collection pending for the next observation.
      const learned = await withTransaction(this.pool, async client => {
        const settled = await this.settle(run, computer, collected.run, { ...settlement, client })
        if (settled) {
          await this.learnDurations(run.repository, durations, client)
        }
        return settled
      })
      if (learned) {
        // Release the upsert's row locks before pruning can wait on another collection's expired rows.
        await this.pool.query(`delete from ci_file_durations
          where repository=$1 and updated_at < now() - interval '30 days'`, [run.repository])
      }
    } else {
      await this.settle(run, computer, collected.run, settlement)
    }
    if (observationError) throw observationError
  }

  /** A ticket failed by its deadline keeps its slot until the executor confirms the run stopped or never existed. */
  private async releaseRetainedExecutor(run: CiRunRecord, computer: HostCiComputer) {
    try {
      const reply = await this.endpoint.request(computer, { operation: 'cancel', runId: ciExecutionRunId(run) })
      if (reply.operation !== 'cancel' || ['queued', 'starting', 'running'].includes(reply.run.state)
        || reply.run.executorCleanupPending) {
        throw new DomainError('CI_EXECUTOR_CLEANUP_PENDING', 'The executor has not confirmed the run stopped.', 503)
      }
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'CI_RUN_UNKNOWN')) throw error
    }
    const next = CiRunRecordSchema.parse({ ...run, executorCleanupPending: false,
      deadlineExceeded: { ...run.deadlineExceeded!, executor: 'released' },
      observation: { status: 'available', lastSuccessAt: new Date().toISOString(), lastError: null,
        consecutiveFailures: 0, nextAttemptAt: null } })
    await this.pool.query(`update ci_runs set host_key=null, record=$2::jsonb where id=$1 and record=$3::jsonb`,
      [run.id, serializeCiJson(next), JSON.stringify(run)])
  }

  private async recordObservationFailure(failedRun: CiRunRecord, error: unknown, hostKey: string | null) {
    const run = await this.read(failedRun.id, failedRun.workspaceId)
    if (ciExecutionRunId(run) !== ciExecutionRunId(failedRun)
      || !isDeepStrictEqual(run.computer?.hostRef, failedRun.computer?.hostRef)) return
    const now = Date.now()
    const transportUnavailableSince = ciTransportUnavailable(error)
      ? run.observation?.transportUnavailableSince ?? new Date(now).toISOString() : undefined
    const consecutiveFailures = (run.observation?.consecutiveFailures ?? 0) + 1
    const code = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? ` (${error.code})` : ''
    const lastError = `CI observation unavailable${code}; ownership retained.`
    const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(consecutiveFailures - 1, 6))
    const observation: CiRunRecord['observation'] = { status: 'unavailable',
      lastSuccessAt: run.observation?.lastSuccessAt ?? null, lastError, consecutiveFailures,
      nextAttemptAt: new Date(now + delayMs).toISOString(),
      ...(transportUnavailableSince ? { transportUnavailableSince } : {}) }
    if (transportUnavailableSince && now - Date.parse(transportUnavailableSince) >= ciExecutorOutageLimit(run)
      && ['starting', 'running'].includes(run.state) && run.computer && !run.cancellation && !run.supersededBy
      && !run.deadlineExceeded && !run.executorCleanupPending && hostKey) {
      const computer: HostCiComputer = { ...run.computer, key: hostKey, priority: 0 }
      if (await this.settle(run, computer, { state: 'queued', step: null, exitCode: null, startedAt: null,
        finishedAt: null, message: 'Queued on another computer after sustained executor transport failure.' },
      { retainExecutor: true })) void this.dispatch()
      return
    }
    // A deadline failure keeps its explanation; the observation carries the retry state.
    const next = CiRunRecordSchema.parse({ ...run, observation,
      message: run.deadlineExceeded ? run.message : lastError })
    log.warn({ err: error, runId: run.id, observation }, 'CI observation unavailable; retry scheduled')
    await this.pool.query(`update ci_runs set record=$4::jsonb
      where id=$1 and state=$2 and workspace_id=$3 and record=$5::jsonb`,
    [run.id, run.state, run.workspaceId, serializeCiJson(next), JSON.stringify(run)])
  }

  private refreshActiveRuns(active: { id: string; record: unknown; host_key: string | null }[],
    computers: HostCiComputer[]) {
    const refresh = async (listed: typeof active[number]) => {
      const listedRun = CiRunRecordSchema.parse(listed.record)
      const { workspaceId } = listedRun
      try {
        // An observation that finished after this pass listed the ticket has rewritten it, including its backoff.
        const previous = await this.read(listed.id, workspaceId)
        // It may also have moved the ticket off the listed executor, such as a setup retry queued with a new
        // execution. The listed executor does not hold that execution; the next pass lists the ticket where it is.
        if (ciExecutionRunId(previous) !== ciExecutionRunId(listedRun)
          || !isDeepStrictEqual(previous.computer?.hostRef, listedRun.computer?.hostRef)) return
        await this.refreshRun({ ...listed, record: previous }, computers,
          { onCollecting: () => { this.collectingRuns.add(listed.id) } })
        const current = await this.read(listed.id, workspaceId)
        if (['starting', 'running'].includes(previous.state) && !['starting', 'running'].includes(current.state)
          || previous.executorCleanupPending && !current.executorCleanupPending
          || previous.deadlineExceeded?.executor === 'retained' && current.deadlineExceeded?.executor === 'released') {
          void this.dispatch()
        }
      } catch (error) {
        reportServiceFailure('ci-observation', error)
        try {
          await this.recordObservationFailure(listedRun, error, listed.host_key)
        } catch {
          log.warn({ runId: listed.id }, 'CI observation failed and its status could not be persisted')
        }
      } finally {
        this.collectingRuns.delete(listed.id)
      }
    }
    const cloud = active.filter(row => CiRunRecordSchema.parse(row.record).computer?.hostRef.kind === 'cloud')
    const local = active.filter(row => CiRunRecordSchema.parse(row.record).computer?.hostRef.kind !== 'cloud')
    const expectedEnd = (row: typeof active[number]) => {
      const run = CiRunRecordSchema.parse(row.record)
      if (!run.startedAt || !run.expectedDurationMs) return Infinity
      return Date.parse(run.startedAt) + run.expectedDurationMs
    }
    cloud.sort((left, right) => expectedEnd(left) - expectedEnd(right))
    // Every observation returns to this pool to collect and settle. Keep room
    // for dispatch, authenticated reads and the Run writers they can wait on.
    const limit = Math.max(1, Math.floor((this.pool.options?.max ?? 10) / 2))
    const rows = Array.from({ length: Math.max(cloud.length, local.length) }, (_, index) =>
      [cloud[index], local[index]].filter(row => row !== undefined)).flat()
    const offset = this.observationOffset % Math.max(1, rows.length)
    let pendingCloud = cloud.filter(row => this.observingRuns.has(row.id)).length
    let pendingLocal = local.filter(row => this.observingRuns.has(row.id)).length
    // Slow provider polls may hold all but one permit, so Worker tickets can always release their slots.
    const cloudLimit = limit > 1 ? limit - 1 : limit
    let observingCloud = cloud.filter(row => this.observingRuns.has(row.id) && !this.collectingRuns.has(row.id)).length
    // The first cloud ticket left waiting for a permit is where the next pass resumes, even if this pass goes on to
    // start Worker tickets that wrap around to the front of the rotation.
    let resumeAt: number | undefined
    for (let visited = 0; visited < rows.length && this.observingRuns.size - this.collectingRuns.size < limit; visited++) {
      const index = (offset + visited) % rows.length
      const row = rows[index]!
      if (this.observingRuns.has(row.id)) continue
      const isCloud = CiRunRecordSchema.parse(row.record).computer?.hostRef.kind === 'cloud'
      if (isCloud && pendingCloud < 48 && observingCloud >= cloudLimit) resumeAt ??= index
      if (isCloud ? pendingCloud >= 48 || observingCloud >= cloudLimit : pendingLocal >= 8) continue
      if (isCloud) {
        pendingCloud++
        observingCloud++
      } else pendingLocal++
      const observation = withoutCiDatabasePriority(() =>
        trackService('ci-observation', { cadenceMs: 1000, deadlineMs: 5 * 60_000 },
          () => refresh(row))).finally(() => { this.observingRuns.delete(row.id) })
      this.observingRuns.set(row.id, observation)
      this.observationOffset = resumeAt ?? (index + 1) % rows.length
    }
  }

  private refreshComputerStatuses(computers: HostCiComputer[]) {
    for (const computer of computers) {
      const key = computer.hostRef.kind === 'cloud'
        ? this.endpoint.statusKey?.(computer) ?? computer.key : computer.key
      if (this.planningEndpoint.status(computer) || this.observingComputers.has(key)) continue
      const retry = this.computerStatusRetries.get(key)
        ?? new RetryBackoff({ initialMs: 5000, maxMs: 300_000 })
      this.computerStatusRetries.set(key, retry)
      if (!retry.ready()) continue
      // Readiness belongs to dispatch; collecting running tickets uses the shared pool.
      const observation = withCiDatabasePriority(() => readCiComputerStatus(this.endpoint, computer)).then(status => {
        if (status) {
          retry.reset()
          void this.dispatch()
        } else {
          retry.fail()
        }
      }).finally(() => { this.observingComputers.delete(key) })
      this.observingComputers.set(key, observation)
    }
  }

  /** Pushes a commit snapshot to the CI mirror once per distinct payload; dispatch runs again when the push settles. */
  private publishMirror(input: CiMirrorInput): { settled: boolean } {
    if (!this.endpoint.publishMirror) return { settled: true }
    const key = canonicalJson(input)
    const known = this.mirrorPublications.get(key)
    if (known) return known
    const publication = { settled: false }
    this.mirrorPublications.set(key, publication)
    if (this.mirrorPublications.size > 200) this.mirrorPublications.delete(this.mirrorPublications.keys().next().value!)
    void this.endpoint.publishMirror(input).catch(error => {
      // A failed push is retried, and reported, by the ticket's own start.
      log.warn({ err: error, commit: input.commit, mirror: input.mirror }, 'CI mirror publication failed; the start will retry')
    }).finally(() => {
      publication.settled = true
      void this.dispatch()
    })
    return publication
  }

  /** The snapshot a cloud start publishes, matching its derivation of the published branch and timings. */
  private mirrorPublished(start: Extract<CiHostRequest, { operation: 'start' }>): boolean {
    if (!start.ciMirror || !this.endpoint.publishMirror) return true
    const deriveFiles = (start.scope ?? 'affected') === 'affected' && start.files === undefined
    return this.publishMirror({ repository: start.repository, mirror: start.ciMirror, commit: start.commit,
      ...(deriveFiles && !start.baseCommit ? { defaultBranch: start.defaultBranch ?? 'main' } : {}),
      ...(deriveFiles && start.baseCommit ? { baseCommit: start.baseCommit } : {}),
      ...(start.integrationCoverage ? { integrationCoverage: start.integrationCoverage } : {}),
      durations: start.durations ?? {} }).settled
  }

  private startRequest(run: CiRunRecord, selection: Partial<Extract<CiHostRequest, { operation: 'start' }>>,
    durations: CiDurations | null | undefined, coverage?: CiCoverageSelection): Extract<CiHostRequest, { operation: 'start' }> {
    if (run.suite === 'integration' && run.deriveFiles && !coverage) {
      throw new DomainError('CI_GROUP_SELECTION_MISSING', 'The integration group has no saved selection input.', 409)
    }
    return {
      operation: 'start', runId: ciExecutionRunId(run), workspaceId: run.workspaceId, ciMirror: run.ciMirror ?? null,
      repository: run.repository, commit: run.commit, suite: run.suite,
      ...(run.part ? { part: run.part } : {}),
      ...(run.partition ? { partition: run.partition } : {}),
      scope: run.scope, ...selection,
      ...(run.expectedDurationMs !== undefined ? { expectedDurationMs: run.expectedDurationMs } : {}),
      ...(run.defaultBranch ? { defaultBranch: run.defaultBranch } : {}),
      ...(run.baseCommit ? { baseCommit: run.baseCommit } : {}),
      ...(run.cachedFiles?.length ? { notice: ciCachedNotice(run.cachedFiles) } : {}),
      ...(durations ? { durations } : {}),
      ...(coverage ? { integrationCoverage: coverage } : {}),
    }
  }

  /** Each computer's slot total, unavailability reason and gate shards from its dispatch status; raises `used` to the
   * slots the computer itself reports busy. */
  private dispatchCapacity(computers: HostCiComputer[], used: Map<string, number>) {
    const totals = new Map<string, number>()
    const unavailable = new Map<string, string>()
    const gateShards = new Map<string, number>()
    for (const computer of computers) {
      const status = this.planningEndpoint.dispatchStatus(computer)
      const slots = computer.hostRef.kind === 'cloud' ? 1 : status?.slotsTotal ?? 1
      totals.set(computer.key, status?.ready ? slots : 0)
      if (!status?.ready) unavailable.set(computer.key, status?.reasons.join('; ') || 'Worker CI status unavailable')
      if (status) {
        used.set(computer.key, Math.max(used.get(computer.key) ?? 0, status.slotsUsed ?? 0))
        if (status.ready) {
          gateShards.set(computer.key, buildComputerIntegrationShards(status, computer.buildAllowancePercent))
        }
      }
    }
    return { totals, unavailable, gateShards }
  }

  private async splitGateParts(queued: CiRunRecord[],
    capacity: Omit<Parameters<typeof splitUnavailableGateParts>[2], 'reservedCloud'>, snapshots: PolicySnapshots) {
    const result: CiRunRecord[] = []
    for (const run of queued) {
      if (!buildComputerGatePart(run, capacity.knownComputers ?? capacity.computers)) {
        result.push(run)
        continue
      }
      const computers = await this.schedulingFleet(capacity.computers, { mirrorName: run.ciMirror?.split('/')[1], snapshots })
      const keys = new Set(computers.map(computer => computer.key))
      result.push(...await splitUnavailableGateParts(this.pool, [run], { ...capacity, computers,
        shards: new Map([...capacity.shards].filter(([key]) => keys.has(key))),
        reservedCloud: reservedCloudSlotKeys(computers.filter(computer => capacity.shards.has(computer.key)), this.reservedCloudSlots) }))
    }
    return result
  }

  private async refreshExecutions(knownComputers: HostCiComputer[]) {
    const active = (await this.pool.query<{ id: string; record: unknown; host_key: string | null }>(
      `select id,record,host_key from ci_runs where state in ('starting','running') or record->>'collection'='pending'
        or record->>'executorCleanupPending'='true'
        or ${CI_RETAINED_EXECUTORS}
        or (state in ('passed','failed','canceled','lost') and record#>>'{observation,status}'='unavailable')`)).rows
    this.retainedExecutors.refresh(active.map(row => CiRunRecordSchema.parse(row.record)), knownComputers,
      () => { void this.dispatch() })
    this.refreshActiveRuns(active.filter(row => {
      const run = CiRunRecordSchema.parse(row.record)
      return ['starting', 'running'].includes(run.state) || run.collection === 'pending'
        || run.executorCleanupPending || run.observation?.status === 'unavailable'
    }), knownComputers)
    const busyTickets = (await this.pool.query<{ host_key: string | null; record: unknown }>(
      `select host_key,record from ci_runs where ${CI_BUSY_TICKET} or ${CI_RETAINED_EXECUTORS}`)).rows
    return busyTickets.flatMap(row => {
      const run = CiRunRecordSchema.parse(row.record)
      const assigned = row.host_key ? [{ ...row, host_key: row.host_key }] : []
      return [...assigned, ...run.retainedExecutions?.filter(attempt => attempt.executor === 'retained')
        .map(attempt => ({ record: row.record, host_key: attempt.hostKey })) ?? []]
    })
  }

  private async dispatchOnce() {
    const snapshots: PolicySnapshots = new Map()
    this.cleaningTickets ??= withoutCiDatabasePriority(() => this.cancelObsoleteTickets())
      .catch(error => log.warn({ err: error }, 'CI ticket cleanup failed; retrying'))
      .finally(() => { this.cleaningTickets = undefined })
    const knownComputers = await this.endpoint.computers()
    const { parsed, durations, coverage } = await readQueuedCiRuns(this.pool)
    const speeds = parsed.some(run => run.gate)
      ? await readExecutorSpeeds(this.pool, this.planningEndpoint) : new Map()
    void withoutCiDatabasePriority(async () => this.prewarm.schedule(knownComputers, parsed))
    this.dispatchRejections.retain(parsed)
    this.refreshComputerStatuses(knownComputers)
    const busyRows = await this.refreshExecutions(knownComputers)
    const used = new Map<string, number>()
    for (const row of busyRows) used.set(row.host_key, (used.get(row.host_key) ?? 0) + 1)
    const assignments = new Map(busyRows.map(row => {
      const run = CiRunRecordSchema.parse(row.record)
      return [run.id, { groupId: run.groupId, computerKey: row.host_key }]
    }))
    const { gate, reservedHosts } = await readCiGateReservation(this.pool)
    const computers = parsed.length ? await this.schedulingFleet(knownComputers, { snapshots }) : knownComputers
    const { totals, unavailable, gateShards } = this.dispatchCapacity(computers, used)
    const freeSlots = (computer: HostCiComputer) => Math.max(0,
      (totals.get(computer.key) ?? 1) - (used.get(computer.key) ?? 0))
    const releaseSlot = (computer: HostCiComputer) => {
      used.set(computer.key, Math.max(0, (used.get(computer.key) ?? 0) - 1))
    }
    const github = computers.filter(isGitHubComputer)
    const githubKeys = new Set(github.map(computer => computer.key))
    const integrationOnGitHub = new Set(busyRows.filter(row => githubKeys.has(row.host_key)
      && CiRunRecordSchema.parse(row.record).suite === 'integration').map(row => row.host_key))
    const smokeTargets = await this.smokeTargets(parsed)
    let queued = parsed
    // Reserve four GitHub slots while checks that can dispatch wait, including integration already using GitHub.
    const dispatchableCheck = (run: CiRunRecord) => run.suite !== 'integration' && !gateQueueBlock(run, gate)
    const githubIntegrationLimit = Math.max(0, github.length - (queued.some(dispatchableCheck) ? 4 : 0))
    queued = await weighCiPartitions(this.pool, this.planningEndpoint, queued, computers.flatMap(computer =>
      Array.from({ length: freeSlots(computer) }, () => computer)), (id, workspaceId) => this.read(id, workspaceId))
    queued.sort((left, right) => (left.priority === right.priority
      && !left.gate && !right.gate
      && left.partition?.tier === right.partition?.tier && left.partition?.tier !== 'slow'
      ? Number(needsSystemdExecutor(right)) - Number(needsSystemdExecutor(left)) : 0) || compareCiQueue(left, right))
    // Whether a ticket's mirror snapshot is on GitHub does not depend on which cloud slot is tried.
    const mirrorReady = new Map<string, boolean>()
    const stealsGatePart = gatePartStealer(knownComputers, queued)
    const canTakeGatePart = (run: CiRunRecord, computer: HostCiComputer) => {
      if (!gateShards.has(computer.key)) return false
      if (run.retainedExecutions?.length) return true
      if (run.setupRetry) return true
      if (computer.key === run.plannedHostKey) return true
      if (buildComputerGatePart(run, knownComputers)) {
        return computer.hostRef.kind !== 'cloud'
          && gateShards.get(computer.key)! >= run.integrationShards!
          && stealsGatePart(run, computer)
      }
      return !run.plannedHostKey
        || !gateShards.has(run.plannedHostKey) && !this.observingComputers.has(run.plannedHostKey)
        || stealsGatePart(run, computer)
    }
    queued = await this.splitGateParts(queued, { computers, knownComputers, shards: gateShards, durations, speeds,
      gate, freeSlots, canTake: canTakeGatePart, idle: computer => (used.get(computer.key) ?? 0) === 0 }, snapshots)
    // Reserve slots before awaiting a start so concurrent dispatches cannot spend the same capacity.
    await inBatches(queued, 8, async run => {
      const smokeTarget = smokeTargets.get(run.groupId)
      const blocked = gateQueueBlock(run, gate)
      if (blocked) {
        if (run.message !== blocked) await saveQueuedCiRun(this.pool, run, { ...run, message: blocked })
        return
      }
      if (run.suite === 'integration' && run.partition && !run.partition.weights) return
      const hostRequired = needsSystemdExecutor(run)
      const integrationLimit = run.priority === 'high'
        && !queued.some(check => dispatchableCheck(check) && compareCiQueue(check, run) < 0)
        ? github.length : githubIntegrationLimit
      const reasons = (run.unstartedProviders ?? []).map(provider => `${provider}: dispatch retries exhausted`)
      const preferred = (computer: HostCiComputer) => {
        if (run.gate && run.suite !== 'integration') return Number(computer.hostRef.kind === 'cloud')
        if (computer.hostRef.kind !== 'cloud') return 3
        if (run.suite !== 'integration') return Number(isGitHubComputer(computer))
        return isGitHubComputer(computer) ? 1 : 2
      }
      const affectedFiles = run.scope === 'affected' && !run.deriveFiles ? { files: run.files } : {}
      const plannedProvider = run.gate
        ? computers.find(computer => computer.key === run.plannedHostKey)?.hostRef.provider : undefined
      const selection = (run.gate || smokeTarget) && run.suite === 'integration'
        ? { gate: true, scope: 'full' as const, integrationShards: run.integrationShards!, files: run.files }
        : affectedFiles
      const eligible = await this.schedulingFleet(computers, { mirrorName: run.ciMirror?.split('/')[1], snapshots })
      const reservedCloud = reservedCloudSlotKeys(eligible.filter(computer => gateShards.has(computer.key)),
        this.reservedCloudSlots)
      const order = eligible
        .filter(computer => runsOnCircleCi(run)
        || computer.hostRef.kind !== 'cloud' || computer.hostRef.provider !== 'circleci')
        .filter(computer => !hostRequired || supportsUserSystemd(computer))
        .filter(computer => !run.dispatchHostKey || computer.key === run.dispatchHostKey)
        .filter(computer => !run.setupRetry || !isDeepStrictEqual(computer.hostRef, run.setupRetry.failedComputer))
        .filter(computer => !run.retainedExecutions?.some(attempt =>
          attempt.executor === 'retained' && attempt.hostKey === computer.key))
        .filter(computer => !smokeTarget || isDeepStrictEqual(computer.hostRef, smokeTarget))
        .filter(computer => !run.gate || canTakeGatePart(run, computer))
        // Full-run backfill never takes a build computer a queued gate part is still waiting to use exclusively.
        .filter(computer => run.gate || computer.hostRef.kind === 'cloud' || !reservedHosts.has(computer.key) && (run.scope === 'affected' || !queued.some(item => item.gate && item.plannedHostKey === computer.key)))
        .filter(computer => computer.hostRef.kind !== 'cloud' || !computer.hostRef.provider
          || !run.unstartedProviders?.includes(computer.hostRef.provider))
      while (order.length) {
        const siblingComputers = new Set([...assignments.values()]
          .filter(assignment => assignment.groupId === run.groupId).map(assignment => assignment.computerKey))
        order.sort((left, right) => Number(siblingComputers.has(left.key)) - Number(siblingComputers.has(right.key))
          || Number(right.key === run.plannedHostKey) - Number(left.key === run.plannedHostKey)
          || Number(plannedProvider !== undefined && right.hostRef.provider === plannedProvider)
            - Number(plannedProvider !== undefined && left.hostRef.provider === plannedProvider)
          || preferred(right) - preferred(left)
          || Number(reservedCloud.has(left.key)) - Number(reservedCloud.has(right.key))
          || right.priority - left.priority)
        const computer = order.shift()!
        // The same bounded snapshot that counted this computer's free slots decides whether it can take the ticket.
        const status = this.planningEndpoint.dispatchStatus(computer)
        const rejected = this.dispatchRejections.reason(run.id, computer, status)
        const notReady = status?.ready ? undefined
          : status?.reasons.join('; ') || unavailable.get(computer.key) || 'CI status unavailable'
        const reason = computer.hostRef.kind === 'cloud' && !run.ciMirror
          ? 'This workspace has no CI mirror' : rejected ?? notReady
        if (reason) {
          reasons.push(`${computer.label}: ${reason}`)
          continue
        }
        if (run.gate && computer.hostRef.kind === 'cloud'
          && expectedCloudGateDurationMs(run, computer, speeds) > CLOUD_GATE_JOB_BUDGET_MS) {
          reasons.push(`${computer.label}: expected runtime exceeds the cloud job budget`)
          continue
        }
        if (run.gate && reservedCloud.has(computer.key)) {
          reasons.push(`${computer.label}: reserved for non-gate CI while a gate runs`)
          continue
        }
        const exclusiveGate = run.gate && computer.hostRef.kind !== 'cloud'
        if (exclusiveGate && (used.get(computer.key) ?? 0) > 0) {
          reasons.push(`${computer.label}: gate waits for exclusive use of this build computer`)
          continue
        }
        if (computer.hostRef.kind === 'cloud' && computer.hostRef.provider
          && run.unstartedProviders?.includes(computer.hostRef.provider)) continue
        if (!freeSlots(computer)) {
          reasons.push(`${computer.label}: all CI slots in use (${used.get(computer.key) ?? 0}/${totals.get(computer.key) ?? 1})`)
          continue
        }
        const usesGitHubIntegration = run.suite === 'integration' && isGitHubComputer(computer)
        if (usesGitHubIntegration && !run.gate && integrationOnGitHub.size >= integrationLimit) {
          reasons.push(`${computer.label}: slots reserved for queued checks`)
          continue
        }
        const shards = gateDispatchShards(run, computer.key, gateShards.get(computer.key)!)
        const start = this.startRequest(run, { ...selection, ...shards }, durations.get(run.id), coverage.get(run.groupId))
        // A cloud slot is claimed only once the shared mirror snapshot is on GitHub; build computers need no snapshot.
        if (computer.hostRef.kind === 'cloud') {
          if (!mirrorReady.has(run.id)) mirrorReady.set(run.id, this.mirrorPublished(start))
          if (!mirrorReady.get(run.id)) {
            reasons.push(`${computer.label}: publishing the CI mirror snapshot`)
            continue
          }
        }
        used.set(computer.key, (used.get(computer.key) ?? 0) + (exclusiveGate ? totals.get(computer.key) ?? 1 : 1))
        assignments.set(run.id, { groupId: run.groupId, computerKey: computer.key })
        if (usesGitHubIntegration) integrationOnGitHub.add(computer.key)
        const assigned = await claimCiSlot(this.pool, run, computer, start)
        if (assigned === 'busy') {
          assignments.delete(run.id)
          used.set(computer.key, totals.get(computer.key) ?? 1)
          if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          reasons.push(`${computer.label}: slot is busy with another CI ticket`)
          continue
        }
        if (!assigned) {
          assignments.delete(run.id)
          releaseSlot(computer)
          if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
          return
        }
        const outcome = await this.sendDispatch(assigned, computer)
        if (outcome === 'pending') return
        run = await this.read(run.id, run.workspaceId)
        if (run.state !== 'queued') return
        assignments.delete(run.id)
        if (outcome === 'busy') used.set(computer.key, totals.get(computer.key) ?? 1)
        else releaseSlot(computer)
        if (usesGitHubIntegration) integrationOnGitHub.delete(computer.key)
        reasons.push(`${computer.label}: ${run.message ?? outcome}`)
      }
      const systemdCloud = computers.some(computer => computer.hostRef.kind === 'cloud' && supportsUserSystemd(computer))
      let prefix = `No ready computer for ${run.part ?? run.suite}`
      if (hostRequired) {
        prefix = systemdCloud ? 'Waiting for a systemd-capable executor'
          : 'Waiting for a build computer: this integration slice needs one'
      }
      const message = sanitizeCiText(`${prefix}; ${reasons.join('; ') || 'no eligible computers'}`.slice(0, 2000))
      if (message !== run.message) await saveQueuedCiRun(this.pool, run, { ...run, message })
    })
    this.spareComputers = computers.filter(computer => freeSlots(computer) > 0)
  }
}

export { CI_HOST_NAMESPACE }

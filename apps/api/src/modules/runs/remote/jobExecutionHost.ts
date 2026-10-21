import { createHash } from 'node:crypto'
import type { JobLogChunk } from '@foreman-code/contracts/jobs'
import { componentLogger } from '../../diagnostics/logger.js'
import { isDeepStrictEqual } from 'node:util'
import { JobExecutionRecordSchema, type JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { RemoteJobExecutionRpcRequestRecordSchema, type RemoteJobDispatchIntent, type RemoteJobConnectionIdentity,
  type RemoteJobOwnerControl, type RemoteJobOperationReceiptRecord, type RemoteJobOperationStatusRecord,
  type RemoteJobTerminalEvidence } from '@foreman-code/contracts/remote-job-execution'
import { JobOutputCollectionError } from '../../jobs/executorOutputs.js'
import { executeJob, executeVerificationJob, jobSupervisorIdentity, type JobExecutorPorts,
  type JobExecutorResult, type JobSupervisor, type VerificationExecution, type VerificationJobExecutorPorts } from '../../jobs/executor.js'
import type { PodmanJobSupervisor } from '../../jobs/executorPodman.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import { jobContainerNonEntryObserved } from '../../jobs/executorJournal.js'
import { logIgnoredError } from '../../diagnostics/ignoredError.js'
import { isTransientExecutionError } from '../executionRetryPolicy.js'

const digest = (value: unknown) => createHash('sha256').update(canonicalGraphJson(value)).digest('hex')
type RuntimeSupervisor = JobSupervisor<JobExecutionRecord>
  & Pick<PodmanJobSupervisor<JobExecutionRecord>, 'reconcile' | 'stopExecution' | 'removeExecution'>
type ReconciledJob = NonNullable<Awaited<ReturnType<RuntimeSupervisor['reconcile']>>>

function recoveredOutcome(receipt: RemoteJobOperationReceiptRecord, observed: ReconciledJob,
  options: { interrupted?: boolean } = {}): NonNullable<JobExecutorResult['outcome']> {
  if (observed.neverStarted) return 'preparation_failed'
  if (options.interrupted || receipt.stopFence) return 'cancelled'
  if (observed.timedOut) return 'timed_out'
  if (observed.execError) return 'spawn_failed'
  return observed.exitCode === 0 ? 'succeeded' : 'build_failed'
}
export interface RemoteJobExecutionHostPorts {
  journal: RemoteOperationJournal
  connection: RemoteJobConnectionIdentity
  incarnationId: string
  supervisor: RuntimeSupervisor | ((execution: JobExecutionRecord) => Promise<RuntimeSupervisor>)
  source: JobExecutorPorts<JobExecutionRecord>['source']
  /** Mandatory W09 canonical delivery; exact tuple is verified before claim/native entry. */
  inputs: JobExecutorPorts<JobExecutionRecord>['inputs']
  appendLog: JobExecutorPorts['appendLog']
  /** Uses main's live, exact job grant; never an SQL connection on the worker. */
  authorize(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord, action: 'start'|'read'|'control'|'publish'): Promise<void>
  /** Actual main PostgresJobDispatch.observeReceipt ingress; closure acknowledged before bytes publish. */
  observeReceipt(receipt: RemoteJobOperationReceiptRecord): Promise<void>
  collectOutputs: JobExecutorPorts<JobExecutionRecord>['collectOutputs']
  prepareOutputs?: JobExecutorPorts<JobExecutionRecord>['prepareOutputs']
  verification?(execution: VerificationExecution): Promise<Pick<VerificationJobExecutorPorts,
    'measurement' | 'dispatchAt' | 'verifyAcceptedSpec' | 'prepareOutputs' | 'inputs'>>
  /** Runs after durable closure and live publication authorization; uses the original terminal receipt on retries. */
  preparePublication?(execution: JobExecutionRecord, terminal: RemoteJobTerminalEvidence): Promise<void>
  /** Drop local adapter state after acknowledged terminal publication and idle operation requests. */
  releaseOperation?(execution: JobExecutionRecord): void
}
export class RemoteJobExecutionHost {
  private readonly tasks = new Map<string, { controller: AbortController; task: Promise<void> }>()
  private readonly admissions = new Set<Promise<unknown>>()
  private readonly operationActivity = new Map<string, {
    users: number
    completed: JobExecutionRecord | null
  }>()
  private draining = false
  constructor(private readonly ports: RemoteJobExecutionHostPorts) {}
  private validate(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord) {
    const target = execution.acceptedSpec.target, connection = this.ports.connection
    const subject = execution.workflow ? { kind: 'workflow-node', workspaceId: execution.workspaceId, ...execution.workflow }
      : { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId }
    if (intent.executionId !== execution.id || intent.operationId !== execution.operationId || intent.attemptId !== execution.attemptId
      || intent.bindingHash !== execution.acceptedSpec.bindingHash || intent.inputDigest !== `sha256:${execution.acceptedSpec.specDigest}`
      || !isDeepStrictEqual(intent.owner, execution.owner) || !isDeepStrictEqual(intent.subject, subject) || target.mainId !== intent.mainId
      || target.mainId !== connection.mainId) throw new Error('Job dispatch does not match its actual immutable subject')
    if (target.hostRef.kind === 'device') {
      if (!('deviceId' in connection) || connection.deviceId !== target.hostRef.deviceId || connection.workerInstallationId !== target.registration?.workerInstallationId
        || connection.keyRevision !== target.registration.keyRevision || connection.authorizationRevision !== target.registration.authorizationRevision) throw new Error('Job worker registration mismatch')
    } else if (!('kind' in connection) || connection.kind !== 'main' || connection.mainInstallationId !== target.mainInstallationId) throw new Error('Job main installation mismatch')
  }
  /** Worker startup closes abandoned preparation and rearms original local watchdogs. */
  async recover(): Promise<void> {
    for (const receipt of await this.ports.journal.jobOperations()) {
      if (receipt.terminal) continue
      this.validate(receipt.intent, receipt.execution)
      if (!receipt.entryAttempted) {
        await this.closeAbandonedPreparation(receipt)
        continue
      }
      if (await this.retainConfirmedNonEntry(receipt)) continue
      const observed = await this.reconcileSupervisor(receipt)
      if (!observed) await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original OCI supervisor absent during worker recovery')
    }
  }
  async shutdown(): Promise<void> {
    const active = [...this.tasks.entries()]
    for (const [, owned] of active) owned.controller.abort(new Error('Worker job host is shutting down.'))
    await Promise.all(active.map(([, owned]) => owned.task))
    for (const receipt of await this.ports.journal.jobOperations()) {
      if (!receipt.entryAttempted || receipt.terminal) continue
      if (await this.retainConfirmedNonEntry(receipt)) continue
      const supervisor = await this.supervisor(receipt.execution)
      let observed = await supervisor.reconcile(receipt.execution)
      const interrupted = observed && !observed.stopped
      if (interrupted) {
        if (!await supervisor.stopExecution(receipt.execution, receipt.execution.acceptedSpec.policy.cancellationGraceMs, observed!.containerId)) throw new Error('Original Job shutdown closure remains unconfirmed')
        observed = await supervisor.reconcile(receipt.execution)
      }
      if (!observed?.stopped || observed.exitCode === null && !observed.neverStarted) {
        throw new Error('Original Job shutdown closure remains unconfirmed')
      }
      if (!receipt.native) await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId: observed.containerId,
        supervisorIdentity: jobSupervisorIdentity(receipt.execution), processIdentityDigest: digest({ executionId: receipt.execution.id,
          attemptId: receipt.execution.attemptId, operationId: receipt.execution.operationId, containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution) }) })
      await this.ports.journal.jobTerminal(receipt.intent.operationId, this.terminalEvidence({
        outcome: recoveredOutcome(receipt, observed, { interrupted: Boolean(interrupted) }), exitCode: observed.exitCode,
        signal: null, processStopped: true, supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId: observed.containerId,
        recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true))
    }
  }
  async handle(raw: unknown): Promise<RemoteJobOperationStatusRecord> {
    const frame = RemoteJobExecutionRpcRequestRecordSchema.parse(raw)
    if (frame.method === 'job-dispatch') return this.deliver(frame.intent, frame.execution)
    const status = await this.ports.journal.jobStatus(frame.intent.operationId)
    if (status.status !== 'known') {
      if (frame.method !== 'job-control' || !frame.execution) return status
      this.validate(frame.intent, frame.execution)
      await this.ports.authorize(frame.intent, frame.execution, 'control')
      await Promise.allSettled([...this.admissions])
      if ((await this.ports.journal.jobStatus(frame.intent.operationId)).status === 'known') return this.handle(raw)
      const receipt = await this.ports.journal.jobCancelBeforeEntry(frame.intent, frame.execution,
        this.ports.connection, this.ports.incarnationId, frame.command,
        this.preparationTerminal(frame.execution, 'cancelled'))
      return this.useOperation(frame.execution, async () => {
        await this.publish(receipt)
        return this.ports.journal.jobStatus(frame.intent.operationId)
      })
    }
    return this.useOperation(status.receipt.execution, async () => {
      if (!isDeepStrictEqual(status.receipt.intent, frame.intent)) throw new Error('Stale job RPC owner')
      this.validate(frame.intent, status.receipt.execution)
      await this.ports.authorize(frame.intent, status.receipt.execution, frame.method === 'job-control' ? 'control' : 'read')
      if (frame.method === 'job-control') {
        if (frame.command.operationId !== frame.intent.operationId || frame.command.executionId !== frame.intent.executionId ||
          frame.command.attemptId !== frame.intent.attemptId || frame.command.bindingHash !== frame.intent.bindingHash ||
          !isDeepStrictEqual(frame.command.subject, frame.intent.subject) || !isDeepStrictEqual(frame.command.owner, frame.intent.owner)) throw new Error('Job control envelope ownership mismatch')
        return this.control(frame.command)
      }
      return this.reconcile(status.receipt)
    })
  }
  deliver(intent: RemoteJobDispatchIntent, raw: JobExecutionRecord): Promise<RemoteJobOperationStatusRecord> {
    if (this.draining) return Promise.reject(new Error('Worker Job admissions are draining for runtime refresh.'))
    const task = this.accept(intent, raw)
    this.admissions.add(task)
    void task.then(() => this.admissions.delete(task), () => this.admissions.delete(task))
    return task
  }
  async beginDrain(): Promise<void> {
    this.draining = true
    await Promise.allSettled([...this.admissions])
    await this.drain()
  }
  resumeAdmissions(): void { this.draining = false }
  private async accept(intent: RemoteJobDispatchIntent, raw: JobExecutionRecord) {
    const execution = JobExecutionRecordSchema.parse(raw)
    this.validate(intent, execution)
    await this.ports.authorize(intent, execution, 'start')
    await this.ports.journal.jobAccept(intent, execution, this.ports.connection, this.ports.incarnationId)
    const status = await this.ports.journal.jobStatus(intent.operationId)
    if (status.status !== 'known') return status
    if (this.tasks.has(intent.operationId)) return status
    if (status.receipt.phase !== 'received') {
      return this.useOperation(execution, () => this.reconcile(status.receipt))
    }
    const controller = new AbortController()
    const task = this.useOperation(execution, () => this.execute(intent, execution, controller.signal)).catch(async error => {
      componentLogger('jobs').error({ err: error, operationId: intent.operationId }, 'Job execution or publication needs reconciliation')
      try {
        const latest = await this.ports.journal.jobStatus(intent.operationId)
        if (latest.status === 'known' && !latest.receipt.entryAttempted && isTransientExecutionError(error)) return
        await this.ports.journal.jobUncertain(intent.operationId, 'Original OCI execution requires reconciliation')
      } catch (journalError) {
        logIgnoredError('jobs', 'record uncertain job execution', journalError, { operationId: intent.operationId })
      }
    })
    this.tasks.set(intent.operationId, { controller, task })
    void task.finally(() => { if (this.tasks.get(intent.operationId)?.task === task) this.tasks.delete(intent.operationId) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return this.ports.journal.jobStatus(intent.operationId)
  }
  private async execute(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord, signal: AbortSignal) {
    const supervisor = await this.supervisor(execution)
    const ports: JobExecutorPorts<JobExecutionRecord> = {
      authority: {
        recheck: async () => { await this.ports.authorize(intent, execution, 'start') },
        claim: async (_execution, name) => {
          if (name !== jobSupervisorIdentity(execution)) throw new Error('Wrong OCI supervisor identity')
          await this.ports.authorize(intent, execution, 'start')
          const reservation = await this.ports.journal.jobReserveEntry(intent.operationId)
          return reservation.reserved ? 'launch' : reservation.receipt.stopFence ? 'cancelled' : 'reconcile'
        },
        launched: async (_execution, name, containerId) => {
          if (!containerId || name !== jobSupervisorIdentity(execution)) throw new Error('Positive original OCI container identity required')
          await this.ports.journal.jobAcknowledgeLaunch(intent.operationId, { containerId, supervisorIdentity: name,
            processIdentityDigest: digest({ executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, containerId, supervisorIdentity: name }), startedAt: new Date().toISOString() })
        },
      }, source: this.ports.source, inputs: this.ports.inputs, supervisor,
      appendLog: async chunk => {
        await this.ports.journal.jobAppendLog(intent.operationId, chunk)
        try { await this.flushLogs(intent.operationId) }
        catch { /* ignore: flushLogs reports the retained spool failure. */ }
      },
      collectOutputs: async () => {},
      ...(this.ports.prepareOutputs ? { prepareOutputs: this.ports.prepareOutputs } : {}),
    }
    let result: JobExecutorResult
    if (execution.schemaVersion === 2) {
      if (!this.ports.verification) throw new Error('Verification execution dependencies were not composed.')
      const verification = await this.ports.verification(execution)
      result = await executeVerificationJob(execution, { ...ports, ...verification }, signal)
    } else result = await executeJob(execution, ports, signal)
    if (result.recoveryRequired || !result.processStopped || !result.outcome) { await this.ports.journal.jobUncertain(intent.operationId, 'OCI entry or physical closure remains uncertain'); return }
    const logGapPossible = result.logError || (await this.ports.journal.jobPendingLogs(intent.operationId)).length > 0
    const receipt = await this.ports.journal.jobTerminal(intent.operationId, this.terminalEvidence(result, logGapPossible))
    await this.publish(receipt)
  }
  private supervisor(execution: JobExecutionRecord) {
    return typeof this.ports.supervisor === 'function' ? this.ports.supervisor(execution) : Promise.resolve(this.ports.supervisor)
  }
  private async useOperation<T>(execution: JobExecutionRecord, action: () => Promise<T>): Promise<T> {
    const operationId = execution.operationId
    const activity = this.operationActivity.get(operationId) ?? { users: 0, completed: null }
    activity.users++
    this.operationActivity.set(operationId, activity)
    try {
      return await action()
    } finally {
      activity.users--
      if (activity.users === 0) {
        this.operationActivity.delete(operationId)
        if (activity.completed) this.ports.releaseOperation?.(activity.completed)
      }
    }
  }
  private async observeReceipt(receipt: RemoteJobOperationReceiptRecord): Promise<void> {
    await this.ports.observeReceipt(receipt)
    const publicationFinished = receipt.publication === 'complete' || receipt.publication === 'failed'
    if (!this.ports.releaseOperation || !receipt.terminal?.processStopped || !publicationFinished) return
    const activity = this.operationActivity.get(receipt.intent.operationId)
    if (activity) activity.completed = receipt.execution
    else this.ports.releaseOperation(receipt.execution)
  }
  private async reconcileSupervisor(receipt: RemoteJobOperationReceiptRecord) {
    const supervisor = await this.supervisor(receipt.execution)
    let observed = await supervisor.reconcile(receipt.execution)
    if (receipt.native && observed && receipt.native.containerId !== observed.containerId) throw new Error('Recovered OCI container identity changed')
    if (receipt.stopFence && observed && !observed.stopped) {
      await supervisor.stopExecution(receipt.execution, receipt.execution.acceptedSpec.policy.cancellationGraceMs, observed.containerId)
      observed = await supervisor.reconcile(receipt.execution)
      if (receipt.native && observed && receipt.native.containerId !== observed.containerId) throw new Error('Recovered OCI container identity changed')
    }
    return observed
  }
  /** Each transition is fsynced before transport IO. Lost ACKs resume the same output commands. */
  private async publish(original: RemoteJobOperationReceiptRecord) {
    if (await this.ports.journal.isJobRetired(original.intent.operationId)) {
      await this.observeReceipt(original)
      return
    }
    let receipt = original
    if (receipt.native && receipt.terminal?.processStopped) {
      await (await this.supervisor(receipt.execution)).removeExecution(receipt.execution, receipt.native.containerId)
    }
    await this.observeReceipt(receipt)
    if (receipt.publication === 'complete' || receipt.publication === 'failed') return
    if (receipt.publication === 'pending') {
      receipt = await this.ports.journal.jobPublication(receipt.intent.operationId, 'process_recorded')
      await this.observeReceipt(receipt)
    }
    const owner = receipt.execution.schemaVersion === 2 ? await this.ports.journal.jobNativeOwner(receipt.intent.operationId) : null
    if (receipt.entryAttempted && (receipt.native || owner?.nonEntryConfirmed && owner.verification)) {
      try { await this.ports.authorize(receipt.intent, receipt.execution, 'publish') }
      catch (error) {
        if (isTransientExecutionError(error)) throw error
        await this.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'failed'))
        return
      }
      if (receipt.publication !== 'collecting') receipt = await this.ports.journal.jobPublication(receipt.intent.operationId, 'collecting')
      await this.observeReceipt(receipt)
      // A collector may have published before losing its ACK. Keep collecting; W09's
      // retained command IDs reconcile publication instead of allocating another revision.
      try {
        if (!receipt.terminal?.processStopped) throw new JobOutputCollectionError('Confirmed Job closure required before reports.')
        await this.ports.preparePublication?.(receipt.execution, receipt.terminal)
        await this.ports.collectOutputs(receipt.execution)
      } catch (error) {
        const publicationExpired = receipt.execution.schemaVersion === 2
          && Date.parse(receipt.execution.acceptedSpec.lifecycle.publicationDeadlineAt) <= Date.now()
        if (!(error instanceof JobOutputCollectionError) && !publicationExpired) throw error
        await this.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'failed')); return
      }
    }
    await this.observeReceipt(await this.ports.journal.jobPublication(receipt.intent.operationId, 'complete'))
  }
  private async flushLogs(operationId: string) {
    let pending: JobLogChunk[] | undefined
    let acknowledged = 0
    try {
      pending = await this.ports.journal.jobPendingLogs(operationId)
      for (const chunk of pending) {
        await this.ports.appendLog(chunk)
        await this.ports.journal.jobAcknowledgeLog(operationId, chunk.sequence)
        acknowledged++
      }
    } catch (error) {
      const retained = pending?.slice(acknowledged)
      logIgnoredError('jobs', 'flush remote job log spool', error, { operationId,
        pendingBytes: retained ? retained.reduce((sum, chunk) => sum + chunk.byteSize, 0) : null,
        pendingSince: retained?.[0]?.createdAt ?? null })
      throw error
    }
  }
  private terminalEvidence(result: JobExecutorResult, logGapPossible: boolean): RemoteJobTerminalEvidence {
    if (!result.outcome || !result.processStopped || result.recoveryRequired) throw new Error('Positive OCI closure required')
    return { finishedAt: new Date().toISOString(), closureEvidenceDigest: digest({ containerId: result.containerId ?? null, supervisorIdentity: result.supervisorIdentity ?? null,
      processStopped: result.processStopped, exitCode: result.exitCode, signal: result.signal }), outcome: result.outcome, exitCode: result.exitCode, signal: result.signal,
      processStopped: true, resultDigest: digest(result), logGapPossible, logsTruncated: result.logsTruncated, outputCollectionError: result.outputCollectionError, artifactDigests: [] }
  }
  private async reconcile(receipt: RemoteJobOperationReceiptRecord) {
    try { await this.flushLogs(receipt.intent.operationId) }
    catch { /* ignore: flushLogs reports the retained spool failure. */ }
    if (this.tasks.has(receipt.intent.operationId)) return this.ports.journal.jobStatus(receipt.intent.operationId)
    if (receipt.terminal) { await this.publish(receipt); return this.ports.journal.jobStatus(receipt.intent.operationId) }
    if (!receipt.entryAttempted) {
      if (this.admissions.size > 0) return this.ports.journal.jobStatus(receipt.intent.operationId)
      if (!receipt.stopFence && receipt.phase === 'received') return this.deliver(receipt.intent, receipt.execution)
      const closed = await this.closeAbandonedPreparation(receipt)
      if (closed) await this.publish(closed)
      return this.ports.journal.jobStatus(receipt.intent.operationId)
    }
    await this.ports.authorize(receipt.intent, receipt.execution, 'read')
    if (await this.retainConfirmedNonEntry(receipt)) {
      const status = await this.ports.journal.jobStatus(receipt.intent.operationId)
      if (status.status !== 'known') throw new Error('Original non-entry receipt unavailable')
      await this.publish(status.receipt)
      return this.ports.journal.jobStatus(receipt.intent.operationId)
    }
    const observed = await this.reconcileSupervisor(receipt)
    if (!observed) {
      const supervisor = await this.supervisor(receipt.execution)
      if (!receipt.native && await supervisor.stopExecution(receipt.execution, 0)
        && (await this.ports.journal.jobNativeOwner(receipt.intent.operationId))?.nonEntryConfirmed) {
        const evidence = this.terminalEvidence({ outcome: receipt.stopFence ? 'cancelled' : 'preparation_failed',
          exitCode: null, signal: null, processStopped: true, supervisorIdentity: jobSupervisorIdentity(receipt.execution),
          containerId: null, recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true)
        await this.publish(await this.ports.journal.jobTerminal(receipt.intent.operationId, evidence))
      } else await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original OCI supervisor absent: nonexecution not proven')
      return this.ports.journal.jobStatus(receipt.intent.operationId)
    }
    if (!receipt.native) await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution), processIdentityDigest: digest({ executionId: receipt.execution.id, attemptId: receipt.execution.attemptId, operationId: receipt.execution.operationId, containerId: observed.containerId, supervisorIdentity: jobSupervisorIdentity(receipt.execution) }) })
    // Recovered absence of logs is explicit; stopped without exact exit outcome remains uncertain.
    if (!observed.stopped || observed.exitCode === null && !observed.neverStarted) {
      return this.ports.journal.jobStatus(receipt.intent.operationId)
    }
    const evidence = this.terminalEvidence({ outcome: recoveredOutcome(receipt, observed),
      exitCode: observed.exitCode, signal: null, processStopped: true,
      supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId: observed.containerId, recoveryRequired: false, logError: true, logsTruncated: false, outputCollectionError: false }, true)
    await this.publish(await this.ports.journal.jobTerminal(receipt.intent.operationId, evidence))
    return this.ports.journal.jobStatus(receipt.intent.operationId)
  }
  private preparationTerminal(execution: JobExecutionRecord, outcome: 'cancelled' | 'preparation_failed') {
    return this.terminalEvidence({ outcome, exitCode: null, signal: null, processStopped: true,
      supervisorIdentity: jobSupervisorIdentity(execution), containerId: null, recoveryRequired: false,
      logError: false, logsTruncated: false, outputCollectionError: false }, false)
  }
  private async closeAbandonedPreparation(receipt: RemoteJobOperationReceiptRecord) {
    const owner = await this.ports.journal.jobNativeOwner(receipt.intent.operationId)
    if (owner && !await (await this.supervisor(receipt.execution)).stopExecution(receipt.execution, 0)) {
      await this.ports.journal.jobUncertain(receipt.intent.operationId, 'Original Job preparation closure remains unconfirmed')
      return null
    }
    return this.ports.journal.jobTerminal(receipt.intent.operationId,
      this.preparationTerminal(receipt.execution, receipt.stopFence ? 'cancelled' : 'preparation_failed'))
  }
  private async retainConfirmedNonEntry(receipt: RemoteJobOperationReceiptRecord): Promise<boolean> {
    const retained = await this.ports.journal.jobNativeOwner(receipt.intent.operationId)
    if (receipt.native || !retained?.nonEntryConfirmed || !jobContainerNonEntryObserved(retained)) return false
    const containerId = retained.container?.containerId ?? null
    if (containerId) {
      const supervisorIdentity = jobSupervisorIdentity(receipt.execution)
      await this.ports.journal.jobAcknowledgeLaunch(receipt.intent.operationId, { containerId, supervisorIdentity,
        processIdentityDigest: digest({ executionId: receipt.execution.id, attemptId: receipt.execution.attemptId,
          operationId: receipt.execution.operationId, containerId, supervisorIdentity }) })
    }
    await this.ports.journal.jobTerminal(receipt.intent.operationId, this.terminalEvidence({
      outcome: receipt.stopFence ? 'cancelled' : 'preparation_failed', exitCode: null, signal: null,
      processStopped: true, supervisorIdentity: jobSupervisorIdentity(receipt.execution), containerId,
      recoveryRequired: false, logError: true, logsTruncated: false,
      outputCollectionError: false }, true))
    return true
  }
  private async control(command: RemoteJobOwnerControl) {
    const recorded = await this.ports.journal.jobControl(command)
    this.tasks.get(command.operationId)?.controller.abort()
    if (recorded.dispatch && this.tasks.has(command.operationId)) await (await this.supervisor(recorded.receipt.execution)).stopExecution(recorded.receipt.execution,
      recorded.receipt.execution.acceptedSpec.policy.cancellationGraceMs, recorded.receipt.native?.containerId)
    return this.reconcile(recorded.receipt)
  }
  async drain() { await Promise.all([...this.tasks.values()].map(value => value.task)) }
}

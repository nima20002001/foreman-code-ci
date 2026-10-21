import { JobAuthoringChoicesRecordSchema, type JobAuthoringChoicesRecord } from '@foreman-code/contracts/job-verification'
import {
  JobExecutionRecordSchema,
  JobDefinitionRecordSchema,
  PreparedJobSpecRecordSchema,
  isAutoJobSpecRecord,
  type JobDefinitionRecord,
  type JobDefinitionSpecRecord,
  type ResolvedJobDefinitionSpecRecord,
  type JobExecutionRecord,
  type PreparedJobSpecRecord,
} from '@foreman-code/contracts/job-verification'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
import type { JobPreparationPort, JobQueueConfiguration } from './ports.js'
import type pg from 'pg'
import { JobQueueTicketSchema, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { JobOwnership } from './ownership.js'
import { jobEligibilityReason, releaseClosedJobComputers, releaseUnstartedJobComputer,
  type JobComputerSelection } from './computerSelection.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { requireJobPreparationDeadline } from './preparationDeadline.js'
import { componentLogger } from '../diagnostics/logger.js'
export interface JobPreparationSources {
  revalidateAccepted(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord,
    options?: { requireQualification: boolean }):Promise<void>
  /** Actual W12 computer/root, W09 scoped snapshot and CI-A qualified profile readbacks. No probes/install side effects. */
  adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord):Promise<void>
  choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string):Promise<JobAuthoringChoicesRecord>
  /** Real W09 verified private repository materialization, bound to this genuine job/attempt. */
  materialize(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:ResolvedJobDefinitionSpecRecord,identity:{executionId:string;attemptId:string;operationId:string}):Promise<PreparedJobSpecRecord>
}

interface QueuePreparationPorts {
  configuration: JobQueueConfiguration
  placement: JobComputerSelection
  prepare(principal: ManagementPrincipal, definition: JobDefinitionRecord, ticket: JobQueueTicket): Promise<PreparedJobSpecRecord>
  admit(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinitionRecord,
    prepared: PreparedJobSpecRecord, ticket: JobQueueTicket): Promise<JobExecutionRecord>
  wake(execution: JobExecutionRecord): Promise<void>
  closePreparation?(ticket: JobQueueTicket): Promise<void>
  prepareRuntime?(ticket: JobQueueTicket): Promise<void>
}

/** Claims capacity in queue order, then prepares on the original attempt outside SQL locks. */
export class JobQueuePreparation {
  private readonly repository = new JobRepository()
  private readonly work = new Map<string, Promise<void>>()
  constructor(private readonly pool: pg.Pool, private readonly ports: QueuePreparationPorts,
    private readonly clock: () => Date) {}

  async scan(): Promise<Promise<void>[]> {
    const tasks = [...this.work.values()]
    const order = await JobOwnership.acquire(this.pool, 'job-admission-order', () => {})
    if (!order) return tasks
    const claimed: { ticket: JobQueueTicket; owner: JobOwnership }[] = []
    const cleanups: { ticket: JobQueueTicket; owner: JobOwnership }[] = []
    const waiting: JobQueueTicket[] = []
    let recoveries: JobExecutionRecord[]
    const barriers: { id: string; hosts: string[]; claims: number }[] = []
    try {
      await order.connection.transaction(sql => this.repository.finishCompletedQueueTickets(sql))
      const terminal = await order.connection.query<{ record: unknown }>(`select q.record
        from job_admission_queue q join job_computer_selections s on s.execution_id=q.execution_id
        where q.record->>'state'='terminal' and s.released_at is null
          and not exists(select 1 from job_executions e where e.id=q.execution_id)
        order by q.enqueue_sequence`)
      const pending = [...terminal.rows.map(row => JobQueueTicketSchema.parse(row.record)),
        ...await this.repository.pendingQueue(order.connection)]
      const accepted = await order.connection.query<{ record: unknown }>(`select e.record
        from job_admission_queue q join job_executions e on e.id=q.execution_id and e.workspace_id=q.workspace_id
        where (q.record->>'state'='accepted' or q.record->>'terminalReason'='completed') and
          (e.record #>> '{process,phase}'<>'terminal'
            or e.record #> '{process,processStopped}'<>'true'::jsonb
            or e.record->>'publication' in ('pending','collecting')
            or exists(select 1 from source_execution_materializations m
              where m.operation_id=e.operation_id and m.state<>'closed')
            or exists(select 1 from job_computer_selections s
              where s.execution_id=e.id and s.released_at is null))`)
      recoveries = accepted.rows.map(row => JobExecutionRecordSchema.parse(row.record))
      for (const pendingTicket of pending) {
        order.assertOwned()
        if (this.work.has(pendingTicket.executionId)) continue
        const owner = await JobOwnership.acquire(this.pool, pendingTicket.executionId, () => {})
        if (!owner) continue
        let retained = false
        try {
          const ticket = await owner.connection.transaction(async sql => {
            beforeGraphCommit(sql, async () => { order.assertOwned() })
            const ticket = await this.repository.queueTicket(sql, pendingTicket.workspaceId, pendingTicket.id, true)
            if (ticket.state === 'accepted') return null
            if (ticket.state === 'terminal') {
              await this.fence(sql, owner, ticket)
              return ticket
            }
            if (ticket.cancelRequestedAt) {
              await this.finish(sql, ticket, 'cancelled')
              return null
            }
            let principal: ManagementPrincipal
            try {
              principal = await this.principal(sql, ticket)
            } catch (error) {
              if (!(error instanceof DomainError) || error.status !== 403) throw error
              await this.finish(sql, ticket, 'authorization_revoked', [error.code])
              return null
            }
            if (ticket.sourceCapacityWait && this.clock().getTime() >= Date.parse(ticket.deadlineAt)) {
              await this.finish(sql, ticket, 'timed_out')
              return null
            }
            if (ticket.sourceCapacityWait && this.clock().getTime() < Date.parse(ticket.sourceCapacityWait.retryAt)) {
              return null
            }
            if (ticket.state === 'claimed' || ticket.sourceCapacityWait) {
              await this.fence(sql, owner, ticket)
              return ticket
            }
            if (this.clock().getTime() >= Date.parse(ticket.deadlineAt)) {
              await this.finish(sql, ticket, 'timed_out')
              return null
            }
            const claimed = await this.claim(sql, principal, ticket, owner, barriers)
            if (!claimed && ticket.runtimePreparation) {
              const blocked = await this.repository.queueTicket(sql, ticket.workspaceId, ticket.id)
              if (blocked.waitingReasons.includes('dependencies_changed')) waiting.push(blocked)
            }
            return claimed
          })
          if (ticket) {
            if (ticket.state === 'terminal') cleanups.push({ ticket, owner })
            else claimed.push({ ticket, owner })
            retained = true
          }
        } finally {
          if (!retained) await owner.release()
        }
      }
    } catch (error) {
      await Promise.allSettled([...claimed, ...cleanups].map(({ owner }) => owner.release()))
      throw error
    } finally {
      await order.release()
    }
    for (const { ticket, owner } of claimed) {
      tasks.push(this.track(ticket.executionId, () => this.prepare(ticket, owner)))
    }
    for (const { ticket, owner } of cleanups) {
      tasks.push(this.track(ticket.executionId, async () => {
        try { await this.closePreparation(ticket, owner) }
        finally { await owner.release() }
      }))
    }
    for (const execution of recoveries) {
      tasks.push(this.track(execution.id, () => this.ports.wake(execution)))
    }
    for (const ticket of waiting) {
      tasks.push(this.track(`runtime:${ticket.id}`, () => this.ports.prepareRuntime?.(ticket) ?? Promise.resolve()))
    }
    return tasks
  }

  private track(executionId: string, run: () => Promise<void>): Promise<void> {
    const existing = this.work.get(executionId)
    if (existing) return existing
    const task = run().finally(() => { this.work.delete(executionId) })
    this.work.set(executionId, task)
    // Scans continue while source I/O is pending; retain failures for callers awaiting this work.
    void task.catch(error => componentLogger('jobs').error({ err: error, executionId }, 'Job queue work failed'))
    return task
  }

  async waitForWork(tasks: readonly Promise<void>[] = [...this.work.values()]): Promise<void> {
    const pending = new Set([...tasks, ...this.work.values()])
    const results = await Promise.allSettled(pending)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  private async principal(sql: JobSql, ticket: JobQueueTicket): Promise<ManagementPrincipal> {
    const principal = await readLiveManagementPrincipal(sql, ticket.principalId)
    requireAuthorization(principal, 'jobs:start', { workspaceId: ticket.workspaceId })
    return principal
  }

  private async fence(sql: GraphTransactionSql,
    owner: JobOwnership, ticket: JobQueueTicket): Promise<void> {
    const fence = await owner.readFence(sql)
    await sql.query('update job_admission_queue set owner_id=$2,owner_fence=$3 where id=$1',
      [ticket.id, fence.ownerId, fence.fence])
    beforeGraphCommit(sql, async () => { owner.assertOwned() })
  }

  private async claim(sql: GraphTransactionSql,
    principal: ManagementPrincipal, ticket: JobQueueTicket, owner: JobOwnership,
    barriers: { id: string; hosts: string[]; claims: number }[]): Promise<JobQueueTicket | null> {
    const excluded = new Set(barriers.filter(barrier => barrier.claims >= this.ports.configuration.limits.maxBackfillClaims)
      .flatMap(barrier => barrier.hosts))
    let claim
    try {
      claim = await this.ports.placement.claim(sql, principal, JobDefinitionRecordSchema.parse(ticket.definition), ticket,
        { excludedHosts: excluded, placementOverride: ticket.placementOverride, limits: ticket.resources.limits,
          queued: true })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      const reason = jobEligibilityReason(error.code)
      if (error.status === 403 || reason === 'authorization_revoked') {
        await this.finish(sql, ticket, 'authorization_revoked', [error.code])
        return null
      }
      await this.repository.putQueueTicket(sql, { ...ticket, state: 'blocked', waitingReasons: [reason],
        compatibleTargetCount: 0 })
      await sql.query('update job_admission_queue set diagnostic_codes=$2::jsonb where id=$1',
        [ticket.id, JSON.stringify([error.code])])
      return null
    }
    if (claim.exceedsMaximum || claim.reasons.includes('authorization_revoked')) {
      await this.finish(sql, ticket, claim.exceedsMaximum ? 'request_exceeds_maximum' : 'authorization_revoked',
        claim.diagnosticCodes)
      return null
    }
    if (!claim.spec) {
      const blocked = claim.reasons.some(reason => reason !== 'busy' && reason !== 'offline')
      await this.repository.putQueueTicket(sql, { ...ticket, state: blocked ? 'blocked' : 'waiting',
        waitingReasons: claim.reasons, compatibleTargetCount: claim.compatibleTargetCount })
      await sql.query('update job_admission_queue set diagnostic_codes=$2::jsonb where id=$1',
        [ticket.id, JSON.stringify(claim.diagnosticCodes)])
      const row = (await sql.query<{ backfill_claims: number }>(
        'select backfill_claims from job_admission_queue where id=$1', [ticket.id])).rows[0]!
      barriers.push({ id: ticket.id, hosts: claim.waitingHosts, claims: row.backfill_claims })
      return null
    }
    const selection = (await sql.query<{ limits: unknown }>(
      'select limits from job_computer_selections where execution_id=$1', [ticket.executionId])).rows[0]!
    if (canonicalJson(selection.limits) !== canonicalJson(ticket.resources.limits)) {
      throw new DomainError('JOB_RESOURCE_REQUEST_CONFLICT', 'The reviewed build envelope differs from the runtime limits.', 409)
    }
    for (const barrier of barriers.filter(barrier => claim.selectedHost && barrier.hosts.includes(claim.selectedHost))) {
      barrier.claims++
      await sql.query('update job_admission_queue set backfill_claims=backfill_claims+1 where id=$1', [barrier.id])
    }
    await sql.query(`insert into job_preparations
      (execution_id,attempt_id,operation_id,workspace_id,definition_version_id,principal_id,command_id,definition,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) on conflict(execution_id) do nothing`,
    [ticket.executionId, ticket.attemptId, ticket.operationId, ticket.workspaceId, ticket.definition.versionId,
      ticket.principalId, ticket.commandId, JSON.stringify(ticket.definition), this.clock().toISOString()])
    await this.fence(sql, owner, ticket)
    return this.repository.putQueueTicket(sql, { ...ticket, state: 'claimed', reservationId: ticket.id,
      waitingReasons: [], queuePosition: null, compatibleTargetCount: claim.compatibleTargetCount })
  }

  private async finish(sql: JobSql, ticket: JobQueueTicket,
    reason: NonNullable<JobQueueTicket['terminalReason']>, diagnosticCodes: string[] = []): Promise<void> {
    await this.repository.finishQueueTicket(sql, ticket, reason, this.clock().toISOString())
    await sql.query('update job_admission_queue set diagnostic_codes=$2::jsonb where id=$1',
      [ticket.id, JSON.stringify(diagnosticCodes)])
    if (ticket.reservationId) await releaseUnstartedJobComputer(sql, ticket)
  }

  private async closePreparation(original: JobQueueTicket, owner: JobOwnership): Promise<void> {
    const ticket = await owner.connection.transaction(async sql => {
      const current = await this.repository.queueTicket(sql, original.workspaceId, original.id, true)
      if (current.state !== 'terminal' || !current.reservationId) return null
      await this.fence(sql, owner, current)
      await releaseUnstartedJobComputer(sql, current)
      const pending = await sql.query(`select 1 from job_computer_selections
        where execution_id=$1 and released_at is null`, [current.executionId])
      return pending.rowCount ? current : null
    })
    if (!ticket) return
    await this.ports.closePreparation?.(ticket)
    owner.assertOwned()
    await owner.connection.transaction(sql => releaseClosedJobComputers(sql))
  }

  private async prepare(original: JobQueueTicket, owner: JobOwnership): Promise<void> {
    let executionToWake: JobExecutionRecord | null
    const capacityWaitMs = original.sourceCapacityWait
      ? original.sourceCapacityWait.waitedMs + Math.max(0,
        this.clock().getTime() - Date.parse(original.sourceCapacityWait.startedAt))
      : 0
    try {
      const principal = await owner.connection.transaction(sql => this.principal(sql, original))
      // Capacity waiting uses the queue deadline, not the source I/O budget.
      await owner.connection.transaction(sql => requireJobPreparationDeadline(sql, 'manual', original.executionId,
        original.definition.spec.policy.preparationTimeoutMs + capacityWaitMs, this.clock().getTime()))
      const prepared = await this.ports.prepare(principal, JobDefinitionRecordSchema.parse(original.definition), original)
      owner.assertOwned()
      executionToWake = await owner.connection.transaction(async sql => {
        await lockActiveWorkspace(sql, original.workspaceId)
        const ticket = await this.repository.queueTicket(sql, original.workspaceId, original.id, true)
        if (ticket.state === 'terminal') return null
        if (ticket.cancelRequestedAt) {
          await this.finish(sql, ticket, 'cancelled')
          return null
        }
        const live = await this.principal(sql, ticket)
        await requireJobPreparationDeadline(sql, 'manual', ticket.executionId,
          ticket.definition.spec.policy.preparationTimeoutMs + capacityWaitMs, this.clock().getTime())
        await this.fence(sql, owner, ticket)
        const execution = await this.ports.admit(sql, live, JobDefinitionRecordSchema.parse(ticket.definition), prepared, ticket)
        const accepted = { ...ticket }
        delete accepted.sourceCapacityWait
        await this.repository.putQueueTicket(sql, { ...accepted, state: 'accepted', waitingReasons: [] })
        return execution
      })
    } catch (error) {
      if (error instanceof DomainError && error.code !== 'JOB_OWNERSHIP_LOST') {
        owner.assertOwned()
        await owner.connection.transaction(async sql => {
          const ticket = await this.repository.queueTicket(sql, original.workspaceId, original.id, true)
          if (ticket.state !== 'claimed' && !ticket.sourceCapacityWait) return
          if (error.status === 403) await this.finish(sql, ticket, 'authorization_revoked', [error.code])
          else if (error.code === 'JOB_PREPARATION_TIMEOUT') await this.finish(sql, ticket, 'timed_out', [error.code])
          else if (['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY', 'SOURCE_CAPACITY_UNAVAILABLE'].includes(error.code)) {
            const attempts = (ticket.sourceCapacityWait?.attempts ?? 0) + 1
            const now = this.clock().getTime()
            const delayMs = Math.min(60_000, 5_000 * 2 ** Math.min(attempts - 1, 4))
            await this.repository.putQueueTicket(sql, { ...ticket, state: 'waiting', waitingReasons: ['busy'],
              sourceCapacityWait: { attempts, waitedMs: capacityWaitMs, startedAt: new Date(now).toISOString(),
                retryAt: new Date(now + delayMs).toISOString() } })
            if (!ticket.sourceCapacityWait) {
              componentLogger('jobs').info({ ticketId: ticket.id }, 'Queued Job waiting for source capacity')
            }
          }
          else {
            const failed = { ...ticket }
            delete failed.sourceCapacityWait
            await this.repository.putQueueTicket(sql, { ...failed, state: 'claimed', waitingReasons: [jobEligibilityReason(error.code)] })
            await sql.query('update job_admission_queue set diagnostic_codes=$2::jsonb where id=$1',
              [ticket.id, JSON.stringify([error.code])])
          }
        })
      }
      if (error instanceof DomainError
        && ['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY', 'SOURCE_CAPACITY_UNAVAILABLE'].includes(error.code)) return
      componentLogger('jobs').error({ err: error, ticketId: original.id }, 'Queued Job preparation or dispatch failed')
      throw error
    } finally {
      try { await this.closePreparation(original, owner) }
      finally { await owner.release() }
    }
    // Dispatch takes over the same session-lock identity after preparation releases it.
    if (executionToWake) await this.ports.wake(executionToWake)
  }
}
/** Source/target/profile authority is drawn from current inventory, never trusted caller attestations. */
export class JobPreparationService implements JobPreparationPort {
  constructor(private readonly sources:JobPreparationSources) {}
  async revalidateAccepted(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord,
    options?: { requireQualification: boolean }) {
    await this.sources.revalidateAccepted(sql,principal,execution,options)
  }
  async adoptFinalBinding(sql:JobSql,principal:ManagementPrincipal,execution:JobExecutionRecord) {
    await this.sources.adoptFinalBinding(sql,principal,execution)
  }
  async choices(sql:JobSql,principal:ManagementPrincipal,workspaceId:string) {
    return JobAuthoringChoicesRecordSchema.parse(await this.sources.choices(sql,principal,workspaceId))
  }
  async validate(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:JobDefinitionSpecRecord) {
    if (isAutoJobSpecRecord(spec)) return { valid: false, reasons: ['AUTO_SOURCE_VALIDATION_UNAVAILABLE'], sideEffects: false as const }
    const choices=await this.choices(sql,principal,workspaceId),reasons:string[]=[]
    const target=choices.targets.find(choice=>canonicalJson(choice.target)===canonicalJson(spec.target))
    if(!target)reasons.push('TARGET_AUTHORITY_CHANGED')
    else if(!target.ready)reasons.push(...target.reasons)
    if(!choices.sources.some(source=>canonicalJson(source)===canonicalJson(spec.source)))reasons.push('SOURCE_REVISION_UNAVAILABLE')
    if(!choices.policies.some(policy=>canonicalJson(policy)===canonicalJson(spec.policy)))reasons.push('ISOLATION_POLICY_UNAVAILABLE')
    return {valid:reasons.length===0,reasons,sideEffects:false as const}
  }
  async accept(sql:JobSql,principal:ManagementPrincipal,workspaceId:string,spec:ResolvedJobDefinitionSpecRecord,identity:{executionId:string;attemptId:string;operationId:string}) {
    const ready=await this.validate(sql,principal,workspaceId,spec)
    if(!ready.valid){componentLogger('jobs').warn({executionId:identity.executionId,reasons:ready.reasons},'Job preparation validation failed');throw new DomainError('JOB_NOT_READY','Current source, target or isolation authority does not match the saved job.',409,{reasons:ready.reasons})}
    return PreparedJobSpecRecordSchema.parse(await this.sources.materialize(sql,principal,workspaceId,spec,identity))
  }
}

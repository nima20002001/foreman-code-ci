import { errorMessage } from '../../shared/errorMessage.js'
import { randomUUID } from 'node:crypto'
import { DurableInteractionSchema, type DurableInteraction } from '@foreman-code/contracts'
import type pg from 'pg'
import type { NativeRollout } from '../harnesses/nativeRollout.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { PostgresInteractionCoordinationRepository } from './coordination.js'
import type { ReviewerDispatcher } from './reviewer.js'
import { assertOrchestratorGraphAuthority } from './graphAuthority.js'
import { DomainError } from '../errors.js'
import { requestReviewFailureStop } from './reviewFailureLifecycle.js'
import type { ApprovalExecutionCoordinator } from './execution.js'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

/** Drives durable, explicitly assigned reviewers; never fabricates a board Agent or grants. */
export class AutomaticReviewService {
  private readonly coordination: PostgresInteractionCoordinationRepository
  private readonly dispatcher: ReviewerDispatcher
  private readonly workerId = `reviewer-${randomUUID()}`
  private readonly tasks = new Map<string, Promise<unknown>>()
  private readonly lastErrors = new Map<string, string>()
  private polling: Promise<void> | undefined
  private closing = false
  private shutdownTask: Promise<void> | undefined
  constructor(private readonly pool: pg.Pool, private readonly runs: PostgresRunRepository,
    private readonly native: ApprovalExecutionCoordinator, private readonly locations: WorkspaceLocationService, private readonly rollout: NativeRollout,
    private readonly stopFailedRun?: (runId: string) => Promise<void>) {
    this.coordination = native.reviewCoordination
    this.dispatcher = native.reviewers
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve()
    if (this.polling) return this.polling
    this.polling = this.poll().finally(() => { this.polling = undefined })
    return this.polling
  }
  private async poll() {
    // Failures remain discoverable after their interaction was delivered/canceled,
    // and after restart. Stop is requested even while native cleanup is uncertain.
    await this.reconcileFailedReviews()
    await this.dispatcher.reconcile(() => undefined)
    let after = ''
    while (!this.closing) {
      const result = await this.pool.query<{ id: string; record: unknown }>(`select id,record from durable_interactions
        where id>$1 and status='pending' and record->'approval'->>'handler'='orchestrator'
        order by id limit 50`, [after])
      if (!result.rows.length) break
      for (const row of result.rows) {
        after = row.id
        if (this.closing) break
        const interaction = DurableInteractionSchema.parse(row.record)
        if (!interaction.graphInterruptId || this.tasks.has(interaction.id)) continue
        const task = this.schedule(interaction).catch(async (error: unknown) => {
          const message = error instanceof DomainError ? error.code : 'REVIEW_SETUP_UNCERTAIN'
          this.lastErrors.set(interaction.id, message)
          logIgnoredError('engine', 'schedule automatic review', error, {
            interactionId: interaction.id, runId: interaction.runId,
          })
          // A failed setup is not native terminal evidence. The authoritative
          // interaction remains pending; do not publish fabricated job facts.

        }).finally(() => this.tasks.delete(interaction.id))
        this.tasks.set(interaction.id, task)
        void task.catch(ignoreError('engine', 'finish automatic review task', { interactionId: interaction.id }))
      }
    }
  }
  private async stopFailedJob(reviewJobId: string): Promise<void> {
    const runId = await requestReviewFailureStop(this.pool, { reviewJobId })
    if (runId) await this.stopFailedRun?.(runId)
  }

  private async reconcileFailedReviews(): Promise<void> {
    let after = ''
    while (!this.closing) {
      const page = await this.pool.query<{ id: string }>(
        `select j.id from review_jobs j join durable_interactions i on i.id=j.interaction_id
         join runs r on r.id=i.run_id where j.id>$1 and j.state='failed'
           and (r.execution_state<>'completed' or j.record->'cleanup'->>'completedAt' is null)
         order by j.id limit 50`, [after],
      )
      if (!page.rows.length) return
      for (const row of page.rows) {
        after = row.id
        if (this.closing) return
        // One unavailable native boundary must not starve other Runs' cleanup.
        try { await this.stopFailedJob(row.id) }
        catch (error) {
          logIgnoredError('engine', 'retry failed review cleanup', error, { reviewJobId: row.id })
          this.lastErrors.set(`failure:${row.id}`, errorMessage(error, 'Review cleanup failed.'))
        }
      }
    }
  }

  private async schedule(interaction: DurableInteraction): Promise<void> {
    const run = await this.runs.get(interaction.runId)
    if (!run || !['running', 'waiting'].includes(run.executionState) || !run.authorizationPrincipalId) return
    await this.locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId)
    if (this.closing) return
    const reviewerId = interaction.approval.designatedOrchestratorAgentId
    if (!reviewerId || reviewerId === interaction.requestingAgentId) throw new Error('Automatic review requires a different designated Orchestrator.')
    try { await assertOrchestratorGraphAuthority(this.pool, interaction) }
    catch (error) {
      if (error instanceof DomainError && error.code === 'INTERACTION_ACCESS_DENIED') {
        // A pre-upgrade invalid wait must not repeatedly dispatch or wait forever.
        const failedRunId = await requestReviewFailureStop(this.pool, {
          interactionId: interaction.id, errorCode: 'APPROVAL_DIRECT_CONNECTION_REQUIRED',
        })
        if (failedRunId) await this.stopFailedRun?.(failedRunId)
      }
      throw error
    }
    const configurationId = run.agentConfigurationVersionIds[reviewerId]
    const configuration = configurationId && await this.runs.getExecutionConfiguration(configurationId)
    if (!configuration || !this.rollout.enabled(configuration.harness.harness)) throw new DomainError(
      'REVIEWER_NATIVE_UNQUALIFIED', 'The pinned reviewer has not passed native provider qualification.', 409)
    // The coordinator selects the exact accepted execution/occurrence through
    // the saved approval relationship, not a latest execution for the Agent.
    await this.native.enqueueReview(interaction)
    if (this.closing) return
    const job = await this.dispatcher.dispatchNext(reviewerId, this.workerId)
    // Transactional review events already carry the actual job's Run/execution.
    // A reviewer-wide dispatch can select another interaction, possibly in another Run.
    if (job?.state === 'failed') await this.stopFailedJob(job.id)
    const current = await this.coordination.findReviewJob(interaction.id, reviewerId)
    if (current?.state === 'failed' && current.id !== job?.id) await this.stopFailedJob(current.id)
  }
  shutdown(): Promise<void> {
    this.closing = true
    this.shutdownTask ??= Promise.allSettled([
      this.dispatcher.shutdown(), ...(this.polling ? [this.polling] : []), ...this.tasks.values(),
    ]).then((results) => {
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Automatic review shutdown was incomplete.')
    })
    return this.shutdownTask
  }
}

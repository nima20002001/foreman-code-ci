import type { DurableInteraction, InteractionResponseValue } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { NativeResponseJournal } from '../harnesses/recovery/responseJournal.js'
import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { projectInteractionActivity, type InteractionActivityEvidence } from './activityProjection.js'
import { DomainError } from '../errors.js'
import type { InteractionResponder } from './responder.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { InteractionNativeRuntime } from './runtimePorts.js'
import { Wave25InteractionRepository } from './wave25/repository.js'
import type { InteractionResponseOptions } from './cancellation.js'
import type { WorkDirectionActions } from './workDirection.js'
import { deliverApproval, respondToApproval, resumeApproval,
  type ApprovalRuntimeDependencies, type AtomicApprovalResumeConsumer } from './wave25/service.js'

export type { InteractionResponder }
const message = (error: unknown) => error instanceof DomainError ? error.code : 'APPROVAL_RECOVERY_UNCERTAIN'

/** One current authenticated decision/delivery/resume service. Transport source
 * and graph complexity never select another repository or approval protocol. */
export class InteractionService {
  useWorkDirectionActions(actions: WorkDirectionActions): void { this.interactions.directions.useActions(actions) }
  private atomicApprovalResume: AtomicApprovalResumeConsumer | undefined
  private prepareRequester: ((interaction: DurableInteraction) => Promise<void>) | undefined
  useApprovalPreparation(prepare: (interaction: DurableInteraction) => Promise<void>): void {
    if (this.prepareRequester && this.prepareRequester !== prepare) throw new DomainError(
      'APPROVAL_RESUME_ALREADY_BOUND', 'The requester recovery consumer is already bound.', 409)
    this.prepareRequester = prepare
  }
  useAtomicApprovalResume(consumer: AtomicApprovalResumeConsumer): void {
    if (this.atomicApprovalResume && this.atomicApprovalResume !== consumer) throw new DomainError(
      'APPROVAL_RESUME_ALREADY_BOUND', 'The production checkpoint consumer is already bound.', 409)
    this.atomicApprovalResume = consumer
  }
  usesAtomicApproval(runId: string): Promise<boolean> { return this.interactions.usesAtomicApproval(runId) }
  private approvalDependencies(): ApprovalRuntimeDependencies {
    return { repository: this.interactions, nativeRuntime: this.nativeRuntime,
      ...(this.responseJournal ? { journal: this.responseJournal } : {}),
      ...(this.atomicApprovalResume ? { atomicResume: this.atomicApprovalResume } : {}),
      ...(this.prepareRequester ? { prepareRequester: this.prepareRequester } : {}) }
  }
  constructor(private readonly interactions: Wave25InteractionRepository,
    _budgets: PostgresApprovalBudgetRepository, private readonly nativeRuntime: InteractionNativeRuntime,
    _resumeGraph: (interaction: DurableInteraction) => Promise<void>, private readonly responseJournal?: NativeResponseJournal,
    private readonly activityEvidence?: (interaction: DurableInteraction) => Promise<InteractionActivityEvidence>) {
    if (!(interactions instanceof Wave25InteractionRepository)) throw new DomainError(
      'APPROVAL_REPOSITORY_REQUIRED', 'The current original-source approval repository is required.', 503)
  }
  private resumeDelivered(interaction: DurableInteraction): Promise<void> {
    return resumeApproval(this.approvalDependencies(), interaction)
  }
  private deliver(id: string, reconcileOnly = false): Promise<DurableInteraction> {
    return deliverApproval(this.approvalDependencies(), id, reconcileOnly)
  }
  async get(id: string): Promise<DurableInteraction> {
    const interaction = await this.interactions.get(id)
    if (!interaction) throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    return interaction
  }

  async list(input: { workspaceId?: string; workflowId?: string; runId?: string; handler?: DurableInteraction['approval']['handler']; status?: DurableInteraction['status']; cursor?: string; limit: number }): Promise<{ items: DurableInteraction[]; nextCursor: string | null }> {
    const rows = await this.interactions.list({
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.handler ? { handler: input.handler } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.cursor ? { afterId: input.cursor } : {}), limit: input.limit + 1,
    })
    const items = rows.slice(0, input.limit)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null }
  }

  async getVisible(principal: ManagementPrincipal, id: string): Promise<DurableInteraction> {
    const interaction = await this.get(id)
    requireAuthorization(principal, 'interactions:read', {
      workspaceId: interaction.workspaceId, workflowId: interaction.workflowId, runId: interaction.runId,
    })
    return interaction
  }

  async reviewStatusVisible(principal: ManagementPrincipal, id: string) {
    const interaction = await this.getVisible(principal, id)
    const authorized = interaction.approval.handler === 'user' && principal.audience === 'operator'
      && isAuthorized(principal, 'interactions:respond', interaction)
    const activity = await this.readActivity(interaction, authorized)
    const reviewerId = interaction.approval.designatedOrchestratorAgentId
    if (interaction.approval.handler !== 'orchestrator' || !reviewerId) return { interaction, activity }
    const job = await this.interactions.coordination.findReviewJob(id, reviewerId)
    if (!job) return { interaction, activity }
    const { state, attempt, error, retryAfter, updatedAt } = job
    return { interaction, activity, review: { state, attempt, updatedAt, reviewJobId: job.id,
      cleanupPending: state === 'failed' && !job.cleanup?.completedAt,
      ...(error ? { error } : {}), ...(retryAfter ? { retryAfter } : {}) } }
  }

  /** Read-only availability. Caller supplies the result of its existing responder-role policy. */
  async readActivity(interaction: DurableInteraction, authorized: boolean) {
    if (interaction.kind === 'work_direction') {
      const available = await this.interactions.directions.available(interaction)
      return projectInteractionActivity(interaction, { response: { authorized, qualified: available, usable: available,
        path: 'workflow_decision', identity: { interactionId: interaction.id, revision: interaction.revision,
          sessionId: interaction.nativeSessionId, requestId: interaction.nativeRequestId, executionId: interaction.executionId } } })
    }
    const qualified = this.activityEvidence ? await this.activityEvidence(interaction) : {
      response: { qualified: false, usable: false, path: null, authorized: false },
    } satisfies InteractionActivityEvidence
    const acknowledgment = await this.interactions.activityAcknowledgment(interaction)
    const turnMatches = !acknowledgment.nativeTurnId || !qualified.nativeTurnId
      || acknowledgment.nativeTurnId === qualified.nativeTurnId
    return projectInteractionActivity(interaction, { ...qualified, ...acknowledgment,
      response: { ...qualified.response, authorized, usable: qualified.response.usable && turnMatches } })
  }

  async listVisible(principal: ManagementPrincipal, input: {
    workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
    handler?: DurableInteraction['approval']['handler'] | undefined;
    status?: DurableInteraction['status'] | undefined; cursor?: string | undefined; limit: number;
  }) {
    if (!hasAction(principal, 'interactions:read')) {
      throw new DomainError('ACCESS_DENIED', 'The caller is not authorized to read interactions.', 403)
    }
    const scopes = principal.grants.filter((grant) => grant.actions.includes('interactions:read')).map((grant) => grant.scope)
    const filters = { workspaceId: input.workspaceId, workflowId: input.workflowId, runId: input.runId, handler: input.handler, scopes }
    const rows = await this.interactions.list({ ...filters, status: input.status, afterId: input.cursor, limit: input.limit + 1 })
    const items = rows.slice(0, input.limit)
    const counts = await this.interactions.pendingCounts(filters)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null, ...counts }
  }

  async respond(responder: InteractionResponder, input: { interactionId: string; optionId: string; expectedRevision: number;
    commandId?: string; response?: InteractionResponseValue | undefined },
    options: InteractionResponseOptions = {}) {
    const interaction = await this.get(input.interactionId)
    if (interaction.kind === 'work_direction') {
      if (!responder.principal || responder.kind === 'orchestrator') throw new DomainError(
        'INTERACTION_ACCESS_DENIED', 'Workflow direction is assigned to the owner.', 403)
      return this.interactions.directions.respond(responder.principal,
        responder.kind === 'operator' ? responder.source ?? 'http' : 'http', input, options)
    }
    return respondToApproval(this.approvalDependencies(), responder, input, options)
  }

  async reconcile(interaction: DurableInteraction): Promise<DurableInteraction> {
    if (interaction.kind === 'work_direction') return this.interactions.directions.complete(interaction)
    const current = await this.deliver(interaction.id, true)
    await this.resumeDelivered(current)
    return this.get(current.id)
  }

  /** Bounded, cursor-based recovery for the application lifecycle worker. No native replay. */
  async recover(input: { afterId?: string; limit: number }): Promise<{ nextCursor: string | null; errors: Array<{ interactionId: string; error: string }> }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new DomainError('RECOVERY_LIMIT_INVALID', 'Recovery batch size must be between 1 and 100.', 400)
    }
    const rows = await this.interactions.delivery.recoveryCandidates({ ...input, limit: input.limit + 1 })
    const errors: Array<{ interactionId: string; error: string }> = []
    for (const candidate of rows.slice(0, input.limit)) {
      try {
        if (candidate.kind === 'work_direction') {
          await this.interactions.directions.complete(candidate)
          continue
        }
        const current = candidate.deliveryState === 'delivered' ? candidate : await this.deliver(candidate.id)
        await this.resumeDelivered(current)
      } catch (error) {
        errors.push({ interactionId: candidate.id, error: message(error) })
      }
    }
    return { nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null, errors }
  }
}

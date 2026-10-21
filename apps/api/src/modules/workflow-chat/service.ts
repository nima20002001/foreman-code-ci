import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowChatPostRequestSchema, type WorkflowChatPostResponse } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { DomainError } from '../errors.js'
import type { ChatDeliveryRouter } from './delivery.js'
import type { PostgresWorkflowChatRepository } from './repository.js'
import type { ChannelRead, ChannelScope, WorkflowChatAuthority, WorkflowChatChange } from './model.js'
import { assertTargetScope, channelCommand, decodeCursor, encodeCursor } from './validation.js'

export class WorkflowChatEvents {
  private readonly listeners = new Map<string, Set<(event: WorkflowChatChange) => void>>()
  subscribe(workflowId: string, listener: (event: WorkflowChatChange) => void) {
    const listeners = this.listeners.get(workflowId) ?? new Set()
    listeners.add(listener); this.listeners.set(workflowId, listeners)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(workflowId) }
  }
  publish(workflowId: string, event: WorkflowChatChange): void {
    for (const listener of this.listeners.get(workflowId) ?? []) {
      try { listener(event) } catch (error) { componentLogger('engine').warn({ err: error }, 'Group chat subscriber failed') }
    }
  }
}

export class WorkflowChatService {
  readonly events = new WorkflowChatEvents()
  private pendingWake: (() => void) | undefined
  constructor(readonly repository: PostgresWorkflowChatRepository, private readonly authority: WorkflowChatAuthority,
    private readonly delivery: ChatDeliveryRouter) {}

  async assertReadable(principal: ManagementPrincipal, scope: ChannelScope): Promise<void> {
    await this.authority.authenticate(principal, scope, 'read')
  }

  async post(principal: ManagementPrincipal, raw: unknown): Promise<WorkflowChatPostResponse> {
    // Parsing scope never resolves targets; replay stays possible after target removal/settlement.
    const parsed = WorkflowChatPostRequestSchema.parse(raw)
    const actor = await this.authority.authenticate(principal, parsed, 'read')
    const request = channelCommand(parsed, actor.author)
    const result = await this.repository.admit(actor.principal, request, actor.author, this.authority, actor.subject)
    if (!result.replayed) {
      const channel = await this.repository.channel(request)
      // The invalidation revision can include a later commit. Never label an older delta with it.
      // Readback also supplies receipt-to-Run associations for the caller's active filter.
      this.events.publish(request.workflowId, { revision: channel!.revision, snapshotRequired: true })
      // Delivery is a separately durable pending operation. This method never awaits native I/O.
      this.pendingWake?.()
    }
    return result
  }

  /** D starts/stops this only when the feature is composed. Restart begins from the durable pending set. */
  startPendingDrain(projector?: { projectCommittedFacts(limit?: number): Promise<number> }): () => void {
    if (this.pendingWake) throw new Error('The Group pending drain is already running.')
    let closed = false, running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const wake = () => {
      if (closed || running) return
      clearTimeout(timer)
      timer = setTimeout(() => { void drain() }, 0)
    }
    const drain = async () => {
      if (closed || running) return
      running = true
      try {
        const pending = await this.repository.deliveries.pending()
        const scopes = new Map(pending.flatMap(command => {
          const target = command.request.target
          return target.kind === 'operator_conversation' || !command.request.sourcePostId ? []
            : [[target.agent.workflowId, target.agent] as const]
        }))
        const revisions = new Map(await Promise.all([...scopes.values()].map(async scope =>
          [scope.workflowId, (await this.repository.channel(scope))?.revision] as const)))
        await this.delivery.drainPrepared()
        await projector?.projectCommittedFacts()
        for (const scope of scopes.values()) {
          const channel = await this.repository.channel(scope)
          if (!closed && channel && channel.revision !== revisions.get(scope.workflowId)) {
            this.events.publish(scope.workflowId, { revision: channel.revision, snapshotRequired: true })
          }
        }
      } catch (error) { componentLogger('engine').warn({ err: error }, 'Group pending drain will retry retained work') }
      finally {
        running = false
        // Poll the durable committed-fact set within the 500 ms visibility budget; I0 measures end-to-end cost.
        if (!closed) timer = setTimeout(() => { void drain() }, 250)
      }
    }
    this.pendingWake = wake
    wake()
    return () => { closed = true; clearTimeout(timer); this.pendingWake = undefined }
  }

  /** Owning service calls after its receipt transaction commits; no delta can be mislabeled. */
  async receiptChanged(receiptId: string): Promise<void> {
    const command = await this.repository.deliveries.byReceipt(receiptId)
    if (!command?.request.sourcePostId || command.request.target.kind === 'operator_conversation') return
    const scope = command.request.target.agent
    const channel = await this.repository.channel(scope)
    if (channel) this.events.publish(scope.workflowId, { revision: channel.revision, snapshotRequired: true })
  }

  async read(principal: ManagementPrincipal, scope: ChannelScope, input: ChannelRead = {}) {
    const actor = await this.authority.authenticate(principal, scope, 'read')
    return this.repository.history(scope, actor.principal.id, input)
  }

  async body(principal: ManagementPrincipal, scope: ChannelScope, postId: string, bodyCursor?: string) {
    await this.assertReadable(principal, scope)
    const post = await this.repository.exactPost(scope, postId)
    const cursorScope = { postId, purpose: 'body' }
    const offset = decodeCursor(cursorScope, bodyCursor) ?? 0
    if (offset > post.body.length) throw new DomainError('CHAT_BODY_CURSOR_INVALID', 'The body cursor exceeds the retained post.', 422)
    let end = Math.min(offset + 16 * 1024, post.body.length)
    if (end < post.body.length && /[\uD800-\uDBFF]/.test(post.body[end - 1]!)) end--
    return { postId, body: post.body.slice(offset, end),
      nextBodyCursor: end < post.body.length ? encodeCursor(cursorScope, end) : null,
      revision: (await this.repository.channel(scope))?.revision ?? 0 }
  }

  async receipts(principal: ManagementPrincipal, scope: ChannelScope, input: ChannelRead = {}) {
    const actor = await this.authority.authenticate(principal, scope, 'read')
    return this.repository.receipts(scope, actor.principal.id, input)
  }

  async cancel(principal: ManagementPrincipal, scope: ChannelScope, receiptId: string, commandId?: string) {
    const actor = await this.authority.authenticate(principal, scope, 'read')
    const stored = await this.repository.deliveries.byReceipt(receiptId)
    if (!stored?.request.sourcePostId) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'This Group receipt is unavailable.', 404)
    assertTargetScope(stored.request.target, scope)
    await this.repository.exactPost(scope, stored.request.sourcePostId)
    await this.delivery.cancel(actor.principal, { commandId, target: stored.request.target, selection: { kind: 'one', receiptId } })
    const current = await this.repository.deliveries.byReceipt(receiptId)
    if (!current) throw new DomainError('CHAT_RECEIPT_NOT_FOUND', 'The canceled receipt is unavailable.', 404)
    return current.receipt
  }
}

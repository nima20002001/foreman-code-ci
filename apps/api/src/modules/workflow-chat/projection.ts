import { randomUUID } from 'node:crypto'
import {
  AgentIdentitySchema, BoardLifecycleFactSchema, ExecutionRefSchema, LogicalWorkRefSchema, WorkflowChatPostSchema,
  type AgentIdentity, type BoardLifecycleFact, type ExecutionRef, type LogicalWorkRef, type WorkflowChatPost,
} from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { z } from 'zod'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import type { PostgresWorkflowChatRepository } from './repository.js'
import type { StoredDelivery, WorkflowChatChange } from './model.js'

const identity = { sourceEventKey: z.string().min(1), createdAt: z.iso.datetime(), agent: AgentIdentitySchema }
const lifecycleSchema = z.object({ kind: z.literal('lifecycle'), ...identity, fact: BoardLifecycleFactSchema,
  summary: z.string().max(600).optional() }).strict()
const returnSchema = z.object({ kind: z.literal('review_return'), ...identity, work: LogicalWorkRefSchema,
  execution: ExecutionRefSchema, summary: z.string().min(1).max(600) }).strict()
const replySchema = z.object({ kind: z.literal('reply'), ...identity, commandId: z.string().min(1),
  receiptId: z.string().min(1), nativeMessageId: z.string().min(1), nativeSessionId: z.string().min(1),
  nativeTurnId: z.string().min(1).optional(), execution: ExecutionRefSchema.optional(), consultationId: z.string().min(1).optional() }).strict()
const receiptChangeSchema = z.object({ kind: z.literal('receipt_changed'), ...identity,
  receiptId: z.string().min(1) }).strict()
const committedFactSchema = z.discriminatedUnion('kind', [lifecycleSchema, returnSchema, replySchema, receiptChangeSchema])
/** Only owning committed transactions call this seam; it is never an HTTP/model input. */
export type CommittedWorkflowChatFact = z.infer<typeof committedFactSchema>
export interface CommittedReplySource {
  /** Read exactly this committed command/native-message source; ambiguous correlations return no reply. */
  read(tx: TransactionSql, fact: z.infer<typeof replySchema>): Promise<{ body: string } | undefined>
}
interface WorkState { started_post_id: string | null; finished_post_id: string | null; blocker_hash: string | null }

function same(left: unknown, right: unknown): boolean { return commandInputHash(left) === commandInputHash(right) }
function workKey(agent: AgentIdentity, work: LogicalWorkRef): string {
  return commandInputHash({ workspaceId: agent.workspaceId, workflowId: agent.workflowId, node: agent.workflowNodeId, work })
}
function validateFact(value: unknown): CommittedWorkflowChatFact {
  const input = committedFactSchema.parse(value)
  if (input.kind === 'lifecycle' && (!same(input.agent, input.fact.agent) || input.sourceEventKey !== input.fact.sourceEventKey)) {
    throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT', 'The lifecycle projection must retain its committed identity.', 409)
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) {
    throw new DomainError('CHAT_PROJECTION_TOO_LARGE', 'Committed channel projection must remain a bounded summary or reply.', 413)
  }
  return input
}
function lifecycleContent(fact: BoardLifecycleFact, summary?: string): { kind: WorkflowChatPost['kind']; body: string } | undefined {
  if (fact.controlContinuationId && fact.execution && fact.previousExecution
    && same(fact.execution, fact.previousExecution) && ['accepted', 'failed', 'canceled'].includes(fact.phase)) return undefined
  if (fact.phase === 'launched') return { kind: 'started', body: `${fact.agent.displayName} started this task.`.slice(0, 600) }
  if (fact.phase === 'accepted' && fact.outstandingRequestIds.length === 0) {
    return { kind: 'finished', body: summary?.trim() || `${fact.agent.displayName} finished this task.`.slice(0, 600) }
  }
  if (['blocked', 'failed', 'canceled'].includes(fact.phase)) {
    const reason = fact.reason?.trim()
    return { kind: 'blocked', body: (reason || `${fact.agent.displayName}'s task ${fact.phase === 'blocked'
      ? 'is blocked' : fact.phase === 'failed' ? 'failed' : 'was canceled'}.`).slice(0, 600) }
  }
  return undefined
}

/** A durable pending set, not a maximum source-ID cursor: delayed commits remain discoverable. */
export class WorkflowChatProjector {
  constructor(private readonly repository: PostgresWorkflowChatRepository,
    private readonly publish: (workflowId: string, change: WorkflowChatChange) => void,
    private readonly replies: CommittedReplySource) {}

  async enqueueCommitted(tx: TransactionSql, value: CommittedWorkflowChatFact): Promise<void> {
    const fact = validateFact(value)
    const prior = (await tx.query<{ input_hash: string }>(
      'select input_hash from workflow_chat_projection_keys where source_event_key=$1', [fact.sourceEventKey])).rows[0]
    if (prior) {
      if (prior.input_hash !== commandInputHash(fact)) throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT', 'A committed source key was reused with different facts.', 409)
      return
    }
    const pending = await tx.query<{ fact: unknown }>(`insert into workflow_chat_projection_pending
      (source_event_key,workspace_id,workflow_id,fact) values($1,$2,$3,$4::jsonb)
      on conflict(source_event_key) do update set source_event_key=excluded.source_event_key returning fact`,
    [fact.sourceEventKey, fact.agent.workspaceId, fact.agent.workflowId, JSON.stringify(fact)])
    if (!same(pending.rows[0]!.fact, fact)) throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT', 'A pending source key was reused with different facts.', 409)
  }

  async projectCommittedFacts(limit = 32): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('CHAT_PROJECTION_LIMIT', 'Projection batches contain 1 to 100 facts.', 422)
    let projected = 0
    for (let index = 0; index < limit; index++) {
      const result = await withTransaction(this.repository.pool, async tx => {
        const pending = (await tx.query<{ fact: unknown }>(`select fact from workflow_chat_projection_pending
          order by created_at,source_event_key for update skip locked limit 1`)).rows[0]
        if (!pending) return undefined
        const fact = validateFact(pending.fact)
        const prior = (await tx.query<{ post_id: string | null; input_hash: string }>(
          'select post_id,input_hash from workflow_chat_projection_keys where source_event_key=$1', [fact.sourceEventKey])).rows[0]
        if (prior && prior.input_hash !== commandInputHash(fact)) throw new DomainError('CHAT_PROJECTION_SOURCE_CONFLICT', 'Committed projection facts changed.', 409)
        const post = prior ? undefined : await this.projectLocked(tx, fact)
        if (!prior) await tx.query(`insert into workflow_chat_projection_keys(source_event_key,input_hash,post_id)
          values($1,$2,$3)`, [fact.sourceEventKey, commandInputHash(fact), post?.id ?? null])
        await tx.query('delete from workflow_chat_projection_pending where source_event_key=$1', [fact.sourceEventKey])
        return { fact, changed: Boolean(post) || !prior && fact.kind === 'receipt_changed' }
      }, { conflictRetries: 2 })
      if (!result) break
      projected++
      if (result.changed) {
        const channel = await this.repository.channel(result.fact.agent)
        this.publish(result.fact.agent.workflowId, { revision: channel?.revision ?? 0, snapshotRequired: true })
      }
    }
    return projected
  }

  private async projectLocked(tx: TransactionSql, fact: CommittedWorkflowChatFact): Promise<WorkflowChatPost | undefined> {
    if (fact.kind === 'receipt_changed') return undefined
    if (fact.kind === 'reply') return this.replyLocked(tx, fact)
    const work = fact.kind === 'lifecycle' ? fact.fact.work : fact.work
    const key = workKey(fact.agent, work)
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`chat-work:${key}`])
    await tx.query('insert into workflow_chat_projection_work(work_key) values($1) on conflict do nothing', [key])
    const state = (await tx.query<WorkState>('select * from workflow_chat_projection_work where work_key=$1 for update', [key])).rows[0]!
    if (fact.kind === 'lifecycle' && ['launched', 'retry_admitted', 'continuation_admitted', 'accepted'].includes(fact.fact.phase)) {
      await tx.query('update workflow_chat_projection_work set blocker_hash=null where work_key=$1', [key])
    }
    const content = fact.kind === 'review_return' ? { kind: 'review_return' as const, body: fact.summary }
      : lifecycleContent(fact.fact, fact.summary)
    if (!content || content.kind === 'started' && state.started_post_id || content.kind === 'finished' && state.finished_post_id) return undefined
    const blocker = content.kind === 'blocked' ? commandInputHash(content.body) : null
    if (blocker && blocker === state.blocker_hash) return undefined
    const post = await this.postLocked(tx, fact, content,
      fact.kind === 'lifecycle' ? fact.fact.execution : fact.execution)
    await tx.query(`update workflow_chat_projection_work set
      started_post_id=case when $2='started' then $3 else started_post_id end,
      finished_post_id=case when $2='finished' then $3 else finished_post_id end,
      blocker_hash=case when $2 in ('blocked','started','finished','review_return') then $4 else blocker_hash end where work_key=$1`,
    [key, content.kind, post.id, blocker])
    return post
  }

  private async replyLocked(tx: TransactionSql, fact: z.infer<typeof replySchema>): Promise<WorkflowChatPost | undefined> {
    // Match the actual retained command and owner binding before taking the channel lock.
    await tx.query('select id from chat_delivery_commands where id=$1 for update', [fact.receiptId])
    const stored = await this.repository.deliveries.byReceipt(fact.receiptId, tx)
    if (!stored || stored.request.commandId !== fact.commandId || stored.receipt.replyPostId) return undefined
    if (!stored.request.sourcePostId) return undefined // direct messages are never broadcast
    assertReplyBinding(stored, fact)
    const reply = await this.replies.read(tx, fact)
    if (!reply?.body.trim()) return undefined
    const post = await this.postLocked(tx, fact, { kind: 'message', body: reply.body }, fact.execution, stored.request.sourcePostId)
    await this.repository.deliveries.updateLocked(tx, { ...stored.receipt, replyPostId: post.id, updatedAt: new Date().toISOString() })
    return post
  }

  private async postLocked(tx: TransactionSql, fact: CommittedWorkflowChatFact,
    content: { kind: WorkflowChatPost['kind']; body: string }, execution?: ExecutionRef, replyToPostId?: string) {
    const channel = await this.repository.ensureChannelLocked(tx, fact.agent)
    const post = WorkflowChatPostSchema.parse({ id: randomUUID(), channelId: channel.id, sequence: channel.nextSequence,
      workspaceId: fact.agent.workspaceId, workflowId: fact.agent.workflowId,
      author: { kind: 'agent', agent: fact.agent }, ...content, mentions: [], cardIds: [],
      ...(execution ? { execution } : {}), ...(replyToPostId ? { replyToPostId } : {}),
      sourceEventKey: fact.sourceEventKey, createdAt: fact.createdAt })
    await this.repository.insertPostLocked(tx, post, 'committed-projection', fact.sourceEventKey, commandInputHash(fact))
    return post
  }
}

function assertReplyBinding(stored: StoredDelivery, fact: z.infer<typeof replySchema>): void {
  const { target } = stored.receipt
  const agent = { workspaceId: fact.agent.workspaceId, workflowId: fact.agent.workflowId,
    workflowNodeId: fact.agent.workflowNodeId, agentId: fact.agent.agentId }
  const denied = () => { throw new DomainError('CHAT_REPLY_TARGET_MISMATCH', 'This committed reply does not match the retained command owner.', 409) }
  if (target.kind === 'operator_conversation' || !same(target.agent, agent)) denied()
  if (stored.receipt.nativeTurnId !== fact.nativeTurnId) denied()
  const session = stored.ownerBinding.deliveredNativeSessionId
    ?? (stored.receipt.appliedIntent === 'steer' ? stored.ownerBinding.nativeSessionId : undefined)
  if (session && session !== fact.nativeSessionId) denied()
  if (stored.ownerBinding.configurationVersionId && stored.ownerBinding.configurationVersionId !== fact.agent.configurationVersionId) denied()
  if (target.kind === 'workflow_execution') {
    if (!fact.execution || !same(stored.receipt.continuationExecution ?? target.execution, fact.execution) || fact.consultationId) denied()
  } else if (target.kind === 'workflow_coordinator') {
    if (!fact.consultationId || fact.consultationId !== stored.receipt.consultationId || fact.execution) denied()
  } else if (fact.execution || fact.consultationId) denied()
}

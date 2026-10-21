import type { SqlQuery } from '../../infrastructure/transaction.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  WorkflowChatPostSchema, type WorkflowChatPost, type WorkflowChatPostRequest, type WorkflowChatPostResponse,
  type ChatDeliveryReceipt, type ChatSendRequest, type AgentSubject,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { withTransaction, type TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { PostgresChatDeliveryRepository } from './deliveryRepository.js'
import type { ChannelRead, ChannelRecord, ChannelScope, WorkflowChatAuthority, DeliveryQualification } from './model.js'
import { CHANNEL_PAGE_BYTES, decodeCursor, effectiveInput, encodeCursor, pageLimit, recipientCommandId } from './validation.js'
import { assertChatCommandKind } from './commandIdentity.js'

interface ChannelRow { id: string; workspace_id: string; workflow_id: string; revision: string; next_sequence: string }
interface PostRow { record: unknown; sequence: string; input_hash: string }
export interface ChannelPostPage {
  items: WorkflowChatPost[]; nextCursor: string | null; hasMore: boolean; revision: number
  bodyTruncations?: Array<{ postId: string; nextBodyCursor: string; originalBytes: number }>
}

export class PostgresWorkflowChatRepository {
  readonly deliveries: PostgresChatDeliveryRepository
  constructor(readonly pool: pg.Pool) { this.deliveries = new PostgresChatDeliveryRepository(pool) }

  async channel(scope: ChannelScope, sql: SqlQuery = this.pool): Promise<ChannelRecord | undefined> {
    const row = (await sql.query<ChannelRow>('select * from workflow_chat_channels where workspace_id=$1 and workflow_id=$2',
      [scope.workspaceId, scope.workflowId])).rows[0]
    return row ? { ...scope, id: row.id, revision: Number(row.revision), nextSequence: Number(row.next_sequence) } : undefined
  }

  async ensureChannelLocked(tx: TransactionSql, scope: ChannelScope): Promise<ChannelRecord> {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`workflow-chat:${scope.workspaceId}:${scope.workflowId}`])
    await tx.query(`insert into workflow_chat_channels(id,workspace_id,workflow_id)
      values($1,$2,$3) on conflict(workflow_id) do nothing`, [randomUUID(), scope.workspaceId, scope.workflowId])
    const channel = await this.channel(scope, tx)
    if (!channel) throw new DomainError('CHAT_SCOPE_MISMATCH', 'The workflow channel belongs to a different workspace.', 409)
    await tx.query('select id from workflow_chat_channels where id=$1 for update', [channel.id])
    return channel
  }

  async admit(principal: ManagementPrincipal, request: WorkflowChatPostRequest & { commandId: string },
    author: WorkflowChatPost['author'], authority: WorkflowChatAuthority, subject?: AgentSubject): Promise<WorkflowChatPostResponse> {
    return withTransaction(this.pool, async tx => {
      await authority.authorizeLocked(tx, principal, request, 'read')
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`chat-command:${principal.id}:${request.commandId}`])
      const inputHash = effectiveInput(request)
      const prior = (await tx.query<PostRow>(`select record,sequence,input_hash from workflow_chat_posts
        where principal_id=$1 and command_id=$2`, [principal.id, request.commandId])).rows[0]
      if (prior) {
        if (prior.input_hash !== inputHash) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This Group command already identifies a different post or recipient.', 409)
        const post = WorkflowChatPostSchema.parse(prior.record)
        return { post, receipts: (await this.deliveries.forPost(post.id, tx)).map(item => item.receipt), replayed: true }
      }
      await assertChatCommandKind(tx, principal.id, request.commandId, 'post')
      await authority.authorizeLocked(tx, principal, request, 'write')
      await authority.validateLinksLocked(tx, principal, request)
      const postId = randomUUID()
      const inputs = request.deliveries.map(delivery => ({
        commandId: recipientCommandId(request.commandId, delivery.workflowNodeId),
        target: delivery.target, intent: delivery.intent, content: request.body, attachments: [], sourcePostId: postId,
        ...(delivery.expectedNativeTurnId ? { expectedNativeTurnId: delivery.expectedNativeTurnId } : {}),
      } satisfies ChatSendRequest & { commandId: string }))
      const qualified = new Map<string, DeliveryQualification>()
      // This callback holds the existing context/owner locks and may create cold rows in this transaction only.
      // Owners precede channel locks everywhere, including receipt updates and committed projections.
      for (const input of [...inputs].sort((a, b) => effectiveInput(a.target).localeCompare(effectiveInput(b.target)))) {
        qualified.set(input.commandId, await authority.validateRecipientLocked(tx, principal, input, request))
      }
      const channel = await this.ensureChannelLocked(tx, request)
      const post = WorkflowChatPostSchema.parse({ id: postId, channelId: channel.id, sequence: channel.nextSequence,
        workspaceId: request.workspaceId, workflowId: request.workflowId, author, kind: 'message',
        body: request.body, mentions: request.mentions, cardIds: request.cardIds,
        ...(request.replyToPostId ? { replyToPostId: request.replyToPostId } : {}),
        ...(subject?.kind === 'execution' ? { execution: subject.execution } : {}), createdAt: new Date().toISOString() })
      await this.insertPostLocked(tx, post, principal.id, request.commandId, inputHash,
        subject?.kind === 'coordinator_consultation' ? subject.binding.runId : undefined)
      const receipts: ChatDeliveryReceipt[] = []
      for (const input of inputs) {
        receipts.push((await this.deliveries.prepareLocked(tx, principal.id, input, qualified.get(input.commandId)!, channel.id)).receipt)
      }
      return { post, receipts, replayed: false }
    }, { conflictRetries: 2 })
  }

  async insertPostLocked(tx: TransactionSql, post: WorkflowChatPost, principalId: string, commandId: string, inputHash: string,
    consultationRunId?: string): Promise<void> {
    await tx.query(`insert into workflow_chat_posts(id,channel_id,sequence,command_id,principal_id,input_hash,record,source_event_key,run_id)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [post.id, post.channelId, post.sequence, commandId, principalId,
      inputHash, JSON.stringify(post), post.sourceEventKey ?? null, post.execution?.runId ?? consultationRunId ?? null])
    await tx.query('update workflow_chat_channels set revision=revision+1,next_sequence=next_sequence+1 where id=$1', [post.channelId])
  }

  async history(scope: ChannelScope, principalId: string, input: ChannelRead = {}, sql: SqlQuery = this.pool): Promise<ChannelPostPage> {
    if (sql === this.pool) return withTransaction(this.pool, tx => this.history(scope, principalId, input, tx),
      { isolation: 'repeatable read', readOnly: true })
    const limit = pageLimit(input.limit)
    const channel = await this.channel(scope, sql)
    if (!channel) return { items: [], nextCursor: null, hasMore: false, revision: 0 }
    const filter = { scope, runId: input.runId ?? null, postId: input.postId ?? null,
      receiptId: input.receiptId ?? null, commandId: input.commandId ?? null, principalId }
    const before = decodeCursor(filter, input.cursor)
    const result = await sql.query<PostRow>(`select p.record,p.sequence,p.input_hash from workflow_chat_posts p
      where p.channel_id=$1 and ($2::bigint is null or p.sequence<$2)
        and ($3::text is null or p.id=$3)
        and ($4::text is null or p.command_id=$4 and p.principal_id=$5)
        and ($6::text is null or exists(select 1 from chat_delivery_commands d where d.post_id=p.id and d.id=$6))
        and ($3::text is not null or $6::text is not null or $7::text is null or p.run_id=$7
          or exists(select 1 from chat_delivery_commands d where (d.post_id=p.id or d.post_id=p.record->>'replyToPostId')
            and coalesce(d.request->'target'->'execution'->>'runId',d.request->'target'->>'runId')=$7))
      order by p.sequence desc limit $8`, [channel.id, before ?? null, input.postId ?? null, input.commandId ?? null,
      principalId, input.receiptId ?? null, input.runId ?? null, limit + 1])
    return boundedPosts(result.rows, channel.revision, filter, limit)
  }

  async exactPost(scope: ChannelScope, postId: string): Promise<WorkflowChatPost> {
    const row = (await this.pool.query<{ record: unknown }>(`select p.record from workflow_chat_posts p
      join workflow_chat_channels c on c.id=p.channel_id where p.id=$1 and c.workspace_id=$2 and c.workflow_id=$3`,
    [postId, scope.workspaceId, scope.workflowId])).rows[0]
    if (!row) throw new DomainError('CHAT_POST_NOT_FOUND', 'This post is unavailable in the selected workflow.', 404)
    return WorkflowChatPostSchema.parse(row.record)
  }

  async receipts(scope: ChannelScope, principalId: string, input: ChannelRead = {}, sql: SqlQuery = this.pool):
    Promise<{ items: ChatDeliveryReceipt[]; nextCursor: string | null; hasMore: boolean; revision: number }> {
    if (sql === this.pool) return withTransaction(this.pool, tx => this.receipts(scope, principalId, input, tx),
      { isolation: 'repeatable read', readOnly: true })
    const limit = pageLimit(input.limit)
    const channel = await this.channel(scope, sql)
    if (!channel) return { items: [], nextCursor: null, hasMore: false, revision: 0 }
    const filter = { scope, postId: input.postId ?? null, receiptId: input.receiptId ?? null,
      runId: input.runId ?? null, commandId: input.commandId ?? null, principalId }
    const before = decodeCursor(filter, input.cursor)
    const result = await sql.query<{ receipt: ChatDeliveryReceipt; sequence: string }>(`select d.receipt,d.sequence
      from chat_delivery_commands d join workflow_chat_posts p on p.id=d.post_id
      where d.channel_id=$1 and ($2::bigint is null or d.sequence<$2)
        and ($3::text is null or d.post_id=$3) and ($4::text is null or d.id=$4)
        and ($5::text is null or (p.command_id=$5 or d.command_id=$5) and d.principal_id=$6)
        and ($3::text is not null or $4::text is not null or $7::text is null
          or coalesce(d.request->'target'->'execution'->>'runId',d.request->'target'->>'runId')=$7)
      order by d.sequence desc limit $8`, [channel.id, before ?? null, input.postId ?? null,
      input.receiptId ?? null, input.commandId ?? null, principalId, input.runId ?? null, limit + 1])
    const items: ChatDeliveryReceipt[] = []
    const page = (values: ChatDeliveryReceipt[]) => {
      const hasMore = result.rows.length > values.length, last = result.rows[values.length - 1]
      return { items: [...values].reverse(), hasMore, revision: channel.revision,
        nextCursor: hasMore && last ? encodeCursor(filter, Number(last.sequence)) : null }
    }
    for (const row of result.rows.slice(0, limit)) {
      if (Buffer.byteLength(JSON.stringify(page([...items, row.receipt]))) > CHANNEL_PAGE_BYTES) {
        if (!items.length) throw new DomainError('CHAT_RECEIPT_TOO_LARGE', 'The receipt metadata exceeds its read window.', 413)
        break
      }
      items.push(row.receipt)
    }
    return page(items)
  }
}

function boundedPosts(rows: PostRow[], revision: number, filter: unknown, limit: number): ChannelPostPage {
  const items: WorkflowChatPost[] = []
  const bodyTruncations: NonNullable<ChannelPostPage['bodyTruncations']> = []
  const page = (values: WorkflowChatPost[], truncations = bodyTruncations): ChannelPostPage => {
    const hasMore = rows.length > values.length, last = rows[values.length - 1]
    return { items: [...values].reverse(), revision, hasMore,
      nextCursor: hasMore && last ? encodeCursor(filter, Number(last.sequence)) : null,
      ...(truncations.length ? { bodyTruncations: truncations } : {}) }
  }
  for (const row of rows.slice(0, limit)) {
    const full = WorkflowChatPostSchema.parse(row.record)
    if (Buffer.byteLength(JSON.stringify(page([...items, full]))) <= CHANNEL_PAGE_BYTES) { items.push(full); continue }
    if (items.length) break
    const preview = (length: number) => {
      const end = length < full.body.length && /[\uD800-\uDBFF]/.test(full.body[length - 1] ?? '') ? length - 1 : length
      return { post: { ...full, body: full.body.slice(0, end) }, truncation: { postId: full.id,
        originalBytes: Buffer.byteLength(full.body), nextBodyCursor: encodeCursor({ postId: full.id, purpose: 'body' }, end) } }
    }
    let low = 0, high = Math.min(full.body.length, 16 * 1024)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2), candidate = preview(middle)
      if (Buffer.byteLength(JSON.stringify(page([candidate.post], [candidate.truncation]))) <= CHANNEL_PAGE_BYTES) low = middle
      else high = middle - 1
    }
    const candidate = preview(low)
    if (!candidate.post.body.length || Buffer.byteLength(JSON.stringify(page([candidate.post], [candidate.truncation]))) > CHANNEL_PAGE_BYTES) {
      throw new DomainError('CHAT_POST_METADATA_TOO_LARGE', 'The post metadata exceeds its bounded read window.', 413)
    }
    items.push(candidate.post); bodyTruncations.push(candidate.truncation)
  }
  return page(items)
}

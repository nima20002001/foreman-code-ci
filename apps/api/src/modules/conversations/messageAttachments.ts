import type pg from 'pg'
import { MessageSchema, type ActivitySourceRevision, type Message } from '@foreman-code/contracts'
import { readClaudeMessagePublications } from '../harnesses/claudeSdk/publications.js'
import {
  FileWithRevisionSchema, MessageAttachmentRefsSchema, fileStateAt,
  type FileWithRevision, type MessageAttachmentRef,
} from '@foreman-code/contracts/files'

import { readOriginalMessageInputs } from './originalMessageInputs.js'
import { DomainError } from '../errors.js'
import { MessagePublicationRefsSchema, mergeMessagePins, readCodexMessagePublications } from './messagePublications.js'

type Queryable = Pick<pg.PoolClient, 'query'>
const StoredMessageSchema = MessageSchema.omit({ attachments: true, originalInput: true }).extend({
  attachmentRefs: MessageAttachmentRefsSchema.optional(), publicationRefs: MessagePublicationRefsSchema.optional(),
}).strict()

/** Only immutable pins are stored on the message. Expiry/state must not be snapshotted there. */
export function withMessageAttachmentRefs(message: Message, input?: MessageAttachmentRef[]) {
  const refs = MessageAttachmentRefsSchema.parse(input ?? [])
  return StoredMessageSchema.parse({ ...message, ...(refs.length ? { attachmentRefs: refs } : {}) })
}

// c is always the persisted, exact conversation, never browser context. Explicit NULL
// predicates matter: absent Run/execution is a distinct scope, not a wildcard.
const SAME_CONVERSATION = `f.scope_kind='temporary' and f.chat_kind=c.kind and f.conversation_id=c.id
  and ((c.kind='operator' and f.owner_principal_id=c.owner_principal_id and f.operator_id=c.operator_id
    and f.agent_id is null and f.workspace_id is null and f.workflow_id is null
    and f.run_id is null and f.execution_id is null)
  or (c.kind='agent' and f.operator_id is null and f.agent_id=c.agent_id
    and f.workspace_id=c.workspace_id and f.workflow_id=c.workflow_id
    and f.run_id is not distinct from c.origin_run_id
    and f.execution_id is not distinct from c.origin_execution_id))`

interface AttachmentRow {
  file_id: string; revision_id: string; current_revision_id: string; activity_record_revision: string
  chat_kind: 'operator' | 'agent'; owner_principal_id: string; operator_id: string | null
  conversation_id: string; agent_id: string | null; workspace_id: string | null; workflow_id: string | null
  run_id: string | null; execution_id: string | null
  state: 'pending' | 'ready' | 'expired' | 'removed'
  created_at: Date; retention_duration_seconds: number; expires_at: Date
  filename: string; media_type: string; byte_size: string; sha256: string; origin: string
  revision_created_at: Date; read_at: Date
}
function identity(ref: MessageAttachmentRef): string { return JSON.stringify([ref.fileId, ref.revisionId]) }

function metadata(row: AttachmentRow): FileWithRevision {
  const chat = row.chat_kind === 'operator'
    ? { kind: 'operator', ownerPrincipalId: row.owner_principal_id, operatorId: row.operator_id, conversationId: row.conversation_id }
    : { kind: 'agent', conversationId: row.conversation_id, agentId: row.agent_id,
      workspaceId: row.workspace_id, workflowId: row.workflow_id,
      ...(row.run_id === null ? {} : { runId: row.run_id, executionId: row.execution_id }) }
  const value = FileWithRevisionSchema.parse({
    file: { fileId: row.file_id, currentRevisionId: row.current_revision_id,
      scope: { kind: 'temporary', chat }, state: row.state, createdAt: row.created_at.toISOString(),
      retentionDurationSeconds: row.retention_duration_seconds, expiresAt: row.expires_at.toISOString() },
    revision: { fileId: row.file_id, revisionId: row.revision_id, filename: row.filename,
      mediaType: row.media_type, byteSize: Number(row.byte_size), sha256: row.sha256,
      origin: row.origin, createdAt: row.revision_created_at.toISOString() },
  })
  return FileWithRevisionSchema.parse({ ...value, file: { ...value.file,
    state: fileStateAt(value.file, row.read_at.toISOString()) } })
}

async function readPins(query: Queryable, conversationId: string, refs: MessageAttachmentRef[], onFileRevision?: (revision: ActivitySourceRevision) => void) {
  if (!refs.length) return new Map<string, FileWithRevision>()
  // The caller bounds message pages; output pins are not subject to the send limit.
  // Deduplicate exact pins, not logical IDs: history can pin different revisions.
  const pins = [...new Map(refs.map((ref) => [identity(ref), ref])).values()]
  const result = await query.query<AttachmentRow>(`select f.file_id,f.current_revision_id,f.activity_record_revision::text as activity_record_revision,f.chat_kind,
      f.owner_principal_id,f.operator_id,f.conversation_id,f.agent_id,f.workspace_id,f.workflow_id,
      f.run_id,f.execution_id,f.state,f.created_at,f.retention_duration_seconds,f.expires_at,
      r.revision_id,r.filename,r.media_type,r.byte_size,r.sha256,r.origin,r.created_at as revision_created_at,
      clock_timestamp() as read_at
    from jsonb_to_recordset($2::jsonb) as pin("fileId" text,"revisionId" text)
    join files f on f.file_id=pin."fileId"
    join file_revisions r on r.file_id=f.file_id and r.revision_id=pin."revisionId"
    join operator_conversations c on c.id=$1 and c.deleted_at is null
    where ${SAME_CONVERSATION}`, [conversationId, JSON.stringify(pins)])
  for (const row of result.rows) onFileRevision?.({ source: 'file', id: row.file_id, revision: row.activity_record_revision })
  return new Map(result.rows.map((row) => [identity({ fileId: row.file_id, revisionId: row.revision_id }), metadata(row)]))
}

/** Called inside the existing admission transaction, after locking the conversation and
 * checking the receipt. No transaction is held across native/byte I/O. Shared lifecycle
 * locks serialize admission with retention/removal/expiry, in a deterministic order. */
export async function validateMessageAttachments(query: Queryable, conversationId: string, input?: MessageAttachmentRef[]): Promise<void> {
  const refs = MessageAttachmentRefsSchema.parse(input ?? [])
  if (!refs.length) return // Text-only paths don't depend on the file migration.
  const locked = await query.query<{ file_id: string }>(`select f.file_id from files f
    join operator_conversations c on c.id=$1 and c.deleted_at is null
    where f.file_id=any($2::text[]) and ${SAME_CONVERSATION}
    order by f.file_id for share of f`, [conversationId, refs.map((ref) => ref.fileId)])
  if (locked.rows.length !== refs.length) throw new DomainError(
    'MESSAGE_ATTACHMENT_NOT_FOUND', 'An attachment was not found in this conversation.', 404)
  // Read the clock AFTER waiting for lifecycle locks. Transaction-start now() can be
  // stale here, allowing a file that expired while admission was blocked.
  const rows = await readPins(query, conversationId, refs)
  for (const ref of refs) {
    const value = rows.get(identity(ref))
    if (!value) throw new DomainError('MESSAGE_ATTACHMENT_NOT_FOUND', 'An attachment revision was not found in this conversation.', 404)
    if (value.file.state === 'pending') throw new DomainError('MESSAGE_ATTACHMENT_NOT_READY', 'An attachment is not ready.', 409)
    if (value.file.state !== 'ready') throw new DomainError('MESSAGE_ATTACHMENT_UNAVAILABLE', 'An attachment has expired or was removed.', 410)
  }
}

/** Metadata-only page readback, including durable Codex publications missed at close.
 * Never downloads bytes or follows a file head.
 * Callers retain the existing chat read authorization, including on receipt replay. */
export async function hydrateMessageAttachments(query: Queryable, conversationId: string, input: unknown[], onFileRevision?: (revision: ActivitySourceRevision) => void): Promise<Message[]> {
  const messages = input.map((value) => StoredMessageSchema.parse(value))
  if (messages.some((message) => message.conversationId !== conversationId)) {
    throw new DomainError('MESSAGE_ATTACHMENT_CONTEXT_MISMATCH', 'Message readback addressed another conversation.', 500)
  }
  const pins = (message: typeof messages[number]) => mergeMessagePins(message.attachmentRefs ?? [], message.publicationRefs ?? [])
  const rows = await readPins(query, conversationId, messages.flatMap(pins), onFileRevision)
  // New receipt-bearing user messages can publish inherited references without
  // uploads. Legacy unreceipted text stays independent of the file migration;
  // the recovery reader verifies persisted native identity for this bounded page.
  const candidates = messages.filter((message) => message.role === 'user'
    && (message.requestId !== undefined || (message.attachmentRefs?.length ?? 0) > 0))
    .map((message) => message.id)
  const originalInputs = await readOriginalMessageInputs(query, conversationId, messages.filter((message) => message.role === 'user').map((message) => message.id))
  const recovered = await readCodexMessagePublications(query, conversationId, candidates)
  for (const [messageId, refs] of await readClaudeMessagePublications(query, conversationId, candidates)) {
    recovered.set(messageId, mergeMessagePins(recovered.get(messageId) ?? [], refs))
  }
  const missing = [...recovered.values()].flat().filter((ref) => !rows.has(identity(ref)))
  for (const [key, value] of await readPins(query, conversationId, missing, onFileRevision)) rows.set(key, value)
  return messages.map(({ attachmentRefs, publicationRefs, ...message }) => {
    const attachments = mergeMessagePins(attachmentRefs ?? [], publicationRefs ?? [], recovered.get(message.id) ?? []).map((ref) => {
      const value = rows.get(identity(ref))
      // Tombstone metadata is retained by FIL-03. Do not fabricate metadata or expose
      // a foreign file if storage invariants have been violated.
      if (!value) throw new DomainError('MESSAGE_ATTACHMENT_METADATA_UNAVAILABLE', 'Pinned attachment metadata is unavailable.', 500)
      return value
    })
    return MessageSchema.parse({ ...message, ...(message.role === 'user' ? { originalInput: originalInputs.get(message.id) ?? null } : {}), ...(attachments?.length ? { attachments } : {}) })
  })
}

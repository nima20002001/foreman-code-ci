import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../../infrastructure/transaction.js'
import type pg from 'pg'
import { MessageSchema, OperatorConfigurationVersionSchema, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import { MessageAttachmentRefsSchema, messageAttachmentIdentity, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { PostgresAccessService } from '../../access/postgres.js'
import { nativeCorrelation } from '../../conversations/operatorChatRepository.js'
import { MessagePublicationRefsSchema } from '../../conversations/messagePublications.js'
import { DomainError } from '../../errors.js'
import { PostgresFileConversationAuthorization } from '../../files/authorization.js'
import { bindingIdentity } from '../../files/tools/context.js'
import type { FileToolContext } from '../../files/tools/types.js'

interface ReceiptRow {
  owner_principal_id: string
  operator_id: string
  operator_configuration_version_id: string
  native_session_id: string | null
  provider_version: string | null
  harness: 'codex' | 'claude'
  active_request_id: string | null
  active_native_turn_id: string | null
  active_phase: string | null
  cancel_requested: boolean
  request_id: string
  native_turn_id: string | null
  turn_message_id: string | null
  accepted_configuration_id: string
  payload: { attachmentIdentity?: string }
  message_id: string
  message_record: unknown
  configuration_record: unknown
}
const StoredMessage = MessageSchema.omit({ attachments: true }).extend({
  attachmentRefs: MessageAttachmentRefsSchema.optional(), publicationRefs: MessagePublicationRefsSchema.optional(),
})

/** Operator receipts predate t.message_id. Join their immutable user message by
 * the receipt's request ID, never an Agent uploader or browser route context. */
async function receipt(pool: pg.Pool, conversationId: string, requestId: string) {
  const row = (await pool.query<ReceiptRow>(`select c.owner_principal_id,c.operator_id,
      c.operator_configuration_version_id,c.native_session_id,c.provider_version,c.harness,
      c.active_request_id,c.active_native_turn_id,c.active_phase,c.cancel_requested,
      t.request_id,t.native_turn_id,t.message_id as turn_message_id,
      t.operator_configuration_version_id as accepted_configuration_id,t.payload,
      m.id as message_id,m.record as message_record,v.record as configuration_record
    from operator_conversations c
    join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$2
    join operator_conversation_messages m on m.conversation_id=c.id and m.role='user'
      and m.client_request_id=t.request_id
    join operator_configuration_versions v on v.id=t.operator_configuration_version_id and v.operator_id=c.operator_id
    where c.id=$1 and c.kind='operator' and c.deleted_at is null
      and c.owner_principal_id is not null and c.operator_id is not null
      and c.workspace_id is null and c.workflow_id is null and c.agent_id is null
      and c.origin_run_id is null and c.origin_execution_id is null`, [conversationId, requestId])).rows[0]
  if (!row) throw new DomainError('OPERATOR_FILE_ADMISSION_NOT_FOUND', 'The accepted Operator message was not found.', 409)
  const message = StoredMessage.parse(row.message_record)
  const configuration = OperatorConfigurationVersionSchema.parse(row.configuration_record)
  if (message.id !== row.message_id || message.conversationId !== conversationId || message.requestId !== requestId
    || message.role !== 'user' || row.request_id !== requestId
    || row.turn_message_id !== null && row.turn_message_id !== row.message_id
    || configuration.id !== row.accepted_configuration_id || configuration.operatorId !== row.operator_id
    || configuration.harness.harness !== row.harness) {
    throw new DomainError('OPERATOR_FILE_ADMISSION_MISMATCH', 'The Operator receipt and message do not have the same identity.', 409)
  }
  return { row, message, configuration }
}

/** Used before selecting a native process, including cleanup-only reattachment.
 * A missing/corrupt file admission must not fall back to a credentialed text turn. */
export async function operatorTurnHasFileInputs(pool: pg.Pool, conversationId: string, requestId: string): Promise<boolean> {
  // Legacy text receipts need not have a configuration pin. Do not route them
  // through the stricter file-admission join merely to inspect/stop old work.
  const row = (await pool.query<{ payload: { attachmentIdentity?: string }; message_record: unknown }>(`
    select t.payload,m.record as message_record from operator_conversations c
    join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=$2
    left join operator_conversation_messages m on m.conversation_id=c.id
      and m.role='user' and m.client_request_id=t.request_id
    where c.id=$1 and c.kind='operator' and c.deleted_at is null`, [conversationId, requestId])).rows[0]
  if (!row) throw new DomainError('OPERATOR_FILE_ADMISSION_NOT_FOUND', 'The accepted Operator receipt was not found.', 409)
  const hasFiles = row.payload.attachmentIdentity !== undefined
  const message = row.message_record == null ? undefined : StoredMessage.parse(row.message_record)
  if (hasFiles !== Boolean(message?.attachmentRefs?.length)) throw new DomainError(
    'OPERATOR_FILE_ADMISSION_MISMATCH', 'The Operator attachment receipt is incomplete.', 409)
  return hasFiles
}

export async function acceptedOperatorFileInputs(pool: pg.Pool, conversationId: string, clientCorrelationId: string,
  configuration: OperatorConfigurationVersion, nativeSessionId: string, providerVersion?: string) {
  const prefix = nativeCorrelation(conversationId, '')
  if (!clientCorrelationId.startsWith(prefix) || clientCorrelationId.length === prefix.length) throw new DomainError(
    'OPERATOR_FILE_ADMISSION_MISMATCH', 'The native correlation does not address this Operator conversation.', 409)
  const requestId = clientCorrelationId.slice(prefix.length)
  const accepted = await receipt(pool, conversationId, requestId)
  const { row, message } = accepted
  const attachments = message.attachmentRefs ?? []
  if (row.active_request_id !== requestId || !['submitting', 'submitted'].includes(row.active_phase ?? '')
    || row.cancel_requested || row.native_session_id !== nativeSessionId
    || providerVersion !== undefined && row.provider_version !== providerVersion
    || row.operator_configuration_version_id !== configuration.id || !isDeepStrictEqual(accepted.configuration, configuration)
    || !attachments.length || row.payload.attachmentIdentity !== messageAttachmentIdentity({ requestId, attachments })) {
    throw new DomainError('OPERATOR_FILE_ADMISSION_MISMATCH', 'The native turn does not match the accepted Operator file command.', 409)
  }
  const owner = await new PostgresAccessService(pool).currentOperator(row.owner_principal_id)
  const authorization = new PostgresFileConversationAuthorization(pool)
  const scope = await authorization.resolve(owner, { kind: 'operator', conversationId }, 'read')
  if (scope.chat.kind !== 'operator' || scope.chat.operatorId !== configuration.operatorId
    || scope.chat.ownerPrincipalId !== row.owner_principal_id) throw new DomainError(
    'OPERATOR_FILE_ADMISSION_MISMATCH', 'The Operator file owner changed.', 409)
  return { ...accepted, requestId, attachments, owner, scope, authorization }
}

/** Runs inside the existing onSubmitted barrier, after native evidence is saved
 * and before either harness may issue a file token. No receipt/hash is changed. */
export async function recordOperatorFileSubmission(pool: pg.Pool, conversationId: string, requestId: string,
  nativeTurnId: string): Promise<void> {
  const result = await pool.query(`update operator_conversation_turns t set native_turn_id=$3,message_id=m.id
    from operator_conversations c,operator_conversation_messages m
    where c.id=$1 and c.kind='operator' and c.deleted_at is null
      and c.active_request_id=$2 and c.active_native_turn_id=$3 and c.native_session_id is not null
      and t.conversation_id=c.id and t.request_id=$2
      and m.conversation_id=c.id and m.client_request_id=t.request_id and m.role='user'
      and (t.message_id is null or t.message_id=m.id)
      and (t.native_turn_id is null or t.native_turn_id=$3)
      and t.payload->>'attachmentIdentity' is not null`, [conversationId, requestId, nativeTurnId])
  if (result.rowCount !== 1) throw new DomainError(
    'OPERATOR_FILE_SUBMISSION_MISMATCH', 'The native file acknowledgement could not be bound to its Operator message.', 409)
}

/** Token-free repair from finalized publications; scoped to the original durable
 * Operator message even after completion has cleared c.active_request_id. */
export async function adoptOperatorFilePublications(pool: pg.Pool, context: FileToolContext,
  expected?: readonly MessageAttachmentRef[]): Promise<void> {
  const chat = context.scope.chat
  if (chat.kind !== 'operator' || chat.ownerPrincipalId !== context.ownerPrincipalId || !context.messageId) throw new DomainError(
    'OPERATOR_FILE_ADOPTION_MISMATCH', 'An owned Operator message binding is required.', 409)
  return withTransaction(pool, async (client) => {
    // Process-close cleanup can run before a native ACK. Such a turn could not
    // publish: do not require a fabricated t.native_turn_id merely to release
    // its inputs. Any real publication (including lost-ACK repair) still goes
    // through the complete original-message/owner/session/turn checks below.
    const ready = await client.query(`select 1 from file_tool_publications p
      join file_allocations a on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id
      where p.binding=$1 and a.state='finalized' limit 1`, [bindingIdentity(context)])
    if (!ready.rowCount && !expected?.length) return
    const row = (await client.query<{ request_id: string; message_record: unknown }>(`select t.request_id,m.record as message_record
      from operator_conversations c
      join operator_conversation_turns t on t.conversation_id=c.id and t.message_id=$2 and t.native_turn_id=$4
      join operator_conversation_messages m on m.id=t.message_id and m.conversation_id=c.id
        and m.client_request_id=t.request_id and m.role='user'
      where c.id=$1 and c.kind='operator' and c.deleted_at is null and c.native_session_id=$3
        and c.owner_principal_id=$5 and c.operator_id=$6
        and c.workspace_id is null and c.workflow_id is null and c.agent_id is null
        and c.origin_run_id is null and c.origin_execution_id is null
      for update of m`, [chat.conversationId, context.messageId, context.nativeSessionId, context.turnId,
      context.ownerPrincipalId, chat.operatorId])).rows[0]
    if (!row) throw new DomainError('OPERATOR_FILE_ADOPTION_MISMATCH', 'The originating Operator file turn is unavailable.', 409)
    const message = StoredMessage.parse(row.message_record)
    if (message.id !== context.messageId || message.requestId !== row.request_id || message.conversationId !== chat.conversationId) {
      throw new DomainError('OPERATOR_FILE_ADOPTION_MISMATCH', 'The originating Operator message changed.', 409)
    }
    const published = (await client.query<{ file_id: string; revision_id: string }>(`select p.file_id,p.revision_id
      from file_tool_publications p join file_allocations a
        on a.owner_principal_id=p.owner_principal_id and a.request_id=p.request_id and a.state='finalized'
      join files f on f.file_id=p.file_id and f.owner_principal_id=p.owner_principal_id
        and f.chat_kind='operator' and f.conversation_id=$2 and f.operator_id=$3
        and f.workspace_id is null and f.workflow_id is null and f.agent_id is null
        and f.run_id is null and f.execution_id is null
      join file_revisions r on r.file_id=p.file_id and r.revision_id=p.revision_id
      where p.binding=$1 and p.owner_principal_id=$4 order by p.request_id`,
    [bindingIdentity(context), chat.conversationId, chat.operatorId, context.ownerPrincipalId])).rows
    for (const ref of expected ?? []) {
      if (!published.some((item) => item.file_id === ref.fileId && item.revision_id === ref.revisionId)) throw new DomainError(
        'OPERATOR_FILE_ADOPTION_MISMATCH', 'The publication is not finalized for this Operator turn.', 409)
    }
    const inputs = message.attachmentRefs ?? []
    const refs = new Map([...inputs, ...(message.publicationRefs ?? [])].map((ref) => [ref.fileId, ref]))
    for (const item of published) {
      const prior = refs.get(item.file_id)
      if (prior && prior.revisionId !== item.revision_id) throw new DomainError(
        'OPERATOR_FILE_PUBLICATION_CONFLICT', 'Another revision is already pinned to this Operator message.', 409)
      refs.set(item.file_id, { fileId: item.file_id, revisionId: item.revision_id })
    }
    const outputs = MessagePublicationRefsSchema.parse([...refs.values()]
      .filter((ref) => !inputs.some((input) => input.fileId === ref.fileId)))
    if (!isDeepStrictEqual(outputs, message.publicationRefs ?? [])) {
      await client.query(`update operator_conversation_messages set record=jsonb_set(record,'{publicationRefs}',$2::jsonb) where id=$1`,
        [context.messageId, JSON.stringify(outputs)])
    }
  })
}

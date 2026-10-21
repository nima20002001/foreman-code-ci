import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { NativeMessageSubmissionSchema } from '@foreman-code/contracts/claude'
import { currentOperatorAuthority } from '../../access/runAuthority.js'
import { PostgresFileConversationAuthorization } from '../../files/authorization.js'
import type { ClaudeFileAdmission } from './files.js'
import type { ClaudeDomainBinding } from './domainAuthority.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import type { FileToolOperation } from '../../files/tools/types.js'

/** Existing accepted message, actual sender and root callback map only. No file
 * scope, native UUID, principal or message is accepted from MCP arguments. */
export function productionClaudeFileAdmission(input: {
  pool: pg.Pool
  binding: Exclude<ClaudeDomainBinding, { kind: 'workflow' }>
  manager(): Pick<ClaudeNativeSessionManager, 'nativeCallbackContext' | 'callbackAuthority'> | undefined
  allowMutation: boolean
}): ClaudeFileAdmission {
  return { current: async identity => {
    const manager = input.manager()
    const actual = manager?.nativeCallbackContext(identity.nativeSessionId, identity.toolUseId)
    const captured = actual && manager?.callbackAuthority(actual)
    if (!manager || !actual || !captured || actual.nativeMessageId !== identity.nativeMessageId
      || actual.clientCorrelationId !== identity.clientCorrelationId || actual.generation !== identity.generation
      || captured.ownerPrincipalId !== identity.ownerPrincipalId || captured.attemptId !== identity.attemptId) return undefined
    const row = (await input.pool.query<{
      kind: 'operator' | 'agent'; workspace_id: string | null; owner_principal_id: string | null;
      sender_id: string | null; native_session_id: string | null; active_request_id: string | null;
      cancel_requested: boolean; native_submission: unknown; message_id: string;
    }>(`select c.kind,c.workspace_id,c.owner_principal_id,c.native_session_id,c.active_request_id,c.cancel_requested,
        t.payload->>'ownerPrincipalId' as sender_id,t.payload->'nativeSubmission' as native_submission,m.id as message_id
      from operator_conversations c join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      join operator_conversation_messages m on m.conversation_id=c.id and m.role='user'
        and m.client_request_id=t.request_id and (t.message_id is null or t.message_id=m.id)
      where c.id=$1 and c.harness='claude' and c.deleted_at is null and (c.kind='agent' or c.record->>'status'='open')
        and c.active_request_id=$2 and c.native_session_id=$3 and c.active_phase='submitted'`,
    [input.binding.conversationId, identity.attemptId, identity.nativeSessionId])).rows[0]
    const receipt = NativeMessageSubmissionSchema.safeParse(row?.native_submission)
    if (!row || row.cancel_requested || row.kind !== input.binding.kind || !receipt.success
      || receipt.data.nativeSessionId !== identity.nativeSessionId || receipt.data.nativeMessageId !== identity.nativeMessageId
      || receipt.data.clientCorrelationId !== identity.clientCorrelationId
      || (row.kind === 'operator' ? row.owner_principal_id : row.sender_id) !== identity.ownerPrincipalId
      || input.binding.kind === 'agent' && row.workspace_id !== input.binding.workspaceId) return undefined
    const principal = (await currentOperatorAuthority(input.pool, identity.ownerPrincipalId)).principal
    const scope = await new PostgresFileConversationAuthorization(input.pool).resolve(principal,
      input.binding.kind === 'operator' ? { kind: 'operator', conversationId: input.binding.conversationId }
        : { kind: 'agent', workspaceId: input.binding.workspaceId, conversationId: input.binding.conversationId }, 'read')
    const current = manager.nativeCallbackContext(identity.nativeSessionId, identity.toolUseId)
    if (input.manager() !== manager || !current || !isDeepStrictEqual(current, actual)) return undefined
    const allowedTools: FileToolOperation[] = ['files.list', 'files.read', ...(input.allowMutation
      ? ['files.create_working_copy', 'files.write_working_copy', 'files.apply_format_edit', 'files.publish_result'] as const : [])]
    return { context: { ownerPrincipalId: identity.ownerPrincipalId, scope, nativeSessionId: identity.nativeSessionId,
      nativeMessageId: identity.nativeMessageId!, messageId: row.message_id, allowMutation: input.allowMutation, allowedTools },
    expiresAt: new Date(principal.expiresAt) }
  } }
}

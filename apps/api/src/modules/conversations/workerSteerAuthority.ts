import type pg from 'pg'
import { sessionTaskContent } from '@foreman-code/contracts'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { AcceptedChatInput } from './nativeChatInput.js'
import { DomainError } from '../errors.js'

/** A steer has its own command identity but can only address its admitted owner turn. */
export async function assertWorkerSteerAuthority(sql: Pick<pg.PoolClient, 'query'>,
  conversation: { id: string; kind: 'agent' | 'operator'; active_request_id: string | null;
    active_native_turn_id: string | null; native_session_id: string | null },
  request: Extract<WorkerConversationRpcRequest, { method: 'conversation.steer' }>, callerId: string): Promise<void> {
  const prefix = conversation.kind === 'agent' ? `agent-chat:${conversation.id}:` : `operator:${conversation.id}:`
  if (!conversation.active_request_id || !conversation.active_native_turn_id
    || request.expectedTurnId !== conversation.active_native_turn_id
    || request.session.nativeSessionId !== conversation.native_session_id || !request.correlationId.startsWith(prefix)) {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The addressed steer owner or native turn changed.', 409)
  }
  const requestId = request.correlationId.slice(prefix.length)
  const saved = (await sql.query<{ intent: string; delivery: string; target_native_turn_id: string | null;
    payload: { content: string; sessionMode?: 'regular' | 'plan'; ownerPrincipalId?: string; targetRequestId?: string; preparedInput?: { input: AcceptedChatInput } | AcceptedChatInput } }>(
    `select intent,delivery,target_native_turn_id,payload from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [conversation.id, requestId])).rows[0]
  const prepared = saved?.payload.preparedInput
  const prompt = prepared ? ('input' in prepared ? prepared.input.prompt : prepared.prompt)
    : saved ? sessionTaskContent(saved.payload.content, saved.payload.sessionMode) : undefined
  if (!saved || requestId === conversation.active_request_id || saved.intent !== 'steer'
    || !['submitting', 'unknown'].includes(saved.delivery)
    || saved.target_native_turn_id !== request.expectedTurnId
    || saved.payload.targetRequestId !== conversation.active_request_id
    || saved.payload.ownerPrincipalId !== callerId
    || prompt !== request.prompt) {
    throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE', 'The steer does not match its admitted command and original turn.', 409)
  }
}

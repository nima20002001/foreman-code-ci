import type { ExecutionResult } from '@foreman-code/contracts'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { AgentConversationRow, PostgresAgentChatRepository } from '../conversations/agentChatRepository.js'
import type { PostgresChatDeliveryRepository } from './deliveryRepository.js'
import type { CommittedReplySource, CommittedWorkflowChatFact, WorkflowChatProjector } from './projection.js'

type ReplyFact = Extract<CommittedWorkflowChatFact, { kind: 'reply' }>

/** Original public native messages only; ambiguous, provisional, reasoning, or truncated input is not a reply. */
export function conversationReplySource(receipts: PostgresChatDeliveryRepository,
  runReplies: CommittedReplySource): CommittedReplySource {
  return { read: async (tx, fact) => {
    const command = await receipts.byReceipt(fact.receiptId, tx)
    if (command?.request.target.kind !== 'agent_conversation') return runReplies.read(tx, fact)
    const id = command.request.target.conversationId
    const rows = (await tx.query<{ content: string; record: { requestId?: string; nativeMessageComplete?: boolean;
      nativeParentMessageId?: string; truncation?: unknown; activityChannel?: string };
      text_provenance: { sessionId: string; turnId?: string; final: boolean; channel: string } | null }>(`
      select content,record,text_provenance from operator_conversation_messages
      where conversation_id=$1 and role='assistant' and record->>'requestId'=$2
        and (native_message_id=$3 or record->>'nativeParentMessageId'=$3) order by sequence`,
    [id, fact.commandId, fact.nativeMessageId])).rows
    if (!rows.length || rows.some(row => row.record.nativeMessageComplete === false || row.record.truncation
      || row.record.activityChannel && row.record.activityChannel !== 'assistant'
      || row.text_provenance && (!row.text_provenance.final || row.text_provenance.channel !== 'assistant'
        || row.text_provenance.sessionId !== fact.nativeSessionId || row.text_provenance.turnId !== fact.nativeTurnId))) return undefined
    if (rows.length > 1 && rows.some(row => row.record.nativeParentMessageId !== fact.nativeMessageId)) return undefined
    return { body: rows.map(row => row.content).join('\n') }
  } }
}

async function replyIdentity(tx: TransactionSql, id: string, requestId: string, supplied?: string): Promise<string | undefined> {
  if (supplied) return supplied
  const rows = (await tx.query<{ id: string }>(`select distinct coalesce(record->>'nativeParentMessageId',native_message_id) as id
    from operator_conversation_messages where conversation_id=$1 and record->>'requestId'=$2 and role='assistant'
      and native_message_id is not null and record->>'nativeMessageComplete' is distinct from 'false'
      and (record->>'activityChannel' is null or record->>'activityChannel'='assistant') limit 2`, [id, requestId])).rows
  return rows.length === 1 ? rows[0]!.id : undefined
}

/** The terminal owner transaction queues a source reference; the off-critical-path projector reads its exact body. */
export function installConversationReplyProjection(repository: PostgresAgentChatRepository,
  receipts: PostgresChatDeliveryRepository, projector: WorkflowChatProjector): void {
  repository.setCommittedChatProjection(async (tx, input) => {
    const target = { kind: 'agent_conversation' as const, conversationId: input.row.id,
      agent: { workspaceId: input.row.workspace_id, workflowId: input.row.workflow_id,
        workflowNodeId: input.row.workflow_node_id, agentId: input.row.agent_id } }
    const commands = await receipts.unfinishedForTarget(target, tx)
    // A final answer to the original request is not evidence of which later steer it answered.
    const command = commands.find(item => item.request.commandId === input.requestId && item.ownerAdmission === 'owner_admitted')
    if (!command) return
    const state = input.result.outcome === 'succeeded' ? 'completed' : input.result.outcome
    if (input.row.native_session_id) await receipts.bindNativeSessionLocked(tx, command.receipt.id, input.row.native_session_id)
    const settled: typeof command.receipt = { ...command.receipt, state,
      ...(input.row.active_native_turn_id ? { nativeTurnId: input.row.active_native_turn_id } : {}),
      ...(input.result.error ? { errorCode: input.result.error.code } : {}), updatedAt: new Date().toISOString() }
    if (!input.result.error) delete settled.errorCode
    await receipts.updateLocked(tx, settled)
    if (input.result.outcome !== 'succeeded' || !command.request.sourcePostId || !command.ownerBinding.agentIdentity
      || !input.row.native_session_id) return
    const nativeMessageId = await replyIdentity(tx, input.row.id, input.requestId, input.nativeMessageId)
    if (!nativeMessageId) return
    const fact: ReplyFact = { kind: 'reply', sourceEventKey: `conversation-reply:${command.receipt.id}:${nativeMessageId}`,
      createdAt: new Date().toISOString(), agent: command.ownerBinding.agentIdentity,
      commandId: input.requestId, receiptId: command.receipt.id, nativeMessageId, nativeSessionId: input.row.native_session_id,
      ...(input.row.active_native_turn_id ? { nativeTurnId: input.row.active_native_turn_id } : {}) }
    await projector.enqueueCommitted(tx, fact)
  })
}

/** Public type for existing owner settlement integration, including typed fake owners. */
export interface CommittedConversationSettlement {
  row: AgentConversationRow; requestId: string; result: ExecutionResult; nativeMessageId?: string
}

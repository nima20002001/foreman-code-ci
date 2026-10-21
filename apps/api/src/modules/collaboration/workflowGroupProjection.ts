import type { CommittedReplySource } from '../workflow-chat/projection.js'
import { readWorkflowNativeChat } from '../interactions/workflowChatNativeRead.js'

export const workflowGroupReplies: CommittedReplySource = {
  async read(sql, fact) {
    const target = fact.execution ? { kind: 'workflow_execution' as const, agent: fact.agent, execution: fact.execution }
      : await consultationTarget(sql, fact)
    if (!target) return undefined
    const page = await readWorkflowNativeChat(sql, target, { limit: 1, bindings: [], messageId: fact.nativeMessageId })
    const message = page.messages.find(item => item.id === fact.nativeMessageId && item.role === 'assistant'
      && item.nativeMessageComplete && item.activityNative?.sessionId === fact.nativeSessionId
      && item.activityNative?.turnId === fact.nativeTurnId)
    return message ? { body: message.content } : undefined
  },
}

async function consultationTarget(sql: Parameters<CommittedReplySource['read']>[0],
  fact: Parameters<CommittedReplySource['read']>[1]) {
  if (!fact.consultationId) return undefined
  const row = (await sql.query<{ run_id: string; waiting_activation_id: string }>(
    'select run_id,waiting_activation_id from run_coordinator_consultations where id=$1', [fact.consultationId])).rows[0]
  return row ? { kind: 'workflow_coordinator' as const, agent: fact.agent, runId: row.run_id,
    waitingActivationId: row.waiting_activation_id } : undefined
}

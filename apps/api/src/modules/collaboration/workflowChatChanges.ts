import type pg from 'pg'
import { WorkflowExecutionChatChangeSchema } from '@foreman-code/contracts'
import type { Principal } from './ports.js'
import { controlDigest, workflowTargetRunId } from './workflowControlRecords.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import { withWorkflowChatRead } from './workflowChatRead.js'
import type { WorkflowChatOwnerPort, WorkflowChatTarget } from './workflowControlTypes.js'
import { readWorkflowNativeChat } from '../interactions/workflowChatNativeRead.js'

export async function readWorkflowChatChanges(pool: pg.Pool, owner: WorkflowChatOwnerPort,
  principal: Principal, target: WorkflowChatTarget, afterRevision?: string) {
  return withWorkflowChatRead(pool, principal, target, 'agent_chat:read', async sql => {
    const identity = await readWorkflowChatIdentity(sql, target)
    const kind = target.kind === 'workflow_execution' ? 'execution' : 'consultation'
    const scopeId = target.kind === 'workflow_execution' ? target.execution.executionId : target.waitingActivationId
    const native = (await sql.query<{ revision: string }>(`select coalesce(max(revision),0)::text as revision
      from workflow_native_chat_items where kind=$1 and run_id=$2 and scope_id=$3`,
    [kind, workflowTargetRunId(target), scopeId])).rows[0]!
    const commands = (await sql.query<{ revision: string }>(`select coalesce(sum(revision),0)::text as revision
      from run_chat_commands where run_id=$1 and target_key=$2`,
    [workflowTargetRunId(target), controlDigest(target)])).rows[0]!
    const activity = (await sql.query<{ revision: string }>(`select coalesce(max(sequence),0)::text as revision
      from run_activity where run_id=$1`, [workflowTargetRunId(target)])).rows[0]!
    const observation = await owner.observe(target)
    const stateCursor = controlDigest({ target, state: identity.state, commands, observation })
    const messages = afterRevision === undefined ? undefined : await readWorkflowNativeChat(sql, target,
      { afterRevision, limit: 100, bindings: [], messageBytes: 32 * 1024 })
    return { stateCursor, nativeRevision: native.revision, messages,
      change: WorkflowExecutionChatChangeSchema.parse({ target, snapshotRequired: true,
        revision: Math.max(Number(native.revision), Number(activity.revision)),
        cursor: controlDigest({ stateCursor, native }) }) }
  })
}

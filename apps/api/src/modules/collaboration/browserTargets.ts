import type pg from 'pg'
import { AgentSubjectSchema, BrowserTargetResultSchema,
  BrowserTargetSelectionSchema, type AgentSubject, type BrowserTargetResult } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readChatPrincipal } from '../access/conversationCredentials.js'
import { PostgresAgentChatRepository, agentChatKey } from '../conversations/agentChatRepository.js'
import { resolveWorkflowChatTarget } from './workflowChatResolver.js'
import type { BrowserAuthority } from './browserAuthority.js'

export async function resolveBrowserTarget(pool: pg.Pool, authority: BrowserAuthority,
  principal: ManagementPrincipal, raw: unknown): Promise<BrowserTargetResult> {
  const input = BrowserTargetSelectionSchema.parse(raw)
  const selected = await resolveWorkflowChatTarget(pool, await readChatPrincipal(pool, principal.id), input, 'workflows:read')
  let subject: AgentSubject
  if (selected.kind === 'outside_run') {
    const row = await new PostgresAgentChatRepository(pool).byKey(agentChatKey(selected.agent))
    if (!row || row.record.archived) return { kind: 'unavailable', reason: 'conversation_missing' }
    subject = (await authority.conversation(row.id)).context.subject
  } else if (selected.kind === 'selected') {
    if (selected.target.kind === 'workflow_execution') {
      subject = { kind: 'execution', agent: selected.agent, execution: selected.target.execution }
    } else {
      const row = (await pool.query<{ binding: unknown }>(`select c.binding from run_coordinator_consultations c
        join run_coordinator_mailboxes m on m.active_consultation_id=c.id where c.run_id=$1
        and c.waiting_activation_id=$2 and c.state in ('admitted','active','settling','unknown')`,
      [selected.target.runId, selected.target.waitingActivationId])).rows[0]
      if (!row) return { kind: 'unavailable', reason: 'consultation_idle' }
      subject = AgentSubjectSchema.parse({ kind: 'coordinator_consultation', agent: selected.agent, binding: row.binding })
    }
  } else return { kind: 'choose_target', selection: selected }
  const details = await authority.details(subject)
  const preparation = subject.kind === 'execution' ? (await pool.query<{ browser_input: unknown; browser_unavailable: unknown }>(
    "select browser_input,browser_unavailable from workflow_collaboration_preparations where execution_id=$1 and browser_state='unavailable'",
    [subject.execution.executionId])).rows[0] : undefined
  return BrowserTargetResultSchema.parse({ kind: 'selected', subject, browser: details.browser,
    computerId: details.computerId, historical: !details.active, readOnly: details.readOnly,
    ...(preparation ? { preparation: { request: preparation.browser_input, result: preparation.browser_unavailable } } : {}) })
}

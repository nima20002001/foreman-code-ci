import { browserSessionPrompt } from './browserPrompt.js'
import { AgentSubjectSchema, BrowserPrepareResultSchema, BrowserReleaseResultSchema, canonicalJson,
  type CoordinatorConsultationBinding } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { BrowserLifecyclePort } from './ports.js'
import type { WorkflowChatLockedTarget } from './workflowControlTypes.js'
import { readCoordinatorConsultationLocked } from './workflowConsultations.js'
import { disabledBrowserLifecyclePort } from './disabled.js'

export type ConsultationTransaction = <T>(work: (context: WorkflowChatLockedTarget) => Promise<T>) => Promise<T>
type BrowserInput = Parameters<BrowserLifecyclePort['prepare']>[0]
interface BrowserRow {
  browser_input: BrowserInput | null
  browser_state: 'preparing' | 'ready' | 'unavailable' | 'releasing' | 'released' | null
  browser_session_id: string | null
  browser_release_reason: 'terminal' | 'stop' | null
}

/** D retains the exact subject/command; B still owns all browser resources. */
export class ConsultationBrowserOwnership {
  private readonly browser: BrowserLifecyclePort
  constructor(browser?: BrowserLifecyclePort) { this.browser = browser ?? disabledBrowserLifecyclePort }

  async prepare(transaction: ConsultationTransaction, binding: CoordinatorConsultationBinding,
    computer: () => Promise<string>): Promise<void> {
    const configured = await transaction(async context => {
      const node = context.version.definition.nodes.find(item => item.id === context.agent.workflowNodeId)
      return !!node && node.kind !== 'job' && node.browser?.enabled
    })
    if (!configured) return
    const computerId = await computer()
    const input = await transaction(async context => {
      const current = await readCoordinatorConsultationLocked(context.sql, binding.runId, binding.waitingActivationId)
      const node = context.version.definition.nodes.find(item => item.id === context.agent.workflowNodeId)
      if (context.stopping || context.accepted || canonicalJson(current?.binding) !== canonicalJson(binding)
        || !current || !['admitted','active','unknown'].includes(current.state) || !node || node.kind === 'job'
        || !node.browser?.enabled) throw new DomainError('COORDINATOR_BINDING_CONFLICT',
        'This consultation no longer admits browser preparation.', 409)
      const proposed: BrowserInput = { subject: AgentSubjectSchema.parse({ kind: 'coordinator_consultation',
        agent: context.agent, binding }), browser: node.browser, computerId,
      commandId: `browser-prepare:${binding.consultationId}` }
      await context.sql.query(`update run_coordinator_consultations set browser_input=$2::jsonb,browser_state='preparing'
        where id=$1 and browser_input is null`, [binding.consultationId, canonicalJson(proposed)])
      const row = (await context.sql.query<BrowserRow>('select * from run_coordinator_consultations where id=$1',
        [binding.consultationId])).rows[0]!
      if (canonicalJson(row.browser_input) !== canonicalJson(proposed) || ['released','releasing'].includes(row.browser_state ?? '')) {
        throw new DomainError('BROWSER_PREPARATION_CONFLICT', 'The consultation browser identity changed.', 409)
      }
      return row.browser_state === 'ready' ? undefined : proposed
    })
    if (!input) return
    const result = BrowserPrepareResultSchema.parse(await this.browser.prepare(input))
    await this.retain(transaction, binding, input, result)
    if (result.kind === 'unavailable') throw new DomainError('BROWSER_PREPARATION_UNAVAILABLE',
      `The coordinator browser is unavailable: ${result.reason}.`, result.retryable ? 503 : 409)
    if (result.session.state !== 'ready' || result.control.state !== 'agent') throw new DomainError(
      'BROWSER_CONTROL_PENDING', 'The coordinator browser is waiting for host-confirmed control.', 503)
  }

  async readPrompt(transaction: ConsultationTransaction, binding: CoordinatorConsultationBinding) {
    return transaction(async context => {
      const current = await readCoordinatorConsultationLocked(context.sql, binding.runId, binding.waitingActivationId)
      if (canonicalJson(current?.binding) !== canonicalJson(binding)) throw new DomainError('COORDINATOR_BINDING_CONFLICT', 'The consultation browser changed.', 409)
      const row = (await context.sql.query<BrowserRow>('select * from run_coordinator_consultations where id=$1', [binding.consultationId])).rows[0]
      return row?.browser_state === 'ready' && row.browser_session_id ? browserSessionPrompt(row.browser_session_id) : undefined
    })
  }

  private async retain(transaction: ConsultationTransaction, binding: CoordinatorConsultationBinding,
    input: BrowserInput, result: ReturnType<typeof BrowserPrepareResultSchema.parse>) {
    if (result.kind === 'ready' && (canonicalJson(result.session.subject) !== canonicalJson(input.subject)
      || result.session.profileId !== input.browser.profileId || result.session.computerId !== input.computerId)) {
      throw new DomainError('BROWSER_SESSION_OWNER_CONFLICT', 'The browser acknowledged a different consultation subject.', 409)
    }
    await transaction(async context => {
      const row = (await context.sql.query<BrowserRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2',
        [binding.consultationId, binding.runId])).rows[0]
      if (!row || canonicalJson(row.browser_input) !== canonicalJson(input) || row.browser_state === 'released'
        || result.kind === 'ready' && row.browser_session_id && row.browser_session_id !== result.session.id) {
        throw new DomainError('BROWSER_PREPARATION_CONFLICT', 'The original consultation browser preparation changed.', 409)
      }
      await context.sql.query(`update run_coordinator_consultations set browser_session_id=coalesce(browser_session_id,$2),
        browser_unavailable=$3::jsonb,browser_state=case when browser_release_reason is not null then 'releasing' else $4 end
        where id=$1`, [binding.consultationId, result.kind === 'ready' ? result.session.id : null,
        result.kind === 'unavailable' ? canonicalJson(result) : null, result.kind === 'unavailable' ? 'unavailable'
          : result.session.state === 'ready' && result.control.state === 'agent' ? 'ready' : 'preparing'])
    })
  }

  async release(transaction: ConsultationTransaction, binding: CoordinatorConsultationBinding,
    reason: 'terminal' | 'stop'): Promise<void> {
    let row = await transaction(async context => {
      const current = (await context.sql.query<BrowserRow>('select * from run_coordinator_consultations where id=$1 and run_id=$2',
        [binding.consultationId, binding.runId])).rows[0]
      if (!current?.browser_input || current.browser_state === 'released') return undefined
      await context.sql.query(`update run_coordinator_consultations set browser_state='releasing',
        browser_release_reason=coalesce(browser_release_reason,$2) where id=$1`, [binding.consultationId, reason])
      return { ...current, browser_release_reason: current.browser_release_reason ?? reason }
    })
    if (!row?.browser_input) return
    const input = row.browser_input
    if (!row.browser_session_id && row.browser_state !== 'unavailable') {
      const result = BrowserPrepareResultSchema.parse(await this.browser.prepare(input))
      await this.retain(transaction, binding, input, result)
      row = { ...row, browser_session_id: result.kind === 'ready' ? result.session.id : null }
    }
    if (row.browser_session_id) {
      const result = BrowserReleaseResultSchema.parse(await this.browser.release({ subject: input.subject,
        sessionId: row.browser_session_id, reason: row.browser_release_reason,
        commandId: `browser-release:${binding.consultationId}` }))
      if (result.sessionId !== row.browser_session_id) throw new DomainError('BROWSER_SESSION_OWNER_CONFLICT',
        'The browser release acknowledged another consultation.', 409)
      if (result.state === 'pending') throw new DomainError('REPEAT_CLEANUP_PENDING',
        'The consultation browser has not confirmed release.', 409)
    }
    await transaction(async context => {
      await context.sql.query("update run_coordinator_consultations set browser_state='released' where id=$1 and run_id=$2",
        [binding.consultationId, binding.runId])
    })
  }
}

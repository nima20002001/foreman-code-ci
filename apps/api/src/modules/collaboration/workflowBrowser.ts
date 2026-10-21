import { browserSessionPrompt } from './browserPrompt.js'
import {
  AgentSubjectSchema, BrowserPrepareResultSchema, BrowserReleaseResultSchema, NodeBrowserSettingsSchema,
  type HarnessExecution,
} from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { BrowserLifecyclePort } from './ports.js'
import { disabledBrowserLifecyclePort } from './disabled.js'
import { retainWorkflowPreparationLocked, withWorkflowPreparation, workflowPreparationIdentityLocked } from './workflowPreparation.js'

type PrepareInput = Parameters<BrowserLifecyclePort['prepare']>[0]
interface BrowserBinding {
  browser_input: unknown
  browser_state: 'preparing' | 'ready' | 'unavailable' | 'releasing' | 'released'
  browser_session_id: string | null
  browser_unavailable: unknown
  browser_release_reason: 'terminal' | 'stop' | null
}

function exactInput(value: unknown): PrepareInput {
  const row = value as PrepareInput
  const subject = AgentSubjectSchema.parse(row.subject)
  const browser = NodeBrowserSettingsSchema.parse(row.browser)
  if (!row.computerId || !row.commandId || !browser.enabled || !browser.profileId || subject.kind !== 'execution') {
    throw new DomainError('BROWSER_PREPARATION_CONFLICT', 'The original browser preparation identity is incomplete.', 409)
  }
  return { subject, browser, computerId: row.computerId, commandId: row.commandId }
}

/** Owns only the engine's exact B-port preparation/release intent, never B's
 * sessions, profiles, tabs, control epochs or transport. Native calls stay
 * outside SQL; an unknown release remains pending on the existing cleanup path. */
export class WorkflowBrowserOwnership {
  private readonly browser: BrowserLifecyclePort
  private readonly installed: boolean
  constructor(browser?: BrowserLifecyclePort) {
    this.browser = browser ?? disabledBrowserLifecyclePort
    this.installed = browser !== undefined
  }

  async prepare(owner: RunOwnership, run: AcceptedWorkflowRunV3, version: WorkflowVersionV3,
    execution: HarnessExecution, computer: () => Promise<string>): Promise<void> {
    const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    if (!node || node.kind === 'job' || !node.browser?.enabled) return
    const computerId = await computer()
    const input = await withWorkflowPreparation(owner, execution, true, async (sql, actualRun) => {
      if (actualRun.workflowVersionId !== run.workflowVersionId) throw new DomainError('RUN_PIN_CONFLICT',
        'The browser preparation Run version changed.', 409)
      const identity = await workflowPreparationIdentityLocked(sql, actualRun, version, execution)
      if (!identity) throw new DomainError('BROWSER_SUBJECT_REQUIRED', 'The saved Agent has no browser subject.', 409)
      await retainWorkflowPreparationLocked(sql, execution, identity)
      const proposed: PrepareInput = { subject: identity.subject, browser: node.browser!, computerId,
        commandId: `browser-prepare:${execution.id}` }
      await sql.query(`update workflow_collaboration_preparations set browser_input=$2::jsonb,browser_state='preparing'
        where execution_id=$1 and browser_input is null`, [execution.id, JSON.stringify(proposed)])
      const row = (await sql.query<BrowserBinding>(
        'select * from workflow_collaboration_preparations where execution_id=$1', [execution.id])).rows[0]!
      if (!sameWorkflowValue(row.browser_input, proposed)) throw new DomainError('BROWSER_PREPARATION_CONFLICT',
        'Browser preparation cannot change its accepted subject, profile or computer.', 409)
      if (row.browser_state === 'released' || row.browser_state === 'releasing') throw new DomainError(
        'BROWSER_SESSION_RELEASED', 'This execution browser is already being released.', 409)
      if (row.browser_state === 'ready') return undefined
      return exactInput(row.browser_input)
    })
    if (!input) return
    const result = BrowserPrepareResultSchema.parse(await this.browser.prepare(input))
    owner.assertOwned()
    await this.retainResult(owner, execution, input, result)
    if (result.kind === 'unavailable') throw new DomainError('BROWSER_PREPARATION_UNAVAILABLE',
      `The Agent browser is unavailable: ${result.reason}.`, result.retryable ? 503 : 409,
      { reason: result.reason, retryable: result.retryable })
    if (result.session.state !== 'ready' || result.control.state !== 'agent') throw new DomainError(
      'BROWSER_CONTROL_PENDING', 'The owning browser is waiting for host-confirmed Agent control.', 503,
      { retryable: true })
    // Stop may win while B prepares. Retain its exact session for owner cleanup,
    // but never let the completed outside-SQL call authorize native launch.
    await withWorkflowPreparation(owner, execution, true, async () => undefined)
  }

  private async retainResult(owner: RunOwnership, execution: HarnessExecution, input: PrepareInput,
    result: ReturnType<typeof BrowserPrepareResultSchema.parse>): Promise<void> {
    if (result.kind === 'ready' && (!sameWorkflowValue(result.session.subject, input.subject)
      || result.session.profileId !== input.browser.profileId || result.session.computerId !== input.computerId)) {
      throw new DomainError('BROWSER_SESSION_OWNER_CONFLICT', 'The prepared session belongs to another Agent, profile or computer.', 409)
    }
    await withWorkflowPreparation(owner, execution, false, async sql => {
      const prior = (await sql.query<BrowserBinding>(
        'select * from workflow_collaboration_preparations where execution_id=$1', [execution.id])).rows[0]
      if (!prior || !sameWorkflowValue(prior.browser_input, input) || prior.browser_state === 'released'
        || result.kind === 'ready' && prior.browser_session_id && prior.browser_session_id !== result.session.id) {
        throw new DomainError('BROWSER_PREPARATION_CONFLICT', 'The original browser preparation changed.', 409)
      }
      await sql.query(`update workflow_collaboration_preparations set
        browser_session_id=coalesce(browser_session_id,$2),browser_unavailable=$3::jsonb,
        browser_state=case when browser_release_reason is not null then 'releasing' else $4 end
        where execution_id=$1`, [execution.id, result.kind === 'ready' ? result.session.id : null,
        result.kind === 'unavailable' ? JSON.stringify(result) : null, result.kind === 'ready'
          ? result.session.state === 'ready' && result.control.state === 'agent' ? 'ready' : 'preparing'
          : 'unavailable'])
    })
  }

  async readPrompt(owner: RunOwnership, execution: HarnessExecution, version: WorkflowVersionV3): Promise<string | undefined> {
    const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    if (!this.installed || !node || node.kind === 'job' || !node.browser?.enabled) return undefined
    return withWorkflowPreparation(owner, execution, false, async sql => {
      const row = (await sql.query<BrowserBinding>('select * from workflow_collaboration_preparations where execution_id=$1',
        [execution.id])).rows[0]
      return row?.browser_state === 'ready' && row.browser_session_id ? browserSessionPrompt(row.browser_session_id) : undefined
    })
  }

  async release(owner: RunOwnership, execution: HarnessExecution, reason: 'terminal' | 'stop',
    version: WorkflowVersionV3): Promise<void> {
    const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    if (!this.installed || !node || node.kind === 'job' || !node.browser?.enabled) return
    let binding = await withWorkflowPreparation(owner, execution, false, async (sql, run, state) => {
      if (reason === 'stop' ? !state.stopped && !state.cleanup : execution.state !== 'completed'
        && run.executionState !== 'completed') throw new DomainError('BROWSER_RELEASE_NOT_ADMITTED',
        'Browser cleanup requires its exact terminal or committed Run cleanup fence.', 409)
      const row = (await sql.query<BrowserBinding>(
        'select * from workflow_collaboration_preparations where execution_id=$1', [execution.id])).rows[0]
      if (!row?.browser_input || row.browser_state === 'released') return undefined
      await sql.query(`update workflow_collaboration_preparations set browser_state='releasing',
        browser_release_reason=coalesce(browser_release_reason,$2) where execution_id=$1`, [execution.id, reason])
      return { ...row, browser_release_reason: row.browser_release_reason ?? reason }
    })
    if (!binding) return
    const input = exactInput(binding.browser_input)
    if (!binding.browser_session_id && binding.browser_state !== 'unavailable') {
      // Same B command resolves a prepare/COMMIT reply gap. Failure/host loss is
      // unknown ownership, never evidence that no session or lease exists.
      const result = BrowserPrepareResultSchema.parse(await this.browser.prepare(input))
      owner.assertOwned()
      await this.retainResult(owner, execution, input, result)
      binding = { ...binding, browser_session_id: result.kind === 'ready' ? result.session.id : null,
        browser_state: result.kind === 'ready' ? 'ready' : 'unavailable' }
    }
    if (binding.browser_session_id) {
      const result = BrowserReleaseResultSchema.parse(await this.browser.release({ sessionId: binding.browser_session_id,
        subject: input.subject, commandId: `browser-release:${execution.id}`, reason: binding.browser_release_reason! }))
      owner.assertOwned()
      if (result.sessionId !== binding.browser_session_id) throw new DomainError('BROWSER_SESSION_OWNER_CONFLICT',
        'Browser release acknowledged another session.', 409)
      if (result.state === 'pending') throw new DomainError('REPEAT_CLEANUP_PENDING',
        'The original browser host has not confirmed session release.', 409,
        { retryable: true, reason: result.reason })
    }
    await withWorkflowPreparation(owner, execution, false, async sql => {
      await sql.query(`update workflow_collaboration_preparations set browser_state='released'
        where execution_id=$1 and browser_release_reason is not null
          and browser_session_id is not distinct from $2`, [execution.id, binding!.browser_session_id])
    })
  }
}

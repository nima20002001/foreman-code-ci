import { BoardDigestSchema, type CoordinatorConsultationBinding, type HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../runs/ownership.js'
import type { CollaborationPorts } from './ports.js'
import { createWorkflowCollaborationHooks } from './workflowHooks.js'
import { WorkflowMemoryContext } from './workflowPreparation.js'
import { WorkflowBrowserOwnership } from './workflowBrowser.js'
import { DomainError } from '../errors.js'
import type { WorkflowResultEffectFailure } from '../runs/workflowResultEffectFailure.js'
import { ConsultationBrowserOwnership, type ConsultationTransaction } from './consultationBrowser.js'

export type WorkflowFeaturePorts = Partial<Pick<CollaborationPorts, 'memoryBoards' | 'browser'>>

/** Root composition supplies the actual A/B ports. Missing implementations keep
 * the C0 no-access behavior; this adapter does not enable result enforcement. */
export class WorkflowCollaborationIntegration {
  readonly hooks
  private readonly memory: WorkflowMemoryContext
  private readonly browser: WorkflowBrowserOwnership
  private readonly consultationBrowser: ConsultationBrowserOwnership
  constructor(private readonly ports: WorkflowFeaturePorts = {}, private readonly computerId:
    (owner: RunOwnership, execution: HarnessExecution) => Promise<string>) {
    this.hooks = createWorkflowCollaborationHooks(ports.memoryBoards)
    this.memory = new WorkflowMemoryContext(ports.memoryBoards)
    this.browser = new WorkflowBrowserOwnership(ports.browser)
    this.consultationBrowser = new ConsultationBrowserOwnership(ports.browser)
  }
  async prepare(owner: RunOwnership, run: AcceptedWorkflowRunV3, version: WorkflowVersionV3,
    execution: HarnessExecution): Promise<void> {
    await this.memory.prepare(owner, run, version, execution)
    owner.assertOwned()
    await this.browser.prepare(owner, run, version, execution, () => this.computerId(owner, execution))
  }
  async readPrompt(owner: RunOwnership, execution: HarnessExecution, version: WorkflowVersionV3): Promise<string | undefined> {
    const memory = await this.memory.readPrompt(owner, execution)
    const browser = await this.browser.readPrompt(owner, execution, version)
    return [memory, browser].filter(Boolean).join('\n\n') || undefined
  }
  async effectRepairPrompt(owner: RunOwnership, failure: WorkflowResultEffectFailure): Promise<string> {
    owner.assertOwned()
    if (!this.ports.memoryBoards || failure.work.runId !== owner.runId) throw new DomainError(
      'WORKFLOW_BOARD_EFFECT_REPAIR_UNAVAILABLE', 'The original board context is unavailable for correction.', 409)
    const digest = BoardDigestSchema.parse(await this.ports.memoryBoards.readDigest({
      subject: failure.subject, work: failure.work }))
    owner.assertOwned()
    return [
      'Your RESULT has a board revision conflict. Its entire structured board batch was rolled back; the task is still pending.',
      'Return a complete corrected RESULT using the same task input and result contract. Preserve the deliverable and routing.',
      'Use the current board facts below and scoped tools to check exact revisions before proposing changes.',
      'Already committed direct tool writes remain factual. Do not replay them under new command IDs.',
      'Current bounded memory board facts:', digest.text || '(No visible board items.)',
      ...(digest.omittedCount ? [`${digest.omittedCount} additional items are omitted; inspect only the needed records.`] : []),
    ].join('\n')
  }
  release(owner: RunOwnership, execution: HarnessExecution, reason: 'terminal' | 'stop',
    version: WorkflowVersionV3): Promise<void> {
    return this.browser.release(owner, execution, reason, version)
  }
  async prepareConsultation(owner: RunOwnership, execution: HarnessExecution,
    binding: CoordinatorConsultationBinding, transaction: ConsultationTransaction): Promise<void> {
    await this.consultationBrowser.prepare(transaction, binding, () => this.computerId(owner, execution))
    owner.assertOwned()
  }
  readConsultationPrompt(binding: CoordinatorConsultationBinding, transaction: ConsultationTransaction) {
    return this.consultationBrowser.readPrompt(transaction, binding)
  }
  releaseConsultation(binding: CoordinatorConsultationBinding, transaction: ConsultationTransaction,
    reason: 'terminal' | 'stop'): Promise<void> {
    return this.consultationBrowser.release(transaction, binding, reason)
  }
}

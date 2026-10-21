import { DomainError } from '../errors.js'
import type { InteractionService } from '../interactions/service.js'
import type { LangGraphWorkflowEngine } from './engine.js'

const registrations = new WeakMap<InteractionService, LangGraphWorkflowEngine>()

/** One production composition seam, shared by the focused integration fixture.
 * The actual checkpoint and canonical resume receipt commit atomically.
 */
export function registerApprovalCheckpointResume(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  const existing = registrations.get(interactions)
  if (existing === engine) return
  if (existing) throw new DomainError('APPROVAL_RESUME_ALREADY_BOUND', 'Another engine owns this interaction service.', 409)
  interactions.useApprovalPreparation((interaction) => engine.prepareInteraction(interaction))
  interactions.useAtomicApprovalResume((claim) => engine.resumeInteraction(claim.interaction, claim))
  registrations.set(interactions, engine)
}

export function assertApprovalCheckpointRegistration(interactions: InteractionService, engine: LangGraphWorkflowEngine): void {
  if (registrations.get(interactions) !== engine) throw new DomainError(
    'APPROVAL_RESUME_COMPOSITION_REQUIRED', 'Bind the actual interaction service to this engine checkpoint consumer.', 503)
}

import type { HarnessConfiguration, WorkflowApprovalConfiguration } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

/** Reject an unavailable reviewer before launch. Never change native permissions to make it work. */
export function validateReviewerBootstrap(
  definition: WorkflowDefinitionV3,
  approval: WorkflowApprovalConfiguration,
  configuration: HarnessConfiguration | undefined,
  acceptedEntryNodeId?: string,
): void {
  if (approval.handler !== 'orchestrator') return
  const nodes = definition.nodes.filter((node) => node.kind !== 'job' && node.agentId === approval.designatedOrchestratorAgentId)
  const reviewer = nodes[0]
  const entryNodeId = definition.entryNodeId
  if (acceptedEntryNodeId !== undefined && acceptedEntryNodeId !== entryNodeId) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_ORDER',
      'The authored entry must match the accepted immutable entry.', 409)
  }
  if (nodes.length !== 1 || !reviewer || entryNodeId !== reviewer.id
    || definition.approval?.handler !== 'orchestrator'
    || definition.approval.designatedOrchestratorAgentId !== approval.designatedOrchestratorAgentId
    || !(definition.hierarchy && definition.handoffs)
      && definition.edges.some((edge) => edge.target === reviewer.id && edge.kind === 'execution')) {
    throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_ORDER',
      'The designated coordinator must appear once as the accepted entry, with no incoming automatic execution dependency. Independent or recursive reviewer startup is unsupported.', 409)
  }
  if (configuration?.harness === 'codex') {
    if (configuration.advanced?.approvalPolicy !== 'on-request'
      || configuration.advanced.approvalsReviewer !== 'auto_review') {
      const message = 'Choose “You, the Operator” for approvals, or set the reviewing agent to “Ask when needed” and “Codex automatic review”.'
      throw new DomainError('APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED', message, 409, { issues: [{
        code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED', path: ['approval', 'handler'], message,
      }] })
    }
    return
  }
  throw new DomainError('APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE',
    'The initial Orchestrator cannot review its own approval. Choose Codex automatic review or select the User workflow handler.', 409)
}

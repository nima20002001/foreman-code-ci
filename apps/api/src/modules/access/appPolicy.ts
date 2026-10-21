import type { DurableInteraction } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementAction, type ManagementPrincipal } from '@foreman-code/contracts/management'

import { DomainError } from '../errors.js'
import { assertOrchestratorInteractionAuthority } from '../interactions/authorization.js'

export interface WorkerScope {
  workspaceIds?: readonly string[]
  workflowIds?: readonly string[]
  runIds?: readonly string[]
}

type WorkerAction = Extract<ManagementAction, 'interactions:read' | 'interactions:respond' | 'bug_reports:report'>

/** Keep action and all three scope dimensions in the same grant. */
export function workerScopesForAction(principal: ManagementPrincipal, action: WorkerAction): WorkerScope[] {
  const parsed = ManagementPrincipalSchema.parse(principal)
  if (parsed.audience !== 'worker' || !parsed.agentId || parsed.revokedAt
    || Date.parse(parsed.expiresAt) <= Date.now()) return []
  return parsed.grants.filter((grant) => grant.actions.includes(action)
    && grant.scope.workspaceIds?.length && grant.scope.workflowIds?.length && grant.scope.runIds?.length)
    .map((grant) => ({
      workspaceIds: grant.scope.workspaceIds!, workflowIds: grant.scope.workflowIds!, runIds: grant.scope.runIds!,
    }))
}

export function hasWorkerAction(principal: ManagementPrincipal, action: WorkerAction): boolean {
  return workerScopesForAction(principal, action).length > 0
}

/** Summary for context display only. Authorization must use the per-grant scopes. */
export function workerScope(principal: ManagementPrincipal): WorkerScope {
  const parsed = ManagementPrincipalSchema.parse(principal)
  if (parsed.audience !== 'worker' || !parsed.agentId || parsed.revokedAt
    || Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new DomainError('APP_ACCESS_DENIED', 'The App caller is not authorized.', 403)
  }
  const scopes = [
    ...workerScopesForAction(parsed, 'interactions:read'),
    ...workerScopesForAction(parsed, 'interactions:respond'),
    ...workerScopesForAction(parsed, 'bug_reports:report'),
  ]
  if (scopes.length === 0) {
    throw new DomainError('APP_SCOPE_REQUIRED', 'The App credential does not have an explicit execution scope.', 403)
  }
  return {
    workspaceIds: [...new Set(scopes.flatMap((scope) => scope.workspaceIds ?? []))],
    workflowIds: [...new Set(scopes.flatMap((scope) => scope.workflowIds ?? []))],
    runIds: [...new Set(scopes.flatMap((scope) => scope.runIds ?? []))],
  }
}

function scopeMatches(scope: WorkerScope, interaction: DurableInteraction): boolean {
  return !!scope.workspaceIds?.includes(interaction.workspaceId)
    && !!scope.workflowIds?.includes(interaction.workflowId)
    && !!scope.runIds?.includes(interaction.runId)
}

export function canReadInteraction(principal: ManagementPrincipal, interaction: DurableInteraction): boolean {
  return workerScopesForAction(principal, 'interactions:read').some((scope) => scopeMatches(scope, interaction))
}

export function canRespondToInteraction(principal: ManagementPrincipal, interaction: DurableInteraction): boolean {
  if (!principal.agentId || !canReadInteraction(principal, interaction)
    || !workerScopesForAction(principal, 'interactions:respond').some((scope) => scopeMatches(scope, interaction))) return false
  try {
    assertOrchestratorInteractionAuthority(interaction, {
      agentId: principal.agentId,
      workspaceId: interaction.workspaceId,
      workflowId: interaction.workflowId,
    })
    return true
  } catch {
    return false
  }
}

export function requireReadableInteraction(principal: ManagementPrincipal, interaction: DurableInteraction | undefined): DurableInteraction {
  if (!interaction || !canReadInteraction(principal, interaction)) {
    throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
  }
  return interaction
}

export function requireRespondableInteraction(principal: ManagementPrincipal, interaction: DurableInteraction | undefined): DurableInteraction {
  if (!interaction || !canRespondToInteraction(principal, interaction)) {
    // Deliberately non-enumerating: wrong workflow, reviewer, and self-review look absent.
    throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
  }
  return interaction
}

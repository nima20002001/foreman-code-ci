import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { WorkerInteractionContext } from './authorization.js'

export type InteractionResponder =
  | { kind: 'user'; principal?: ManagementPrincipal }
  | { kind: 'operator'; principal: ManagementPrincipal; source?: 'http' | 'mcp' }
  | { kind: 'orchestrator'; authority: WorkerInteractionContext; principal?: ManagementPrincipal;
      /** Rejected explicitly; audit belongs to the shared G1 decision writer. */
      beforeCommit?: unknown }

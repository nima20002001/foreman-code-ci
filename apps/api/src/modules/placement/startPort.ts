import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunStartV3Input } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { PlacementCommitFence } from './admission.js'

/** Internal composition only. HTTP/MCP callers send saved version pins, never
 * arbitrary placement JSON. Preparation loads those saved records and performs
 * authenticated host/W09 I/O before the existing Start transaction begins. */
export interface RunPlacementAdmissionPort {
  prepare(input: RunStartV3Input, principal: ManagementPrincipal,
    signal?: AbortSignal, options?: {
      source: 'http' | 'mcp'; sourcePreparationStarted?: () => void
    }): Promise<PreparedRunPlacementAdmission | undefined>
}
export interface PreparedRunPlacementAdmission {
  /** Pure function binds prepared immutable evidence to the NEW Run identity. */
  bind(runId: string): readonly AcceptedNodePlacement[]
  /** Supplies SQL-only revision/auth/config fences on this exact transaction. */
  fence(sql: GraphTransactionSql): PlacementCommitFence
}

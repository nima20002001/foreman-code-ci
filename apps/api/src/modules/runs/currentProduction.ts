import type pg from 'pg'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { InteractionService } from '../interactions/service.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { RepeatStartPublication } from './repeatStartAdmission.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { LangGraphWorkflowEngine } from './engine.js'
import type { PostgresRunRepository } from './postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'

export interface CurrentRuntimeAvailability { runtimeAdmission: boolean; stopAvailable: boolean }
export interface CurrentStopReceipt {
  runId: string; status: 'accepted' | 'already_terminal' | 'not_owner'; processStopped: false
}
export interface CurrentStopContext {
  principal: ManagementPrincipal; source: 'http' | 'mcp'
  input: { workspaceId: string; runId: string; commandId: string }
  run: WorkflowRunV3
  /** A MUST call this while holding the same parent lock as durable Stop.
   * It reads live authority again; the captured principal is not authorization. */
  authorizeLocked(sql: GraphTransactionSql): Promise<void>
}
/** Trusted production composition, not a request flag, test receipt or second
 * engine. A supplies ALL of this only with the actual configured engine,
 * repository, native publication, approval and Stop/cleanup implementations.
 * B never substitutes the baseline SQL fixture publisher for this capability. */
export interface CurrentRunProductionBinding {
  readonly startPublication: RepeatStartPublication
  availability(): CurrentRuntimeAvailability
  assertStartReady(): void
  assertStopReady(): void
  /** Idempotent by the exact context command; return only known durable intent
   * acceptance. An uncertain outcome MUST throw and preserve that identity.
   * Do not call a legacy orphan terminalizer or infer process closure. */
  stop(context: CurrentStopContext): Promise<CurrentStopReceipt>
  /** Diagnostic failure sink; cannot rewrite an accepted Run as successful. */
  reportDispatchFailure(runId: string, error: unknown): void
}
export interface CurrentRunProductionContext {
  primaryPool: pg.Pool; commands: PostgresCommandCoordinator
  runs: PostgresRunRepository; workflows: PostgresWorkflowRepository
  locations: WorkspaceLocationService; engine: LangGraphWorkflowEngine
  nativeExecutions: ApprovalExecutionCoordinator
  interactions: InteractionService; checkpointer: BaseCheckpointSaver
}
export type CurrentRunProductionFactory = (context: CurrentRunProductionContext) => CurrentRunProductionBinding

import type pg from 'pg'
import type { AcceptedNodePlacement, DispatchIntent, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { ExecutionScopedNativeSessionManagerResolver, type NativeManagerResolutionContext, type NativeSessionManagerResolver } from '../interactions/runtimePorts.js'
import { readAcceptedPlacement, readDispatchIntent } from './persistence.js'
import { DomainError } from '../errors.js'

export interface AcceptedExecutionBinding { intent: DispatchIntent; placement: AcceptedNodePlacement; executionPlacement?: NativeExecutionPlacement }

/** Existing V3 validateContinuation runs before sync manager resolution. Compose
 * prepare there, rather than query current placement or switch managers during
 * credential preflight. Each execution retains exactly one native manager. */
export class HostBoundExecutionManagers implements NativeSessionManagerResolver {
  private readonly bindings = new Map<string, AcceptedExecutionBinding | null>()
  private readonly managers: ExecutionScopedNativeSessionManagerResolver
  constructor(private readonly mainId: string, private readonly pool: pg.Pool,
    private readonly executions: { getExecution(id: string): Promise<HarnessExecution | undefined> },
    localFactory: (context: NativeManagerResolutionContext) => NativeHarnessSessionManager,
    remoteFactory: (context: NativeManagerResolutionContext, binding: AcceptedExecutionBinding) => NativeHarnessSessionManager) {
    this.managers = new ExecutionScopedNativeSessionManagerResolver(context => {
      const binding = this.bindings.get(context.executionId)
      if (binding === undefined) throw new DomainError('PLACEMENT_PREPARATION_REQUIRED', 'Load the exact execution binding before manager allocation.', 409)
      if (!binding) return localFactory(context) // existing unplaced local workflow
      const { placement, intent } = binding
      if (placement.payload.kind !== 'agent' || placement.payload.agentId !== context.agentId
        || placement.payload.agentConfigurationVersionId !== context.configuration.id
        || placement.destination.canonicalCwd !== context.workingDirectory || intent.executionId !== context.executionId) {
        throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Native manager context does not match the accepted execution.', 409)
      }
      return placement.hostRef.kind === 'main' ? localFactory(context) : remoteFactory(context, binding)
    })
  }

  async prepare(executionId: string): Promise<AcceptedExecutionBinding | null> {
    const execution = await this.executions.getExecution(executionId)
    if (!execution) throw new DomainError('EXECUTION_NOT_FOUND', 'Exact execution is required for placement preparation.', 404)
    const intent = await readDispatchIntent(this.pool, executionId)
    const placement = await readAcceptedPlacement(this.pool, execution.runId, execution.workflowNodeId)
    if (!!intent !== !!placement) throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Accepted placed execution has no matching durable dispatch.', 409)
    if (intent && placement && (intent.mainId !== this.mainId || placement.mainId !== this.mainId
      || intent.runId !== execution.runId || intent.nodeId !== execution.workflowNodeId
      || placement.destination.canonicalCwd !== execution.workingDirectory)) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Exact execution host or directory changed.', 409)
    }
    if (intent) { Object.freeze(intent.owner); Object.freeze(intent) }
    const binding = intent && placement ? Object.freeze({ intent, placement }) : null
    const old = this.bindings.get(executionId)
    if (old !== undefined && !sameWorkflowValue(old, binding)) throw new DomainError(
      'PLACEMENT_BINDING_CONFLICT', 'Execution placement cannot change after manager preparation.', 409)
    this.bindings.set(executionId, binding)
    return binding
  }

  resolve(context: NativeManagerResolutionContext) { return this.managers.resolve(context) }
  release(context: NativeManagerResolutionContext, manager?: NativeHarnessSessionManager, state?: 'released' | 'failed') {
    this.managers.release(context, manager, state)
  }
  dispose(): Promise<void> { return this.managers.dispose() }
  binding(executionId: string): AcceptedExecutionBinding | null {
    const binding = this.bindings.get(executionId)
    if (binding === undefined) throw new DomainError('PLACEMENT_PREPARATION_REQUIRED', 'No prepared execution host binding is available.', 409)
    return binding
  }
}

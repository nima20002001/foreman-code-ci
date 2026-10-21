import { isAtomicApprovalCheckpointSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { repeatStartPublication } from '../run-graph/repeatStartPublication.js'
import { assertApprovalCheckpointRegistration } from './approvalCheckpointRegistration.js'
import type { CurrentRunProductionBinding, CurrentRunProductionContext, CurrentRunProductionFactory, CurrentStopContext } from './currentProduction.js'
import { stopCurrentWorkflow } from './workflowStopAdmission.js'

const bindings = new WeakMap<CurrentRunProductionBinding, CurrentRunProductionContext>()
export function isCurrentNativeProductionBinding(value: CurrentRunProductionBinding, context: CurrentRunProductionContext): boolean {
  return bindings.get(value) === context
}

/** Assemble only over the ACTUAL objects installed by production.ts. These
 * assertions inspect their constructor-held ports and exact object identities;
 * a baseline publisher, request flag, environment toggle or shape-only object
 * cannot open admission. Live provider/PG qualification remains a separate gate. */
export function createCurrentNativeProductionFactory(options: {
  isRuntimeOpen(): boolean
  reportDispatchFailure(runId: string, code: string, error: unknown): void
}): CurrentRunProductionFactory {
  return (context: CurrentRunProductionContext): CurrentRunProductionBinding => {
    context.runs.assertCurrentProduction(context.primaryPool, context.workflows, context.locations)
    context.engine.assertCurrentProduction(context.runs, context.workflows, context.nativeExecutions, context.checkpointer)
    context.nativeExecutions.assertCurrentProduction(context.runs)
    assertApprovalCheckpointRegistration(context.interactions, context.engine)
    if (!isAtomicApprovalCheckpointSaver(context.checkpointer)) throw new DomainError(
      'CURRENT_CHECKPOINT_COMPOSITION_REQUIRED', 'Use the actual atomic production approval checkpointer.', 503)
    const assertOpen = () => {
      if (!options.isRuntimeOpen() || !context.engine.acceptsCurrentWork()) throw new DomainError(
        'CURRENT_RUNTIME_UNAVAILABLE', 'The assembled native runtime has not acquired ownership or is shutting down.', 503)
    }
    const binding: CurrentRunProductionBinding = Object.freeze({
      startPublication: repeatStartPublication,
      availability: () => {
        const available = options.isRuntimeOpen() && context.engine.acceptsCurrentWork()
        return { runtimeAdmission: available, stopAvailable: available }
      },
      assertStartReady: assertOpen,
      assertStopReady: assertOpen,
      stop: async (stopContext: CurrentStopContext) => {
        assertOpen()
        return stopCurrentWorkflow(context.primaryPool, context.runs, context.engine, stopContext)
      },
      // A queued/running Run and its accepted facts remain intact. The existing
      // engine reconciler retries eligible work; this sink cannot terminalize it.
      reportDispatchFailure: (runId: string, error: unknown) => options.reportDispatchFailure(runId,
        error instanceof DomainError ? error.code : 'WORKFLOW_DISPATCH_UNCERTAIN',
        nativePersistenceRedactor([]).error(error)),
    })
    bindings.set(binding, context)
    return binding
  }
}

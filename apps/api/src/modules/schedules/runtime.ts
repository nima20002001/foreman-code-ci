import type pg from 'pg'
import type { CurrentRunProductionBinding } from '../runs/currentProduction.js'
import type { LangGraphWorkflowEngine } from '../runs/engine.js'
import { admitRepeatRun } from '../runs/repeatStartAdmission.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { WorkflowScheduleDispatcher } from './dispatcher.js'
import { PostgresScheduleDispatcher } from './postgresDispatcher.js'
import type { ScheduleDispatchErrorReporter } from './dispatchErrors.js'

/** API-process composition. Uses exactly the same durable Start as manual
 * HTTP/MCP, and the same concrete canonical publisher and engine entry. */
export function createScheduleDispatcher(pool: pg.Pool, locations: WorkspaceLocationService,
  production: CurrentRunProductionBinding, engine: LangGraphWorkflowEngine,
  reportError: ScheduleDispatchErrorReporter, clock: () => Date = () => new Date()) {
  const port = new PostgresScheduleDispatcher(pool, async (principal, input, schedule) => {
    production.assertStartReady()
    const result = await admitRepeatRun(pool, locations, principal, 'schedule', input, {
      ...production.startPublication,
      initializeLocked: (...args) => {
        production.assertStartReady()
        return production.startPublication.initializeLocked(...args)
      },
    }, { schedule })
    if (!result.replayed) setImmediate(() => {
      void engine.start(result.value.id).catch((error: unknown) => production.reportDispatchFailure(result.value.id, error))
    })
    // Unknown COMMIT never gets here. Existing engine reconciliation owns a
    // committed queued Run after process loss, not an unacknowledged new Start.
  }, clock)
  return new WorkflowScheduleDispatcher(port, {
    clock, reportError, isReady: () => production.availability().runtimeAdmission,
  })
}

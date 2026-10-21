import type { ExecutionResult } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** A handoff failure is retained while its siblings finish their own work. */
export class WorkExecutionFailure extends DomainError {
  constructor(readonly result: ExecutionResult, readonly pendingExecutionId?: string) {
    super('WORK_SELECTED_EXECUTION_FAILED', 'A handed-off execution failed.', 409)
  }
}

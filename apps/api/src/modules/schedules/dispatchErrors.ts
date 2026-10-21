import { DomainError } from '../errors.js'
import { RunGraphError } from '../run-graph/errors.js'
import { DeviceAccessError } from '../devices/access.js'

const deviceAccessCodes = new Map<DeviceAccessError['code'], string>([
  ['unauthorized', 'DEVICE_ACCESS_UNAUTHORIZED'],
  ['revoked', 'DEVICE_ACCESS_REVOKED'],
  ['expired', 'DEVICE_ACCESS_EXPIRED'],
  ['conflict', 'DEVICE_ACCESS_CONFLICT'],
  ['forbidden', 'DEVICE_ACCESS_FORBIDDEN'],
  ['wrong_main', 'DEVICE_ACCESS_WRONG_MAIN'],
])

export interface ScheduleDispatchContext {
  workspaceId: string
  workflowId: string
  dueAt: string | null
}
export type ScheduleDispatchErrorReporter = (error: unknown, context?: ScheduleDispatchContext) => void

/** Only application classifications and known transport/SQLSTATE codes cross
 * the logging boundary. Native messages, SQL details and stacks stay private. */
export function scheduleDispatchLog(error: unknown, context?: ScheduleDispatchContext) {
  let code = 'INTERNAL_ERROR'
  let cause = 'unexpected_error'
  if (error instanceof DeviceAccessError) {
    const diagnostic = deviceAccessCodes.get(error.code)
    if (diagnostic) {
      code = diagnostic
      cause = 'application_error'
    }
  } else if (error instanceof DomainError || error instanceof RunGraphError) {
    if (/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) {
      code = error.code
      cause = 'application_error'
    }
  } else if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND'].includes(error.code)) {
      code = error.code
      cause = 'connection_error'
    } else if (/^(?:[0-9]{2}|0[A-Z]|P0|XX)[A-Z0-9]{3}$/.test(error.code)) {
      code = error.code
      cause = 'database_error'
    }
  }
  return { code, cause, phase: context ? 'workflow' : 'scan', ...(context ?? {}) }
}

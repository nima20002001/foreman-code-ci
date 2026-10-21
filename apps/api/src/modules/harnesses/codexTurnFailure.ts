import type { ExecutionResult } from '@foreman-code/contracts'
import { isCodexCapacityError } from './codexCapacity.js'
import { isObject, text } from './codexStdioTransport.js'

function isTransientTurnError(error: unknown): boolean {
  if (!isObject(error)) return false
  if (isCodexCapacityError(error) || error.codexErrorInfo === 'internalServerError') return true
  const info = error.codexErrorInfo
  if (!isObject(info)) return false
  return ['httpConnectionFailed', 'responseStreamConnectionFailed',
    'responseStreamDisconnected', 'responseTooManyFailedAttempts'].some(kind => {
    const detail = info[kind]
    if (!isObject(detail)) return false
    const status = detail.httpStatusCode
    return status == null || status === 408 || status === 429
      || typeof status === 'number' && status >= 500
  })
}

export function codexTurnFailure(error: unknown): ExecutionResult {
  return { outcome: 'failed', error: {
    code: 'CODEX_TURN_FAILED',
    message: text(isObject(error) ? error.message : undefined) ?? 'Codex turn failed.',
    retryable: isTransientTurnError(error),
  } }
}

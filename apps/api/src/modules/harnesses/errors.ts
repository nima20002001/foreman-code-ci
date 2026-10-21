import { errorMessage } from '../../shared/errorMessage.js'
import { isTransientExecutionCode } from '../../shared/executionFailureCodes.js'
import type { ExecutionResult } from '@foreman-code/contracts'

export function isDefiniteCompactionRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return 'certainty' in error && error.certainty === 'definite'
    || 'deliveryState' in error && error.deliveryState === 'not-delivered'
    || 'method' in error && error.method === 'thread/compact/start'
      && 'uncertain' in error && error.uncertain === false
}

export class HarnessExecutionError extends Error {
  readonly result: ExecutionResult

  constructor(code: string, message: string, retryable = isTransientExecutionCode(code), options?: ErrorOptions) {
    super(message, options)
    this.name = 'HarnessExecutionError'
    this.result = { outcome: 'failed', error: { code, message, retryable } }
  }
}

/** Evidence from the native write boundary, scoped to the operation that failed. */
export class NativeDeliveryError extends HarnessExecutionError {
  constructor(
    readonly operation: 'session_creation' | 'turn_submission',
    readonly delivery: 'not_sent' | 'unknown',
    cause: unknown,
    readonly cleanup: 'confirmed' | 'pending' = 'confirmed',
  ) {
    const result = cause instanceof HarnessExecutionError ? cause.result : undefined
    const code = result?.error?.code ?? (cause && typeof cause === 'object' && 'code' in cause
      && typeof cause.code === 'string' ? cause.code : 'NATIVE_OPERATION_FAILED')
    const message = errorMessage(cause, 'The native operation failed.')
    super(code, message, result?.error?.retryable ?? true, { cause })
    this.name = 'NativeDeliveryError'
  }
}

/** Definite provider refusal: the addressed turn is not the active turn. No input was accepted. */
export class NativeTurnNotActiveError extends HarnessExecutionError {
  constructor(message = 'The addressed native turn is no longer active.', options?: ErrorOptions) {
    super('NATIVE_TURN_NOT_ACTIVE', message, undefined, options)
    this.name = 'NativeTurnNotActiveError'
  }
}

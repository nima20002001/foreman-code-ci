import { DomainError } from '../../src/modules/errors.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { nativePersistenceRedactor } from '../../src/modules/interactions/nativePersistence.js'

export interface NativeFailureDetail {
  name: string
  code?: string
  message: string
  causes?: NativeFailureDetail[]
}

/** Emit the failed operation's bounded state before disposable artifacts are removed. */
export function nativeFailureSummary(evidence: Record<string, unknown>, secrets: readonly string[]): string {
  const fields = ['scenario', 'error', 'startError', 'cleanupError', 'startTaskState', 'mcpInspectionErrors',
    'failureExecutions', 'failureNativeHistories', 'nativeObservationErrors', 'failureInteractions',
    'checks', 'failureReason']
  const selected = Object.fromEntries(fields.filter(name => evidence[name] !== undefined)
    .map(name => [name, evidence[name]]))
  const privateField = /^(?:environment|variables|headers|authorization|cookie|set-cookie|token|password|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|input|output|body|responseBody)$/i
  return JSON.stringify(nativePersistenceRedactor(secrets).value(selected), (key, value: unknown) => {
    if (privateField.test(key)) return undefined
    if (typeof value === 'string') return value.slice(0, 2_048)
    if (Array.isArray(value)) return value.slice(0, 16)
    return value
  }).slice(0, 32_768)
}

export function describeNativeFailure(error: unknown, secrets: readonly string[], depth = 0): NativeFailureDetail {
  const redactor = nativePersistenceRedactor(secrets)
  const detail: NativeFailureDetail = {
    name: error instanceof Error ? redactor.text(error.name).slice(0, 256) : typeof error,
    message: 'Native operation failed without an Error object.',
  }
  if (error instanceof Error) detail.message = redactor.text(error.message).slice(0, 2048)
  if (error instanceof DomainError) detail.code = redactor.text(error.code)
  else if (error instanceof HarnessExecutionError && error.result.error) {
    detail.code = redactor.text(error.result.error.code)
  } else if (error instanceof Error && 'code' in error
    && (typeof error.code === 'string' || typeof error.code === 'number')) {
    detail.code = redactor.text(String(error.code))
  }
  if (depth >= 3) return detail
  const causes: unknown[] = []
  if (error instanceof AggregateError) causes.push(...error.errors.slice(0, 8))
  if (error instanceof Error && error.cause !== undefined && !causes.includes(error.cause)) {
    causes.push(error.cause)
  }
  if (causes.length) detail.causes = causes.slice(0, 8)
    .map(cause => describeNativeFailure(cause, secrets, depth + 1))
  return detail
}

import type { LogComponent } from './logComponent.js'
import { componentLogger } from './logger.js'

const codeOf = (error: unknown) => {
  const failure = error as { code?: unknown; result?: { error?: { code?: unknown } } } | null
  return failure?.code ?? failure?.result?.error?.code
}

/** Missing optional files are ordinary absence; unreadable files are failures. */
export function fallbackOnMissing<T>(fallback: T): (error: unknown) => T {
  return error => {
    if (codeOf(error) === 'ENOENT') return fallback
    throw error
  }
}

/** Independent cleanup must retain its failures without replacing a caller's outcome. */
export async function settleObserved(component: LogComponent, operation: string,
  tasks: readonly Promise<unknown>[]): Promise<PromiseSettledResult<unknown>[]> {
  const results = await Promise.allSettled(tasks)
  for (const result of results) {
    if (result.status === 'rejected') logIgnoredError(component, operation, result.reason)
  }
  return results
}

/** Log best-effort failures while preserving the caller's outcome; narrow expected races by error code. */
export function logIgnoredError(
  component: LogComponent,
  operation: string,
  error: unknown,
  context: Record<string, unknown> = {},
  expected: readonly string[] = [],
): void {
  const code = codeOf(error)
  if (typeof code === 'string' && expected.includes(code)) return
  componentLogger(component).warn({ operation, ...context, err: error }, `Ignored failure of ${operation}`)
}

/** A `.catch` handler that logs through `logIgnoredError` and resolves to `fallback`. */
export function fallbackOnError<T>(
  fallback: T,
  component: LogComponent,
  operation: string,
  context: Record<string, unknown> = {},
  expected: readonly string[] = [],
): (error: unknown) => T {
  return (error) => {
    logIgnoredError(component, operation, error, context, expected)
    return fallback
  }
}

/** A `.catch` handler that logs through `logIgnoredError` and resolves to undefined. */
export function ignoreError(
  component: LogComponent,
  operation: string,
  context: Record<string, unknown> = {},
  expected: readonly string[] = [],
): (error: unknown) => undefined {
  return fallbackOnError(undefined, component, operation, context, expected)
}

import { z } from 'zod'

/** Whether trying again can help: `transient` can, `permanent` cannot, `cancelled` was asked to stop. */
export const FailureClassSchema = z.enum(['transient', 'permanent', 'cancelled'])
export type FailureClass = z.infer<typeof FailureClassSchema>

/** The one failure shape every boundary (device channel, relay, MCP and HTTP replies, execution retries) keeps.
 * Its cause chain is the error's own `cause`, which `failureClass` walks. */
export interface Failure {
  code: string
  class: FailureClass
}

const retryableClass = (value: unknown): FailureClass | undefined =>
  typeof value === 'boolean' ? value ? 'transient' : 'permanent' : undefined

/** The class one error states about itself: `class`, or the older `retryable` flags on the error, its execution
 * result or its details. Undefined when it states none, so a code table may decide. */
export function explicitFailureClass(error: unknown): FailureClass | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const stated = error as {
    class?: unknown; retryable?: unknown; result?: { error?: { retryable?: unknown } }; details?: { retryable?: unknown }
  }
  const parsed = FailureClassSchema.safeParse(stated.class)
  if (parsed.success) return parsed.data
  return retryableClass(stated.retryable) ?? retryableClass(stated.result?.error?.retryable)
    ?? retryableClass(stated.details?.retryable)
}

/** Walks the cause chain once. At each link an explicit class wins over `byLink` (a code table); the first decision
 * ends the walk, and `last` decides when no link did. A cycle is permanent. */
export function failureClass(
  error: unknown,
  byLink: (link: object) => FailureClass | undefined,
  last: (link: unknown) => FailureClass = () => 'permanent',
): FailureClass {
  const seen = new Set<object>()
  while (typeof error === 'object' && error !== null) {
    if (seen.has(error)) return 'permanent'
    seen.add(error)
    const decided = explicitFailureClass(error) ?? byLink(error)
    if (decided) return decided
    const cause = (error as { cause?: unknown }).cause
    if (typeof cause !== 'object' || cause === null) break
    error = cause
  }
  return last(error)
}

/* Pure database and socket error predicates; the API retry policy and the Worker's device replies share them. */

export function isDatabaseTimeout(error: unknown): boolean {
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    // 57014 also covers explicit cancellation; only a statement timeout is transient.
    if (code === '57014') return error instanceof Error && /time(d)? ?out/i.test(error.message)
    if (code === 'DATABASE_READ_TIMEOUT') return true
    if (code !== undefined && code !== 'GRAPH_TRANSACTION_FAILED') return false
    if (error instanceof Error && error.message === 'Query read timeout') return true
    if (error instanceof Error && error.message === 'Connection terminated due to connection timeout') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

export function isDatabasePoolTimeout(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'timeout exceeded when trying to connect'
    || error.message === 'Connection terminated due to connection timeout'
  )
}

const transientConnectionCodes = new Set([
  '55P03', '40001', '40P01', '57P01', '57P02', '57P03', '53300', 'DATABASE_RETRY_DEADLINE_EXCEEDED',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
])

export function isTransientDatabaseOrSocketCode(code: string): boolean {
  return transientConnectionCodes.has(code) || /^08[A-Z0-9]{3}$/.test(code)
}

/** A database or socket failure in the cause chain, unless a nearer link states its own class. */
export function isTransientDatabaseOrSocketError(error: unknown): boolean {
  return failureClass(error, link => {
    if (isDatabaseTimeout(link) || isDatabasePoolTimeout(link)) return 'transient'
    const code = 'code' in link ? link.code : undefined
    if (typeof code === 'string' && isTransientDatabaseOrSocketCode(code)) return 'transient'
    if (link instanceof Error && link.message === 'Connection terminated unexpectedly') return 'transient'
    return undefined
  }) === 'transient'
}

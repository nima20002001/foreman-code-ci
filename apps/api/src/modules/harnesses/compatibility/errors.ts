import type { HarnessCompatibility } from '@foreman-code/contracts'

export class CompatibilityCheckError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options); this.name = 'CompatibilityCheckError' }
}
/** Never expose CLI stderr, config contents, credentials, or filesystem paths. */
export function compatibilityReason(error: unknown, aborted = false): NonNullable<HarnessCompatibility['reason']> {
  if (error instanceof CompatibilityCheckError && error.code === 'CLI_CLEANUP_FAILED') return { code: error.code, message: error.message }
  if (aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) return { code: 'CHECK_TIMEOUT', message: 'The local check exceeded its time limit or was stopped. Retry when the CLI is available.' }
  if (error instanceof CompatibilityCheckError) return { code: error.code, message: error.message }
  return { code: 'CHECK_FAILED', message: 'The local protocol/settings check could not finish. Review the configured CLI installation and retry.' }
}

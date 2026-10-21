import { ZodError } from 'zod'
import { componentLogger } from '../../diagnostics/logger.js'

const log = componentLogger('harness')
function errorIdentity(error: unknown) {
  const value = error && typeof error === 'object' ? error as { code?: unknown; constructor?: { name?: unknown } } : undefined
  const safe = (part: unknown) => typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(part) ? part : undefined
  const code = safe(value?.code), className = safe(value?.constructor?.name)
  const validation = error instanceof ZodError ? error.issues.slice(0, 8).map(issue => ({
    code: issue.code,
    path: issue.path.slice(0, 8).filter(part => typeof part === 'number' || safe(part)),
  })) : undefined
  return { ...(code ? { code } : {}), ...(className ? { class: className } : {}),
    ...(validation ? { validation } : {}) }
}
export function warnCodexFileError(error: unknown): void {
  log.warn(errorIdentity(error), 'Codex file operation failed')
}

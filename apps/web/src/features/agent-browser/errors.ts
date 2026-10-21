import { SessionChangedError } from '../../shared/api/sessionBoundary'

export function browserAccessDenied(error: unknown): boolean {
  if (error instanceof SessionChangedError) return true
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; code?: string }
  return value.status === 401 || value.status === 403 || value.statusCode === 401 || value.statusCode === 403
    || ['UNAUTHORIZED', 'FORBIDDEN', 'SCOPE_DENIED', 'BROWSER_ACCESS_DENIED', 'INSTALLATION_MISMATCH', 'INSTALLATION_CHANGED'].includes(value.code ?? '')
}

export function browserErrorMessage(error: unknown): string {
  if (browserAccessDenied(error)) return 'Browser access is unavailable.'
  return error instanceof Error ? error.message : 'The browser request could not be confirmed.'
}

/** Canonical HTTP adapters preserve status/known-rejection evidence; transport loss is uncertain. */
export function browserRequestUncertain(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true
  const value = error as { status?: number; statusCode?: number; outcome?: string; details?: { outcome?: string } }
  const status = value.status ?? value.statusCode
  return (value.outcome ?? value.details?.outcome) !== 'rejected' && !(status && status >= 400 && status < 500)
}


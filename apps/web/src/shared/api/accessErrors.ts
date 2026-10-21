/** Authentication/authorization failures must not reuse protected cached UI. */
export function isAccessFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('status' in error && (error.status === 401 || error.status === 403)) return true
  if ('statusCode' in error && (error.statusCode === 401 || error.statusCode === 403)) return true
  return 'code' in error && ['ACCESS_DENIED', 'UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTHENTICATION_REQUIRED'].includes(String(error.code))
}

export const WORKER_CREDENTIAL_EXPIRY_MARGIN_MS = 30_000

export interface CredentialLifetime {
  expiresAt: string
  /** Local monotonic deadline, derived from a database reply and never persisted. */
  renewalDeadline?: number
}

export function remainingCredentialLifetime(credential: CredentialLifetime | undefined): number {
  if (!credential) return NaN
  if (credential.renewalDeadline !== undefined) return credential.renewalDeadline - performance.now()
  return Date.parse(credential.expiresAt) - Date.now()
}

export function databaseCredentialDeadline(expiresAt: Date, databaseNow: Date, requestedAt: number): number {
  // Charging the whole round trip against the returned lifetime is conservative.
  return requestedAt + expiresAt.getTime() - databaseNow.getTime()
}

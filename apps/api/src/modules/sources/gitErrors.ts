import { SourceError } from './manifest.js'
import { DomainError } from '../errors.js'

export function gitFailure(code: 'SOURCE_WORKTREE_FAILED' | 'SOURCE_SNAPSHOT_FAILED', operation: string | undefined) {
  // Credential helpers can write arbitrary secrets to stderr; disclose only the operation.
  return new SourceError(code,
    `git ${operation ?? 'operation'} failed. Check repository access and local Git configuration, then retry.`)
}

/** Git stderr is inspected locally but never included in replies: credential helpers may print secrets. */
export function gitAcquisitionFailure(operation: string, stderr: string) {
  const authentication = /fatal: Authentication failed|remote: Invalid username or (?:password|token)|could not read (?:Username|Password) for /iu
  if (authentication.test(stderr)) {
    return new SourceError('COMPUTER_GITHUB_REQUIRED',
      'Sign in to GitHub on this computer (computer_github_login_start), then retry.')
  }
  let reason = `GitHub git ${operation} failed. Check repository access and local Git configuration, then retry.`
  if (/Could not resolve (?:host|proxy)/iu.test(stderr)) {
    reason = `GitHub git ${operation} failed because the DNS lookup failed. Check the network, then retry.`
  } else if (/Connection reset|Failed to connect|Connection timed out|Recv failure|Send failure/iu.test(stderr)) {
    reason = `GitHub git ${operation} failed because the connection failed. Check the network, then retry.`
  } else if (/returned error: 5\d\d|remote: (?:Internal Server Error|Service Unavailable|Bad Gateway)/iu.test(stderr)) {
    reason = `GitHub git ${operation} failed because GitHub is temporarily unavailable. Retry shortly.`
  }
  return new DomainError('SOURCE_GITHUB_UNAVAILABLE', reason, 503, { retryable: true, newCommandRequired: false })
}

import { createHash } from 'node:crypto'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { DomainError } from '../errors.js'
import type { BrowserSnapshotIdentity } from './types.js'

export function browserInputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function sameBrowserSnapshot(left: BrowserSnapshotIdentity | null, right: BrowserSnapshotIdentity | null): boolean {
  return left !== null && right !== null && left.profileId === right.profileId
    && left.publishedRevision === right.publishedRevision && left.sha256 === right.sha256 && left.format === right.format
}

export function browserOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new DomainError('INVALID_ORIGIN', 'Enter an HTTP or HTTPS origin.', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new DomainError('INVALID_ORIGIN', 'Enter an HTTP or HTTPS origin without credentials.', 400)
  }
  return url.origin
}

export function browserPageLimit(value = 50): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new DomainError('INVALID_PAGE', 'Page size must be between 1 and 100.', 400)
  }
  return value
}

export function browserPageCursor(scope: string, after: string): string {
  return Buffer.from(JSON.stringify({ scope, after })).toString('base64url')
}

export function readBrowserCursor(cursor: string | undefined, scope: string): string | undefined {
  if (!cursor) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value === 'object' && value && 'scope' in value && value.scope === scope
      && 'after' in value && typeof value.after === 'string' && value.after.length <= 200) return value.after
  } catch { /* ignore: malformed opaque cursors are reported as a validation error below. */ }
  throw new DomainError('INVALID_CURSOR', 'This page cursor does not match the requested resource.', 400)
}

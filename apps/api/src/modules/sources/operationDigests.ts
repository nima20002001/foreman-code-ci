/** Worker-safe counterpart of the existing Main command canonical digest. */
import { createHash } from 'node:crypto'
import { canonicalJsonLocaleOrderLegacy } from '@foreman-code/contracts/canonical-json'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { MaterializationAttempt } from './ports.js'
export function sourceOperationSelectionHash(root: SourceRootRecord, attempt: MaterializationAttempt, operationId: string): string {
  return createHash('sha256').update(canonicalJsonLocaleOrderLegacy({ version: 1, source: root.source, root: { selection: root.selection,
    binding: root.binding, registration: root.registration, attestationId: root.attestationId, attestationDigest: root.attestationDigest },
  executionId: attempt.executionId, attemptId: attempt.attemptId, operationId, keyRevision: attempt.keyRevision, authorizationRevision: attempt.authorizationRevision })).digest('hex')
}

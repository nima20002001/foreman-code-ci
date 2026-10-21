import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { MaterializationAttempt } from './ports.js'

/** Known before filesystem preparation. Final W08/job dispatch digest additionally
 * covers the actual materialization/private directory and is adopted separately.
 * Keeping these digests distinct avoids a self-referential receipt hash.
 */
export function sourceBindingHash(root: SourceRootRecord,
  attempt: Pick<MaterializationAttempt, 'executionId' | 'attemptId' | 'keyRevision' | 'authorizationRevision'>,
  operationId: string): string {
  return commandInputHash({ version: 1, source: root.source, root: { selection: root.selection,
    binding: root.binding, registration: root.registration, attestationId: root.attestationId, attestationDigest: root.attestationDigest },
  executionId: attempt.executionId, attemptId: attempt.attemptId, operationId,
  keyRevision: attempt.keyRevision, authorizationRevision: attempt.authorizationRevision }).slice('sha256:'.length)
}

/** Stable preparation fact digest; final dispatch adoption cannot make the final
 * spec hash self-referential or rewrite the original materialization identity. */
export function sourceMaterializationDigest(record: SourceMaterializationRecord): string {
  return commandInputHash({ receipt: record.receipt, sourceBindingHash: record.sourceBindingHash,
    rootPolicyId: record.rootPolicyId, rootPolicyRevision: record.rootPolicyRevision,
    operationId: record.operationId, reservationId: record.reservationId }).slice('sha256:'.length)
}

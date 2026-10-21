import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open, unlink, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { MaterializationReceiptSchema, RootBindingSchema, SourceProjectQuotaSlotSchema, type RootBinding }
  from '@foreman-code/contracts/source-materialization'
import type { JobVerificationQuotaPool } from '@foreman-code/contracts/job-verification-runtime'
import { anchored } from './privateFilesystem.js'
import { SourceError } from './manifest.js'
import type { MaterializationAttempt } from './ports.js'

const QualificationQuotaClaimSchema = z.object({ kind: z.literal('qualification'),
  qualificationId: z.uuid(), operationId: z.uuid() }).strict()
const SourceQuotaClaimSchema = z.object({
  version: z.literal(1), materializationId: z.uuid(), binding: RootBindingSchema,
  quota: SourceProjectQuotaSlotSchema,
  attempt: z.object({ placementHash: MaterializationReceiptSchema.shape.placementHash,
    executionId: MaterializationReceiptSchema.shape.executionId, attemptId: MaterializationReceiptSchema.shape.attemptId,
    keyRevision: MaterializationReceiptSchema.shape.keyRevision,
    authorizationRevision: MaterializationReceiptSchema.shape.authorizationRevision }).strict(),
}).strict()
/** Quota Jobs own one claim per attempt. New workflow executions own separate
 * claims; old exclusive-write receipts retain their original cleanup path. */
export function sourceMaterializationClaimName(binding: RootBinding,
  attempt: Pick<MaterializationAttempt, 'executionId' | 'attemptId'>, quota?: unknown, scope?: 'execution'): string {
  if (quota) {
    const owner = createHash('sha256').update(JSON.stringify([attempt.executionId, attempt.attemptId])).digest('hex')
    return `binding-${binding.rootId}-${owner}.lock`
  }
  if (!scope && binding.accessMode === 'exclusive-write') return `binding-${binding.rootId}.lock`
  return `binding-${binding.rootId}-${createHash('sha256').update(attempt.executionId).digest('hex')}.lock`
}

/** An interrupted exclusive write removes only its own incomplete record. */
export async function writeSourceClaim(root: FileHandle, name: string, bytes: string | Buffer,
  signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const file = await open(anchored(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600)
  let durable = false
  try {
    signal?.throwIfAborted()
    await file.writeFile(bytes, signal ? { signal } : undefined)
    signal?.throwIfAborted()
    await file.sync()
    durable = true
    signal?.throwIfAborted()
    await root.sync()
    signal?.throwIfAborted()
  } catch (error) {
    if (!durable) {
      await unlink(anchored(root, name))
      await root.sync()
    }
    throw error
  } finally { await file.close() }
}
/** The namespace lock is held by the caller. A quota claim can outlive a crash before the attempt claim was written. */
export async function restoreQuotaMaterializationClaim(root: FileHandle, binding: RootBinding,
  attempt: MaterializationAttempt, pool: JobVerificationQuotaPool, signal?: AbortSignal): Promise<void> {
  for (const slot of pool.slots) {
    signal?.throwIfAborted()
    let file: FileHandle
    try { file = await open(anchored(root, `quota-${slot.namespace}.claim.json`), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    let bytes: Buffer
    try {
      signal?.throwIfAborted()
      const stat = await file.stat()
      signal?.throwIfAborted()
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) {
        throw new SourceError('SOURCE_CLAIM_INVALID', 'Quota owner record is invalid.')
      }
      bytes = await file.readFile(signal ? { signal } : undefined)
      signal?.throwIfAborted()
    } finally { await file.close() }
    const owner = z.union([SourceQuotaClaimSchema, QualificationQuotaClaimSchema]).parse(JSON.parse(bytes.toString('utf8')))
    if ('kind' in owner) continue
    if (!isDeepStrictEqual(owner.binding, binding) || !isDeepStrictEqual(owner.attempt, attempt)) continue
    if (!isDeepStrictEqual(owner.quota, slot)) throw new SourceError('SOURCE_CLAIM_CONFLICT', 'Quota configuration changed.')
    signal?.throwIfAborted()
    const name = sourceMaterializationClaimName(binding, attempt, pool)
    try { await writeSourceClaim(root, name, bytes, signal) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return
  }
}

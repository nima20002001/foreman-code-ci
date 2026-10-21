import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { JobVerificationQuotaPoolSchema, type JobVerificationQuotaPool }
  from '@foreman-code/contracts/job-verification-runtime'
import { RootBindingSchema, type RootBinding, type SourceProjectQuotaSlot }
  from '@foreman-code/contracts/source-materialization'
import { DomainError } from '../errors.js'
import { MAX_VERIFICATION_CONFIGURATION_BYTES } from './installedVerificationConfiguration.js'
import { type InstalledRuntimeConfigurationLocation } from './installedRuntimeConfiguration.js'
import { findRetainedRuntimeConfiguration } from './retainedRuntimeConfiguration.js'

export const JobProjectQuotaReadbackSchema = z.object({
  filesystemUuid: z.uuid().optional(),
  volumeCapacityBytes: z.number().int().positive(), volumeCapacityInodes: z.number().int().positive(),
  projectId: z.number().int().positive(), inheritance: z.literal(true),
  hardLimitBytes: z.number().int().positive(), hardInodes: z.number().int().positive(),
  usedBytes: z.number().int().nonnegative(), usedInodes: z.number().int().nonnegative(),
  accountingEnabled: z.literal(true), filesystem: RootBindingSchema.shape.filesystem,
}).strict()
export type JobProjectQuotaReadback = z.infer<typeof JobProjectQuotaReadbackSchema>
export type JobQuotaReader = (pool: JobVerificationQuotaPool, directory: string,
  signal: AbortSignal) => Promise<JobProjectQuotaReadback>

export function isKernelQuotaDenial(errno: unknown): boolean {
  return errno === -constants.errno.EDQUOT!
}

export const readJobProjectQuota: JobQuotaReader = async (pool, directory, signal) => {
  signal.throwIfAborted()
  const hash = createHash('sha256').update(await readFile(pool.queryExecutable)).digest('hex')
  if (hash !== pool.queryBinarySha256) throw new DomainError('JOB_QUOTA_CHANGED', 'Quota observer binary changed.', 409)
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(pool.queryExecutable, [directory, pool.blockDevice], {
      env: {}, stdio: ['ignore', 'pipe', 'pipe'], signal,
    })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16384) child.kill('SIGKILL')
      else chunks.push(chunk)
    })
    child.stderr.resume()
    let failure: Error | undefined
    child.once('error', error => { failure = error })
    child.once('close', code => {
      if (failure) reject(failure)
      else if (code !== 0 || size > 16384) reject(new DomainError('JOB_QUOTA_UNAVAILABLE', 'Kernel quota readback failed.', 409))
      else resolve(Buffer.concat(chunks))
    })
  })
  signal.throwIfAborted()
  return JobProjectQuotaReadbackSchema.parse(JSON.parse(bytes.toString('utf8')))
}

export async function verifyJobQuotaOwnership(input: {
  pool: JobVerificationQuotaPool; binding: RootBinding; slot: SourceProjectQuotaSlot;
  directory?: string; signal: AbortSignal; read?: JobQuotaReader;
}): Promise<JobProjectQuotaReadback> {
  const slot = input.pool.slots.find(value => value.namespace === input.slot.namespace)
  if (!slot || !isDeepStrictEqual(slot, input.slot)) {
    throw new DomainError('JOB_QUOTA_CONFLICT', 'The Job quota belongs to another installation.', 409)
  }
  const directory = input.directory ?? join(input.binding.canonicalPath, slot.namespace)
  const observed = await (input.read ?? readJobProjectQuota)(input.pool, directory, input.signal)
  if (observed.projectId !== slot.projectId || observed.hardLimitBytes !== slot.hardLimitBytes
    || observed.hardInodes !== slot.hardInodes
    || (!input.directory && !isDeepStrictEqual(observed.filesystem, slot.filesystem))
    || observed.filesystem.device !== input.binding.filesystem.device
    || observed.filesystem.mountId !== input.binding.filesystem.mountId
    || (input.pool.filesystemUuid && observed.filesystemUuid !== input.pool.filesystemUuid)
    || observed.volumeCapacityInodes !== input.pool.volumeCapacityInodes
    || input.pool.slots.reduce((sum, item) => sum + item.hardLimitBytes, 0) > observed.volumeCapacityBytes
    || input.pool.slots.reduce((sum, item) => sum + item.hardInodes, 0) > observed.volumeCapacityInodes
    || observed.usedBytes > observed.hardLimitBytes || observed.usedInodes > observed.hardInodes) {
    throw new DomainError('JOB_QUOTA_CHANGED', 'Kernel quota ownership or limits changed.', 409)
  }
  return observed
}

export async function readVerificationQuotaPool(pool: JobVerificationQuotaPool, binding: RootBinding,
  signal: AbortSignal, read?: JobQuotaReader): Promise<JobProjectQuotaReadback[]> {
  const observations: JobProjectQuotaReadback[] = []
  for (const slot of pool.slots) {
    observations.push(await verifyJobQuotaOwnership({ pool, binding, slot, signal,
      ...(read ? { read } : {}) }))
  }
  return observations
}

const SourceQuotaConfigurationSchema = z.object({
  schemaVersion: z.number().int(), root: z.object({ binding: RootBindingSchema }).passthrough(),
  descriptor: z.object({ quotaPool: JobVerificationQuotaPoolSchema.optional() }).passthrough().optional(),
}).passthrough()
export async function installedSourceQuotaPool(configuration: InstalledRuntimeConfigurationLocation | null,
  binding: RootBinding,
): Promise<JobVerificationQuotaPool | null> {
  if (!configuration) return null
  const installed = await findRetainedRuntimeConfiguration(configuration, SourceQuotaConfigurationSchema, candidate => {
    // Quota slots belong to the installed physical root across source snapshots.
    const expected = { ...binding,
      bindingRevision: candidate.root.binding.bindingRevision,
      snapshotId: candidate.root.binding.snapshotId,
      manifestDigest: candidate.root.binding.manifestDigest,
    }
    return candidate.schemaVersion === 2 && isDeepStrictEqual(candidate.root.binding, expected)
  }, MAX_VERIFICATION_CONFIGURATION_BYTES)
  if (!installed) return null
  if (!installed.descriptor?.quotaPool) {
    throw new DomainError('JOB_QUOTA_UNAVAILABLE', 'The verification installation has no per-Job quota pool.', 409)
  }
  return installed.descriptor.quotaPool
}

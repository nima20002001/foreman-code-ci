import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { JobRuntimeFingerprintSchema } from '@foreman-code/contracts/job-runtime'
import type { JobRuntimeNativeAdmissionRecord } from '@foreman-code/contracts/job-verification-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { InstalledVerificationRuntimeConfigurationSchema, InstalledVerificationRuntimeCaptureInputSchema }
  from './installedVerificationConfiguration.js'
import { DomainError } from '../errors.js'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().startsWith('/').refine(value => !value.includes('\0') && !value.includes('\n'))
const target = JobRuntimeFingerprintSchema.shape
/** Installer/human protected configuration, never public profile save input.
 * Pins identify an installation; none of these fields grants qualification. */
export const InstalledJobRuntimeConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.object({ hostRef: target.hostRef, registration: target.registration, mainInstallationId: target.mainInstallationId }).strict(),
  root: SourceRootRecordSchema,
  runtimeExecutable: path, ociExecutable: path, findmntExecutable: path, runtimeRoot: path, backingFile: path,
  controllerEnvironment: z.object({ PATH: z.string().min(1), XDG_RUNTIME_DIR: path, LANG: z.literal('C.UTF-8') }).strict(),
  pins: z.object({ bootId: z.uuid(), runtimeBinarySha256: digest, ociBinarySha256: digest, findmntBinarySha256: digest,
    configurationDigest: digest, imageDigest: target.imageDigest, toolchainDigest: digest, diskBytes: z.number().int().positive() }).strict(),
}).strict()
export type InstalledJobRuntimeConfiguration = z.infer<typeof InstalledJobRuntimeConfigurationSchema>
export const InstalledJobRuntimeCaptureInputSchema = InstalledJobRuntimeConfigurationSchema.omit({ pins: true }).extend({
  imageDigest: target.imageDigest, toolchainDigest: digest, diskBytes: z.number().int().positive(),
}).strict()
export type InstalledJobRuntimeCaptureInput = z.infer<typeof InstalledJobRuntimeCaptureInputSchema>
export const InstalledJobRuntimeCaptureInputRecordSchema = z.union([
  InstalledJobRuntimeCaptureInputSchema, InstalledVerificationRuntimeCaptureInputSchema,
])
export const InstalledJobRuntimeRefreshInputSchema = z.object({
  expectedConfigurationSha256: digest,
  captureInput: InstalledJobRuntimeCaptureInputRecordSchema,
}).strict()
export const InstalledJobRuntimeConfigurationRecordSchema = z.union([
  InstalledJobRuntimeConfigurationSchema, InstalledVerificationRuntimeConfigurationSchema,
])
export interface InstalledRuntimeConfigurationLocation { path: string; ownerUid: number }
function unavailable(reason: string): never { throw new DomainError('JOB_RUNTIME_INSTALLATION_UNAVAILABLE', 'The selected job runtime has no current protected installed configuration.', 409, { reason }) }
export { unavailable as installedRuntimeUnavailable }

export async function readProtectedRuntimeConfiguration<T>(
  location: InstalledRuntimeConfigurationLocation | null, schema: z.ZodType<T>, maximumBytes = 65536,
): Promise<T> {
  try { return schema.parse(JSON.parse((await readProtectedRuntimeFile(location, maximumBytes)).toString('utf8'))) }
  catch (error) { if (error instanceof DomainError) throw error; return unavailable('configuration_unavailable') }
}
export async function readProtectedRuntimeFile(
  location: InstalledRuntimeConfigurationLocation | null, maximumBytes = 65536,
): Promise<Buffer> {
  if (!location) unavailable('missing_configuration')
  if (!Number.isSafeInteger(location.ownerUid) || location.ownerUid < 0 || !location.path.startsWith('/')) unavailable('invalid_configuration_location')
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (await realpath(location.path) !== location.path) unavailable('configuration_retargeted')
    file = await open(location.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = await file.stat()
    if (!before.isFile() || before.uid !== location.ownerUid || before.mode & 0o022 || before.nlink !== 1 || before.size > maximumBytes) unavailable('configuration_not_protected')
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) unavailable('configuration_changed')
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) unavailable('configuration_changed')
    return bytes
  } catch (error) {
    if (error instanceof DomainError) throw error
    return unavailable('configuration_unavailable')
  } finally { await file?.close() }
}

/** Worker-local protected capture. Pairing and current authenticated connection
 * are supplied by the existing installed worker authority; no SQL facade. */
export type InstalledRuntimeObservedHost = Pick<JobRuntimeNativeAdmissionRecord, 'hostRef' | 'registration' | 'mainInstallationId' | 'bootId' | 'connection'>

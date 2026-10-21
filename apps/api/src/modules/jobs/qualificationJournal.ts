import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { JobRuntimeNativeAdmissionRecordSchema, JobQualificationCandidateRecordSchema, JobRuntimeQualificationResultRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'

export const QUALIFICATION_COMMAND_LIMIT = 512
export const QUALIFICATION_CLEANUP_COMMAND_LIMIT = QUALIFICATION_COMMAND_LIMIT + 16

const process = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootId: z.uuid() }).strict()
const boundary = z.object({ kind: z.literal('cgroup-v2'), path: z.string().startsWith('/sys/fs/cgroup/'),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
const subject = z.object({ kind: z.literal('qualification'), qualificationId: z.uuid(), profileId: z.string().min(1),
  profileRevision: z.number().int().positive(), operationId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const QualificationOCICertificateSchema = z.object({
  scope: z.object({ subject, admission: JobRuntimeNativeAdmissionRecordSchema, bootId: z.uuid() }).strict(),
  containerId: z.string().regex(/^[a-f0-9]{64}$/), process, boundary,
  helpers: z.array(z.object({ kind: z.enum(['conmon', 'launcher']), process, boundary: boundary.nullable() }).strict()).max(512),
  lifecycle: z.enum(['active', 'closed', 'closure-unconfirmed']),
}).strict()
export const QualificationReceiptSchema = z.object({
  admission: JobRuntimeNativeAdmissionRecordSchema, candidate: JobQualificationCandidateRecordSchema,
  result: JobRuntimeQualificationResultRecordSchema.nullable(), sequence: z.number().int().positive(),
  phase: z.enum(['received', 'native_entry_attempted', 'closed', 'uncertain']),
  finishedAt: z.string().datetime().optional(),
  quotaClaims: z.array(z.object({ path: z.string().startsWith('/'), namespace: z.string().startsWith('/'),
    device: z.number().int().nonnegative(), inode: z.number().int().positive() }).strict()).default([]),
  closedContainers: z.array(QualificationOCICertificateSchema).max(16).default([]),
  launches: z.array(z.object({ launchId: z.uuid(), binary: z.string().startsWith('/'), argv: z.array(z.string()).max(256),
    exit: z.object({ exitCode: z.number().int().min(0).max(255).nullable(), signal: z.string().nullable() }).strict().nullable(),
    closed: z.boolean() }).strict()).max(QUALIFICATION_CLEANUP_COMMAND_LIMIT + 1),
  container: z.object({ identity: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    containerId: z.string().regex(/^[a-f0-9]{64}$/).nullable(), certificate: QualificationOCICertificateSchema.nullable() }).strict().nullable(),
  creationAbsent: z.boolean().default(false),
}).strict()
export type QualificationReceipt = z.infer<typeof QualificationReceiptSchema>

export function qualificationCreationStopped(receipt: QualificationReceipt): boolean {
  const container = receipt.container
  if (!container || container.containerId || container.certificate || receipt.launches.some(value => !value.closed)) return false
  const index = receipt.launches.findLastIndex(value => value.binary === receipt.candidate.fingerprint.runtimeExecutable
    && value.argv.includes('create') && value.argv[value.argv.indexOf('--name') + 1] === container.identity)
  const create = receipt.launches[index]
  return !!create && receipt.launches.slice(index + 1).every(value => value.binary === receipt.candidate.fingerprint.runtimeExecutable
      && (isDeepStrictEqual(value.argv, ['--remote=false', 'container', 'inspect', container.identity])
        || isDeepStrictEqual(value.argv, ['--remote=false', 'container', 'exists', container.identity])))
}

export function qualificationCreationFailed(receipt: QualificationReceipt): boolean {
  const create = receipt.launches.findLast(value => value.argv.includes('create'))
  return qualificationCreationStopped(receipt) && create?.exit?.signal === null
    && create.exit.exitCode !== null && create.exit.exitCode !== 0
}

export function qualificationCleanupCommandAllowed(receipt: QualificationReceipt, binary: string, argv: string[]) {
  const container = receipt.container
  const target = container?.containerId ?? container?.identity
  if (binary !== receipt.candidate.fingerprint.runtimeExecutable || argv[0] !== '--remote=false' || !target) {
    return false
  }
  const command = argv.slice(1)
  if (!container?.containerId
    && isDeepStrictEqual(command, ['container', 'exists', target])) return true
  if (isDeepStrictEqual(command, ['container', 'inspect', target])
    || isDeepStrictEqual(command, ['stop', '--time', '1', target])
    || isDeepStrictEqual(command, ['kill', '--signal', 'KILL', target])) return true
  const containerId = container?.containerId
  if (!containerId || container.certificate?.lifecycle !== 'closed'
    || container.certificate.containerId !== containerId) return false
  return isDeepStrictEqual(command, ['container', 'exists', containerId])
    || isDeepStrictEqual(command, ['rm', '--volumes', containerId])
}

import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'

export const DeviceScopeSchema = z.enum(['connect', 'heartbeat', 'metrics:report'])
export const DeviceRegistrationSchema = z.object({
  mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), keyRevision: z.number().int().positive(),
  authorizationRevision: z.number().int().positive(), status: z.enum(['pending', 'paired', 'revoked']),
  scopes: z.array(DeviceScopeSchema),
}).strict()
export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>
export type DeviceScope = z.infer<typeof DeviceScopeSchema>
export type DevicePrincipal = {
  audience: 'graphql-worker'
  mainId: string
  deviceId: string
  workerInstallationId: string
  keyRevision: number
  authorizationRevision: number
  expiresAt: string
}
export const DeviceConnectionIdentitySchema = z.object({
  mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(), bootId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  connectionGeneration: z.number().int().positive(),
}).strict()
export type DeviceConnectionIdentity = z.infer<typeof DeviceConnectionIdentitySchema>
export type CanonicalMachineReference = { kind: 'main'; mainId: string } | { kind: 'device'; mainId: string; deviceId: string }

export function authorizeDevice(registration: DeviceRegistration, principal: DevicePrincipal, scope: DeviceScope, now: number): boolean {
  return principal.audience === 'graphql-worker' && registration.status === 'paired'
    && principal.mainId === registration.mainId && principal.deviceId === registration.deviceId
    && principal.workerInstallationId === registration.workerInstallationId
    && principal.keyRevision === registration.keyRevision
    && principal.authorizationRevision === registration.authorizationRevision
    && Date.parse(principal.expiresAt) > now && registration.scopes.includes(scope)
}
export function revokeDevice(registration: DeviceRegistration): DeviceRegistration {
  if (registration.status === 'revoked') return registration
  return { ...registration, status: 'revoked', authorizationRevision: registration.authorizationRevision + 1 }
}

export const DeviceTlsTrustSchema = z.object({
  certificatePem: z.string().min(1).max(8192),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type DeviceTlsTrust = z.infer<typeof DeviceTlsTrustSchema>

export const WorkerPairingConfigurationSchema = z.object({
  formatVersion: z.literal(1), mainId: z.uuid(), deviceId: z.uuid(), workerInstallationId: z.uuid(),
  keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive(),
  endpoint: z.url().refine(value => {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  }, 'Use verified WSS or an explicit loopback carrier without URL credentials, query or fragment.'),
  mainPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  tlsTrust: DeviceTlsTrustSchema.optional(),
  credential: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.string().datetime(),
}).strict()
export type WorkerPairingConfiguration = z.infer<typeof WorkerPairingConfigurationSchema>
export const DevicePairingGrantInputSchema = z.object({ workerInstallationId: z.uuid(), publicKey: z.string().max(1024),
  expectedAuthorizationRevision: z.number().int().positive().optional(), commandId: optionalCommandId(z.string().min(8).max(200)), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), scopes: z.array(DeviceScopeSchema).min(1).max(3) }).strict()
export const DeviceRevokeInputSchema = z.object({ deviceId: z.uuid(), expectedRevision: z.number().int().positive(), commandId: optionalCommandId(z.string().min(8).max(200)) }).strict()

export const MainIdentityProofRequestSchema = z.object({
  audience: z.literal('graphql-worker-main-v1'), mainId: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), workerInstallationId: z.uuid(),
  deviceId: z.uuid().optional(), bootId: z.uuid().optional(), connectionGeneration: z.number().int().positive().optional(),
  keyRevision: z.number().int().positive().optional(), authorizationRevision: z.number().int().positive().optional(),
  connectionEpoch: z.uuid().optional(), mainConnectionEpoch: z.uuid().optional(),
  negotiationHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  protocolVersion: z.number().int().positive(), workerApplicationVersion: z.string().min(1).max(128),
}).strict()
export type MainIdentityProofRequest = z.infer<typeof MainIdentityProofRequestSchema>
export const MainSignedIdentityProofSchema = z.object({ request: MainIdentityProofRequestSchema,
  mainApplicationVersion: z.string().min(1).max(128), mainPublicKey: z.string().max(1024),
  mainPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict()
export type MainSignedIdentityProof = z.infer<typeof MainSignedIdentityProofSchema>

/** Public selected-main enrollment proof cannot certify an authenticated session. */
export const MainEnrollmentProofRequestSchema = z.object({
  audience: z.literal('graphql-worker-main-enrollment-v1'), mainId: z.uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), workerInstallationId: z.uuid(),
  protocolVersion: z.number().int().positive(), workerApplicationVersion: z.string().min(1).max(128),
}).strict()
export type MainEnrollmentProofRequest = z.infer<typeof MainEnrollmentProofRequestSchema>
export const MainSignedEnrollmentProofSchema = MainSignedIdentityProofSchema.extend({ request: MainEnrollmentProofRequestSchema })
export type MainSignedEnrollmentProof = z.infer<typeof MainSignedEnrollmentProofSchema>

export const WorkerEnrollmentInputSchema = z.object({ mainId: z.uuid(),
  mainPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/), endpoint: WorkerPairingConfigurationSchema.shape.endpoint,
  grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/), requestId: z.uuid(),
}).strict()
export const DevicePairingRequestSchema = z.object({ mainId: z.uuid(), workerInstallationId: z.uuid(),
  publicKey: z.string().max(1024), grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/), requestId: z.uuid(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict()
export type DevicePairingRequest = z.infer<typeof DevicePairingRequestSchema>
export const DevicePairingResultSchema = z.object({ registration: DeviceRegistrationSchema,
  credential: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime().describe('Device credential expiry; new pairings use a 100-year lifetime. Revocation and scopes still apply.'),
}).strict()

export const DeviceListResultSchema = z.object({ devices: z.array(DeviceRegistrationSchema) }).strict()
export const DevicePairingGrantResultSchema = z.object({ registration: DeviceRegistrationSchema,
  grant: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime().describe('Single-use pairing grant expiry, one hour after creation; retries retain the original expiry.'),
}).strict()
export const MainDeviceIdentityPublicSchema = z.object({ mainId: z.uuid(), mainPublicKey: z.string().max(1024),
  mainPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type MainDeviceIdentityPublic = z.infer<typeof MainDeviceIdentityPublicSchema>

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorizeDevice, DevicePairingGrantInputSchema, DeviceRegistrationSchema, type DevicePrincipal } from './deviceIdentity.js'
import { DeviceSetupApproveInputSchema, encodeWorkerIdentityRequest } from './deviceSetup.js'
import { DEFAULT_MANAGEMENT_ACTIONS, ManagementActionSchema } from './management/index.js'

describe('explicit telemetry grants', () => {
  it('does not infer metrics report authority from an existing connection grant', () => {
    const registration = DeviceRegistrationSchema.parse({ mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), publicKeyFingerprint: 'a'.repeat(64), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] })
    const principal: DevicePrincipal = { audience: 'graphql-worker', ...registration,
      expiresAt: '2099-01-01T00:00:00Z' }
    expect(authorizeDevice(registration, principal, 'metrics:report', 0)).toBe(false)
    const authorized = { ...registration, scopes: [...registration.scopes, 'metrics:report' as const] }
    expect(authorizeDevice(authorized, principal, 'metrics:report', 0)).toBe(true)
    expect(authorizeDevice({ ...authorized, authorizationRevision: 2 }, principal, 'metrics:report', 0)).toBe(false)
    expect(authorizeDevice({ ...authorized, status: 'revoked' }, principal, 'metrics:report', 0)).toBe(false)
    expect(registration.scopes).toEqual(['connect', 'heartbeat'])
  })

  it('accepts three explicitly selected scopes for pairing and setup without defaulting them', () => {
    const scopes = ['connect', 'heartbeat', 'metrics:report'] as const
    const pairing = { workerInstallationId: randomUUID(), publicKey: 'public-key', expectedFingerprint: 'a'.repeat(64),
      commandId: 'pairing-command', scopes: [...scopes] }
    const setup = { commandId: 'setup-command', endpoint: 'wss://192.168.88.197:43131/device/connect', scopes: [...scopes],
      identityRequestCode: encodeWorkerIdentityRequest({ version: 1, kind: 'identity-request',
        workerInstallationId: pairing.workerInstallationId, publicKey: pairing.publicKey, publicKeyFingerprint: pairing.expectedFingerprint }) }
    expect(DevicePairingGrantInputSchema.parse(pairing).scopes).toEqual(scopes)
    expect(DeviceSetupApproveInputSchema.parse(setup).scopes).toEqual(scopes)
    for (const [schema, input] of [[DevicePairingGrantInputSchema, pairing], [DeviceSetupApproveInputSchema, setup]] as const) {
      expect(schema.safeParse({ ...input, scopes: undefined }).success).toBe(false)
      expect(schema.safeParse({ ...input, scopes: [] }).success).toBe(false)
      expect(schema.safeParse({ ...input, scopes: [...scopes, 'connect'] }).success).toBe(false)
    }
  })

  it('includes owner telemetry and provider actions in manage presets', () => {
    expect(ManagementActionSchema.parse('devices:metrics:read')).toBe('devices:metrics:read')
    expect(DEFAULT_MANAGEMENT_ACTIONS).toEqual(ManagementActionSchema.options)
  })
})

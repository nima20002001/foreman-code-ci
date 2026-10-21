import { describe, expect, it } from 'vitest'
import { HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import { projectHarnessInstance, projectHarnessRegistry } from '../src/modules/harnesses/registryProjection.js'

describe('public registry projection', () => {
  it('does not expose unsupported or invalid raw configuration', () => {
    const result = projectHarnessInstance({ instanceId: 'unknown', instanceRevision: '1', driverId: 'unknown', enabled: true, availability: 'unknown-driver', configuration: { credential: 'secret' } })
    expect(result.configuration).toBeNull()
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.availability).toBe('unknown-driver')
  })
  it('preserves existing recognized defaults and immutable identity readback', () => {
    const configuration = { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }
    const result = projectHarnessInstance({ instanceId: 'local-default:codex', instanceRevision: '3', driverId: 'codex', driverRevision: '1', enabled: true, availability: 'available', configuration })
    expect(result.configuration).toEqual(configuration)
    expect(result.configuration).not.toBe(configuration)
    expect(result.instanceRevision).toBe('3')
  })
})

const mainId = '00000000-0000-4000-8000-000000000001', deviceId = '00000000-0000-4000-8000-000000000002', workerInstallationId = '00000000-0000-4000-8000-000000000003'
const observed = { binding: { mainId, deviceId, workerInstallationId, bootId: '00000000-0000-4000-8000-000000000004', connectionEpoch: '00000000-0000-4000-8000-000000000005', keyRevision: 2, authorizationRevision: 3, connectionGeneration: 4 },
  phase: 'offline' as const, dispatch: false, transfer: false, appVersion: 'observed-worker-build', protocolVersion: 1 as const, lastSeenAt: '2026-10-01T10:00:00.000Z' }

it('projects an independent exact canonical observed connection with no fabricated readiness or authentication', () => {
  const metadata = { hostRef: { kind: 'device' as const, mainId, deviceId }, applicationInstallationId: workerInstallationId,
    connection: observed, platform: null, workspaceRoots: null }
  const result = projectHarnessRegistry([], [], metadata)
  expect(result.hostMetadata?.connection).toEqual(observed)
  expect(result.hostMetadata?.connection).not.toBe(observed)
  expect(result.installations).toEqual([])
  expect(result.hostMetadata).not.toHaveProperty('authenticated')
  metadata.connection.binding.connectionGeneration = 99
  expect(result.hostMetadata?.connection?.binding.connectionGeneration).toBe(4)
})

it('keeps main absence explicit and rejects mismatched or incomplete device observations', () => {
  const main = { hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId, connection: null, platform: null, workspaceRoots: null }
  expect(projectHarnessRegistry([], [], main).hostMetadata?.connection).toBeNull()
  expect(() => projectHarnessRegistry([], [], { ...main, connection: observed })).toThrow('exact canonical device')
  const device = { ...main, hostRef: { kind: 'device' as const, mainId, deviceId }, applicationInstallationId: workerInstallationId }
  expect(() => projectHarnessRegistry([], [], { ...device, connection: { ...observed, binding: { ...observed.binding, workerInstallationId: mainId } } })).toThrow('exact canonical device')
  const incomplete: Record<string, unknown> = { ...observed }
  delete incomplete.appVersion
  expect(HarnessRegistryReadbackSchema.safeParse({ instances: [], installations: [], hostMetadata: { ...device, connection: incomplete } }).success).toBe(false)
})

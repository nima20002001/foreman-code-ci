import { describe, expect, it, vi } from 'vitest'
import type { HostHarnessOverride, HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import { createHostHarnessProfileCheckExtension } from '../src/modules/harnesses/instanceSettings/profileChannel.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'

const mainId = '00000000-0000-4000-8000-000000000001', deviceId = '00000000-0000-4000-8000-000000000002', workerInstallationId = '00000000-0000-4000-8000-000000000003'
const binding = { mainId, deviceId, workerInstallationId, bootId: '00000000-0000-4000-8000-000000000004', keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, connectionEpoch: 'epoch' }
const override: HostHarnessOverride = { instanceId: '00000000-0000-4000-8000-000000000005', revision: 1, instanceRevision: '1',
  target: { hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId, harnessInstallationId: 'codex', installationFingerprint: 'sha' },
  presetId: 'local-default:codex', enabled: true, driverId: 'codex', configuration: { harness: 'codex', model: 'test', reasoningEffort: 'high', sandbox: 'read-only', serviceTier: 'standard' }, configurationFingerprint: 'profile', qualification: 'qualified' }
const proof: HostHarnessProfileEvidence = { target: override.target, instanceRevision: '1', configurationFingerprint: 'profile', driverId: 'codex', driverRevision: 'driver', protocolRevision: 'protocol', suiteRevision: 'suite', environmentGeneration: 'env', connectionGeneration: harnessConnectionGeneration(binding), authenticated: false, compatible: true, qualified: false, checkedAt: '2026-10-01T00:00:00.000Z' }
const request = { checkId: '00000000-0000-4000-8000-000000000006', override }
function fixture() {
  const qualify = vi.fn(async () => structuredClone(proof))
  const extension = createHostHarnessProfileCheckExtension({ hostRef: { kind: 'device', mainId, deviceId }, applicationInstallationId: workerInstallationId, qualifierForBinding: () => ({ qualify }) })
  return { qualify, extension }
}
describe('actual worker profile-check handler port', () => {
  it('always calls the actual qualifier and ignores incoming qualified flags', async () => {
    const f = fixture()
    const result = await f.extension.handle(request, { binding, signal: new AbortController().signal })
    expect(result.payload.qualified).toBe(false)
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })
  it('rejects unrelated canonical targets before native admission and stale proof bindings afterward', async () => {
    const f = fixture(), signal = new AbortController().signal
    await expect(f.extension.handle({ ...request, override: { ...override, target: { ...override.target, applicationInstallationId: mainId } } }, { binding, signal })).rejects.toThrow('binding mismatch')
    expect(f.qualify).not.toHaveBeenCalled()
    f.qualify.mockResolvedValueOnce({ ...proof, connectionGeneration: 'old-boot' })
    await expect(f.extension.handle(request, { binding, signal })).rejects.toThrow('stale or unrelated')
  })
})

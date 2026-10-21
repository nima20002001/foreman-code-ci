import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import type { CompatibilityProbeOwnership } from '../src/modules/harnesses/compatibility/probe.js'
import { scopedCompatibilityProbe } from '../src/modules/harnesses/compatibility/scopedProbe.js'

const binding: RegistryHarnessSelection = {
  inventoryRevision: 1,
  selection: { driverId: 'codex', instanceId: 'default', instanceRevision: '8', hostRef: { kind: 'main', mainId: 'recorded' },
    harnessInstallationId: 'installation', installationFingerprint: 'payload' },
  instance: { instanceId: 'default', instanceRevision: '8', driverId: 'codex', enabled: true,
    configuration: DEFAULT_HARNESS_DEFAULTS.codex, availability: 'available', driverRevision: '1' },
  installation: { hostRef: { kind: 'main', mainId: 'recorded' }, harnessInstallationId: 'installation',
    installationFingerprint: 'payload', driverId: 'codex', driverRevision: '1', protocolRevision: 'recorded-protocol',
    environmentGeneration: 'env', connectionGeneration: 'connection', installed: true, observedVersion: null,
    authenticated: null, compatible: null, qualified: null,
    launcher: { requested: 'codex', resolvedLauncher: '/recorded/codex', fingerprint: 'payload', status: 'installed',
      interpreter: null, diagnostics: [], checkedAt: '2026-10-01T00:00:00.000Z', payloadFingerprints: [],
      environment: { generation: 'env', provenance: 'worker', cwd: '/recorded', path: '/recorded' } } },
}

function fixture() {
  const registry = { scope: vi.fn((owner: string) => ({ root: '/recorded/registry', owner })),
    reserveLaunch: vi.fn(async (owner: string) => ({ root: '/recorded/registry', owner, launchId: 'recorded-launch' })),
    abandonReservedLaunch: vi.fn(async () => false), closeOwner: vi.fn(async (owner: string) => { expect(owner).toMatch(/^diagnostics:compatibility:/); return true }) }
  const assertInstallation = vi.fn(async () => undefined)
  let commandOwnership: CompatibilityProbeOwnership | undefined
  const inspect = vi.fn(async (signal: AbortSignal) => {
    await commandOwnership!.beforeCommand('/recorded/codex', signal)
    return { executable: '/recorded/codex', identity: 'payload', version: '0.154.0' }
  })
  const rawClose = vi.fn(async () => undefined)
  const probe = scopedCompatibilityProbe({ registry, pin: () => binding, assertInstallation, workingDirectory: '/recorded',
    nativeProbe: (_binaries, _directory, _environment, _timeout, ownership) => {
      commandOwnership = ownership
      return { inspect: (_harness, signal) => inspect(signal), probe: async () => 'schema',
        assertUnchanged: async () => undefined, close: rawClose }
    } })
  return { registry, assertInstallation, probe, inspect, rawClose }
}

it('allocates without admission and rejects early cancellation without an orphan reservation', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort(new Error('Stopped before admission'))
  expect(f.registry.scope).not.toHaveBeenCalled()
  expect(() => f.probe.inspect('codex', controller.signal)).toThrow('Stopped before admission')
  expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  await f.probe.close!()
})

it('retains failed physical cleanup and retries the exact admitted diagnostic owner', async () => {
  const f = fixture()
  f.registry.closeOwner.mockResolvedValueOnce(false)
  await expect(f.probe.inspect('codex', new AbortController().signal)).rejects.toBeInstanceOf(AggregateError)
  expect(f.registry.reserveLaunch).toHaveBeenCalledOnce()
  expect(() => f.probe.inspect('codex', new AbortController().signal)).toThrow('ownership remains uncertain')
  expect(f.registry.scope.mock.calls[0]?.[0]).toMatch(/^diagnostics:compatibility:codex:/)
  await f.probe.close!()
  expect(f.registry.closeOwner.mock.calls[0]?.[0]).toBe(f.registry.closeOwner.mock.calls[1]?.[0])
  expect(f.rawClose).toHaveBeenCalledTimes(2)
})

it.each(['host generation changed', 'native payload changed'])('fences %s before native reservation', async (reason) => {
  const f = fixture()
  f.assertInstallation.mockRejectedValue(new Error(reason))
  await expect(f.probe.inspect('codex', new AbortController().signal)).rejects.toThrow(reason)
  expect(f.registry.reserveLaunch).not.toHaveBeenCalled()
  expect(f.inspect).not.toHaveBeenCalled()
  await f.probe.close!()
})

import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { expect, it, vi } from 'vitest'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'
import { withQualificationIdentity } from '../src/modules/harnesses/qualification/identity.js'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'
import { ReplayGate } from './support/harnessReplay.js'

function fixture() {
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload([{ instanceId: 'configured-codex', instanceRevision: 'config-1', driverId: 'codex',
    enabled: true, configuration: DEFAULT_HARNESS_DEFAULTS.codex }])
  const hostRef = { kind: 'main' as const, mainId: 'canonical-main' }
  const installation: HarnessInstallationRecord = { hostRef, harnessInstallationId: 'codex-installation',
    installationFingerprint: 'aggregate-launcher-payload', driverId: 'codex', driverRevision: '1',
    protocolRevision: 'recorded-protocol', environmentGeneration: 'env-1', connectionGeneration: 'connection-1',
    installed: true, observedVersion: '0.154.0', authenticated: null, compatible: null, qualified: null,
    launcher: { requested: '/recorded/codex', resolvedLauncher: '/recorded/codex', fingerprint: 'aggregate-launcher-payload',
      payloadFingerprints: [{ path: '/recorded/codex', fingerprint: 'recorded-launcher-hash' },
        { path: '/recorded/payload', fingerprint: 'recorded-payload-hash' }], status: 'installed', interpreter: null,
      diagnostics: [], checkedAt: '2026-10-01T00:00:00Z',
      environment: { generation: 'env-1', provenance: 'worker', cwd: '/neutral', path: '/recorded' } } }
  const registry = new HarnessInstallationRegistry(instances)
  registry.refresh([installation])
  const pin = () => registry.pin({ instanceId: 'configured-codex', hostRef, harnessInstallationId: 'codex-installation',
    environmentGeneration: 'env-1', connectionGeneration: 'connection-1' })
  const input: QualificationSuiteInput = { binary: '/recorded/codex', binarySha256: 'recorded-launcher-hash',
    version: '0.154.0', profile: 'codex-0.156', model: null, workDirectory: '/recorded-work', signal: new AbortController().signal }
  return { registry, pin, installation, input }
}

it('records exact identity while every explicitly requested live run still executes', async () => {
  const f = fixture()
  const run = vi.fn(async () => ({ checks: [{ id: 'recorded', passed: true, detail: 'synthetic unit fixture' }], evidence: {} }))
  const suite = withQualificationIdentity({ harness: 'codex', revision: 'suite-1', run }, f.registry, f.pin)
  const first = await suite.run(f.input)
  await suite.run(f.input)
  expect(run).toHaveBeenCalledTimes(2)
  expect(first.evidence.qualificationIdentity).toMatchObject({ suiteRevision: 'suite-1+identity-v1', protocolRevision: 'recorded-protocol',
    selection: { hostRef: f.installation.hostRef, instanceRevision: 'config-1', installationFingerprint: 'aggregate-launcher-payload' },
    payloadFingerprints: f.installation.launcher.payloadFingerprints })
})

it('rejects a pending result after explicit inventory invalidation and rejects another launcher before dispatch', async () => {
  const f = fixture()
  const gate = new ReplayGate<void>()
  const entered = new ReplayGate<void>()
  const run = vi.fn(async () => { entered.release(); await gate.promise; return { checks: [], evidence: {} } })
  const suite = withQualificationIdentity({ harness: 'codex', revision: 'suite-1', run }, f.registry, f.pin)
  const running = suite.run(f.input)
  await entered.promise
  f.registry.invalidate()
  gate.release()
  await expect(running).rejects.toThrow('stale')
  await expect(suite.run({ ...f.input, binary: '/another/codex' })).rejects.toThrow('exact selected')
  expect(run).toHaveBeenCalledTimes(1)
})

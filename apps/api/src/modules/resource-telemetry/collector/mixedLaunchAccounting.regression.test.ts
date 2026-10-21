import { expect, it, vi } from 'vitest'
import { telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { passiveRegistryOwnershipReader, type NativeLaunchObservation, type TrustedNativeScope } from './registryAdapter.js'
import { LinuxSampler } from './sampler.js'

const identity = { mainId: telemetryOwnedFixture.mainId, host: telemetryOwnedFixture.host }
const boundary = { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/certified', device: '1', inode: '10' }

it.each(['active-process-only', 'unconfirmed-process-only', 'closed-process-only', 'old-boot-process-only', 'certified'] as const)(
  'reports adapter-to-sampler completeness for a certified launch plus %s', async mode => {
    const certified: NativeLaunchObservation = { owner: 'native-owner', launchId: 'certified-launch', bootId: identity.host.bootId,
      provider: { pid: 42, startTicks: '100' }, boundary, lifecycle: 'active' }
    const other: NativeLaunchObservation = { owner: 'native-owner', launchId: 'other-launch', bootId: mode === 'old-boot-process-only' ? 'old-boot' : identity.host.bootId,
      provider: { pid: 43, startTicks: '200' }, lifecycle: mode === 'closed-process-only' ? 'closed' : mode === 'unconfirmed-process-only' ? 'closure-unconfirmed' : 'active',
      ...(mode === 'certified' ? { boundary: { ...boundary, path: '/sys/fs/cgroup/other', inode: '11' } } : {}) }
    const scope: TrustedNativeScope = { nativeOwner: 'native-owner', selector: telemetryOwnedFixture, leaseId: 'accepted-lease',
      observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId, shared: false, lifecycle: 'active' }
    const reader = passiveRegistryOwnershipReader({ revision: () => '1', snapshot: () => ({ revision: '1', launches: [certified, other] }), changes: async function* () {} },
      { revision: () => '1', snapshot: async () => [scope], changes: async function* () {} })
    const signal = new AbortController().signal, snapshot = await reader.snapshot(signal)
    const view = snapshot.views[0]!
    // Keep the adapter's certified handles and completeness facts, substituting only successful physical reads.
    for (const handle of view.accountingHandles) vi.spyOn(handle, 'read').mockResolvedValue({ cpu: 100n, memory: 512, cpuFailure: null, memoryFailure: null })
    const processStat = vi.fn(async () => { throw new Error('cgroup metrics must not be combined with process metrics') })
    let now = 1_000_000_000n
    const sampler = new LinuxSampler({ now: () => now, wholeHostVisible: false, constants: { clockTicksPerSecond: 100n, pageSize: 4096n },
      read: async path => path.includes('boot_id') ? identity.host.bootId : '0-7',
      process: { stat: processStat, children: async () => [] }, ownership: { snapshot: async () => snapshot, changes: async function* () {} } })
    await sampler.capture(identity, signal); now += 2_000_000_000n
    const row = (await sampler.capture(identity, signal)).owned[0]!
    expect(row.cpu).toMatchObject({ state: 'ok', basis: 'cgroup-usage-usec' })
    expect(row.memory).toMatchObject({ state: 'ok', value: { kind: 'cgroup-current', bytes: mode === 'certified' ? 1024 : 512 } })
    expect(processStat).not.toHaveBeenCalled()
    const incomplete = mode === 'active-process-only' || mode === 'unconfirmed-process-only'
    expect(row.coverage.boundary).toBe(incomplete ? 'partial' : 'complete-boundary')
    expect(view.accountingIncomplete).toBe(incomplete)
    expect(row.coverage.reasons).toEqual(incomplete ? ['escaped-boundary'] : [])
  })

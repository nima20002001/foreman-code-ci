import { expect, it } from 'vitest'
import { telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { passiveRegistryOwnershipReader, type NativeLaunchObservation, type PassiveNativeRegistry, type TrustedNativeScope, type TrustedNativeScopes } from './registryAdapter.js'
const scope = (): TrustedNativeScope => ({ nativeOwner: 'execution:accepted-execution', selector: telemetryOwnedFixture,
  leaseId: 'accepted-lease', observedDeviceId: telemetryOwnedFixture.host.deviceId,
  observedInstallationId: telemetryOwnedFixture.host.applicationInstallationId, shared: false, lifecycle: 'closure-unconfirmed' })
const launch = (launchId = 'launch-1'): NativeLaunchObservation => ({ owner: 'execution:accepted-execution', launchId,
  bootId: telemetryOwnedFixture.host.bootId, guardian: { pid: 42, startTicks: '100' }, provider: { pid: 43, startTicks: '200' }, lifecycle: 'active' })
const registry = (launches = [launch()]): PassiveNativeRegistry => ({ revision: () => 'native-1', snapshot: () => ({ revision: 'native-1', launches }), changes: async function* () {} })
const scopes = (values = [scope()]): TrustedNativeScopes => ({ revision: () => 'scope-1', snapshot: async () => values, changes: async function* () {} })
it('joins all actual sequential launches and separates guardian/provider birth identities', async () => {
  const second = { ...launch('launch-2'), provider: { pid: 44, startTicks: '300' } }
  const view = (await passiveRegistryOwnershipReader(registry([launch(), second]), scopes()).snapshot(new AbortController().signal)).views[0]!
  expect(view.launchIds).toEqual(['launch-1', 'launch-2']); expect(view.roots.map(root => root.pid)).toEqual([42, 43, 44]); expect(view.lifecycle).toBe('closure-unconfirmed'); expect(view.selector).toBe(telemetryOwnedFixture)
})
it('does not infer owner from names, sessions or Agent matches', async () => {
  const unrelated = { ...launch(), owner: 'conversation:same-agent' }; const result = await passiveRegistryOwnershipReader(registry([unrelated]), scopes()).snapshot(new AbortController().signal)
  expect(result.views[0]?.launchIds).toEqual([]); expect(result.views[0]?.roots).toEqual([])
})
it('excludes old-boot and positively closed accounting sources without clearing authority facts', async () => {
  const old = { ...launch(), bootId: 'old-boot' }; const closed = { ...launch('closed'), lifecycle: 'closed' as const }
  const view = (await passiveRegistryOwnershipReader(registry([old, closed]), scopes()).snapshot(new AbortController().signal)).views[0]!
  expect(view.roots).toEqual([]); expect(view.launchIds).toHaveLength(2); expect(view.lifecycle).toBe('closure-unconfirmed')
})
it('projects read-only local certificate and never source control keys', async () => {
  const boundary = { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/captured', device: '1', inode: '2' }
  const source = { ...launch(), boundary, controlKey: 'must-not-escape' }
  const view = (await passiveRegistryOwnershipReader(registry([source]), scopes()).snapshot(new AbortController().signal)).views[0]!
  expect(view.accountingHandles[0]?.boundary).toEqual(boundary); expect(JSON.stringify(view)).not.toContain('must-not-escape')
})
it('scope revision changes retry atomic join and do not retain the old selector', async () => {
  const owner = scopes(); let revision = '1'; let count = 0; owner.revision = () => revision
  owner.snapshot = async () => { if (++count === 1) revision = '2'; return [{ ...scope(), selector: { ...telemetryOwnedFixture, attributionRevision: revision } }] }
  const result = await passiveRegistryOwnershipReader(registry(), owner).snapshot(new AbortController().signal); expect(result.views[0]?.selector.attributionRevision).toBe('2'); expect(count).toBe(2)
})
it('bounded captures expose truncation', async () => {
  const many = Array.from({ length: 4100 }, (_, i) => ({ ...launch(String(i)), guardian: { pid: i + 1000, startTicks: '100' } }))
  const view = (await passiveRegistryOwnershipReader(registry(many), scopes()).snapshot(new AbortController().signal)).views[0]!
  expect(view.roots).toHaveLength(4096); expect(view.captureTruncated).toBe(true)
})
it('publication cleanup aborts and joins both producers', async () => {
  const reg = registry(); const owner = scopes(); let closed = 0
  const changes = async function* (_revision: string, signal: AbortSignal) {
    try { yield { revision: '2', launches: [launch()], gap: false }; await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve() }) }
    finally { closed++ }
  }
  reg.changes = changes; owner.changes = changes
  const reader = passiveRegistryOwnershipReader(reg, owner); const abort = new AbortController(); const snapshot = await reader.snapshot(abort.signal)
  const iterator = reader.changes(snapshot.revision, abort.signal)[Symbol.asyncIterator](); expect((await iterator.next()).done).toBe(false)
  abort.abort(); await iterator.return?.(); expect(closed).toBe(2)
})

it('reuses owner lookup across samples and refreshes it when native launches change', async () => {
  let traversals = 0
  const launches = [launch(), ...Array.from({ length: 1000 }, (_, index) => ({
    ...launch(`retired-${index}`), owner: `other-owner-${index}`, lifecycle: 'closed' as const,
  }))]
  const observed = new Proxy(launches, { get(target, property, receiver) {
    if (property === Symbol.iterator) {
      return function* () {
        traversals++
        yield* target
      }
    }
    return Reflect.get(target, property, receiver)
  } })
  let snapshot = { revision: 'native-1', launches: observed }
  const reg: PassiveNativeRegistry = {
    revision: () => snapshot.revision,
    snapshot: () => snapshot,
    changes: async function* () {},
  }
  const reader = passiveRegistryOwnershipReader(reg, scopes())
  const signal = new AbortController().signal
  const first = await reader.snapshot(signal)
  const second = await reader.snapshot(signal)
  expect(second).toEqual(first)
  expect(first.views[0]?.launchIds).toEqual(['launch-1'])
  expect(traversals).toBe(1)
  snapshot = { revision: 'native-2', launches: [launch(), launch('launch-2')] }
  const changed = await reader.snapshot(signal)
  expect(changed.views[0]?.launchIds).toEqual(['launch-1', 'launch-2'])
  expect(changed.revision).not.toBe(first.revision)
})

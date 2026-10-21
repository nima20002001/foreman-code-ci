import { expect, it, vi } from 'vitest'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../src/modules/devices/deviceWire.js'
import { deferred } from './helpers/deferred.js'
import { startInput } from './helpers/nodePlacementStartFixture.js'
import { placementDiscoveryFixture } from './helpers/placementDiscoveryFixture.js'

it.each(['http', 'mcp'] as const)('allows Main Start while a Worker readiness probe is held through %s', async via => {
  const entered = deferred()
  const release = deferred()
  const f = await placementDiscoveryFixture({ mainOnlyWorkflow: true, ensureComputerReady: async host => {
    if (host.kind !== 'device') return
    entered.resolve()
    await release.promise
  } })
  const reading = f.read(via)
  try {
    await entered.promise
    const accepted = await f.native.start(via, startInput(f.native, f.saved))
    expect(accepted.accepted).toBe(true)
    release.resolve()
    const result = await reading
    const persisted = SourceRootListResultSchema.parse(decodeMcpToolResult(await f.native.client.callTool({
      name: 'source_root_list', arguments: { workspaceId: f.input.workspaceId } })))
    const mainRoot = persisted.items.find(root => root.selection.hostRef.kind === 'main')!
    expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'ready', placement: expect.objectContaining({
      hostRef: f.native.placement.local.hostRef, source: mainRoot.source,
      rootBinding: { rootId: mainRoot.binding.rootId, bindingRevision: mainRoot.binding.bindingRevision },
    }) }))
  } finally {
    release.resolve()
    await reading
    await f.close()
    vi.restoreAllMocks()
  }
}, 120_000)

it.each(['http', 'mcp'] as const)('probes each computer once across matching profiles through %s', async via => {
  const probe = vi.fn(async () => undefined)
  const f = await placementDiscoveryFixture({ ensureComputerReady: probe })
  try {
    await f.addMatchingWorkerProfile()
    const result = await f.read(via)
    expect(result.choices).toHaveLength(3)
    expect(result.choices.every(choice => choice.availability === 'ready')).toBe(true)
    expect(probe.mock.calls).toEqual(expect.arrayContaining([[f.native.placement.local.hostRef], [f.worker.target.hostRef]]))
    expect(probe).toHaveBeenCalledTimes(2)
  } finally { await f.close(); vi.restoreAllMocks() }
}, 120_000)

it.each(['http', 'mcp'] as const)('revalidates a source released during a Worker probe through %s', async via => {
  const entered = deferred()
  const release = deferred()
  const f = await placementDiscoveryFixture({ ensureComputerReady: async host => {
    if (host.kind !== 'device') return
    entered.resolve()
    await release.promise
  } })
  const reading = f.read(via)
  try {
    await entered.promise
    await f.pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
      [f.native.placement.source.snapshotId])
    release.resolve()
    const result = await reading
    expect(result.choices).toHaveLength(2)
    for (const choice of result.choices) expect(choice).toMatchObject({ availability: 'unavailable',
      reason: 'The approved source was released. Approve and bind the source again.' })
  } finally {
    release.resolve()
    await reading
    await f.close()
    vi.restoreAllMocks()
  }
}, 120_000)

const rootFailures = [
  { name: 'disconnect', error: undefined },
  { name: 'transport', error: new DeviceConnectionError('transport') },
  { name: 'timeout', error: new DeviceApplicationError('timeout') },
  { name: 'overload', error: new DeviceApplicationAdmissionError() },
  { name: 'storage', error: new DeviceApplicationError('SOURCE_DISK_CAPACITY') },
]
for (const via of ['http', 'mcp'] as const) {
  it.each(rootFailures)('keeps Main and a sibling when missing-root provisioning encounters $name through ' + via,
    async failure => {
      const f = await placementDiscoveryFixture({ deviceCount: 2, missingWorkerRoot: true })
      try {
        const rootsBefore = await f.roots()
        f.state.disconnected = failure.name === 'disconnect'
        f.state.rootFailure = failure.error
        const result = await f.read(via)
        expect(result.choices).toHaveLength(2)
        expect(result.choices.every(choice => choice.availability === 'ready')).toBe(true)
        expect(result.choices).toEqual(expect.arrayContaining([
          expect.objectContaining({ placement: expect.objectContaining({ hostRef: f.native.placement.local.hostRef }) }),
          expect.objectContaining({ placement: expect.objectContaining({ hostRef: f.native.placement.remotes[1]!.hostRef }) }),
        ]))
        expect(await f.roots()).toEqual(rootsBefore)
        await f.expectDenied()
        f.state.disconnected = false
        f.state.rootFailure = undefined
        const recovered = await f.read(via)
        expect(recovered.choices).toHaveLength(3)
        expect(recovered.choices.every(choice => choice.availability === 'ready')).toBe(true)
        expect((await f.roots()).items).toHaveLength(3)
      } finally { await f.close(); vi.restoreAllMocks() }
    }, 120_000)
}

for (const via of ['http', 'mcp'] as const) {
  it.each([
    new DeviceApplicationAdmissionError(), new DeviceApplicationError('DEVICE_BUSY'),
    new DeviceConnectionError('backpressure'),
  ])('keeps healthy choices while the Worker readiness probe reports %s through ' + via, async error => {
    let busy = true
    const f = await placementDiscoveryFixture({ ensureComputerReady: async host => {
      if (host.kind === 'device' && busy) throw error
    } })
    try {
      const rootsBefore = await f.roots()
      const result = await f.read(via)
      expect(result.pending).toBe(true)
      expect(result.choices).toHaveLength(2)
      expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
        placement: expect.objectContaining({ hostRef: f.native.placement.local.hostRef }) }))
      expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'unavailable',
        reason: expect.stringMatching(/busy/iu),
        placement: expect.objectContaining({ hostRef: f.native.placement.remote.hostRef }) }))
      expect(await f.roots()).toEqual(rootsBefore)
      await f.expectDenied()
      busy = false
      const recovered = await f.read(via)
      expect(recovered.pending).toBe(false)
      expect(recovered.choices.every(choice => choice.availability === 'ready')).toBe(true)
    } finally { await f.close(); vi.restoreAllMocks() }
  }, 120_000)
}

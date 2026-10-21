import { expect, it } from 'vitest'
import type { NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { deferred } from '../../../../test/helpers/deferred.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'
import { InstalledWorkflowPhysicalReadouts, remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'

it('serves qualified removed-cgroup closure observed while a physical read is awaiting authorization', async () => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const checking = deferred()
  const authorized = deferred()
  let observation = f.captured.launch
  let closure: NativeLaunchObservation | null = null
  readouts.remember({ readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {},
    assertCurrent: async () => { checking.resolve(); await authorized.promise },
    observe: () => observation, closure: () => closure })
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  const reading = readouts.read(selector)
  const outcome = Promise.allSettled([reading])
  try {
    await checking.promise
    // The registry has qualified the removed boundary after the original service died.
    observation = { ...observation, lifecycle: 'closed', closureEvidence: 'cgroup_v2_removed' }
    closure = observation
    authorized.resolve()
    await expect(reading).resolves.toMatchObject({ observation,
      closure: { ownerClosed: true, launch: observation } })
  } finally {
    authorized.resolve()
    await outcome
    readouts.clear()
    await f.sqlConnection.close()
  }
})

it.each(['active', 'closure-unconfirmed'] as const)(
  'rejects removed-cgroup evidence whose registry lifecycle is %s', async lifecycle => {
    const f = await physicalFixture()
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const observation = { ...f.captured.launch, lifecycle, closureEvidence: 'cgroup_v2_removed' as const }
    readouts.remember({ readout: f.readout, placement: f.placement, source: f.source,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
      observe: () => observation, closure: () => observation })
    try {
      await expect(readouts.read({ intent: f.intent, placement: f.placement,
        receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(f.source) }))
        .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    } finally {
      readouts.clear()
      await f.sqlConnection.close()
    }
  },
)

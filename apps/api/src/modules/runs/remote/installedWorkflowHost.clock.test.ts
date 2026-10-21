import { expect, it, vi } from 'vitest'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { MainClock } from '../../devices/workerClock.js'
import { remoteWorkflowSourceDigest } from './workflowPhysicalReadout.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

it.each([-90_000, 5_000, 90_000])(
  'serves a full Main-clock observation window with a %s ms Worker offset', async offset => {
    const mainTime = Date.now()
    let elapsed = 0
    const mainClock = new MainClock(() => elapsed)
    mainClock.observe(mainTime)
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime + offset)
    const f = await runningInstalledFixture('generation', { mainNow: () => mainClock.now() })
    try {
      const read = async () => {
        const status = await f.journal.status(f.intent.operationId)
        if (status.status !== 'known') throw new Error('Expected running operation')
        return RemoteWorkflowPhysicalReadoutSchema.parse((await f.call('physical-readout', {
          receiptSequence: status.receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }),
        })).payload)
      }
      await f.call('status')
      expect((await read()).expiresAt).toBe(new Date(mainTime + 60_000).toISOString())
      elapsed = 60_001
      wallClock.mockReturnValue(mainTime - 300_000)
      expect((await read()).expiresAt).toBe(new Date(mainTime + elapsed + 60_000).toISOString())
      wallClock.mockReturnValue(mainTime + 300_000)
      expect((await read()).expiresAt).toBe(new Date(mainTime + elapsed + 60_000).toISOString())
    } finally {
      wallClock.mockRestore()
      f.cleanup()
      await f.stop()
      await f.host.close()
    }
  },
)

it('keeps observations valid across lease rollover with a Worker two minutes behind', async () => {
  const mainTime = Date.now()
  let elapsed = 0
  const mainClock = new MainClock(() => elapsed)
  mainClock.observe(mainTime)
  const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime - 120_000)
  const f = await runningInstalledFixture('generation', { mainNow: () => mainClock.now(), realMcp: true })
  try {
    const observe = async () => {
      await f.call('status')
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known') throw new Error('Expected running operation')
      return RemoteWorkflowPhysicalReadoutSchema.parse((await f.call('physical-readout', {
        receiptSequence: status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'boundary' }),
      })).payload)
    }
    for (const age of [15 * 60_000 - 1_000, 15 * 60_000 + 1_000]) {
      elapsed = age
      wallClock.mockReturnValue(mainClock.now() - 120_000)
      f.renew(new Date(mainClock.now() + 15 * 60_000).toISOString())
      expect((await observe()).expiresAt).toBe(new Date(mainClock.now() + 60_000).toISOString())
    }
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.turns).toHaveBeenCalledOnce()
  } finally {
    wallClock.mockRestore()
    f.cleanup()
    await f.stop()
    await f.host.close()
  }
})

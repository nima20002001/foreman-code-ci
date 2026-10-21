import { describe, expect, it, vi } from 'vitest'
import { DeviceConnectionError } from '../src/modules/devices/deviceWire.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('CI enrollment reconnect recovery', () => {
  const fixture = ciEnrollmentFixture()

  it('retries a transient Worker transport failure within seconds without a periodic pass', async () => {
    const f = await fixture()
    try {
      f.computers[0]!.executionMode = 'host'
      for (const computer of f.computers.slice(1)) computer.buildEnabled = false
      f.inventory.hostStatus = vi.fn()
        .mockRejectedValueOnce(new DeviceConnectionError('transport'))
        .mockResolvedValue({ operation: 'status', ready: true, reasons: [],
          cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] })

      await f.enrollment.reconcile()
      const pending = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(pending.computers[0]!.state).toBe('pending')
      await vi.waitFor(async () => {
        const recovered = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(recovered.computers[0]!.state).toBe('ready')
      }, { timeout: 5_000, interval: 50 })
      expect(f.inventory.hostStatus).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { telemetryComputerFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { createResourceCollector } from './lifecycle.js'
import type { SamplerPorts } from './sampler.js'
import { readOperationalFailures } from '../../diagnostics/logger.js'

const capture = vi.hoisted(() => vi.fn())
vi.mock('./sampler.js', () => ({ LinuxSampler: class { capture = capture; reset() {} } }))
afterEach(() => vi.useRealTimers())
it.each(['capture', 'schema', 'size'])('reports a dropped %s sample while keeping collection independent', async kind => {
  vi.useFakeTimers()
  const before = readOperationalFailures().find(item => item.operation === 'capture resource telemetry sample')?.failureCount ?? 0
  capture.mockReset()
  if (kind === 'capture') capture.mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'EIO' }))
  if (kind === 'schema') capture.mockResolvedValue({})
  if (kind === 'size') capture.mockResolvedValue({ owned: [], host: 'x'.repeat(70_000) })
  const identity = { mainId: telemetryComputerFixture.mainId, host: telemetryComputerFixture.host }
  const collector = createResourceCollector({ identity, ports: {} as SamplerPorts,
    clock: { now: () => 0n, wall: () => 0, setTimer: (work, ms) => setTimeout(work, ms),
      clearTimer: timer => clearTimeout(timer) } })
  collector.offer({ schemaVersion: 1, identity, challengeId: `challenge-${kind}`,
    issuedAtUnixMs: 0, freshUntilUnixMs: 6000 })
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'capture resource telemetry sample',
      failureCount: before + 1 }))
  } finally { await collector.close() }
})

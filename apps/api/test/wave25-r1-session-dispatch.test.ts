import { describe, expect, it, vi } from 'vitest'
import type { NativeSessionLane } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'
import { rejectableDeferred } from './helpers/deferred.js'

function writer() {
  const fixture = deliveryFixture()
  const lane: NativeSessionLane = { id: 'lane-r1', harness: 'codex', nativeSessionId: fixture.session.nativeSessionId,
    ownerAgentId: fixture.interaction.requestingAgentId, connectionGeneration: 0, observedStatus: 'idle',
    observedAt: new Date().toISOString(), revision: 0 }
  const coordination = {
    ensureLane: vi.fn(async () => lane),
    claimLane: vi.fn(async (_id: string, _revision: number, _owner: string, token: string, expiry: string) =>
      ({ ...lane, leaseToken: token, leaseExpiresAt: expiry })),
    assertLaneLease: vi.fn(async () => undefined),
    renewLane: vi.fn(async () => new Date(Date.now() + 60000).toISOString()),
    releaseLane: vi.fn(async () => undefined),
  }
  const native = { harness: 'codex', respond: vi.fn(async () => undefined) }
  const manager = new SingleWriterSessionManager(native as unknown as NativeHarnessSessionManager,
    coordination as unknown as PostgresInteractionCoordinationRepository, lane.ownerAgentId)
  return { fixture, coordination, native, manager }
}

describe('BR1-006: final check inside the real native writer control queue', () => {
  it('revalidates after queueing and never dispatches a response rejected by that check', async () => {
    const f = writer(), entered = rejectableDeferred(), release = rejectableDeferred()
    f.native.respond.mockImplementationOnce(async () => { entered.resolve(); await release.promise })
    const option = f.fixture.interaction.responseOptions[0]!
    const first = f.manager.respond(f.fixture.session, 'earlier-request', option)
    await entered.promise
    let stopped = false
    const validate = vi.fn(async () => { if (stopped) throw new Error('EXECUTION_STOPPED') })
    const second = f.manager.respondQualified(f.fixture.session, 'queued-approval', option, validate)
    // Attach the rejection assertion before releasing the first native operation.
    const denied = expect(second).rejects.toThrow('EXECUTION_STOPPED')
    expect(validate).not.toHaveBeenCalled()
    stopped = true; release.resolve()
    await first; await denied
    expect(validate).toHaveBeenCalledTimes(1)
    expect(f.native.respond).toHaveBeenCalledTimes(1)
  })
  it('calls the final guard before, not during or after, the native response', async () => {
    const f = writer(), order: string[] = []
    f.native.respond.mockImplementationOnce(async () => { order.push('native') })
    await f.manager.respondQualified(f.fixture.session, 'approval', f.fixture.interaction.responseOptions[0]!,
      async () => { order.push('sql-finished') })
    expect(order).toEqual(['sql-finished', 'native'])
    expect(f.coordination.assertLaneLease).toHaveBeenCalled()
  })
  it('a local Stop during the final check prevents dispatch', async () => {
    const f = writer(), controller = new AbortController()
    await expect(f.manager.respondQualified(f.fixture.session, 'approval', f.fixture.interaction.responseOptions[0]!,
      async () => { controller.abort(new Error('stop')) }, controller.signal)).rejects.toThrow('stop')
    expect(f.native.respond).not.toHaveBeenCalled()
  })
})

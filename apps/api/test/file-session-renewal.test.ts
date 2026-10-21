import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeFileBridge } from '../src/modules/harnesses/claudeSdk/files.js'
import type { ClaudeCallbackIdentity } from '../src/modules/harnesses/claudeSdk/interactions.js'
import { fileToolFixture } from './support/fileTools.js'

afterEach(() => { vi.useRealTimers() })

async function longTurn() {
  const f = await fileToolFixture()
  vi.useFakeTimers()
  vi.setSystemTime(f.clock())
  const identity: ClaudeCallbackIdentity = { ownerPrincipalId: f.context.ownerPrincipalId,
    nativeSessionId: f.context.nativeSessionId, nativeMessageId: 'observed-message', clientCorrelationId: 'correlation',
    attemptId: 'attempt', generation: 'generation', toolUseId: 'tool-use' }
  const context = { ...f.context, turnId: undefined, nativeMessageId: 'observed-message' }
  // Production admission passes the owner's own expiry; the Operator owner here does not expire for decades.
  const admission = { current: vi.fn(async () => ({ context, expiresAt: new Date(f.principal.expiresAt) })) }
  const issue = vi.spyOn(f.sessions, 'issueForAcceptedSession')
  const bridge = new ClaudeFileBridge(identity, admission, f.service)
  const list = () => bridge.call('files.list', { scope: f.scope, limit: 10 })
  /** Moves the file service clock and the renewal timers together, like wall time during a native turn. */
  const elapse = async (ms: number) => {
    for (let step = 0; step < ms; step += 10_000) {
      f.advance(10_000)
      await vi.advanceTimersByTimeAsync(10_000)
    }
  }
  return { ...f, bridge, list, elapse, issue }
}

it('keeps file tools working for a native turn that runs past the old one-hour cap', async () => {
  const f = await longTurn()
  try {
    await expect(f.list()).resolves.toMatchObject({ items: [] })
    await f.elapse(3 * 60 * 60_000)
    await expect(f.list()).resolves.toMatchObject({ items: [] })
    expect(f.issue).toHaveBeenCalledOnce()
  } finally { await f.bridge.close() }
})

it('stops renewing when the turn closes and keeps a revoked owner revoked', async () => {
  const f = await longTurn()
  await f.list()
  const token = await f.issue.mock.results[0]!.value as string
  const renew = vi.spyOn(f.sessions, 'renew')
  await f.elapse(20 * 60_000)
  expect(renew).toHaveBeenCalled()
  f.revoke()
  await f.elapse(20 * 60_000)
  await expect(f.list()).rejects.toThrow(/session could not be renewed: REVOKED/)
  await f.bridge.close()
  const calls = renew.mock.calls.length
  await f.elapse(60 * 60_000)
  expect(renew).toHaveBeenCalledTimes(calls)
  await expect(f.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
})

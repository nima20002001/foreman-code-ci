import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionAuthorityRequestSchema } from '@foreman-code/contracts/execution-authority'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import { deviceReconnectTimeoutMs } from '../../devices/deviceReconnect.js'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'
import { constructionFixture } from './__tests__/installedWorkflowHost.js'
import { deferred } from '../../../../test/helpers/deferred.js'

/** A preparation whose native thread creation is held until the test releases it. */
async function preparing() {
  const f = await constructionFixture()
  const request = new AbortController()
  f.context.signal = request.signal
  const entered = deferred(), release = deferred()
  const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockImplementation(async (_input, signal) => {
    entered.resolve()
    await release.promise
    signal?.throwIfAborted()
    return f.session
  })
  vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(async owner => f.registry.scope(owner))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
    residency: { session: f.session, connectionId: 'unit-native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
    assertCurrent: () => {},
  })
  vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => ({
    endpoint: 'http://unit.invalid/mcp', close: async () => {}, bindRelay: async () => {}, refreshLease: () => relay.refresh!(),
  }))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
  const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockResolvedValue(true)
  const access = { kind: 'scoped-worker-mcp', token: 'unit-main-owned-token', executionId: f.intent.executionId,
    agentId: f.request.configuration.agentId, operationId: f.intent.operationId, attemptId: f.intent.attemptId,
    bindingHash: f.intent.bindingHash }
  const frame = { method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
    executionPlacement: f.nativePlacement, applicationAccess: access }
  const replacement = { ...f.context.binding, connectionGeneration: f.context.binding.connectionGeneration + 1,
    connectionEpoch: randomUUID() }
  /** The device link drops: no session is live and the next Main authority request fails in flight. */
  const drop = () => {
    request.abort(new DeviceConnectionError('transport'))
    f.currentBinding.mockReturnValue(undefined)
    f.linkLostAt.mockReturnValue(Date.now())
    const authority = f.readMain.getMockImplementation()!
    let failed = false
    f.readMain.mockImplementation(async raw => {
      if (!failed && ExecutionAuthorityRequestSchema.safeParse(raw).success) {
        failed = true
        throw new DeviceConnectionError('transport')
      }
      return authority(raw)
    })
  }
  const reconnect = () => {
    f.currentBinding.mockReturnValue(replacement)
    f.linkLostAt.mockReturnValue(undefined)
  }
  return { ...f, create, closeOwner, frame, entered, release, replacement, drop, reconnect }
}

describe('installed workflow preparation across a dropped device link', () => {
  it('keeps the original preparation and answers the replayed prepare on the reconnected session', async () => {
    const f = await preparing()
    const original = f.handler(f.frame, f.context)
    const originalOutcome = original.then(() => 'answered', (error: unknown) => error)
    try {
      await f.entered.promise
      f.drop()
      setTimeout(f.reconnect, 300)
      // Thread creation finishes while the link is still down.
      f.release.resolve()
      await new Promise(resolve => setTimeout(resolve, 400))
      const replayed = await f.handler(f.frame, { binding: f.replacement, signal: new AbortController().signal })
      expect(replayed.payload).toMatchObject({ session: f.session, status: { status: 'known',
        receipt: { native: { sessionId: f.session.nativeSessionId } } } })
      expect(await originalOutcome).toBe('answered')
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.closeOwner).not.toHaveBeenCalled()
      const status = await f.journal.status(f.intent.operationId)
      expect(status).toMatchObject({ status: 'known', receipt: { native: { sessionId: f.session.nativeSessionId } } })
      expect(status.status === 'known' && status.receipt.terminal).toBeFalsy()
    } finally {
      f.release.resolve()
      await originalOutcome
      await f.host.close()
    }
  })

  it('joins the in-flight preparation when Main replays prepare before thread creation finishes', async () => {
    const f = await preparing()
    const original = f.handler(f.frame, f.context)
    const originalOutcome = original.then(() => 'answered', (error: unknown) => error)
    try {
      await f.entered.promise
      f.drop()
      f.reconnect()
      const replayed = f.handler(f.frame, { binding: f.replacement, signal: new AbortController().signal })
      f.release.resolve()
      expect((await replayed).payload).toMatchObject({ session: f.session })
      expect(await originalOutcome).toBe('answered')
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.closeOwner).not.toHaveBeenCalled()
    } finally {
      f.release.resolve()
      await originalOutcome
      await f.host.close()
    }
  })

  it('rejects the preparation when the Worker link stays down past the reconnect bound', async () => {
    const f = await preparing()
    const original = f.handler(f.frame, f.context)
    const originalOutcome = original.then(() => 'answered', (error: unknown) => error)
    try {
      await f.entered.promise
      f.drop()
      f.linkLostAt.mockReturnValue(Date.now() - deviceReconnectTimeoutMs - 1)
      f.release.resolve()
      expect(await originalOutcome).toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      expect(f.create).toHaveBeenCalledOnce()
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'uncertain', entryAttempted: true },
      })
    } finally {
      f.release.resolve()
      await originalOutcome
      await f.host.close()
    }
  })
})

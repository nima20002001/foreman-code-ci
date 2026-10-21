import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { unavailableSessionControls } from '@foreman-code/contracts'
import type { WorkerConversationReceipt, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeSessionStart } from '../harnesses/port.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge, type WorkerConversationChannel } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it.each(['initiator', 'follower'] as const)(
  'cancels only the %s waiting for a shared reconnect and keeps the controls caller usable', async order => {
    const f = workerConversationFixture()
    const entered = deferred()
    const reattached = deferred()
    const bridge = new MainWorkerConversationBridge()
    let connection = f.connection
    const requests: WorkerConversationRpcRequest[] = []
    const receipt: WorkerConversationReceipt = { binding: f.binding, connection, session: f.session,
      nativeOwner: f.nativeOwner, revision: 1, closed: false, closing: false, turns: [], compactions: [],
      desiredPreferences: null, appliedPreferences: null }
    const capabilities = unavailableSessionControls('reconnect-fixture')
    const channel = (): WorkerConversationChannel => {
      const captured = connection
      return { binding: captured, request: async (raw, options) => {
        const request = raw as WorkerConversationRpcRequest
        requests.push(request)
        if (request.method === 'conversation.open' && captured.connectionGeneration > 1) {
          entered.resolve()
          let abort!: () => void
          try {
            await new Promise<void>((resolve, reject) => {
              abort = () => reject(options?.signal?.reason)
              options?.signal?.addEventListener('abort', abort, { once: true })
              void reattached.promise.then(resolve, reject)
              if (options?.signal?.aborted) abort()
            })
          } finally { options?.signal?.removeEventListener('abort', abort) }
        }
        receipt.connection = captured
        receipt.revision++
        if (request.method === 'conversation.pending') return { payload: null }
        if (request.method === 'conversation.controls-read') {
          return { payload: { receipt, capabilities, context: null, preferences: null } }
        }
        if (request.method === 'conversation.release-runtime') receipt.runtimeReleased = true
        return { payload: { receipt } }
      } }
    }
    const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration,
      bridge, current: async () => {}, channel: channel(), currentChannel: channel })
    const controller = new AbortController()
    const reason = new DOMException('Only this read was canceled', 'AbortError')
    let reading: Promise<unknown> | undefined
    let controls: Promise<unknown> | undefined
    try {
      await manager.attachSession(f.session, { kind: 'operator', configuration: f.configuration,
        workingDirectory: f.binding.workingDirectory, correlationId: 'attach' } as NativeSessionStart)
      connection = { ...connection, connectionGeneration: 2, connectionEpoch: randomUUID() }
      const read = () => manager.pending(f.session, controller.signal).then(value => value, error => error)
      const control = () => manager.sessionControlCapabilities(f.session).then(value => ({ value }), error => ({ error }))
      if (order === 'initiator') reading = read()
      else controls = control()
      await entered.promise
      if (order === 'initiator') controls = control()
      else reading = read()
      controller.abort(reason)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(await Promise.race([reading!, Promise.resolve('still waiting for the Worker')])).toBe(reason)
      reattached.resolve()
      expect(await controls).toEqual({ value: capabilities })
      await expect(manager.pending(f.session)).resolves.toBeUndefined()
      expect(requests.filter(request => request.method === 'conversation.open')).toHaveLength(2)
      expect(requests.some(request => request.method === 'conversation.start-turn')).toBe(false)
    } finally {
      reattached.resolve()
      await Promise.allSettled([reading, controls])
      await manager.dispose()
      await bridge.close()
    }
  })

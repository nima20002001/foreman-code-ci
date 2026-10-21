import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceApplicationChannel } from './deviceApplicationChannel.js'
import { adaptDeviceSocket } from './deviceWire.js'

/** In-memory socket: frames reach the peer on a microtask. */
class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    if (this.closed) throw new Error('socket closed')
    queueMicrotask(() => this.peer?.deliver(text))
  }
  deliver(text: string) { if (!this.closed) this.emit('message', Buffer.from(text), false) }
  close() {
    if (this.closed) return
    this.closed = true
    queueMicrotask(() => { this.emit('close'); this.peer?.close() })
  }
}

it('admits a short call while long history pages occupy every bulk slot', async () => {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const extension = { namespace: 'execution-v1', version: 1, mainCanRequest: true, workerCanRequest: false,
    maxJsonBytes: 1_048_576, maxBinaryBytes: 0, observationAdmission: true as const }
  const mainRaw = new Socket(), workerRaw = new Socket()
  mainRaw.peer = workerRaw; workerRaw.peer = mainRaw
  const mainSocket = adaptDeviceSocket(mainRaw), workerSocket = adaptDeviceSocket(workerRaw)
  let releaseHistory!: () => void
  const historyReleased = new Promise<void>(resolve => { releaseHistory = resolve })
  const handle = vi.fn(async (payload: unknown) => {
    if ((payload as { method: string }).method === 'history') await historyReleased
    return { payload: 'ok' }
  })
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: new AbortController().signal, extensions: [extension], registrations: [] })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: new AbortController().signal, extensions: [extension],
    registrations: [{ ...extension, role: 'server', handle }] })
  const mainRun = main.run(mainSocket.messages[Symbol.asyncIterator](), 15_000)
  const workerRun = worker.run(workerSocket.messages[Symbol.asyncIterator](), 15_000)

  try {
    const pages = Array.from({ length: 8 }, (_, page) => main.request('execution-v1', { method: 'history', page }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(handle.mock.calls.map(([payload]) => payload)).toEqual(
      Array.from({ length: 8 }, (_, page) => ({ method: 'history', page })),
    )
    const status = main.request('execution-v1', { method: 'status' })
    const outcome = await Promise.race([status.then(() => 'admitted'),
      new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 2_000))])

    expect(outcome).toBe('admitted')
    expect(handle.mock.calls.at(-1)?.[0]).toEqual({ method: 'status' })
    expect(await status).toEqual({ payload: 'ok' })
    releaseHistory()
    expect(await Promise.all(pages)).toEqual(Array.from({ length: 8 }, () => ({ payload: 'ok' })))
  } finally {
    releaseHistory()
    const mainClosed = expect(mainRun).rejects.toMatchObject({ code: 'transport' })
    const workerClosed = expect(workerRun).rejects.toMatchObject({ code: 'transport' })
    main.close()
    worker.close()
    await Promise.all([mainClosed, workerClosed, main.join(), worker.join()])
    mainSocket.close()
    workerSocket.close()
  }
})

import { EventEmitter } from 'node:events'
import { negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceApplicationChannel, extensionDescriptors, type DeviceExtensionRegistration }
  from '../../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../src/modules/devices/deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

export function managedMcpChannelFixture(binding: DeviceSessionBinding, registration: DeviceExtensionRegistration) {
  const rawMain = new Socket()
  const rawWorker = new Socket()
  rawMain.peer = rawWorker
  rawWorker.peer = rawMain
  const mainSocket = adaptDeviceSocket(rawMain)
  const workerSocket = adaptDeviceSocket(rawWorker)
  const client: DeviceExtensionRegistration = { ...registration, role: 'client' }
  delete client.handle
  const extensions = negotiateDeviceExtensions(extensionDescriptors([client]), extensionDescriptors([registration]))
  const parent = new AbortController()
  const main = new DeviceApplicationChannel({ side: 'main', binding, socket: mainSocket,
    signal: parent.signal, extensions, registrations: [client], revalidate: async () => {} })
  const worker = new DeviceApplicationChannel({ side: 'worker', binding, socket: workerSocket,
    signal: parent.signal, extensions, registrations: [registration] })
  const tasks = [main.run(mainSocket.messages[Symbol.asyncIterator](), 10_000),
    worker.run(workerSocket.messages[Symbol.asyncIterator](), 5000)]
  for (const task of tasks) void task.catch(() => {
    // ignore: closing the fixture joins both carrier tasks below.
  })
  return { main, async close() {
    parent.abort()
    main.close()
    worker.close()
    await Promise.allSettled(tasks)
  } }
}

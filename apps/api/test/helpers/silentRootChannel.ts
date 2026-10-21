import { EventEmitter } from 'node:events'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { DeviceApplicationChannel } from '../../src/modules/devices/deviceApplicationChannel.js'
import { adaptDeviceSocket } from '../../src/modules/devices/deviceWire.js'
import { deferred } from './deferred.js'

/** The authenticated channel sends a real request; the simulated Worker supplies no response. */
export function silentRootChannel(binding: DeviceSessionBinding) {
  const sent = deferred()
  class Socket extends EventEmitter {
    bufferedAmount = 0
    send() { sent.resolve() }
    close() { this.emit('close') }
  }
  const channel = new DeviceApplicationChannel({ side: 'main', binding,
    socket: adaptDeviceSocket(new Socket()), signal: new AbortController().signal,
    extensions: [{ namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version,
      maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0,
      mainCanRequest: true, workerCanRequest: false }], registrations: [],
  })
  return { sent, request: channel.captureRequest(WORKSPACE_ROOT_EXTENSION.namespace).request,
    async close() { channel.close(); await channel.join() } }
}

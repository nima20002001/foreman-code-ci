import { channel } from 'node:diagnostics_channel'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { expect } from 'vitest'

export async function holdPostgresResponses(connectionString: string) {
  const target = new URL(connectionString)
  // Socket addresses are resolved IPs, even when the endpoint uses localhost.
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  const addresses = new Set((await lookup(hostname, { all: true })).map(result => result.address))
  const connections = channel('net.client.socket')
  const sockets = new Set<Socket>()
  const pending = new Map<Socket, () => void>()
  let current: Socket | undefined
  const keepPaused = () => current?.pause()
  const observe = (message: unknown) => {
    const { socket } = message as { socket: Socket }
    const connected = () => {
      pending.delete(socket)
      if (!socket.remoteAddress || !addresses.has(socket.remoteAddress)
        || socket.remotePort !== Number(target.port || 5432)) return
      current = socket
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    }
    pending.set(socket, connected)
    socket.once('connect', connected)
  }
  connections.subscribe(observe)
  return {
    hold() {
      if (!current || current.destroyed) throw new Error('Owned PostgreSQL connection is unavailable')
      current.pause()
      // Removing the last readable listener resumes data flow, so retain this one until release.
      current.on('readable', keepPaused)
    },
    async received() {
      if (!current || current.destroyed) throw new Error('Owned PostgreSQL connection is unavailable')
      const socket = current
      if (socket.readableLength === 0) {
        // Socket I/O and this abort deadline progress while query timers are frozen.
        await once(socket, 'readable', { signal: AbortSignal.timeout(2000) })
      }
      expect(socket.readableLength).toBeGreaterThan(0)
    },
    release() {
      current?.off('readable', keepPaused)
      current?.resume()
    },
    close() {
      connections.unsubscribe(observe)
      for (const [socket, connected] of pending) socket.off('connect', connected)
      pending.clear()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
  }
}

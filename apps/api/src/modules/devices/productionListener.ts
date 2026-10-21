import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { readDeviceTlsMaterials } from './tlsMaterials.js'
import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import { WebSocketServer } from 'ws'
import { DEVICE_FRAME_BYTES } from '@foreman-code/contracts/device-connection'
import { deviceUpgradeHandler } from './deviceCarrier.js'
import type { DeviceEndpoint } from './deviceEndpoint.js'
import { deviceHttpHandler } from './deviceHttp.js'
import type { DeviceListenerConfig } from './productionConfig.js'

/** One explicitly opted-in device-only TLS listener. It has no browser, API or
 * MCP delegation, certificate fallback, provider login or owner credentials. */
export class ProductionDeviceListener {
  private server: Server | undefined
  private websocket: WebSocketServer | undefined
  private readonly sockets = new Set<Socket>()
  private closing = false
  private starting: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private publicTrust: import('@foreman-code/contracts/device-identity').DeviceTlsTrust | undefined
  publicTlsTrust() { return this.publicTrust ? { ...this.publicTrust } : undefined }
  private serverClosed = false
  private websocketClosed = false
  constructor(private readonly config: DeviceListenerConfig, private readonly endpoint: DeviceEndpoint,
    private readonly http: Parameters<typeof deviceHttpHandler>[0],
    private readonly browserMedia?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean) {}

  start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Device listener is shutting down.'))
    this.starting ??= this.open()
    return this.starting
  }
  private async open(): Promise<void> {
    const { certificate, key, publicTrust } = await readDeviceTlsMaterials(this.config)
    if (this.closing) throw new Error('Device listener startup was canceled.')
    const server = createServer({ cert: certificate, key, minVersion: 'TLSv1.2',
      handshakeTimeout: 10_000, maxHeaderSize: DEVICE_FRAME_BYTES }, deviceHttpHandler(this.http))
    this.server = server
    server.headersTimeout = 10_000; server.requestTimeout = 15_000; server.keepAliveTimeout = 5_000
    server.maxHeadersCount = 64; server.maxConnections = 128
    server.on('connection', (socket) => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)) })
    const websocket = new WebSocketServer({ noServer: true, maxPayload: DEVICE_FRAME_BYTES, perMessageDeflate: false })
    this.websocket = websocket
    const deviceUpgrade = deviceUpgradeHandler(this.endpoint, websocket)
    server.on('upgrade', (request, socket, head) => {
      if (!this.browserMedia?.(request, socket, head)) deviceUpgrade(request, socket, head)
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', ready)
      server.listen({ host: this.config.host, port: this.config.port })
    })
    if (this.closing) throw new Error('Device listener startup was canceled.')
    this.publicTrust = publicTrust
  }
  hasConnections(): boolean { return this.sockets.size > 0 }
  close(options?: { preserveEndpoint: true }): Promise<void> {
    this.closing = true
    if (!options?.preserveEndpoint) this.endpoint.close()
    if (this.stopping) return this.stopping
    const attempt = this.finish()
    this.stopping = attempt
    void attempt.catch(() => { if (this.stopping === attempt) this.stopping = undefined })
    return attempt
  }
  private async finish(): Promise<void> {
    await this.starting?.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    const server = this.server
    const websocket = this.websocket
    if (!server) return
    const timer = setTimeout(() => {
      for (const client of websocket?.clients ?? []) client.terminate()
      for (const socket of this.sockets) socket.destroy()
    }, 5_000)
    timer.unref()
    try {
      for (const client of websocket?.clients ?? []) client.close()
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) => {
          if (this.serverClosed) { resolve(); return }
          server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else { this.serverClosed = true; resolve() }
        })
        }),
        new Promise<void>((resolve, reject) => {
          if (!websocket || this.websocketClosed) { resolve(); return }
          websocket.close((error) => { if (error) reject(error); else { this.websocketClosed = true; resolve() } })
        }),
      ])
      const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Device listener closure was incomplete.')
    } finally { clearTimeout(timer) }
  }
}

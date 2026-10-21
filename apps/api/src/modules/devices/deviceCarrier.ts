import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { DeviceEndpoint } from './deviceEndpoint.js'
import { adaptDeviceSocket, DeviceConnectionError, type DeviceSocket, type RawDeviceSocket } from './deviceWire.js'

export interface UpgradeServer {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: RawDeviceSocket) => void): void
}
/** ws server MUST use {noServer:true,maxPayload:16384,perMessageDeflate:false}. */
export function deviceUpgradeHandler(endpoint: DeviceEndpoint, server: UpgradeServer) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== '/device/connect' || request.headers['sec-websocket-extensions']) { socket.destroy(); return }
    // Catch every post-upgrade path explicitly; no Fastify/browser auth middleware is involved.
    void endpoint.authenticate({
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      ...(request.headers.cookie !== undefined ? { cookie: request.headers.cookie } : {}),
      ...(request.headers.origin !== undefined ? { origin: request.headers.origin } : {}),
    }).then((principal) => {
      if (socket.destroyed) return
      server.handleUpgrade(request, socket, head, (raw) => { void endpoint.acceptAuthenticated(principal, adaptDeviceSocket(raw)).catch(() => raw.close()) })
    }).catch((error: unknown) => {
      const code = error instanceof DeviceConnectionError ? error.code : 'transport'
      const statuses: Record<string, number> = { authentication: 401, permission: 403, 'wrong-main': 409, revoked: 410 }
      const status = statuses[code] ?? 503
      if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Device connection rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    })
  }
}
export interface ClientDeviceSocket extends RawDeviceSocket {
  on(event: 'open' | 'message' | 'error' | 'close' | 'unexpected-response', listener: (...args: unknown[]) => void): void
  off(event: 'open' | 'message' | 'error' | 'close' | 'unexpected-response', listener: (...args: unknown[]) => void): void
}
/** Factory is ws's constructor; never pass owner cookies/provider/MCP credentials. */
export function deviceConnector(options: {
  url: string; credential: string
  create(url: string, options: { headers: { Authorization: string }; rejectUnauthorized: true; perMessageDeflate: false; maxPayload: number; handshakeTimeout: number }): ClientDeviceSocket
}): (signal: AbortSignal) => Promise<DeviceSocket> {
  const url = new URL(options.url)
  if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/device/connect' || url.search || url.hash) throw new DeviceConnectionError('wrong-main')
  return (signal) => {
    if (signal.aborted) return Promise.reject(new DeviceConnectionError('transport'))
    const raw = options.create(url.href, { headers: { Authorization: `Bearer ${options.credential}` }, rejectUnauthorized: true, perMessageDeflate: false, maxPayload: 16_384, handshakeTimeout: 10_000 })
    return new Promise<DeviceSocket>((resolve, reject) => {
      const cleanup = () => { raw.off('open', open); raw.off('error', fail); raw.off('close', fail); raw.off('unexpected-response', rejected); signal.removeEventListener('abort', fail) }
      const rejected = (_request: unknown, response: unknown) => {
        const status = (response as { statusCode?: number })?.statusCode
        const failures: Record<number, import('@foreman-code/contracts/device-connection').DeviceFailureCode> = {
          401: 'authentication', 403: 'permission', 409: 'wrong-main', 410: 'revoked',
        }
        cleanup(); adapted.close(); reject(new DeviceConnectionError(failures[status ?? 0] ?? 'transport'))
      }
      const open = () => { cleanup(); resolve(adapted) }
      const fail = (error?: unknown) => {
        const code = (error as { code?: string })?.code
        const certificateFailure = code?.startsWith('ERR_TLS_CERT_') || ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code ?? '')
        cleanup(); adapted.close(); reject(new DeviceConnectionError(certificateFailure ? 'wrong-main' : 'transport'))
      }
      raw.on('open', open)
      raw.on('error', fail)
      raw.on('close', fail)
      raw.on('unexpected-response', rejected)
      // Classify handshake errors before the adapter closes the socket.
      const adapted = adaptDeviceSocket(raw)
      signal.addEventListener('abort', fail, { once: true })
    })
  }
}

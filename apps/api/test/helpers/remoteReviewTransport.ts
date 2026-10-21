import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { ExecutionAuthorityRequestSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import type { DeviceApplicationFrame } from '@foreman-code/contracts/device-application'
import { RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest }
  from '@foreman-code/contracts/remote-execution-rpc'

/** Forward actual paired frames unchanged. A test can delay authorization at
 * the network boundary; Main still performs the original scope checks. */
export async function createRemoteReviewTransport(input: {
  endpoint: string
  certificateFile: string
  privateKeyFile: string
  beforeAuthorization(request: ReturnType<typeof ExecutionAuthorityRequestSchema.parse>): Promise<void>
  beforeDiscovery?(): Promise<void | 'cancel'>
  beforeCompactionResponse?(): Promise<void>
}) {
  const [cert, key] = await Promise.all([readFile(input.certificateFile), readFile(input.privateKeyFile)])
  const server = createServer({ cert, key })
  const connections = new Set<Socket>()
  server.on('connection', socket => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  const sockets = new Set<WebSocket>()
  let paused = false
  let dropPhysical: (() => void) | undefined
  let loseCompactionResponse = false
  const conversationRequests: WorkerConversationRpcRequest[] = []
  const deliveryReads: Array<{ command: ReturnType<typeof RemoteOwnerControlSchema.parse>; phase: string }> = []
  const websocket = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 16384 })
  websocket.on('connection', (worker, request) => {
    if (paused) { worker.close(); return }
    const main = new WebSocket(input.endpoint, { ca: cert,
      headers: { authorization: request.headers.authorization! }, perMessageDeflate: false })
    sockets.add(worker)
    sockets.add(main)
    const assemblies = new Map<string, { bytes: number; chunks: Buffer[]; received: number }>()
    const readRequests = new Map<string, ReturnType<typeof RemoteOwnerControlSchema.parse>>()
    const compactionRequests = new Set<string>()
    const trace = new Map<string, { bytes: number; chunks: Buffer[]; received: number }>()
    const observe = (data: RawData, direction: 'to-worker' | 'to-main') => {
      const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
      const key = `${direction}:${'id' in frame ? frame.id : ''}`
      if (frame.type === 'application-open' && frame.namespace === 'execution-v1') {
        trace.set(key, { bytes: frame.jsonBytes, chunks: [], received: 0 })
      }
      if (frame.type !== 'application-chunk') return
      const assembly = trace.get(key)
      if (!assembly) return
      const chunk = Buffer.from(frame.data, 'base64')
      assembly.chunks.push(chunk)
      assembly.received += chunk.byteLength
      if (assembly.received !== assembly.bytes) return
      trace.delete(key)
      const payload = JSON.parse(Buffer.concat(assembly.chunks).toString('utf8')) as {
        method?: string; command?: unknown; phase?: string
      }
      if (direction === 'to-worker' && payload.method === 'physical-readout' && dropPhysical) {
        const dropped = dropPhysical
        dropPhysical = undefined
        worker.terminate()
        main.terminate()
        dropped()
        return true
      }
      if (direction === 'to-worker' && payload.method?.startsWith('conversation.')) {
        conversationRequests.push(WorkerConversationRpcRequestSchema.parse(payload))
      }
      if (direction === 'to-worker' && payload.method === 'conversation.compact'
        && loseCompactionResponse) compactionRequests.add(frame.id)
      if (direction === 'to-main' && compactionRequests.has(frame.id)) {
        compactionRequests.delete(frame.id)
        if (loseCompactionResponse) {
          loseCompactionResponse = false
          return true
        }
      }
      if (direction === 'to-worker' && payload.method === 'control-delivery') {
        readRequests.set(frame.id, RemoteOwnerControlSchema.parse(payload.command))
      }
      const command = readRequests.get(frame.id)
      if (direction === 'to-main' && command && payload.phase) {
        deliveryReads.push({ command, phase: payload.phase })
        readRequests.delete(frame.id)
      }
    }
    let ready = false
    const waiting: Array<{ data: RawData; binary: boolean }> = []
    const fail = () => { worker.terminate(); main.terminate() }
    main.on('open', () => {
      ready = true
      for (const message of waiting.splice(0)) main.send(message.data, { binary: message.binary })
    })
    const discoveryFrames = new Map<string, Array<{ data: RawData; binary: boolean }>>()
    main.on('message', (data, binary) => {
      if (observe(data, 'to-worker')) return
      const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
      if (input.beforeDiscovery && frame.type === 'application-open' && frame.kind === 'request'
        && frame.namespace === 'harness-discovery-v1') {
        const waiting = [{ data, binary }]
        discoveryFrames.set(frame.id, waiting)
        void input.beforeDiscovery().then(outcome => {
          discoveryFrames.delete(frame.id)
          if (outcome === 'cancel') {
            main.send(JSON.stringify({ type: 'application-cancel', id: frame.id }))
            return
          }
          for (const message of waiting) worker.send(message.data, { binary: message.binary })
        }).catch(fail)
        return
      }
      const waiting = 'id' in frame ? discoveryFrames.get(frame.id) : undefined
      if (waiting) { waiting.push({ data, binary }); return }
      worker.send(data, { binary })
    })
    main.on('error', fail)
    worker.on('error', fail)
    main.on('close', () => { sockets.delete(main); worker.close() })
    worker.on('close', () => { sockets.delete(worker); main.close() })
    worker.on('message', (data, binary) => {
      const forward = async () => {
        if (observe(data, 'to-main')) {
          await input.beforeCompactionResponse?.()
          fail()
          return
        }
        const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
        if (frame.type === 'application-open' && frame.kind === 'request'
          && frame.namespace === EXECUTION_AUTHORITY_EXTENSION.namespace) {
          assemblies.set(frame.id, { bytes: frame.jsonBytes, chunks: [], received: 0 })
        }
        if (frame.type === 'application-chunk') {
          const assembly = assemblies.get(frame.id)
          if (assembly) {
            const chunk = Buffer.from(frame.data, 'base64')
            assembly.chunks.push(chunk)
            assembly.received += chunk.byteLength
            if (assembly.received === assembly.bytes) {
              assemblies.delete(frame.id)
              const parsed = ExecutionAuthorityRequestSchema.safeParse(
                JSON.parse(Buffer.concat(assembly.chunks).toString('utf8')))
              if (parsed.success) await input.beforeAuthorization(parsed.data)
            }
          }
        }
        if (ready) main.send(data, { binary })
        else waiting.push({ data, binary })
      }
      void forward().catch(fail)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback transport fixture port.')
  return { endpoint: `wss://127.0.0.1:${address.port}/device/connect`, deliveryReads, conversationRequests,
    paused: () => paused,
    pauseConnections() {
      paused = true
      for (const socket of sockets) socket.terminate()
    },
    resumeConnections() { paused = false },
    dropNextPhysicalReadout() {
      if (dropPhysical) throw new Error('A physical readout interruption is already armed.')
      return new Promise<void>(resolve => { dropPhysical = resolve })
    },
    loseNextCompactionResponse: () => { loseCompactionResponse = true },
    close: async () => {
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
      for (const socket of sockets) socket.terminate()
      // TLS connections can exist before any WebSocket upgrade or HTTP request.
      for (const connection of connections) connection.destroy()
      await Promise.all([
        serverClosed,
        new Promise<void>((resolve, reject) => websocket.close(error => error ? reject(error) : resolve())),
      ])
    } }
}

import { once } from 'node:events'
import { createServer } from 'node:https'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it } from 'vitest'
import { createRemoteReviewTls } from './helpers/remoteReviewProvider.js'
import { createRemoteReviewTransport } from './helpers/remoteReviewTransport.js'

it('cancels held discovery at the peer boundary and forwards discovery normally after release', async () => {
  const storage = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'discovery-transport-'))
  const tls = await createRemoteReviewTls(directory)
  const [cert, key] = await Promise.all([readFile(tls.certificateFile), readFile(tls.privateKeyFile)])
  const server = createServer({ cert, key })
  const upstream = new WebSocketServer({ server })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener.')
  let entered!: () => void
  const discovering = new Promise<void>(resolve => { entered = resolve })
  let release!: (outcome?: 'cancel') => void
  const held = new Promise<void | 'cancel'>(resolve => { release = resolve })
  let blocked = true
  const transport = await createRemoteReviewTransport({ ...tls,
    endpoint: `wss://127.0.0.1:${address.port}`,
    beforeAuthorization: async () => {},
    beforeDiscovery: async () => {
      if (blocked) { entered(); return held }
    },
  })
  const connected = once(upstream, 'connection')
  const worker = new WebSocket(transport.endpoint, { ca: cert,
    headers: { authorization: 'Bearer fixture-worker' } })
  const [connection] = await Promise.all([connected, once(worker, 'open')])
  const main = connection[0] as WebSocket
  try {
    const id = randomUUID()
    const open = { type: 'application-open', id, kind: 'request', namespace: 'harness-discovery-v1',
      version: 1, jsonBytes: 2, binaryBytes: 0 }
    const cancelled = once(main, 'message')
    main.send(JSON.stringify(open))
    await discovering
    release('cancel')
    expect(JSON.parse(String((await cancelled)[0]))).toEqual({ type: 'application-cancel', id })

    // A later frame on the same stream is a barrier for any mistakenly forwarded held frames.
    const marker = { type: 'application-cancel', id: randomUUID() }
    const forwarded = once(worker, 'message')
    main.send(JSON.stringify(marker))
    expect(JSON.parse(String((await forwarded)[0]))).toEqual(marker)

    blocked = false
    const next = { ...open, id: randomUUID() }
    const discoveryForwarded = once(worker, 'message')
    main.send(JSON.stringify(next))
    expect(JSON.parse(String((await discoveryForwarded)[0]))).toEqual(next)
  } finally {
    release()
    worker.terminate()
    main.terminate()
    await transport.close()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})

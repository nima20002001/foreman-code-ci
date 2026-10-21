import { get } from 'node:http'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { MemoryBoardService } from './service.js'
import { streamMemoryBoard } from './stream.js'
import type { BoardChange } from './types.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('Memory board HTTP stream lifetime', () => {
  it.each([undefined, 0])('delivers a change between stream connection and first readback with cursor %s', async afterSequence => {
    const committed = deferred<void>()
    const changes: BoardChange[] = []
    let wake: () => void = () => undefined
    let reads = 0
    const service: Pick<MemoryBoardService, 'changes' | 'listen'> = {
      async changes(_principal, input) {
        reads += 1
        if (reads > 1) await committed.promise
        const watermark = changes.length
        const cursor = input.afterSequence ?? watermark
        return { items: changes.filter(change => change.sequence > cursor), nextCursor: null, hasMore: false,
          revision: watermark, watermark, resetRequired: false }
      },
      async listen(_boardId, changed) {
        wake = changed
        return () => undefined
      },
    }
    const principal: ManagementPrincipal = { id: 'stream-reader', name: 'Reader', audience: 'operator',
      grants: [], expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
    const app = Fastify({ logger: false })
    app.get('/events', async (request, reply) => {
      await streamMemoryBoard(request, reply, service, principal, 'board', afterSequence)
      reply.raw.end()
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const change: BoardChange = { id: 'change', boardId: 'board', sequence: 1, boardRevision: 1,
      entity: 'note', entityId: 'note', entityRevision: 1, actor: { kind: 'operator', id: 'writer', displayName: 'Writer' },
      occurredAt: '2026-10-21T00:00:00.000Z' }
    const response = new Promise<string>((resolve, reject) => {
      const request = get(new URL('/events', address), incoming => {
        let body = ''
        incoming.setEncoding('utf8')
        incoming.on('data', (chunk: string) => {
          body += chunk
          if (body.includes(': connected') && !changes.length) {
            changes.push(change)
            wake()
            committed.resolve()
          }
        })
        incoming.once('error', reject)
        incoming.once('end', () => resolve(body))
      })
      request.once('error', reject)
    })
    try {
      expect(await response).toContain(`event: change\nid: 1\ndata: ${JSON.stringify(change)}\n\n`)
    } finally {
      committed.resolve()
      await app.close()
    }
  })

  it('releases a subscription that finishes registering after its HTTP client disconnects', async () => {
    const entering = deferred<void>(), registration = deferred<() => void>()
    const closed = deferred<void>(), completed = deferred<void>()
    let subscribers = 0
    const service: Pick<MemoryBoardService, 'changes' | 'listen'> = {
      async changes() {
        return { items: [], nextCursor: null, hasMore: false, revision: 0, watermark: 0, resetRequired: false }
      },
      async listen() {
        entering.resolve()
        return registration.promise
      },
    }
    const principal: ManagementPrincipal = { id: 'stream-reader', name: 'Reader', audience: 'operator',
      grants: [], expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
    const app = Fastify({ logger: false })
    app.get('/events', async (request, reply) => {
      reply.raw.once('close', () => closed.resolve())
      try { await streamMemoryBoard(request, reply, service, principal, 'board') }
      finally { completed.resolve() }
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const request = get(new URL('/events', address))
    // The expected local abort is observed explicitly instead of becoming an
    // unhandled ClientRequest error while the server is registering its listener.
    const clientError = deferred<Error>()
    request.once('error', error => clientError.resolve(error))
    try {
      await entering.promise
      request.destroy(new Error('Close the visible board'))
      await closed.promise
      subscribers += 1
      registration.resolve(() => { subscribers -= 1 })
      await completed.promise
      expect((await clientError.promise).message).toBe('Close the visible board')
      expect(subscribers).toBe(0)
    } finally {
      request.destroy()
      registration.resolve(() => { subscribers = 0 })
      await app.close()
    }
  })
})

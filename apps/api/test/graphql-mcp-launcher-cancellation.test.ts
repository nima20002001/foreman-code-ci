import type { ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { mcpLauncherFixture } from './support/mcpLauncher.js'
import { rejectableDeferred } from './helpers/deferred.js'

it('aborts only the cancelled stdio HTTP call and suppresses its late result', async () => {
  const started = rejectableDeferred<void>()
  const disconnected = rejectableDeferred<void>()
  const notification = rejectableDeferred<void>()
  const responses = new Map<string | number, ServerResponse>()
  const f = await mcpLauncherFixture((message, response) => {
    if (message.method === 'notifications/cancelled') {
      notification.resolve()
      response.writeHead(202).end()
      return
    }
    if (message.id === 'barrier') {
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }))
      return
    }
    responses.set(message.id!, response)
    if (message.id === 1) response.once('close', () => disconnected.resolve())
    if (responses.size === 2) started.resolve()
  })
  try {
    f.send({ id: 1, method: 'tools/call', params: { name: 'interaction_respond' } })
    f.send({ id: 2, method: 'tools/call', params: { name: 'interaction_respond' } })
    await started.promise
    f.send({ method: 'notifications/cancelled', params: { requestId: 1 } })
    await Promise.all([notification.promise, disconnected.promise])
    responses.get(1)!.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { late: true } }))
    responses.get(2)!.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { committed: true } }))
    expect(await f.receive(2)).toMatchObject({ id: 2, result: { committed: true } })
    f.send({ id: 'barrier', method: 'ping' })
    await f.receive('barrier')
    expect(f.messages.some((message) => message.id === 1)).toBe(false)
  } finally { await f.close() }
}, 10_000)

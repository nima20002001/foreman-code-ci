import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { trackInFlightRequests } from '../apps/api/src/infrastructure/inFlightRequests.ts'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const Fastify = require('fastify')

async function fixture(t) {
  const app = Fastify()
  const tracked = trackInFlightRequests(app, { graceMs: 600, closable: url => url.startsWith('/mcp') })
  app.post('/mcp', async (request, reply) => {
    const tool = request.body.params.name
    if (tool === 'ci_get') return new Promise(() => {})
    await delay(80)
    return reply.send({ saved: true })
  })
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  const send = name => new Promise(resolve => {
    const call = request(`${origin}/mcp`, { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json' } }, response => {
      response.resume()
      response.once('end', () => resolve({ status: response.statusCode }))
    })
    call.once('error', error => resolve({ error: error.code }))
    call.end(JSON.stringify({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name } }))
  })
  const entered = async count => {
    const deadline = Date.now() + 1000
    while (tracked.size() < count && Date.now() < deadline) await delay(5)
    assert.equal(tracked.size(), count)
  }
  return { app, send, entered }
}

test('shutdown cancels read-only CI waits immediately while accepted MCP writes finish', async t => {
  const { app, send, entered } = await fixture(t)
  const reading = send('ci_get')
  const writing = send('workflow_save')
  await entered(2)
  const started = performance.now()
  await app.close()
  const elapsedMs = Math.round(performance.now() - started)
  t.diagnostic(`shutdown elapsedMs=${elapsedMs}`)
  assert.equal((await writing).status, 200)
  assert.equal((await reading).error, 'ECONNRESET')
  assert.ok(elapsedMs < 400, 'a read-only long poll must not consume the mutation shutdown grace')
})

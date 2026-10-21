import { request } from 'node:http'
import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { trackInFlightRequests } from './inFlightRequests.js'

const apps: ReturnType<typeof Fastify>[] = []
afterEach(async () => { await Promise.allSettled(apps.splice(0).map(app => app.close())) })

async function server() {
  const app = Fastify()
  apps.push(app)
  const tracked = trackInFlightRequests(app, { graceMs: 200, closable: url => url.startsWith('/mcp') })
  // A tool call that never answers, like the two MCP calls that held every production stop for 60 s.
  let completeMutation: (() => void) | undefined
  app.post('/mcp', request => {
    const body = request.body as { params?: { name?: string } }
    if (body.params?.name === 'workspace_update') {
      return new Promise(resolve => { completeMutation = () => resolve({ saved: true }) })
    }
    return new Promise(() => {})
  })
  app.post('/slow', () => new Promise(resolve => setTimeout(() => resolve({ done: true }), 400)))
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const port = Number(new URL(address).port)
  const send = (path: string, body: unknown) => new Promise<{ status?: number | undefined; error?: string | undefined }>(resolve => {
    const call = request({ host: '127.0.0.1', port, path, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json' } },
      response => { response.resume(); response.on('end', () => resolve({ status: response.statusCode })) })
    call.on('error', error => resolve({ error: (error as NodeJS.ErrnoException).code ?? error.message }))
    call.end(JSON.stringify(body))
  })
  return { app, tracked, send, completeMutation: () => completeMutation!() }
}

it('names in-flight requests, including the MCP tool being called', async () => {
  const { tracked, send } = await server()
  void send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run' } })
  await expect.poll(() => tracked.describe()).toEqual(['POST /mcp ci_run'])
})

it('ends hung MCP calls after the grace so closing does not wait for them', async () => {
  const { app, send } = await server()
  const hung = send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_run' } })
  const slow = send('/slow', {})
  await new Promise(resolve => setTimeout(resolve, 50))
  const started = Date.now()
  await app.close()
  // Other requests still finish; only the MCP call is cut, after the grace instead of systemd's 60 s timeout.
  expect(Date.now() - started).toBeLessThan(2000)
  expect((await hung).error).toBeDefined()
  expect((await slow).status).toBe(200)
})

it('lets a completing MCP mutation reply during shutdown grace while disconnecting a hung call', async () => {
  const { app, tracked, send, completeMutation } = await server()
  const hung = send('/mcp', { method: 'tools/call', params: { name: 'ci_run' } })
  const mutation = send('/mcp', { method: 'tools/call', params: { name: 'workspace_update' } })
  await expect.poll(() => tracked.describe()).toEqual(['POST /mcp ci_run', 'POST /mcp workspace_update'])
  const closing = app.close()
  // Release after shutdown has started, comfortably inside the 200 ms grace.
  await new Promise(resolve => setTimeout(resolve, 50))
  completeMutation()
  expect(await mutation).toEqual({ status: 200 })
  await closing
  expect((await hung).error).toBeDefined()
})

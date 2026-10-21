import Fastify from 'fastify'
import { afterEach, expect, it } from 'vitest'
import { requestDatabaseCommand } from './helpers/requestDatabaseCommand.js'

const apps: ReturnType<typeof Fastify>[] = []
const busy = { error: { code: 'DATABASE_BUSY', details: { retryable: true, newCommandRequired: false } } }

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

function fixture(replies: { status: number; body: object }[]) {
  const app = Fastify()
  apps.push(app)
  const seen: unknown[] = []
  app.post('/command', async (request, reply) => {
    const response = replies[Math.min(seen.length, replies.length - 1)]!
    seen.push(request.body)
    return reply.code(response.status).send(response.body)
  })
  const payload = { commandId: 'original-command', runId: 'run-1' }
  const request = () => requestDatabaseCommand(async () => app.inject({
    method: 'POST', url: '/command', payload,
  }))
  return { request, seen, payload }
}

it('retries database contention with the unchanged command until the request succeeds', async () => {
  const f = fixture([
    { status: 503, body: busy },
    { status: 503, body: busy },
    { status: 200, body: { runId: 'run-1', replayed: false } },
  ])
  const response = await f.request()
  expect(response.statusCode, response.body).toBe(200)
  expect(response.json()).toEqual({ runId: 'run-1', replayed: false })
  expect(f.seen).toEqual([f.payload, f.payload, f.payload])
})

it('returns persistent database contention after ten attempts', async () => {
  const f = fixture([{ status: 503, body: busy }])
  const response = await f.request()
  expect(response.statusCode).toBe(503)
  expect(response.json()).toEqual(busy)
  expect(f.seen).toEqual(Array.from({ length: 10 }, () => f.payload))
})

it.each([
  { status: 403, body: { error: { code: 'ACCESS_DENIED' } } },
  { status: 409, body: { error: { code: 'GRAPH_RESUME_OWNER_LOST' } } },
  { status: 503, body: { error: { code: 'DATABASE_BUSY', details: { retryable: false } } } },
  { status: 503, body: { error: { code: 'DATABASE_BUSY' } } },
  { status: 503, body: { error: { code: 'COMMAND_DATABASE_TIMEOUT', details: { retryable: true } } } },
])('returns $status $body without retrying other failures', async failure => {
  const f = fixture([failure, { status: 200, body: {} }])
  const response = await f.request()
  expect(response.statusCode).toBe(failure.status)
  expect(response.json()).toEqual(failure.body)
  expect(f.seen).toEqual([f.payload])
})

it('propagates request failures without resubmitting an unknown outcome', async () => {
  const failure = new Error('connection closed')
  let attempts = 0
  await expect(requestDatabaseCommand(async () => {
    attempts++
    throw failure
  })).rejects.toBe(failure)
  expect(attempts).toBe(1)
})

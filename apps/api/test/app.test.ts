import { once } from 'node:events'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('operational endpoints', () => {
  it('closes accepted connections that have not sent an HTTP request', async () => {
    const app = buildApp({ readiness: {
      database: { ping: async () => undefined },
      checkpoints: { ping: async () => undefined },
    } })
    apps.push(app)
    const origin = new URL(await app.listen({ host: '127.0.0.1', port: 0 }))
    const accepted = once(app.server, 'connection')
    const socket = connect({ host: origin.hostname, port: Number(origin.port) })
    let timer: ReturnType<typeof setTimeout> | undefined
    const closing = accepted.then(() => app.close())
    try {
      const completed = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_000) }),
      ])
      expect(completed).toBe(true)
    } finally {
      clearTimeout(timer)
      socket.destroy()
      await closing
    }
  })

  it('drains an in-flight readiness request during shutdown', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const app = buildApp({ readiness: {
      database: { ping: async () => { entered(); await waiting } },
      checkpoints: { ping: async () => undefined },
    } })
    apps.push(app)
    let stopping!: () => void
    const shutdownStarted = new Promise<void>(resolve => { stopping = resolve })
    app.addHook('preClose', async () => { stopping() })
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = fetch(`${origin}/health/ready`).then(async value => ({
      status: value.status, body: await value.json(),
    }))
    await started
    const closing = app.close()
    await shutdownStarted
    release()
    expect(await response).toMatchObject({ status: 200, body: { status: 'ok' } })
    await closing
  })

  it('reports liveness without consulting infrastructure', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => { throw new Error('must not run') } },
        checkpoints: { ping: async () => { throw new Error('must not run') } },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'graphql-api' })
  })

  it('reports each readiness dependency', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => undefined },
        checkpoints: { ping: async () => { throw new Error('offline') } },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: 'unavailable',
      service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'unavailable' },
    })
  })

  it('returns contract-shaped not-found errors', async () => {
    const app = buildApp({
      readiness: {
        database: { ping: async () => undefined },
        checkpoints: { ping: async () => undefined },
      },
    })
    apps.push(app)

    const response = await app.inject({ method: 'GET', url: '/api/not-real' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'The requested API route was not found.' },
    })
    expect(response.json().error.requestId).toEqual(expect.any(String))
  })
})

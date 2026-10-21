import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { resolveProductEnvironment } from '@foreman-code/contracts/product-environment'

const apps: ReturnType<typeof buildApp>[] = []
const healthy = () => ({
  database: { ping: async () => undefined },
  checkpoints: { ping: async () => undefined },
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('readiness deadlines', () => {
  it.each(['database', 'checkpoints'] as const)(
    'bounds and coalesces a non-cooperative %s check',
    async (dependency) => {
      let signal: AbortSignal | undefined
      const ping = vi.fn((received?: AbortSignal) => {
        signal = received
        return new Promise<void>(() => undefined)
      })
      const readiness = { ...healthy(), [dependency]: { ping } }
      const app = buildApp({ readiness, readinessTimeoutMs: 30 })
      apps.push(app)
      const started = Date.now()
      const responses = await Promise.all(Array.from({ length: 8 }, () =>
        app.inject({ method: 'GET', url: '/health/ready' }),
      ))
      expect(Date.now() - started).toBeLessThan(1000)
      expect(responses.every((response) => response.statusCode === 503)).toBe(true)
      expect(responses[0]?.json().checks[dependency]).toBe('unavailable')
      expect(signal?.aborted).toBe(true)
      expect(ping).toHaveBeenCalledTimes(1)
      // A check that ignores abort must not start more work on later probes.
      expect((await app.inject('/health/ready')).statusCode).toBe(503)
      expect(ping).toHaveBeenCalledTimes(1)
      expect((await app.inject('/health/live')).statusCode).toBe(200)
    },
  )

  it('recovers after a canceled check has cleaned up', async () => {
    const ping = vi.fn<(signal?: AbortSignal) => Promise<void>>()
      .mockImplementationOnce((signal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      .mockResolvedValue(undefined)
    const app = buildApp({
      readiness: { ...healthy(), checkpoints: { ping } },
      readinessTimeoutMs: 20,
    })
    apps.push(app)
    expect((await app.inject('/health/ready')).statusCode).toBe(503)
    expect((await app.inject('/health/ready')).statusCode).toBe(200)
    expect(ping).toHaveBeenCalledTimes(2)
  })

  it('handles a synchronous dependency exception', async () => {
    const app = buildApp({
      readiness: {
        ...healthy(),
        database: { ping: () => { throw new Error('offline') } },
      },
    })
    apps.push(app)
    expect((await app.inject('/health/ready')).statusCode).toBe(503)
  })

  it.each([0, -1, Infinity, 2147483648])('rejects invalid deadline %s', (readinessTimeoutMs) => {
    expect(() => buildApp({ readiness: healthy(), readinessTimeoutMs })).toThrow(RangeError)
  })
})

describe('logger injection', () => {
  it.each([false, true])('constructs with logging set to %s', async (logger) => {
    const app = buildApp({ readiness: healthy(), logger })
    apps.push(app)
    expect((await app.inject('/health/live')).statusCode).toBe(200)
  })

  it('accepts an existing Fastify logger instance', async () => {
    const owner = Fastify({ logger: true })
    const app = buildApp({ readiness: healthy(), logger: owner.log })
    apps.push(app, owner)
    expect((await app.inject('/health/live')).statusCode).toBe(200)
  })
})

it('sanitizes unexpected errors even when they claim a client status', async () => {
  const app = buildApp({ readiness: healthy() })
  apps.push(app)
  app.post('/unexpected-error', async () => {
    throw Object.assign(new Error('private implementation detail'), { code: 'UNEXPECTED_FAILURE', statusCode: 400 })
  })
  const response = await app.inject({ method: 'POST', url: '/unexpected-error' })
  expect(response.statusCode).toBe(500)
  expect(response.json()).toEqual({ error: {
    code: 'INTERNAL_ERROR', message: 'The API could not complete the request.', requestId: expect.any(String),
  } })
})

it('loads configurable deadlines for both PostgreSQL pools and readiness', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql',
    DATABASE_CONNECTION_TIMEOUT_MS: '123',
    DATABASE_QUERY_TIMEOUT_MS: '456',
    READINESS_TIMEOUT_MS: '789',
  })
  expect(config.database.connectionTimeoutMs).toBe(123)
  expect(config.database.queryTimeoutMs).toBe(456)
  expect(config.readinessTimeoutMs).toBe(789)
  expect(config.harnesses.codexBinary).toBe(harnessBinaries(resolveProductEnvironment({
    DATABASE_URL: config.database.connectionString,
  })).codexBinary)
  expect(loadConfig({ DATABASE_URL: config.database.connectionString, CODEX_BINARY: 'codex' }).harnesses.codexBinary)
    .toBe(harnessBinaries({ CODEX_BINARY: 'codex' }).codexBinary)
  expect(loadConfig({ DATABASE_URL: config.database.connectionString, CODEX_BINARY: '/opt/codex' }).harnesses.codexBinary)
    .toBe('/opt/codex')
  expect(() => loadConfig({ DATABASE_URL: config.database.connectionString, READINESS_TIMEOUT_MS: '0' }))
    .toThrow()
})

it('accepts a separate production workspace root and rejects relative storage', () => {
  const environment = {
    DATABASE_URL: 'postgresql://graphql_production:fixture@127.0.0.1:55440/graphql_production',
    WORKSPACE_STORAGE_ROOT: '/srv/graphql-production/workspaces',
  }
  expect(loadConfig(environment).workspaceStorageRoot).toBe(environment.WORKSPACE_STORAGE_ROOT)
  expect(() => loadConfig({ ...environment, WORKSPACE_STORAGE_ROOT: 'workspaces' })).toThrow()
})

import { setTimeout as delay } from 'node:timers/promises'
import Fastify from 'fastify'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: undefined as ReturnType<typeof Fastify> | undefined,
  calls: [] as string[],
  finishRecovery: undefined as (() => void) | undefined,
  listeners: new Map<string, () => void>(),
  pingFailures: [] as Error[],
  pingCalls: 0,
  initializeCalls: 0,
  databaseClosed: false,
  drainFailure: undefined as Error | undefined,
  drain: undefined as Promise<void> | undefined,
  productionClose: undefined as (() => Promise<void>) | undefined,
  blockRecovery: true,
  ownerFailure: undefined as Error | undefined,
  schemaChanges: [] as string[],
  ownerHeld: false,
  errors: [] as { message: string; error: unknown }[],
}))
vi.mock('@foreman-code/contracts/product-environment-node', () => ({ loadProductEnvFile: () => undefined }))
vi.mock('node:fs/promises', async original => ({
  ...(await original<typeof import('node:fs/promises')>()),
  mkdir: async () => undefined,
  realpath: async (path: string) => path,
}))
// Native qualification belongs to buildProductionApp, which this lifecycle fixture replaces.
vi.mock('../src/modules/harnesses/qualification/suites/codex.js', () => ({ codexQualificationSuite: {} }))
vi.mock('../src/infrastructure/logger.js', async original => ({
  ...(await original<typeof import('../src/infrastructure/logger.js')>()),
  enableFileLogging: async () => undefined,
  componentLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: (context: { err: unknown }, message: string) => state.errors.push({ message, error: context.err }),
    fatal: (context: { err: unknown }, message: string) => state.errors.push({ message, error: context.err }),
  }),
}))
vi.mock('../src/infrastructure/processLifecycle.js', () => ({ installProcessLifecycleLogging: () => undefined }))
vi.mock('../src/config.js', () => ({ loadConfig: () => ({ database: {}, checkpoints: { schema: 'test' }, harnesses: { workspaceRoot: process.env.HARNESS_WORKSPACE_ROOT }, host: '127.0.0.1', port: 0 }) }))
vi.mock('../src/modules/byte-transfer/installedEntrypoints.js', () => ({ readMainRsyncEntrypoint: async () => ({ kind: 'unavailable', reason: 'Startup lifecycle fixture has no installed rsync selection.' }) }))
vi.mock('../src/infrastructure/database.js', () => ({ createDatabase: () => ({
  pool: {},
  ping: async () => {
    state.pingCalls += 1
    if (state.databaseClosed) throw new Error('Cannot use a pool after calling end on the pool')
    const failure = state.pingFailures.shift()
    if (failure) throw failure
  },
  migrate: async () => { state.schemaChanges.push('application'); expect(state.ownerHeld).toBe(true) },
  close: async () => {
    state.databaseClosed = true
    state.calls.push('database closed')
  },
}) }))
vi.mock('../src/infrastructure/checkpoints.js', () => ({ createCheckpointStore: () => ({
  setup: async () => { state.schemaChanges.push('checkpoints'); expect(state.ownerHeld).toBe(true) }, ping: async () => undefined,
  close: async () => { state.calls.push('checkpoints closed') },
}) }))
vi.mock('../src/production.js', () => ({ buildProductionApp: (...args: unknown[]) => {
  const infrastructure = args[7] as { closeInfrastructure?: () => Promise<void> }
  if (infrastructure.closeInfrastructure) {
    state.app!.addHook('onClose', async () => { await infrastructure.closeInfrastructure!() })
  }
  if (state.productionClose) {
    state.app!.addHook('onClose', async () => { await state.productionClose!() })
  }
  return {
    app: state.app,
    prepareSchema: async () => {
      if (state.ownerFailure) throw state.ownerFailure
      state.ownerHeld = true
      const { createDatabase } = await import('../src/infrastructure/database.js')
      const { createCheckpointStore } = await import('../src/infrastructure/checkpoints.js')
      await createDatabase({ connectionString: '', maxConnections: 1, connectionTimeoutMs: 1 }).migrate()
      await createCheckpointStore('', 'test').setup()
    },
    rsync: { kind: 'unavailable' },
    registerFileStorage: () => { expect(state.listeners.has('SIGTERM')).toBe(true) },
    startDeviceListener: async () => undefined,
    initialize: async () => { state.initializeCalls += 1 },
    reconcile: async () => {
      state.calls.push('recovery started')
      if (state.blockRecovery) {
        await new Promise<void>((resolve) => { state.finishRecovery = resolve })
      }
    },
    drainShutdown: () => {
      state.drain ??= Promise.resolve().then(() => {
        state.calls.push('native shutdown')
        state.finishRecovery?.()
        if (state.drainFailure) throw state.drainFailure
      })
      return state.drain
    },
  }
} }))

let previousExitCode: NodeJS.Process['exitCode']

beforeEach(() => {
  vi.resetModules()
  state.calls = []
  state.listeners.clear()
  state.finishRecovery = undefined
  state.pingFailures = []
  state.pingCalls = 0
  state.initializeCalls = 0
  state.databaseClosed = false
  state.drainFailure = undefined
  state.drain = undefined
  state.productionClose = undefined
  state.blockRecovery = true
  state.errors = []
  state.ownerHeld = false
  state.ownerFailure = undefined
  state.schemaChanges = []
  previousExitCode = process.exitCode
  state.app = Fastify()
  vi.spyOn(process, 'once').mockImplementation(function (
    this: NodeJS.Process,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) {
    if (event === 'SIGTERM' || event === 'SIGINT') state.listeners.set(event, listener)
    return this
  })
  vi.spyOn(state.app, 'listen').mockImplementation(async () => {
    expect(state.listeners.has('SIGTERM')).toBe(true)
    await state.app!.ready()
    state.calls.push('listening')
    return 'http://localhost:0'
  })
})

afterEach(async () => {
  state.finishRecovery?.()
  const [closed] = await Promise.allSettled([state.app!.close()])
  if (closed!.status === 'rejected' && !state.drainFailure) throw closed!.reason
  process.exitCode = previousExitCode
  vi.restoreAllMocks()
})

it('handles SIGTERM while startup recovery is still running and closes all resources', async () => {
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.calls).toContain('recovery started'))
  state.listeners.get('SIGTERM')!()
  await vi.waitFor(() => expect(state.calls).toContain('database closed'))
  await delay(5)
  expect(state.calls).toEqual(['listening', 'recovery started', 'native shutdown', 'checkpoints closed', 'database closed'])
})

it('retries a transient startup database read before initializing the application once', async () => {
  state.pingFailures = [new Error('Query read timeout')]
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.calls).toContain('recovery started'))
  expect(state.pingCalls).toBe(2)
  expect(state.initializeCalls).toBe(1)
  expect(state.errors).toEqual([])
  expect(state.databaseClosed).toBe(false)
})

it('fails a permanent database authentication error without replaying startup', async () => {
  const failure = Object.assign(new Error('password authentication failed'), { code: '28P01' })
  state.pingFailures = [failure]
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.errors).toContainEqual({ message: 'api failed to start', error: failure }))
  expect(state.pingCalls).toBe(1)
  expect(state.initializeCalls).toBe(0)
  expect(state.databaseClosed).toBe(true)
})

it('keeps the infrastructure open when runtime shutdown is incomplete', async () => {
  state.drainFailure = new Error('Runtime ownership has not been released')
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.calls).toContain('recovery started'))
  state.listeners.get('SIGTERM')!()
  await vi.waitFor(() => expect(state.errors).toContainEqual({ message: 'shutdown failed', error: state.drainFailure }))
  expect(state.calls).not.toContain('database closed')
  expect(state.calls).not.toContain('checkpoints closed')
})

it('finishes older production close hooks while database access is still available', async () => {
  state.productionClose = async () => {
    const { createDatabase } = await import('../src/infrastructure/database.js')
    await createDatabase({ connectionString: '', maxConnections: 1, connectionTimeoutMs: 1 }).ping()
    state.calls.push('production database cleanup')
  }
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.calls).toContain('recovery started'))
  state.listeners.get('SIGTERM')!()
  await vi.waitFor(() => expect(state.calls).toContain('database closed'))
  expect(state.errors).toEqual([])
  expect(state.calls.indexOf('production database cleanup')).toBeLessThan(state.calls.indexOf('database closed'))
})

it('rejects an occupied runtime before applying either schema migration', async () => {
  state.ownerFailure = new Error('Another API owns this database')
  await import('../src/server.js')
  await vi.waitFor(() => expect(state.errors).toContainEqual({ message: 'api failed to start', error: state.ownerFailure }))
  expect(state.schemaChanges).toEqual([])
  expect(state.initializeCalls).toBe(0)
  expect(state.databaseClosed).toBe(true)
})

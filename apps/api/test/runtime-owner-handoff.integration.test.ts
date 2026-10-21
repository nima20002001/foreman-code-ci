import { createFixtureDatabase, dropFixtureDatabase } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'
import { NativeProcessRegistry, type NativeRegistryChange } from '../src/modules/harnesses/recovery/processRegistry.js'
import { processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { deferred } from './helpers/deferred.js'

// Runtime-owner advisory locks are DATABASE scoped, not schema scoped. Use a
// disposable database so parallel production integration files cannot collide.
// The test role needs CREATEDB; never alter its privileges or skip on failure.
const connectionString = process.env.TEST_DATABASE_URL!
const databaseName = `runtime_owner_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Client({ connectionString })
const isolatedUrl = new URL(connectionString)
isolatedUrl.pathname = `/${databaseName}`
const owners: OperatorRuntimeOwner[] = []
let created = false

beforeAll(async () => {
  await admin.connect()
  await createFixtureDatabase(admin, databaseName, "template template0")
  created = true
}, 15_000)
afterEach(async () => {
  // These fixtures own no native processes. Tests settle their artificial gates
  // before this deliberate teardown of even a retained-on-failure owner.
  const results = await Promise.allSettled(owners.splice(0).map((owner) => owner.close()))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Runtime-owner database fixture cleanup failed.')
})
afterAll(async () => {
  try { if (created) await dropFixtureDatabase(admin, databaseName) } finally { await admin.end() }
})

function owner() {
  const value = new OperatorRuntimeOwner(isolatedUrl.toString(), vi.fn())
  owners.push(value)
  return value
}

describe('PostgreSQL runtime owner handoff', () => {
  it('joins an unstarted guardian before retiring its watched registration and releasing ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-registry-shutdown-'))
    const registry = new NativeProcessRegistry(root)
    const watching = new AbortController()
    const guardian = spawn(process.execPath, ['-e',
      'process.on("message", () => process.exit(0)); process.send("ready")',
    ], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const exited = once(guardian, 'exit')
    let changes: AsyncIterator<NativeRegistryChange> | undefined
    let finishing: Promise<unknown> | undefined
    try {
      await once(guardian, 'message')
      const first = owner()
      await first.acquire()
      const recovery = await registry.reserveLaunch(`diagnostic:${randomUUID()}`)
      const directory = join(root, createHash('sha256').update(recovery.owner).digest('hex'), recovery.launchId!)
      const identity = guardian.pid && processIdentity(guardian.pid)
      if (!identity) throw new Error('The fixture guardian identity is unavailable.')
      writeRecord(join(directory, 'dispatched.json'), { format: 1, id: recovery.launchId, guardian: identity })
      writeRecord(join(directory, 'not-started.json'), { id: recovery.launchId, owner: recovery.owner })
      const initial = registry.snapshot()
      expect(initial.launches).toContainEqual(expect.objectContaining({
        launchId: recovery.launchId, lifecycle: 'closure-unconfirmed', guardian: {
          pid: identity.pid, startTicks: identity.startTicks,
        },
      }))
      changes = registry.changes(initial.revision, watching.signal)[Symbol.asyncIterator]()
      const observed = changes.next()
      const entered = deferred()
      const shutdown = new RuntimeShutdown({
        stop: [{ name: 'native process', run: () => {
          const closing = registry.closeOwner(recovery.owner)
          entered.resolve()
          return closing
        } }],
        drain: [{ name: 'registry observation', run: async () => {
          watching.abort()
          await changes!.return?.()
        } }],
        dispose: [],
        releaseOwnership: () => first.close(),
      })
      // Capture rejection immediately while checking the still-held real database lock.
      finishing = shutdown.finish().then(() => undefined, (error: unknown) => error)
      await entered.promise
      await expect(owner().acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
      expect(registry.closedRegistration(recovery.owner, recovery.launchId!)).toBeUndefined()
      await expect(registry.reserveLaunch(recovery.owner)).rejects.toThrow()
      guardian.send('stop')
      expect((await exited)[0]).toBe(0)
      expect(await finishing).toBeUndefined()
      expect((await observed).value?.launches).toContainEqual(expect.objectContaining({
        launchId: recovery.launchId, lifecycle: 'closed', closureEvidence: 'native_not_started',
      }))
      expect(registry.closedRegistration(recovery.owner, recovery.launchId!)).toMatchObject({
        launchId: recovery.launchId, lifecycle: 'closed', closureEvidence: 'native_not_started',
      })
      await expect(registry.closeOwner(recovery.owner)).resolves.toBe(true)
      await expect(owner().acquire()).resolves.toBeUndefined()
    } finally {
      watching.abort()
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGTERM')
      await exited
      await changes?.return?.()
      await finishing
      rmSync(root, { recursive: true, force: true })
      registry.snapshot()
    }
  }, 15_000)

  for (const pendingStage of ['runtime', 'reconciliation', 'manager'] as const) {
    it(`rejects a second real owner while ${pendingStage} cleanup is pending, then allows handoff`, async () => {
      const first = owner()
      await first.acquire()
      const pending = deferred(); const entered = deferred()
      const hold = () => { entered.resolve(); return pending.promise }
      const released = vi.fn(() => first.close())
      const shutdown = new RuntimeShutdown({
        stop: [{ name: 'runtime', run: pendingStage === 'runtime' ? hold : async () => undefined }],
        drain: [{ name: 'reconciliation', run: pendingStage === 'reconciliation' ? hold : async () => undefined }],
        dispose: [{ name: 'native manager', run: pendingStage === 'manager' ? hold : async () => undefined }],
        releaseOwnership: released,
      })
      const app = Fastify()
      app.addHook('preClose', async () => { shutdown.begin() })
      app.addHook('onClose', async () => { await shutdown.finish() })
      // Match server.ts's second hook without ever re-entering app.close().
      app.addHook('onClose', async () => { await shutdown.finish() })
      await app.ready()
      const closing = app.close()
      try {
        await entered.promise
        await expect(owner().acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
        expect(released).not.toHaveBeenCalled()
        pending.resolve()
        await closing
        expect(released).toHaveBeenCalledTimes(1)
        await expect(owner().acquire()).resolves.toBeUndefined()
      } finally {
        pending.resolve()
        await closing
      }
    }, 15_000)
  }

  it('keeps the real owner connection held when protected cleanup reports uncertainty', async () => {
    const first = owner()
    await first.acquire()
    const dispose = vi.fn(async () => undefined)
    const release = vi.fn(() => first.close())
    const shutdown = new RuntimeShutdown({
      stop: [{ name: 'runtime', run: async () => { throw new Error('native closure is not confirmed') } }],
      drain: [], dispose: [{ name: 'remaining cleanup', run: dispose }], releaseOwnership: release,
    })
    await expect(shutdown.finish()).rejects.toThrow('runtime ownership was not released')
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    await expect(owner().acquire()).rejects.toMatchObject({ code: 'OPERATOR_API_ALREADY_OWNED' })
    await expect(shutdown.finish()).rejects.toThrow('runtime ownership was not released')
    expect(release).not.toHaveBeenCalled()
  })

  it('coalesces owner acquisition and close without taking stacked advisory locks', async () => {
    const first = owner()
    const acquiring = first.acquire()
    expect(first.acquire()).toBe(acquiring)
    await acquiring
    const closing = first.close()
    expect(first.close()).toBe(closing)
    await closing
    await expect(owner().acquire()).resolves.toBeUndefined()
  })
})

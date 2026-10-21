import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

it.each(['owner', 'registration'] as const)(
  'rejects admission while %s closure awaits a live guardian, then retires after exit', async operation => {
    const root = await privateFixtureDirectory('native-retirement-admission-')
    const registry = new NativeProcessRegistry(root)
    const guardian = spawn(process.execPath, ['-e',
      'process.on("message", () => process.exit(0)); process.send("ready")',
    ], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const exited = once(guardian, 'exit')
    let closure: Promise<{ closed: true } | { error: unknown }> | undefined
    try {
      await once(guardian, 'message')
      const recovery = await registry.reserveLaunch(`diagnostic:${randomUUID()}`)
      const identity = guardian.pid && processIdentity(guardian.pid)
      if (!identity) throw new Error('The fixture guardian identity is unavailable.')
      const directory = join(root, createHash('sha256').update(recovery.owner).digest('hex'), recovery.launchId!)
      writeRecord(join(directory, 'dispatched.json'), { format: 1, id: recovery.launchId, guardian: identity })
      writeRecord(join(directory, 'not-started.json'), { id: recovery.launchId, owner: recovery.owner })
      const closing = operation === 'owner' ? registry.closeOwner(recovery.owner)
        : registry.closeRegistration(recovery, recovery.launchId!)
      closure = closing.then(() => ({ closed: true as const }), (error: unknown) => ({ error }))
      // Cross an event-loop turn so closure reaches its guardian wait before the competing admission.
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(registry.reserveLaunch(recovery.owner)).rejects.toThrow('active or unconfirmed')
      expect(registry.closedRegistration(recovery.owner, recovery.launchId!)).toBeUndefined()
      guardian.send('stop')
      expect((await exited)[0]).toBe(0)
      expect(await closure).toEqual({ closed: true })
      expect(registry.closedRegistration(recovery.owner, recovery.launchId!)).toMatchObject({
        launchId: recovery.launchId, lifecycle: 'closed', closureEvidence: 'native_not_started',
      })
      await expect(registry.closeOwner(recovery.owner)).resolves.toBe(true)
      await expect(registry.closeRegistration(recovery, recovery.launchId!)).resolves.toBeUndefined()
    } finally {
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGTERM')
      await exited
      await closure
      await rm(root, { recursive: true, force: true })
      registry.snapshot()
    }
  })

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setTimeout as delay } from 'node:timers/promises'
import { describe, it } from 'vitest'

import { runJsonlProcess, spawnOwnedStdioProcess, stopProcess } from '../src/modules/harnesses/process.js'
import { NativeProcessRegistry, prepareNativeProcessRecovery, spawnNativeProcess, stopRecoveredChild } from '../src/modules/harnesses/recovery/processRegistry.js'
import { bootIdentity, identityAlive, processIdentity, sessionAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateDirectory, writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { cgroupBoundary, cgroupPopulated, cgroupRemoved } from '../src/modules/harnesses/recovery/cgroupBoundary.js'

const owner = 'native-process-fixture-owner'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-process-ownership-'))
  const directory = privateDirectory(join(root, createHash('sha256').update(owner).digest('hex')))
  const registry = new NativeProcessRegistry(root)
  return { root, directory, registry, scope: registry.scope(owner) }
}
function launch(id: string) {
  return { format: 1, id, owner, boot: bootIdentity(), parent: processIdentity(process.pid)!, controlKey: 'a'.repeat(64) }
}
function seedClosed(directory: string, id: string, oldBoot = false) {
  const path = join(directory, id)
  mkdirSync(path, { mode: 0o700 })
  const intent = launch(id)
  if (oldBoot) intent.boot = 'earlier-boot'
  // Fixture data represents already-durable certificates from prior cleanup.
  // Reusing a now-live numeric parent identity must not invalidate closed work.
  writeFileSync(join(path, 'intent.json'), JSON.stringify(intent), { mode: 0o600 })
  writeFileSync(join(path, 'closed.json'), JSON.stringify(oldBoot
    ? { format: 1, id, owner, evidence: 'linux_boot_or_session_absence' }
    : { format: 2, id, owner, boot: intent.boot, evidence: 'native_not_started' }), { mode: 0o600 })
}
async function closed(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
}

// These tests never signal a stored application PID. Test teardown only kills
// freshly launched, identity-checked fixture children owned by the test itself.
describe.skipIf(process.platform !== 'linux')('Linux native process ownership', () => {
  for (const oldMarker of [false, true]) it(`a setsid descendant prevents false legacy closure (old closed marker=${oldMarker})`, async () => {
    const f = fixture()
    const parent = spawn(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      console.log(child.pid); child.unref();
    `], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const original = processIdentity(parent.pid!)!
    let descendant: ReturnType<typeof processIdentity>
    try {
      let output = ''
      for await (const chunk of parent.stdout) output += String(chunk)
      await closed(parent)
      descendant = processIdentity(Number(output.trim()))
      assert.ok(descendant)
      assert.equal(descendant.session, descendant.pid)
      assert.notEqual(descendant.session, original.session)
      assert.equal(sessionAlive(original.session), false)
      const id = randomUUID()
      const path = privateDirectory(join(f.directory, id))
      writeRecord(join(path, 'intent.json'), launch(id))
      writeRecord(join(path, 'birth.json'), { format: 1, id, owner, boot: bootIdentity(), guardian: original })
      if (oldMarker) writeRecord(join(path, 'closed.json'), { format: 1, id, owner, evidence: 'linux_boot_or_session_absence' })
      await assert.rejects(f.registry.closeRegistration(f.scope, id, AbortSignal.timeout(150)))
      assert.ok(identityAlive(descendant))
      assert.ok(existsSync(join(path, 'intent.json')))
      await assert.rejects(async () => spawnNativeProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: f.root, env: {}, recovery: await prepareNativeProcessRecovery(f.scope),
      }), /active or unconfirmed/)
    } finally {
      if (descendant && identityAlive(descendant)) process.kill(-descendant.pid, 'SIGKILL')
      if (identityAlive(original)) process.kill(-original.pid, 'SIGKILL')
      await closed(parent)
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 10_000)

  it('compacts more than 10,000 proven closed launches before applying the active-work bound', async () => {
    const f = fixture()
    let child: ChildProcessWithoutNullStreams | undefined
    try {
      const ids = Array.from({ length: 10_005 }, () => randomUUID())
      for (const [index, id] of ids.entries()) seedClosed(f.directory, id, index < 3)
      assert.equal(await f.registry.closeOwner(owner), true)
      const reopened = new NativeProcessRegistry(f.root)
      for (const id of [ids[0]!, ids.at(-1)!]) {
        assert.equal(reopened.closedRegistration(owner, id)?.lifecycle, 'closed')
      }
      assert.equal(await f.registry.closeOwner(owner), true)
      child = spawnNativeProcess(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.root, env: {}, recovery: await prepareNativeProcessRecovery(f.scope) })
      child.stdout.resume(); child.stderr.resume()
      assert.ok(child.pid)
      assert.equal(await stopRecoveredChild(child), true)
      assert.equal(await stopRecoveredChild(child), true) // Never fall through to PID signaling after GC.
    } finally {
      if (child) { await stopRecoveredChild(child); await closed(child) }
      rmSync(f.root, { recursive: true, force: true })
    }
  // Every registration keeps a durable receipt, including on slower disks.
  }, 1_200_000)

  it('resumes a partially deleted retirement tombstone, but retains unresolved work', async () => {
    const f = fixture()
    try {
      const retiredId = randomUUID()
      const tombstone = privateDirectory(join(f.directory, `.retired-${retiredId}`))
      writeRecord(join(tombstone, 'partial.json'), { remaining: true })
      writeRecord(join(f.directory, 'retired.json'), { format: 2, id: retiredId, owner })
      assert.equal(await f.registry.closeOwner(owner), true)
      assert.ok(!existsSync(tombstone))
      // A direct Stop retry after GC can still prove THIS registration closed.
      await f.registry.closeRegistration(f.scope, retiredId)
      await assert.rejects(f.registry.closeRegistration(f.scope, randomUUID()), { code: 'ENOENT' })
      const id = randomUUID()
      const active = privateDirectory(join(f.directory, id))
      writeRecord(join(active, 'intent.json'), launch(id))
      await assert.rejects(f.registry.closeOwner(owner, AbortSignal.timeout(100)))
      assert.ok(existsSync(join(active, 'intent.json')))
      await assert.rejects(async () => spawnNativeProcess(process.execPath, [], { cwd: f.root, env: {}, recovery: await prepareNativeProcessRecovery(f.scope) }), /active or unconfirmed/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('coalesces cleanup and recovers the exact receipt after GC; unrelated missing IDs stay unconfirmed', async () => {
    const f = fixture()
    try {
      const id = randomUUID()
      seedClosed(f.directory, id)
      const first = f.registry.closeRegistration(f.scope, id)
      assert.equal(f.registry.closeRegistration(f.scope, id), first)
      await first
      await f.registry.closeRegistration(f.scope, id)
      await assert.rejects(f.registry.closeRegistration(f.scope, randomUUID()), { code: 'ENOENT' })
      const neverStarted = randomUUID()
      const path = privateDirectory(join(f.directory, neverStarted))
      writeRecord(join(path, 'intent.json'), launch(neverStarted))
      writeRecord(join(path, 'not-started.json'), { id: neverStarted, owner })
      writeRecord(join(path, 'containment.json'), { format: 1, id: neverStarted, owner: 'wrong-owner', boot: bootIdentity(),
        boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${neverStarted}`, device: '1', inode: '1' } })
      await assert.rejects(f.registry.closeRegistration(f.scope, neverStarted), /reservation owner mismatch/)
      assert.ok(existsSync(join(path, 'intent.json')))
      writeRecord(join(path, 'containment.json'), { format: 1, id: neverStarted, owner, boot: bootIdentity(),
        boundary: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${neverStarted}`, device: '1', inode: '1' } })
      await f.registry.closeRegistration(f.scope, neverStarted)
      assert.ok(!existsSync(path))
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('refuses a missing, replaced, or non-kernel cgroup boundary as closure proof', () => {
    const f = fixture()
    try {
      assert.throws(() => cgroupBoundary({ kind: 'cgroup-v2', path: '/sys/fs/cgroup/../wrong', device: '1', inode: '2' }, randomUUID()))
      assert.throws(() => cgroupPopulated({ kind: 'cgroup-v2', path: f.root, device: '1', inode: '2' }), /identity changed/)
      assert.throws(() => cgroupPopulated({ kind: 'cgroup-v2', path: join(f.root, 'missing'), device: '1', inode: '2' }))
      assert.equal(cgroupRemoved({ kind: 'cgroup-v2', path: join(f.root, 'missing'), device: '1', inode: '2' }), false)
      assert.equal(cgroupRemoved({ kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${randomUUID()}`,
        device: '0', inode: '2' }), false)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('a qualified launch kills descendants even after they create a new POSIX session', async (context) => {
    const f = fixture()
    let detached: ReturnType<typeof processIdentity>
    const child = spawnNativeProcess(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      console.log(child.pid); child.unref(); setInterval(()=>{},1000);
    `], { cwd: f.root, env: {}, recovery: await prepareNativeProcessRecovery(f.scope) })
    let output = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    try {
      for (let count = 0; count < 200 && !output.includes('\n') && child.exitCode === null && child.signalCode === null; count += 1) await delay(10)
      if (!output.includes('\n')) {
        await stopRecoveredChild(child)
        assert.equal(readdirSync(f.directory).filter((entry) => /^[0-9a-f-]{36}$/.test(entry)).length, 0)
        assert.match(stderr, /delegated cgroup v2/)
        context.skip('No writable delegated cgroup v2: native launch was refused before any provider code ran.')
        return
      }
      detached = processIdentity(Number(output.trim()))
      assert.ok(detached)
      assert.equal(detached.session, detached.pid)
      assert.notEqual(detached.session, child.pid)
      await stopRecoveredChild(child)
      assert.equal(identityAlive(detached), false)
      assert.equal(await f.registry.closeOwner(owner), true)
    } finally {
      await stopRecoveredChild(child)
      await closed(child)
      if (detached && identityAlive(detached)) process.kill(-detached.pid, 'SIGKILL')
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('retries a failed owned-process kill and retains Stop ownership until closure succeeds', async () => {
    const owned = await spawnOwnedStdioProcess({ binary: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: tmpdir(), environment: {}, onError: () => undefined })
    const pid = owned.child.pid!
    const original = process.kill
    let blocked = 0
    process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
      if (target === -pid) { blocked += 1; throw Object.assign(new Error('fixture EPERM'), { code: 'EPERM' }) }
      return original(target, signal)
    }) as typeof process.kill
    try {
      const first = owned.close()
      assert.equal(owned.close(), first)
      await assert.rejects(first, /fixture EPERM/)
      assert.ok(blocked >= 2)
      assert.equal(owned.child.exitCode, null)
      process.kill = original
      assert.equal(await stopProcess(owned.child), true)
      assert.equal(await stopProcess(owned.child), false)
      await owned.close()
    } finally {
      process.kill = original
      await owned.close()
    }
  }, 10_000)

  it('an inspection-process cleanup can retry after rejection and release its retained Stop handle', async () => {
    let child: import('node:child_process').ChildProcess | undefined
    const original = process.kill
    const running = runJsonlProcess({ binary: process.execPath, args: ['-e', 'process.exit(0)'], cwd: tmpdir(),
      signal: new AbortController().signal, onEvent: async () => undefined,
      onSpawn: (spawned) => {
        child = spawned
        process.kill = ((target: number, signal?: NodeJS.Signals | number) => {
          if (target === -spawned.pid!) throw Object.assign(new Error('inspection cleanup failure'), { code: 'EPERM' })
          return original(target, signal)
        }) as typeof process.kill
      },
    })
    try {
      await assert.rejects(running, /inspection cleanup failure/)
      process.kill = original
      assert.ok(child)
      assert.equal(await stopProcess(child), true)
      assert.equal(await stopProcess(child), false)
    } finally {
      process.kill = original
      if (child) await stopProcess(child)
    }
  }, 10_000)

})

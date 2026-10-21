import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import {
  NativeProcessRegistry, prepareNativeProcessRecovery,
  spawnNativeProcess,
  stopRecoveredChild,
  type NativeProcessRecovery,
} from '../src/modules/harnesses/recovery/processRegistry.js'
import { readRecord, recordObject, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-launch-abandonment-'))
  const registry = new NativeProcessRegistry(root)
  const scope = await registry.reserveLaunch('diagnostic-fixture-owner')
  const ownerDirectory = join(root, createHash('sha256').update(scope.owner).digest('hex'))
  const directory = join(ownerDirectory, scope.launchId!)
  return { root, registry, scope, ownerDirectory, directory }
}

async function auxiliary(registry: NativeProcessRegistry, scope: NativeProcessRecovery) {
  const factories = new NativeHarnessFactories({ codexBinary: 'unused', auxiliaryRecovery: () => scope,
    abandonRecovery: async recovery => { await registry.abandonReservedLaunch(recovery) },
    closeRecovery: async recovery => {
      if (!await registry.closeOwner(recovery.owner)) throw new Error('Auxiliary native closure is unconfirmed.')
    },
  })
  const allocation = factories.allocate({ harness: 'codex', role: 'qualification',
    ownerAgentId: 'qualification', workingDirectory: scope.root, appMcpAccess: 'none' })
  await factories.admitAuxiliary(allocation.manager)
  return { factories, manager: allocation.manager }
}

describe('qualification reservation cleanup', () => {
  it('abandons a never-dispatched reservation before closing its owner', async () => {
    const f = await fixture()
    const owned = await auxiliary(f.registry, f.scope)
    try {
      await owned.factories.disposeAuxiliary(owned.manager)
      assert.equal(await f.registry.closeOwner(f.scope.owner), true)
      assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: f.root, env: {}, recovery: f.scope,
      }))
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it.each(['reserved', 'unreserved'] as const)('uses owner closure after a %s launch has dispatched', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'qualification-launch-'))
    const registry = new NativeProcessRegistry(root)
    const scope = kind === 'reserved'
      ? await registry.reserveLaunch('qualification-owner') : registry.scope('qualification-owner')
    const owned = await auxiliary(registry, scope)
    const child = spawnNativeProcess(process.execPath, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], {
      cwd: root, env: {}, recovery: await prepareNativeProcessRecovery(scope),
    })
    child.stderr.resume()
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.once('exit', () => reject(new Error('Native fixture exited before entering.')))
      })
      await owned.factories.disposeAuxiliary(owned.manager)
      await closed
      if (scope.launchId !== undefined) assert.equal(await registry.abandonReservedLaunch(scope), false)
      assert.equal(await registry.closeOwner(scope.owner), true)
    } finally {
      await stopRecoveredChild(child)
      await closed
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  for (const mutation of [{ root: '/foreign-registry' }, { owner: 'foreign-owner' }, { launchId: '' }]) {
    it(`retains cleanup failure for an invalid ${Object.keys(mutation)[0]} instead of closing another owner`, async () => {
      const f = await fixture()
      const original = { ...f.scope }
      const owned = await auxiliary(f.registry, Object.assign(f.scope, mutation))
      try {
        await assert.rejects(owned.factories.disposeAuxiliary(owned.manager))
        Object.assign(f.scope, original)
        await owned.factories.disposeAuxiliary(owned.manager)
        assert.equal(await f.registry.closeOwner(f.scope.owner), true)
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    })
  }
})

describe('original-parent no-dispatch retirement', () => {
  it('publishes positive no-start evidence and permanently fences the exact abandoned scope', async () => {
    const f = await fixture()
    try {
      // A live parent and undispatched intent alone remain insufficient evidence.
      await assert.rejects(f.registry.closeRegistration(f.scope, f.scope.launchId!, AbortSignal.timeout(75)))
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
      assert.equal(await f.registry.closeOwner(f.scope.owner), true)
      assert.deepEqual(readdirSync(f.ownerDirectory), [`closed-${f.scope.launchId}.json`, 'retired.json'])
      assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("must never launch")'], {
        cwd: f.root, env: {}, recovery: f.scope,
      }))
      assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("must never launch")'], {
        cwd: f.root, env: {}, recovery: { ...f.scope },
      }))
      assert.deepEqual(readdirSync(f.ownerDirectory), [`closed-${f.scope.launchId}.json`, 'retired.json'])
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('refuses positive no-start evidence for a real native process that has already entered', async () => {
    const f = await fixture()
    const child = spawnNativeProcess(process.execPath, ['-e', 'console.log("native-entered");setInterval(()=>{},1000)'], {
      cwd: f.root, env: {}, recovery: f.scope,
    })
    child.stderr.resume()
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      const output = await new Promise<string>((resolve, reject) => {
        child.stdout.once('data', (chunk) => resolve(String(chunk)))
        child.once('exit', () => reject(new Error('Native fixture exited before entering.')))
      })
      assert.equal(output, 'native-entered\n')
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), false)
      assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
      assert.ok(readRecord(join(f.directory, 'birth.json')))
    } finally {
      await stopRecoveredChild(child)
      await closed
      // Only the observed original scope can report entered after registration GC.
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), false)
      assert.equal(await f.registry.closeOwner(f.scope.owner), true)
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope }))
      const original = { ...f.scope }
      for (const mutation of [{ owner: 'foreign-owner' }, { launchId: randomUUID() }, { root: join(f.root, 'foreign') }]) {
        Object.assign(f.scope, mutation)
        await assert.rejects(f.registry.abandonReservedLaunch(f.scope))
        assert.throws(() => spawnNativeProcess(process.execPath, ['-e', 'throw new Error("must never launch")'], {
          cwd: f.root, env: {}, recovery: f.scope,
        }), /scope was modified/)
        Object.assign(f.scope, original)
      }
      rmSync(f.root, { recursive: true, force: true })
    }
  }, 10_000)

  for (const state of ['claimed.json', 'dispatched.json', 'birth.json', 'containment.json', 'closed.json']) {
    it(`refuses abandonment after ${state} without publishing no-start evidence`, async () => {
      const f = await fixture()
      try {
        // Private markers model an already-entered lifecycle; no fixture process runs.
        writeRecord(join(f.directory, state), { id: f.scope.launchId, owner: f.scope.owner })
        assert.equal(await f.registry.abandonReservedLaunch(f.scope), false)
        assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
        assert.ok(readRecord(join(f.directory, 'intent.json')))
        rmSync(join(f.directory, state))
        assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    })
  }

  it('rejects foreign root, owner, and launch scopes without changing the original reservation', async () => {
    const f = await fixture()
    try {
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, root: join(f.root, 'foreign') }))
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, owner: 'another-owner' }))
      await assert.rejects(f.registry.abandonReservedLaunch({ ...f.scope, launchId: randomUUID() }))
      await assert.rejects(f.registry.abandonReservedLaunch(f.registry.scope(f.scope.owner)))
      assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  for (const field of ['boot', 'parent-pid', 'parent-generation', 'owner', 'id']) it(`rejects stale ${field} binding`, async () => {
    const f = await fixture()
    const path = join(f.directory, 'intent.json')
    const original = recordObject(readRecord(path))
    try {
      const changed = structuredClone(original)
      if (field === 'boot') changed.boot = 'earlier-boot'
      else if (field === 'owner') changed.owner = 'another-owner'
      else if (field === 'id') changed.id = randomUUID()
      else {
        const parent = recordObject(changed.parent)
        if (field === 'parent-pid') parent.pid = Number(parent.pid) + 1
        else parent.startTicks = String(BigInt(String(parent.startTicks)) + 1n)
      }
      writeRecord(path, changed)
      await assert.rejects(f.registry.abandonReservedLaunch(f.scope), /exact original parent/)
      assert.equal(readRecord(join(f.directory, 'not-started.json')), undefined)
      writeRecord(path, original)
      assert.equal(await f.registry.abandonReservedLaunch(f.scope), true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
})

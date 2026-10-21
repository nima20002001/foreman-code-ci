import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { bootIdentity, processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateDirectory, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'registry-observation-'))
  const registry = new NativeProcessRegistry(root)
  const owner = 'exact-lease-owner'
  const ownerDirectory = privateDirectory(join(root, createHash('sha256').update(owner).digest('hex')))
  function seed(id = randomUUID()) {
    const directory = privateDirectory(join(ownerDirectory, id))
    const intent = { format: 1, id, owner, boot: bootIdentity(), parent: processIdentity(process.pid), controlKey: 'a'.repeat(64) }
    writeRecord(join(directory, 'intent.json'), intent)
    return { directory, intent, id }
  }
  return { root, registry, owner, ownerDirectory, seed }
}

describe.skipIf(process.platform !== 'linux')('passive native registry producer', () => {
  it('reads an exit publication with a retained temporary link while observing other launches', () => {
    const f = fixture()
    try {
      const guardian = processIdentity(process.pid)!
      const ended = f.seed()
      const active = f.seed()
      for (const row of [ended, active]) {
        writeRecord(join(row.directory, 'birth.json'), {
          format: 1, id: row.id, owner: f.owner, boot: row.intent.boot, guardian,
        })
      }
      const exitPath = join(ended.directory, 'provider-exit.json')
      writeRecord(exitPath, {
        format: 1, id: ended.id, owner: f.owner, boot: ended.intent.boot, code: 0, signal: null,
      }, true)
      linkSync(exitPath, join(ended.directory, `.pending-${randomUUID()}`))

      const snapshot = f.registry.snapshot()
      expect(snapshot.launches.find(row => row.launchId === ended.id)?.lifecycle).toBe('ended')
      expect(snapshot.launches.find(row => row.launchId === active.id)?.lifecycle).toBe('active')
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  for (const evidence of ['native_exit_removed_cgroup', 'cgroup_v2_removed']) {
    it(`reads persisted ${evidence} cleanup after reopening and retiring the registry`, async () => {
      const f = fixture()
      try {
        const row = f.seed()
        writeRecord(join(row.directory, 'closed.json'), { ...row.intent, format: 2, evidence })
        const reopened = new NativeProcessRegistry(f.root)
        expect(reopened.snapshot().launches).toEqual([{ owner: f.owner, launchId: row.id,
          bootId: row.intent.boot, lifecycle: 'closed', closureEvidence: evidence }])
        await f.registry.closeRegistration(f.registry.scope(f.owner), row.id)
        expect(f.registry.closedRegistration(f.owner, row.id)).toMatchObject({ lifecycle: 'closed',
          closureEvidence: evidence })
        expect(new NativeProcessRegistry(f.root).snapshot().launches).toEqual([{ owner: f.owner,
          launchId: row.id, bootId: row.intent.boot, lifecycle: 'closed', closureEvidence: evidence }])
      } finally {
        rmSync(f.root, { recursive: true, force: true })
      }
    })
  }

  it('does not create missing storage or compact closed/legacy records and freezes sanitized DTOs', () => {
    const f = fixture()
    try {
      const absent = join(f.root, 'absent')
      expect(new NativeProcessRegistry(absent).snapshot().launches).toEqual([])
      expect(existsSync(absent)).toBe(false)
      const row = f.seed()
      writeRecord(join(row.directory, 'closed.json'), { ...row.intent, format: 2, evidence: 'native_not_started' })
      const before = readdirSync(row.directory)
      const snapshot = f.registry.snapshot()
      expect(snapshot.launches[0]).toEqual({ owner: f.owner, launchId: row.id, bootId: row.intent.boot, lifecycle: 'closed', closureEvidence: 'native_not_started' })
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.launches)).toBe(true)
      expect(Object.isFrozen(snapshot.launches[0])).toBe(true)
      expect(readdirSync(row.directory)).toEqual(before)
      expect(JSON.stringify(snapshot)).not.toContain('controlKey')
      expect(JSON.stringify(snapshot)).not.toContain(f.root)
      writeRecord(join(row.directory, 'closed.json'), { ...row.intent, format: 1, evidence: 'linux_boot_or_session_absence' })
      expect(f.registry.snapshot().launches[0]?.lifecycle).toBe('closure-unconfirmed')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('captures distinct sequential actual CLI births, positive exit and closure without treating disappearance as closed', () => {
    const f = fixture()
    try {
      const guardian = processIdentity(process.pid)!
      const first = f.seed()
      const second = f.seed()
      for (const row of [first, second]) {
        writeRecord(join(row.directory, 'birth.json'), { format: 1, id: row.id, owner: f.owner, boot: row.intent.boot, guardian })
        const provider = { pid: guardian.pid + 1, startTicks: `${Number(guardian.startTicks) + 1}` }
        writeRecord(join(row.directory, 'provider.json'), { format: 1, id: row.id, owner: f.owner, boot: row.intent.boot, guardian, provider, capture: 'captured' })
      }
      const captured = f.registry.snapshot()
      expect(captured.launches).toHaveLength(2)
      expect(captured.launches.every(row => row.guardian?.pid !== row.provider?.pid)).toBe(true)
      const provider = captured.launches.find(row => row.launchId === first.id)!.provider
      writeRecord(join(first.directory, 'provider-exit.json'), { format: 1, id: first.id, owner: f.owner, boot: first.intent.boot, provider, code: 0, signal: null })
      expect(f.registry.snapshot().launches.find(row => row.launchId === first.id)?.lifecycle).toBe('ended')
      rmSync(second.directory, { recursive: true })
      expect(f.registry.snapshot().launches.find(row => row.launchId === second.id)?.lifecycle).toBe('closure-unconfirmed')
      expect(captured.launches.find(row => row.launchId === first.id)?.lifecycle).toBe('active')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  it('publishes durable reserve/retire transitions across registry instances with explicit gap on coalesced revisions', async () => {
    const f = fixture()
    const controller = new AbortController()
    try {
      const baseline = f.registry.snapshot()
      const scope = await f.registry.reserveLaunch(f.owner)
      const reserved = f.registry.snapshot()
      const rowDirectory = join(f.ownerDirectory, scope.launchId!)
      writeRecord(join(rowDirectory, 'not-started.json'), { id: scope.launchId, owner: f.owner })
      await f.registry.closeRegistration(scope, scope.launchId!)
      expect(existsSync(rowDirectory)).toBe(false)
      const reader = new NativeProcessRegistry(f.root)
      const iterator = reader.changes(baseline.revision, controller.signal)[Symbol.asyncIterator]()
      const one = await iterator.next()
      expect(one.value?.revision).not.toBe(reserved.revision)
      expect(one.value?.gap).toBe(true)
      expect(one.value?.launches[0]?.lifecycle).toBe('closed')
      controller.abort()
      expect((await iterator.next()).done).toBe(true)
    } finally { controller.abort(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('reports stale/foreign revisions as a gap and aborts a waiting subscription', async () => {
    const f = fixture()
    const controller = new AbortController()
    try {
      f.seed()
      f.registry.snapshot()
      const iterator = f.registry.changes('foreign:0', controller.signal)[Symbol.asyncIterator]()
      expect((await iterator.next()).value?.gap).toBe(true)
      const pending = iterator.next()
      controller.abort()
      expect((await pending).done).toBe(true)
    } finally { controller.abort(); rmSync(f.root, { recursive: true, force: true }) }
  })

  it('rejects mismatched child identities rather than adopting a PID', () => {
    const f = fixture()
    try {
      const row = f.seed()
      const guardian = processIdentity(process.pid)!
      writeRecord(join(row.directory, 'birth.json'), { format: 1, id: row.id, owner: f.owner, boot: row.intent.boot, guardian })
      writeRecord(join(row.directory, 'provider.json'), { format: 1, id: row.id, owner: f.owner, boot: row.intent.boot, guardian: { ...guardian, startTicks: '0' }, provider: guardian, capture: 'captured' })
      expect(() => f.registry.snapshot()).toThrow('guardian mismatch')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('subscribes before publication and exposes sanitized boundary certificates only', async () => {
    const f = fixture()
    const controller = new AbortController()
    try {
      const baseline = f.registry.snapshot()
      const iterator = f.registry.changes(baseline.revision, controller.signal)[Symbol.asyncIterator]()
      const pending = iterator.next()
      const scope = await f.registry.reserveLaunch(f.owner)
      const event = await pending
      expect(event.value?.gap).toBe(false)
      expect(event.value?.launches[0]?.launchId).toBe(scope.launchId)
      const path = join(f.ownerDirectory, scope.launchId!)
      const guardian = processIdentity(process.pid)!
      writeRecord(join(path, 'birth.json'), { format: 1, id: scope.launchId, owner: f.owner, boot: bootIdentity(), guardian,
        containment: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${scope.launchId}`, device: '1', inode: '2', controlKey: 'must-not-leak' } })
      const snapshot = f.registry.snapshot()
      expect(snapshot.launches[0]?.boundary).toEqual({ kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${scope.launchId}`, device: '1', inode: '2' })
      expect(Object.isFrozen(snapshot.launches[0]?.boundary)).toBe(true)
      expect(JSON.stringify(snapshot)).not.toContain('must-not-leak')
      controller.abort()
      await iterator.return?.()
    } finally { controller.abort(); rmSync(f.root, { recursive: true, force: true }) }
  })

})

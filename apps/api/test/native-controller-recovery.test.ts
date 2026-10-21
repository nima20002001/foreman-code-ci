import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ livePid: 0, sessionLive: false, fullHierarchy: true, device: 77n,
  cgroupDescriptors: new Set<number>(), overlay: '' }))
vi.mock('../src/modules/harnesses/recovery/linuxIdentity.js', () => ({
  bootIdentity: () => '22222222-2222-4222-8222-222222222222',
  processIdentity: (pid: number) => ({ pid, startTicks: '100', group: pid, session: pid, state: 'S' }),
  identityAlive: (process: { pid: number }) => process.pid === host.livePid,
  sessionAlive: () => host.sessionLive,
}))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    readFileSync: new Proxy(actual.readFileSync, { apply(read, receiver, args) {
      if (args[0] === '/proc/self/mountinfo') {
        const hierarchy = `1 0 0:1 ${host.fullHierarchy ? '/' : '/subtree'} /sys/fs/cgroup rw - cgroup2 cgroup rw\n`
        return hierarchy + (host.overlay ? `2 1 0:2 / ${host.overlay} rw - cgroup2 cgroup rw\n` : '')
      }
      return Reflect.apply(read, receiver, args)
    } }),
    openSync: new Proxy(actual.openSync, { apply(open, receiver, args) {
      const fd = Reflect.apply(open, receiver, args)
      if (args[0] === '/sys/fs/cgroup') host.cgroupDescriptors.add(fd)
      return fd
    } }),
    closeSync: new Proxy(actual.closeSync, { apply(close, receiver, args) {
      host.cgroupDescriptors.delete(args[0])
      return Reflect.apply(close, receiver, args)
    } }),
    fstatSync: new Proxy(actual.fstatSync, { apply(read, receiver, args) {
      if (host.cgroupDescriptors.has(args[0])) return { dev: host.device }
      return Reflect.apply(read, receiver, args)
    } }),
    statfsSync: new Proxy(actual.statfsSync, { apply(read, receiver, args) {
      const match = /^\/proc\/self\/fd\/(\d+)$/.exec(String(args[0]))
      if (match && host.cgroupDescriptors.has(Number(match[1]))) return { type: 0x63677270 }
      return Reflect.apply(read, receiver, args)
    } }),
  }
})

import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { writeRecord } from '../src/modules/harnesses/recovery/storage.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  host.livePid = 0
  host.sessionLive = false
  host.fullHierarchy = true
  host.device = 77n
  host.overlay = ''
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-controller-recovery-'))
  roots.push(root)
  const registry = new NativeProcessRegistry(root)
  const scope = await registry.reserveLaunch('container-controller')
  const directory = join(root, createHash('sha256').update(scope.owner).digest('hex'), scope.launchId!)
  const launch = JSON.parse(readFileSync(join(directory, 'intent.json'), 'utf8'))
  const guardian = { pid: 50001, group: 50001, session: 50001, startTicks: '101', state: 'S' }
  const provider = { pid: 50002, startTicks: '102' }
  const shared = { format: 1, id: scope.launchId, owner: scope.owner, boot: launch.boot }
  writeRecord(join(directory, 'birth.json'), { ...shared, guardian,
    containment: { kind: 'cgroup-v2', path: `/sys/fs/cgroup/graphql-native-${scope.launchId}`, device: '77', inode: '88' } })
  writeRecord(join(directory, 'provider.json'), { ...shared, guardian, provider, capture: 'captured' })
  const exit = { ...shared, provider, code: 0, signal: null }
  writeRecord(join(directory, 'provider-exit.json'), exit)
  return { registry, scope, directory, launch, guardian, provider, exit }
}

it('closes an exited controller after systemd removes its cgroup, with the recorded provider exit', async () => {
  const f = await fixture()
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).resolves.toBeUndefined()
  expect(await f.registry.closeOwner(f.scope.owner)).toBe(true)
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).resolves.toBeUndefined()
})

it.each(['parent-live', 'guardian-live', 'provider-live', 'session-live',
  'wrong-provider', 'partial-cgroup-mount', 'changed-cgroup-device', 'over-mounted-boundary', 'invalid-exit'] as const)(
'keeps ownership unresolved when the cgroup is absent and %s', async failure => {
  const f = await fixture()
  if (failure === 'parent-live') host.livePid = f.launch.parent.pid
  if (failure === 'guardian-live') host.livePid = f.guardian.pid
  if (failure === 'provider-live') host.livePid = f.provider.pid
  if (failure === 'session-live') host.sessionLive = true
  if (failure === 'partial-cgroup-mount') host.fullHierarchy = false
  if (failure === 'changed-cgroup-device') host.device = 78n
  if (failure === 'over-mounted-boundary') host.overlay = `/sys/fs/cgroup/graphql-native-${f.scope.launchId}`
  if (failure === 'wrong-provider') {
    writeRecord(join(f.directory, 'provider-exit.json'), { ...f.exit, provider: { ...f.provider, startTicks: '103' } })
  }
  if (failure === 'invalid-exit') writeRecord(join(f.directory, 'provider-exit.json'), { ...f.exit, code: 256 })
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('confirms a killed native tree without an exit receipt only after qualified kernel removal', async () => {
  const f = await fixture()
  unlinkSync(join(f.directory, 'provider-exit.json'))
  host.fullHierarchy = false
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).rejects.toMatchObject({ code: 'ENOENT' })
  host.fullHierarchy = true
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).resolves.toBeUndefined()
  expect(await f.registry.closeOwner(f.scope.owner)).toBe(true)
  await expect(f.registry.closeRegistration(f.scope, f.scope.launchId!)).resolves.toBeUndefined()
})

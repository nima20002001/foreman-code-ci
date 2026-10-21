import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { systemSyncthingPorts } from './syncthingSystem.js'
import { mainSyncId } from '../../../test/helpers/syncthing.js'

const mock = vi.hoisted(() => ({ ports: {} as Record<string, unknown> }))
vi.mock('./accountProbe.js', () => ({ systemPorts: () => mock.ports }))
const homes: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})
async function fixture(options: { installed?: boolean; checksum?: string; failStart?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'foreman-sync-system-'))
  homes.push(home)
  const binary = join(home, '.local', 'bin', 'syncthing')
  const config = join(home, '.local', 'state', 'foreman-code', 'syncthing', 'config.xml')
  let running = false
  let healthy = true
  let failStart = options.failStart ?? false
  const calls: { file: string; args: string[] }[] = []
  mock.ports = {
    find: async () => {
      if (options.installed) return '/usr/bin/syncthing'
      try { await access(binary); return binary } catch { return null }
    },
    run: async (file: string, args: string[]) => {
      calls.push({ file, args })
      let code = 0
      let stdout = ''
      if (file === 'tailscale') stdout = '100.64.0.1\n'
      if (args[0] === 'generate') await writeFile(config, '<configuration><gui><apikey>localkey</apikey></gui></configuration>')
      if (file === 'tar') {
        const scratch = args[args.indexOf('-C') + 1]!
        const directory = join(scratch, 'syncthing-linux-amd64-v2.0.11')
        await mkdir(directory)
        await writeFile(join(directory, 'syncthing'), 'installed binary')
      }
      if (args.includes('is-active')) code = running ? 0 : 3
      if (args.includes('enable')) {
        code = failStart ? 1 : 0
        running = !failStart
        healthy = !failStart
      }
      return { code, stdout, stderr: code ? 'user service failed' : '' }
    },
  }
  const archive = Buffer.from('release archive')
  const downloaded: string[] = []
  const settings: unknown[] = []
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('http://127.0.0.1:8385/')) {
      expect(new Headers(init?.headers).get('X-API-Key')).toBe(/<apikey>([^<]+)<\/apikey>/u.exec(await readFile(config, 'utf8'))?.[1])
      if (url.endsWith('/rest/system/status') && !healthy) return new Response('unavailable', { status: 503 })
      if (url.endsWith('/rest/config/options')) {
        settings.push(JSON.parse(init?.body as string) as unknown)
        return new Response('null')
      }
      return new Response(JSON.stringify({ myID: mainSyncId }))
    }
    downloaded.push(url)
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ tag_name: 'v2.0.11' }))
    if (url.endsWith('/sha256sum.txt')) return new Response(`${options.checksum ?? createHash('sha256').update(archive).digest('hex')}  syncthing-linux-amd64-v2.0.11.tar.gz\n`)
    return new Response(archive)
  })
  vi.stubGlobal('fetch', fetcher)
  return { home, binary, config, calls, downloaded, settings, ports: systemSyncthingPorts({ HOME: home }),
    allowStart: () => { failStart = false }, stop: () => { running = false },
    failHealth: () => { healthy = false } }
}

it('installs checksum-verified Syncthing, starts its user service and configures Tailscale through local REST', async () => {
  const f = await fixture()
  const identity = await f.ports.prepare()
  expect(identity).toEqual({ deviceId: mainSyncId, address: '100.64.0.1', rootPath: join(f.home, '.local/share/foreman-code/shared-files') })
  expect(f.calls.filter(call => call.args.includes('daemon-reload'))).toHaveLength(1)
  expect(f.calls.filter(call => call.args.includes('enable'))).toHaveLength(1)
  expect(await readFile(f.binary, 'utf8')).toBe('installed binary')
  expect((await stat(f.binary)).mode & 0o777).toBe(0o755)
  expect(await f.ports.available()).toEqual({ installed: true, running: true })
  expect(f.settings).toEqual([expect.objectContaining({ globalAnnounceEnabled: false, localAnnounceEnabled: false,
    relaysEnabled: false, natEnabled: false, listenAddresses: ['tcp://100.64.0.1:22001'] })])
  await writeFile(f.config, '<configuration><gui><apikey>replacementkey</apikey></gui></configuration>')
  await f.ports.rest('GET', '/rest/system/status')
  expect(JSON.stringify(identity)).not.toMatch(/key|apikey/)
})

it('refuses a corrupt download before installing or starting anything', async () => {
  const f = await fixture({ checksum: '0'.repeat(64) })
  await expect(f.ports.prepare()).rejects.toThrow('published checksum')
  await expect(access(f.binary)).rejects.toThrow()
  expect(f.calls.some(call => call.file === 'systemctl')).toBe(false)
})

it('uses an existing binary without a download and retries failed service startup without replacing its identity', async () => {
  const f = await fixture({ installed: true, failStart: true })
  await expect(f.ports.prepare()).rejects.toThrow('user service failed')
  const original = await readFile(f.config, 'utf8')
  f.allowStart()
  expect((await f.ports.prepare()).deviceId).toBe(mainSyncId)
  expect(await readFile(f.config, 'utf8')).toBe(original)
  expect(f.downloaded).toEqual([])
})

it('lists nested conflict copies without exposing deleted versions or following symlinks', async () => {
  const f = await fixture()
  const folder = join(f.home, 'shared')
  await mkdir(join(folder, 'nested'), { recursive: true })
  await mkdir(join(folder, '.stversions'))
  await writeFile(join(folder, 'nested', 'file.sync-conflict-20261008.txt'), 'copy')
  await writeFile(join(folder, '.stversions', 'old.sync-conflict-20261007.txt'), 'old copy')
  await writeFile(join(folder, 'ordinary.txt'), 'ordinary')
  const outside = join(f.home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'outside.sync-conflict-20261008.txt'), 'outside copy')
  await symlink(outside, join(folder, 'external'), 'dir')
  await symlink(folder, join(folder, 'self'), 'dir')
  expect(await f.ports.conflicts(folder)).toEqual(['nested/file.sync-conflict-20261008.txt'])
})

it('cancels local REST status requests with the caller budget', async () => {
  const f = await fixture({ installed: true })
  await f.ports.prepare()
  const controller = new AbortController()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let requestSignal: AbortSignal | null | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    requestSignal = init?.signal
    entered()
    return new Promise<Response>((_, reject) => {
      requestSignal!.addEventListener('abort', () => reject(requestSignal!.reason), { once: true })
    })
  }))
  const pending = f.ports.rest('GET', '/rest/system/status', undefined, controller.signal)
  const rejected = expect(pending).rejects.toThrow('Context budget expired')
  await started
  controller.abort(new Error('Context budget expired'))
  await rejected
  expect(requestSignal?.aborted).toBe(true)
})

it('stops a canceled conflict scan before reading the directory', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error('Context budget expired'))
  await expect(f.ports.conflicts(join(f.home, 'missing-folder'), controller.signal))
    .rejects.toThrow('Context budget expired')
})

it('reuses unchanged preparation while checking service liveness and refreshes at expiry', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const first = await f.ports.prepare()
  f.calls.length = 0
  expect(await f.ports.prepare()).toEqual(first)
  expect(f.calls).toEqual([{ file: 'systemctl', args: ['--user', 'is-active', 'foreman-syncthing.service'] }])
  vi.advanceTimersByTime(30_000)
  expect(await f.ports.prepare()).toEqual(first)
  expect(f.calls.some(call => call.file === 'tailscale')).toBe(true)
})

it.each(['binary', 'config', 'unit', 'stopped'] as const)('reprepares after %s changes', async changed => {
  const f = await fixture()
  const first = await f.ports.prepare()
  f.calls.length = 0
  if (changed === 'binary') {
    const before = await stat(f.binary)
    const replacement = join(f.home, 'replacement')
    await writeFile(replacement, 'replacement data', { mode: 0o755 })
    await utimes(replacement, before.atime, before.mtime)
    await rename(replacement, f.binary)
  }
  if (changed === 'config') await writeFile(f.config, await readFile(f.config))
  if (changed === 'unit') await writeFile(join(f.home, '.config', 'systemd', 'user', 'foreman-syncthing.service'), 'changed')
  if (changed === 'stopped') f.stop()
  expect(await f.ports.prepare()).toEqual(first)
  expect(f.calls.some(call => call.file === 'tailscale')).toBe(true)
  expect(f.calls.filter(call => call.args.includes('daemon-reload'))).toHaveLength(changed === 'unit' ? 1 : 0)
  expect(f.calls.filter(call => call.args.includes('enable'))).toHaveLength(changed === 'stopped' ? 1 : 0)
  expect((await f.ports.available()).running).toBe(true)
})

it('refreshes preparation after the clock moves backwards', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const first = await f.ports.prepare()
  f.calls.length = 0
  vi.setSystemTime(Date.now() - 1000)
  expect(await f.ports.prepare()).toEqual(first)
  expect(f.calls.some(call => call.file === 'tailscale')).toBe(true)
})

it('invalidates cached availability when preparation restarts the service', async () => {
  const f = await fixture()
  await f.ports.prepare()
  f.calls.length = 0
  await Promise.all(Array.from({ length: 5 }, () => f.ports.available()))
  expect(f.calls.filter(call => call.args.includes('is-active'))).toHaveLength(1)
  f.stop()
  await f.ports.prepare()
  f.calls.length = 0
  expect(await f.ports.available()).toEqual({ installed: true, running: true })
  await f.ports.available()
  expect(f.calls.filter(call => call.args.includes('is-active'))).toHaveLength(1)
})


it.each(['expired', 'fresh instance'] as const)('keeps an unchanged healthy install untouched after %s', async cache => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await fixture()
  const first = await f.ports.prepare()
  const unit = join(f.home, '.config', 'systemd', 'user', 'foreman-syncthing.service')
  const before = await stat(unit, { bigint: true })
  f.calls.length = 0
  vi.advanceTimersByTime(30_000)
  const ports = cache === 'expired' ? f.ports : systemSyncthingPorts({ HOME: f.home })
  expect(await ports.prepare()).toEqual(first)
  expect(f.calls.filter(call => call.args.includes('daemon-reload'))).toEqual([])
  expect(f.calls.filter(call => call.args.includes('enable'))).toEqual([])
  const after = await stat(unit, { bigint: true })
  expect(after.mtimeNs).toBe(before.mtimeNs)
  expect(after.ctimeNs).toBe(before.ctimeNs)
})

it('reloads a changed unit and preserves a healthy running service', async () => {
  const f = await fixture()
  const first = await f.ports.prepare()
  const unit = join(f.home, '.config', 'systemd', 'user', 'foreman-syncthing.service')
  const original = await readFile(unit, 'utf8')
  await writeFile(unit, 'outdated unit')
  f.calls.length = 0
  expect(await f.ports.prepare()).toEqual(first)
  expect(await readFile(unit, 'utf8')).toBe(original)
  expect(f.calls.filter(call => call.args.includes('daemon-reload'))).toHaveLength(1)
  expect(f.calls.filter(call => call.args.includes('enable'))).toEqual([])
})

it('retries startup when an active service fails its REST health check', async () => {
  const f = await fixture()
  const first = await f.ports.prepare()
  f.failHealth()
  f.calls.length = 0
  expect(await f.ports.prepare()).toEqual(first)
  expect(f.calls.filter(call => call.args.includes('enable'))).toHaveLength(1)
  expect(f.calls.filter(call => call.args.includes('daemon-reload'))).toEqual([])
})

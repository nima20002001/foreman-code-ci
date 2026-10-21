import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { SyncIdentitySchema, TailscaleAddressSchema, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { systemPorts } from './accountProbe.js'
import { createSyncthingAvailability } from './syncthingAvailability.js'
import { SyncthingConflictScanner } from './syncthingConflictScan.js'
import { DomainError } from '../errors.js'

export interface SyncthingPorts {
  prepare(signal?: AbortSignal, assertCurrent?: () => void): Promise<SyncIdentity>
  available(signal?: AbortSignal): Promise<{ installed: boolean; running: boolean }>
  rest(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal): Promise<unknown>
  mkdir(path: string, signal?: AbortSignal): Promise<void>
  conflicts(path: string, signal?: AbortSignal): Promise<string[]>
}
const UNIT = 'foreman-syncthing.service'
const API = 'http://127.0.0.1:8385'
const RELEASES = 'https://github.com/syncthing/syncthing/releases/download'
const failure = (message: string) => new DomainError('SYNC_UNAVAILABLE', message, 502)

export function systemSyncthingPorts(environment: NodeJS.ProcessEnv = process.env): SyncthingPorts {
  const home = environment.HOME ?? homedir()
  const state = join(home, '.local', 'state', 'foreman-code', 'syncthing')
  const rootPath = join(home, '.local', 'share', 'foreman-code', 'shared-files')
  const processPorts = systemPorts(environment)
  const availability = createSyncthingAvailability(processPorts, UNIT)
  const conflicts = new SyncthingConflictScanner()
  let prepared: { at: number; metadata: string; identity: SyncIdentity } | undefined
  const preparationMetadata = async (binary: string): Promise<string | null> => {
    try {
      const selected = await realpath(binary)
      const files = [selected, join(state, 'config.xml'), join(home, '.config', 'systemd', 'user', UNIT)]
      const metadata = await Promise.all(files.map(async path => {
        const value = await stat(path, { bigint: true })
        return [path, value.dev, value.ino, value.size, value.mode, value.mtimeNs, value.ctimeNs].join(':')
      }))
      return metadata.join('|')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const run = async (file: string, args: string[], signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(120_000)
    const result = await processPorts.run(file, args, signal ? AbortSignal.any([signal, timeout]) : timeout)
    signal?.throwIfAborted()
    if (result.code !== 0) throw failure(`${file.split('/').at(-1)} failed: ${result.stderr.trim().slice(-300)}`)
    return result.stdout
  }
  const download = async (url: string, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(120_000)
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { 'User-Agent': 'foreman-code' } })
    if (!response.ok) throw failure(`Syncthing download failed (${response.status}).`)
    return Buffer.from(await response.arrayBuffer())
  }
  const rest: SyncthingPorts['rest'] = async (method, path, body, signal) => {
    signal?.throwIfAborted()
    const config = await readFile(join(state, 'config.xml'), { encoding: 'utf8', ...(signal ? { signal } : {}) })
    signal?.throwIfAborted()
    const key = /<apikey>([A-Za-z0-9]+)<\/apikey>/u.exec(config)?.[1]
    if (!key) throw failure('Syncthing API key is missing from its local configuration.')
    const timeout = AbortSignal.timeout(15_000)
    const response = await fetch(`${API}${path}`, { method, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw failure(`Syncthing ${method} request failed (${response.status}).`)
    if (method === 'DELETE' && path.startsWith('/rest/config/folders/')) {
      await conflicts.forget(join(rootPath, path.slice('/rest/config/folders/'.length)))
    }
    const text = await response.text()
    return text ? JSON.parse(text) as unknown : null
  }
  const serviceHealthy = async (signal?: AbortSignal): Promise<boolean> => {
    if (!(await availability.probe(signal)).running) return false
    try {
      await rest('GET', '/rest/system/status', undefined, signal)
      return true
    } catch (error) {
      signal?.throwIfAborted()
      // Failed REST health checks go through service startup and its readiness retry below.
      if (error instanceof DomainError && error.code === 'SYNC_UNAVAILABLE') return false
      if (error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError') return false
      throw error
    }
  }
  const install = async (signal?: AbortSignal, assertCurrent: () => void = () => {}) => {
    const check = () => { signal?.throwIfAborted(); assertCurrent() }
    check()
    const installed = await processPorts.find('syncthing')
    if (installed) return installed
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as 'x64' | 'arm64']
    if (!arch) throw failure('Syncthing has no supported Linux build for this processor.')
    const release = z.object({ tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/u) }).parse(
      JSON.parse((await download('https://api.github.com/repos/syncthing/syncthing/releases/latest', signal)).toString('utf8')))
    const name = `syncthing-linux-${arch}-${release.tag_name}`
    const archiveName = `${name}.tar.gz`
    const base = `${RELEASES}/${release.tag_name}`
    const archive = await download(`${base}/${archiveName}`, signal)
    const sums = (await download(`${base}/sha256sum.txt`, signal)).toString('utf8')
    const expected = sums.split('\n').map(line => line.trim().split(/\s+/u))
      .find(parts => parts[1]?.replace(/^\*/u, '') === archiveName)?.[0]
    if (expected !== createHash('sha256').update(archive).digest('hex')) {
      throw failure('The Syncthing download did not match its published checksum.')
    }
    const scratch = join(tmpdir(), `foreman-syncthing-${randomUUID()}`)
    const target = join(home, '.local', 'bin', 'syncthing')
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      check()
      await mkdir(scratch, { mode: 0o700 })
      check()
      await mkdir(join(home, '.local', 'bin'), { recursive: true })
      check()
      await writeFile(join(scratch, archiveName), archive, { mode: 0o600 })
      await run('tar', ['-xzf', join(scratch, archiveName), '-C', scratch, `${name}/syncthing`], signal)
      check()
      await copyFile(join(scratch, name, 'syncthing'), temporary)
      check()
      await chmod(temporary, 0o755)
      check()
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
      await rm(scratch, { recursive: true, force: true })
    }
    return target
  }
  return {
    rest, available: availability.read,
    mkdir: async (path, signal) => {
      signal?.throwIfAborted()
      await mkdir(path, { recursive: true, mode: 0o700 })
      signal?.throwIfAborted()
    },
    conflicts: (path, signal) => conflicts.scan(path, signal),
    prepare: async (signal, assertCurrent = () => {}) => {
      const check = () => { signal?.throwIfAborted(); assertCurrent() }
      check()
      const installed = await processPorts.find('syncthing')
      if (prepared && installed && Date.now() >= prepared.at && Date.now() - prepared.at < 30_000
        && await preparationMetadata(installed) === prepared.metadata && await serviceHealthy(signal)) {
        check()
        return structuredClone(prepared.identity)
      }
      prepared = undefined
      const address = TailscaleAddressSchema.parse((await run('tailscale', ['ip', '-4'], signal)).trim().split('\n')[0])
      const binary = await install(signal, assertCurrent)
      check()
      await mkdir(state, { recursive: true, mode: 0o700 })
      try { await readFile(join(state, 'config.xml')) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        check()
        await run(binary, ['generate', `--home=${state}`], signal)
      }
      const units = join(home, '.config', 'systemd', 'user')
      check()
      await mkdir(units, { recursive: true, mode: 0o700 })
      const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`
      const content = ['[Unit]', 'Description=Foreman Code shared files', 'After=network-online.target', '', '[Service]',
        `ExecStart=${quote(binary)} serve ${quote(`--home=${state}`)} --gui-address=127.0.0.1:8385 --no-browser --no-upgrade`,
        'Restart=on-failure', '', '[Install]', 'WantedBy=default.target', ''].join('\n')
      check()
      const unitPath = join(units, UNIT)
      let existing: string | undefined
      try { existing = await readFile(unitPath, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existing !== content) {
        check()
        await writeFile(unitPath, content, { mode: 0o600 })
        check()
        await run('systemctl', ['--user', 'daemon-reload'], signal)
      }
      if (!await serviceHealthy(signal)) {
        check()
        await run('systemctl', ['--user', 'enable', '--now', UNIT], signal)
        availability.invalidate()
      }
      let ready = false
      for (let attempt = 0; attempt < 40; attempt++) {
        check()
        try { await rest('GET', '/rest/system/status', undefined, signal); ready = true; break } catch (error) {
          check()
          if (attempt === 39) throw error
          await new Promise(resolve => { setTimeout(resolve, 250) })
        }
      }
      if (!ready) throw failure('Syncthing did not start on this computer.')
      check()
      await rest('PATCH', '/rest/config/options', { globalAnnounceEnabled: false, localAnnounceEnabled: false,
        relaysEnabled: false, natEnabled: false, listenAddresses: [`tcp://${address}:22001`],
        autoUpgradeIntervalH: 0, crashReportingEnabled: false, urAccepted: -1 }, signal)
      const system = z.object({ myID: SyncIdentitySchema.shape.deviceId }).parse(await rest('GET', '/rest/system/status', undefined, signal))
      const identity = SyncIdentitySchema.parse({ deviceId: system.myID, address, rootPath })
      const metadata = await preparationMetadata(binary)
      check()
      if (metadata) prepared = { at: Date.now(), metadata, identity }
      return identity
    },
  }
}

import { EventEmitter } from 'node:events'
import { timingSafeEqual } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { NATIVE_GUARDIAN_SOURCE } from '../src/modules/harnesses/recovery/nativeGuardian.js'

/** Execute the actual guardian program against deterministic private storage and
 * process APIs. No executable, kernel cgroup, signal or host setting is touched. */
function guardianFixture(childAvailable = true, observationWriteFails = false,
  options: { restartDetachable?: true; reconnectableStdio?: true; earlyInput?: string } = {}) {
  const id = '11111111-1111-1111-1111-111111111111'
  const boot = '22222222-2222-2222-2222-222222222222'
  const records = new Map<string, string>()
  const descriptors = new Map<number, string>()
  const native = Object.assign(new EventEmitter(), {
    pid: 902, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  if (options.earlyInput) native.stdin.on('data', chunk => native.stdout.write(`response:${String(chunk)}`))
  const output: unknown[] = []
  const outputObservations: boolean[] = []
  const ipc: unknown[] = []
  const flushed: (() => void)[] = []
  const signals: unknown[] = []
  const kills: string[] = []
  const timers: Array<{ callback(): void; delay: number }> = []
  const process = Object.assign(new EventEmitter(), {
    pid: 501, connected: true, getuid: () => 1000, kill: (...args: unknown[]) => { signals.push(args); return true },
    exit: () => undefined, send: (value: unknown, callback?: () => void) => {
      ipc.push(value)
      if (callback && (value as { operation: string }).operation === 'native_exit') flushed.push(callback)
    }, stdin: new PassThrough(), stdout: Object.assign(new EventEmitter(), { write: (chunk: unknown) => {
      outputObservations.push(records.has('/private/provider.json'))
      output.push(chunk)
      return true
    } }),
    stderr: Object.assign(new EventEmitter(), { write: (chunk: unknown) => output.push(chunk) }),
  })
  records.set('/private/intent.json', JSON.stringify({ format: 1, id, boot, owner: 'same-lease', controlKey: 'a'.repeat(64) }))
  function stat(pid: number, ticks: string) {
    const parts = ['S', '1', '501', '501', ...Array<string>(15).fill('0'), ticks]
    return `${pid} (native cli) ${parts.join(' ')}`
  }
  const fs = {
    constants: { O_RDONLY: 1, O_NOFOLLOW: 2, O_CREAT: 4, O_EXCL: 8, O_WRONLY: 16, O_DIRECTORY: 32 },
    lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: 1000 }),
    openSync: (path: string) => { const fd = descriptors.size + 1; descriptors.set(fd, path); return fd },
    closeSync: () => undefined, fsyncSync: () => undefined,
    fstatSync: () => ({ isFile: () => true, nlink: 1, size: 100, mode: 0o600, uid: 1000, dev: 5n, ino: 6n }),
    readFileSync: (file: number | string) => {
      const path = typeof file === 'number' ? descriptors.get(file)! : file
      if (path === '/proc/501/stat') return stat(501, '100')
      if (path === '/proc/902/stat') { if (!childAvailable) throw new Error('ENOENT'); return stat(902, '200') }
      if (path === '/proc/self/cgroup') return '0::/delegated\n'
      if (path === '/proc/sys/kernel/random/boot_id') return boot
      const value = records.get(path)
      if (value === undefined) throw new Error(`Missing fixture record ${path}`)
      return value
    },
    writeFileSync: (file: number | string, value: string) => {
      const path = typeof file === 'number' ? descriptors.get(file)! : file
      if (path.endsWith('/cgroup.kill')) kills.push(value)
      records.set(path, value)
    },
    linkSync: (from: string, to: string) => {
      if (to === '/private/provider.json' && options.earlyInput) process.stdin.write(options.earlyInput)
      if (observationWriteFails && /\/provider(?:-exit)?\.json$/.test(to)) throw new Error('Passive storage unavailable')
      if (records.has(to)) throw new Error('EEXIST')
      records.set(to, records.get(from)!)
    },
    unlinkSync: (path: string) => records.delete(path), mkdirSync: () => undefined, rmdirSync: () => undefined,
    statfsSync: () => ({ type: 0x63677270 }),
  }
  const server = { on: () => undefined, listen: (_options: unknown, callback: () => void) => callback(), maxConnections: 0 }
  let acceptSocket: (socket: EventEmitter) => void
  const requireFixture = (module: string): unknown => {
    if (module === 'node:fs') return fs
    if (module === 'node:child_process') return {
      spawn: (_binary: string, _args: string[], spawnOptions: { stdio: string[] }) => {
        if (spawnOptions.stdio[0] === 'inherit') {
          process.stdin.on('data', chunk => native.stdin.write(chunk))
          process.stdin.on('end', () => native.stdin.end())
        }
        if (spawnOptions.stdio[1] === 'inherit') {
          native.stdout.on('data', chunk => process.stdout.write(chunk))
          native.stderr.on('data', chunk => process.stderr.write(chunk))
        }
        return native
      },
    }
    if (module === 'node:net') return { createServer: (callback: typeof acceptSocket) => { acceptSocket = callback; return server } }
    if (module === 'node:crypto') return { randomUUID: () => `${records.size}`, timingSafeEqual }
    if (module === 'node:path') return { join: (...parts: string[]) => parts.join('/').replaceAll('//', '/'), dirname: (path: string) => path.slice(0, path.lastIndexOf('/')) || '/', resolve: (...parts: string[]) => parts.join('/').replace('/./', '/').replaceAll('//', '/'), parse: () => ({ root: '/' }), sep: '/' }
    throw new Error(module)
  }
  runInNewContext(NATIVE_GUARDIAN_SOURCE, { require: requireFixture, process, Buffer,
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { callback, delay }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer: typeof timers[number]) => {
      const index = timers.indexOf(timer)
      if (index >= 0) timers.splice(index, 1)
    } })
  process.emit('message', { operation: 'start', directory: '/private', binary: 'actual-cli', args: ['private-argument'],
    cwd: '/workspace', environment: { SECRET: 'private-secret',
      ...(options.reconnectableStdio ? { FOREMAN_CODE_MCP_TOKEN: 'fixture-token' } : {}) },
    restartDetachable: options.restartDetachable === true, reconnectableStdio: options.reconnectableStdio === true })
  const control = (message: unknown) => {
    const state = { destroyed: false, replies: [] as string[] }
    const socket = Object.assign(new EventEmitter(), { setTimeout: () => {}, setEncoding: () => {},
      pause: () => {}, resume: () => {},
      write: (reply: string) => { state.replies.push(reply); return true },
      destroy: () => { state.destroyed = true }, end: (reply: string) => state.replies.push(reply) })
    acceptSocket(socket)
    socket.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
    return Object.assign(state, { socket })
  }
  return { records, native, ipc, signals, flushed, kills, timers, process, output, outputObservations, control, id }
}

describe('guardian actual child observation receipts', () => {
  it('publishes the provider identity before a buffered request can receive its native response', async () => {
    const f = guardianFixture(true, false, { earlyInput: 'initialize' })
    await new Promise(resolve => setImmediate(resolve))
    expect(f.output.map(String)).toEqual(['response:initialize'])
    expect(f.outputObservations).toEqual([true])
  })
  it('forwards ordinary native input, output, and EOF after provider publication', async () => {
    const f = guardianFixture()
    const input: string[] = []
    f.native.stdin.on('data', chunk => {
      expect(f.records.has('/private/provider.json')).toBe(true)
      input.push(String(chunk))
    })
    f.process.stdin.end('initialize\n')
    f.native.stdout.write('session ready\n')
    f.native.stderr.write('diagnostic\n')
    await new Promise(resolve => setImmediate(resolve))
    expect(input).toEqual(['initialize\n'])
    expect(f.native.stdin.writableFinished).toBe(true)
    expect(f.output.map(String)).toEqual(['session ready\n', 'diagnostic\n'])
  })
  it('retains the original daemon across authenticated detachment and still closes on Stop', () => {
    const f = guardianFixture(true, false, { restartDetachable: true })
    const command = { operation: 'detach', id: f.id, owner: 'same-lease',
      controlKey: 'a'.repeat(64), startTicks: '100' }
    f.native.stdout.emit('data', 'original-output')
    expect(f.output).toEqual(['original-output'])
    expect(f.control({ ...command, controlKey: 'b'.repeat(64) }).destroyed).toBe(true)
    expect(f.records.has('/private/restart-detached.json')).toBe(false)
    expect(f.control(command).replies).toHaveLength(1)
    const detached = f.records.get('/private/restart-detached.json')!
    expect(JSON.parse(detached)).toMatchObject({ id: f.id, owner: 'same-lease',
      guardian: { pid: 501, startTicks: '100' }, provider: { pid: 902, startTicks: '200' } })
    expect(detached).not.toMatch(/private-secret|controlKey/)
    expect(f.control(command).replies).toHaveLength(1)
    expect(f.records.get('/private/restart-detached.json')).toBe(detached)
    f.process.connected = false
    f.process.emit('disconnect')
    f.process.stdout.emit('error', { code: 'EPIPE' })
    f.process.stderr.emit('error', { code: 'EPIPE' })
    f.native.stdout.emit('data', 'detached-output')
    f.native.stderr.emit('data', 'detached-error')
    expect(f.output).toEqual(['original-output'])
    expect(f.signals).toEqual([])
    expect(f.control({ ...command, operation: 'stop' }).replies).toHaveLength(1)
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
  })
  it('keeps ordinary native launches tied to their original parent', () => {
    const f = guardianFixture()
    expect(f.control({ operation: 'detach', id: f.id, owner: 'same-lease',
      controlKey: 'a'.repeat(64), startTicks: '100' }).destroyed).toBe(true)
    expect(f.records.has('/private/restart-detached.json')).toBe(false)
    f.process.connected = false
    f.process.emit('disconnect')
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
  })
  it('records restart detachment on original IPC loss before releasing a reconnectable daemon', () => {
    const f = guardianFixture(true, false, { restartDetachable: true, reconnectableStdio: true })
    const command = { id: f.id, owner: 'same-lease', controlKey: 'a'.repeat(64), startTicks: '100' }
    f.process.stdin.write('{"id":"incomplete')
    f.process.connected = false
    f.process.emit('disconnect')
    f.process.stdout.emit('error', { code: 'EPIPE' })
    f.process.stderr.emit('error', { code: 'EPIPE' })
    expect(JSON.parse(f.records.get('/private/restart-detached.json')!)).toMatchObject({
      id: f.id, owner: 'same-lease', guardian: { pid: 501, startTicks: '100' },
      provider: { pid: 902, startTicks: '200' }, reconnectableStdio: true,
    })
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
    const attached = f.control({ ...command, operation: 'attach', connectionId: 'replacement' })
    expect(attached.destroyed).toBe(false)
    expect(JSON.parse(attached.replies[0]!)).toMatchObject({ accepted: true })
    expect(f.control({ ...command, operation: 'stop' }).replies).toHaveLength(1)
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
  })
  it.each([
    { restartDetachable: true as const },
    { reconnectableStdio: true as const },
  ])('stops original IPC loss unless both crash recovery options are enabled: %j', options => {
    const f = guardianFixture(true, false, options)
    f.process.connected = false
    f.process.emit('disconnect')
    expect(f.records.has('/private/restart-detached.json')).toBe(false)
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
  })
  it('detaches on a closed original output pipe and keeps the attached observer through late IPC loss', () => {
    const f = guardianFixture(true, false, { restartDetachable: true, reconnectableStdio: true })
    const command = { id: f.id, owner: 'same-lease', controlKey: 'a'.repeat(64), startTicks: '100' }
    f.process.stdout.emit('error', { code: 'EPIPE' })
    expect(f.records.has('/private/restart-detached.json')).toBe(true)
    const attached = f.control({ ...command, operation: 'attach', connectionId: 'replacement' })
    expect(attached.destroyed).toBe(false)
    f.process.connected = false
    f.process.emit('disconnect')
    f.process.stderr.emit('error', { code: 'EPIPE' })
    const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'same-thread' } }
    f.native.stdout.write(JSON.stringify(request) + '\n')
    expect(JSON.parse(attached.replies[1]!)).toEqual(request)
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
  })
  it('reconnects one authenticated stdio observer after release and preserves pending native requests', () => {
    const f = guardianFixture(true, false, { restartDetachable: true, reconnectableStdio: true })
    const command = { id: f.id, owner: 'same-lease', controlKey: 'a'.repeat(64), startTicks: '100' }
    const sent: unknown[] = []
    f.native.stdin.on('data', chunk => sent.push(JSON.parse(String(chunk))))
    f.process.stdin.write(JSON.stringify({ id: 'original:1', method: 'thread/start' }) + '\n')
    f.native.stdout.write(JSON.stringify({ id: 'original:1', result: {
      model: 'fixture-model', thread: { id: 'same-thread' }, sandbox: { type: 'readOnly' },
    } }) + '\n')
    expect(f.control({ ...command, operation: 'attach', connectionId: 'second' }).destroyed).toBe(true)
    expect(f.control({ ...command, operation: 'detach', controlKey: 'b'.repeat(64) }).destroyed).toBe(true)
    expect(f.control({ ...command, operation: 'detach' }).replies).toHaveLength(1)
    f.process.connected = false
    f.process.emit('disconnect')
    f.process.stdin.end()
    expect(f.native.stdin.writableEnded).toBe(false)
    const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'same-thread' } }
    f.native.stdout.write(JSON.stringify(request) + '\n')
    const environment = f.control({ ...command, operation: 'environment' })
    expect(JSON.parse(environment.replies[0]!)).toMatchObject({ variables: { FOREMAN_CODE_MCP_TOKEN: 'fixture-token' } })
    const attached = f.control({ ...command, operation: 'attach', connectionId: 'second' })
    expect(attached.destroyed).toBe(false)
    expect(JSON.parse(attached.replies[0]!)).toMatchObject({ accepted: true,
      threadSettings: { 'same-thread': { model: 'fixture-model', sandbox: { type: 'readOnly' } } } })
    expect(JSON.parse(attached.replies[1]!)).toEqual(request)
    expect(f.control({ ...command, operation: 'attach', connectionId: 'third' }).destroyed).toBe(true)
    expect(f.control({ ...command, operation: 'detach', connectionId: 'wrong' }).destroyed).toBe(true)
    attached.socket.emit('data', Buffer.from(JSON.stringify({ id: 7, result: { answers: {} } }) + '\n'))
    expect(sent.at(-1)).toEqual({ id: 7, result: { answers: {} } })
    expect(f.control({ ...command, operation: 'detach', connectionId: 'second' }).replies).toHaveLength(1)
    expect(attached.destroyed).toBe(true)
    const resumed = f.control({ ...command, operation: 'attach', connectionId: 'third' })
    expect(resumed.replies).toHaveLength(1)
    const result = { method: 'turn/completed', params: { threadId: 'same-thread',
      turn: { id: 'same-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Original result' }] } } }
    f.native.stdout.write(JSON.stringify(result) + '\n')
    expect(JSON.parse(resumed.replies[1]!)).toEqual(result)
    expect(f.signals).toEqual([])
    expect(f.control({ ...command, operation: 'stop' }).replies).toHaveLength(1)
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
  })
  it('releases a lost observer and discards its partial input while rejecting another owner cleanup', () => {
    const f = guardianFixture(true, false, { restartDetachable: true, reconnectableStdio: true })
    const command = { id: f.id, owner: 'same-lease', controlKey: 'a'.repeat(64), startTicks: '100' }
    expect(f.control({ ...command, operation: 'detach' }).replies).toHaveLength(1)
    const initial = f.control({ ...command, operation: 'attach', connectionId: 'initial' })
    initial.socket.emit('data', Buffer.from('{"id":"partial'))
    initial.socket.emit('close')
    expect(f.control({ ...command, operation: 'stop', owner: 'settings:mcp:codex' }).destroyed).toBe(true)
    expect(f.control({ ...command, operation: 'detach', controlKey: 'b'.repeat(64) }).destroyed).toBe(true)
    const replacement = f.control({ ...command, operation: 'attach', connectionId: 'replacement' })
    expect(replacement.destroyed).toBe(false)
    const input: unknown[] = []
    f.native.stdin.on('data', chunk => input.push(JSON.parse(String(chunk))))
    const read = { id: 'read', method: 'thread/read', params: { threadId: 'same-thread' } }
    replacement.socket.emit('data', Buffer.from(JSON.stringify(read) + '\n'))
    expect(input).toEqual([read])
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
  })
  it('preserves pending native requests and thread settings through repeated observer loss', () => {
    const f = guardianFixture(true, false, { restartDetachable: true, reconnectableStdio: true })
    const command = { id: f.id, owner: 'same-lease', controlKey: 'a'.repeat(64), startTicks: '100' }
    const sent: unknown[] = []
    f.native.stdin.on('data', chunk => sent.push(JSON.parse(String(chunk))))
    f.process.stdin.write(JSON.stringify({ id: 'thread', method: 'thread/start' }) + '\n')
    f.native.stdout.write(JSON.stringify({ id: 'thread', result: {
      thread: { id: 'same-thread' }, model: 'fixture-model', sandbox: { type: 'readOnly' },
    } }) + '\n')
    expect(f.control({ ...command, operation: 'detach' }).replies).toHaveLength(1)
    const marker = f.records.get('/private/restart-detached.json')
    const request = { id: 7, method: 'item/tool/requestUserInput', params: { threadId: 'same-thread' } }
    f.native.stdout.write(JSON.stringify(request) + '\n')
    for (const connectionId of ['first', 'second', 'third']) {
      const observer = f.control({ ...command, operation: 'attach', connectionId })
      expect(observer.destroyed).toBe(false)
      expect(JSON.parse(observer.replies[0]!)).toMatchObject({
        threadSettings: { 'same-thread': { model: 'fixture-model', sandbox: { type: 'readOnly' } } },
      })
      expect(JSON.parse(observer.replies[1]!)).toEqual(request)
      observer.socket.emit('close')
      expect(f.records.get('/private/restart-detached.json')).toBe(marker)
    }
    expect(sent).toEqual([{ id: 'thread', method: 'thread/start' }])
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
  })
  it('journals actual child PID/startTicks and positive CLI exit independently of wrapper termination', async () => {
    const f = guardianFixture()
    const birth = JSON.parse(f.records.get('/private/provider.json')!) as Record<string, unknown>
    expect(birth).toMatchObject({ owner: 'same-lease', guardian: { pid: 501, startTicks: '100' }, provider: { pid: 902, startTicks: '200' }, capture: 'captured' })
    expect(JSON.stringify(birth)).not.toMatch(/private-argument|private-secret|SECRET|controlKey/)
    expect(f.ipc).toHaveLength(1)
    expect(f.records.has('/private/provider-exit.json')).toBe(false)
    f.native.emit('exit', 0, null)
    expect(JSON.parse(f.records.get('/private/provider-exit.json')!)).toMatchObject({ provider: { pid: 902, startTicks: '200' }, code: 0, signal: null })
    expect(f.ipc).toHaveLength(3)
    expect(f.ipc[2]).toMatchObject({ operation: 'native_exit', guardian: { pid: 501, startTicks: '100' }, nativePid: 902, exitCode: 0, exitSignal: null })
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
    f.flushed[0]!()
    await new Promise(resolve => setImmediate(resolve))
    expect(f.kills).toEqual(['1'])
    expect(f.timers).toEqual([])
  })
  it('keeps a disappeared-before-capture child uncertain and never substitutes the guardian PID', () => {
    const f = guardianFixture(false)
    const birth = JSON.parse(f.records.get('/private/provider.json')!) as Record<string, unknown>
    expect(birth.capture).toBe('unavailable')
    expect(birth.provider).toBeUndefined()
    f.native.emit('exit', null, 'SIGTERM')
    expect(JSON.parse(f.records.get('/private/provider-exit.json')!)).toMatchObject({ code: null, signal: 'SIGTERM' })
    expect(f.ipc[2]).toMatchObject({ operation: 'native_exit', nativePid: 902, exitCode: null, exitSignal: 'SIGTERM' })
  })
  it('retains native outcome and defers cleanup until receipt flush when passive writes fail', async () => {
    const f = guardianFixture(true, true)
    expect(f.records.has('/private/provider.json')).toBe(false)
    expect(f.signals).toEqual([])
    f.native.emit('exit', 7, null)
    expect(f.records.has('/private/provider-exit.json')).toBe(false)
    expect(f.ipc).toHaveLength(1)
    expect(f.ipc[0]).toMatchObject({ operation: 'native_exit', nativePid: 902, exitCode: 7, exitSignal: null })
    expect(f.signals).toEqual([])
    expect(f.kills).toEqual([])
    f.flushed[0]!()
    await new Promise(resolve => setImmediate(resolve))
    expect(f.kills).toEqual(['1'])
    expect(f.timers).toEqual([])
  })
  it('retains the one-second grace period for cancellation while the provider is running', () => {
    const f = guardianFixture()
    f.process.emit('SIGTERM')
    expect(f.signals).toEqual([[-501, 'SIGTERM']])
    expect(f.kills).toEqual([])
    expect(f.timers).toHaveLength(1)
    expect(f.timers[0]!.delay).toBe(1000)
    f.native.emit('exit', null, 'SIGTERM')
    f.flushed[0]!()
    expect(f.kills).toEqual([])
    expect(f.timers).toHaveLength(1)
    f.timers[0]!.callback()
    expect(f.kills).toEqual(['1'])
  })
})

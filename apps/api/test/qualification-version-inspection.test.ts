import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { nativeCompatibilityProbe, type CompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { passiveDriverPayloads } from '../src/modules/harnesses/payloadDiscovery.js'

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) }
})
vi.mock('../src/modules/harnesses/payloadDiscovery.js', async original => {
  const payloads = await original<typeof import('../src/modules/harnesses/payloadDiscovery.js')>()
  return { ...payloads, passiveDriverPayloads: vi.fn(payloads.passiveDriverPayloads) }
})

function virtualNativeDeadlines() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // Node's AbortSignal.timeout uses internal timers, so bridge it to the fake clock.
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      milliseconds)
    return controller.signal
  })
}

function gate() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), release: () => resolve() }
}

function service(binary: string, factory: (timeoutMs: number) => CompatibilityProbe,
  refreshInstalled?: ConstructorParameters<typeof HarnessQualificationService>[9], previous: unknown = null) {
  const save = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ checks: [{ id: 'recorded', passed: true, detail: null }], evidence: {} }))
  const qualification = new HarnessQualificationService({ find: async () => previous, save } as never,
    { inspectBinary: async () => ({ binary, sha256: createHash('sha256')
      .update(await readFile(binary)).digest('hex') }), trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: 'recorded', run } },
    { codex: binary }, {} as never,
    { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) },
    async () => 'recorded-schema', undefined, (_harness, _binary, timeoutMs) => factory(timeoutMs), refreshInstalled)
  return { qualification, run, save }
}

async function binaryFixture(program: string) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-version-'))
  const binary = join(directory, 'native-cli.cjs')
  await writeFile(binary, `#!${process.execPath}\n${program}\n`, { mode: 0o700 })
  await chmod(binary, 0o700)
  return { directory, binary }
}

it('keeps installation verification and closure outside the native version-command deadline', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.154.0')")
  const verifying = gate()
  const verified = gate()
  const closing = gate()
  const closed = gate()
  const instance = service(f.binary, timeoutMs => {
    const raw = nativeCompatibilityProbe({ codex: f.binary }, f.directory, process.env, timeoutMs)
    return { ...raw, async inspect(harness, signal) {
      verifying.release()
      await verified.promise
      signal.throwIfAborted()
      const result = await raw.inspect(harness, signal)
      closing.release()
      await closed.promise
      signal.throwIfAborted()
      return result
    } }
  })
  const deadlines = virtualNativeDeadlines()
  const admitted = instance.qualification.begin('codex')
  const result = admitted.then(value => ({ value }), error => ({ error }))
  try {
    await verifying.promise
    await vi.advanceTimersByTimeAsync(6000)
    verified.release()
    await closing.promise
    await vi.advanceTimersByTimeAsync(6000)
    closed.release()
    expect(await result).toMatchObject({ value: { version: '0.154.0', status: 'qualifying' } })
    await instance.qualification.join()
    expect(instance.run).toHaveBeenCalledOnce()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }),
      expect.any(Object))
  } finally {
    verified.release()
    closed.release()
    await result
    vi.useRealTimers()
    deadlines.mockRestore()
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('refuses a binary replacement after version inspection before admitting its suite', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.160.1')")
  const instance = service(f.binary, timeoutMs => {
    const raw = nativeCompatibilityProbe({ codex: f.binary }, f.directory, process.env, timeoutMs)
    return { ...raw, async inspect(harness, signal) {
      const result = await raw.inspect(harness, signal)
      await appendFile(f.binary, '\n// replacement payload\n')
      return result
    } }
  })
  try {
    await instance.qualification.begin('codex')
    await instance.qualification.join()
    expect(instance.run).not.toHaveBeenCalled()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed',
      version: '0.160.1', failureReason: expect.stringContaining('changed before its native contract checks') }))
  } finally {
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('qualifies after slow payload hashing and still detects payload replacement', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.154.0')")
  const payload = join(f.directory, 'native-payload')
  await writeFile(payload, 'native payload bytes')
  const hashing = gate()
  const hashed = gate()
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const installations: Awaited<ReturnType<CompatibilityProbe['inspect']>>[] = []
  const instance = service(f.binary, timeoutMs => {
    const raw = nativeCompatibilityProbe({ codex: f.binary }, f.directory, process.env, timeoutMs)
    return { ...raw, async inspect(harness, signal) {
      const installation = await raw.inspect(harness, signal)
      installations.push(installation)
      return installation
    } }
  })
  vi.mocked(passiveDriverPayloads).mockResolvedValueOnce({ complete: true, paths: [payload] })
  vi.mocked(createReadStream).mockImplementation((path, options) => {
    if (path !== payload) return fs.createReadStream(path, options)
    return Readable.from((async function* () {
      hashing.release()
      await hashed.promise
      yield* fs.createReadStream(path, options)
    })()) as ReturnType<typeof createReadStream>
  })
  const deadlines = virtualNativeDeadlines()
  const result = instance.qualification.begin('codex').then(value => ({ value }), error => ({ error }))
  try {
    await hashing.promise
    await vi.advanceTimersByTimeAsync(6000)
    hashed.release()
    expect(await result).toMatchObject({ value: { version: '0.154.0', status: 'qualifying' } })
    await instance.qualification.join()
    expect(instance.run).toHaveBeenCalledOnce()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }),
      expect.any(Object))
    const probe = nativeCompatibilityProbe({ codex: f.binary }, f.directory)
    try {
      await probe.assertUnchanged(installations[0]!, new AbortController().signal)
      await appendFile(payload, 'replacement bytes')
      await expect(probe.assertUnchanged(installations[0]!, new AbortController().signal))
        .rejects.toMatchObject({ code: 'CLI_CHANGED' })
    } finally {
      await probe.close?.()
    }
  } finally {
    hashed.release()
    await result
    vi.useRealTimers()
    deadlines.mockRestore()
    vi.mocked(createReadStream).mockImplementation(fs.createReadStream)
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('still stops a stalled version command at the native deadline without admitting a suite', async () => {
  const f = await binaryFixture(`
    require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ready'), '')
    setInterval(() => {}, 1000)
  `)
  const instance = service(f.binary, timeoutMs => nativeCompatibilityProbe(
    { codex: f.binary }, f.directory, process.env, timeoutMs))
  const deadlines = virtualNativeDeadlines()
  try {
    const rejected = expect(instance.qualification.begin('codex')).rejects.toMatchObject({
      name: 'DomainError', code: 'HARNESS_CHECK_TIMEOUT', status: 503,
      message: 'The native check timed out. Try again.',
    })
    await vi.waitFor(async () => { await readFile(join(f.directory, 'ready')) }, { interval: 1 })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    await instance.qualification.join()
    expect(instance.run).not.toHaveBeenCalled()
    expect(instance.save).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
    deadlines.mockRestore()
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
}, 40_000)

it('allows a cold native version command to load beyond five seconds', async () => {
  const f = await binaryFixture(`
    const fs = require('node:fs')
    const path = require('node:path')
    const watcher = fs.watch(__dirname, () => {
      if (!fs.existsSync(path.join(__dirname, 'release'))) return
      watcher.close()
      console.log('codex-cli 0.154.0')
    })
    fs.writeFileSync(path.join(__dirname, 'ready'), '')
  `)
  const instance = service(f.binary, timeoutMs => nativeCompatibilityProbe(
    { codex: f.binary }, f.directory, process.env, timeoutMs))
  const deadlines = virtualNativeDeadlines()
  try {
    const admitted = expect(instance.qualification.begin('codex')).resolves.toMatchObject({
      version: '0.154.0', status: 'qualifying',
    })
    await vi.waitFor(async () => { await readFile(join(f.directory, 'ready')) }, { interval: 1 })
    await vi.advanceTimersByTimeAsync(6000)
    await writeFile(join(f.directory, 'release'), '')
    await admitted
    await instance.qualification.join()
    expect(instance.run).toHaveBeenCalledOnce()
    expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }),
      expect.any(Object))
  } finally {
    vi.useRealTimers()
    deadlines.mockRestore()
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('reports inventory refresh timeouts as domain errors before admitting a suite', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.154.0')")
  const factory = vi.fn((timeoutMs: number) => nativeCompatibilityProbe(
    { codex: f.binary }, f.directory, process.env, timeoutMs))
  const instance = service(f.binary, factory, async () => { throw new DOMException('Refresh timed out', 'TimeoutError') })
  try {
    await expect(instance.qualification.begin('codex')).rejects.toMatchObject({
      name: 'DomainError', code: 'HARNESS_CHECK_TIMEOUT', status: 503,
    })
    expect(factory).not.toHaveBeenCalled()
    expect(instance.run).not.toHaveBeenCalled()
  } finally {
    await instance.qualification.shutdown()
    await removeFixtureDirectory(f.directory)
  }
})

it('finishes the pre-launch identity check before starting the version-command deadline', async () => {
  const f = await binaryFixture("console.log('codex-cli 0.154.0')")
  const checking = gate()
  const checked = gate()
  const beforeCommand = vi.fn(async (_binary: string, signal: AbortSignal) => {
    checking.release()
    await checked.promise
    signal.throwIfAborted()
    throw new Error('Installation changed before launch')
  })
  const probe = nativeCompatibilityProbe({ codex: f.binary }, f.directory, process.env, 25, {
    recovery: { root: f.directory, owner: 'identity-check' }, beforeCommand,
  })
  const deadlines = virtualNativeDeadlines()
  try {
    const rejected = expect(probe.inspect('codex', new AbortController().signal))
      .rejects.toThrow('Installation changed before launch')
    await checking.promise
    await vi.advanceTimersByTimeAsync(100)
    checked.release()
    await rejected
    expect(beforeCommand).toHaveBeenCalledOnce()
  } finally {
    checked.release()
    vi.useRealTimers()
    deadlines.mockRestore()
    await probe.close?.()
    await removeFixtureDirectory(f.directory)
  }
})

it.each([['qualified', 1], ['failed', 0], [null, 0]] as const)(
  'after a restart re-runs the live suite only for a binary previously %s', async (status, runs) => {
    const f = await binaryFixture("console.log('codex-cli 0.154.0')")
    const instance = service(f.binary, timeoutMs => nativeCompatibilityProbe({ codex: f.binary }, f.directory,
      process.env, timeoutMs), undefined, status ? { harness: 'codex', version: '0.154.0', status, checks: [] } : null)
    try {
      const restored = await instance.qualification.restore('codex')
      if (runs) expect(restored).toMatchObject({ version: '0.154.0', status: 'qualifying' })
      else expect(restored).toBeNull()
      await instance.qualification.join()
      expect(instance.run).toHaveBeenCalledTimes(runs)
      if (runs) expect(instance.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }), expect.any(Object))
    } finally {
      await instance.qualification.shutdown()
      await removeFixtureDirectory(f.directory)
    }
  })

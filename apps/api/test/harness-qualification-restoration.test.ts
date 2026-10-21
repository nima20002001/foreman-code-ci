import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import type { HarnessQualification } from '@foreman-code/contracts/harness-qualification'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'
import { parseInstalledVersion } from '../src/modules/harnesses/compatibility/probe.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { DomainError } from '../src/modules/errors.js'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }))

const directories: string[] = []

afterEach(async () => {
  vi.mocked(delay).mockReset()
  vi.mocked(delay).mockResolvedValue(undefined)
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(previousStatus: 'qualified' | 'failed' | null = 'qualified',
  options: { nativeStatic?: true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-qualification-restoration-'))
  directories.push(directory)
  const binary = join(directory, 'native-cli')
  const bytes = Buffer.from('qualification binary identity fixture; never executed')
  await writeFile(binary, bytes, { mode: 0o700 })
  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const record: HarnessQualification = {
    harness: 'codex', version: '0.162.1', binarySha256,
    suiteRevision: 'restoration-suite', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'native-turn', passed: true, detail: null }], failureReason: null,
    startedAt: '2026-10-01T00:00:00.000Z', checkedAt: '2026-10-01T00:00:01.000Z',
  }
  let persisted: HarnessQualification | null = previousStatus ? { ...record, status: previousStatus } : null
  const find = vi.fn(async (harness: string, version: string, sha256: string, revision: string) => {
    if (persisted?.harness !== harness || persisted.version !== version
      || persisted.binarySha256 !== sha256 || persisted.suiteRevision !== revision) return null
    return persisted
  })
  const save = vi.fn(async (value: HarnessQualification) => { persisted = value })
  const inspect = vi.fn(async () => ({ executable: binary, identity: 'installation', version: record.version }))
  const close = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => undefined)
  const run = vi.fn(async () => ({ checks: record.checks, evidence: { environment: 'restarted' } }))
  const staticCheck = vi.fn(async () => 'schema')
  const inspectBinary = vi.fn(async () => ({ binary,
    sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }))
  const qualification = new HarnessQualificationService({ find, save,
    list: async () => persisted ? [persisted] : [] } as never,
    { inspectBinary, trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: record.suiteRevision, run } }, { codex: binary }, {} as never,
    { getManagedHarnessDefaults: async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }) },
    options.nativeStatic ? undefined : staticCheck, undefined,
    () => ({ inspect, close, probe: async () => 'schema', assertUnchanged: async () => undefined }), refresh)
  return { qualification, record, find, save, inspect, close, refresh, run, staticCheck, binary }
}

it.each([
  new DOMException('Version check timed out', 'TimeoutError'),
  new CompatibilityCheckError('CHECK_TIMEOUT', 'Version check timed out'),
  new DomainError('HARNESS_CHECK_TIMEOUT', 'Inventory check timed out', 503),
])('restores a qualified binary after transient startup inspection failures: $name', async error => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(error).mockRejectedValueOnce(error)
  try {
    expect(await f.qualification.restore('codex')).toMatchObject({ status: 'qualifying', version: '0.162.1' })
    await f.qualification.join()
    expect(f.inspect).toHaveBeenCalledTimes(3)
    expect(f.close).toHaveBeenCalledTimes(3)
    expect(f.refresh).toHaveBeenCalledTimes(3)
    expect(f.run).toHaveBeenCalledOnce()
    const reader = ManagementPrincipalSchema.parse({ id: 'qualification-reader', name: 'Qualification reader',
      audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null })
    expect(await f.qualification.list(reader))
      .toMatchObject({ qualifications: [{ status: 'qualified', version: '0.162.1',
        binarySha256: f.record.binarySha256, checks: expect.arrayContaining(f.record.checks) }] })
  } finally { await f.qualification.shutdown() }
})

it.each(['failed', null] as const)('does not restore an unqualified binary after a timeout: %s', async status => {
  const f = await fixture(status)
  f.inspect.mockRejectedValueOnce(new DOMException('Version check timed out', 'TimeoutError'))
  try {
    expect(await f.qualification.restore('codex')).toBeNull()
    await f.qualification.join()
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.run).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('keeps automatic Main profile verification pending through startup inspection timeouts', async () => {
  const f = await fixture()
  f.refresh.mockRejectedValueOnce(new DOMException('Inventory timed out', 'TimeoutError'))
  f.inspect.mockRejectedValueOnce(new CompatibilityCheckError('CHECK_TIMEOUT', 'Version check timed out'))
  try {
    expect(await f.qualification.verify('codex', { force: true })).toMatchObject({
      status: 'qualified', version: '0.162.1', binarySha256: f.record.binarySha256,
    })
    expect(f.refresh).toHaveBeenCalledTimes(3)
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(f.run).toHaveBeenCalledOnce()
  } finally { await f.qualification.shutdown() }
})

it('coalesces restart restoration and cancels the retry wait on shutdown', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValue(new DOMException('Version check timed out', 'TimeoutError'))
  vi.mocked(delay).mockImplementation((_milliseconds, _value, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const restored = f.qualification.restore('codex')
  const rejected = expect(restored).rejects.toMatchObject({ name: 'AbortError' })
  try {
    expect(f.qualification.restore('codex')).toBe(restored)
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce())
    await f.qualification.shutdown()
    await rejected
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('does not retry an inspection whose native cleanup is unconfirmed', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValueOnce(new DOMException('Version check timed out', 'TimeoutError'))
  f.close.mockRejectedValueOnce(new Error('Unconfirmed cleanup'))
  try {
    await expect(f.qualification.restore('codex')).rejects.toBeInstanceOf(AggregateError)
    expect(delay).not.toHaveBeenCalled()
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

const invalidVersion = () => new CompatibilityCheckError('CLI_VERSION_INVALID',
  'The configured CLI returned an unrecognized version. Check the binary setting and retry.')

it.each(['', 'codex-cli 0.162.', 'unrecognized output'])(
  'restores an unchanged qualified binary after invalid startup version output: %j', async output => {
    const f = await fixture()
    f.inspect.mockImplementationOnce(async () => ({ executable: f.binary, identity: 'installation',
      version: parseInstalledVersion(output, '') }))
    try {
      expect(await f.qualification.restore('codex')).toMatchObject({ status: 'qualifying' })
      await f.qualification.join()
      expect(f.inspect).toHaveBeenCalledTimes(2)
      expect(f.close).toHaveBeenCalledTimes(2)
      expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([1_000])
      expect(f.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
      expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'qualified' }), expect.any(Object))
    } finally { await f.qualification.shutdown() }
  },
)

it('retries invalid version output in the automatic static check before publishing a failure', async () => {
  const f = await fixture('qualified', { nativeStatic: true })
  f.inspect.mockResolvedValueOnce({ executable: f.binary, identity: 'installation', version: f.record.version })
    .mockRejectedValueOnce(invalidVersion()).mockRejectedValueOnce(invalidVersion())
  try {
    expect(await f.qualification.verify('codex', { force: true })).toMatchObject({ status: 'qualified',
      checks: expect.arrayContaining([{ id: 'static-compatibility', passed: true, detail: 'schema (3 attempts)' }]) })
    expect(f.inspect).toHaveBeenCalledTimes(4)
    expect(f.close).toHaveBeenCalledTimes(4)
    expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([1_000, 2_000])
    expect(f.run).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  } finally { await f.qualification.shutdown() }
})

it.each(['inspection', 'static check'] as const)(
  'bounds invalid startup version retries during %s and persists the failure', async stage => {
    const f = await fixture()
    if (stage === 'inspection') f.inspect.mockRejectedValue(invalidVersion())
    else f.staticCheck.mockRejectedValue(invalidVersion())
    try {
      if (stage === 'inspection') {
        await expect(f.qualification.restore('codex')).rejects.toMatchObject({ code: 'CLI_VERSION_INVALID' })
        expect(f.inspect).toHaveBeenCalledTimes(4)
        expect(f.close).toHaveBeenCalledTimes(4)
      } else {
        expect(await f.qualification.verify('codex', { force: true })).toMatchObject({ status: 'failed' })
        expect(f.staticCheck).toHaveBeenCalledTimes(4)
      }
      expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([1_000, 2_000, 4_000])
      expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed',
        binarySha256: f.record.binarySha256,
        checks: [{ id: 'static-compatibility', passed: false, detail: invalidVersion().message }] }))
      expect(f.run).not.toHaveBeenCalled()
    } finally { await f.qualification.shutdown() }
  },
)

it.each(['failed', null] as const)('does not retry invalid version output for an unqualified binary: %s', async status => {
  const f = await fixture(status)
  f.inspect.mockRejectedValue(invalidVersion())
  try {
    await expect(f.qualification.restore('codex')).rejects.toMatchObject({ code: 'CLI_VERSION_INVALID' })
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('does not retry a changed binary with an invalid startup version', async () => {
  const f = await fixture()
  await writeFile(f.binary, 'replacement binary')
  f.inspect.mockRejectedValue(invalidVersion())
  try {
    await expect(f.qualification.restore('codex')).rejects.toMatchObject({ code: 'CLI_VERSION_INVALID' })
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it.each(['failed', null] as const)('does not retry an invalid static version for an unqualified binary: %s', async status => {
  const f = await fixture(status)
  f.staticCheck.mockRejectedValue(invalidVersion())
  try {
    expect(await f.qualification.verify('codex', { force: true })).toMatchObject({ status: 'failed' })
    expect(f.staticCheck).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('stops retrying when binary bytes change during the backoff', async () => {
  const f = await fixture()
  f.staticCheck.mockRejectedValue(invalidVersion())
  vi.mocked(delay).mockImplementationOnce(async () => { await writeFile(f.binary, 'replacement binary') })
  try {
    expect(await f.qualification.verify('codex', { force: true })).toMatchObject({ status: 'failed',
      checks: [{ id: 'static-compatibility', passed: false,
        detail: 'The CLI changed during qualification. Retry after the installation has finished.' }] })
    expect(f.staticCheck).toHaveBeenCalledOnce()
    expect(delay).toHaveBeenCalledOnce()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it.each(['version', 'protocol', 'cleanup'] as const)('does not retry a genuine %s failure', async failure => {
  const f = await fixture('qualified', { nativeStatic: true })
  f.inspect.mockResolvedValueOnce({ executable: f.binary, identity: 'installation', version: f.record.version })
  if (failure === 'version') {
    f.inspect.mockResolvedValue({ executable: f.binary, identity: 'installation', version: '0.163.0' })
  } else if (failure === 'protocol') {
    f.inspect.mockRejectedValue(new CompatibilityCheckError('PROTOCOL_SETTINGS_UNSUPPORTED', 'Required method missing'))
  } else {
    f.inspect.mockRejectedValue(invalidVersion())
    f.close.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Unconfirmed cleanup'))
  }
  try {
    const result = f.qualification.verify('codex', { force: true })
    if (failure === 'cleanup') await expect(result).rejects.toBeInstanceOf(AggregateError)
    else expect(await result).toMatchObject({ status: 'failed' })
    expect(f.inspect).toHaveBeenCalledTimes(2)
    expect(delay).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

it('keeps explicit qualification failures immediate', async () => {
  const f = await fixture()
  f.staticCheck.mockRejectedValue(invalidVersion())
  try {
    expect(await f.qualification.begin('codex', true)).toMatchObject({ status: 'qualifying' })
    await f.qualification.join()
    expect(f.staticCheck).toHaveBeenCalledOnce()
    expect(delay).not.toHaveBeenCalled()
    expect(f.save).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
  } finally { await f.qualification.shutdown() }
})

it('cancels the invalid-version backoff on shutdown without recording a failure', async () => {
  const f = await fixture()
  f.inspect.mockRejectedValue(invalidVersion())
  vi.mocked(delay).mockImplementation((_milliseconds, _value, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const restored = f.qualification.restore('codex')
  const rejected = expect(restored).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce())
    await f.qualification.shutdown()
    await rejected
    expect(f.inspect).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
  } finally { await f.qualification.shutdown() }
})

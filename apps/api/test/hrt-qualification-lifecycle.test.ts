import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'

vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>(), mkdtemp: vi.fn(async () => '/qualification-owned'), rm: vi.fn(async () => undefined) }))
vi.mock('../src/modules/harnesses/compatibility/probe.js', async (original) => ({ ...await original<typeof import('../src/modules/harnesses/compatibility/probe.js')>(), nativeCompatibilityProbe: vi.fn(() => ({ inspect: vi.fn(async () => ({ version: '0.158.0' })), close: vi.fn(async () => undefined) })) }))

import { mkdtemp, rm } from 'node:fs/promises'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { HarnessQualificationService } from '../src/modules/harnesses/qualification/service.js'
import { deferred } from './helpers/deferred.js'

const binaryDirectories: string[] = []
function fixture(staticCheck: ConstructorParameters<typeof HarnessQualificationService>[6] = async () => 'schema') {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-lifecycle-binary-'))
  binaryDirectories.push(directory)
  const binary = join(directory, 'codex')
  const bytes = Buffer.from('model-free binary identity fixture')
  writeFileSync(binary, bytes)
  const inspectBinary = vi.fn(async () => ({ binary, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const save = vi.fn(async (qualification: import('@foreman-code/contracts/harness-qualification').HarnessQualification, evidence?: Record<string, unknown>): Promise<void> => { void qualification; void evidence })
  const run = vi.fn(async (input: QualificationSuiteInput) => { void input; return { checks: [{ id: 'live', passed: true, detail: null }], evidence: {} } })
  const audit = vi.fn(async (): Promise<void> => undefined)
  const settings = vi.fn(async () => ({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS }))
  const service = new HarnessQualificationService({ find: async () => undefined, save } as never,
    { inspectBinary, trusted: async () => true } as never,
    { codex: { harness: 'codex', revision: 'test', run } },
    { codex: binary }, { recordAudit: audit } as never,
    { getManagedHarnessDefaults: settings }, staticCheck)
  return { service, binary, inspectBinary, save, run, audit, settings }
}

afterEach(() => { for (const directory of binaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.clearAllMocks(); vi.mocked(rm).mockResolvedValue(undefined); vi.mocked(mkdtemp).mockResolvedValue('/qualification-owned') })

describe('qualification stop/cancel/join', () => {
  it('settles an interruption after static success before shutdown finishes', async () => {
    const entered = deferred(), staticResult = deferred<string>(), finalSave = deferred()
    const f = fixture(async () => { entered.resolve(); return staticResult.promise })
    f.save.mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalSave.promise)
    await f.service.begin('codex'); await entered.promise
    let joined = false
    const stopped = f.service.shutdown().then(() => { joined = true })
    staticResult.resolve('schema')
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    expect(f.save.mock.calls[1]?.[0]).toMatchObject({ status: 'failed', checkedAt: expect.any(String),
      checks: [{ id: 'static-compatibility', passed: true }] })
    expect(joined).toBe(false)
    expect(f.run).not.toHaveBeenCalled(); expect(mkdtemp).not.toHaveBeenCalled()
    finalSave.resolve(); await stopped
  })

  it('settles project preparation failure without granting trust', async () => {
    const f = fixture()
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('project creation failed'))
    await f.service.begin('codex'); await f.service.join()
    expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'failed', checkedAt: expect.any(String),
      checks: [{ id: 'static-compatibility', passed: true }] })
    expect(f.run).not.toHaveBeenCalled(); expect(rm).not.toHaveBeenCalled()
    await f.service.shutdown()
  })

  it('owns and removes a project acquired while shutdown is waiting', async () => {
    const f = fixture(), project = deferred<string>()
    vi.mocked(mkdtemp).mockReturnValueOnce(project.promise)
    await f.service.begin('codex')
    await vi.waitFor(() => expect(mkdtemp).toHaveBeenCalledTimes(1))
    const stopped = f.service.shutdown()
    project.resolve('/qualification-owned')
    await stopped
    expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'failed' })
    expect(f.run).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledWith('/qualification-owned', { recursive: true, force: true })
  })

  it('releases operation deadline timers after successful settlement', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.begin('codex')
    await f.service.join()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.run).toHaveBeenCalledTimes(1)
    await f.service.shutdown()
  })

  it('joins an admitted management audit before shutdown can complete', async () => {
    const f = fixture(), audit = deferred()
    f.audit.mockReturnValue(audit.promise)
    const principal = { id: 'principal', name: 'Fixture', audience: 'operator' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
      grants: [{ actions: ['harnesses:update' as const], scope: {} }] }
    const request = f.service.run(principal, 'mcp', 'codex')
    await vi.waitFor(() => expect(f.audit).toHaveBeenCalledTimes(1))
    let joined = false
    const shutdown = f.service.shutdown().then(() => { joined = true })
    await Promise.resolve(); expect(joined).toBe(false)
    audit.resolve(); await request; await shutdown
    expect(f.audit).toHaveBeenCalledWith('principal', 'mcp', 'harness.qualification.run', 'codex', 'succeeded')
  })

  it('refuses qualification trust when settings change before or during persistence', async () => {
    for (const duringSave of [false, true]) {
      const f = fixture()
      let revision = 0
      f.settings.mockImplementation(async () => ({ revision, defaults: DEFAULT_HARNESS_DEFAULTS }))
      if (duringSave) f.save.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { revision = 1 })
      else f.run.mockImplementation(async () => { revision = 1; return { checks: [{ id: 'live', passed: true, detail: null }], evidence: {} } })
      await f.service.begin('codex'); await f.service.join()
      expect(f.save.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'failed' })
      await f.service.shutdown()
    }
  })

  it('registers preparation before its first await and stops before any version process starts', async () => {
    const f = fixture(), inspecting = deferred<Awaited<ReturnType<typeof f.inspectBinary>>>()
    f.inspectBinary.mockReturnValueOnce(inspecting.promise)
    const begin = f.service.begin('codex')
    const rejection = expect(begin).rejects.toMatchObject({ name: 'AbortError' })
    let joined = false
    const shutdown = f.service.shutdown().then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    inspecting.resolve({ binary: '/fixture/codex', sha256: 'a'.repeat(64) })
    await rejection; await shutdown
    expect(nativeCompatibilityProbe).not.toHaveBeenCalled()
    await expect(f.service.begin('codex')).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('shares one suite and joins abort handling, final persistence and directory cleanup', async () => {
    const f = fixture(), entered = deferred(), cleanup = deferred(), finalSave = deferred()
    f.run.mockImplementation(async (input) => {
      entered.resolve()
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }))
      await cleanup.promise
      throw input.signal.reason
    })
    f.save.mockResolvedValueOnce(undefined).mockImplementationOnce(() => finalSave.promise)
    await f.service.begin('codex'); await entered.promise
    await f.service.begin('codex')
    expect(f.run).toHaveBeenCalledTimes(1)
    const first = f.service.shutdown()
    expect(f.service.shutdown()).toBe(first)
    let joined = false; void first.then(() => { joined = true })
    await Promise.resolve(); expect(joined).toBe(false)
    cleanup.resolve()
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    expect(joined).toBe(false); expect(rm).not.toHaveBeenCalled()
    finalSave.resolve(); await first
    expect(rm).toHaveBeenCalledWith('/qualification-owned', { recursive: true, force: true })
    expect(f.run.mock.calls[0]![0].signal.aborted).toBe(true)
  })

  it('does not start a suite after shutdown interrupts saved-default readback', async () => {
    const f = fixture(), saved = deferred<Awaited<ReturnType<typeof f.settings>>>()
    f.settings.mockReturnValue(saved.promise)
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.settings).toHaveBeenCalledTimes(1))
    const stopped = f.service.shutdown()
    saved.resolve({ revision: 0, defaults: DEFAULT_HARNESS_DEFAULTS })
    await stopped
    expect(f.run).not.toHaveBeenCalled(); expect(rm).toHaveBeenCalledTimes(1)
  })

  it('retains failed temporary cleanup and retries it without restarting native work', async () => {
    const f = fixture()
    vi.mocked(rm).mockRejectedValue(new Error('directory busy'))
    await f.service.begin('codex')
    await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    vi.mocked(rm).mockResolvedValue(undefined)
    await f.service.shutdown()
    expect(f.run).toHaveBeenCalledTimes(1); expect(rm).toHaveBeenCalledTimes(3)
  })

  it('retains a partially acquired diagnostic probe and retries its positive close barrier', async () => {
    const close = vi.fn(async (): Promise<void> => { throw new Error('process closure uncertain') })
    const probe = { inspect: vi.fn(async () => { throw new Error('probe failed') }), close }
    vi.mocked(nativeCompatibilityProbe).mockReturnValueOnce({ inspect: async () => ({ version: '0.158.0' }), close: async () => undefined } as never).mockReturnValueOnce(probe as never)
    const f = fixture(undefined)
    // Explicit undefined selects the production static probe rather than a fixture check.
    const service = new HarnessQualificationService({ find: async () => undefined, save: f.save } as never,
      { inspectBinary: f.inspectBinary } as never,
      { codex: { harness: 'codex', revision: 'test', run: f.run } },
      { codex: f.binary }, {} as never, { getManagedHarnessDefaults: f.settings })
    await service.begin('codex')
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    await expect(service.shutdown()).rejects.toThrow('cleanup was incomplete')
    close.mockResolvedValueOnce(undefined)
    await service.shutdown()
    expect(close).toHaveBeenCalledTimes(3); expect(f.run).not.toHaveBeenCalled()
  })

  it('retries registered native cleanup before removing its project and never repeats the suite', async () => {
    const f = fixture(), close = vi.fn(async (): Promise<void> => { throw new Error('cgroup nonempty') })
    f.run.mockImplementation(async (input) => {
      input.ownCleanup?.(close)
      throw new AggregateError([new Error('partial acquisition')], 'Native cleanup failed')
    })
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    expect(rm).not.toHaveBeenCalled()
    close.mockResolvedValueOnce(undefined)
    await f.service.shutdown()
    expect(f.run).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(2)
    expect(rm).toHaveBeenCalledTimes(1)
  })

  it('keeps unconfirmed suite cleanup visible instead of using a finished Promise as proof', async () => {
    const f = fixture()
    f.run.mockRejectedValue(new AggregateError([new Error('descendant alive')], 'Native closure unconfirmed'))
    await f.service.begin('codex')
    await vi.waitFor(() => expect(f.save).toHaveBeenCalledTimes(2))
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    await expect(f.service.shutdown()).rejects.toThrow('cleanup was incomplete')
    expect(rm).not.toHaveBeenCalled()
  })
})

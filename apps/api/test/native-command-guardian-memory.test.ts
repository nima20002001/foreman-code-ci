import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const seams = vi.hoisted(() => ({ spawn: vi.fn(), populated: vi.fn(), retire: vi.fn(), qualify: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: seams.spawn }))
vi.mock('../src/modules/harnesses/recovery/linuxIdentity.js', () => ({
  bootIdentity: () => '22222222-2222-2222-2222-222222222222',
  processIdentity: (pid: number) => ({ pid, startTicks: '100', group: pid, session: pid, state: 'S' }),
  identityAlive: () => true,
}))
vi.mock('../src/modules/harnesses/recovery/cgroupBoundary.js', () => ({
  cgroupBoundary: (value: unknown) => value,
  cgroupPopulated: seams.populated,
  retireCgroup: seams.retire,
  killCgroup: vi.fn(),
}))
vi.mock('../src/modules/harnesses/qualification/gate.js', () => ({ requireHarnessQualification: seams.qualify }))

import { runCommand } from '../src/modules/harnesses/process.js'
import { NATIVE_GUARDIAN_SOURCE } from '../src/modules/harnesses/recovery/nativeGuardian.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { readRecord, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.resetAllMocks() })

/** Actual runCommand and registry; only process/kernel/qualification IO is replaced.
 * The mock guardian publishes a birth certificate and native IPC, then its wrapper
 * exits via cleanup SIGKILL. Empty containment remains separate positive evidence. */
async function fixture(outcome: 0 | 7 | 'missing' | 'stale') {
  const root = mkdtempSync(join(tmpdir(), 'native-command-guardian-memory-'))
  roots.push(root)
  const registry = new NativeProcessRegistry(root)
  const recovery = await registry.reserveLaunch('version-owner')
  const wrapper = Object.assign(new EventEmitter(), {
    pid: 501, exitCode: null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    disconnect: vi.fn(), connected: true,
    send: vi.fn((_message, callback: (error?: Error) => void) => {
      queueMicrotask(() => {
        const directory = join(root, createHash('sha256').update(recovery.owner).digest('hex'), recovery.launchId!)
        writeRecord(join(directory, 'birth.json'), { format: 1, id: recovery.launchId, owner: recovery.owner,
          boot: '22222222-2222-2222-2222-222222222222',
          guardian: { pid: 501, startTicks: '100', group: 501, session: 501 },
          containment: { kind: 'cgroup-v2', path: '/mock/containment', device: '1', inode: '2' } })
        wrapper.emit('message', { operation: 'observation', id: recovery.launchId })
        if (outcome !== 'missing') wrapper.emit('message', { format: 1, operation: 'native_exit',
          id: recovery.launchId, owner: recovery.owner, boot: '22222222-2222-2222-2222-222222222222',
          guardian: { pid: 501, startTicks: outcome === 'stale' ? '101' : '100' },
          nativePid: 902, exitCode: typeof outcome === 'number' ? outcome : 0, exitSignal: null })
        wrapper.stdout.end('codex-cli 0.154.0\n'); wrapper.stderr.end()
        callback()
        wrapper.signalCode = 'SIGKILL'
        wrapper.emit('exit', null, 'SIGKILL')
        wrapper.emit('close', null, 'SIGKILL')
      })
      return true
    }),
  })
  seams.spawn.mockReturnValueOnce(wrapper)
  seams.populated.mockReturnValue(false)
  return { root, registry, recovery, wrapper }
}

describe('combined native command outcome and cleanup', () => {
  for (const code of [0, 7] as const) it(`returns native ${code} through the actual reader after positive cleanup`, async () => {
    const f = await fixture(code)
    const result = await runCommand('mock-codex', ['--version'], f.root, undefined, undefined, { recovery: f.recovery })
    expect(result).toMatchObject({ exitCode: code, stdout: 'codex-cli 0.154.0\n', stderr: '' })
    expect(f.wrapper.signalCode).toBe('SIGKILL')
    expect(seams.spawn.mock.calls[0]?.slice(0, 2)).toEqual([process.execPath, ['-e', NATIVE_GUARDIAN_SOURCE]])
    expect(seams.populated).toHaveBeenCalled()
    expect(seams.retire).toHaveBeenCalledOnce()
    expect(await f.registry.closeOwner(f.recovery.owner)).toBe(true)
  })

  it('does not return a valid native success when containment closure fails', async () => {
    const f = await fixture(0)
    seams.populated.mockImplementation(() => { throw new Error('containment closure unavailable') })
    await expect(runCommand('mock-codex', ['--version'], f.root, undefined, undefined, { recovery: f.recovery }))
      .rejects.toThrow('containment closure unavailable')
    expect(seams.retire).not.toHaveBeenCalled()
    seams.populated.mockReturnValue(false)
    expect(await f.registry.closeOwner(f.recovery.owner)).toBe(true)
  })

  it('keeps retirement unconfirmed when containment becomes populated after closure observation', async () => {
    const f = await fixture(0)
    seams.populated.mockReturnValueOnce(false).mockReturnValue(true)
    await expect(runCommand('mock-codex', ['--version'], f.root, undefined, undefined, { recovery: f.recovery }))
      .rejects.toThrow('live process')
    expect(seams.retire).not.toHaveBeenCalled()
    expect(f.registry.closedRegistration(f.recovery.owner, f.recovery.launchId!)).toBeUndefined()

    seams.populated.mockReturnValue(false)
    expect(await f.registry.closeOwner(f.recovery.owner)).toBe(true)
    expect(seams.retire).toHaveBeenCalledOnce()
    expect(f.registry.closedRegistration(f.recovery.owner, f.recovery.launchId!)).toMatchObject({
      launchId: f.recovery.launchId,
      lifecycle: 'closed',
      closureEvidence: 'cgroup_v2_empty',
    })
  })

  it('retains recovery records and withholds retirement publication when containment retirement fails', async () => {
    const f = await fixture(0)
    const controller = new AbortController()
    try {
      seams.retire.mockImplementation(() => { throw new Error('containment retirement unavailable') })
      await expect(runCommand('mock-codex', ['--version'], f.root, undefined, undefined, { recovery: f.recovery }))
        .rejects.toThrow('containment retirement unavailable')
      const changes = f.registry.changes('unobserved:0', controller.signal)[Symbol.asyncIterator]()
      const event = await changes.next()
      expect(event.value?.launches.find((launch: { launchId: string; lifecycle: string }) => launch.launchId === f.recovery.launchId)?.lifecycle)
        .not.toBe('closed')
      controller.abort()
      await changes.return?.()
      const directory = join(f.root, createHash('sha256').update(f.recovery.owner).digest('hex'), f.recovery.launchId!)
      expect(readRecord(join(directory, 'intent.json'))).toMatchObject({ owner: f.recovery.owner })
      expect(f.registry.closedRegistration(f.recovery.owner, f.recovery.launchId!)).toBeUndefined()

      seams.retire.mockReset()
      expect(await f.registry.closeOwner(f.recovery.owner)).toBe(true)
      expect(f.registry.closedRegistration(f.recovery.owner, f.recovery.launchId!)).toMatchObject({
        launchId: f.recovery.launchId, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
      })
    } finally { controller.abort() }
  })

})

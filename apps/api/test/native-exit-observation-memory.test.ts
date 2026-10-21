import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const child = vi.hoisted(() => ({ spawn: vi.fn() }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: child.spawn }))
vi.mock('../src/modules/diagnostics/logger.js', () => ({ componentLogger: () => log }))
vi.mock('../src/modules/harnesses/recovery/linuxIdentity.js', () => ({
  bootIdentity: () => '22222222-2222-2222-2222-222222222222',
  processIdentity: (pid: number) => ({ pid, startTicks: '100', group: pid, session: pid, state: 'S' }),
  identityAlive: () => true,
}))

import { NativeProcessRegistry, nativeProcessExit, spawnNativeProcess } from '../src/modules/harnesses/recovery/processRegistry.js'
import { writeRecord } from '../src/modules/harnesses/recovery/storage.js'
import { createHash } from 'node:crypto'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

async function fixture(purpose?: 'command' | 'inspection' | 'session') {
  const root = mkdtempSync(join(tmpdir(), 'native-exit-observation-memory-'))
  roots.push(root)
  const registry = new NativeProcessRegistry(root)
  const scope = await registry.reserveLaunch('memory-owner')
  const wrapper = Object.assign(new EventEmitter(), { pid: 501, send: vi.fn(), disconnect: vi.fn() })
  child.spawn.mockReturnValueOnce(wrapper)
  const process = spawnNativeProcess('memory-only-cli', ['private-prompt'], {
    cwd: root, env: { PRIVATE_TOKEN: 'private-credential' }, recovery: scope, ...(purpose ? { purpose } : {}),
  })
  const receipt = { format: 1, operation: 'native_exit', id: scope.launchId, owner: scope.owner,
    boot: '22222222-2222-2222-2222-222222222222', guardian: { pid: 501, startTicks: '100' },
    nativePid: 902, exitCode: 0, exitSignal: null }
  return { root, registry, scope, process, receipt }
}

describe('native exit and passive observation IPC composition without subprocesses', () => {
  for (const purpose of ['command', 'inspection', 'session'] as const) {
    it(`logs ${purpose} success separately from guardian cleanup`, async () => {
      const f = await fixture(purpose)
      f.process.emit('spawn')
      f.process.emit('message', f.receipt)
      f.process.emit('exit', null, 'SIGKILL')
      expect(log.info).toHaveBeenCalledWith({ binary: 'memory-only-cli', purpose,
        owner: f.scope.owner, childPid: 501 }, `harness ${purpose} started`)
      expect(log.info).toHaveBeenCalledWith({ binary: 'memory-only-cli', purpose,
        owner: f.scope.owner, childPid: 501, exitCode: 0, signal: null,
        guardianExitCode: null, guardianSignal: 'SIGKILL' }, `harness ${purpose} exited`)
      expect(log.warn).not.toHaveBeenCalled()
      expect(JSON.stringify(log.info.mock.calls)).not.toMatch(/private-prompt|private-credential/)
      expect(child.spawn).toHaveBeenCalledTimes(1)
    })
  }

  it('logs native failures without replacing them with the guardian cleanup signal', async () => {
    const f = await fixture('session')
    f.process.emit('message', { ...f.receipt, exitCode: null, exitSignal: 'SIGTERM' })
    f.process.emit('exit', null, 'SIGKILL')
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'session', exitCode: null, signal: 'SIGTERM', guardianSignal: 'SIGKILL',
    }), 'harness session exited')
  })

  it('keeps a missing native receipt as a failure', async () => {
    const f = await fixture('command')
    f.process.emit('exit', null, 'SIGKILL')
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      exitCode: null, signal: 'SIGKILL',
    }), 'harness command exited')
  })

  it('reports rejected receipts without throwing from the exit observer', async () => {
    const f = await fixture('command')
    f.process.emit('message', { ...f.receipt, guardian: { pid: 501, startTicks: '101' } })
    expect(() => f.process.emit('exit', null, 'SIGKILL')).not.toThrow()
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ outcomeReceipt: 'invalid' }),
      'harness command outcome unavailable')
    expect(log.info).not.toHaveBeenCalled()
  })

  it('accepts the original exact native outcome around passive publications without adding receipt listeners', async () => {
    const f = await fixture()
    expect(f.process.listeners('message')).toHaveLength(1)
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', { operation: 'observation', id: 'foreign-launch' })
    f.process.emit('message', f.receipt)
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    expect(nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toEqual({ exitCode: 0, exitSignal: null })
  })

  it('never promotes a passive observation to an original native success receipt', async () => {
    const f = await fixture()
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    expect(() => nativeProcessExit(f.process, { exitCode: 0, exitSignal: null })).toThrow('receipt is missing')
  })

  it('preserves exact guardian generation rejection after a passive publication', async () => {
    const f = await fixture()
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', { ...f.receipt, guardian: { pid: 501, startTicks: '101' } })
    expect(() => nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toThrow('Invalid native exit receipt')
  })

  it('does not let observation read failure poison the original native receipt', async () => {
    const f = await fixture()
    const directory = join(f.root, createHash('sha256').update(f.scope.owner).digest('hex'), f.scope.launchId!)
    writeRecord(join(directory, 'provider.json'), { format: 1, id: 'foreign', owner: f.scope.owner, boot: f.receipt.boot })
    f.process.emit('message', { operation: 'observation', id: f.scope.launchId })
    f.process.emit('message', f.receipt)
    expect(nativeProcessExit(f.process, { exitCode: null, exitSignal: 'SIGKILL' })).toEqual({ exitCode: 0, exitSignal: null })
  })
})

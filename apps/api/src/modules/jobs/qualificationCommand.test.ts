import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runQualificationCommand, type QualificationNativeOwner } from './qualification.js'

function diagnostic() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
  const owner = {
    reserveProcess: vi.fn(async () => 'reserved-command'),
    spawnProcess: vi.fn(() => child as unknown as ChildProcess),
    readNativeExit: vi.fn(async () => ({ confirmed: true, exitCode: 0 })),
    stopProcess: vi.fn(async () => true),
  } satisfies Pick<QualificationNativeOwner, 'reserveProcess' | 'spawnProcess' | 'readNativeExit' | 'stopProcess'>
  return { child, owner }
}

describe('qualification command interruption', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
  afterEach(() => vi.useRealTimers())

  it('reports the command deadline without shortening the default budget', async () => {
    const { owner } = diagnostic()
    const result = runQualificationCommand(owner, '/approved/diagnostic', [], {}, new AbortController().signal)
      .catch(error => error)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(owner.stopProcess).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({
      reason: 'command_timeout', elapsedMs: 30_000, outputBytes: 0,
      timeoutMs: 30_000, outputLimitBytes: 65_536, stopConfirmed: true,
    })
    expect(owner.stopProcess).toHaveBeenCalledOnce()
    expect(owner.readNativeExit).not.toHaveBeenCalled()
  })

  it('reports signal cancellation with the output count at interruption', async () => {
    const { child, owner } = diagnostic()
    const controller = new AbortController()
    const result = runQualificationCommand(owner, '/approved/diagnostic', [], {}, controller.signal)
      .catch(error => error)
    await vi.advanceTimersByTimeAsync(123)
    child.stdout.write('private-output')
    controller.abort(new Error('private-abort-detail'))
    const error = await result
    expect(error).toMatchObject({
      reason: 'signal_aborted', elapsedMs: 123, outputBytes: 14,
      timeoutMs: 30_000, outputLimitBytes: 65_536, stopConfirmed: true,
    })
    expect(error.message).not.toContain('private-output')
    expect(error.message).not.toContain('private-abort-detail')
    expect(owner.stopProcess).toHaveBeenCalledOnce()
  })

  it('keeps the 64 KiB cap and reports the first overflow only', async () => {
    const { child, owner } = diagnostic()
    const result = runQualificationCommand(owner, '/approved/diagnostic', [], {}, new AbortController().signal)
      .catch(error => error)
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write(Buffer.alloc(65_536))
    expect(owner.stopProcess).not.toHaveBeenCalled()
    child.stderr.write('x')
    child.stdout.write(Buffer.alloc(65_536))
    expect(await result).toMatchObject({
      reason: 'output_limit', elapsedMs: 0, outputBytes: 65_537,
      timeoutMs: 30_000, outputLimitBytes: 65_536, stopConfirmed: true,
    })
    expect(owner.stopProcess).toHaveBeenCalledOnce()
  })

  it('retains an unconfirmed physical stop in the interruption facts', async () => {
    const { owner } = diagnostic()
    owner.stopProcess.mockResolvedValue(false)
    const result = runQualificationCommand(owner, '/approved/diagnostic', [], {}, new AbortController().signal, 50)
      .catch(error => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toMatchObject({ reason: 'command_timeout', elapsedMs: 50, stopConfirmed: false })
  })
})

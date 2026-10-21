import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { installManagedLauncher, writeLauncherInstallation } from '../src/modules/harnesses/appMcpLauncher.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { heldLauncher } from './helpers/launcherLock.js'

async function beforeTimeout<T>(operation: Promise<T>, milliseconds: number, fallback: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<string>(resolve => { timer = setTimeout(() => resolve(fallback), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

it.each(['install', 'register'] as const)('cancels a blocked launcher %s without writing after lock release', async kind => {
  const fixture = await heldLauncher()
  const controller = new AbortController()
  try {
    const operation = kind === 'install'
      ? installManagedLauncher(fixture.source, fixture.launcher, controller.signal)
      : writeLauncherInstallation(fixture.launcher, { version: 1, executables: [] }, controller.signal)
    const outcome = operation.then(() => 'written', error => error)
    // Give the blocked flock one short window to prove that it cannot write.
    expect(await beforeTimeout(outcome, 30, 'waiting')).toBe('waiting')
    const reason = new Error('Installation canceled')
    controller.abort(reason)
    expect(await beforeTimeout(outcome, 1000, 'still blocked')).toBe(reason)
    await fixture.release()
    expect(await readFile(fixture.launcher, 'utf8')).toBe('original launcher')
    await expect(readFile(`${fixture.launcher}.registration.json`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(`${fixture.launcher}.installation.json`)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    controller.abort()
    await fixture.close()
  }
}, 5000)

it('settles settings shutdown while a launcher installation lock remains held', async () => {
  const fixture = await heldLauncher()
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  const closed = vi.fn(async () => {})
  const service = new HarnessMcpSettingsService({} as never, {} as never, { codex: {
    read: async signal => {
      notifyStarted()
      await installManagedLauncher(fixture.source, fixture.launcher, signal)
      throw new Error('Canceled installation unexpectedly completed')
    }, apply: vi.fn(),
  } }, () => {}, closed)
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read'], scope: {} }] }
  try {
    const reading = service.list(principal, 'codex')
    const rejected = expect(reading).rejects.toMatchObject({ code: 'HARNESS_CHECK_TIMEOUT' })
    await started
    // The held lock must keep the read pending before shutdown cancels it.
    expect(await beforeTimeout(reading.then(() => 'finished', () => 'rejected'), 30, 'waiting')).toBe('waiting')
    expect(await beforeTimeout(service.shutdown().then(() => 'closed'), 1000, 'blocked')).toBe('closed')
    await rejected
    expect(closed).toHaveBeenCalledOnce()
    await fixture.release()
    expect(await readFile(fixture.launcher, 'utf8')).toBe('original launcher')
  } finally {
    await fixture.close()
    await service.shutdown()
  }
}, 5000)

it('enforces the operation deadline while waiting for the launcher lock', async () => {
  const fixture = await heldLauncher()
  try {
    const installation = installManagedLauncher(fixture.source, fixture.launcher, AbortSignal.timeout(80))
    await expect(installation).rejects.toMatchObject({ name: 'TimeoutError' })
    await fixture.release()
    expect(await readFile(fixture.launcher, 'utf8')).toBe('original launcher')
  } finally {
    await fixture.close()
  }
}, 5000)

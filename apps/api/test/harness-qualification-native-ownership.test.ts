import { expect, it, vi } from 'vitest'
import { withNativeQualificationOwnership, type NativeQualificationSuiteInput } from '../src/modules/harnesses/qualification/nativeOwnership.js'
import type { QualificationSuiteInput } from '../src/modules/harnesses/qualification/types.js'

const input = (signal = new AbortController().signal): QualificationSuiteInput => ({
  binary: '/recorded/native', version: '0.154.0', binarySha256: 'recorded', profile: 'codex-0.154',
  model: 'recorded', workDirectory: '/recorded/project', signal,
})

it('admits a distinct qualification owner and retains uncertain cleanup for retry', async () => {
  const scope = { root: '/recorded/registry', owner: 'qualification:codex:recorded', launchId: 'recorded-launch' }
  let closes = 0
  const registry = { reserveLaunch: vi.fn(async (owner: string) => { expect(owner).toMatch(/^qualification:codex:/); return scope }), abandonReservedLaunch: vi.fn(async () => false),
    closeOwner: vi.fn(async () => ++closes > 1) }
  let retained: (() => Promise<void>) | undefined
  const release = vi.fn()
  const guard = vi.fn(async () => undefined)
  const source = input()
  source.ownCleanup = (close) => { retained = close; return release }
  const suite = withNativeQualificationOwnership({ harness: 'codex', revision: 'recorded',
    async run(value: NativeQualificationSuiteInput) {
      expect(value.processRecovery).toBe(scope)
      expect(value.assertInstallation).toBeTypeOf('function')
      expect(registry.reserveLaunch.mock.calls[0]?.[0]).toMatch(/^qualification:codex:/)
      return { checks: [], evidence: {} }
    } }, registry, () => guard)
  expect(registry.reserveLaunch).not.toHaveBeenCalled()
  await expect(suite.run(source)).rejects.toBeInstanceOf(AggregateError)
  expect(release).not.toHaveBeenCalled()
  await retained!()
  expect(registry.abandonReservedLaunch).toHaveBeenLastCalledWith(scope)
  expect(registry.closeOwner).toHaveBeenLastCalledWith(scope.owner)
})

it('rejects cancellation during positive physical cleanup before publishing qualification', async () => {
  const controller = new AbortController()
  let entered!: () => void
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const closed = new Promise<void>((resolve) => { finish = resolve })
  const release = vi.fn()
  const source = input(controller.signal)
  source.ownCleanup = () => release
  const suite = withNativeQualificationOwnership({ harness: 'codex', revision: 'recorded',
    run: async () => ({ checks: [], evidence: {} }) }, {
    reserveLaunch: async () => ({ root: '/recorded/registry', owner: 'qualification:codex:recorded' }),
    abandonReservedLaunch: async () => true,
    closeOwner: async () => { entered(); await closed; return true },
  }, () => async () => undefined)
  const task = suite.run(source)
  await waiting
  controller.abort(new Error('Caller stopped qualification'))
  finish()
  await expect(task).rejects.toThrow('Caller stopped qualification')
  expect(release).toHaveBeenCalledOnce()
})

it('checks the selected payload before native reservation and after physical closure', async () => {
  let changed = true
  const reserveLaunch = vi.fn(async (owner: string) => ({ root: '/recorded/registry', owner }))
  const guard = async () => { if (changed) throw new Error('Selected payload changed') }
  const release = vi.fn()
  const source = input()
  source.ownCleanup = () => release
  const suite = withNativeQualificationOwnership({ harness: 'codex', revision: 'recorded',
    run: async () => ({ checks: [], evidence: {} }) }, {
    reserveLaunch, abandonReservedLaunch: async () => true,
    closeOwner: async () => { changed = true; return true },
  }, () => guard)
  await expect(suite.run(source)).rejects.toThrow('Selected payload changed')
  expect(reserveLaunch).not.toHaveBeenCalled()
  changed = false
  await expect(suite.run(source)).rejects.toThrow('Selected payload changed')
  expect(reserveLaunch).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

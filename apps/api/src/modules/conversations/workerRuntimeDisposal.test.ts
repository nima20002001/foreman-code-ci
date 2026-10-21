import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import { createAdmittedNativeManager } from '../harnesses/admittedManager.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

async function fixture() {
  const f = workerConversationFixture()
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  let exited = false
  let closes = 0
  let recoveries = 0
  let closureConfirmed = true
  let completed = false
  const native = { harness: 'codex', createSession: async () => f.session,
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async (_session: unknown, correlationId: string) => ({ events: [], pendingInteractions: [],
      correlationId, nativeTurnId: 'native-turn',
      ...(completed ? { terminalResult: { outcome: 'succeeded', output: 'Recovered native result' } } : {}) }),
  } as unknown as NativeHarnessSessionManager
  const start = { kind: 'operator', configuration: f.configuration,
    workingDirectory: f.binding.workingDirectory, correlationId: 'creation' } as NativeSessionStart
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => ({ manager: native, start: async () => start, hasExited: () => exited,
      nativeOwner: async (_session, options) => {
        if (exited && !options?.allowExited) throw new Error('Native process has exited')
        return f.nativeOwner
      }, close: async () => {
        if (!closureConfirmed) throw new Error('Native closure is unconfirmed')
        closes++
      } }),
    recover: async () => { recoveries++; throw new Error('Cleanup must not resume a provider') },
  })
  const bridge = new MainWorkerConversationBridge()
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    current: async () => {}, channel: { binding: f.connection,
      request: async (request, options) => ({ payload: await host.handle(request, f.connection, options?.signal) }) } })
  await manager.createSession(start)
  return { ...f, manager, journal, closes: () => closes, recoveries: () => recoveries,
    exit: () => { exited = true }, unconfirmed: () => { closureConfirmed = false },
    confirm: () => { closureConfirmed = true },
    complete: () => { completed = true },
    cleanup: async () => { closureConfirmed = true; await host.shutdown(); await bridge.close() } }
}

it.each(['submitted', 'uncertain', 'compaction'] as const)(
  'retains disposal ownership for %s work and releases it after Worker settlement', async state => {
    const f = await fixture()
    try {
      if (state === 'compaction') {
        await f.journal.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
      } else {
        await f.journal.reserveTurn(f.binding, 'turn', commandInputHash('original input'))
        await f.journal.submitted(f.binding, 'turn', { nativeTurnId: 'native-turn' })
        if (state === 'uncertain') await f.journal.finishTurn(f.binding, 'turn')
      }
      // Refresh through the public native port so Main has the outstanding receipt.
      await f.manager.history(f.session)
      const before = (await f.journal.read(f.binding))!
      await expect(f.manager.dispose()).rejects.toThrow('Finish the active operation')
      await expect(f.manager.history(f.session)).resolves.toMatchObject({ events: [] })
      expect(await f.journal.read(f.binding)).toEqual(before)
      expect(f.closes()).toBe(0)
      if (state === 'compaction') {
        await f.journal.compactProgress(f.binding, { ...before.compactions[0]!.state, status: 'completed' })
      } else {
        await f.journal.finishTurn(f.binding, 'turn', { outcome: 'succeeded', output: 'Saved result' })
      }
      const settled = (await f.journal.read(f.binding))!
      await f.manager.dispose()
      const released = (await f.journal.read(f.binding))!
      expect(released).toMatchObject({ runtimeReleased: true, closed: false, session: f.session })
      expect(released.turns).toEqual(settled.turns)
      expect(released.compactions).toEqual(settled.compactions)
      expect(f.closes()).toBe(1)
      expect(f.recoveries()).toBe(0)
    } finally { await f.cleanup() }
  })

it('releases an exited allocation without native recovery and retries unconfirmed closure', async () => {
  const f = await fixture()
  try {
    f.exit()
    f.unconfirmed()
    await expect(f.manager.closeForResume(f.session)).rejects.toThrow('Native closure is unconfirmed')
    expect((await f.journal.read(f.binding))?.runtimeReleased).not.toBe(true)
    expect(f.recoveries()).toBe(0)
    f.confirm()
    await f.manager.dispose()
    expect((await f.journal.read(f.binding))?.runtimeReleased).toBe(true)
    expect(f.recoveries()).toBe(0)
    expect(f.closes()).toBe(1)
  } finally { await f.cleanup() }
})

it('keeps an admitted Worker owner recoverable after disposal fails and disposes after native reconciliation', async () => {
  const f = await fixture()
  const manager = createAdmittedNativeManager('codex', async () => ({ manager: f.manager })).manager
  try {
    await f.journal.reserveTurn(f.binding, 'turn', commandInputHash('original input'))
    await f.journal.submitted(f.binding, 'turn', { nativeTurnId: 'native-turn' })
    await f.journal.finishTurn(f.binding, 'turn')
    await manager.history(f.session)
    const before = (await f.journal.read(f.binding))!
    await expect(manager.dispose!()).rejects.toThrow('Finish the active operation')
    await expect(manager.history(f.session)).resolves.toMatchObject({ events: [] })
    expect(await f.journal.read(f.binding)).toEqual(before)
    f.complete()
    await expect(manager.reconcile(f.session, 'turn')).resolves.toMatchObject({
      terminalResult: { outcome: 'succeeded', output: 'Recovered native result' },
    })
    expect((await f.journal.read(f.binding))?.turns[0]).toMatchObject({ status: 'completed', nativeTurnId: 'native-turn' })
    await manager.dispose!()
    expect((await f.journal.read(f.binding))?.runtimeReleased).toBe(true)
    await expect(manager.history(f.session)).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
    expect(f.closes()).toBe(1)
    expect(f.recoveries()).toBe(0)
  } finally { await f.cleanup() }
})

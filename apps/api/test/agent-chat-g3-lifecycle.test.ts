import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'
import type { AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { fixture } from './helpers/agentChatF1.js'
import { deferred } from './helpers/deferred.js'

const tick = () => new Promise<void>((done) => setImmediate(done))
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

async function entered(gate: ReturnType<typeof deferred<void>>) {
  vi.advanceTimersByTime(1_000)
  await gate.promise
}

describe('G3 shutdown ownership (fake SQL/native manager; real service and repair timer)', () => {
  for (const tail of ['get', 'nextQueued'] as const) {
    for (const rejectTail of [false, true]) {
      it(`A2-PF-07: shutdown drains timer-started ${tail}, including ${rejectTail ? 'rejection' : 'success'}, after control ends`, async () => {
        const f = fixture()
        const reached = deferred(), release = deferred()
        const calls: string[] = []
        let disposals = 0, stopped = false
        f.manager.close = async () => { disposals++ }
        f.repository.open = async () => []
        await f.service.recover()
        f.repository.restoreUnsettled = async () => { calls.push('restore'); return f.store.row }
        const wait = async () => { reached.resolve(); await release.promise; if (rejectTail) throw new Error('gated SQL failure') }
        f.repository.get = async () => { calls.push('get'); if (tail === 'get') await wait(); return f.store.row }
        f.repository.nextQueued = async () => { calls.push('nextQueued'); if (tail === 'nextQueued') await wait(); return undefined }
        try {
          f.service['scheduleReconcile'](f.store.row.id)
          await entered(reached)
          assert.ok(f.store.statements.some(({ sql, values }) => sql.startsWith('select a.conversation_id,a.request_id,a.activity_id,a.source_provenance')
            && values[0] === 'agent' && values[1] === f.store.row.id), 'The real bounded activity owner inquiry precedes the gated SQL tail.')
          assert.equal(f.service['recovery'], undefined)
          assert.equal(f.service['controls'].size, 0)
          assert.equal(f.internals.tasks.size, 0)
          const shutdown = f.service.shutdown()
          assert.equal(f.service.shutdown(), shutdown, 'Concurrent shutdown callers share the same barrier.')
          void shutdown.then(() => { stopped = true })
          await tick()
          assert.equal(stopped, false, 'Shutdown must not resolve while the post-control database read is pending.')
          assert.equal(disposals, 0, 'Do not dispose the owner while a producer still owns work.')
          release.resolve()
          await shutdown
          await tick()
          assert.equal(stopped, true); assert.equal(disposals, 1)
          assert.equal(f.service['inflightCommands'].size, 0)
          assert.equal(f.service['reconciliationTimers'].size, 0)
          const queriesAtBarrier = calls.length
          f.service['scheduleReconcile'](f.store.row.id)
          await f.service.recover()
          await tick()
          assert.equal(calls.length, queriesAtBarrier, 'No follow-on SQL after the shutdown barrier.')
          assert.equal(f.service['reconciliationTimers'].size, 0)
          assert.deepEqual(f.manager.starts, []); assert.deepEqual(f.manager.cancels, [])
        } finally {
          release.resolve()
          await f.service.shutdown()
          await tick()
        }
      })
    }
  }

  it('A2-PF-07: shutdown cancels a timer that has not fired and prevents later repairs', async () => {
    const f = fixture()
    let reads = 0
    f.repository.restoreUnsettled = async () => { reads++; return f.store.row }
    try {
      f.service['scheduleReconcile'](f.store.row.id)
      assert.equal(f.service['reconciliationTimers'].size, 1)
      await f.service.shutdown()
      f.service['scheduleReconcile'](f.store.row.id)
      await vi.advanceTimersByTimeAsync(1_050)
      assert.equal(reads, 0)
      assert.equal(f.service['reconciliationTimers'].size, 0)
    } finally { await f.service.shutdown() }
  })

  for (const cleanup of ['dispose', 'close'] as const) {
    it(`A-R18: failed ${cleanup} retains both ownership maps, fences reuse, and retries the same owner during shutdown`, async () => {
      const f = fixture()
      const id = f.store.row.id
      const owners = new Map([[id, f.manager]])
      let attempts = 0, releases = 0, allocations = 0, fail = true
      const factory: AgentChatManagerFactory = Object.assign(() => { allocations++; return f.manager },
        { release: (key: string) => { releases++; owners.delete(key) } })
      ;(f.service as unknown as { managers: AgentChatManagerFactory }).managers = factory
      const dispose = async () => { attempts++; if (fail) throw new Error('disposal unproven') }
      if (cleanup === 'dispose') (f.manager as NativeHarnessSessionManager).dispose = dispose
      else f.manager.close = dispose
      try {
        await assert.rejects(f.service['release'](id), /disposal unproven/)
        assert.equal(owners.get(id), f.manager)
        assert.equal(f.service['runtimes'].get(id)?.manager, f.manager)
        assert.equal(f.service['runtimes'].get(id)?.retiring, true)
        assert.equal((await f.read()).availability.canSend, false)
        await assert.rejects(f.send('must-not-replace'), { code: 'AGENT_CHAT_UNAVAILABLE' })
        await assert.rejects(f.service.shutdown(), AggregateError)
        assert.equal(attempts, 2); assert.equal(releases, 0); assert.equal(allocations, 0)
        assert.equal(owners.get(id), f.manager)
        assert.equal(f.service['runtimes'].get(id)?.manager, f.manager)
        fail = false
        await f.service.shutdown()
        assert.equal(attempts, 3); assert.equal(releases, 1); assert.equal(allocations, 0)
        assert.equal(owners.size, 0); assert.equal(f.service['runtimes'].size, 0)
        assert.deepEqual(f.manager.starts, [])
      } finally { fail = false; await f.service.shutdown() }
    })
  }
})

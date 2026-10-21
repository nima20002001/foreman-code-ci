import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { recoverWorkflowNativeClosure, readWorkflowClosure, readUnboundWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { recoveryDatabase } from './helpers/eng06Recovery.testSupport.js'

const freshSignal = () => new AbortController().signal

describe('ENG06-A exact restart closure evidence', () => {
  it.each([false, true])('rejects a resident generation mismatch before native IO (already closed: %s)', async closed => {
    const db = recoveryDatabase()
    let calls = 0
    const close = async () => {
      calls += 1
      return true
    }
    try {
      if (closed) await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => true, freshSignal())
      const previous = await readWorkflowClosure(db.connection, db.state.execution)
      await assert.rejects(recoverWorkflowNativeClosure(db.owner, db.state.execution, close,
        freshSignal(), { generation: '72' }), { code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
      assert.equal(calls, 0)
      assert.deepEqual(await readWorkflowClosure(db.connection, db.state.execution), previous)
    } finally {
      await db.owner.release()
    }
  })

  it('keeps a terminal detached execution pending until its original process closure is confirmed', async () => {
    const db = recoveryDatabase({ detached: true })
    db.state.execution.state = 'completed'
    db.state.execution.result = { outcome: 'failed', error: {
      code: 'EXECUTION_INTERRUPTED', message: 'Main restarted.', retryable: false,
    } }
    db.state.execution.finishedAt = '2026-09-26T00:01:00.000Z'
    const original = structuredClone(db.state.lifetime)
    try {
      assert.equal(await readWorkflowClosure(db.connection, db.state.execution), undefined)
      await assert.rejects(recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => false, freshSignal()))
      assert.equal(await readWorkflowClosure(db.connection, db.state.execution), undefined)
      await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => true, freshSignal())
      assert.equal((await readWorkflowClosure(db.connection, db.state.execution))?.durableGeneration, '71')
      assert.deepEqual(db.state.lifetime, original)
      assert.equal(db.state.execution.result.error?.code, 'EXECUTION_INTERRUPTED')
    } finally {
      await db.owner.release()
    }
  })

  for (const detached of [false, true]) it(`recovers ${detached ? 'restart-detached' : 'crash-unclosed'} lifetime without rewriting original evidence`, async () => {
    const db = recoveryDatabase({ detached })
    const original = structuredClone(db.state.lifetime)
    let calls = 0
    const close = async (id: string) => { assert.equal(db.state.active, false); assert.equal(id, db.state.execution.id); calls++; return true }
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, close, freshSignal())
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, close, freshSignal())
    assert.equal(calls, 1); assert.equal(db.state.inserts, 1)
    assert.deepEqual(db.state.lifetime, original)
    const proof = await readWorkflowClosure(db.connection, db.state.execution)
    assert.equal(proof?.durableGeneration, '71'); assert.deepEqual(proof?.session, db.state.session)
    assert.equal(db.state.execution.state, 'running'); assert.equal(db.state.execution.result, undefined)
    await db.owner.release()
  })

  it('closes entered preflight with no saved session only from positive registry evidence', async () => {
    const db = recoveryDatabase({ bound: false })
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => true, freshSignal())
    assert.equal((await readUnboundWorkflowClosure(db.connection, db.state.execution))?.durableGeneration, '71')
    assert.equal(await readWorkflowClosure(db.connection, db.state.execution), undefined)
    assert.equal(db.state.proof?.reference, null)
    await db.owner.release()
  })

  for (const evidence of ['missing_port', 'missing_receipt', 'failed_close'] as const) it(`does not turn ${evidence} into closure`, async () => {
    const db = recoveryDatabase()
    const close = evidence === 'missing_port' ? undefined : async () => {
      if (evidence === 'failed_close') throw new Error('kernel closure unconfirmed')
      return false
    }
    await assert.rejects(recoverWorkflowNativeClosure(db.owner, db.state.execution, close, freshSignal()))
    assert.equal(db.state.proof, undefined); assert.equal(db.state.inserts, 0)
    assert.equal(await readWorkflowClosure(db.connection, db.state.execution), undefined)
    await db.owner.release()
  })

  for (const mutation of ['generation', 'session', 'owner', 'fence', 'cleanup'] as const) it(`rejects changed ${mutation} across physical IO`, async () => {
    const db = recoveryDatabase()
    await assert.rejects(recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => {
      assert.equal(db.state.active, false)
      if (mutation === 'generation') db.state.lifetime!.generation = '72'
      if (mutation === 'session') db.state.session!.providerVersion = 'other-provider'
      if (mutation === 'owner') db.state.lost = true
      if (mutation === 'fence') db.state.fence = '9002'
      if (mutation === 'cleanup') db.state.fenced = false
      return true
    }, freshSignal()))
    assert.equal(db.state.proof, undefined); assert.equal(db.state.inserts, 0)
    await db.owner.release()
  })

  for (const mutation of ['owner', 'fence', 'session', 'abort'] as const) it(`rolls back a receipt when ${mutation} changes before COMMIT`, async () => {
    const db = recoveryDatabase(), controller = new AbortController()
    db.state.afterInsert = () => {
      if (mutation === 'owner') db.state.lost = true
      if (mutation === 'fence') db.state.fence = 'changed'
      if (mutation === 'session') db.state.session!.providerVersion = 'changed'
      if (mutation === 'abort') controller.abort(new Error('cleanup expired'))
    }
    await assert.rejects(recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => true, controller.signal))
    assert.equal(db.state.proof, undefined); assert.equal(db.state.rollbacks, 1)
    await db.owner.release()
  })

  it('requires semantics 3, an exact Run owner, and committed negative authority before physical IO', async () => {
    for (const kind of ['semantics', 'scope', 'authority', 'identity', 'prior_lifetime']) {
      const db = recoveryDatabase(); let calls = 0
      const candidate = structuredClone(db.state.execution)
      if (kind === 'semantics') db.state.semantics = 'invalid'
      if (kind === 'scope') candidate.runId = 'another-run'
      if (kind === 'authority') db.state.fenced = false
      if (kind === 'identity') candidate.agentConfigurationVersionId = 'another-configuration'
      if (kind === 'prior_lifetime') db.state.lifetime!.prior_unclosed = true
      await assert.rejects(recoverWorkflowNativeClosure(db.owner, candidate, async () => { calls++; return true }, freshSignal()))
      assert.equal(calls, 0); assert.equal(db.state.proof, undefined)
      await db.owner.release()
    }
  })

  it('leaves a prepared no-submission lifetime to the existing canonical seal without requiring a nonexistent process', async () => {
    const db = recoveryDatabase({ bound: false }); db.state.entryPhase = 'prepared'
    let calls = 0
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => { calls++; return false }, freshSignal())
    assert.equal(calls, 0); assert.equal(db.state.proof, undefined)
    assert.equal(db.state.entryPhase, 'prepared', 'only the existing canonical repository may seal the entry')
    assert.equal(await readUnboundWorkflowClosure(db.connection, db.state.execution), undefined)
    await db.owner.release()
  })

  it('does not create a missing lifetime or claim that a reserved attempt was submitted', async () => {
    const db = recoveryDatabase({ bound: false, lifetime: false }); let calls = 0
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => { calls++; return true }, freshSignal())
    assert.equal(calls, 0); assert.equal(db.state.proof, undefined)
    assert.equal(await readUnboundWorkflowClosure(db.connection, db.state.execution), undefined)
    await db.owner.release()
  })

  it('uses an existing exact original close without calling any native recovery port', async () => {
    const db = recoveryDatabase({ closed: true })
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => { throw new Error('must not call native') }, freshSignal())
    assert.equal((await readWorkflowClosure(db.connection, db.state.execution))?.durableGeneration, '71')
    assert.equal(db.state.inserts, 0)
    await db.owner.release()
  })

  it('retains an exact original close committed concurrently with kernel closure', async () => {
    const db = recoveryDatabase()
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => {
      db.state.lifetime!.closed = true; db.state.lifetime!.closed_reference = db.state.session
      return true
    }, freshSignal())
    assert.equal(db.state.inserts, 0)
    assert.equal((await readWorkflowClosure(db.connection, db.state.execution))?.durableGeneration, '71')
    await db.owner.release()
  })

  it('does not reuse recovery evidence after a newer native lifetime or different pinned execution', async () => {
    const db = recoveryDatabase()
    await recoverWorkflowNativeClosure(db.owner, db.state.execution, async () => true, freshSignal())
    await assert.rejects(readWorkflowClosure(db.connection, { ...db.state.execution, attempt: 2 }))
    db.state.lifetime!.generation = '72'
    assert.equal(await readWorkflowClosure(db.connection, db.state.execution), undefined)
    await db.owner.release()
  })
})
